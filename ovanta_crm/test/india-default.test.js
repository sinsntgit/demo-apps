import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

Object.assign(process.env, { DB_PATH: ':memory:', SESSION_SECRET: 'india', BASE_URL: 'https://crm.example.com' });
delete process.env.SEED_BILLING_DEMO; delete process.env.SEED_BILLING_MODE;
const { server } = await import('../server/index.js');
const { seedIfEmpty } = await import('../server/seed.js');
const { get, all } = await import('../server/db.js');
const { MIGRATIONS } = await import('../server/migrations.js');
let base, admin;
before(async () => { seedIfEmpty(); await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@ovantaa.com', password: 'Ovantaa@123' }) }); admin = r.headers.get('set-cookie').split(';')[0]; });
after(() => server.close());
const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), cookie: admin }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };

test('a new install invoices under India GST, with Indian demo invoices', async () => {
  const s = (await call('GET', '/api/billing/settings')).body.settings;
  assert.equal(s.jurisdiction, 'IN'); assert.equal(s.currency, 'INR'); assert.equal(s.vat_rate, 18); assert.equal(s.tax_id_label, 'GSTIN');
  const inv = all('SELECT jurisdiction, currency, place_of_supply FROM invoices'); assert.ok(inv.length >= 10);
  assert.ok(inv.every((i) => i.jurisdiction === 'IN' && i.currency === 'INR'));
  assert.ok(inv.some((i) => i.place_of_supply === '29') && inv.some((i) => i.place_of_supply !== '29'), 'both intra-state (CGST+SGST) and inter-state (IGST) customers');
  const n = get("SELECT COUNT(*) n FROM invoices WHERE status IN ('paid','partially_paid')").n; assert.ok(n >= 4);
});

test('account form follows the invoicing mode: GSTIN for India, VAT + Arabic fields for Saudi', async () => {
  const acc = (m) => Object.fromEntries(m.body.entities.accounts.builtin.map((b) => [b.key, b]));
  let b = acc(await call('GET', '/api/customization'));
  assert.equal(b.vat_number.label, 'GSTIN'); assert.equal(b.name_ar.modeHidden, true); assert.equal(b.building_no.modeHidden, true); assert.match(b.state.label, /GST place of supply/);
  assert.equal((await call('PUT', '/api/billing/settings', { jurisdiction: 'KSA' })).status, 200);
  b = acc(await call('GET', '/api/customization')); assert.equal(b.vat_number.label, 'VAT number'); assert.ok(!b.name_ar.modeHidden);
  await call('PUT', '/api/billing/settings', { jurisdiction: 'IN' });
});

test('upgrading: an untouched Saudi demo setup moves to India; a customised one is kept', () => {
  const up = MIGRATIONS.find((m) => m.version === 16).up;
  const mk = (billing) => { const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)'); db.prepare("INSERT INTO settings (key,value) VALUES ('billing',?)").run(JSON.stringify(billing)); up(db); return JSON.parse(db.prepare("SELECT value FROM settings WHERE key='billing'").get().value); };
  const demo = mk({ jurisdiction: 'KSA', seller_name: 'Ovantaa Demo Trading Co', vat_number: '300000000000003', currency: 'SAR', address: { city: 'Riyadh' }, bank: { iban: 'SA03' } });
  assert.equal(demo.jurisdiction, 'IN'); assert.equal(demo.currency, 'INR'); assert.equal(demo.address.state, 'Karnataka'); assert.equal(demo.bank.iban, '');
  const mine = mk({ jurisdiction: 'KSA', seller_name: 'Al Noor Trading', vat_number: '310123456700003', currency: 'SAR' });
  assert.equal(mine.jurisdiction, 'KSA', 'a real Saudi setup is never changed'); assert.equal(mine.seller_name, 'Al Noor Trading');
});
