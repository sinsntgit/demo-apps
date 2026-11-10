import {
  api, html, raw, setHtml, esc, on, store, toast, fail, modal, confirmBox, field, formValues, money as usd, fmtDate, fmtDateTime, ago, todayStr, debounce, $, $$, allow,
} from './core.js';
import { mountList } from './list.js';

export const fmt = (n, cur = 'SAR') => `${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`;
const chip = (cls, text) => html`<span class="badge ${cls}">${text}</span>`;
const STATUS = { draft: ['b-grey', 'Draft'], issued: ['b-info', 'Issued'], partially_paid: ['b-warn', 'Partially paid'], paid: ['b-ok', 'Paid'] };
const COMPLIANCE = { not_ready: ['b-grey', 'Draft'], ready: ['b-info', 'Ready · not submitted'], cleared: ['b-ok', 'Cleared'], reported: ['b-ok', 'Reported'], rejected: ['b-bad', 'Rejected'], failed: ['b-bad', 'Submission failed'] };
const TYPES = { standard: 'Tax invoice (B2B)', simplified: 'Simplified (B2C)', credit_note: 'Credit note', debit_note: 'Debit note' };
export const statusChip = (i) => (i.days_overdue > 0 ? chip('b-bad', `Overdue ${i.days_overdue}d`) : chip(...STATUS[i.status]));
export const complianceChip = (s) => chip(...(COMPLIANCE[s] || ['b-grey', s]));
export const invLabel = (i) => i.number || i.external_number || `Draft #${i.id}`;
const page = (title, actions = '') => html`<div class="topbar"><h1>${title}</h1><span class="grow"></span>${actions}</div>`;
const issuesBox = (issues, empty = 'No problems found.') => issues.length ? html`${issues.map((i) => html`<div class="issue ${i.severity}"><b>${i.severity === 'error' ? 'Must fix' : i.severity === 'warning' ? 'Check' : 'Note'}:</b> ${i.message}${i.fix ? html` <span class="muted small">— ${i.fix}</span>` : ''}${i.seller ? html` <a href="#/billing-settings">Open billing settings</a>` : ''}</div>`)}` : html`<div class="issue info">✅ ${empty}</div>`;

// ================= List =================
export async function invoiceList(root, importFlow) {
  root.innerHTML = ''; const head = document.createElement('div'), body = document.createElement('div'); root.append(head, body);
  setHtml(head, page('Invoices', html`${allow('invoices.import') ? html`<button class="btn" data-act="import">Import from accounting system</button>` : ''}<button class="btn primary" data-act="new">+ New invoice</button>`));
  mountList(body, { key: 'invoices', endpoint: '/invoices', searchPlaceholder: 'Search number, customer…', empty: 'No invoices yet. Create your first one or import from Zoho Books, QuickBooks or Xero.',
    extra: () => ({ account_id: new URLSearchParams(location.hash.split('?')[1] || '').get('account_id') || '' }),
    filters: [{ name: 'status', label: 'Status', options: [['draft', 'Draft'], ['open', 'Open (unpaid)'], ['overdue', 'Overdue'], ['partially_paid', 'Partially paid'], ['paid', 'Paid']] }, { name: 'type', label: 'Type', options: Object.entries(TYPES) }, { name: 'compliance', label: 'E-invoicing', options: Object.entries(COMPLIANCE).filter(([k]) => k !== 'not_ready').map(([k, v]) => [k, v[1]]) }],
    pagerExtra: (d) => ` · total ${fmt(d.sum_total, '')}· outstanding ${fmt(d.sum_balance, '')}`,
    columns: [
      { label: 'Number', sort: 'number', render: (i) => html`<a href="#/invoices/${i.id}"><b>${invLabel(i)}</b></a>${i.ref_number ? html`<div class="small muted">for ${i.ref_number}</div>` : ''}${i.source === 'import' ? html`<div class="small muted">imported</div>` : ''}` },
      { label: 'Customer', sort: 'buyer_name', render: (i) => i.buyer_name || '—' }, { label: 'Type', render: (i) => chip('b-grey', TYPES[i.doc_type].split(' (')[0]) },
      { label: 'Issued', sort: 'issue_date', render: (i) => fmtDate(i.issue_date) }, { label: 'Due', sort: 'due_date', render: (i) => html`<span style="${i.days_overdue ? 'color:var(--bad);font-weight:600' : ''}">${fmtDate(i.due_date)}</span>` },
      { label: 'Total', sort: 'total', cls: 'right nowrap', render: (i) => fmt(i.doc_type === 'credit_note' ? -i.total : i.total, i.currency) }, { label: 'Balance', sort: 'balance', cls: 'right nowrap', render: (i) => (i.status === 'draft' || i.doc_type === 'credit_note' ? '—' : fmt(i.balance, i.currency)) },
      { label: 'Status', render: statusChip }, { label: 'E-invoicing', render: (i) => complianceChip(i.compliance_status) },
    ] });
  on(head, { new: () => { location.hash = '#/invoices/new'; }, import: () => importFlow?.() });
}

