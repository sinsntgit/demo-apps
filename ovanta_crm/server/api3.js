import { GET, POST, PUT, DELETE, HttpError, bad, notFound, forbidden } from './http.js';
import { all, get, run, tx, audit, nowIso } from './db.js';
import { config } from './config.js';
import {
  getBilling, saveBilling, calcLines, validateInvoice, validateSeller, issueInvoice, recordPayment, loadInvoice, logEvent, verifyChain, balanceOf, daysOverdue, round2, today,
  qrSvg, cleanStr, isValidTaxId, defaultVatRate, statusFor,
} from './invoicing.js';
import { submitToProvider } from './providers.js';
import { receivablesSummary, readinessReport, sendReminder, runReminders, portalUrl } from './receivables.js';
import { renderInvoiceHtml } from './invoice-view.js';
import { scopeOf, canOnRecord } from './permissions.js';

/** Own-scope roles may only see/act on invoices they own. Hides existence (404) rather than revealing it. */
function assertVisible(user, id) {
  const row = get('SELECT owner_id FROM invoices WHERE id=?', id); if (!row) throw notFound('Invoice not found');
  if (scopeOf(user, 'invoices.view') === 'own' && row.owner_id !== user.id) throw notFound('Invoice not found');
  return row;
}

const MGR = ['admin', 'manager'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (d, n) => new Date(new Date(d).getTime() + n * 86400000).toISOString().slice(0, 10);
const asDate = (v, label) => { if (v === undefined || v === null || v === '') return null; const s = String(v).slice(0, 10); if (!DATE.test(s) || Number.isNaN(Date.parse(s))) throw bad(`${label} must be a valid date (YYYY-MM-DD)`); return s; };

// ---------------- Billing settings ----------------
GET('/api/billing/settings', () => ({ settings: getBilling(), issues: validateSeller(getBilling()) }));
PUT('/api/billing/settings', ({ body, user }) => { const s = saveBilling(body); audit(user, 'update', 'billing_settings', null); return { settings: s, issues: validateSeller(s) }; });
GET('/api/billing/chain', () => verifyChain());

// ---------------- Draft building ----------------
const BUYER_KEYS = ['buyer_name', 'buyer_name_ar', 'buyer_vat', 'buyer_street', 'buyer_building', 'buyer_district', 'buyer_city', 'buyer_postal', 'buyer_country', 'buyer_email', 'buyer_phone'];
function fromAccount(a, c) {
  return { buyer_name: a.name, buyer_name_ar: a.name_ar, buyer_vat: a.vat_number, buyer_street: a.street, buyer_building: a.building_no, buyer_district: a.district, buyer_city: a.city, buyer_postal: a.postal_code,
    buyer_country: a.country_code || 'SA', buyer_email: a.billing_email || c?.email || null, buyer_phone: a.billing_phone || c?.phone || a.phone || null };
}
/** Merge request body over an existing draft (or defaults) into a normalised, unsaved invoice + computed lines. */
export function buildDraft(body, existing, user) {
  const co = getBilling();
  const jur = ['KSA', 'UAE'].includes(body.jurisdiction) ? body.jurisdiction : existing?.jurisdiction || co.jurisdiction;
  const doc_type = ['standard', 'simplified', 'credit_note', 'debit_note'].includes(body.doc_type) ? body.doc_type : existing?.doc_type || 'standard';
  const f = { ...(existing || {}), doc_type, jurisdiction: jur };
  f.currency = cleanStr(body.currency ?? existing?.currency ?? (jur === 'UAE' ? 'AED' : co.currency), 3).toUpperCase() || co.currency;
  f.lang = ['en', 'ar', 'both'].includes(body.lang) ? body.lang : existing?.lang || co.default_lang;
  const accId = body.account_id === undefined ? existing?.account_id : body.account_id ? Number(body.account_id) : null;
  const conId = body.contact_id === undefined ? existing?.contact_id : body.contact_id ? Number(body.contact_id) : null;
  if (accId && !get('SELECT 1 FROM accounts WHERE id=?', accId)) throw bad('Customer (account) not found');
  if (conId && !get('SELECT 1 FROM contacts WHERE id=?', conId)) throw bad('Contact not found');
  f.account_id = accId || null; f.contact_id = conId || null;
  f.deal_id = body.deal_id === undefined ? existing?.deal_id ?? null : body.deal_id ? Number(body.deal_id) : null;
  if (f.account_id && (body.account_id !== undefined && Number(body.account_id) !== existing?.account_id || !existing)) {
    Object.assign(f, fromAccount(get('SELECT * FROM accounts WHERE id=?', f.account_id), conId ? get('SELECT * FROM contacts WHERE id=?', conId) : null));
  }
  for (const k of BUYER_KEYS) if (body[k] !== undefined) f[k] = cleanStr(body[k], 200) || null;
  if (f.buyer_vat) f.buyer_vat = String(f.buyer_vat).replace(/\s/g, '');
  f.buyer_country = String(f.buyer_country || (jur === 'UAE' ? 'AE' : 'SA')).toUpperCase().slice(0, 2);
  f.issue_date = asDate(body.issue_date ?? existing?.issue_date ?? today(), 'Issue date');
  f.supply_date = body.supply_date !== undefined ? asDate(body.supply_date, 'Supply date') : existing?.supply_date ?? f.issue_date;
  f.due_date = body.due_date !== undefined ? asDate(body.due_date, 'Due date') : existing ? existing.due_date : (doc_type === 'credit_note' || doc_type === 'simplified' ? null : addDays(f.issue_date, co.payment_terms_days));
  f.payment_terms = body.payment_terms !== undefined ? cleanStr(body.payment_terms, 200) || null : existing?.payment_terms ?? null;
  f.notes = body.notes !== undefined ? String(body.notes || '').slice(0, 1000) || null : existing?.notes ?? null;
  f.reason = body.reason !== undefined ? cleanStr(body.reason, 300) || null : existing?.reason ?? null;
  f.external_number = body.external_number !== undefined ? cleanStr(body.external_number, 60) || null : existing?.external_number ?? null;
  if (['credit_note', 'debit_note'].includes(doc_type)) {
    const refId = body.ref_invoice_id !== undefined ? Number(body.ref_invoice_id) || null : existing?.ref_invoice_id ?? null;
    f.ref_invoice_id = refId; f.ref_number = refId ? get('SELECT number FROM invoices WHERE id=?', refId)?.number ?? null : null;
  } else { f.ref_invoice_id = null; f.ref_number = null; }
  const rawLines = body.lines !== undefined ? body.lines : existing?.lines;
  if (!Array.isArray(rawLines)) throw bad('lines must be an array');
  if (rawLines.length > 300) throw bad('An invoice can have at most 300 lines');
  const calc = calcLines(rawLines, jur);
  Object.assign(f, { subtotal: calc.subtotal, discount_total: calc.discount_total, vat_total: calc.vat_total, total: calc.total });
  f.owner_id = existing?.owner_id ?? user?.id ?? null;
  return { f, calc };
}
const issuesFor = (f, calc) => {
  const original = f.ref_invoice_id ? get('SELECT * FROM invoices WHERE id=?', f.ref_invoice_id) : null;
  const dup = f.external_number && f.source === 'import' ? !!get("SELECT 1 FROM invoices WHERE id IS NOT ? AND external_number=? AND status<>'draft'", f.id ?? null, f.external_number) : false;
  return [...validateInvoice({ ...f, total_stored: undefined }, calc, { company: getBilling(), original, duplicateNumber: dup })];
};
const COLS = ['doc_type', 'jurisdiction', 'currency', 'lang', 'account_id', 'contact_id', 'deal_id', ...BUYER_KEYS, 'issue_date', 'supply_date', 'due_date', 'payment_terms', 'notes', 'reason', 'external_number', 'ref_invoice_id', 'ref_number', 'subtotal', 'discount_total', 'vat_total', 'total', 'owner_id'];
function saveDraft(f, calc, user, id = null) {
  return tx(() => {
    if (id) {
      run(`UPDATE invoices SET ${COLS.map((c) => `${c}=?`).join(',')}, updated_at=? WHERE id=? AND status='draft'`, ...COLS.map((c) => f[c] ?? null), nowIso(), id);
      run('DELETE FROM invoice_lines WHERE invoice_id=?', id);
    } else {
      const cols = [...COLS, 'created_by', 'source'];
      id = Number(run(`INSERT INTO invoices (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...COLS.map((c) => f[c] ?? null), user?.id ?? null, f.source || null).lastInsertRowid);
    }
    calc.lines.forEach((l, i) => run('INSERT INTO invoice_lines (invoice_id,position,description,description_ar,qty,unit_price,discount,vat_category,vat_rate,exemption_reason,net,vat,total) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, i, l.description, l.description_ar, l.qty, l.unit_price, l.discount, l.vat_category, l.vat_rate, l.exemption_reason, l.net, l.vat, l.total));
    logEvent(id, id && f._isNew === false ? 'draft_updated' : 'draft_saved', `${calc.lines.length} line(s), total ${calc.total.toFixed(2)} ${f.currency}`, user);
    return id;
  });
}

// ---------------- Invoice list / detail ----------------
const LIST = `SELECT i.id,i.owner_id,i.number,i.doc_type,i.status,i.jurisdiction,i.currency,i.buyer_name,i.account_id,i.issue_date,i.due_date,i.total,i.amount_paid,i.amount_credited,i.compliance_status,i.external_number,i.source,i.ref_number,i.created_at,
  CASE WHEN i.status='draft' OR i.doc_type='credit_note' THEN 0 ELSE MAX(0, ROUND(i.total-i.amount_paid-i.amount_credited,2)) END AS balance,
  CASE WHEN i.status IN ('issued','partially_paid') AND i.doc_type<>'credit_note' AND i.due_date < date('now') THEN CAST(julianday(date('now'))-julianday(i.due_date) AS INTEGER) ELSE 0 END AS days_overdue FROM invoices i`;
GET('/api/invoices', ({ query, user }) => {
  const w = []; const p = [];
  if (scopeOf(user, 'invoices.view') === 'own') { w.push('owner_id = ?'); p.push(user.id); }
  if (query.q) { w.push("(number LIKE ? ESCAPE '\\' OR buyer_name LIKE ? ESCAPE '\\' OR external_number LIKE ? ESCAPE '\\')"); const l = `%${String(query.q).replace(/[\\%_]/g, (m) => '\\' + m)}%`; p.push(l, l, l); }
  if (query.status === 'overdue') w.push('days_overdue > 0'); else if (query.status === 'open') w.push("status IN ('issued','partially_paid') AND balance > 0"); else if (query.status) { w.push('status = ?'); p.push(query.status); }
  if (query.type) { w.push('doc_type = ?'); p.push(query.type); }
  if (query.account_id) { w.push('account_id = ?'); p.push(Number(query.account_id)); }
  if (query.compliance) { w.push('compliance_status = ?'); p.push(query.compliance); }
  const where = w.length ? ' WHERE ' + w.join(' AND ') : '';
  const limit = Math.min(Math.max(parseInt(query.limit || '25', 10) || 25, 1), 500), page = Math.max(parseInt(query.page || '1', 10) || 1, 1);
  const sorts = { number: 'number', issue_date: 'issue_date', due_date: 'due_date', total: 'total', balance: 'balance', buyer_name: 'buyer_name' };
  const order = `${sorts[query.sort] || 'id'} ${query.dir === 'asc' ? 'ASC' : 'DESC'}`;
  const agg = get(`SELECT COUNT(*) n, COALESCE(SUM(total),0) total, COALESCE(SUM(balance),0) balance FROM (${LIST}) x${where}`, ...p);
  return { rows: all(`SELECT * FROM (${LIST}) x${where} ORDER BY ${order}, id DESC LIMIT ? OFFSET ?`, ...p, limit, (page - 1) * limit), total: agg.n, sum_total: round2(agg.total), sum_balance: round2(agg.balance), page, limit };
});

POST('/api/invoices/validate', ({ body, user }) => {
  const existing = body.id ? loadInvoice(Number(body.id)) : null;
  const { f, calc } = buildDraft(body, existing?.status === 'draft' ? existing : null, user);
  return { calc, issues: [...validateSeller(getBilling()).map((i) => ({ ...i, seller: true })), ...issuesFor(f, calc)] };
});

async function detail(id) {
  const inv = loadInvoice(id); if (!inv) throw notFound('Invoice not found');
  const { xml, seller_json, ...pub } = inv;
  const calc = inv.status === 'draft' ? calcLines(inv.lines, inv.jurisdiction) : null;
  return {
    ...pub, has_xml: !!xml, seller: seller_json ? JSON.parse(seller_json) : null,
    payments: all('SELECT * FROM payments WHERE invoice_id=? ORDER BY paid_on, id', id), claims: all('SELECT * FROM payment_claims WHERE invoice_id=? ORDER BY id DESC', id),
    events: all('SELECT * FROM invoice_events WHERE invoice_id=? ORDER BY id', id), reminders: all('SELECT * FROM reminder_log WHERE invoice_id=? ORDER BY id DESC LIMIT 50', id),
    related: all('SELECT id, number, doc_type, total, issue_date, reason FROM invoices WHERE ref_invoice_id=? ORDER BY id', id),
    issues: inv.status === 'draft' ? [...validateSeller(getBilling()).map((i) => ({ ...i, seller: true })), ...issuesFor(inv, calc)] : [],
    portal_url: inv.portal_token ? portalUrl(inv) : null, qr_svg: inv.qr ? await qrSvg(inv.qr) : null,
    provider: { mode: getBilling().asp.mode },
  };
}
GET('/api/invoices/:id', ({ params, user }) => { assertVisible(user, params.id); return detail(params.id); });
GET('/api/invoices/:id/xml', ({ params, res, user }) => {
  assertVisible(user, params.id);
  const inv = get('SELECT number, xml FROM invoices WHERE id=?', params.id); if (!inv?.xml) throw notFound('XML is generated when an invoice is issued.');
  res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Disposition': `attachment; filename="${inv.number}.xml"` }); res.end(inv.xml);
});
GET('/api/invoices/:id/print', async ({ params, query, res, user }) => {
  assertVisible(user, params.id);
  const inv = loadInvoice(params.id); if (!inv) throw notFound('Invoice not found');
  const html = await renderInvoiceHtml(inv, { lang: query.lang, portal: false });
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html);
});

// ---------------- Create / edit / delete drafts ----------------
POST('/api/invoices', ({ body, user }) => {
  const { f, calc } = buildDraft(body, null, user); f._isNew = true;
  const id = saveDraft(f, calc, user); audit(user, 'create', 'invoices', id, `draft ${f.doc_type}`);
  return detail(id);
});
PUT('/api/invoices/:id', ({ params, body, user }) => {
  assertVisible(user, params.id);
  const existing = loadInvoice(params.id); if (!existing) throw notFound('Invoice not found');
  if (!canOnRecord(user, 'invoices.edit', existing.owner_id)) throw forbidden('Your role can only edit invoices you own.');
  if (existing.status !== 'draft') throw forbidden('Issued invoices cannot be edited. Issue a credit or debit note to correct them.');
  const { f, calc } = buildDraft(body, existing, user); f._isNew = false;
  saveDraft(f, calc, user, existing.id); return detail(existing.id);
});
DELETE('/api/invoices/:id', ({ params, user }) => {
  const inv = loadInvoice(params.id); if (!inv) throw notFound('Invoice not found');
  if (inv.status !== 'draft') throw forbidden('Issued invoices cannot be deleted — tax records must be kept. Issue a credit note instead.');
  assertVisible(user, params.id);
  if (!canOnRecord(user, 'invoices.delete', inv.owner_id)) throw forbidden('Your role can only delete invoices you own.');
  run('DELETE FROM invoices WHERE id=?', inv.id); audit(user, 'delete', 'invoices', inv.id, 'draft'); return { ok: true };
});

// ---------------- Issue, submit, payments ----------------
POST('/api/invoices/:id/issue', async ({ params, user }) => {
  assertVisible(user, params.id);
  const r = issueInvoice(Number(params.id), user); audit(user, 'issue', 'invoices', params.id, r.number);
  const inv = loadInvoice(params.id);
  const sub = await submitToProvider(inv, user);
  return { ...(await detail(params.id)), warnings: r.warnings, submission: sub };
});
POST('/api/invoices/:id/submit', async ({ params, user }) => {
  assertVisible(user, params.id);
  const inv = loadInvoice(params.id); if (!inv || inv.status === 'draft') throw bad('Only issued invoices can be submitted.');
  if (['cleared', 'reported'].includes(inv.compliance_status)) throw bad(`Already ${inv.compliance_status}.`);
  const sub = await submitToProvider(inv, user); return { ...(await detail(params.id)), submission: sub };
});

POST('/api/invoices/:id/payments', async ({ params, body, user }) => {
  assertVisible(user, params.id);
  const inv = loadInvoice(params.id); if (!inv) throw notFound('Invoice not found');
  recordPayment(inv, body, user); audit(user, 'payment', 'invoices', inv.id, String(body.amount)); return detail(inv.id);
});
PUT('/api/payments/:id/reconcile', ({ params, body, user }) => {
  const p = get('SELECT * FROM payments WHERE id=?', params.id); if (!p) throw notFound('Payment not found');
  run('UPDATE payments SET reconciled=? WHERE id=?', body.reconciled ? 1 : 0, p.id);
  logEvent(p.invoice_id, body.reconciled ? 'reconciled' : 'unreconciled', `payment of ${p.amount.toFixed(2)} on ${p.paid_on}`, user); return { ok: true };
});

// Customer-notified payments awaiting confirmation
GET('/api/payment-claims', ({ query, user }) => all(`SELECT c.*, i.number, i.buyer_name, i.currency, ROUND(i.total-i.amount_paid-i.amount_credited,2) AS balance FROM payment_claims c JOIN invoices i ON i.id=c.invoice_id WHERE c.status=? AND (? OR i.owner_id=?) ORDER BY c.id DESC LIMIT 200`, query.status || 'pending', scopeOf(user, 'invoices.view') === 'own' ? 0 : 1, user.id));
POST('/api/payment-claims/:id/confirm', ({ params, user }) => {
  const c = get("SELECT * FROM payment_claims WHERE id=? AND status='pending'", params.id); if (!c) throw notFound('Claim not found or already handled');
  const inv = loadInvoice(c.invoice_id);
  recordPayment(inv, { amount: Math.min(c.amount, inv.balance), paid_on: c.paid_on && c.paid_on <= today() ? c.paid_on : today(), method: 'bank_transfer', reference: c.reference, note: `Confirmed customer notice${c.payer_name ? ` from ${c.payer_name}` : ''}` }, user);
  run("UPDATE payment_claims SET status='confirmed', resolved_by_name=?, resolved_at=? WHERE id=?", user.name, nowIso(), c.id); return { ok: true };
});
POST('/api/payment-claims/:id/reject', ({ params, user }) => {
  const c = get("SELECT * FROM payment_claims WHERE id=? AND status='pending'", params.id); if (!c) throw notFound('Claim not found or already handled');
  run("UPDATE payment_claims SET status='rejected', resolved_by_name=?, resolved_at=? WHERE id=?", user.name, nowIso(), c.id); logEvent(c.invoice_id, 'claim_rejected', `claimed ${c.amount.toFixed(2)} — not found in bank`, user); return { ok: true };
});

// ---------------- Credit / debit notes (corrections) ----------------
function noteDraft(kind, orig, body, user) {
  if (orig.status === 'draft') throw bad('Issue the invoice before creating a note against it.');
  if (['credit_note'].includes(orig.doc_type)) throw bad('Create notes against the original invoice, not against a credit note.');
  const reason = cleanStr(body.reason, 300); if (!reason) throw bad('A reason is required (it is printed on the note and sent to the tax authority).');
  let lines = Array.isArray(body.lines) && body.lines.length ? body.lines : (kind === 'credit_note' ? orig.lines.map((l) => ({ description: l.description, description_ar: l.description_ar, qty: l.qty, unit_price: l.unit_price, discount: l.discount, vat_category: l.vat_category, vat_rate: l.vat_rate, exemption_reason: l.exemption_reason })) : [{ description: '', qty: 1, unit_price: 0, vat_category: 'S' }]);
  const payload = { doc_type: kind, ref_invoice_id: orig.id, reason, account_id: orig.account_id, contact_id: orig.contact_id, lines, currency: orig.currency, jurisdiction: orig.jurisdiction, lang: orig.lang, due_date: null, issue_date: today() };
  const { f, calc } = buildDraft(payload, null, user);
  for (const k of [...BUYER_KEYS]) f[k] = orig[k]; // keep the exact buyer details of the original
  f._isNew = true; return saveDraft(f, calc, user);
}
POST('/api/invoices/:id/credit-note', async ({ params, body, user }) => { assertVisible(user, params.id); const o = loadInvoice(params.id); if (!o) throw notFound('Invoice not found'); const id = noteDraft('credit_note', o, body, user); logEvent(o.id, 'credit_note_drafted', body.reason, user); return detail(id); });
POST('/api/invoices/:id/debit-note', async ({ params, body, user }) => { assertVisible(user, params.id); const o = loadInvoice(params.id); if (!o) throw notFound('Invoice not found'); const id = noteDraft('debit_note', o, body, user); logEvent(o.id, 'debit_note_drafted', body.reason, user); return detail(id); });

// ---------------- Reminders ----------------
POST('/api/invoices/:id/remind', async ({ params, body, user }) => {
  assertVisible(user, params.id);
  const inv = loadInvoice(params.id); if (!inv) throw notFound('Invoice not found');
  if (!['issued', 'partially_paid'].includes(inv.status) || inv.balance <= 0) throw bad('Reminders can only be sent for invoices with an outstanding balance.');
  if (!['email', 'whatsapp', 'sms'].includes(body.channel)) throw bad('Choose email, whatsapp or sms');
  return sendReminder(inv, body.channel, { kind: 'manual', user });
});
POST('/api/reminders/run', async ({ user }) => { const r = await runReminders({ force: true }); audit(user, 'run_reminders', 'invoices', null, JSON.stringify(r)); return r; });

// ---------------- Analytics ----------------
GET('/api/receivables', () => receivablesSummary());
GET('/api/readiness', () => readinessReport());

// ---------------- Import from other accounting systems (Zoho Books, QuickBooks, Xero, local) ----------------
function parseAnyDate(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const s = String(v).trim();
  if (DATE.test(s)) return s;
  if (/^\d{5}$/.test(s)) return new Date(Math.round((Number(s) - 25569) * 86400000)).toISOString().slice(0, 10); // Excel serial
  const m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/); // day-first, as is usual in the region
  if (m) { let [, d, mo, y] = m; if (+mo > 12 && +d <= 12) [d, mo] = [mo, d]; if (y.length === 2) y = `20${y}`; const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`; return Number.isNaN(Date.parse(iso)) ? null : iso; }
  const t = Date.parse(s); return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}
POST('/api/invoices/import', ({ body, user }) => {
  const rows = Array.isArray(body.rows) ? body.rows : null; if (!rows) throw bad('rows array required');
  if (rows.length > 5000) throw bad('Import is limited to 5,000 rows at a time');
  const co = getBilling(); const jur = ['KSA', 'UAE'].includes(body.jurisdiction) ? body.jurisdiction : co.jurisdiction;
  const groups = new Map();
  rows.forEach((r, i) => { const key = cleanStr(r.invoice_number, 60) || `${cleanStr(r.customer, 100)}|${cleanStr(r.issue_date, 20)}|auto`; if (!groups.has(key)) groups.set(key, { number: cleanStr(r.invoice_number, 60) || null, rows: [], first: i + 2 }); groups.get(key).rows.push(r); });
  const res = { invoices: 0, skipped_duplicates: 0, accounts_created: 0, with_errors: 0, with_warnings: 0, clean: 0, results: [] };
  for (const g of groups.values()) {
    const h = g.rows[0];
    try {
      if (g.number && get('SELECT 1 FROM invoices WHERE external_number=?', g.number)) { res.skipped_duplicates++; res.results.push({ number: g.number, skipped: 'already imported', errors: 0, warnings: 0 }); continue; }
      const vat = cleanStr(h.customer_vat, 30).replace(/\s/g, ''); const name = cleanStr(h.customer, 200);
      let acc = (vat && get('SELECT * FROM accounts WHERE vat_number=?', vat)) || (name && get('SELECT * FROM accounts WHERE name=? COLLATE NOCASE', name)) || null;
      if (!acc && name) { const id = Number(run('INSERT INTO accounts (name, vat_number, billing_email, billing_phone, street, city, postal_code, owner_id) VALUES (?,?,?,?,?,?,?,?)', name, vat || null, cleanStr(h.customer_email, 120) || null, cleanStr(h.customer_phone, 40) || null, cleanStr(h.customer_street, 200) || null, cleanStr(h.customer_city, 100) || null, cleanStr(h.customer_postal, 10) || null, user.id).lastInsertRowid); acc = get('SELECT * FROM accounts WHERE id=?', id); res.accounts_created++; }
      const lines = g.rows.map((r) => { const rate = r.vat_rate === '' || r.vat_rate === undefined ? undefined : Number(String(r.vat_rate).replace('%', '')); return { description: r.description, qty: r.qty === '' || r.qty === undefined ? 1 : Number(r.qty), unit_price: Number(r.unit_price || 0), discount: Number(r.discount || 0), vat_category: rate === 0 ? 'Z' : 'S', vat_rate: Number.isFinite(rate) ? rate : undefined }; });
      const issue = parseAnyDate(h.issue_date) || today();
      const payload = { doc_type: vat ? 'standard' : 'simplified', account_id: acc?.id, lines, jurisdiction: jur, currency: cleanStr(h.currency, 3).toUpperCase() || (jur === 'UAE' ? 'AED' : co.currency), issue_date: issue, supply_date: issue, due_date: parseAnyDate(h.due_date) || addDays(issue, co.payment_terms_days), external_number: g.number, buyer_name: name || undefined, buyer_vat: vat || undefined };
      const { f, calc } = buildDraft(payload, null, user); f.source = 'import'; f._isNew = true;
      if (!acc) for (const k of BUYER_KEYS) f[k] = f[k] ?? null;
      const id = saveDraft(f, calc, user); logEvent(id, 'imported', `from external invoice ${g.number || '(no number)'}`, user);
      const issues = issuesFor({ ...f, id }, calc); const e = issues.filter((x) => x.severity === 'error').length, w = issues.filter((x) => x.severity === 'warning').length;
      res.invoices++; if (e) res.with_errors++; else if (w) res.with_warnings++; else res.clean++;
      res.results.push({ id, number: g.number || `Draft #${id}`, customer: name, errors: e, warnings: w, top: issues.filter((x) => x.severity === 'error').slice(0, 3).map((x) => x.message) });
    } catch (e) { res.results.push({ number: g.number || `row ${g.first}`, failed: e.message, errors: 1, warnings: 0 }); res.with_errors++; }
  }
  audit(user, 'import', 'invoices', null, `${res.invoices} drafts`); return res;
});

// ================= Public customer payment portal =================
const claimHits = new Map();
const page404 = '<!doctype html><meta charset="utf-8"><title>Not found</title><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Invoice not found</h2><p>This link is invalid or has expired.</p></body>';
export async function portalGet(token, query) {
  const inv = /^[\w-]{20,40}$/.test(token) ? get("SELECT id FROM invoices WHERE portal_token=? AND status<>'draft'", token) : null;
  if (!inv) return { status: 404, html: page404 };
  return { status: 200, html: await renderInvoiceHtml(loadInvoice(inv.id), { lang: query.get('lang'), portal: true, claimed: query.get('claimed') === '1', claimError: query.get('error') || '' }) };
}
export function portalClaim(token, form, ip) {
  const row = /^[\w-]{20,40}$/.test(token) ? get("SELECT id FROM invoices WHERE portal_token=? AND status<>'draft'", token) : null; if (!row) return { status: 404 };
  const hits = (claimHits.get(ip) || []).filter((t) => Date.now() - t < 3600000); if (hits.length >= 10) return { redirect: `/pay/${token}?error=${encodeURIComponent('Too many notices from your network. Please try again later.')}` };
  const inv = loadInvoice(row.id); const amount = round2(form.get('amount')); const paid = (form.get('paid_on') || '').slice(0, 10);
  const fail = (m) => ({ redirect: `/pay/${token}?error=${encodeURIComponent(m)}` });
  if (inv.balance <= 0) return fail('This invoice has no outstanding balance.');
  if (!(amount > 0) || amount > inv.balance + 0.005) return fail(`Enter an amount between 0.01 and ${inv.balance.toFixed(2)}.`);
  if (paid && (!DATE.test(paid) || paid > today())) return fail('Payment date must be a valid date that is not in the future.');
  if (get("SELECT COUNT(*) n FROM payment_claims WHERE invoice_id=? AND status='pending'", inv.id).n >= 5) return fail('We already have several pending notices for this invoice. We will confirm them shortly.');
  hits.push(Date.now()); claimHits.set(ip, hits);
  run('INSERT INTO payment_claims (invoice_id,amount,paid_on,reference,payer_name) VALUES (?,?,?,?,?)', inv.id, amount, paid || null, cleanStr(form.get('reference'), 100) || null, cleanStr(form.get('payer'), 100) || null);
  logEvent(inv.id, 'payment_claim', `Customer notified a payment of ${amount.toFixed(2)} ${inv.currency}${form.get('reference') ? ` (ref ${cleanStr(form.get('reference'), 60)})` : ''} — awaiting confirmation`, null);
  return { redirect: `/pay/${token}?claimed=1` };
}
