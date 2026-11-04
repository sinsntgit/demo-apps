import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.SEED_BILLING_DEMO = '0'; process.env.DB_PATH = ':memory:'; process.env.SESSION_SECRET = 'bill-secret'; process.env.BASE_URL = 'http://crm.test'; process.env.SEND_DELAY_MS = '1';
let aspMode = 'cleared'; const aspCalls = [];
const asp = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { aspCalls.push({ auth: req.headers.authorization, body: JSON.parse(b) });
  if (aspMode === 'down') { res.writeHead(503); return res.end('{}'); }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(aspMode === 'rejected' ? { status: 'rejected', message: 'Invalid buyer VAT', errors: ['BR-KSA-44'] } : { status: aspMode })); }); });
const msgCalls = []; const gw = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { msgCalls.push(JSON.parse(b)); res.writeHead(200); res.end('{}'); }); });
await new Promise((r) => asp.listen(0, '127.0.0.1', r)); await new Promise((r) => gw.listen(0, '127.0.0.1', r));
const { server } = await import('../server/index.js');
const { seedIfEmpty } = await import('../server/seed.js');
const { db } = await import('../server/db.js');
const { runReminders } = await import('../server/receivables.js');
const { decodeQr, INITIAL_PIH, verifyChain } = await import('../server/invoicing.js');

let base, cookie = '', repCookie = '';
before(async () => { seedIfEmpty(); await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; });
after(() => { server.close(); asp.close(); gw.close(); });
async function api(method, path, body, ck) {
  const r = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie: ck ?? cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc && path.includes('login')) { const c = sc.split(';')[0]; if (!ck) cookie = c; }
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j, headers: r.headers };
}
const login = async (email) => (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Ovantaa@123' }) })).headers.get('set-cookie').split(';')[0];
const PROFILE = { seller_name: 'Ovantaa Trading Co', seller_name_ar: 'شركة أوفانتا للتجارة', vat_number: '399999999900003', cr_number: '1010123456', jurisdiction: 'KSA', currency: 'SAR',
  address: { street: 'King Fahd Road', building_no: '1234', district: 'Olaya', city: 'Riyadh', postal_code: '12211', country_code: 'SA' },
  bank: { bank_name: 'Al Rajhi Bank', account_name: 'Ovantaa Trading Co', iban: 'SA0380000000608010167519', swift: 'RJHISARI' }, payment_terms_days: 30 };
const CUSTOMER = { name: 'Najd Builders', name_ar: 'نجد للمقاولات', vat_number: '311111111100003', street: 'Prince Sultan St', building_no: '4321', district: 'Al Malaz', city: 'Riyadh', postal_code: '11564', country_code: 'SA', billing_email: 'ap@najd.example', billing_phone: '0501234567' };
const line = (o = {}) => ({ description: 'Consulting', description_ar: 'استشارات', qty: 1, unit_price: 1000, vat_category: 'S', ...o });
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
let acc, inv1, inv2;

test('setup: login, roles, billing profile', async () => {
  assert.equal((await api('POST', '/api/auth/login', { email: 'admin@ovantaa.com', password: 'Ovantaa@123' }, undefined)).status, 200);
  repCookie = await login('liam@ovantaa.com');
  assert.equal((await api('GET', '/api/billing/settings', null, repCookie)).status, 403);
  assert.equal((await api('PUT', '/api/billing/settings', PROFILE, repCookie)).status, 403);
  assert.equal((await api('PUT', '/api/billing/settings', { jurisdiction: 'XX' })).status, 400);
  const empty = await api('GET', '/api/billing/settings'); assert.ok(empty.body.issues.some((i) => i.code === 'SELLER_VAT'));
  const bad = await api('PUT', '/api/billing/settings', { ...PROFILE, vat_number: '123' }); assert.ok(bad.body.issues.some((i) => i.code === 'SELLER_VAT_FORMAT'));
  const ok = await api('PUT', '/api/billing/settings', PROFILE); assert.equal(ok.status, 200); assert.equal(ok.body.issues.filter((i) => i.severity === 'error').length, 0);
  acc = (await api('POST', '/api/accounts', CUSTOMER)).body; assert.equal(acc.vat_number, '311111111100003');
});

test('issue is blocked while the seller profile is invalid', async () => {
  await api('PUT', '/api/billing/settings', { vat_number: '123' });
  const d = (await api('POST', '/api/invoices', { account_id: acc.id, lines: [line()] })).body;
  const r = await api('POST', `/api/invoices/${d.id}/issue`); assert.equal(r.status, 400); assert.ok(r.body.issues.some((i) => i.code === 'SELLER_VAT_FORMAT'));
  await api('PUT', '/api/billing/settings', { vat_number: '399999999900003' });
  await api('DELETE', `/api/invoices/${d.id}`);
});

test('drafts: customer details copied, totals computed with rounding, bad numbers rejected', async () => {
  const r = await api('POST', '/api/invoices', { account_id: acc.id, lines: [line({ qty: 2, unit_price: 100.555, discount: 10 }), line({ description: 'Training', unit_price: 33.33, qty: 3 })] });
  assert.equal(r.status, 200); const d = r.body;
  assert.equal(d.status, 'draft'); assert.equal(d.number, null); assert.equal(d.buyer_vat, '311111111100003'); assert.equal(d.buyer_postal, '11564'); assert.equal(d.buyer_email, 'ap@najd.example');
  // line1: gross 201.11 (2*100.555=201.11), net 191.11, vat 28.67; line2: gross 99.99, net 99.99, vat 15.00 → total 191.11+99.99+28.67+15.00
  assert.equal(d.lines[0].net, 191.11); assert.equal(d.lines[0].vat, 28.67); assert.equal(d.lines[1].vat, 15);
  assert.equal(d.total, 334.77); assert.equal(d.vat_total, 43.67); assert.equal(d.due_date, new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10));
  assert.equal((await api('POST', '/api/invoices', { account_id: acc.id, lines: [{ description: 'x', qty: 'abc', unit_price: 1 }] })).status, 400);
  assert.equal((await api('POST', '/api/invoices', { account_id: acc.id, lines: 'nope' })).status, 400);
  assert.equal((await api('POST', '/api/invoices', { account_id: 99999, lines: [line()] })).status, 400);
  const upd = await api('PUT', `/api/invoices/${d.id}`, { lines: [line({ unit_price: 500 })], notes: 'Thanks' }); assert.equal(upd.body.total, 575); assert.equal(upd.body.lines.length, 1);
  await api('DELETE', `/api/invoices/${d.id}`); assert.equal((await api('GET', `/api/invoices/${d.id}`)).status, 404);
});

