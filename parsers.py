"""Rule-based, fully offline statement parsing (PDF / CSV / Excel)."""
import io
import re
import datetime as dt

import pandas as pd
import pdfplumber
from pdfminer.pdfdocument import PDFPasswordIncorrect


class NeedPassword(Exception):
    pass


class WrongPassword(Exception):
    pass


# ---------------------------------------------------------------- categories
EXPENSE_CATS = ["Food & Dining", "Groceries", "Shopping", "Travel", "Fuel", "Bills & Utilities",
                "Entertainment", "Health", "Education", "Insurance", "Rent", "Loan EMI", "Cash", "Others"]
NON_SPEND_CATS = ["Card Payment", "Transfer", "Investment"]
CREDIT_CATS = ["Salary", "Interest", "Refund", "Other Credit"]
EXCLUDED_FROM_SPEND = set(NON_SPEND_CATS)

RULES = [
    ("Card Payment", ["credit card payment", "cc payment", "card payment", "payment received", "payment thank",
                      "bppy", "cred club", "cred.club", "autopay card", "billdesk cc", "cc bill", "card bill"]),
    ("Loan EMI", ["emi", "loan", "bajaj fin", "finserv", "tata capital", "ach d-", "nach"]),
    ("Investment", ["zerodha", "groww", "upstox", "mutual fund", "sip ", "nps", "ppf", "kuvera", "indmoney",
                    "smallcase", "coin by", "icclgrow", "ccil", "bse ltd", "nse clearing"]),
    ("Insurance", ["insurance", "lic of india", "lic premium", "policybazaar", "hdfc life", "icici pru", "star health",
                   "max life", "acko", "sbi life", "bajaj allianz", "care health", "niva bupa", "premium"]),
    ("Food & Dining", ["swiggy", "zomato", "restaurant", "cafe", "pizza", "mcdonald", "dominos", "kfc", "starbucks",
                       "bakery", "eatery", "burger", "food", "biryani", "dhaba", "barbeque", "haldiram", "chaayos"]),
    ("Groceries", ["bigbasket", "blinkit", "zepto", "dmart", "avenue super", "grofers", "instamart", "reliance fresh",
                   "more retail", "supermarket", "grocery", "nature's basket", "jiomart", "milkbasket", "kirana"]),
    ("Shopping", ["amazon", "flipkart", "myntra", "ajio", "nykaa", "meesho", "tata cliq", "reliance digital", "croma",
                  "decathlon", "ikea", "lifestyle", "westside", "pantaloons", "shoppers stop", "max fashion", "h&m",
                  "zara", "uniqlo", "apple store", "lenskart", "firstcry"]),
    ("Travel", ["uber", "ola ", "olacabs", "rapido", "irctc", "makemytrip", "goibibo", "cleartrip", "redbus", "indigo",
                "air india", "vistara", "akasa", "airline", "railway", "metro", "fastag", "ixigo", "agoda", "oyo",
                "booking.com", "airbnb", "taj hotel", "marriott", "hotel", "yatra"]),
    ("Fuel", ["petrol", "hpcl", "bpcl", "iocl", "indian oil", "shell", "fuel", "bharat petroleum",
              "hindustan petroleum", "nayara", "reliance bp"]),
    ("Bills & Utilities", ["electricity", "bescom", "tneb", "tata power", "adani electric", "mseb", "airtel", "jio",
                           "vodafone", "bsnl", "broadband", "fibernet", "gas ", "water bill", "recharge", "dth",
                           "tata play", "tata sky", "bharat bill", "bbps", "piped gas", "mahanagar", "indane",
                           "municipal", "property tax"]),
    ("Entertainment", ["netflix", "hotstar", "prime video", "spotify", "youtube", "bookmyshow", "pvr", "inox",
                       "sonyliv", "zee5", "steam", "playstation", "xbox", "apple.com", "google play", "jiocinema"]),
    ("Health", ["pharmacy", "apollo", "1mg", "pharmeasy", "hospital", "clinic", "diagnostic", "medplus", "netmeds",
                "lab", "dental", "practo", "medical", "healthcare", "cult.fit", "cultfit", "gym"]),
    ("Education", ["school", "college", "university", "udemy", "coursera", "byju", "unacademy", "tuition", "fees",
                   "upgrad", "vedantu"]),
    ("Rent", ["rent", "nobroker", "housing society", "maintenance", "nestaway"]),
    ("Cash", ["atm", "cash withdrawal", "nwd", "cash wdl", "cash wd"]),
    ("Transfer", ["neft", "imps", "rtgs", "fund transfer", "self transfer", "own account", "ift"]),
]
CREDIT_RULES = [
    ("Salary", ["salary", "payroll", "sal credit", "sal for", " sal "]),
    ("Interest", ["int.pd", "int pd", "interest", "dividend", "int credit"]),
    ("Refund", ["refund", "reversal", "cashback", "reversed"]),
]


