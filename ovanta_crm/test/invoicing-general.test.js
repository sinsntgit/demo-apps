import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { SMTPServer } = createRequire(import.meta.url)('smtp-server');

const inbox = [];
const smtp = new SMTPServer({ authOptional: false, logger: false,
  onAuth(a, _s, cb) { a.username === 'billing@acme.in' && a.password === 'pw' ? cb(null, { user: 1 }) : cb(Object.assign(new Error('authentication failed'), { responseCode: 535 })); },
  onData(stream, s, cb) { let raw = ''; stream.on('data', (c) => (raw += c)); stream.on('end', () => { inbox.push({ raw: raw.replace(/=\r?\n/g, ''), to: s.envelope.rcptTo.map((r) => r.address) }); cb(); }); } });
await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
Object.assign(process.env, { SEED_BILLING_DEMO: '0', DB_PATH: ':memory:', SESSION_SECRET: 'ig', BASE_URL: 'https://crm.example.com', SMTP_TIMEOUT_MS: '3000', SMTP_TLS_INSECURE: '1' });
const { server } = await import('../server/index.js');
const { seedIfEmpty } = await import('../server/seed.js');
const { get } = await import('../server/db.js');
const { gstinValid } = await import('../server/regimes.js');
let base, admin, rep;
before(async () => {
  seedIfEmpty(); await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; admin = await login('admin@ovantaa.com'); rep = await login('liam@ovantaa.com');
  await call(admin, 'POST', '/api/senders', { label: 'Acme billing', from_email: 'billing@acme.in', mode: 'smtp', host: '127.0.0.1', port: smtp.server.address().port, secure: false, username: 'billing@acme.in', password: 'pw', delay_ms: 0 });
});
after(() => { server.close(); smtp.close(); });
async function call(ck, method, p, body) { const r = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie: ck || '' }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j }; }
async function login(email) { return (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Ovantaa@123' }) })).headers.get('set-cookie').split(';')[0]; }
const waitFor = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 40)); } return fn(); };
/** A GSTIN with a correct check character for the given state + PAN. */
const gstin = (state, pan) => { for (const c of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ') { const g = `${state}${pan}1Z${c}`; if (gstinValid(g)) return g; } throw new Error('no checksum'); };
const SELLER_GST = gstin('27', 'AAPFU0939F'), KA_GST = gstin('29', 'AABCT1332L'), MH_GST = gstin('27', 'AACCM4441K');
const line = (o = {}) => ({ description: 'Implementation services', hsn_code: '998314', qty: 2, unit_price: 50000, vat_category: 'S', vat_rate: 18, ...o });

test('India GST: mode switch, GSTIN checks, place of supply decides IGST vs CGST+SGST, amount in words', async () => {
  assert.equal((await call(admin, 'PUT', '/api/billing/settings', { jurisdiction: 'IN', seller_name: 'Acme Software Pvt Ltd', vat_number: '27ABCDE1234F1Z5', address: { street: 'MG Road', city: 'Pune', state: 'Maharashtra', postal_code: '411001' } })).status, 200);
  const bad = (await call(admin, 'GET', '/api/billing/settings')).body; assert.equal(bad.settings.currency, 'INR'); assert.equal(bad.settings.tax_label, 'GST'); assert.equal(bad.settings.address.state, '27');
  assert.ok(bad.issues.some((i) => i.code === 'SELLER_VAT_FORMAT'), 'GSTIN checksum is verified');
  await call(admin, 'PUT', '/api/billing/settings', { vat_number: SELLER_GST, pan: 'AAPFU0939F', bank: { bank_name: 'HDFC Bank', account_number: '50100123456789', bank_code: 'HDFC0001234', upi: 'acme@hdfcbank' } });
  assert.deepEqual((await call(admin, 'GET', '/api/billing/settings')).body.issues.filter((i) => i.severity === 'error'), []);
  const ka = (await call(admin, 'POST', '/api/accounts', { name: 'Bangalore Retail Ltd', vat_number: KA_GST, state: 'Karnataka', country_code: 'IN', street: '1 Brigade Rd', city: 'Bengaluru', billing_email: 'ap@blrretail.in' })).body;
  const d = (await call(admin, 'POST', '/api/invoices', { account_id: ka.id, lines: [line(), line({ description: 'Licence', hsn_code: '997331', qty: 1, unit_price: 20000 })] })).body;
  assert.equal(d.jurisdiction, 'IN'); assert.equal(d.currency, 'INR'); assert.equal(d.place_of_supply, '29'); assert.equal(d.lang, 'en');
  assert.deepEqual(d.issues.filter((i) => i.severity === 'error'), [], JSON.stringify(d.issues));
  assert.deepEqual(d.tax_breakdown.map((b) => [b.label, b.amount]), [['IGST 18%', 21600]], 'other state → IGST');
  const iss = await call(admin, 'POST', `/api/invoices/${d.id}/issue`); assert.equal(iss.status, 200, JSON.stringify(iss.body)); assert.equal(iss.body.compliance_status, 'not_applicable'); assert.equal(iss.body.qr, null, 'no ZATCA QR on Indian invoices');
  const html = await (await fetch(`${base}/api/invoices/${d.id}/print`, { headers: { cookie: admin } })).text();
  for (const s of ['Tax Invoice', 'GSTIN', 'IGST 18%', 'HSN/SAC', '998314', 'Place of supply', 'Karnataka (29)', 'Rupees One Lakh Forty One Thousand Six Hundred Only', 'HDFC0001234', 'acme@hdfcbank', 'PAN: AAPFU0939F']) assert.ok(html.includes(s), s);
  assert.ok(!/فاتورة|VAT no\./.test(html), 'no Arabic or VAT wording');
  // same state → CGST + SGST
  const mh = (await call(admin, 'POST', '/api/accounts', { name: 'Mumbai Traders', vat_number: MH_GST, state: '27', country_code: 'IN', street: 'x', city: 'Mumbai', billing_email: 'a@mt.in' })).body;
  const d2 = (await call(admin, 'POST', '/api/invoices', { account_id: mh.id, lines: [line({ qty: 1, unit_price: 10000 })] })).body;
  assert.deepEqual(d2.tax_breakdown.map((b) => [b.label, b.amount]), [['CGST 9%', 900], ['SGST 9%', 900]]);
  // checks: GSTIN format, missing state, HSN code
  const d3 = (await call(admin, 'POST', '/api/invoices', { buyer_name: 'No state Co', buyer_vat: '29ABCDE1234F1Z9', lines: [line({ hsn_code: '' })] })).body;
  for (const code of ['BUYER_GSTIN', 'PLACE_OF_SUPPLY', 'LINE_HSN']) assert.ok(d3.issues.some((i) => i.code === code), code);
  // export: customer outside India → IGST / export wording, no place-of-supply error
  const ex = (await call(admin, 'POST', '/api/invoices', { buyer_name: 'London Ltd', buyer_country: 'GB', buyer_email: 'ap@london.co.uk', currency: 'USD', lines: [line({ vat_category: 'Z', vat_rate: 0 })] })).body;
  assert.ok(!ex.issues.some((i) => i.severity === 'error'), JSON.stringify(ex.issues)); assert.equal(ex.place_of_supply, '96');
});

test('any other country: UK VAT preset, own tax name/rate, no Gulf rules', async () => {
  await call(admin, 'PUT', '/api/billing/settings', { jurisdiction: 'GEN', country: 'GB', seller_name: 'Acme UK Ltd', vat_number: 'GB123456789', address: { street: '1 High St', city: 'London', postal_code: 'EC1A 1BB', country_code: 'GB' }, bank: { account_number: '12345678', bank_code: '20-00-00', iban: '' } });
  const s = (await call(admin, 'GET', '/api/billing/settings')).body.settings;
  assert.deepEqual([s.currency, s.tax_label, s.vat_rate, s.invoice_title, s.bank.bank_code_label], ['GBP', 'VAT', 20, 'VAT Invoice', 'Sort code']);
  const d = (await call(admin, 'POST', '/api/invoices', { buyer_name: 'Bristol Bikes', buyer_email: 'ap@bristolbikes.co.uk', buyer_street: '2 Park Row', buyer_city: 'Bristol', lines: [{ description: 'Consulting', qty: 10, unit_price: 100, vat_category: 'S' }] })).body;
  assert.equal(d.currency, 'GBP'); assert.equal(d.vat_total, 200, 'default 20%'); assert.equal(d.buyer_country, 'GB');
  assert.deepEqual(d.issues.filter((i) => i.severity === 'error'), [], JSON.stringify(d.issues));
  assert.equal((await call(admin, 'POST', `/api/invoices/${d.id}/issue`)).status, 200);
  const html = await (await fetch(`${base}/api/invoices/${d.id}/print`, { headers: { cookie: admin } })).text();
  for (const x of ['VAT Invoice', 'VAT 20%', 'VAT registration no.', 'Sort code', '20-00-00']) assert.ok(html.includes(x), x);
  // US: sales tax with a custom rate; simplified type is not offered outside the Gulf
  await call(admin, 'PUT', '/api/billing/settings', { jurisdiction: 'GEN', country: 'US', vat_rate: 8.25 });
  const us = (await call(admin, 'POST', '/api/invoices', { doc_type: 'simplified', buyer_name: 'Austin Co', buyer_email: 'a@austin.com', lines: [{ description: 'Widget', qty: 1, unit_price: 100 }] })).body;
  assert.equal(us.doc_type, 'standard'); assert.equal(us.vat_total, 8.25); assert.equal(us.tax_breakdown[0].label, 'Sales tax 8.25%');
  globalThis.ukInvoice = d.id;
});

test('email an invoice: message, view & pay link, invoice attached, logged; drafts and reps are refused', async () => {
  const id = globalThis.ukInvoice;
  assert.equal((await call(rep, 'POST', `/api/invoices/${id}/email`, {})).status, 403, 'needs the Email & remind permission');
  const draft = (await call(admin, 'POST', '/api/invoices', { buyer_name: 'X', lines: [{ description: 'a', qty: 1, unit_price: 1 }] })).body;
  assert.equal((await call(admin, 'POST', `/api/invoices/${draft.id}/email`, { to: 'x@y.com' })).status, 400);
  assert.equal((await call(admin, 'POST', `/api/invoices/${id}/email`, { to: 'not-an-email' })).status, 400);
  const r = await call(admin, 'POST', `/api/invoices/${id}/email`, { cc: 'boss@bristolbikes.co.uk', message: 'Hi team,\nPlease find our invoice attached.' });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.status, 'sent'); assert.deepEqual(r.body.to, ['ap@bristolbikes.co.uk']);
  const m = await waitFor(() => inbox.find((x) => x.to.includes('ap@bristolbikes.co.uk') && /VAT Invoice/.test(x.raw)));
  assert.ok(m); assert.ok(m.to.includes('boss@bristolbikes.co.uk'), 'cc delivered'); assert.match(m.raw, /Please find our invoice attached/); assert.match(m.raw, /https:\/\/crm\.example\.com\/pay\//);
  assert.match(m.raw, /Content-Disposition: attachment; filename=.?INV-\d+\.html/); assert.match(m.raw, /20-00-00/);
  const inv = r.body.invoice; assert.equal(inv.email_count, 1); assert.ok(inv.emailed_at); assert.ok(inv.events.some((e) => e.type === 'emailed'));
});

test('payments: record with a receipt email, reverse a mistaken payment, status follows', async () => {
  const id = globalThis.ukInvoice; inbox.length = 0;
  const p = await call(admin, 'POST', `/api/invoices/${id}/payments`, { amount: 400, method: 'bank_transfer', reference: 'FPS123', send_receipt: true });
  assert.equal(p.status, 200); assert.equal(p.body.status, 'partially_paid'); assert.equal(p.body.balance, 800); assert.equal(p.body.receipt.status, 'sent');
  const rc = await waitFor(() => inbox.find((x) => /Payment[ _]received/.test(x.raw))); assert.ok(rc && /800\.00/.test(rc.raw), 'receipt shows the remaining balance');
  const full = await call(admin, 'POST', `/api/invoices/${id}/payments`, { amount: 800, method: 'card' }); assert.equal(full.body.status, 'paid');
  const wrong = full.body.payments.find((x) => x.amount === 800);
  assert.equal((await call(rep, 'DELETE', `/api/payments/${wrong.id}`, { reason: 'x' })).status, 403);
  const rev = await call(admin, 'DELETE', `/api/payments/${wrong.id}`, { reason: 'Card payment bounced' });
  assert.equal(rev.status, 200); assert.equal(rev.body.status, 'partially_paid'); assert.equal(rev.body.balance, 800); assert.ok(rev.body.events.some((e) => e.type === 'payment_reversed' && /bounced/.test(e.detail)));
  const all = rev.body.payments; await call(admin, 'DELETE', `/api/payments/${all[0].id}`, {}); assert.equal((await call(admin, 'GET', `/api/invoices/${id}`)).body.status, 'issued');
});

test('reminders: English for non-Gulf invoices, pay button, local WhatsApp prefix, pause stops automatic reminders', async () => {
  const id = globalThis.ukInvoice; inbox.length = 0;
  const r = await call(admin, 'POST', `/api/invoices/${id}/remind`, { channel: 'email' }); assert.equal(r.body.status, 'sent');
  const m = await waitFor(() => inbox.find((x) => /Upcoming payment|Payment due|Overdue payment/.test(x.raw))); assert.ok(m); assert.ok(!/المرجع|السادة/.test(m.raw), 'no Arabic'); assert.match(m.raw, /View invoice &amp; pay|View invoice & pay/);
  const { whatsappLink } = await import('../server/receivables.js'); assert.match(whatsappLink('09876543210', 'hi', 'IN'), /wa\.me\/919876543210/); assert.match(whatsappLink('9876543210', 'hi', 'IN'), /wa\.me\/919876543210/); assert.match(whatsappLink('07700900123', 'hi', 'GB'), /wa\.me\/447700900123/);
  // overdue + automatic reminders on → sent unless paused
  const { run } = await import('../server/db.js'); run("UPDATE invoices SET due_date=date('now','-3 day') WHERE id=?", id);
  const b = (await call(admin, 'GET', '/api/billing/settings')).body.settings; await call(admin, 'PUT', '/api/billing/settings', { reminders: { ...b.reminders, enabled: true } });
  assert.equal((await call(admin, 'PUT', `/api/invoices/${id}/reminders`, { paused: true })).body.paused, true);
  await call(admin, 'POST', '/api/reminders/run'); assert.equal(get("SELECT COUNT(*) n FROM reminder_log WHERE invoice_id=? AND kind='auto'", id).n, 0, 'paused');
  await call(admin, 'PUT', `/api/invoices/${id}/reminders`, { paused: false }); await call(admin, 'POST', '/api/reminders/run');
  assert.ok(get("SELECT COUNT(*) n FROM reminder_log WHERE invoice_id=? AND kind='auto' AND channel='email'", id).n >= 1, 'sent once resumed');
});

test('switching back to KSA keeps the ZATCA rules', async () => {
  await call(admin, 'PUT', '/api/billing/settings', { jurisdiction: 'KSA', vat_number: '300000000000003' });
  const s = (await call(admin, 'GET', '/api/billing/settings')).body.settings; assert.equal(s.currency, 'SAR'); assert.equal(s.vat_rate, 15); assert.equal(s.default_lang, 'both');
  const d = (await call(admin, 'POST', '/api/invoices', { buyer_name: 'Riyadh Co', lines: [{ description: 'x', qty: 1, unit_price: 100 }] })).body;
  assert.ok(d.issues.some((i) => i.code === 'BUYER_VAT'), 'B2B VAT number still required'); assert.equal(d.vat_total, 15);
});