// ================= Editor =================
const emptyLine = () => ({ description: '', description_ar: '', qty: 1, unit_price: 0, discount: 0, vat_category: 'S', vat_rate: '', exemption_reason: '' });
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
function liveTotals(lines, defRate) {
  let gross = 0, disc = 0, vat = 0;
  const calc = lines.map((l) => { const g = r2((+l.qty || 0) * (+l.unit_price || 0)), net = r2(g - (+l.discount || 0)), rate = l.vat_category === 'S' ? (l.vat_rate === '' || l.vat_rate == null ? defRate : +l.vat_rate) : 0, v = r2((net * rate) / 100); gross += g; disc += g - net; vat += v; return { net, vat: v, total: r2(net + v) }; });
  return { calc, gross: r2(gross), disc: r2(disc), vat: r2(vat), total: r2(gross - disc + vat) };
}

export async function invoiceEditor(root, id) {
  const [accounts, settings] = await Promise.all([api('GET', '/accounts?limit=1000&sort=name'), api('GET', '/billing/settings').catch(() => null)]);
  const co = settings?.settings || { jurisdiction: 'KSA', currency: 'SAR', default_lang: 'both' };
  let inv = id ? await api('GET', `/invoices/${id}`) : { doc_type: 'standard', jurisdiction: co.jurisdiction, currency: co.jurisdiction === 'UAE' ? 'AED' : co.currency, lang: co.default_lang, issue_date: todayStr(), supply_date: todayStr(), due_date: new Date(Date.now() + (co.payment_terms_days ?? 30) * 86400000).toISOString().slice(0, 10), lines: [emptyLine()], buyer_country: co.jurisdiction === 'UAE' ? 'AE' : 'SA' };
  if (id && inv.status !== 'draft') { location.hash = `#/invoices/${id}`; return; }
  const isNote = ['credit_note', 'debit_note'].includes(inv.doc_type); const defRate = inv.jurisdiction === 'UAE' ? 5 : 15;
  const F = (n, label, o = {}) => field({ name: n, label, ...o }, inv);
  setHtml(root, html`${page(id ? `Edit ${isNote ? TYPES[inv.doc_type].toLowerCase() : 'draft invoice'}` : 'New invoice', html`<a class="btn" href="#/invoices${id ? '/' + id : ''}">Cancel</a><button class="btn" data-act="save">Save draft</button>${allow('invoices.issue') ? html`<button class="btn primary" data-act="saveissue">Save & issue</button>` : ''}`)}
    <form id="inv" class="grid g21" style="align-items:start"><div style="display:grid;gap:16px">
      <div class="card"><div class="hd"><h2>Document</h2></div><div class="bd">
        ${isNote ? html`<div class="banner info small"><b>${TYPES[inv.doc_type]}</b> against <b>${inv.ref_number}</b>. ${inv.doc_type === 'credit_note' ? 'Reduce quantities or prices to credit part of the invoice.' : 'Add the extra charges.'}</div>${F('reason', 'Reason (printed on the document and sent to the authority)', { required: true })}` : html`<div class="row">${F('doc_type', 'Type', { type: 'select', options: [['standard', 'Tax invoice — business customer (B2B)'], ['simplified', 'Simplified invoice — consumer (B2C)']], blank: false })}${F('lang', 'Language', { type: 'select', options: [['both', 'Arabic + English'], ['en', 'English'], ['ar', 'Arabic']], blank: false })}</div>`}
        <div class="row">${F('issue_date', 'Issue date', { type: 'date', required: true })}${F('supply_date', 'Supply date', { type: 'date' })}</div>
        <div class="row">${F('due_date', 'Due date', { type: 'date' })}${F('currency', 'Currency', { required: true })}</div>${F('payment_terms', 'Payment terms (optional)', { placeholder: 'e.g. Net 30 days' })}</div></div>
      <div class="card"><div class="hd"><h2>Customer</h2><span class="grow"></span>${isNote ? '' : html`<a href="#/accounts" class="small">Manage customers</a>`}</div><div class="bd">
        ${isNote ? '' : field({ name: 'account_id', label: 'Customer (account)', type: 'select', options: accounts.rows.map((a) => [a.id, a.name]), blank: 'Select a customer…' }, inv)}
        <div class="row">${F('buyer_name', 'Name')}${F('buyer_name_ar', 'Name (Arabic)')}</div><div class="row">${F('buyer_vat', jur() === 'UAE' ? 'TRN (tax registration number)' : 'VAT number')}${F('buyer_country', 'Country code', { placeholder: 'SA / AE' })}</div>
        <div class="row">${F('buyer_street', 'Street')}${F('buyer_building', 'Building no.')}</div><div class="row">${F('buyer_district', 'District')}${F('buyer_city', 'City')}</div>
        <div class="row">${F('buyer_postal', 'Postal code')}${F('buyer_email', 'Email (reminders)', { type: 'email' })}</div>${F('buyer_phone', 'Phone / WhatsApp (reminders)')}</div></div>
      <div class="card"><div class="hd"><h2>Items</h2><span class="grow"></span><button type="button" class="btn sm" data-act="addline">+ Add line</button></div><div class="bd tablewrap"><table class="lines"><thead><tr><th style="min-width:200px">Description</th><th style="min-width:140px">Arabic description</th><th style="width:70px">Qty</th><th style="width:100px">Unit price</th><th style="width:80px">Discount</th><th style="width:110px">VAT</th><th style="width:70px">Rate %</th><th class="n" style="width:90px">Total</th><th style="width:30px"></th></tr></thead><tbody id="lines"></tbody></table></div></div>
      ${F('notes', 'Notes (printed on the invoice)', { type: 'textarea', rows: 2 })}</div>
      <div style="display:grid;gap:16px;position:sticky;top:12px"><div class="card"><div class="hd"><h2>Totals</h2></div><div class="bd" id="totals"></div></div>
      <div class="card"><div class="hd"><h2>Compliance check</h2><span class="grow"></span><span class="small muted">${inv.jurisdiction} rules</span></div><div class="bd" id="issues"></div></div></div></form>`);
  function jur() { return inv.jurisdiction; }
  const form = $('#inv', root); form.addEventListener('submit', (e) => e.preventDefault());
  const tbody = $('#lines', root);
  const lineRow = (l, i) => html`<tr data-i="${i}"><td><input data-k="description" value="${l.description}" maxlength="500" aria-label="Description"></td><td><input data-k="description_ar" dir="rtl" value="${l.description_ar || ''}" aria-label="Arabic description"></td>
    <td><input data-k="qty" type="number" step="any" min="0" value="${l.qty}"></td><td><input data-k="unit_price" type="number" step="0.01" min="0" value="${l.unit_price}"></td><td><input data-k="discount" type="number" step="0.01" min="0" value="${l.discount || 0}"></td>
    <td><select data-k="vat_category">${[['S', 'Standard'], ['Z', 'Zero-rated'], ['E', 'Exempt'], ['O', 'Out of scope']].map(([v, t]) => html`<option value="${v}" ${l.vat_category === v ? raw('selected') : ''}>${t}</option>`)}</select>${l.vat_category !== 'S' ? html`<input data-k="exemption_reason" placeholder="Reason / VATEX code" value="${l.exemption_reason || ''}" style="margin-top:4px">` : ''}</td>
    <td><input data-k="vat_rate" type="number" step="any" min="0" ${l.vat_category !== 'S' ? raw('disabled') : ''} placeholder="${defRate}" value="${l.vat_category === 'S' ? (l.vat_rate ?? '') : ''}"></td><td class="n" data-total></td><td><button type="button" class="btn sm danger" data-act="rmline" aria-label="Remove line">✕</button></td></tr>`;
  let lines = (inv.lines || []).map((l) => ({ ...emptyLine(), ...l })); if (!lines.length) lines = [emptyLine()];
  if (inv.id) lines = lines.map((l) => ({ ...l, vat_rate: l.vat_category === 'S' && l.vat_rate === defRate ? '' : l.vat_rate }));
  const drawLines = () => { setHtml(tbody, html`${lines.map(lineRow)}`); refresh(); };
  const readLines = () => $$('tr', tbody).map((tr) => { const o = {}; $$('[data-k]', tr).forEach((el) => { o[el.dataset.k] = el.value; }); return { ...emptyLine(), ...o }; });
  const payload = () => {
    const g = (n) => form.elements[n]?.value ?? '';
    const p = { id: inv.id, doc_type: isNote ? inv.doc_type : g('doc_type'), lang: g('lang') || inv.lang, currency: g('currency'), jurisdiction: inv.jurisdiction, issue_date: g('issue_date'), supply_date: g('supply_date'), due_date: g('due_date'), payment_terms: g('payment_terms'), notes: g('notes'), lines: readLines().map((l) => ({ ...l, vat_rate: l.vat_category === 'S' ? l.vat_rate : '' })) };
    for (const k of ['buyer_name', 'buyer_name_ar', 'buyer_vat', 'buyer_street', 'buyer_building', 'buyer_district', 'buyer_city', 'buyer_postal', 'buyer_country', 'buyer_email', 'buyer_phone']) p[k] = g(k);
    if (isNote) { p.reason = g('reason'); p.ref_invoice_id = inv.ref_invoice_id; } else p.account_id = g('account_id') || null;
    if (inv.contact_id) p.contact_id = inv.contact_id;
    return p;
  };
  const refresh = debounce(async () => {
    const p = payload(); const t = liveTotals(p.lines, defRate);
    $$('tr', tbody).forEach((tr, i) => { $('[data-total]', tr).textContent = t.calc[i].total.toFixed(2); });
    setHtml($('#totals', root), html`<div style="display:grid;gap:4px"><div style="display:flex;justify-content:space-between"><span>Subtotal</span><b>${fmt(t.gross, p.currency)}</b></div>${t.disc ? html`<div style="display:flex;justify-content:space-between"><span>Discount</span><b>− ${fmt(t.disc, p.currency)}</b></div>` : ''}<div style="display:flex;justify-content:space-between"><span>VAT</span><b>${fmt(t.vat, p.currency)}</b></div><div style="display:flex;justify-content:space-between;font-size:18px;border-top:2px solid var(--ink);padding-top:6px;margin-top:4px"><span>Total</span><b>${fmt(t.total, p.currency)}</b></div></div>`);
    try { const v = await api('POST', '/invoices/validate', p); setHtml($('#issues', root), issuesBox(v.issues, 'Ready to issue — no problems found.')); } catch (e) { setHtml($('#issues', root), html`<div class="issue error">${e.message}</div>`); }
  }, 350);
  drawLines();
  form.addEventListener('input', (e) => { if (e.target.dataset.k === 'vat_category') return; refresh(); });
  form.addEventListener('change', async (e) => {
    if (e.target.dataset.k === 'vat_category') { lines = readLines(); drawLines(); return; }
    if (e.target.name === 'account_id' && e.target.value) {
      const a = await api('GET', `/accounts/${e.target.value}`);
      const map = { buyer_name: a.name, buyer_name_ar: a.name_ar, buyer_vat: a.vat_number, buyer_street: a.street, buyer_building: a.building_no, buyer_district: a.district, buyer_city: a.city, buyer_postal: a.postal_code, buyer_country: a.country_code || 'SA', buyer_email: a.billing_email, buyer_phone: a.billing_phone || a.phone };
      for (const [k, v] of Object.entries(map)) if (form.elements[k]) form.elements[k].value = v || '';
      refresh();
    }
  });
  const save = async () => { const p = payload(); const r = id ? await api('PUT', `/invoices/${id}`, p) : await api('POST', '/invoices', p); return r; };
  on(root, {
    addline: () => { lines = [...readLines(), emptyLine()]; drawLines(); },
    rmline: (el) => { lines = readLines(); lines.splice(+el.closest('tr').dataset.i, 1); if (!lines.length) lines = [emptyLine()]; drawLines(); },
    save: async () => { const r = await save(); toast('Draft saved', 'ok'); location.hash = `#/invoices/${r.id}`; },
    saveissue: async () => {
      const r = await save();
      try { const issued = await api('POST', `/invoices/${r.id}/issue`); toast(`Issued ${issued.number}`, 'ok'); location.hash = `#/invoices/${r.id}`; }
      catch (e) { toast('Saved as draft — fix the problems below, then issue.', 'bad'); if (e.message) setHtml($('#issues', root), html`<div class="issue error">${e.message}</div>`); id = r.id; history.replaceState(null, '', `#/invoices/${r.id}/edit`); refresh(); }
    },
  });
}