def categorize(desc, is_credit=False, bank=False):
    d = " " + (desc or "").lower() + " "
    if is_credit:
        for cat, keys in CREDIT_RULES:
            if any(k in d for k in keys):
                return cat
        if any(k in d for k in RULES[0][1]):
            return "Card Payment"
        if bank:
            return "Other Credit"
    for cat, keys in RULES:
        if any(k in d for k in keys):
            return cat
    return "Other Credit" if (bank and is_credit) else "Others"


# ------------------------------------------------------------------ helpers
DATE_FORMATS = ["%d/%m/%Y", "%d-%m-%Y", "%d/%m/%y", "%d-%m-%y", "%d %b %Y", "%d %b %y", "%d-%b-%Y", "%d-%b-%y",
                "%d %B %Y", "%d-%B-%Y", "%Y-%m-%d", "%d.%m.%Y", "%d.%m.%y", "%d/%b/%Y", "%b %d, %Y", "%d %b, %Y",
                "%m/%d/%Y"]


def parse_date(s):
    if s is None:
        return None
    if isinstance(s, (dt.datetime, dt.date, pd.Timestamp)):
        return pd.Timestamp(s).date().isoformat()
    s = str(s).strip().replace("'", " ")
    s = re.sub(r"(\d)(st|nd|rd|th)\b", r"\1", s)
    s = re.sub(r"\s+\d{1,2}:\d{2}(:\d{2})?.*$", "", s)  # drop times
    for f in DATE_FORMATS:
        try:
            return dt.datetime.strptime(s, f).date().isoformat()
        except ValueError:
            pass
    return None


def num(s):
    """'1,23,456.78 Cr' -> 123456.78 ; returns None if not a number."""
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return None if pd.isna(s) else float(s)
    t = str(s).strip()
    if not t or t.lower() in ("nan", "none", "-"):
        return None
    neg = t.startswith("(") and t.endswith(")")
    t = re.sub(r"(?i)(₹|rs\.?|inr|cr\.?|dr\.?)", "", t)
    t = t.replace(",", "").replace("(", "").replace(")", "").strip()
    try:
        v = float(t)
    except ValueError:
        return None
    return -v if neg else v


AMT_RE = re.compile(r"(?<![\d.,/-])(\d{1,3}(?:,\d{2,3})+|\d+)\.\d{2}(?!\d)\s*(Cr|CR|cr|Dr|DR|dr)?(?![A-Za-z])")
DATE_START = re.compile(r"^\s*(\d{1,2}[/\-. ](?:\d{1,2}|[A-Za-z]{3,9})[/\-. ,]{1,2}\d{2,4})\b")
BANKS = [("HDFC", "HDFC Bank"), ("ICICI", "ICICI Bank"), ("State Bank", "SBI"), ("SBI", "SBI"), ("Axis", "Axis Bank"),
         ("Kotak", "Kotak Mahindra Bank"), ("IDFC", "IDFC FIRST Bank"), ("Yes Bank", "Yes Bank"),
         ("IndusInd", "IndusInd Bank"), ("RBL", "RBL Bank"), ("Standard Chartered", "Standard Chartered"),
         ("Citi", "Citibank"), ("AU Small", "AU Small Finance Bank"), ("Federal", "Federal Bank"),
         ("Bank of Baroda", "Bank of Baroda"), ("Punjab National", "PNB"), ("PNB", "PNB"), ("Canara", "Canara Bank"),
         ("Union Bank", "Union Bank of India"), ("American Express", "American Express"), ("HSBC", "HSBC"),
         ("Bajaj Finance", "Bajaj Finance"), ("Bajaj Finserv", "Bajaj Finserv"), ("Tata Capital", "Tata Capital"),
         ("LIC Housing", "LIC Housing Finance"), ("L&T Finance", "L&T Finance"), ("Piramal", "Piramal Finance"),
         ("Muthoot", "Muthoot Finance"), ("Mahindra Finance", "Mahindra Finance"), ("Hero FinCorp", "Hero FinCorp"),
         ("Aditya Birla", "Aditya Birla Capital"), ("Bank of India", "Bank of India"), ("Indian Bank", "Indian Bank")]


