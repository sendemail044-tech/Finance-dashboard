/* My Finances - vanilla JS front end */
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const inr = n => (n < 0 ? '-₹' : '₹') + nf.format(Math.abs(Math.round(n || 0)));
const amt = n => `<span class="amt">${inr(n)}</span>`;
const hiding = () => document.body.classList.contains('hide-amt');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = m => m ? `${MON[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}` : '';
const dateLabel = d => d ? `${+d.slice(8, 10)} ${MON[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}` : '–';
const curMonth = () => new Date().toISOString().slice(0, 7);
const sum = (a, f) => a.reduce((t, x) => t + (f(x) || 0), 0);

const state = { lockMin: 2, meta: null, route: 'overview' };

/* ------------------------------------------------------------------ api */
async function api(path, opts = {}) {
  const o = { headers: {}, ...opts };
  if (o.json !== undefined) {
    o.method = o.method || 'POST';
    o.headers['Content-Type'] = 'application/json';
    o.body = JSON.stringify(o.json);
  }
  const r = await fetch('/api' + path, o);
  if (r.status === 401 && !path.startsWith('/auth')) { lockNow(true); throw new Error('locked'); }
  let data = null;
  try { data = await r.json(); } catch (e) { }
  if (!r.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : 'Request failed');
  return data;
}
const qs = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v)).toString();
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 3200);
}