// ================= Detail =================
export async function invoiceDetail(root, id) {
  const draw = async () => {
    const i = await api('GET', `/invoices/${id}`); const cur = i.currency; const note = i.doc_type === 'credit_note';
    const open = ['issued', 'partially_paid'].includes(i.status) && i.balance > 0;
    const cstat = { ready: i.provider.mode === 'none' ? 'Generated and validated, but no e-invoicing provider is connected, so it has not been submitted to the tax authority.' : 'Generated and waiting to be submitted to your provider.', cleared: 'Cleared by the tax authority via your provider.', reported: 'Reported to the tax authority via your provider.', rejected: 'Rejected. Issue a credit note and a corrected invoice.', failed: 'Submission failed — retry below.' }[i.compliance_status];
    setHtml(root, html`<div class="topbar"><a href="#/invoices">← Invoices</a><h1 class="mono" style="margin-left:6px">${invLabel(i)}</h1>${i.status === 'draft' ? chip('b-grey', 'Draft') : statusChip(i)}${chip('b-grey', TYPES[i.doc_type])}${i.status !== 'draft' ? complianceChip(i.compliance_status) : ''}<span class="grow"></span>
      ${i.status === 'draft' ? html`<a class="btn" href="#/invoices/${i.id}/edit">Edit</a>${allow('invoices.issue') ? html`<button class="btn primary" data-act="issue">Issue</button>` : ''}<button class="btn danger" data-act="delete">Delete draft</button>` : html`
        ${allow('invoices.payment') && open ? html`<button class="btn primary" data-act="pay">Record payment</button>` : ''}${allow('invoices.remind') && open ? html`<button class="btn" data-act="remind">Send reminder</button>` : ''}<a class="btn" href="/api/invoices/${i.id}/print" target="_blank" rel="noopener">Print / PDF</a><a class="btn" href="/api/invoices/${i.id}/xml">XML</a>
        ${allow('invoices.notes') && !note ? html`<button class="btn" data-act="credit">Credit note</button><button class="btn" data-act="debit">Debit note</button>` : ''}`}</div>
      ${i.status !== 'draft' && ['ready', 'failed', 'rejected'].includes(i.compliance_status) && i.doc_type !== 'simplified' && i.jurisdiction === 'KSA' ? html`<div class="banner small"><b>Do not send this invoice to the customer yet.</b> ${i.compliance_status === 'rejected' ? 'It was rejected.' : 'Standard (B2B) invoices must be cleared by ZATCA first.'}</div>` : ''}
      ${i.status === 'draft' ? html`<div class="card" style="margin-bottom:16px"><div class="hd"><h2>Compliance check</h2></div><div class="bd">${issuesBox(i.issues, 'Ready to issue — no problems found.')}</div></div>` : ''}
      ${i.status !== 'draft' && !note ? html`<div class="grid g4" style="margin-bottom:16px"><div class="card kpi"><div class="l">Total</div><div class="v" style="font-size:22px">${fmt(i.total, cur)}</div><div class="s">VAT ${fmt(i.vat_total, cur)}</div></div><div class="card kpi"><div class="l">Paid</div><div class="v" style="font-size:22px">${fmt(i.amount_paid, cur)}</div>${i.amount_credited ? html`<div class="s">credited ${fmt(i.amount_credited, cur)}</div>` : ''}</div>
        <div class="card kpi"><div class="l">Balance</div><div class="v" style="font-size:22px;${i.days_overdue ? 'color:var(--bad)' : ''}">${fmt(i.balance, cur)}</div></div><div class="card kpi"><div class="l">${i.days_overdue ? 'Overdue' : 'Due'}</div><div class="v" style="font-size:22px">${i.balance <= 0 ? 'Settled' : i.days_overdue ? `${i.days_overdue} days` : fmtDate(i.due_date)}</div><div class="s">due ${fmtDate(i.due_date)}</div></div></div>` : ''}
      <div class="grid g21" style="align-items:start"><div style="display:grid;gap:16px">
        <div class="card"><div class="hd"><h2>Items</h2></div><div class="tablewrap"><table><thead><tr><th>Description</th><th class="right">Qty</th><th class="right">Unit</th><th class="right">Disc.</th><th class="right">VAT</th><th class="right">Total</th></tr></thead><tbody>
          ${i.lines.map((l) => html`<tr><td>${l.description}${l.description_ar ? html`<div class="small muted" dir="rtl">${l.description_ar}</div>` : ''}${l.exemption_reason ? html`<div class="small muted">${l.exemption_reason}</div>` : ''}</td><td class="right">${l.qty}</td><td class="right">${l.unit_price.toFixed(2)}</td><td class="right">${l.discount.toFixed(2)}</td><td class="right">${l.vat_category === 'S' ? l.vat_rate + '%' : l.vat_category} · ${l.vat.toFixed(2)}</td><td class="right"><b>${l.total.toFixed(2)}</b></td></tr>`)}</tbody></table></div>
          <div class="bd" style="text-align:right"><div>Subtotal ${fmt(i.subtotal, cur)}</div>${i.discount_total ? html`<div>Discount − ${fmt(i.discount_total, cur)}</div>` : ''}<div>VAT ${fmt(i.vat_total, cur)}</div><div style="font-size:18px"><b>Total ${fmt(i.total, cur)}</b></div></div></div>
        ${i.status !== 'draft' && !note ? html`<div class="card"><div class="hd"><h2>Payments</h2></div>${i.payments.length ? html`<div class="tablewrap"><table><thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Reference</th><th>Recorded by</th><th>Bank reconciled</th></tr></thead><tbody>${i.payments.map((p) => html`<tr><td>${fmtDate(p.paid_on)}</td><td><b>${fmt(p.amount, cur)}</b></td><td>${p.method.replace('_', ' ')}</td><td>${p.reference || '—'}${p.note ? html`<div class="small muted">${p.note}</div>` : ''}</td><td class="small">${p.recorded_by_name || '—'}</td><td>${allow('invoices.payment') ? html`<input type="checkbox" data-act="recon" data-id="${p.id}" ${p.reconciled ? raw('checked') : ''} aria-label="Reconciled">` : p.reconciled ? '✓' : '—'}</td></tr>`)}</tbody></table></div>` : html`<div class="empty">No payments recorded yet.</div>`}</div>` : ''}
        ${i.claims.filter((c) => c.status === 'pending').length ? html`<div class="card" style="border-color:var(--warn)"><div class="hd"><h2>Customer says they paid</h2></div><div class="bd">${i.claims.filter((c) => c.status === 'pending').map((c) => html`<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:6px 0"><span class="grow"><b>${fmt(c.amount, cur)}</b> on ${fmtDate(c.paid_on || c.created_at)}${c.reference ? ` · ref ${c.reference}` : ''}${c.payer_name ? ` · ${c.payer_name}` : ''}<div class="small muted">Check your bank statement before confirming.</div></span>${allow('invoices.payment') ? html`<button class="btn sm primary" data-act="claimok" data-id="${c.id}">Confirm received</button><button class="btn sm danger" data-act="claimno" data-id="${c.id}">Not received</button>` : ''}</div>`)}</div></div>` : ''}
        <div class="card"><div class="hd"><h2>Audit trail</h2><span class="muted small">append-only</span></div><div class="bd"><ul class="timeline">${i.events.map((e) => html`<li><b>${e.type.replace(/_/g, ' ')}</b> <span class="muted small">· ${e.user_name || 'system'} · ${fmtDateTime(e.created_at)}</span>${e.detail ? html`<div class="small">${e.detail}</div>` : ''}</li>`)}</ul></div></div>
      </div><div style="display:grid;gap:16px">
        <div class="card"><div class="hd"><h2>Customer</h2></div><div class="bd small" style="display:grid;gap:3px"><b>${i.buyer_name || '—'}</b>${i.buyer_name_ar ? html`<span dir="rtl">${i.buyer_name_ar}</span>` : ''}<span class="mono">${i.buyer_vat || 'no VAT number'}</span><span>${[i.buyer_street, i.buyer_building, i.buyer_district, i.buyer_city, i.buyer_postal].filter(Boolean).join(', ') || '—'}</span><span>${i.buyer_email || ''} ${i.buyer_phone || ''}</span>${i.account_id ? html`<a href="#/accounts/${i.account_id}">Open customer →</a>` : ''}</div></div>
        <div class="card"><div class="hd"><h2>Dates</h2></div><div class="bd small" style="display:grid;gap:3px"><span>Issued: ${fmtDate(i.issue_date)}</span><span>Supply: ${fmtDate(i.supply_date)}</span><span>Due: ${fmtDate(i.due_date)}</span>${i.ref_number ? html`<span>Original: <a href="#/invoices/${i.ref_invoice_id}"><b>${i.ref_number}</b></a></span>` : ''}${i.reason ? html`<span>Reason: ${i.reason}</span>` : ''}</div></div>
        ${i.status !== 'draft' ? html`<div class="card"><div class="hd"><h2>E-invoicing</h2></div><div class="bd small" style="display:grid;gap:8px"><div>${complianceChip(i.compliance_status)}</div><div>${cstat || ''}</div>${i.compliance_response ? html`<div class="issue ${i.compliance_status === 'rejected' || i.compliance_status === 'failed' ? 'error' : 'info'}">${i.compliance_response}</div>` : ''}
          ${allow('invoices.submit') && ['ready', 'failed'].includes(i.compliance_status) && i.provider.mode === 'webhook' ? html`<button class="btn sm" data-act="submit">${i.compliance_status === 'failed' ? 'Retry submission' : 'Submit to provider'}</button>` : ''}
          <div style="display:flex;gap:10px;align-items:center"><div class="qrbox">${raw(i.qr_svg || '')}</div><div class="muted">QR (seller, VAT no., time, totals, hash). Signature fields are added by your certified provider.</div></div>
          <div><span class="muted">ICV</span> ${i.icv} · <span class="muted">UUID</span> <span class="mono">${i.uuid}</span></div><div class="hashline"><span class="muted">Hash</span> <span class="mono">${i.invoice_hash}</span></div><div class="hashline"><span class="muted">Previous hash</span> <span class="mono">${i.previous_hash}</span></div></div></div>` : ''}
        ${i.portal_url ? html`<div class="card"><div class="hd"><h2>Customer payment page</h2></div><div class="bd small" style="display:grid;gap:8px"><div class="mono hashline">${i.portal_url}</div><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm" data-act="copy" data-url="${i.portal_url}">Copy link</button><a class="btn sm" href="${i.portal_url}" target="_blank" rel="noopener">Open</a><a class="btn sm" href="${i.portal_url}?lang=ar" target="_blank" rel="noopener">عربي</a></div><div class="muted">Shows the invoice, bank-transfer instructions and lets the customer notify you of a payment.</div></div></div>` : ''}
        ${i.related.length ? html`<div class="card"><div class="hd"><h2>Credit / debit notes</h2></div><div class="bd small">${i.related.map((r) => html`<div><a href="#/invoices/${r.id}"><b>${r.number || 'Draft'}</b></a> ${chip('b-grey', r.doc_type === 'credit_note' ? 'credit' : 'debit')} ${fmt(r.total, cur)}<div class="muted">${r.reason}</div></div>`)}</div></div>` : ''}
        ${i.reminders.length ? html`<div class="card"><div class="hd"><h2>Reminders sent</h2></div><div class="bd small">${i.reminders.map((r) => html`<div>${chip(r.status === 'failed' ? 'b-bad' : r.status === 'skipped' ? 'b-grey' : 'b-ok', r.channel)} ${r.status} <span class="muted">${ago(r.created_at)} · ${r.kind}</span>${r.detail ? html`<div class="muted">${r.detail}</div>` : ''}</div>`)}</div></div>` : ''}
        ${i.notes ? html`<div class="card"><div class="bd small">${i.notes}</div></div>` : ''}</div></div>`);
    const noteModal = (kind) => modal({ title: kind === 'credit_note' ? `Credit note for ${i.number}` : `Debit note for ${i.number}`, submitLabel: 'Create draft',
      body: html`<p class="small muted">${kind === 'credit_note' ? 'A credit note corrects or cancels an issued invoice — issued invoices are never edited. It starts as a draft copy of all lines; you can reduce it to credit only part.' : 'A debit note adds charges to an issued invoice. You will add the lines next.'}</p>${field({ name: 'reason', label: 'Reason', required: true, placeholder: 'e.g. Services not delivered / price correction / wrong customer VAT number' })}`,
      onSubmit: async (f) => { const n = await api('POST', `/invoices/${i.id}/${kind === 'credit_note' ? 'credit-note' : 'debit-note'}`, { reason: f.reason.value }); location.hash = `#/invoices/${n.id}/edit`; } });
    on(root, {
      issue: async () => { try { const r = await api('POST', `/invoices/${id}/issue`); toast(`Issued ${r.number}${r.submission?.status && r.submission.status !== 'ready' ? ` · ${r.submission.status}` : ''}`, 'ok'); draw(); } catch (e) { modal({ title: 'Cannot issue yet', hideFooter: true, body: html`<p>${e.message}</p>${e.extra?.issues ? '' : ''}` }); draw(); } },
      delete: async () => { if (await confirmBox('Delete this draft?', 'Delete')) { await api('DELETE', `/invoices/${id}`); location.hash = '#/invoices'; } },
      pay: () => modal({ title: `Record payment · ${i.number}`, submitLabel: 'Record payment',
        body: html`<p class="small muted">Balance outstanding: <b>${fmt(i.balance, cur)}</b></p><div class="row">${field({ name: 'amount', label: 'Amount received', type: 'number', step: '0.01', min: 0.01, max: i.balance, required: true, default: i.balance })}${field({ name: 'paid_on', label: 'Payment date', type: 'date', required: true, default: todayStr() })}</div><div class="row">${field({ name: 'method', label: 'Method', type: 'select', options: [['bank_transfer', 'Bank transfer'], ['cash', 'Cash'], ['card', 'Card'], ['cheque', 'Cheque'], ['other', 'Other']], blank: false })}${field({ name: 'reference', label: 'Bank reference' })}</div>${field({ name: 'note', label: 'Note (optional)' })}${field({ name: 'reconciled', label: 'Already matched with the bank statement', type: 'checkbox' })}`,
        onSubmit: async (f) => { await api('POST', `/invoices/${id}/payments`, { amount: f.amount.value, paid_on: f.paid_on.value, method: f.method.value, reference: f.reference.value, note: f.note.value, reconciled: f.reconciled.checked }); toast('Payment recorded', 'ok'); draw(); } }),
      recon: async (el) => { await api('PUT', `/payments/${el.dataset.id}/reconcile`, { reconciled: el.checked }); toast(el.checked ? 'Marked reconciled' : 'Marked unreconciled', 'ok'); },
      claimok: async (el) => { await api('POST', `/payment-claims/${el.dataset.id}/confirm`); toast('Payment confirmed', 'ok'); draw(); },
      claimno: async (el) => { if (await confirmBox('Mark as not received? The customer is not notified automatically.', 'Not received')) { await api('POST', `/payment-claims/${el.dataset.id}/reject`); draw(); } },
      credit: () => noteModal('credit_note'), debit: () => noteModal('debit_note'),
      submit: async () => { const r = await api('POST', `/invoices/${id}/submit`); toast(`Provider: ${r.compliance_status}`, r.compliance_status === 'rejected' || r.compliance_status === 'failed' ? 'bad' : 'ok'); draw(); },
      copy: async (el) => { try { await navigator.clipboard.writeText(el.dataset.url); toast('Link copied', 'ok'); } catch { toast('Copy failed — select the link manually', 'bad'); } },
      remind: () => modal({ title: `Send reminder · ${i.number}`, submitLabel: 'Send', body: html`<p class="small muted">${i.days_overdue ? `${i.days_overdue} days overdue` : 'Not yet overdue'} · balance ${fmt(i.balance, cur)}. The message is bilingual and includes the payment link and bank details.</p>${field({ name: 'channel', label: 'Channel', type: 'select', blank: false, options: [['email', `Email${i.buyer_email ? ' → ' + i.buyer_email : ' (no email on file)'}`], ['whatsapp', `WhatsApp${i.buyer_phone ? ' → ' + i.buyer_phone : ' (no phone on file)'}`], ['sms', 'SMS (needs a gateway)']] })}`,
        onSubmit: async (f) => {
          const r = await api('POST', `/invoices/${id}/remind`, { channel: f.channel.value });
          if (r.status === 'link') { window.open(r.link, '_blank', 'noopener'); toast('WhatsApp opened with the message ready — press send there.', 'ok'); }
          else toast(`${r.status}: ${r.detail}`, ['failed', 'skipped'].includes(r.status) ? 'bad' : 'ok'); draw();
        } }),
    });
  };
  await draw();
}