def find_bank(text):
    head = text[:3000]
    best = None
    for key, name in BANKS:
        i = re.search(re.escape(key), head, re.I)
        if i and (best is None or i.start() < best[0]):
            best = (i.start(), name)
    return best[1] if best else ""


def last4(text):
    m = re.search(r"(?i)(?:card|account|a/c)\s*(?:no\.?|number|#)?\s*[:\-]?\s*((?:[\dXx*•]{2,}[\s-]*){2,5})", text)
    if m:
        digits = re.findall(r"\d", m.group(1))
        if len(digits) >= 4:
            return "".join(digits[-4:])
    return ""


# -------------------------------------------------------------- file reading
def pdf_text(data, password=None):
    try:
        with pdfplumber.open(io.BytesIO(data), password=password or None) as pdf:
            return "\n".join((p.extract_text() or "") for p in pdf.pages)
    except PDFPasswordIncorrect:
        raise WrongPassword() if password else NeedPassword()
    except Exception as e:  # pdfplumber wraps pdfminer's password error
        inner = e.args[0] if e.args else None
        if isinstance(inner, PDFPasswordIncorrect) or "password" in repr(e).lower() or "encrypt" in repr(e).lower():
            raise WrongPassword() if password else NeedPassword()
        raise


def read_tables(data, filename):
    """Return list of DataFrames (header=None, all strings) for CSV/Excel."""
    name = filename.lower()
    if name.endswith((".csv", ".txt", ".tsv")):
        txt = data.decode("utf-8-sig", errors="replace")
        rows = []
        import csv
        dialect = csv.Sniffer().sniff(txt[:4096], delimiters=",;\t|") if txt.strip() else csv.excel
        for r in csv.reader(io.StringIO(txt), dialect):
            rows.append(r)
        width = max((len(r) for r in rows), default=0)
        return [pd.DataFrame([r + [""] * (width - len(r)) for r in rows], dtype=object)]
    sheets = pd.read_excel(io.BytesIO(data), sheet_name=None, header=None, dtype=object)
    return [df for df in sheets.values() if len(df) > 0]


def tables_to_text(dfs):
    out = []
    for df in dfs:
        for _, row in df.iterrows():
            cells = [str(c).strip() for c in row if str(c).strip() not in ("", "nan", "NaT", "None")]
            if cells:
                out.append(" : ".join(cells))
    return "\n".join(out)


def load_text_and_tables(data, filename, password=None):
    name = filename.lower()
    if name.endswith(".pdf"):
        return pdf_text(data, password), None
    dfs = read_tables(data, filename)
    return tables_to_text(dfs), dfs


# ------------------------------------------------------- transaction parsing
HEADER_KEYS = {
    "date": ["date", "txn date", "transaction date", "tran date", "value date", "posting date"],
    "desc": ["description", "narration", "particulars", "details", "transaction details", "remarks",
             "transaction remarks", "merchant"],
    "debit": ["debit", "withdrawal", "withdrawals", "withdrawal amt", "withdrawal amount", "dr", "debit amount",
              "debit amt"],
    "credit": ["credit", "deposit", "deposits", "deposit amt", "deposit amount", "cr", "credit amount", "credit amt"],
    "amount": ["amount", "amount (inr)", "transaction amount", "amt", "amount in rs"],
    "drcr": ["dr/cr", "cr/dr", "type", "transaction type", "debit/credit"],
    "balance": ["balance", "closing balance", "running balance", "balance amt", "bal"],
}


def _map_header(row):
    m = {}
    for i, c in enumerate(row):
        t = str(c).strip().lower()
        for key, names in HEADER_KEYS.items():
            if t in names and key not in m:
                m[key] = i
    return m