/* --------------------------------------------------------------- charts */
const PAL = ['#2563eb', '#93b4f8', '#1e3a8a', '#475569', '#bfd2fb', '#94a3b8', '#3b82f6', '#cbd5e1', '#64748b', '#dbe6fd'];
const chartFmt = v => hiding() ? '••••' : inr(v);
function drawChart(id, cfg) {
  const el = document.getElementById(id);
  if (!el) return;
  const old = Chart.getChart(el); if (old) old.destroy();
  Chart.defaults.font.family = 'system-ui, sans-serif';
  Chart.defaults.color = '#64748b';
  new Chart(el, cfg);
}
const tip = { callbacks: { label: c => ` ${c.label || c.dataset.label}: ${chartFmt(c.parsed.y ?? c.parsed)}` } };
function donut(id, labels, values) {
  drawChart(id, { type: 'doughnut', data: { labels, datasets: [{ data: values, backgroundColor: PAL, borderWidth: 2, borderColor: '#fff' }] },
    options: { maintainAspectRatio: false, cutout: '62%', plugins: { legend: { display: false }, tooltip: tip } } });
}
function bars(id, labels, datasets, stacked) {
  drawChart(id, { type: 'bar', data: { labels, datasets: datasets.map((d, i) => ({ backgroundColor: PAL[i === 0 ? 0 : i === 1 ? 5 : 1], borderRadius: 4, ...d })) },
    options: { maintainAspectRatio: false, plugins: { legend: { display: datasets.length > 1 }, tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${chartFmt(c.parsed.y)}` } } },
      scales: { x: { stacked, grid: { display: false } }, y: { stacked, ticks: { callback: chartFmt }, grid: { color: '#eef2f7' } } } } });
}
function legend(labels, values) {
  const tot = sum(values, x => x) || 1;
  return `<div class="legend">${labels.map((l, i) => `<div><i style="background:${PAL[i % PAL.length]}"></i>${esc(l)}<b>${amt(values[i])}</b><span class="muted" style="width:38px;text-align:right">${Math.round(values[i] / tot * 100)}%</span></div>`).join('')}</div>`;
}

/* ---------------------------------------------------------------- modal */
let modalToken = 0;
function closeModal() { modalToken++; $('#modalRoot').innerHTML = ''; }
function openModal({ title, body, submitText = 'Save', onSubmit, wide, onOpen, hideSubmit }) {
  const token = ++modalToken;
  $('#modalRoot').innerHTML = `<div class="modal-back"><div class="modal ${wide ? 'wide' : ''}">
    <div class="m-head"><h3>${esc(title)}</h3><button class="x" data-x>&times;</button></div>
    <div class="m-body">${body}</div>
    <div class="m-foot"><span class="err"></span><button class="btn ghost" data-x>Cancel</button>
    ${hideSubmit ? '' : `<button class="btn" data-ok>${esc(submitText)}</button>`}</div></div></div>`;
  const root = $('#modalRoot');
  root.querySelectorAll('[data-x]').forEach(b => b.onclick = closeModal);
  const ok = $('[data-ok]', root);
  if (ok) ok.onclick = async () => {
    $('.err', root).textContent = '';
    ok.disabled = true;
    try {
      const r = await onSubmit(root);
      if (r !== false && token === modalToken) closeModal();
    } catch (e) { if (token === modalToken) $('.err', root).textContent = e.message; }
    ok.disabled = false;
  };
  if (onOpen) onOpen(root);
  return root;
}

/* ---------------------------------------------------------------- forms */
const optPair = o => Array.isArray(o) ? o : [o, o];
function fieldHtml(f, v) {
  const val = v ?? '';
  const id = 'f_' + f.k;
  let input;
  if (f.t === 'select') {
    const opts = f.opts.map(optPair);
    if (val !== '' && !opts.some(o => o[0] == val)) opts.push([val, val]);
    input = `<select id="${id}">${opts.map(o => `<option value="${esc(o[0])}" ${o[0] == val ? 'selected' : ''}>${esc(o[1])}</option>`).join('')}</select>`;
  } else if (f.t === 'multi') {
    const cur = String(val).split(',');
    input = `<div class="checks" id="${id}">${f.opts.map(o => `<label><input type="checkbox" value="${esc(o)}" ${cur.includes(o) ? 'checked' : ''}>${esc(o)}</label>`).join('')}</div>`;
  } else {
    const type = f.t === 'number' ? 'number' : f.t || 'text';
    input = `<input id="${id}" type="${type}" ${f.t === 'number' ? 'step="any" min="0"' : ''} value="${esc(val)}" placeholder="${esc(f.ph || '')}" ${f.list ? `list="dl_${f.k}"` : ''}>`;
    if (f.list) input += `<datalist id="dl_${f.k}">${f.list.map(x => `<option value="${esc(x)}">`).join('')}</datalist>`;
  }
  return `<div class="field" data-k="${f.k}"><label for="${id}">${esc(f.l)}${f.req ? ' *' : ''}</label>${input}</div>`;
}
function formHtml(fields, values = {}) {
  let out = '', row = [];
  const flush = () => { if (row.length) out += `<div class="frow">${row.join('')}</div>`; row = []; };
  fields.forEach(f => {
    const h = fieldHtml(f, values[f.k]);
    if (f.half) { row.push(h); if (row.length === 2) flush(); } else { flush(); out += h; }
  });
  flush();
  return out;
}
function readForm(root, fields) {
  const o = {};
  fields.forEach(f => {
    const el = $('#f_' + f.k, root);
    if (!el) return;
    o[f.k] = f.t === 'multi' ? [...el.querySelectorAll('input:checked')].map(i => i.value) : el.value.trim();
    if (f.req && (o[f.k] === '' || (Array.isArray(o[f.k]) && !o[f.k].length))) throw new Error(`${f.l} is required`);
  });
  return o;
}
function wireShowIf(root, fields) {
  const upd = () => {
    const cur = {};
    fields.forEach(f => { const el = $('#f_' + f.k, root); if (el && f.t !== 'multi') cur[f.k] = el.value; });
    fields.filter(f => f.showIf).forEach(f => { $(`.field[data-k="${f.k}"]`, root).style.display = f.showIf(cur) ? '' : 'none'; });
  };
  root.addEventListener('change', upd); upd();
}
function editEntity(entity, title, fields, row, done, prefill) {
  const vals = { ...(prefill || {}), ...(row || {}) };
  openModal({
    title: (row?.id ? 'Edit ' : 'Add ') + title, body: formHtml(fields, vals),
    onOpen: r => wireShowIf(r, fields),
    onSubmit: async r => {
      const d = readForm(r, fields);
      if (row?.id) await api(`/${entity}/${row.id}`, { method: 'PUT', json: d });
      else await api(`/${entity}`, { json: d });
      toast('Saved'); done();
    }
  });
}
function delEntity(entity, id, label, done) {
  openModal({
    title: 'Delete', submitText: 'Delete', body: `<p>Delete <b>${esc(label)}</b>? This cannot be undone.</p>`,
    onSubmit: async () => { await api(`/${entity}/${id}`, { method: 'DELETE' }); toast('Deleted'); done(); }
  });
}

/* ------------------------------------------------------------- helpers */
function table(cols, rows, empty = 'Nothing here yet.') {
  if (!rows.length) return `<div class="empty">${esc(empty)}</div>`;
  return `<div class="tw"><table><thead><tr>${cols.map(c => `<th class="${c.cls || ''}">${c.h}</th>`).join('')}</tr></thead>
  <tbody>${rows.map(r => `<tr>${cols.map(c => `<td class="${c.cls || ''}">${c.f(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
const actions = (entity, id) => `<button class="link" data-edit="${entity}:${id}">Edit</button><button class="link d" data-del="${entity}:${id}">Delete</button>`;
const bar = (pct, over) => `<div class="bar ${over ? 'over' : ''}"><i style="width:${Math.min(100, Math.max(0, pct || 0))}%"></i></div>`;
function monthSelect(id, months, cur) {
  const list = months.includes(cur) ? months : [cur, ...months];
  return `<select id="${id}">${list.map(m => `<option value="${m}" ${m === cur ? 'selected' : ''}>${monthLabel(m)}</option>`).join('')}</select>`;
}
function wireRows(root, entity, rows, title, fields, done, labelFn, prefill) {
  root.querySelectorAll(`[data-edit^="${entity}:"]`).forEach(b => b.onclick = () => {
    const row = rows.find(r => r.id == b.dataset.edit.split(':')[1]); editEntity(entity, title, fields, row, done, prefill);
  });
  root.querySelectorAll(`[data-del^="${entity}:"]`).forEach(b => b.onclick = () => {
    const row = rows.find(r => r.id == b.dataset.del.split(':')[1]); delEntity(entity, row.id, labelFn(row), done);
  });
}
function selectHtml(opts, cur, attrs = '') {
  return `<select ${attrs}>${opts.map(o => `<option ${o === cur ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
}
const BANKS = ['HDFC Bank', 'ICICI Bank', 'SBI', 'Axis Bank', 'Kotak Mahindra Bank', 'IDFC FIRST Bank', 'Yes Bank', 'IndusInd Bank', 'RBL Bank', 'Standard Chartered', 'Bajaj Finance', 'Tata Capital', 'LIC Housing Finance', 'PNB', 'Bank of Baroda', 'Canara Bank'];

/* upload: pick file (+ password if needed), then hand parsed result to a callback */
function uploadFlow({ kind, title, hint, accept, extra = '', onParsed }) {
  openModal({
    title, submitText: 'Read file', wide: false,
    body: `<div class="note">${hint}</div>${extra}
      <div class="field"><label>File</label><input type="file" id="upf" accept="${accept}"></div>
      <div class="field" id="pwrow" style="display:none"><label>PDF password</label><input type="password" id="pwd" autocomplete="off" placeholder="Used once to open the file, never stored"></div>`,
    onSubmit: async r => {
      const f = $('#upf', r).files[0];
      if (!f) throw new Error('Choose a file first');
      const fd = new FormData();
      fd.append('file', f);
      fd.append('password', $('#pwd', r).value);
      const dt = $('#dtype', r); if (dt) fd.append('default_type', dt.value);
      let data;
      try { data = await api('/parse/' + kind, { method: 'POST', body: fd }); }
      catch (e) {
        if (e.message === 'password_required' || e.message === 'wrong_password') {
          $('#pwrow', r).style.display = '';
          throw new Error(e.message === 'wrong_password' ? 'Wrong password, try again' : 'This PDF is password protected. Enter the password.');
        }
        throw e;
      }
      onParsed(data, f);
      return false;
    }
  });
}

/* ------------------------------------------------------------ overview */
async function pageOverview(v) {
  const o = await api('/overview');
  const empty = !o.total_assets && !o.total_liabilities;
  const aL = Object.keys(o.assets), lL = Object.keys(o.liabilities);
  const b = o.budget;
  v.innerHTML = `
  ${empty ? `<div class="note">Welcome. Start by adding a bank account, investments, loans or credit cards from the sidebar. Everything stays on this computer.</div>` : ''}
  <div class="grid g3">
    <div class="card tile hero"><div class="lbl">Net worth</div><div class="val">${amt(o.networth)}</div><div class="sub">Assets minus liabilities</div></div>
    <div class="card tile"><div class="lbl">Total assets</div><div class="val">${amt(o.total_assets)}</div><div class="sub">Bank + investments</div></div>
    <div class="card tile"><div class="lbl">Total liabilities</div><div class="val">${amt(o.total_liabilities)}</div><div class="sub">Monthly EMIs ${amt(o.monthly_emi)}</div></div>
  </div>
  <div class="grid g21">
    <div class="card"><h2>Net worth trend</h2><div class="chartbox"><canvas id="cTrend"></canvas></div>
      ${o.trend.length < 2 ? '<div class="muted" style="margin-top:6px">The trend builds up month by month as you use the dashboard.</div>' : ''}</div>
    <div class="card"><h2>Upcoming (45 days)</h2>${o.dues.length ? o.dues.map(d => `<div class="list-row"><div>${esc(d.label)}<div class="muted">${dateLabel(d.date)} · ${d.days === 0 ? 'today' : d.days + ' days'}</div></div><b>${amt(d.amount)}</b></div>`).join('') : '<div class="empty">Nothing due soon.</div>'}</div>
  </div>
  <div class="grid g2">
    <div class="card"><h2>Assets</h2>${aL.length ? `<div class="chartbox" style="height:190px"><canvas id="cAssets"></canvas></div>${legend(aL, aL.map(k => o.assets[k]))}` : '<div class="empty">No assets yet.</div>'}</div>
    <div class="card"><h2>Liabilities</h2>${lL.length ? `<div class="chartbox" style="height:190px"><canvas id="cLiab"></canvas></div>${legend(lL, lL.map(k => o.liabilities[k]))}` : '<div class="empty">No liabilities. Nice.</div>'}</div>
  </div>
  <div class="grid g3">
    <div class="card"><h2>Budget · ${monthLabel(b.month)} <a class="link" href="#budget">Open</a></h2>
      ${b.total_limit ? `<div style="font-size:20px;font-weight:700">${amt(b.total_spent)} <span class="muted" style="font-size:13px;font-weight:400">of ${amt(b.total_limit)}</span></div>${bar(b.total_spent / b.total_limit * 100, b.total_spent > b.total_limit)}
      <div class="muted" style="margin-top:6px">${b.total_spent > b.total_limit ? 'Over budget by ' + amt(b.total_spent - b.total_limit) : amt(b.total_limit - b.total_spent) + ' left'}</div>`
        : `<div class="empty">Set monthly limits in Budget.</div>`}
      ${b.income ? `<div class="list-row"><span class="muted">Savings this month</span><b>${amt(b.savings)}${b.savings_rate !== null ? ` · ${b.savings_rate}%` : ''}</b></div>` : ''}</div>
    <div class="card"><h2>Goals <a class="link" href="#goals">Open</a></h2>${o.goals.length ? o.goals.map(g => `<div style="margin-bottom:12px"><div class="list-row" style="border:0;padding:0 0 4px"><b>${esc(g.name)}</b><span class="pill ${g.status === 'Behind' ? 'dark' : g.status === 'Not enough history' ? 'grey' : ''}">${g.status}</span></div>${bar(g.pct)}<div class="muted">${amt(g.current)} of ${amt(g.target)} · ${g.pct}%</div></div>`).join('') : '<div class="empty">No goals yet.</div>'}</div>
    <div class="card"><h2>Insurance cover <a class="link" href="#insurance">Open</a></h2>${o.insurance.length ? o.insurance.map(i => `<div class="list-row"><span>${esc(i.type)} <span class="muted">(${i.n})</span></span><b>${amt(i.cover)}</b></div>`).join('') : '<div class="empty">No policies added.</div>'}</div>
  </div>`;
  if (o.trend.length) drawChart('cTrend', { type: 'line', data: { labels: o.trend.map(t => monthLabel(t.month)), datasets: [{ label: 'Net worth', data: o.trend.map(t => t.networth), borderColor: '#2563eb', backgroundColor: 'rgba(37,99,235,.1)', fill: true, tension: .3, pointRadius: 3 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ' ' + chartFmt(c.parsed.y) } } }, scales: { x: { grid: { display: false } }, y: { ticks: { callback: chartFmt }, grid: { color: '#eef2f7' } } } } });
  if (aL.length) donut('cAssets', aL, aL.map(k => o.assets[k]));
  if (lL.length) donut('cLiab', lL, lL.map(k => o.liabilities[k]));
}

/* --------------------------------------------------------------- cards */
const cardFields = () => [
  { k: 'name', l: 'Card name', req: true, ph: 'e.g. HDFC Regalia', half: true }, { k: 'bank', l: 'Bank', list: BANKS, half: true },
  { k: 'last4', l: 'Last 4 digits', half: true }, { k: 'credit_limit', l: 'Credit limit (₹)', t: 'number', half: true },
  { k: 'outstanding', l: 'Outstanding (₹)', t: 'number', half: true }, { k: 'min_due', l: 'Minimum due (₹)', t: 'number', half: true },
  { k: 'due_day', l: 'Due day of month (1-31)', t: 'number' }];

async function pageCards(v) {
  const cards = await api('/cards');
  v.innerHTML = `<div class="toolbar"><div class="grow"></div><button class="btn ghost" id="up">Upload statement</button><button class="btn" id="add">+ Add card</button></div>
  <div class="card" style="margin-bottom:16px">${table([
    { h: 'Card', f: c => `<b>${esc(c.name)}</b><div class="muted">${esc(c.bank || '')}${c.last4 ? ' ••' + esc(c.last4) : ''}</div>` },
    { h: 'Limit', cls: 'num', f: c => amt(c.credit_limit) }, { h: 'Outstanding', cls: 'num', f: c => amt(c.outstanding) },
    { h: 'Used', f: c => c.credit_limit ? `${bar(c.outstanding / c.credit_limit * 100, c.outstanding / c.credit_limit > .5)}<div class="muted">${Math.round(c.outstanding / c.credit_limit * 100)}%</div>` : '–' },
    { h: 'Min due', cls: 'num', f: c => amt(c.min_due) }, { h: 'Due day', f: c => c.due_day || '–' },
    { h: '', cls: 'num', f: c => actions('cards', c.id) }], cards, 'No cards yet. Add one or upload a statement.')}</div>
  <div id="analysis"></div>`;
  const reload = () => route();
  wireRows(v, 'cards', cards, 'card', cardFields(), reload, c => c.name);
  $('#add', v).onclick = () => editEntity('cards', 'card', cardFields(), null, reload);
  $('#up', v).onclick = () => uploadFlow({
    kind: 'card', title: 'Upload credit card statement', accept: '.pdf,.csv,.xlsx,.xls',
    hint: 'PDF, CSV or Excel. You can review and correct everything before it is saved.',
    onParsed: (d, f) => reviewCardStatement(d, cards, reload)
  });
  loadCardAnalysis(v, cards, null, '');
}

function reviewCardStatement(d, cards, done) {
  const cats = state.meta.card_cats;
  const match = cards.find(c => d.last4 && c.last4 === d.last4);
  const body = `${d.warning ? `<div class="note">${esc(d.warning)}</div>` : ''}
  <div class="frow"><div class="field"><label>Add to card</label><select id="cardSel">${cards.map(c => `<option value="${c.id}" ${match?.id === c.id ? 'selected' : ''}>${esc(c.name)}${c.last4 ? ' ••' + c.last4 : ''}</option>`).join('')}<option value="new" ${match || cards.length ? '' : 'selected'}>+ New card</option></select></div>
  <div class="field" id="nn"><label>New card name</label><input id="nname" value="${esc((d.bank || '') + (d.last4 ? ' ••' + d.last4 : ' card'))}"></div></div>
  <div class="frow"><div class="field"><label>Outstanding (₹)</label><input id="o_out" type="number" step="any" value="${d.outstanding ?? ''}"></div>
  <div class="field"><label>Minimum due (₹)</label><input id="o_min" type="number" step="any" value="${d.min_due ?? ''}"></div>
  <div class="field"><label>Credit limit (₹)</label><input id="o_lim" type="number" step="any" value="${d.credit_limit ?? ''}"></div>
  <div class="field"><label>Due day of month</label><input id="o_due" type="number" value="${d.due_day ?? ''}"></div></div>
  <div class="field"><label style="display:inline-flex;gap:6px;align-items:center;font-weight:500;color:var(--ink)"><input type="checkbox" id="upd" checked style="width:auto"> Update the card's outstanding, due day and limit from this statement</label></div>
  <p class="muted">${d.txns.length} transactions found. Untick any you don't want; change categories if needed. Negative amounts are credits/payments.</p>
  <div class="tw">${table([
    { h: 'Keep', f: (t, ) => `<input type="checkbox" data-keep checked>` }, { h: 'Date', f: t => dateLabel(t.date) }, { h: 'Description', f: t => esc(t.description) },
    { h: 'Amount', cls: 'num', f: t => amt(t.amount) }, { h: 'Category', f: t => selectHtml(cats, t.category, 'data-cat') }], d.txns, 'No transactions.')}</div>`;
  openModal({
    title: 'Review statement', wide: true, submitText: 'Import', body,
    onOpen: r => { const t = () => $('#nn', r).style.display = $('#cardSel', r).value === 'new' ? '' : 'none'; $('#cardSel', r).onchange = t; t(); },
    onSubmit: async r => {
      let cid = $('#cardSel', r).value;
      const val = id => { const x = $(id, r).value; return x === '' ? null : x; };
      const patch = { bank: d.bank, last4: d.last4, credit_limit: val('#o_lim'), outstanding: val('#o_out'), min_due: val('#o_min'), due_day: val('#o_due') };
      if (cid === 'new') {
        const name = $('#nname', r).value.trim(); if (!name) throw new Error('Enter a card name');
        cid = (await api('/cards', { json: { name, ...patch } })).id;
      } else if ($('#upd', r).checked) {
        const c = cards.find(c => c.id == cid);
        const m = { ...c }; Object.entries(patch).forEach(([k, x]) => { if (x !== null && x !== '' && !(k === 'bank' || k === 'last4') ) m[k] = x; });
        await api('/cards/' + cid, { method: 'PUT', json: m });
      }
      const rows = [...r.querySelectorAll('tbody tr')];
      const txns = d.txns.map((t, i) => ({ ...t, category: $('[data-cat]', rows[i]).value, keep: $('[data-keep]', rows[i]).checked })).filter(t => t.keep);
      const res = await api(`/cards/${cid}/txns/bulk`, { json: { txns } });
      toast(`Imported ${res.added} transactions` + (res.skipped ? `, skipped ${res.skipped} duplicates` : ''));
      done();
    }
  });
}

async function loadCardAnalysis(v, cards, month, cardId) {
  const box = $('#analysis', v);
  const a = await api('/card-analysis?' + qs({ month, card_id: cardId }));
  if (!a.months.length) { box.innerHTML = `<div class="card"><h2>Spend analysis</h2><div class="empty">Upload a credit card statement to see where your money goes.</div></div>`; return; }
  const cats = state.meta.card_cats;
  box.innerHTML = `<div class="toolbar"><h3 style="margin:0">Spend analysis</h3><div class="grow"></div>
    <select id="cf"><option value="">All cards</option>${cards.map(c => `<option value="${c.id}" ${c.id == cardId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>${monthSelect('cm', a.months, a.month)}</div>
  <div class="grid g3"><div class="card tile hero"><div class="lbl">Spent in ${monthLabel(a.month)}</div><div class="val">${amt(a.total)}</div><div class="sub">${a.txns.length} transactions</div></div>
  <div class="card" style="grid-column:span 2"><h2>Monthly spend</h2><div class="chartbox" style="height:150px"><canvas id="cMon"></canvas></div></div></div>
  <div class="grid g2"><div class="card"><h2>By category</h2>${a.by_category.length ? `<div class="chartbox" style="height:200px"><canvas id="cCat"></canvas></div>${legend(a.by_category.map(x => x.category), a.by_category.map(x => x.amount))}` : '<div class="empty">No spend.</div>'}</div>
  <div class="card"><h2>Top merchants</h2>${a.merchants.length ? a.merchants.map(m => `<div class="list-row"><span>${esc(m.name)}</span><b>${amt(m.amount)}</b></div>`).join('') : '<div class="empty">No data.</div>'}</div></div>
  <div class="card"><h2>Transactions</h2>${table([{ h: 'Date', f: t => dateLabel(t.date) }, { h: 'Description', f: t => esc(t.description) }, { h: 'Card', f: t => `<span class="muted">${esc(t.card || '')}</span>` },
    { h: 'Amount', cls: 'num', f: t => amt(t.amount) }, { h: 'Category', f: t => selectHtml(cats, t.category, `data-tid="${t.id}"`) }, { h: '', f: t => `<button class="link d" data-rm="${t.id}">Remove</button>` }], a.txns)}</div>`;
  $('#cm', box).onchange = e => loadCardAnalysis(v, cards, e.target.value, $('#cf', box).value);
  $('#cf', box).onchange = e => loadCardAnalysis(v, cards, $('#cm', box).value, e.target.value);
  box.querySelectorAll('[data-tid]').forEach(s => s.onchange = async () => { await api('/card-txns/' + s.dataset.tid, { method: 'PUT', json: { category: s.value } }); toast('Category updated'); loadCardAnalysis(v, cards, a.month, cardId); });
  box.querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => { await api('/card-txns/' + b.dataset.rm, { method: 'DELETE' }); loadCardAnalysis(v, cards, a.month, cardId); });
  bars('cMon', a.monthly.map(m => monthLabel(m.month)), [{ label: 'Spend', data: a.monthly.map(m => m.total) }]);
  if (a.by_category.length) donut('cCat', a.by_category.map(x => x.category), a.by_category.map(x => x.amount));
}

/* --------------------------------------------------------------- loans */
const LOAN_TYPES = ['Home Loan', 'Personal Loan', 'Car Loan', 'Two-Wheeler Loan', 'Education Loan', 'Gold Loan', 'Business Loan', 'Loan Against Property', 'Other Loan'];
const loanFields = () => [
  { k: 'type', l: 'Loan type', t: 'select', opts: LOAN_TYPES, half: true }, { k: 'lender', l: 'Lender', list: BANKS, req: true, half: true },
  { k: 'emi', l: 'EMI amount (₹)', t: 'number', req: true, half: true }, { k: 'emi_day', l: 'EMI date (day of month)', t: 'number', half: true },
  { k: 'outstanding', l: 'Total outstanding (₹)', t: 'number', req: true, half: true }, { k: 'end_date', l: 'End / expiry date', t: 'date', half: true },
  { k: 'principal', l: 'Original loan amount (₹)', t: 'number', half: true }, { k: 'rate', l: 'Interest rate (% p.a.)', t: 'number', half: true }];

async function pageLoans(v) {
  const loans = await api('/loans');
  const reload = () => route();
  v.innerHTML = `<div class="toolbar"><div class="grow"></div><button class="btn ghost" id="up">Upload statement</button><button class="btn" id="add">+ Add loan</button></div>
  <div class="grid g3"><div class="card tile hero"><div class="lbl">Total outstanding</div><div class="val">${amt(sum(loans, l => l.outstanding))}</div></div>
  <div class="card tile"><div class="lbl">Monthly EMI</div><div class="val">${amt(sum(loans, l => l.emi))}</div></div>
  <div class="card tile"><div class="lbl">Loans</div><div class="val">${loans.length}</div></div></div>
  <div class="card">${table([
    { h: 'Loan', f: l => `<b>${esc(l.type)}</b><div class="muted">${esc(l.lender)}</div>` }, { h: 'EMI', cls: 'num', f: l => amt(l.emi) },
    { h: 'EMI date', f: l => l.emi_day ? 'Day ' + l.emi_day : '–' }, { h: 'Ends', f: l => dateLabel(l.end_date) },
    { h: 'Rate', cls: 'num', f: l => l.rate ? l.rate + '%' : '–' }, { h: 'Outstanding', cls: 'num', f: l => amt(l.outstanding) },
    { h: 'Repaid', f: l => l.principal ? `${bar((1 - l.outstanding / l.principal) * 100)}<div class="muted">${Math.max(0, Math.round((1 - l.outstanding / l.principal) * 100))}%</div>` : '–' },
    { h: '', cls: 'num', f: l => actions('loans', l.id) }], loans, 'No loans added.')}</div>`;
  wireRows(v, 'loans', loans, 'loan', loanFields(), reload, l => `${l.type} - ${l.lender}`);
  $('#add', v).onclick = () => editEntity('loans', 'loan', loanFields(), null, reload);
  $('#up', v).onclick = () => uploadFlow({
    kind: 'loan', title: 'Upload loan statement', accept: '.pdf,.csv,.xlsx,.xls',
    hint: 'I will read loan type, lender, EMI, EMI date, end date and outstanding. Check the details on the next screen.',
    onParsed: d => editEntity('loans', 'loan (review details)', loanFields(), null, reload, d)
  });
}

/* --------------------------------------------------------- investments */
const INV_TYPES = ['Mutual Fund', 'Stock/ETF', 'FD', 'RD', 'PPF', 'EPF', 'NPS', 'Gold', 'Real Estate', 'Crypto', 'Other'];
const invFields = () => [
  { k: 'type', l: 'Type', t: 'select', opts: INV_TYPES, half: true }, { k: 'name', l: 'Name', req: true, ph: 'e.g. Parag Parikh Flexi Cap', half: true },
  { k: 'invested', l: 'Invested amount (₹)', t: 'number', req: true, half: true }, { k: 'current_value', l: 'Current value (₹)', t: 'number', req: true, half: true },
  { k: 'maturity_date', l: 'Maturity date (FD/RD/PPF, optional)', t: 'date' }, { k: 'notes', l: 'Notes' }];

async function pageInvestments(v) {
  const inv = await api('/investments');
  const reload = () => route();
  const tInv = sum(inv, i => i.invested), tCur = sum(inv, i => i.current_value), gain = tCur - tInv;
  v.innerHTML = `<div class="toolbar"><div class="grow"></div><button class="btn ghost" id="up">Upload Excel/CSV</button><button class="btn" id="add">+ Add investment</button></div>
  <div class="grid g3"><div class="card tile hero"><div class="lbl">Current value</div><div class="val">${amt(tCur)}</div></div>
  <div class="card tile"><div class="lbl">Invested</div><div class="val">${amt(tInv)}</div></div>
  <div class="card tile"><div class="lbl">Gain / loss</div><div class="val">${amt(gain)}</div><div class="sub">${tInv ? (gain / tInv * 100).toFixed(1) + '%' : ''}</div></div></div>
  <div class="card">${table([
    { h: 'Name', f: i => `<b>${esc(i.name)}</b>${i.notes ? `<div class="muted">${esc(i.notes)}</div>` : ''}` }, { h: 'Type', f: i => `<span class="pill">${esc(i.type)}</span>` },
    { h: 'Invested', cls: 'num', f: i => amt(i.invested) }, { h: 'Current', cls: 'num', f: i => amt(i.current_value) },
    { h: 'Gain / loss', cls: 'num', f: i => `${amt(i.current_value - i.invested)} <span class="muted">${i.invested ? ((i.current_value / i.invested - 1) * 100).toFixed(1) + '%' : ''}</span>` },
    { h: 'Matures', f: i => i.maturity_date ? dateLabel(i.maturity_date) : '–' }, { h: '', cls: 'num', f: i => actions('investments', i.id) }], inv, 'No investments added.')}</div>
  <p class="muted">Current values are updated by you (edit a row or re-upload an Excel). Live prices are not fetched.</p>`;
  wireRows(v, 'investments', inv, 'investment', invFields(), reload, i => i.name);
  $('#add', v).onclick = () => editEntity('investments', 'investment', invFields(), null, reload);
  $('#up', v).onclick = () => uploadFlow({
    kind: 'investments', title: 'Upload holdings (Excel / CSV)', accept: '.csv,.xlsx,.xls',
    hint: 'Needs a header row with columns such as Name, Invested (or Qty + Avg cost) and Current value. Works with broker and fund-house holdings exports.',
    extra: `<div class="field"><label>Default type for rows without a type column</label>${selectHtml(INV_TYPES, 'Mutual Fund', 'id="dtype"')}</div>`,
    onParsed: d => reviewInvestments(d, reload)
  });
}
function reviewInvestments(d, done) {
  openModal({
    title: 'Review holdings', wide: true, submitText: 'Import selected',
    body: `${d.warning ? `<div class="note">${esc(d.warning)}</div>` : '<div class="note">These are added as new rows. Delete older rows first if you are re-uploading the same holdings.</div>'}
    ${table([{ h: 'Keep', f: () => '<input type="checkbox" data-keep checked>' }, { h: 'Name', f: r => esc(r.name) }, { h: 'Type', f: r => selectHtml(INV_TYPES, INV_TYPES.includes(r.type) ? r.type : 'Other', 'data-type') },
      { h: 'Invested', cls: 'num', f: r => amt(r.invested) }, { h: 'Current', cls: 'num', f: r => amt(r.current_value) }], d.rows)}`,
    onSubmit: async r => {
      const trs = [...r.querySelectorAll('tbody tr')];
      const rows = d.rows.map((x, i) => ({ ...x, type: $('[data-type]', trs[i]).value, keep: $('[data-keep]', trs[i]).checked })).filter(x => x.keep);
      if (!rows.length) throw new Error('Nothing selected');
      await api('/investments/bulk', { json: { rows } }); toast(`Imported ${rows.length} holdings`); done();
    }
  });
}

/* ------------------------------------------------------------ insurance */
const INS_TYPES = ['Health', 'Life', 'Motor', 'Home', 'Travel', 'Other'];
const insFields = () => [
  { k: 'type', l: 'Type', t: 'select', opts: INS_TYPES, half: true }, { k: 'insurer', l: 'Insurer', req: true, half: true },
  { k: 'policy_no', l: 'Policy number', half: true }, { k: 'nominee', l: 'Nominee / insured', half: true },
  { k: 'cover', l: 'Cover amount (₹)', t: 'number', req: true, half: true }, { k: 'premium', l: 'Annual premium (₹)', t: 'number', half: true },
  { k: 'renewal_date', l: 'Renewal / due date', t: 'date' }];

async function pageInsurance(v) {
  const pol = await api('/insurance');
  const reload = () => route();
  const by = t => sum(pol.filter(p => p.type === t), p => p.cover);
  const today = new Date().toISOString().slice(0, 10);
  v.innerHTML = `<div class="toolbar"><div class="grow"></div><button class="btn" id="add">+ Add policy</button></div>
  <div class="grid g4"><div class="card tile hero"><div class="lbl">Total cover</div><div class="val">${amt(sum(pol, p => p.cover))}</div></div>
  <div class="card tile"><div class="lbl">Health</div><div class="val">${amt(by('Health'))}</div></div>
  <div class="card tile"><div class="lbl">Life</div><div class="val">${amt(by('Life'))}</div></div>
  <div class="card tile"><div class="lbl">Yearly premiums</div><div class="val">${amt(sum(pol, p => p.premium))}</div></div></div>
  <div class="card">${table([
    { h: 'Policy', f: p => `<b>${esc(p.insurer)}</b><div class="muted">${esc(p.policy_no || '')}</div>` }, { h: 'Type', f: p => `<span class="pill">${esc(p.type)}</span>` },
    { h: 'Cover', cls: 'num', f: p => amt(p.cover) }, { h: 'Premium / yr', cls: 'num', f: p => amt(p.premium) },
    { h: 'Renewal', f: p => p.renewal_date ? `${dateLabel(p.renewal_date)} ${p.renewal_date < today ? '<span class="pill dark">Overdue</span>' : ''}` : '–' },
    { h: 'Nominee', f: p => esc(p.nominee || '–') }, { h: '', cls: 'num', f: p => actions('insurance', p.id) }], pol, 'No policies added.')}</div>
  <p class="muted">Insurance cover is protection, not an asset, so it is not counted in net worth.</p>`;
  wireRows(v, 'insurance', pol, 'policy', insFields(), reload, p => `${p.insurer} ${p.type}`);
  $('#add', v).onclick = () => editEntity('insurance', 'policy', insFields(), null, reload);
}

/* ------------------------------------------------------- bank & income */
const acctFields = () => [{ k: 'bank', l: 'Bank', list: BANKS, req: true, half: true }, { k: 'name', l: 'Account name', ph: 'e.g. Salary account ••1234', half: true },
  { k: 'type', l: 'Type', t: 'select', opts: ['Savings', 'Current', 'Salary', 'Other'], half: true }, { k: 'balance', l: 'Balance (₹)', t: 'number', req: true, half: true }];
const incFields = () => [{ k: 'month', l: 'Month', t: 'month', req: true, half: true }, { k: 'source', l: 'Source', req: true, ph: 'Salary, Freelance...', half: true }, { k: 'amount', l: 'Amount (₹)', t: 'number', req: true }];

async function pageBank(v) {
  const [accts, income] = await Promise.all([api('/accounts'), api('/income')]);
  const reload = () => route();
  v.innerHTML = `<div class="toolbar"><div class="grow"></div><button class="btn ghost" id="up">Upload bank statement</button><button class="btn" id="add">+ Add account</button></div>
  <div class="grid g3"><div class="card tile hero"><div class="lbl">Total bank balance</div><div class="val">${amt(sum(accts, a => a.balance))}</div></div>
  <div class="card tile"><div class="lbl">Accounts</div><div class="val">${accts.length}</div></div>
  <div class="card tile"><div class="lbl">Income this month</div><div class="val">${amt(sum(income.filter(i => i.month === curMonth()), i => i.amount))}</div></div></div>
  <div class="card" style="margin-bottom:16px">${table([{ h: 'Account', f: a => `<b>${esc(a.bank)}</b><div class="muted">${esc(a.name || '')}</div>` }, { h: 'Type', f: a => esc(a.type || '') },
    { h: 'Balance', cls: 'num', f: a => amt(a.balance) }, { h: '', cls: 'num', f: a => actions('accounts', a.id) }], accts, 'No accounts added.')}</div>
  <div id="bankA"></div>
  <div class="card"><h2>Monthly income <button class="btn sm" id="addInc">+ Add income</button></h2>${table([{ h: 'Month', f: i => monthLabel(i.month) }, { h: 'Source', f: i => esc(i.source) },
    { h: 'Amount', cls: 'num', f: i => amt(i.amount) }, { h: '', cls: 'num', f: i => actions('income', i.id) }], income, 'No income entries. Without entries, salary credits found in bank statements are used.')}</div>`;
  wireRows(v, 'accounts', accts, 'account', acctFields(), reload, a => a.bank);
  wireRows(v, 'income', income, 'income', incFields(), reload, i => `${i.source} ${monthLabel(i.month)}`);
  $('#add', v).onclick = () => editEntity('accounts', 'account', acctFields(), null, reload);
  $('#addInc', v).onclick = () => editEntity('income', 'income', incFields(), null, reload, { month: curMonth() });
  $('#up', v).onclick = () => uploadFlow({
    kind: 'bank', title: 'Upload bank statement', accept: '.pdf,.csv,.xlsx,.xls',
    hint: 'PDF, CSV or Excel. Debits and credits are read and categorised; you can review them next.',
    onParsed: d => reviewBank(d, accts, reload)
  });
  loadBankAnalysis(v, accts, '', '');
}
function reviewBank(d, accts, done) {
  const cats = state.meta.bank_cats;
  const match = accts.find(a => d.last4 && (a.name || '').includes(d.last4));
  openModal({
    title: 'Review bank statement', wide: true, submitText: 'Import',
    body: `${d.warning ? `<div class="note">${esc(d.warning)}</div>` : ''}
    <div class="frow"><div class="field"><label>Add to account</label><select id="acSel">${accts.map(a => `<option value="${a.id}" ${match?.id === a.id ? 'selected' : ''}>${esc(a.bank)} ${esc(a.name || '')}</option>`).join('')}<option value="new" ${accts.length ? '' : 'selected'}>+ New account</option></select></div>
    <div class="field" id="nn"><label>New account name</label><input id="nname" value="${esc((d.bank || 'Bank') + (d.last4 ? ' ••' + d.last4 : ''))}"></div></div>
    <div class="field"><label>Closing balance (₹)</label><input id="cb" type="number" step="any" value="${d.closing_balance ?? ''}" placeholder="Leave blank to keep current balance"></div>
    <p class="muted">${d.txns.length} transactions found.</p>
    ${table([{ h: 'Keep', f: () => '<input type="checkbox" data-keep checked>' }, { h: 'Date', f: t => dateLabel(t.date) }, { h: 'Description', f: t => esc(t.description) },
      { h: 'Debit', cls: 'num', f: t => t.debit ? amt(t.debit) : '' }, { h: 'Credit', cls: 'num', f: t => t.credit ? amt(t.credit) : '' }, { h: 'Category', f: t => selectHtml(cats, t.category, 'data-cat') }], d.txns)}`,
    onOpen: r => { const t = () => $('#nn', r).style.display = $('#acSel', r).value === 'new' ? '' : 'none'; $('#acSel', r).onchange = t; t(); },
    onSubmit: async r => {
      let id = $('#acSel', r).value;
      const cb = $('#cb', r).value;
      if (id === 'new') {
        const name = $('#nname', r).value.trim(); if (!name) throw new Error('Enter an account name');
        id = (await api('/accounts', { json: { bank: d.bank || name, name, type: 'Savings', balance: cb || 0 } })).id;
      }
      const trs = [...r.querySelectorAll('tbody tr')];
      const txns = d.txns.map((t, i) => ({ ...t, category: $('[data-cat]', trs[i]).value, keep: $('[data-keep]', trs[i]).checked })).filter(t => t.keep);
      const res = await api(`/accounts/${id}/txns/bulk`, { json: { txns, closing_balance: cb === '' ? null : cb } });
      toast(`Imported ${res.added} transactions` + (res.skipped ? `, skipped ${res.skipped} duplicates` : '')); done();
    }
  });
}
async function loadBankAnalysis(v, accts, month, aid) {
  const box = $('#bankA', v);
  const a = await api('/bank-analysis?' + qs({ month, account_id: aid }));
  if (!a.monthly.length) { box.innerHTML = ''; return; }
  const cats = state.meta.bank_cats;
  box.innerHTML = `<div class="grid g2"><div class="card"><h2>Income vs spend vs savings</h2><div class="chartbox"><canvas id="cBank"></canvas></div></div>
  <div class="card"><h2>Monthly savings</h2>${table([{ h: 'Month', f: m => monthLabel(m.month) }, { h: 'Income', cls: 'num', f: m => amt(m.income) }, { h: 'Spent', cls: 'num', f: m => amt(m.spent) },
    { h: 'Saved', cls: 'num', f: m => `<b>${amt(m.savings)}</b>` }], [...a.monthly].reverse())}</div></div>
  <div class="card" style="margin-bottom:16px"><h2>Transactions <span><select id="bf"><option value="">All accounts</option>${accts.map(c => `<option value="${c.id}" ${c.id == aid ? 'selected' : ''}>${esc(c.bank)} ${esc(c.name || '')}</option>`).join('')}</select> ${monthSelect('bm', a.months, a.month)}</span></h2>
  ${table([{ h: 'Date', f: t => dateLabel(t.date) }, { h: 'Description', f: t => esc(t.description) }, { h: 'Debit', cls: 'num', f: t => t.debit ? amt(t.debit) : '' }, { h: 'Credit', cls: 'num', f: t => t.credit ? amt(t.credit) : '' },
    { h: 'Category', f: t => selectHtml(cats, t.category, `data-tid="${t.id}"`) }, { h: '', f: t => `<button class="link d" data-rm="${t.id}">Remove</button>` }], a.txns)}</div>`;
  $('#bm', box).onchange = e => loadBankAnalysis(v, accts, e.target.value, $('#bf', box).value);
  $('#bf', box).onchange = e => loadBankAnalysis(v, accts, $('#bm', box).value, e.target.value);
  box.querySelectorAll('[data-tid]').forEach(s => s.onchange = async () => { await api('/bank-txns/' + s.dataset.tid, { method: 'PUT', json: { category: s.value } }); toast('Category updated'); loadBankAnalysis(v, accts, a.month, aid); });
  box.querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => { await api('/bank-txns/' + b.dataset.rm, { method: 'DELETE' }); loadBankAnalysis(v, accts, a.month, aid); });
  bars('cBank', a.monthly.map(m => monthLabel(m.month)), [{ label: 'Income', data: a.monthly.map(m => m.income) }, { label: 'Spent', data: a.monthly.map(m => m.spent) }, { label: 'Saved', data: a.monthly.map(m => m.savings) }]);
}

/* -------------------------------------------------------------- budget */
async function pageBudget(v, month) {
  month = month || curMonth();
  const b = await api('/budget?month=' + month);
  const cats = state.meta.expense_cats;
  const byCat = Object.fromEntries(b.categories.map(c => [c.category, c]));
  const months = []; const d = new Date();
  for (let i = 0; i < 12; i++) { months.push(new Date(d.getFullYear(), d.getMonth() - i, 1).toLocaleDateString('en-CA').slice(0, 7)); }
  v.innerHTML = `<div class="toolbar"><div class="grow"></div>${monthSelect('bmon', months, month)}<button class="btn" id="save">Save budget</button></div>
  <div class="grid g4"><div class="card tile hero"><div class="lbl">Spent</div><div class="val">${amt(b.total_spent)}</div><div class="sub">${b.total_limit ? 'of ' + amt(b.total_limit) : 'No limit set'}</div></div>
  <div class="card tile"><div class="lbl">Remaining</div><div class="val">${b.total_limit ? amt(b.total_limit - b.total_spent) : '–'}</div></div>
  <div class="card tile"><div class="lbl">Income</div><div class="val">${amt(b.income)}</div><div class="sub">${b.income_source === 'manual' ? 'From your income entries' : b.income ? 'From bank salary credits' : 'Add income in Bank & Income'}</div></div>
  <div class="card tile"><div class="lbl">Savings</div><div class="val">${b.income ? amt(b.savings) : '–'}</div><div class="sub">${b.savings_rate !== null ? b.savings_rate + '% of income' : ''}</div></div></div>
  <div class="card"><div class="field" style="max-width:320px"><label>Overall monthly limit (₹) - optional</label><input id="lim__total" type="number" min="0" value="${b.limits._total || ''}" placeholder="Defaults to the sum of categories"></div>
  ${table([{ h: 'Category', f: c => c }, { h: 'Monthly limit (₹)', f: c => `<input class="inline-in" type="number" min="0" data-lim="${c}" value="${b.limits[c] || ''}">` },
    { h: 'Spent', cls: 'num', f: c => amt(byCat[c]?.spent || 0) },
    { h: 'Progress', f: c => { const x = byCat[c]; return x && x.limit ? `${bar(x.pct, x.pct > 100)}<div class="muted">${x.pct}% used${x.pct > 100 ? ' · over by ' + (hiding() ? '••••' : inr(x.spent - x.limit)) : ''}</div>` : '<span class="muted">No limit</span>'; } }], cats)}</div>
  <p class="muted">Spend comes from your credit card and bank transactions (card bill payments, transfers and investments are not counted).</p>`;
  $('#bmon', v).onchange = e => pageBudget(v, e.target.value);
  $('#save', v).onclick = async () => {
    const limits = {};
    v.querySelectorAll('[data-lim]').forEach(i => { if (i.value) limits[i.dataset.lim] = i.value; });
    if ($('#lim__total', v).value) limits._total = $('#lim__total', v).value;
    await api('/budget', { method: 'PUT', json: { limits } }); toast('Budget saved'); pageBudget(v, month);
  };
}

/* --------------------------------------------------------------- goals */
const goalFields = () => [{ k: 'name', l: 'Goal name', req: true, ph: 'Emergency fund, House down payment...' },
  { k: 'kind', l: 'Measure progress by', t: 'select', opts: [['networth', 'My total net worth'], ['linked', 'Specific assets only']] },
  { k: 'linked', l: 'Assets that count towards this goal', t: 'multi', opts: state.meta.asset_groups, showIf: v => v.kind === 'linked' },
  { k: 'target', l: 'Target amount (₹)', t: 'number', req: true, half: true }, { k: 'target_date', l: 'Target date', t: 'date', req: true, half: true }];

async function pageGoals(v) {
  const goals = await api('/goals');
  const reload = () => route();
  const fields = goalFields();
  v.innerHTML = `<div class="toolbar"><div class="grow"></div><button class="btn" id="add">+ Add goal</button></div>
  ${goals.length ? `<div class="grid g2">${goals.map(g => `<div class="card">
    <h2><span>${esc(g.name)}</span><span class="pill ${g.status === 'Behind' ? 'dark' : g.status === 'Not enough history' ? 'grey' : ''}">${g.status}</span></h2>
    <div style="font-size:22px;font-weight:700">${amt(g.current)} <span class="muted" style="font-size:13px;font-weight:400">of ${amt(g.target)}</span></div>
    ${bar(g.pct)}<div class="muted" style="margin:6px 0 10px">${g.pct}% complete · ${g.kind === 'linked' ? 'Tracking: ' + esc(g.linked_list.join(', ')) : 'Tracking: net worth'}</div>
    <div class="list-row"><span class="muted">Still to go</span><b>${amt(g.gap)}</b></div>
    <div class="list-row"><span class="muted">Target date</span><b>${dateLabel(g.target_date)}${g.months_left !== null ? ` (${g.months_left} mo)` : ''}</b></div>
    <div class="list-row"><span class="muted">Needed per month</span><b>${g.required_monthly !== null ? amt(g.required_monthly) : '–'}</b></div>
    <div class="list-row"><span class="muted">Your recent monthly growth</span><b>${g.avg_growth !== null ? amt(g.avg_growth) : 'Needs 2+ months of history'}</b></div>
    <div style="margin-top:8px;text-align:right">${actions('goals', g.id)}</div></div>`).join('')}</div>`
      : '<div class="card"><div class="empty">No goals yet. Add one, like an emergency fund or a net worth target.</div></div>'}`;
  wireRows(v, 'goals', goals, 'goal', fields, reload, g => g.name);
  $('#add', v).onclick = () => editEntity('goals', 'goal', fields, null, reload, { kind: 'networth' });
}

/* ------------------------------------------------------------ settings */
async function pageSettings(v) {
  const st = await api('/auth/status');
  v.innerHTML = `<div class="grid g2"><div>
  <div class="card section"><h3>Auto-lock</h3><p>Blur and lock the dashboard when you are inactive.</p>
    <div class="field"><label>Lock after</label><select id="lm">${[1, 2, 5, 10, 15].map(m => `<option value="${m}" ${m === st.lock_minutes ? 'selected' : ''}>${m} minute${m > 1 ? 's' : ''}</option>`).join('')}</select></div>
    <div class="checks field"><label><input type="checkbox" id="hd" ${st.hide_default ? 'checked' : ''}> Hide amounts by default (click an amount to reveal it)</label></div>
    <button class="btn" id="saveS">Save</button></div>
  <div class="card section"><h3>Change password</h3><p>You will stay signed in after changing it.</p>
    <div class="field"><label>Current password</label><input type="password" id="pc" autocomplete="current-password"></div>
    <div class="field"><label>New password (min 6 characters)</label><input type="password" id="pn" autocomplete="new-password"></div>
    <div class="field"><label>Repeat new password</label><input type="password" id="pr" autocomplete="new-password"></div>
    <button class="btn" id="savePw">Change password</button> <span class="err" id="pwErr"></span></div></div><div>
  <div class="card section"><h3>Backup &amp; restore</h3><p>All your data lives in one file on this computer. Download a backup regularly, and keep it somewhere safe.</p>
    <button class="btn ghost" id="bk">Download backup</button>
    <div class="field" style="margin-top:14px"><label>Restore from a backup file (replaces current data)</label><input type="file" id="rf" accept=".db"></div><button class="btn ghost" id="rs">Restore</button></div>
  <div class="card section"><h3>Export to Excel</h3><p>One workbook with every table: cards, loans, investments, insurance, transactions and more.</p><button class="btn ghost" id="exp">Export all data</button></div>
  <div class="card section"><h3>Clear all data</h3><p>Deletes every record. Your password and settings are kept.</p><button class="btn danger" id="clr">Clear all data...</button></div></div></div>`;
  $('#saveS', v).onclick = async () => {
    await api('/settings', { json: { lock_minutes: +$('#lm', v).value, hide_default: $('#hd', v).checked } });
    state.lockMin = +$('#lm', v).value; resetIdle(); toast('Settings saved');
  };
  $('#savePw', v).onclick = async () => {
    const e = $('#pwErr', v); e.textContent = '';
    if ($('#pn', v).value !== $('#pr', v).value) { e.textContent = 'New passwords do not match'; return; }
    try { await api('/settings/password', { json: { current: $('#pc', v).value, new: $('#pn', v).value } }); toast('Password changed'); ['pc', 'pn', 'pr'].forEach(i => $('#' + i, v).value = ''); }
    catch (x) { e.textContent = x.message; }
  };
  $('#bk', v).onclick = () => { location.href = '/api/settings/backup'; };
  $('#exp', v).onclick = () => { location.href = '/api/settings/export'; };
  $('#rs', v).onclick = () => {
    const f = $('#rf', v).files[0]; if (!f) return toast('Choose a backup file first');
    openModal({ title: 'Restore backup', submitText: 'Replace my data', body: '<p>This replaces all current data with the backup, including the password stored in it. Continue?</p>',
      onSubmit: async () => { const fd = new FormData(); fd.append('file', f); await api('/settings/restore', { method: 'POST', body: fd }); toast('Restored. Please sign in again.'); lockNow(true); } });
  };
  $('#clr', v).onclick = () => openModal({ title: 'Clear all data', submitText: 'Delete everything',
    body: '<p>This permanently deletes all records. Download a backup first if unsure. Enter your password to confirm.</p><div class="field"><input type="password" id="cpw" placeholder="Password"></div>',
    onSubmit: async r => { await api('/settings/clear', { json: { password: $('#cpw', r).value } }); toast('All data cleared'); route(); } });
}

/* --------------------------------------------------------------- router */
const PAGES = {
  overview: ['Overview', pageOverview], cards: ['Credit Cards', pageCards], loans: ['Loans', pageLoans], investments: ['Investments', pageInvestments],
  insurance: ['Insurance', pageInsurance], bank: ['Bank & Income', pageBank], budget: ['Budget', pageBudget], goals: ['Goals', pageGoals], settings: ['Settings', pageSettings]
};
function buildNav() {
  $('#links').innerHTML = Object.entries(PAGES).map(([k, [t]]) => (k === 'budget' || k === 'settings' ? '<div class="sep"></div>' : '') + `<a href="#${k}" data-r="${k}">${t}</a>`).join('');
}
async function route() {
  state.route = (location.hash || '#overview').slice(1);
  if (!PAGES[state.route]) state.route = 'overview';
  const [title, fn] = PAGES[state.route];
  $('#title').textContent = title;
  document.querySelectorAll('#links a').forEach(a => a.classList.toggle('on', a.dataset.r === state.route));
  const v = $('#view');
  try { await fn(v); } catch (e) { if (e.message !== 'locked') v.innerHTML = `<div class="note">${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', () => { closeModal(); route(); });

/* ---------------------------------------------------- lock / auth gate */
let idleT, lastPing = 0, locked = true;
function resetIdle() {
  if (locked) return;
  clearTimeout(idleT);
  idleT = setTimeout(() => lockNow(), state.lockMin * 60000);
  if (Date.now() - lastPing > 30000) { lastPing = Date.now(); fetch('/api/auth/ping', { method: 'POST' }).catch(() => { }); }
}
['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach(e => window.addEventListener(e, resetIdle, { passive: true }));

function scramble(root) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const rnd = s => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)];
  let n; while ((n = w.nextNode())) n.nodeValue = n.nodeValue.replace(/[0-9]/g, () => Math.floor(Math.random() * 10)).replace(/[a-z]/g, rnd).replace(/[A-Z]/g, () => rnd().toUpperCase());
  root.querySelectorAll('input').forEach(i => { i.value = ''; });
  root.querySelectorAll('canvas').forEach(c => { const ch = Chart.getChart(c); if (ch) ch.destroy(); });
}
async function lockNow(serverAlready) {
  if (locked) return;
  locked = true; clearTimeout(idleT);
  closeModal();
  scramble($('#view'));
  $('#app').classList.add('blurred');
  if (!serverAlready) api('/auth/lock', { method: 'POST' }).catch(() => { });
  showGate('login');
}
function showGate(mode, msg) {
  const g = $('#gate'); g.hidden = false;
  const setup = mode === 'setup';
  g.innerHTML = `<form class="box"><h2>${setup ? 'Create a password' : 'Locked'}</h2><p>${setup ? 'This protects your dashboard. You can change it later in Settings.' : 'Enter your password to continue.'}</p>
  <input type="password" id="gp" placeholder="Password" autocomplete="${setup ? 'new-password' : 'current-password'}" autofocus>
  ${setup ? '<input type="password" id="gp2" placeholder="Repeat password" autocomplete="new-password">' : ''}
  <button class="btn" style="width:100%">${setup ? 'Create password' : 'Unlock'}</button><div class="err" id="ge" style="margin:10px 0 0">${esc(msg || '')}</div></form>`;
  $('#gp').focus();
  $('form', g).onsubmit = async e => {
    e.preventDefault();
    const pw = $('#gp').value;
    if (setup && pw !== $('#gp2').value) { $('#ge').textContent = 'Passwords do not match'; return; }
    try { await api(setup ? '/auth/setup' : '/auth/login', { json: { password: pw } }); await enter(); }
    catch (x) { $('#ge').textContent = x.message; $('#gp').value = ''; }
  };
}
async function enter() {
  const st = await api('/auth/status');
  state.lockMin = st.lock_minutes;
  document.body.classList.toggle('hide-amt', st.hide_default);
  syncHideBtn();
  if (!state.meta) state.meta = await api('/meta');
  $('#gate').hidden = true; $('#app').classList.remove('blurred');
  locked = false; resetIdle();
  await route();
}
function syncHideBtn() { $('#hideBtn').classList.toggle('on', hiding()); $('#hideBtn').textContent = hiding() ? 'Show amounts' : 'Hide amounts'; }

document.addEventListener('click', e => {
  const a = e.target.closest('.amt');
  if (a && hiding()) a.classList.toggle('show');
});
$('#hideBtn').onclick = () => { document.body.classList.toggle('hide-amt'); syncHideBtn(); if (!locked) route(); };
$('#lockBtn').onclick = () => lockNow();

(async function init() {
  buildNav();
  const st = await fetch('/api/auth/status').then(r => r.json());
  if (!st.configured) { $('#app').classList.add('blurred'); showGate('setup'); }
  else if (!st.unlocked) { $('#app').classList.add('blurred'); showGate('login'); }
  else await enter();
})();