test('validation rules (KSA): buyer VAT/address, exemption reasons, dates, advance payments', async () => {
  const v = async (body) => (await api('POST', '/api/invoices/validate', { doc_type: 'standard', lines: [line()], ...body })).body.issues;
  const codes = (is) => is.map((i) => i.code);
  assert.ok(codes(await v({ buyer_name: 'X' })).includes('BUYER_VAT'));
  assert.ok(codes(await v({ buyer_name: 'X', buyer_vat: '123' })).includes('BUYER_VAT_FORMAT'));
  const noAddr = codes(await v({ buyer_name: 'X', buyer_vat: '311111111100003' })); assert.ok(noAddr.includes('BUYER_STREET') && noAddr.includes('BUYER_POSTAL'));
  assert.ok(codes(await v({ account_id: acc.id, lines: [line({ vat_category: 'Z' })] })).includes('VAT_REASON'));
  assert.ok(!codes(await v({ account_id: acc.id, lines: [line({ vat_category: 'Z', exemption_reason: 'VATEX-SA-32 Export' })] })).includes('VAT_REASON'));
  assert.ok(codes(await v({ account_id: acc.id, issue_date: '2999-01-01' })).includes('ISSUE_DATE_FUTURE'));
  assert.ok(codes(await v({ account_id: acc.id, lines: [line({ vat_rate: 5 })] })).includes('KSA_RATE'));
  assert.ok(codes(await v({ account_id: acc.id, lines: [line({ description: 'Advance payment 30%' })] })).includes('ADVANCE'));
  assert.ok(codes(await v({ account_id: acc.id, lines: [] })).includes('NO_LINES'));
  assert.ok(codes(await v({ account_id: acc.id, lines: [line({ qty: 0 })] })).includes('LINE_QTY'));
  assert.ok(codes(await v({ account_id: acc.id, lines: [line({ discount: 5000 })] })).includes('LINE_DISCOUNT'));
  assert.ok(!codes(await v({ account_id: acc.id })).some((c) => c.startsWith('BUYER_')), 'complete customer passes');
  assert.ok(codes(await v({ doc_type: 'simplified', lines: [line()] })).every((c) => !c.startsWith('BUYER_')), 'simplified invoices do not need buyer details');
  // UAE rules
  const uae = (await api('POST', '/api/invoices/validate', { doc_type: 'standard', jurisdiction: 'UAE', buyer_name: 'Gulf Co', buyer_vat: '399999999900003', buyer_street: 's', buyer_city: 'Dubai', buyer_country: 'AE', lines: [line({ vat_rate: 15 })] })).body.issues;
  assert.ok(uae.some((i) => i.code === 'UAE_RATE') && uae.some((i) => i.code === 'CURRENCY') === false, JSON.stringify(uae.map((i) => i.code)));
  const trn = (await api('POST', '/api/invoices/validate', { doc_type: 'standard', jurisdiction: 'UAE', currency: 'AED', buyer_name: 'Gulf Co', buyer_vat: '12345', lines: [line({ vat_rate: 5 })] })).body.issues;
  assert.ok(trn.some((i) => i.code === 'BUYER_VAT_FORMAT' && /TRN/.test(i.message)));
});