def rows_from_tables(dfs):
    """Normalise CSV/Excel into [{date, desc, amount, direction, balance}]."""
    out = []
    for df in dfs:
        hdr_i, mp = None, {}
        for i in range(min(len(df), 60)):
            mp = _map_header(df.iloc[i].tolist())
            if "date" in mp and ("amount" in mp or "debit" in mp or "credit" in mp):
                hdr_i = i
                break
        if hdr_i is None:
            continue
        for i in range(hdr_i + 1, len(df)):
            r = df.iloc[i].tolist()
            d = parse_date(r[mp["date"]])
            if not d:
                continue
            desc = str(r[mp["desc"]]).strip() if "desc" in mp else ""
            bal = num(r[mp["balance"]]) if "balance" in mp else None
            amt, direction = None, None
            deb = num(r[mp["debit"]]) if "debit" in mp else None
            cre = num(r[mp["credit"]]) if "credit" in mp else None
            if deb:
                amt, direction = abs(deb), "Dr"
            elif cre:
                amt, direction = abs(cre), "Cr"
            elif "amount" in mp:
                a = num(r[mp["amount"]])
                if a is None or a == 0:
                    continue
                tag = str(r[mp["drcr"]]).lower() if "drcr" in mp else ""
                raw = str(r[mp["amount"]]).lower()
                if "cr" in tag or "credit" in tag or raw.rstrip().endswith("cr"):
                    direction = "Cr"
                elif "dr" in tag or "debit" in tag or raw.rstrip().endswith("dr"):
                    direction = "Dr"
                else:
                    direction = "Cr" if a < 0 else "Dr"   # card exports: negative = credit
                amt = abs(a)
            if amt:
                out.append({"date": d, "desc": desc, "amount": amt, "direction": direction, "balance": bal})
    return out


def _amt_value(m):
    return num(re.sub(r"(?i)\s*(cr|dr)$", "", m.group(0).strip()))


def rows_from_pdf_text(text, mode):
    """PDF text lines that start with a date -> normalised rows."""
    rows = []
    prev_bal = None
    m = re.search(r"(?i)opening\s+balance[^\d\n]{0,30}((?:\d{1,3}(?:,\d{2,3})*|\d+)\.\d{2})", text)
    if m:
        prev_bal = num(m.group(1))
    for line in text.splitlines():
        dm = DATE_START.match(line)
        if not dm:
            continue
        d = parse_date(dm.group(1))
        if not d:
            continue
        rest = line[dm.end():]
        rest = DATE_START.sub("", rest, count=1)           # second (value/posting) date
        amts = list(AMT_RE.finditer(rest))
        if not amts:
            continue
        desc_end = amts[0].start()
        desc = re.sub(r"\b\d{1,2}:\d{2}(:\d{2})?\b", " ", rest[:desc_end])
        desc = re.sub(r"[|]+", " ", desc)
        desc = re.sub(r"\s+", " ", desc).strip(" -:")
        balance = None
        if mode == "bank" and len(amts) >= 2:
            balance = _amt_value(amts[-1])
            a = amts[-2]
        else:
            a = amts[-1]
        value = _amt_value(a)
        tag = (a.group(2) or "").lower()
        direction = "Cr" if tag == "cr" else "Dr" if tag == "dr" else None
        if mode == "bank" and balance is not None and prev_bal is not None and direction is None:
            direction = "Cr" if balance > prev_bal else "Dr"
        if mode == "bank" and balance is not None:
            prev_bal = balance
        if direction is None:
            low = desc.lower()
            credit_words = ("salary", "refund", "reversal", "credit", "interest", "int.pd", "deposit", "cashback",
                            "payment received", "payment thank", "upi/cr", " cr ")
            direction = "Cr" if any(w in low for w in credit_words) else "Dr"
        if value:
            rows.append({"date": d, "desc": desc, "amount": abs(value), "direction": direction, "balance": balance})
    return rows


def extract_rows(text, dfs, mode):
    rows = rows_from_tables(dfs) if dfs else []
    if not rows:
        rows = rows_from_pdf_text(text, mode)
    return rows


