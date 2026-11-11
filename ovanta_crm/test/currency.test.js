import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { SEED_BILLING_DEMO: '0', DB_PATH: ':memory:', SESSION_SECRET: 'fx' });
const { server } = await import('../server/index.js');
const { seedIfEmpty } = await import('../server/seed.js');
const { run } = await import('../server/db.js');
let base, admin, rep;
const Y = new Date().getFullYear();
before(async () => { seedIfEmpty(); await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; admin = await login('admin@ovantaa.com'); rep = await login('liam@ovantaa.com'); });
after(() => server.close());
async function call(ck, method, p, body) { const r = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie: ck || '' }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j }; }
async function login(email) { return (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Ovantaa@123' }) })).headers.get('set-cookie').split(';')[0]; }
const deal = async (b) => (await call(admin, 'POST', '/api/deals', { name: 'FX ' + Math.random(), ...b })).body;
const reload = async (d) => (await call(admin, 'GET', `/api/deals/${d.id}`)).body;

test('setup: only settings managers can change currencies and rates; codes are validated', async () => {
  const m = (await call(rep, 'GET', '/api/meta')).body.currency; assert.equal(m.c1, 'USD'); assert.equal(m.c2, null);
  assert.equal((await deal({ amount: 100 })).amount2, null, 'no Currency 2 yet → no conversion');
  assert.equal((await call(rep, 'PUT', '/api/currency', { c1: 'USD', c2: 'SAR' })).status, 403);
  assert.equal((await call(admin, 'PUT', '/api/currency', { c1: 'US', c2: 'SAR' })).status, 400);
  assert.equal((await call(admin, 'PUT', '/api/currency', { c1: 'USD', c2: 'USD' })).status, 400);
  assert.equal((await call(admin, 'PUT', `/api/currency/rates/${Y}`, { rate: 3.75 })).status, 400, 'Currency 2 must be chosen first');
  const ok = await call(admin, 'PUT', '/api/currency', { c1: 'usd', c2: 'sar' }); assert.equal(ok.status, 200); assert.equal(ok.body.c2, 'SAR');
  assert.equal((await call(rep, 'PUT', `/api/currency/rates/${Y}`, { rate: 3.75 })).status, 403);
  assert.equal((await call(admin, 'PUT', `/api/currency/rates/${Y}`, { rate: -1 })).status, 400);
  for (const [yr, rate] of [[Y - 1, 3.70], [Y, 3.75]]) assert.equal((await call(admin, 'PUT', `/api/currency/rates/${yr}`, { rate, note: 'board approved' })).status, 200);
  const cust = (await call(rep, 'GET', '/api/customization')).body; assert.equal(cust.entities.deals.builtin.find((b) => b.key === 'amount').label, 'Amount (USD)');
});

test('which year applies: open deals use the expected close date (else the created date); closed deals use the date they closed', async () => {
  const a = await deal({ amount: 1000, close_date: `${Y}-06-30` }); assert.equal(a.amount2, 3750); assert.equal(a.fx_year, Y);
  const b = await deal({ amount: 1000, close_date: `${Y - 1}-12-31` }); assert.equal(b.amount2, 3700, 'expected close last year → last year rate');
  const c = await deal({ amount: 1000 }); assert.equal(c.rate_date.slice(0, 4), String(Y)); assert.equal(c.amount2, 3750, 'no close date → created date');
  const w = await call(admin, 'POST', `/api/deals/${b.id}/stage`, { stage: 'won' }); assert.equal(w.body.fx_year, Y); assert.equal(w.body.amount2, 3750, 'won today → this year rate, not the expected close date');
  run('UPDATE deals SET closed_at=? WHERE id=?', `${Y - 1}-11-02 10:00:00`, b.id); assert.equal((await reload(b)).amount2, 3700, 'closed last year → last year rate');
  const later = await deal({ amount: 1000, close_date: `${Y + 1}-03-01` }); assert.equal(later.amount2, 3750); assert.equal(later.fx_exact, 0, 'no rate for next year yet → latest earlier year, flagged');
  const early = await deal({ amount: 1000, close_date: '2001-01-01' }); assert.equal(early.amount2, null, 'no rate at or before that year');
  // a rate change updates every deal of that year, and is kept in the history
  await call(admin, 'PUT', `/api/currency/rates/${Y}`, { rate: 3.76 }); assert.equal((await reload(a)).amount2, 3760);
  const info = (await call(admin, 'GET', '/api/currency')).body;
  assert.ok(info.history.some((h) => h.year === Y && h.old_rate === 3.75 && h.new_rate === 3.76 && h.changed_by_name === 'Admin User'));
  assert.ok(info.deals_without_rate >= 1); assert.ok(info.deals_using_fallback >= 1);
  const sorted = (await call(admin, 'GET', '/api/deals?sort=amount2&dir=desc&limit=3')).body.rows; assert.ok(sorted[0].amount2 >= sorted[1].amount2);
});

test('dashboard totals in both currencies, AI search knows the converted amount', async () => {
  const d = (await call(admin, 'GET', '/api/dashboard')).body;
  for (const k of ['pipelineValue2', 'forecast2', 'wonValue2', 'dealsWithoutRate']) assert.ok(k in d.kpis, k);
  assert.ok(d.pipeline.every((s) => 'amount2' in s)); assert.ok('value2' in d.revenueByMonth[0]); assert.ok(d.kpis.pipelineValue2 > d.kpis.pipelineValue, 'SAR totals are larger than USD');
  const f = (await call(admin, 'GET', '/api/search/fields')).body.entities.find((e) => e.entity === 'deals'); assert.ok(f.fields.some((x) => x.key === 'amount_currency2'));
});

test('changing the currency pair keeps the old rates as history; deleting a rate is logged', async () => {
  await call(admin, 'PUT', '/api/currency', { c1: 'USD', c2: 'INR' });
  const info = (await call(admin, 'GET', '/api/currency')).body; assert.equal(info.rates.length, 0); assert.ok(info.other_pairs.some((p) => p.c2 === 'SAR' && p.years === 2));
  await call(admin, 'PUT', '/api/currency', { c1: 'USD', c2: 'SAR' }); assert.equal((await call(admin, 'GET', '/api/currency')).body.rates.length, 2, 'switching back brings the rates back');
  assert.equal((await call(admin, 'DELETE', `/api/currency/rates/${Y - 1}`)).status, 200);
  assert.ok((await call(admin, 'GET', '/api/currency')).body.history.some((h) => h.year === Y - 1 && h.new_rate === null));
  await call(admin, 'PUT', '/api/currency', { c1: 'EUR', c2: 'SAR' }); assert.equal((await call(rep, 'GET', '/api/customization')).body.entities.deals.builtin.find((b) => b.key === 'amount').label, 'Amount (EUR)');
});