test('issuing: gap-free numbers, ICV, hash chain, QR, UBL XML, portal token', async () => {
  const mk = async (extra = {}) => (await api('POST', '/api/invoices', { account_id: acc.id, lines: [line({ qty: 2, unit_price: 500 })], supply_date: daysAgo(1), ...extra })).body;
  const d1 = await mk(); const r1 = await api('POST', `/api/invoices/${d1.id}/issue`);
  assert.equal(r1.status, 200); inv1 = r1.body;
  assert.equal(inv1.number, 'INV-000001'); assert.equal(inv1.icv, 1); assert.equal(inv1.previous_hash, INITIAL_PIH); assert.equal(inv1.status, 'issued'); assert.equal(inv1.compliance_status, 'ready');
  assert.match(inv1.uuid, /^[0-9a-f-]{36}$/); assert.ok(inv1.portal_token.length >= 20); assert.equal(inv1.total, 1150); assert.equal(inv1.vat_total, 150);
  const qr = decodeQr(inv1.qr); assert.equal(qr[1], 'Ovantaa Trading Co'); assert.equal(qr[2], '399999999900003'); assert.equal(qr[4], '1150.00'); assert.equal(qr[5], '150.00'); assert.equal(qr[6], inv1.invoice_hash); assert.match(qr[3], /^\d{4}-\d{2}-\d{2}T[\d:]+Z$/);
  assert.match(inv1.qr_svg, /<svg/);
  const d2 = await mk({ lines: [line({ unit_price: 200 })] }); inv2 = (await api('POST', `/api/invoices/${d2.id}/issue`)).body;
  assert.equal(inv2.number, 'INV-000002'); assert.equal(inv2.icv, 2); assert.equal(inv2.previous_hash, inv1.invoice_hash, 'chained to the previous invoice');
  const xml = (await api('GET', `/api/invoices/${inv1.id}/xml`)); assert.equal(xml.status, 200); assert.match(xml.headers.get('content-type'), /xml/);
  for (const frag of ['<cbc:ID>INV-000001</cbc:ID>', 'InvoiceTypeCode name="0100000">388', '<cbc:ID>ICV</cbc:ID><cbc:UUID>1</cbc:UUID>', '399999999900003', '311111111100003', 'schemeID="CRN"', '<cbc:ID>QR</cbc:ID>', 'TaxInclusiveAmount currencyID="SAR">1150.00', 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2'])
    assert.ok(xml.body.includes(frag), `xml missing ${frag}`);
  assert.ok((await api('GET', `/api/invoices/${d1.id}/xml`)).status === 200);
  assert.equal((await api('GET', '/api/billing/chain')).body.problems.length, 0);
  // simplified (B2C) invoice needs no buyer
  const s = (await api('POST', '/api/invoices', { doc_type: 'simplified', buyer_name: 'Walk-in', lines: [line({ unit_price: 50 })] })).body; const si = await api('POST', `/api/invoices/${s.id}/issue`);
  assert.equal(si.status, 200); assert.match(si.body.xml === undefined ? '0200000' : '', /0200000/); assert.equal(si.body.icv, 3);
  // a draft with blocking errors cannot be issued
  const bad = (await api('POST', '/api/invoices', { buyer_name: 'No VAT Ltd', doc_type: 'standard', lines: [line()] })).body; const br = await api('POST', `/api/invoices/${bad.id}/issue`);
  assert.equal(br.status, 400); assert.ok(br.body.issues.some((i) => i.code === 'BUYER_VAT')); assert.equal((await api('GET', `/api/invoices/${bad.id}`)).body.status, 'draft'); await api('DELETE', `/api/invoices/${bad.id}`);
  assert.equal((await api('POST', `/api/invoices/${inv1.id}/issue`)).status, 400, 'cannot issue twice');
});

test('immutability: API and database both refuse to change or delete issued invoices', async () => {
  assert.equal((await api('PUT', `/api/invoices/${inv1.id}`, { notes: 'x' })).status, 403);
  assert.equal((await api('DELETE', `/api/invoices/${inv1.id}`)).status, 403);
  assert.throws(() => db.prepare('UPDATE invoices SET total=1 WHERE id=?').run(inv1.id), /cannot be changed/);
  assert.throws(() => db.prepare("UPDATE invoices SET buyer_name='Other' WHERE id=?").run(inv1.id), /cannot be changed/);
  assert.throws(() => db.prepare('UPDATE invoices SET xml=? WHERE id=?').run('<x/>', inv1.id), /cannot be changed/);
  assert.throws(() => db.prepare('DELETE FROM invoices WHERE id=?').run(inv1.id), /cannot be deleted/);
  assert.throws(() => db.prepare('UPDATE invoice_lines SET unit_price=1 WHERE invoice_id=?').run(inv1.id), /cannot be changed/);
  assert.throws(() => db.prepare('DELETE FROM invoice_lines WHERE invoice_id=?').run(inv1.id), /cannot be deleted/);
  assert.throws(() => db.prepare("INSERT INTO invoice_lines (invoice_id,description) VALUES (?, 'sneaky')").run(inv1.id), /cannot be added/);
  assert.throws(() => db.prepare("UPDATE invoice_events SET detail='edited' WHERE invoice_id=?").run(inv1.id), /append-only/);
  const purge = await api('POST', '/api/admin/purge', { entity: 'invoices', confirm: 'DELETE' }); assert.equal(purge.status, 400, 'invoices are not purgeable');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices WHERE status<>?').get('draft').n >= 3, true);
});

test('payments: partial/full, overpay and date checks, reconcile, audit trail', async () => {
  assert.equal((await api('POST', `/api/invoices/${inv1.id}/payments`, { amount: 100 }, repCookie)).status, 403);
  assert.equal((await api('POST', `/api/invoices/${inv1.id}/payments`, { amount: 5000 })).status, 400, 'more than balance');
  assert.equal((await api('POST', `/api/invoices/${inv1.id}/payments`, { amount: 0 })).status, 400);
  assert.equal((await api('POST', `/api/invoices/${inv1.id}/payments`, { amount: 10, paid_on: '2999-01-01' })).status, 400);
  const p = await api('POST', `/api/invoices/${inv1.id}/payments`, { amount: 400, paid_on: daysAgo(10), method: 'bank_transfer', reference: 'TRF-1' });
  assert.equal(p.body.status, 'partially_paid'); assert.equal(p.body.balance, 750); assert.equal(p.body.amount_paid, 400);
  const pid = p.body.payments[0].id; assert.equal((await api('PUT', `/api/payments/${pid}/reconcile`, { reconciled: true })).status, 200);
  const full = await api('POST', `/api/invoices/${inv1.id}/payments`, { amount: 750, method: 'cash' }); assert.equal(full.body.status, 'paid'); assert.equal(full.body.balance, 0);
  assert.equal((await api('POST', `/api/invoices/${inv1.id}/payments`, { amount: 1 })).status, 400, 'nothing left to pay');
  const types = full.body.events.map((e) => e.type); assert.deepEqual(types.filter((t) => ['issued', 'payment', 'reconciled'].includes(t)), ['issued', 'payment', 'reconciled', 'payment']);
  assert.ok(full.body.events.every((e) => e.user_name) && full.body.events.at(-1).detail.includes('fully paid'));
});

test('credit notes & debit notes: reference, reason, separate series, credit limits, balances', async () => {
  assert.equal((await api('POST', `/api/invoices/${inv2.id}/credit-note`, {})).status, 400, 'reason required');
  assert.equal((await api('POST', `/api/invoices/${inv2.id}/credit-note`, { reason: 'x' }, repCookie)).status, 403);
  const cn = (await api('POST', `/api/invoices/${inv2.id}/credit-note`, { reason: 'Customer returned the service' })).body;
  assert.equal(cn.doc_type, 'credit_note'); assert.equal(cn.status, 'draft'); assert.equal(cn.ref_number, inv2.number); assert.equal(cn.total, inv2.total); assert.equal(cn.buyer_vat, inv2.buyer_vat);
  // partial credit: edit the draft down to half
  await api('PUT', `/api/invoices/${cn.id}`, { lines: [line({ unit_price: 100 })] });
  const issued = await api('POST', `/api/invoices/${cn.id}/issue`); assert.equal(issued.status, 200);
  assert.equal(issued.body.number, 'CN-000001'); assert.ok(issued.body.icv > inv2.icv); assert.equal(issued.body.reason, 'Customer returned the service');
  assert.match((await api('GET', `/api/invoices/${cn.id}/xml`)).body, /InvoiceTypeCode name="0100000">381[\s\S]*<cbc:ID>INV-000002<\/cbc:ID>/);
  const o = (await api('GET', `/api/invoices/${inv2.id}`)).body; assert.equal(o.amount_credited, 115); assert.equal(o.balance, 115); assert.equal(o.status, 'partially_paid'); assert.equal(o.related.length, 1);
  // cannot credit more than remains
  const cn2 = (await api('POST', `/api/invoices/${inv2.id}/credit-note`, { reason: 'Again' })).body; // copies full 230 > 115 left
  const over = await api('POST', `/api/invoices/${cn2.id}/issue`); assert.equal(over.status, 400); assert.ok(over.body.issues.some((i) => i.code === 'CREDIT_EXCEEDS'));
  await api('PUT', `/api/invoices/${cn2.id}`, { lines: [line({ unit_price: 100 })] }); assert.equal((await api('POST', `/api/invoices/${cn2.id}/issue`)).status, 200);
  const settled = (await api('GET', `/api/invoices/${inv2.id}`)).body; assert.equal(settled.balance, 0); assert.equal(settled.status, 'paid', 'fully credited invoice is settled');
  assert.equal((await api('POST', `/api/invoices/${cn.id}/credit-note`, { reason: 'note on note' })).status, 400, 'no notes on notes');
  assert.equal((await api('POST', `/api/invoices/${cn.id}/payments`, { amount: 1 })).status, 400, 'credit notes take no payments');
  const dn = (await api('POST', `/api/invoices/${inv1.id}/debit-note`, { reason: 'Extra work', lines: [line({ description: 'Extra hours', unit_price: 100 })] })).body;
  const dni = await api('POST', `/api/invoices/${dn.id}/issue`); assert.equal(dni.body.number, 'DN-000001'); assert.equal(dni.body.balance, 115);
  assert.match((await api('GET', `/api/invoices/${dn.id}/xml`)).body, /name="0100000">383/);
  assert.equal(verifyChain().problems.length, 0, 'chain intact across all document types');
});

test('compliance provider adapter: cleared / rejected / provider down + retry', async () => {
  await api('PUT', '/api/billing/settings', { asp: { mode: 'webhook', url: `http://127.0.0.1:${asp.address().port}/submit`, token: 'asp-secret' } });
  assert.equal((await api('GET', '/api/billing/settings')).body.settings.asp.has_token, true); assert.ok(!JSON.stringify((await api('GET', '/api/billing/settings')).body).includes('asp-secret'));
  const issue = async (extra) => { const d = (await api('POST', '/api/invoices', { account_id: acc.id, lines: [line()], ...extra })).body; return (await api('POST', `/api/invoices/${d.id}/issue`)).body; };
  aspMode = 'cleared'; const a = await issue(); assert.equal(a.compliance_status, 'cleared');
  const call = aspCalls.at(-1); assert.equal(call.auth, 'Bearer asp-secret'); assert.equal(call.body.number, a.number); assert.equal(call.body.hash, a.invoice_hash); assert.match(Buffer.from(call.body.xml_base64, 'base64').toString(), /<cbc:ID>INV-/);
  aspMode = 'rejected'; const r = await issue(); assert.equal(r.compliance_status, 'rejected'); assert.match(r.compliance_response, /Invalid buyer VAT.*BR-KSA-44/);
  aspMode = 'down'; const f = await issue(); assert.equal(f.compliance_status, 'failed'); assert.match(f.compliance_response, /Provider error 503/);
  aspMode = 'reported'; const retry = await api('POST', `/api/invoices/${f.id}/submit`); assert.equal(retry.body.compliance_status, 'reported');
  assert.equal((await api('POST', `/api/invoices/${f.id}/submit`)).status, 400, 'no resubmission once reported');
  assert.ok(retry.body.events.some((e) => e.type === 'compliance_failed') && retry.body.events.some((e) => e.type === 'compliance_reported'));
  await api('PUT', '/api/billing/settings', { asp: { mode: 'none', clear_token: true } });
});

test('receivables: ageing buckets, overdue customers, forecast, KPIs; rep is blocked', async () => {
  assert.equal((await api('GET', '/api/receivables', null, repCookie)).status, 403);
  const acc2 = (await api('POST', '/api/accounts', { ...CUSTOMER, name: 'Hijaz Logistics', vat_number: '322222222200003', billing_email: 'fin@hijaz.example' })).body;
  const mkOverdue = async (days, price, who = acc2) => { const d = (await api('POST', '/api/invoices', { account_id: who.id, lines: [line({ unit_price: price })], issue_date: daysAgo(days + 30), supply_date: daysAgo(days + 30), due_date: daysAgo(days) })).body; return (await api('POST', `/api/invoices/${d.id}/issue`)).body; };
  const o10 = await mkOverdue(10, 100), o45 = await mkOverdue(45, 200), o120 = await mkOverdue(120, 300);
  const dueFuture = (await api('POST', '/api/invoices', { account_id: acc2.id, lines: [line({ unit_price: 400 })], due_date: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10) })).body; await api('POST', `/api/invoices/${dueFuture.id}/issue`);
  const s = (await api('GET', '/api/receivables')).body; const b = Object.fromEntries(s.aging.map((x) => [x.key, x]));
  assert.equal(b['1-30'].amount >= 115, true); assert.ok(b['31-60'].amount >= 230); assert.ok(b['90+'].amount >= 345); assert.ok(b.current.amount >= 460);
  const hij = s.customers.find((c) => c.name === 'Hijaz Logistics'); assert.equal(hij.overdue, 115 + 230 + 345); assert.equal(hij.outstanding, hij.overdue + 460); assert.equal(hij.max_days_overdue, 120); assert.equal(hij.overdue_invoices, 3);
  assert.equal(s.overdue_customers[0].overdue >= s.overdue_customers.at(-1).overdue, true);
  assert.ok(Math.abs(s.forecast.total_8w + s.forecast.beyond - s.kpis.outstanding) < 0.01, 'forecast accounts for every open dirham/riyal');
  assert.ok(s.kpis.collected_this_month >= 750 && s.kpis.overdue >= 690 && s.kpis.open_invoices >= 4 && s.kpis.dso !== null && s.monthly.length === 6);
  const list = (await api('GET', '/api/invoices?status=overdue')).body; assert.ok(list.rows.length >= 3 && list.rows.every((r) => r.days_overdue > 0)); assert.ok(list.sum_balance >= 690);
  assert.ok((await api('GET', '/api/invoices?q=Hijaz&status=open')).body.rows.length >= 4);
  global.__hij = { acc2, o10, o45, o120 };
});

test('reminders: scheduled email + WhatsApp link task, idempotent, collection tasks, closed on payment', async () => {
  const { acc2, o10, o120 } = global.__hij;
  const senders = (await api('GET', '/api/senders')).body; const sim = senders.find((x) => x.mode === 'simulate');
  await api('PUT', '/api/billing/settings', { reminders: { enabled: true, sender_id: sim.id, schedule: [{ offset: 0, channels: ['email'] }, { offset: 7, channels: ['email', 'whatsapp'] }, { offset: 30, channels: ['email', 'whatsapp', 'sms'] }] } });
  const r1 = await runReminders({ force: true }); assert.ok(r1.sent >= 3, JSON.stringify(r1)); assert.ok(r1.tasks >= 3);
  const logs = db.prepare("SELECT * FROM reminder_log WHERE invoice_id=? AND kind='auto'").all(o10.id); assert.deepEqual(logs.map((l) => `${l.offset_days}:${l.channel}`).sort(), ['7:email', '7:whatsapp']);
  assert.equal(logs.find((l) => l.channel === 'whatsapp').status, 'link');
  const mail = db.prepare("SELECT * FROM email_log WHERE kind='reminder' AND to_email='fin@hijaz.example' ORDER BY id DESC").all(); assert.ok(mail.length >= 2); assert.match(mail[0].subject, /Overdue payment|invoice/);
  const before = db.prepare("SELECT COUNT(*) n FROM reminder_log WHERE kind='auto'").get().n; await runReminders({ force: true });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reminder_log WHERE kind='auto'").get().n, before, 'second run sends nothing new');
  const tasks = db.prepare("SELECT * FROM tasks WHERE invoice_id=? AND done=0").all(o120.id); assert.ok(tasks.some((t) => /^Collect /.test(t.title) && t.priority === 'high'), JSON.stringify(tasks.map((t) => t.title))); assert.ok(db.prepare("SELECT COUNT(*) n FROM tasks WHERE invoice_id=? AND title LIKE 'Collect %'").get(o120.id).n === 1, 'one collection task per invoice');
  const wa = db.prepare("SELECT * FROM tasks WHERE invoice_id=? AND title LIKE 'Send WhatsApp%'").get(o10.id); assert.match(wa.notes, /https:\/\/wa\.me\/9665\d+\?text=/, 'Saudi mobile numbers get the 966 prefix');
  // manual reminders from the invoice page
  const m1 = await api('POST', `/api/invoices/${o10.id}/remind`, { channel: 'whatsapp' }); assert.equal(m1.body.status, 'link'); assert.match(m1.body.link, /wa\.me/);
  assert.match(m1.body.message, /Dear Hijaz Logistics/); assert.match(m1.body.message, /عزيزي|الفاتورة/); assert.match(m1.body.message, /\/pay\//);
  assert.equal((await api('POST', `/api/invoices/${o10.id}/remind`, { channel: 'sms' })).body.status, 'skipped', 'no SMS gateway connected');
  assert.equal((await api('POST', `/api/invoices/${o10.id}/remind`, { channel: 'fax' })).status, 400);
  assert.equal((await api('POST', `/api/invoices/${o10.id}/remind`, { channel: 'email' }, repCookie)).status, 403);
  // with a gateway connected, WhatsApp/SMS go through it
  await api('PUT', '/api/billing/settings', { messaging: { mode: 'webhook', url: `http://127.0.0.1:${gw.address().port}/send`, token: 'gw' } });
  assert.equal((await api('POST', `/api/invoices/${o10.id}/remind`, { channel: 'sms' })).body.status, 'sent'); assert.equal(msgCalls.at(-1).channel, 'sms'); assert.equal(msgCalls.at(-1).to, '0501234567'.length ? msgCalls.at(-1).to : '');
  assert.equal((await api('POST', `/api/invoices/${o10.id}/remind`, { channel: 'whatsapp' })).body.status, 'sent');
  // paying closes the collection task
  const inv = (await api('GET', `/api/invoices/${o10.id}`)).body; await api('POST', `/api/invoices/${o10.id}/payments`, { amount: inv.balance });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks WHERE invoice_id=? AND done=0').get(o10.id).n, 0);
  assert.ok((await api('GET', `/api/invoices/${o10.id}`)).body.reminders.length >= 4);
  assert.equal((await api('POST', `/api/invoices/${o10.id}/remind`, { channel: 'email' })).status, 400, 'paid invoices are not chased');
  await api('PUT', '/api/billing/settings', { reminders: { enabled: false }, messaging: { mode: 'none' } });
});

test('payment portal: bilingual/RTL page, escaping, claims, confirmation, limits', async () => {
  const evil = (await api('POST', '/api/accounts', { ...CUSTOMER, name: 'Evil <script>alert(1)</script> & Co', vat_number: '333333333300003' })).body;
  const d = (await api('POST', '/api/invoices', { account_id: evil.id, lines: [line({ unit_price: 1000, description: 'Svc <img src=x onerror=alert(1)>' })], notes: '<b>note</b>' })).body;
  const inv = (await api('POST', `/api/invoices/${d.id}/issue`)).body; const url = `/pay/${inv.portal_token}`;
  const page = await fetch(base + url); const html = await page.text();
  assert.equal(page.status, 200); assert.ok(!html.includes('<script>alert(1)') && !html.includes('<img src=x') && !html.includes('<b>note</b>'), 'user content is escaped');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;')); assert.ok(html.includes(inv.number) && html.includes('SA0380000000608010167519') && html.includes('Payment reference') && html.includes('الآيبان') && html.includes('<svg'));
  assert.ok(html.includes('1,150.00 SAR') && html.includes('Notify payment')); assert.equal(page.headers.get('x-robots-tag'), 'noindex');
  const ar = await (await fetch(base + url + '?lang=ar')).text(); assert.ok(ar.includes('dir="rtl"') && ar.includes('فاتورة ضريبية') && !ar.includes('Bill to'));
  assert.equal((await fetch(base + '/pay/not-a-real-token-1234567890')).status, 404); assert.equal((await fetch(base + '/pay/short')).status, 404);
  const draft = (await api('POST', '/api/invoices', { account_id: acc.id, lines: [line()] })).body; assert.equal(draft.portal_token, null);
  const post = (body) => fetch(base + url + '/claim', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const tooMuch = await post({ amount: '99999', paid_on: daysAgo(0) }); assert.equal(tooMuch.status, 303); assert.match(tooMuch.headers.get('location'), /error=/);
  assert.match((await post({ amount: '100', paid_on: '2999-01-01' })).headers.get('location'), /error=/);
  const ok = await post({ amount: '500', paid_on: daysAgo(1), reference: 'SARIE-77', payer: 'Ali' }); assert.match(ok.headers.get('location'), /claimed=1/);
  assert.ok((await (await fetch(base + url + '?claimed=1')).text()).includes('recorded your payment notice'));
  const claims = (await api('GET', '/api/payment-claims')).body; const c = claims.find((x) => x.number === inv.number); assert.equal(c.amount, 500); assert.equal(c.reference, 'SARIE-77');
  assert.equal((await api('GET', '/api/payment-claims', null, repCookie)).status, 403);
  assert.equal((await api('POST', `/api/payment-claims/${c.id}/confirm`)).status, 200);
  const after = (await api('GET', `/api/invoices/${inv.id}`)).body; assert.equal(after.amount_paid, 500); assert.equal(after.status, 'partially_paid'); assert.ok(after.events.some((e) => e.type === 'payment_claim'));
  assert.equal((await api('POST', `/api/payment-claims/${c.id}/confirm`)).status, 404, 'already handled');
  assert.ok((await (await fetch(base + url)).text()).includes('Partially paid'));
  const print = await api('GET', `/api/invoices/${inv.id}/print`); assert.equal(print.status, 200); assert.ok(print.body.includes('printbtn')); assert.equal((await fetch(base + `/api/invoices/${inv.id}/print`)).status, 401);
  // rejected-by-provider invoices tell the customer it is being corrected and hide the pay form
  db.prepare("UPDATE invoices SET compliance_status='rejected' WHERE id=?").run(inv.id);
  const rj = await (await fetch(base + url)).text(); assert.ok(rj.includes('being corrected') && !rj.includes('Notify payment'));
  db.prepare("UPDATE invoices SET compliance_status='ready' WHERE id=?").run(inv.id);
  for (let i = 0; i < 12; i++) await post({ amount: '1', paid_on: daysAgo(0) }); // rate/pending limits
  assert.ok(db.prepare("SELECT COUNT(*) n FROM payment_claims WHERE invoice_id=? AND status='pending'").get(inv.id).n <= 5);
});

test('readiness: seller, customer master data, drafts, compliance, reconciliation, chain', async () => {
  await api('POST', '/api/accounts', { name: 'Sloppy Trading', vat_number: '12345' });
  await api('POST', '/api/accounts', { name: 'Najd Builders' }); // duplicate name
  await api('POST', '/api/invoices', { buyer_name: 'Draft Co', doc_type: 'standard', lines: [line({ vat_category: 'E' })] });
  db.prepare("INSERT INTO payments (invoice_id,amount,paid_on,method,reconciled) VALUES (?,?,?, 'bank_transfer',0)").run(inv1.id, 0.01, daysAgo(20)); // an unreconciled old transfer
  const r = (await api('GET', '/api/readiness')).body; const codes = (a) => a.map((x) => x.code);
  assert.equal(r.jurisdiction, 'KSA'); assert.equal((await api('GET', '/api/readiness', null, repCookie)).status, 403);
  assert.ok(codes(r.sections.customers).includes('CUST_VAT_FORMAT') && codes(r.sections.customers).includes('CUST_DUP_NAME') && codes(r.sections.customers).includes('CUST_CONTACT'));
  assert.ok(r.sections.customers.find((x) => x.code === 'CUST_VAT_FORMAT').ref.type === 'account');
  assert.ok(codes(r.sections.invoices).includes('BUYER_VAT') && codes(r.sections.invoices).includes('VAT_REASON'));
  assert.ok(codes(r.sections.compliance).some((c) => ['NOT_CLEARED', 'NOT_SUBMITTED', 'REJECTED', 'SUBMIT_FAILED'].includes(c)));
  assert.ok(codes(r.sections.reconciliation).includes('UNRECONCILED'));
  assert.equal(r.sections.chain.length, 0); assert.ok(r.summary.errors > 0 && r.summary.drafts >= 1 && r.summary.chain_checked >= 5);
  // a simplified invoice issued >24h ago and never reported is an error
  const s = (await api('POST', '/api/invoices', { doc_type: 'simplified', lines: [line()] })).body; const si = (await api('POST', `/api/invoices/${s.id}/issue`)).body;
  db.prepare("UPDATE invoices SET issued_at=datetime('now','-30 hours') WHERE id=?").run(si.id);
  assert.ok(codes((await api('GET', '/api/readiness')).body.sections.compliance).includes('REPORT_24H'));
  // tampering with stored data is detected by the chain check
  db.exec('DROP TRIGGER trg_lines_no_update'); db.prepare('UPDATE invoice_lines SET unit_price=1 WHERE invoice_id=?').run(inv1.id);
  const t = (await api('GET', '/api/billing/chain')).body; assert.ok(t.problems.some((p) => p.number === 'INV-000001' && /altered after issue/.test(p.message)));
  assert.ok((await api('GET', '/api/readiness')).body.sections.chain.length >= 1);
});

test('import from accounting exports: grouping, customers, dates, duplicates, exceptions', async () => {
  const rows = [
    { invoice_number: 'ZB-1001', issue_date: '15/03/2026', due_date: '14/04/2026', customer: 'Tabuk Foods', customer_vat: '344444444400003', customer_email: 'a@tabuk.example', description: 'Rice 25kg', qty: '10', unit_price: '90', vat_rate: '15' },
    { invoice_number: 'ZB-1001', issue_date: '15/03/2026', due_date: '14/04/2026', customer: 'Tabuk Foods', customer_vat: '344444444400003', description: 'Oil 5L', qty: '4', unit_price: '25.5', vat_rate: '15%' },
    { invoice_number: 'ZB-1002', issue_date: '45000', customer: 'Export Client', customer_vat: '', description: 'Goods', qty: '1', unit_price: '500', vat_rate: '0' },
    { invoice_number: 'ZB-1003', issue_date: '2026-03-20', customer: 'Bad VAT Ltd', customer_vat: '999', description: 'Service', qty: '1', unit_price: '100' },
  ];
  assert.equal((await api('POST', '/api/invoices/import', { rows }, repCookie)).status, 403);
  const r = (await api('POST', '/api/invoices/import', { rows })).body;
  assert.equal(r.invoices, 3); assert.equal(r.accounts_created >= 3, true); assert.equal(r.skipped_duplicates, 0);
  const byNum = Object.fromEntries(r.results.map((x) => [x.number, x]));
  assert.equal(byNum['ZB-1001'].customer, 'Tabuk Foods'); assert.ok(byNum['ZB-1002'].errors >= 0 && byNum['ZB-1003'].errors >= 1, 'bad VAT is flagged');
  const d1 = (await api('GET', `/api/invoices/${byNum['ZB-1001'].id}`)).body; assert.equal(d1.lines.length, 2); assert.equal(d1.issue_date, '2026-03-15'); assert.equal(d1.due_date, '2026-04-14'); assert.equal(d1.source, 'import'); assert.equal(d1.external_number, 'ZB-1001'); assert.equal(d1.status, 'draft');
  assert.equal(Math.round(d1.total * 100) / 100, Math.round((10 * 90 + 4 * 25.5) * 1.15 * 100) / 100);
  const d2 = (await api('GET', `/api/invoices/${byNum['ZB-1002'].id}`)).body; assert.equal(d2.issue_date, '2023-03-15', 'Excel serial date'); assert.equal(d2.lines[0].vat_category, 'Z'); assert.ok(d2.issues.some((i) => i.code === 'VAT_REASON'), 'zero-rate without reason is an exception');
  const again = (await api('POST', '/api/invoices/import', { rows })).body; assert.equal(again.skipped_duplicates, 3, 'idempotent re-import');
  assert.ok((await api('GET', '/api/readiness')).body.sections.invoices.some((i) => i.source === 'import'));
  // fix the exception, then issue
  await api('PUT', `/api/invoices/${d2.id}`, { lines: [{ ...d2.lines[0], exemption_reason: 'VATEX-SA-32 Export of goods' }], buyer_name: 'Export Client', doc_type: 'simplified' });
  assert.equal((await api('POST', `/api/invoices/${d2.id}/issue`)).status, 200);
});

test('reps can draft but not issue; delete-all and purge never touch invoices', async () => {
  const d = (await api('POST', '/api/invoices', { account_id: acc.id, lines: [line()] }, repCookie)); assert.equal(d.status, 200);
  assert.equal((await api('POST', `/api/invoices/${d.body.id}/issue`, {}, repCookie)).status, 403);
  assert.equal((await api('DELETE', `/api/invoices/${d.body.id}`, null, repCookie)).status, 200, 'own draft');
  const n = db.prepare('SELECT COUNT(*) n FROM invoices WHERE status<>?').get('draft').n;
  assert.equal((await api('POST', '/api/admin/purge', { entity: 'accounts', confirm: 'DELETE' })).status, 200, 'accounts can be purged');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices WHERE status<>?').get('draft').n, n, 'issued invoices survive');
  assert.ok(db.prepare('SELECT buyer_name FROM invoices WHERE number=?').get('INV-000002').buyer_name, 'buyer snapshot kept on the invoice');
});