# ------------------------------------------------------------ public parsers
def _amount_after(text, labels, window=70):
    for lab in labels:
        m = re.search(lab + r"[^\n\d₹]{0,%d}?(?:₹|Rs\.?|INR)?\s*((?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d{1,2})?)" % window,
                      text, re.I)
        if m:
            v = num(m.group(1))
            if v is not None:
                return v
    return None


def _date_after(text, labels, window=60):
    pat = (r"(\d{1,2}[/\-. ](?:\d{1,2}|[A-Za-z]{3,9})[/\-. ,]{1,2}\d{2,4})")
    for lab in labels:
        m = re.search(lab + r"[^\n\d]{0,%d}?" % window + pat, text, re.I)
        if m:
            d = parse_date(m.group(1))
            if d:
                return d
    return None


def parse_card_statement(data, filename, password=None):
    text, dfs = load_text_and_tables(data, filename, password)
    rows = extract_rows(text, dfs, "card")
    txns = []
    for r in rows:
        credit = r["direction"] == "Cr"
        cat = categorize(r["desc"], is_credit=credit)
        txns.append({"date": r["date"], "description": r["desc"], "amount": -r["amount"] if credit else r["amount"],
                     "category": cat})
    due = _date_after(text, [r"payment\s+due\s+date", r"due\s+date"])
    return {
        "bank": find_bank(text),
        "last4": last4(text),
        "credit_limit": _amount_after(text, [r"total\s+credit\s+limit", r"credit\s+limit"]),
        "outstanding": _amount_after(text, [r"total\s+amount\s+due", r"total\s+dues?", r"total\s+payment\s+due",
                                            r"amount\s+due", r"closing\s+balance"]),
        "min_due": _amount_after(text, [r"minimum\s+(?:amount\s+)?due", r"min(?:imum)?\.?\s+payment\s+due",
                                        r"min\.?\s+amount\s+due"]),
        "due_day": int(due[8:10]) if due else None,
        "due_date": due,
        "txns": txns,
        "warning": None if txns else "No transactions could be read from this file. Check the format or add them manually.",
    }


def parse_bank_statement(data, filename, password=None):
    text, dfs = load_text_and_tables(data, filename, password)
    rows = extract_rows(text, dfs, "bank")
    txns = []
    for r in rows:
        credit = r["direction"] == "Cr"
        txns.append({"date": r["date"], "description": r["desc"], "debit": 0 if credit else r["amount"],
                     "credit": r["amount"] if credit else 0, "balance": r["balance"],
                     "category": categorize(r["desc"], is_credit=credit, bank=True)})
    closing = None
    balances = [(t["date"], t["balance"]) for t in txns if t["balance"] is not None]
    if balances:
        closing = balances[-1][1] if balances[-1][0] >= balances[0][0] else balances[0][1]
    if closing is None:
        closing = _amount_after(text, [r"closing\s+balance", r"available\s+balance"])
    return {"bank": find_bank(text), "last4": last4(text), "closing_balance": closing, "txns": txns,
            "warning": None if txns else "No transactions could be read from this file. Check the format or add them manually."}


LOAN_TYPES = [("Home Loan", r"home\s+loan|housing\s+loan|home\s+finance"),
              ("Loan Against Property", r"loan\s+against\s+property|\bLAP\b"),
              ("Car Loan", r"car\s+loan|auto\s+loan|vehicle\s+loan|four[\s-]wheeler|used\s+car"),
              ("Two-Wheeler Loan", r"two[\s-]wheeler|bike\s+loan"),
              ("Education Loan", r"education(?:al)?\s+loan|student\s+loan|vidya"),
              ("Gold Loan", r"gold\s+loan"),
              ("Business Loan", r"business\s+loan|msme|working\s+capital"),
              ("Personal Loan", r"personal\s+loan|consumer\s+(?:durable\s+)?loan")]


