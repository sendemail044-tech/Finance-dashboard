"""Personal Finance Dashboard - local FastAPI + SQLite app.

Run:  python app.py            (open http://localhost:8000)
Reset a forgotten password:  python app.py --reset-password
"""
import datetime as dt
import hashlib
import io
import json
import os
import secrets
import shutil
import sqlite3
import sys
import tempfile
import time

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

import parsers

BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("FINANCE_DB", os.path.join(BASE, "finance.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS cards (id INTEGER PRIMARY KEY, name TEXT, bank TEXT, last4 TEXT, credit_limit REAL,
  outstanding REAL, due_day INTEGER, min_due REAL);
CREATE TABLE IF NOT EXISTS card_txns (id INTEGER PRIMARY KEY, card_id INTEGER REFERENCES cards(id) ON DELETE CASCADE,
  date TEXT, description TEXT, amount REAL, category TEXT, hash TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS loans (id INTEGER PRIMARY KEY, type TEXT, lender TEXT, emi REAL, emi_day INTEGER,
  end_date TEXT, outstanding REAL, rate REAL, principal REAL);
CREATE TABLE IF NOT EXISTS investments (id INTEGER PRIMARY KEY, type TEXT, name TEXT, invested REAL,
  current_value REAL, maturity_date TEXT, notes TEXT);
CREATE TABLE IF NOT EXISTS insurance (id INTEGER PRIMARY KEY, type TEXT, insurer TEXT, policy_no TEXT, cover REAL,
  premium REAL, renewal_date TEXT, nominee TEXT);
CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY, bank TEXT, name TEXT, type TEXT, balance REAL);
CREATE TABLE IF NOT EXISTS bank_txns (id INTEGER PRIMARY KEY, account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT, description TEXT, debit REAL, credit REAL, category TEXT, hash TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS income (id INTEGER PRIMARY KEY, month TEXT, source TEXT, amount REAL);
CREATE TABLE IF NOT EXISTS budgets (category TEXT PRIMARY KEY, limit_amount REAL);
CREATE TABLE IF NOT EXISTS goals (id INTEGER PRIMARY KEY, name TEXT, kind TEXT, target REAL, target_date TEXT, linked TEXT);
CREATE TABLE IF NOT EXISTS snapshots (month TEXT PRIMARY KEY, networth REAL, assets REAL, liabilities REAL, detail TEXT);
"""

ENT = {
    "cards": ["name", "bank", "last4", "credit_limit", "outstanding", "due_day", "min_due"],
    "loans": ["type", "lender", "emi", "emi_day", "end_date", "outstanding", "rate", "principal"],
    "investments": ["type", "name", "invested", "current_value", "maturity_date", "notes"],
    "insurance": ["type", "insurer", "policy_no", "cover", "premium", "renewal_date", "nominee"],
    "accounts": ["bank", "name", "type", "balance"],
    "income": ["month", "source", "amount"],
    "goals": ["name", "kind", "target", "target_date", "linked"],
}
NUMERIC = {"credit_limit", "outstanding", "min_due", "emi", "rate", "principal", "invested", "current_value", "cover",
           "premium", "balance", "amount", "target"}
INTEGER = {"due_day", "emi_day"}
ORDER = {"cards": "name", "loans": "lender", "investments": "type, name", "insurance": "type, insurer",
         "accounts": "bank", "income": "month DESC", "goals": "target_date"}
EXPORT_TABLES = ["cards", "card_txns", "loans", "investments", "insurance", "accounts", "bank_txns", "income",
                 "budgets", "goals", "snapshots"]


# ----------------------------------------------------------------- database
def conn():
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys=ON")
    return c


def q(sql, args=()):
    c = conn()
    try:
        return [dict(r) for r in c.execute(sql, args).fetchall()]
    finally:
        c.close()


def ex(sql, args=()):
    c = conn()
    try:
        cur = c.execute(sql, args)
        c.commit()
        return cur.lastrowid
    finally:
        c.close()


def init_db():
    c = conn()
    c.executescript(SCHEMA)
    c.commit()
    c.close()


def get_setting(key, default=None):
    r = q("SELECT value FROM settings WHERE key=?", (key,))
    return r[0]["value"] if r else default


def set_setting(key, value):
    ex("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
       (key, str(value)))


# ---------------------------------------------------------------------- auth
SESSIONS = {}
FAILS = {"count": 0, "until": 0}


def hash_pw(pw, salt=None):
    salt = salt or secrets.token_bytes(16)
    h = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, 200_000)
    return salt.hex(), h.hex()


def check_pw(pw):
    salt, h = get_setting("pw_salt"), get_setting("pw_hash")
    if not salt or not h:
        return False
    return secrets.compare_digest(hash_pw(pw, bytes.fromhex(salt))[1], h)


def lock_minutes():
    return int(get_setting("lock_minutes", 2))


def session_ttl():
    return lock_minutes() * 60 + 60


def authed(request):
    tok = request.cookies.get("sid")
    last = SESSIONS.get(tok)
    return bool(tok and last and time.time() - last <= session_ttl())


def require_auth(request: Request):
    tok = request.cookies.get("sid")
    if not authed(request):
        SESSIONS.pop(tok, None)
        raise HTTPException(401, "locked")
    SESSIONS[tok] = time.time()


app = FastAPI(title="Finance Dashboard", docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def guard(request: Request, call_next):
    p = request.url.path
    open_paths = ("/api/auth/status", "/api/auth/setup", "/api/auth/login")
    if p.startswith("/api/") and p not in open_paths:
        try:
            require_auth(request)
        except HTTPException as e:
            return JSONResponse({"detail": e.detail}, status_code=e.status_code)
    resp = await call_next(request)
    resp.headers["Cache-Control"] = "no-store"
    return resp


def login_response(settings_ok=True):
    tok = secrets.token_urlsafe(32)
    SESSIONS[tok] = time.time()
    r = JSONResponse({"ok": True})
    r.set_cookie("sid", tok, httponly=True, samesite="strict")
    return r


@app.get("/api/auth/status")
def auth_status(request: Request):
    configured = bool(get_setting("pw_hash"))
    return {"configured": configured, "unlocked": authed(request), "lock_minutes": lock_minutes(),
            "hide_default": get_setting("hide_default", "0") == "1"}


@app.post("/api/auth/setup")
async def auth_setup(request: Request):
    if get_setting("pw_hash"):
        raise HTTPException(400, "Password already set")
    pw = (await request.json()).get("password", "")
    if len(pw) < 6:
        raise HTTPException(400, "Use at least 6 characters")
    salt, h = hash_pw(pw)
    set_setting("pw_salt", salt)
    set_setting("pw_hash", h)
    return login_response()


@app.post("/api/auth/login")
async def auth_login(request: Request):
    if time.time() < FAILS["until"]:
        raise HTTPException(429, f"Too many attempts. Wait {int(FAILS['until'] - time.time())}s.")
    pw = (await request.json()).get("password", "")
    if not check_pw(pw):
        FAILS["count"] += 1
        if FAILS["count"] >= 5:
            FAILS["count"], FAILS["until"] = 0, time.time() + 30
        raise HTTPException(401, "Wrong password")
    FAILS["count"] = 0
    return login_response()


@app.post("/api/auth/lock")
def auth_lock(request: Request):
    SESSIONS.pop(request.cookies.get("sid"), None)
    return {"ok": True}


@app.post("/api/auth/ping")
def auth_ping():
    return {"ok": True}


# ------------------------------------------------------------------ settings
@app.post("/api/settings/password")
async def change_password(request: Request):
    d = await request.json()
    if not check_pw(d.get("current", "")):
        raise HTTPException(400, "Current password is wrong")
    if len(d.get("new", "")) < 6:
        raise HTTPException(400, "New password must be at least 6 characters")
    salt, h = hash_pw(d["new"])
    set_setting("pw_salt", salt)
    set_setting("pw_hash", h)
    return {"ok": True}


@app.post("/api/settings")
async def save_settings(request: Request):
    d = await request.json()
    if "lock_minutes" in d:
        m = int(d["lock_minutes"])
        if m not in (1, 2, 5, 10, 15):
            raise HTTPException(400, "Invalid timeout")
        set_setting("lock_minutes", m)
    if "hide_default" in d:
        set_setting("hide_default", "1" if d["hide_default"] else "0")
    return {"ok": True}


@app.get("/api/settings/backup")
def backup():
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".db")
    tmp.close()
    src, dst = sqlite3.connect(DB_PATH), sqlite3.connect(tmp.name)
    src.backup(dst)
    src.close()
    dst.close()
    data = open(tmp.name, "rb").read()
    os.unlink(tmp.name)
    name = f"finance-backup-{dt.date.today().isoformat()}.db"
    return Response(data, media_type="application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.post("/api/settings/restore")
async def restore(file: UploadFile = File(...)):
    data = await file.read()
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".db")
    tmp.write(data)
    tmp.close()
    try:
        t = sqlite3.connect(tmp.name)
        tables = {r[0] for r in t.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        t.close()
        if not {"cards", "loans", "settings"} <= tables:
            raise ValueError
    except Exception:
        os.unlink(tmp.name)
        raise HTTPException(400, "This is not a valid backup file")
    src, dst = sqlite3.connect(tmp.name), sqlite3.connect(DB_PATH)
    src.backup(dst)
    src.close()
    dst.close()
    os.unlink(tmp.name)
    init_db()
    return {"ok": True}


@app.get("/api/settings/export")
def export_xlsx():
    from openpyxl import Workbook
    wb = Workbook()
    wb.remove(wb.active)
    for t in EXPORT_TABLES:
        rows = q(f"SELECT * FROM {t}")
        ws = wb.create_sheet(t)
        if rows:
            ws.append(list(rows[0].keys()))
            for r in rows:
                ws.append(list(r.values()))
    buf = io.BytesIO()
    wb.save(buf)
    name = f"finance-export-{dt.date.today().isoformat()}.xlsx"
    return Response(buf.getvalue(),
                    media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.post("/api/settings/clear")
async def clear_all(request: Request):
    if not check_pw((await request.json()).get("password", "")):
        raise HTTPException(400, "Wrong password")
    c = conn()
    for t in EXPORT_TABLES:
        c.execute(f"DELETE FROM {t}")
    c.commit()
    c.close()
    return {"ok": True}


# ------------------------------------------------------------------- helpers
def month_of(date):
    return (date or "")[:7]


def this_month():
    return dt.date.today().strftime("%Y-%m")


def clean(entity, d):
    out = {}
    for col in ENT[entity]:
        v = d.get(col)
        if v in ("", None):
            out[col] = None
        elif col in INTEGER:
            out[col] = int(float(v))
        elif col in NUMERIC:
            out[col] = float(v)
        elif col == "linked" and isinstance(v, list):
            out[col] = ",".join(v)
        else:
            out[col] = str(v).strip()
    return out


def next_occurrence(day, today=None):
    import calendar
    today = today or dt.date.today()
    if not day:
        return None
    for add in (0, 1):
        m = today.month - 1 + add
        y, mo = today.year + m // 12, m % 12 + 1
        cand = dt.date(y, mo, min(int(day), calendar.monthrange(y, mo)[1]))
        if cand >= today:
            return cand
    return None


def months_between(a, b):
    return (b.year - a.year) * 12 + (b.month - a.month)


# ------------------------------------------------------------- net worth etc
def summary():
    banks = sum((r["balance"] or 0) for r in q("SELECT balance FROM accounts"))
    assets = {}
    if banks:
        assets["Bank Accounts"] = banks
    for r in q("SELECT type, SUM(current_value) v FROM investments GROUP BY type"):
        if r["v"]:
            assets[r["type"] or "Other"] = r["v"]
    loans = sum((r["outstanding"] or 0) for r in q("SELECT outstanding FROM loans"))
    cards = sum((r["outstanding"] or 0) for r in q("SELECT outstanding FROM cards"))
    liabilities = {}
    if loans:
        liabilities["Loans"] = loans
    if cards:
        liabilities["Credit Cards"] = cards
    ta, tl = sum(assets.values()), sum(liabilities.values())
    return {"assets": assets, "liabilities": liabilities, "total_assets": ta, "total_liabilities": tl,
            "networth": ta - tl}


def take_snapshot(s=None):
    s = s or summary()
    ex("INSERT INTO snapshots(month,networth,assets,liabilities,detail) VALUES(?,?,?,?,?) "
       "ON CONFLICT(month) DO UPDATE SET networth=excluded.networth, assets=excluded.assets, "
       "liabilities=excluded.liabilities, detail=excluded.detail",
       (this_month(), s["networth"], s["total_assets"], s["total_liabilities"], json.dumps(s["assets"])))


def spend_by_category(month):
    out = {}
    for r in q("SELECT category, SUM(amount) a FROM card_txns WHERE substr(date,1,7)=? GROUP BY category", (month,)):
        out[r["category"] or "Others"] = out.get(r["category"] or "Others", 0) + (r["a"] or 0)
    for r in q("SELECT category, SUM(debit) d, SUM(credit) c FROM bank_txns WHERE substr(date,1,7)=? GROUP BY category",
               (month,)):
        cat = r["category"] or "Others"
        if cat in parsers.CREDIT_CATS:
            continue
        out[cat] = out.get(cat, 0) + (r["d"] or 0)
    return {k: v for k, v in out.items() if k not in parsers.EXCLUDED_FROM_SPEND}


def month_income(month):
    manual = q("SELECT SUM(amount) a, COUNT(*) n FROM income WHERE month=?", (month,))[0]
    if manual["n"]:
        return manual["a"] or 0, "manual"
    r = q("SELECT SUM(credit) c FROM bank_txns WHERE substr(date,1,7)=? AND category IN ('Salary','Interest')",
          (month,))[0]
    return (r["c"] or 0), "bank"


def budget_status(month):
    limits = {r["category"]: r["limit_amount"] for r in q("SELECT category, limit_amount FROM budgets")}
    spent = spend_by_category(month)
    cats = []
    for c in parsers.EXPENSE_CATS:
        lim = limits.get(c)
        sp = spent.get(c, 0)
        if lim or sp:
            cats.append({"category": c, "limit": lim or 0, "spent": sp,
                         "pct": round(sp / lim * 100) if lim else None})
    total_spent = sum(spent.values())
    total_limit = limits.get("_total") or sum(v for k, v in limits.items() if k != "_total")
    income, src = month_income(month)
    return {"month": month, "categories": cats, "limits": limits, "total_limit": total_limit or 0,
            "total_spent": total_spent, "income": income, "income_source": src,
            "savings": income - total_spent,
            "savings_rate": round((income - total_spent) / income * 100) if income else None}


def goal_progress(g, s):
    linked = [x for x in (g["linked"] or "").split(",") if x]
    if g["kind"] == "linked" and linked:
        current = sum(s["assets"].get(k, 0) for k in linked)
    else:
        current = s["networth"]
    snaps = q("SELECT month, networth, detail FROM snapshots ORDER BY month DESC LIMIT 4")
    snaps.reverse()

    def measure(sn):
        if g["kind"] == "linked" and linked:
            d = json.loads(sn["detail"] or "{}")
            return sum(d.get(k, 0) for k in linked)
        return sn["networth"]

    growth = None
    if len(snaps) >= 2:
        n = months_between(dt.date.fromisoformat(snaps[0]["month"] + "-01"),
                           dt.date.fromisoformat(snaps[-1]["month"] + "-01"))
        if n > 0:
            growth = (measure(snaps[-1]) - measure(snaps[0])) / n
    target = g["target"] or 0
    gap = max(0, target - current)
    months_left = None
    required = None
    if g["target_date"]:
        td = dt.date.fromisoformat(g["target_date"])
        months_left = max(0, months_between(dt.date.today(), td))
        required = gap / months_left if months_left else gap
    if current >= target and target:
        status = "Achieved"
    elif growth is None or required is None:
        status = "Not enough history"
    elif months_left == 0:
        status = "Behind"
    elif growth >= required * 1.1:
        status = "Ahead"
    elif growth >= required * 0.9:
        status = "On track"
    else:
        status = "Behind"
    return {**g, "linked_list": linked, "current": current, "gap": gap,
            "pct": max(0, min(100, round(current / target * 100))) if target else 0,
            "months_left": months_left, "required_monthly": required, "avg_growth": growth, "status": status}


# ----------------------------------------------------------------- endpoints
@app.get("/api/overview")
def overview():
    s = summary()
    take_snapshot(s)
    today = dt.date.today()
    dues = []
    for l in q("SELECT * FROM loans WHERE emi_day IS NOT NULL"):
        d = next_occurrence(l["emi_day"])
        dues.append({"label": f"{l['lender'] or 'Loan'} EMI", "kind": "Loan", "date": d.isoformat(),
                     "amount": l["emi"], "days": (d - today).days})
    for c in q("SELECT * FROM cards WHERE due_day IS NOT NULL AND outstanding > 0"):
        d = next_occurrence(c["due_day"])
        dues.append({"label": f"{c['name']} card bill", "kind": "Card", "date": d.isoformat(),
                     "amount": c["min_due"] or c["outstanding"], "days": (d - today).days})
    for i in q("SELECT * FROM insurance WHERE renewal_date IS NOT NULL"):
        d = dt.date.fromisoformat(i["renewal_date"])
        if 0 <= (d - today).days <= 60:
            dues.append({"label": f"{i['insurer']} renewal ({i['type']})", "kind": "Insurance",
                         "date": d.isoformat(), "amount": i["premium"], "days": (d - today).days})
    for i in q("SELECT * FROM investments WHERE maturity_date IS NOT NULL"):
        d = dt.date.fromisoformat(i["maturity_date"])
        if 0 <= (d - today).days <= 60:
            dues.append({"label": f"{i['name']} matures", "kind": "Maturity", "date": d.isoformat(),
                         "amount": i["current_value"], "days": (d - today).days})
    dues = sorted([d for d in dues if d["days"] <= 45], key=lambda x: x["days"])
    ins = q("SELECT type, SUM(cover) cover, SUM(premium) premium, COUNT(*) n FROM insurance GROUP BY type")
    return {**s, "trend": q("SELECT month, networth FROM snapshots ORDER BY month DESC LIMIT 12")[::-1],
            "dues": dues, "budget": budget_status(this_month()),
            "goals": [goal_progress(g, s) for g in q("SELECT * FROM goals ORDER BY target_date")[:3]],
            "insurance": ins, "monthly_emi": sum((l["emi"] or 0) for l in q("SELECT emi FROM loans"))}


@app.get("/api/meta")
def meta():
    return {"expense_cats": parsers.EXPENSE_CATS, "card_cats": parsers.EXPENSE_CATS + ["Card Payment"],
            "bank_cats": parsers.EXPENSE_CATS + parsers.NON_SPEND_CATS + parsers.CREDIT_CATS,
            "asset_groups": ["Bank Accounts"] + ["Mutual Fund", "Stock/ETF", "FD", "RD", "PPF", "EPF", "NPS", "Gold",
                                                 "Real Estate", "Crypto", "Other"]}


@app.get("/api/budget")
def get_budget(month: str = None):
    return budget_status(month or this_month())


@app.put("/api/budget")
async def put_budget(request: Request):
    limits = (await request.json()).get("limits", {})
    c = conn()
    c.execute("DELETE FROM budgets")
    for k, v in limits.items():
        if v not in ("", None) and float(v) > 0:
            c.execute("INSERT INTO budgets(category, limit_amount) VALUES(?,?)", (k, float(v)))
    c.commit()
    c.close()
    return {"ok": True}


@app.get("/api/goals")
def list_goals():
    s = summary()
    return [goal_progress(g, s) for g in q("SELECT * FROM goals ORDER BY target_date")]


def _analysis(month, rows, amt_key):
    months = sorted({month_of(r["date"]) for r in rows if r["date"]}, reverse=True)
    month = month if month in months else (months[0] if months else this_month())
    cur = [r for r in rows if month_of(r["date"]) == month]
    cats, merch, monthly = {}, {}, {}
    for r in rows:
        monthly[month_of(r["date"])] = monthly.get(month_of(r["date"]), 0) + (r[amt_key] or 0)
    for r in cur:
        if r["category"] in parsers.EXCLUDED_FROM_SPEND:
            continue
        cats[r["category"]] = cats.get(r["category"], 0) + (r[amt_key] or 0)
        merch[r["description"]] = merch.get(r["description"], 0) + (r[amt_key] or 0)
    return {"months": months, "month": month,
            "total": sum(cats.values()),
            "by_category": sorted(({"category": k, "amount": v} for k, v in cats.items() if v > 0),
                                  key=lambda x: -x["amount"]),
            "merchants": sorted(({"name": k, "amount": v} for k, v in merch.items() if v > 0),
                                key=lambda x: -x["amount"])[:8],
            "txns": sorted(cur, key=lambda x: x["date"], reverse=True)}


@app.get("/api/card-analysis")
def card_analysis(month: str = None, card_id: int = None):
    sql, args = "SELECT t.*, c.name card FROM card_txns t LEFT JOIN cards c ON c.id=t.card_id", ()
    if card_id:
        sql, args = sql + " WHERE t.card_id=?", (card_id,)
    rows = q(sql, args)
    a = _analysis(month, rows, "amount")
    a["txns"] = sorted([r for r in rows if month_of(r["date"]) == a["month"]], key=lambda x: x["date"], reverse=True)
    monthly = {}
    for r in rows:
        if r["category"] not in parsers.EXCLUDED_FROM_SPEND:
            monthly[month_of(r["date"])] = monthly.get(month_of(r["date"]), 0) + (r["amount"] or 0)
    a["monthly"] = [{"month": k, "total": v} for k, v in sorted(monthly.items())][-12:]
    return a


@app.get("/api/bank-analysis")
def bank_analysis(month: str = None, account_id: int = None):
    sql, args = "SELECT t.*, a.name account FROM bank_txns t LEFT JOIN accounts a ON a.id=t.account_id", ()
    if account_id:
        sql, args = sql + " WHERE t.account_id=?", (account_id,)
    rows = q(sql, args)
    months = sorted({month_of(r["date"]) for r in rows}, reverse=True)
    month = month if month in months else (months[0] if months else this_month())
    monthly = []
    for m in sorted(months)[-12:]:
        inc, _ = month_income(m)
        spent = sum(spend_by_category(m).values())
        credits = sum(r["credit"] or 0 for r in rows if month_of(r["date"]) == m)
        debits = sum(r["debit"] or 0 for r in rows if month_of(r["date"]) == m)
        monthly.append({"month": m, "credits": credits, "debits": debits, "income": inc, "spent": spent,
                        "savings": inc - spent})
    return {"months": months, "month": month, "monthly": monthly,
            "txns": sorted([r for r in rows if month_of(r["date"]) == month], key=lambda x: x["date"], reverse=True)}


def _hash(*parts):
    return hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()


@app.post("/api/cards/{cid}/txns/bulk")
async def card_bulk(cid: int, request: Request):
    added = skipped = 0
    seen = {}
    for t in (await request.json()).get("txns", []):
        base = _hash(cid, t["date"], t["description"], round(float(t["amount"]), 2))
        n = seen[base] = seen.get(base, 0) + 1          # allow genuine same-day repeats within one file
        try:
            ex("INSERT INTO card_txns(card_id,date,description,amount,category,hash) VALUES(?,?,?,?,?,?)",
               (cid, t["date"], t["description"], float(t["amount"]), t.get("category") or "Others",
                _hash(base, n)))
            added += 1
        except sqlite3.IntegrityError:
            skipped += 1
    return {"added": added, "skipped": skipped}


@app.post("/api/accounts/{aid}/txns/bulk")
async def bank_bulk(aid: int, request: Request):
    body = await request.json()
    added = skipped = 0
    seen = {}
    for t in body.get("txns", []):
        base = _hash(aid, t["date"], t["description"], round(float(t.get("debit") or 0), 2),
                     round(float(t.get("credit") or 0), 2))
        n = seen[base] = seen.get(base, 0) + 1
        try:
            ex("INSERT INTO bank_txns(account_id,date,description,debit,credit,category,hash) VALUES(?,?,?,?,?,?,?)",
               (aid, t["date"], t["description"], float(t.get("debit") or 0), float(t.get("credit") or 0),
                t.get("category") or "Others", _hash(base, n)))
            added += 1
        except sqlite3.IntegrityError:
            skipped += 1
    if body.get("closing_balance") is not None:
        ex("UPDATE accounts SET balance=? WHERE id=?", (float(body["closing_balance"]), aid))
    return {"added": added, "skipped": skipped}


@app.put("/api/card-txns/{tid}")
async def card_txn_update(tid: int, request: Request):
    ex("UPDATE card_txns SET category=? WHERE id=?", ((await request.json())["category"], tid))
    return {"ok": True}


@app.delete("/api/card-txns/{tid}")
def card_txn_delete(tid: int):
    ex("DELETE FROM card_txns WHERE id=?", (tid,))
    return {"ok": True}


@app.put("/api/bank-txns/{tid}")
async def bank_txn_update(tid: int, request: Request):
    ex("UPDATE bank_txns SET category=? WHERE id=?", ((await request.json())["category"], tid))
    return {"ok": True}


@app.delete("/api/bank-txns/{tid}")
def bank_txn_delete(tid: int):
    ex("DELETE FROM bank_txns WHERE id=?", (tid,))
    return {"ok": True}


@app.post("/api/investments/bulk")
async def inv_bulk(request: Request):
    rows = (await request.json()).get("rows", [])
    for r in rows:
        d = clean("investments", r)
        ex("INSERT INTO investments(type,name,invested,current_value,maturity_date,notes) VALUES(?,?,?,?,?,?)",
           (d["type"] or "Other", d["name"], d["invested"] or 0, d["current_value"] or 0, d["maturity_date"], d["notes"]))
    return {"added": len(rows)}


@app.post("/api/parse/{kind}")
async def parse_upload(kind: str, file: UploadFile = File(...), password: str = Form(""),
                       default_type: str = Form("Mutual Fund")):
    data = await file.read()
    if len(data) > 25 * 1024 * 1024:
        raise HTTPException(413, "File too large (max 25 MB)")
    fn = file.filename or "file"
    if not fn.lower().endswith((".pdf", ".csv", ".txt", ".tsv", ".xlsx", ".xlsm", ".xls")):
        raise HTTPException(400, "Upload a PDF, CSV or Excel file")
    try:
        if kind == "card":
            return parsers.parse_card_statement(data, fn, password)
        if kind == "bank":
            return parsers.parse_bank_statement(data, fn, password)
        if kind == "loan":
            return parsers.parse_loan_statement(data, fn, password)
        if kind == "investments":
            if fn.lower().endswith(".pdf"):
                raise HTTPException(400, "For investments please upload an Excel or CSV file")
            rows = parsers.parse_investments(data, fn, default_type)
            return {"rows": rows,
                    "warning": None if rows else "No holdings found. Expected columns like Name, Invested, Current Value."}
    except parsers.NeedPassword:
        raise HTTPException(422, "password_required")
    except parsers.WrongPassword:
        raise HTTPException(422, "wrong_password")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"Could not read this file ({type(e).__name__}). Try CSV/Excel or add entries manually.")
    raise HTTPException(404, "Unknown upload type")


def register_crud(name):
    cols = ENT[name]

    def lst():
        return q(f"SELECT * FROM {name} ORDER BY {ORDER[name]}")

    async def create(request: Request):
        d = clean(name, await request.json())
        rid = ex(f"INSERT INTO {name}({','.join(cols)}) VALUES({','.join('?' * len(cols))})", [d[c] for c in cols])
        return {"id": rid}

    async def update(rid: int, request: Request):
        d = clean(name, await request.json())
        ex(f"UPDATE {name} SET {','.join(c + '=?' for c in cols)} WHERE id=?", [d[c] for c in cols] + [rid])
        return {"ok": True}

    def delete(rid: int):
        ex(f"DELETE FROM {name} WHERE id=?", (rid,))
        return {"ok": True}

    if name != "goals":
        app.get(f"/api/{name}")(lst)
    app.post(f"/api/{name}")(create)
    app.put(f"/api/{name}/{{rid}}")(update)
    app.delete(f"/api/{name}/{{rid}}")(delete)


for _n in ENT:
    register_crud(_n)

app.mount("/static", StaticFiles(directory=os.path.join(BASE, "static")), name="static")


@app.get("/favicon.ico")
def favicon():
    return Response(status_code=204)


@app.get("/")
def index():
    return FileResponse(os.path.join(BASE, "static", "index.html"))


if __name__ == "__main__":
    init_db()
    if "--reset-password" in sys.argv:
        import getpass
        pw = getpass.getpass("New password (min 6 chars): ")
        if len(pw) < 6 or pw != getpass.getpass("Repeat password: "):
            sys.exit("Passwords did not match or are too short. Nothing changed.")
        salt, h = hash_pw(pw)
        set_setting("pw_salt", salt)
        set_setting("pw_hash", h)
        sys.exit("Password updated. Your data was not touched.")
    import uvicorn
    print("\n  Finance Dashboard running at  http://localhost:8000   (Ctrl+C to stop)\n")
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="warning")
else:
    init_db()