def parse_loan_statement(data, filename, password=None):
    text, _ = load_text_and_tables(data, filename, password)
    best, best_n = "", 0
    for name, pat in LOAN_TYPES:
        n = len(re.findall(pat, text, re.I))
        if n > best_n:
            best, best_n = name, n
    emi_day = None
    m = re.search(r"(\d{1,2})(?:st|nd|rd|th)?\s+of\s+(?:every|each)\s+month", text, re.I)
    if m:
        emi_day = int(m.group(1))
    emi_date = _date_after(text, [r"emi\s+(?:due\s+)?date", r"next\s+(?:emi\s+)?(?:due\s+)?date",
                                  r"next\s+instal+ment\s+date", r"due\s+date", r"repayment\s+date"])
    if emi_day is None and emi_date:
        emi_day = int(emi_date[8:10])
    end = _date_after(text, [r"last\s+emi\s+date", r"loan\s+end\s+date", r"maturity\s+date", r"expiry\s+date",
                             r"final\s+emi\s+date", r"end\s+date", r"loan\s+closure\s+date"])
    if not end:
        m = re.search(r"(?:remaining|balance|residual)\s+tenure[^\d\n]{0,30}(\d{1,3})\s*(?:months|emis?|instal)", text, re.I)
        if m:
            t = dt.date.today()
            mo = t.month - 1 + int(m.group(1))
            end = dt.date(t.year + mo // 12, mo % 12 + 1, min(t.day, 28)).isoformat()
    rate = None
    m = re.search(r"(?:rate\s+of\s+interest|interest\s+rate|\broi\b)[^\d\n]{0,40}(\d{1,2}(?:\.\d{1,2})?)", text, re.I)
    if m:
        rate = float(m.group(1))
    return {
        "type": best or "Other Loan",
        "lender": find_bank(text),
        "emi": _amount_after(text, [r"emi\s+amount", r"instal+ment\s+amount", r"monthly\s+instal+ment",
                                    r"monthly\s+emi", r"\bemi\b"]),
        "emi_day": emi_day,
        "end_date": end,
        "outstanding": _amount_after(text, [r"principal\s+outstanding", r"outstanding\s+principal",
                                            r"total\s+outstanding", r"current\s+outstanding",
                                            r"outstanding\s+(?:balance|amount)", r"\bPOS\b", r"foreclosure\s+amount"]),
        "rate": rate,
        "principal": _amount_after(text, [r"sanctioned\s+(?:loan\s+)?amount", r"loan\s+amount",
                                          r"disbursed\s+amount", r"amount\s+financed", r"principal\s+amount"]),
    }


INV_KEYS = {
    "name": ["name", "scheme", "scheme name", "fund", "fund name", "instrument", "security", "stock", "symbol",
             "holding", "company", "company name", "script"],
    "type": ["type", "asset class", "asset type", "category", "product"],
    "invested": ["invested", "invested amount", "invested value", "cost", "cost value", "buy value", "amount invested",
                 "purchase value", "total cost"],
    "avg": ["avg. cost", "avg cost", "average cost", "avg price", "buy avg", "avg. price", "purchase price"],
    "qty": ["qty", "qty.", "quantity", "units", "shares", "balance units"],
    "current": ["current value", "cur. val", "cur val", "market value", "present value", "current amount",
                "valuation", "value", "current", "closing value"],
}


def parse_investments(data, filename, default_type="Mutual Fund"):
    dfs = read_tables(data, filename)
    out = []
    for df in dfs:
        hdr_i, mp = None, {}
        for i in range(min(len(df), 60)):
            row = [str(c).strip().lower() for c in df.iloc[i].tolist()]
            mp = {}
            for key, names in INV_KEYS.items():
                for j, c in enumerate(row):
                    if c in names and key not in mp and j not in mp.values():
                        mp[key] = j
            if "name" in mp and ("current" in mp or "invested" in mp):
                hdr_i = i
                break
        if hdr_i is None:
            continue
        for i in range(hdr_i + 1, len(df)):
            r = df.iloc[i].tolist()
            name = str(r[mp["name"]]).strip()
            if not name or name.lower() in ("nan", "total", "grand total"):
                continue
            inv = num(r[mp["invested"]]) if "invested" in mp else None
            if inv is None and "qty" in mp and "avg" in mp:
                q, a = num(r[mp["qty"]]), num(r[mp["avg"]])
                inv = q * a if q is not None and a is not None else None
            cur = num(r[mp["current"]]) if "current" in mp else None
            if inv is None and cur is None:
                continue
            typ = str(r[mp["type"]]).strip() if "type" in mp else ""
            if not typ or typ.lower() == "nan":
                typ = default_type
            out.append({"type": typ, "name": name, "invested": inv or 0, "current_value": cur if cur is not None else (inv or 0)})
    return out
