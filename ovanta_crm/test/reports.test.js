import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { SEED_BILLING_DEMO: '0', DB_PATH: ':memory:', SESSION_SECRET: 'reports', BASE_URL: 'https://crm.example.com' });
const { server } = await import('../server/index.js');
const { seedIfEmpty } = await import('../server/seed.js');
const { get, run } = await import('../server/db.js');
const { periodRange } = await import('../server/reports.js');
let base, admin, rep, repId;
before(async () => { seedIfEmpty(); await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; admin = await login('admin@ovantaa.com', 'Ovantaa@123'); rep = await login('liam@ovantaa.com', 'Ovantaa@123'); repId = get("SELECT id FROM users WHERE email='liam@ovantaa.com'").id; });
after(() => server.close());
async function call(ck, method, p, body) { const r = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie: ck || '' }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j }; }
async function login(email, password) { const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }); return r.status === 200 ? r.headers.get('set-cookie').split(';')[0] : null; }
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const ts = (n) => `${day(n)} 10:00:00`;

test('review periods: months, calendar and fiscal quarters and years', () => {
  const t = new Date('2026-11-19T12:00:00Z');
  assert.deepEqual([periodRange({ type: 'month' }, t).from, periodRange({ type: 'month' }, t).to, periodRange({ type: 'month' }, t).label], ['2026-11-01', '2026-11-30', 'November 2026']);
  assert.deepEqual([periodRange({ type: 'month', month: '2024-02' }, t).to], ['2024-02-29']);
  const q = periodRange({ type: 'quarter' }, t); assert.deepEqual([q.from, q.to, q.label], ['2026-10-01', '2026-12-31', 'Q4 2026']);
  const fq = periodRange({ type: 'quarter', fy_start: 4 }, t); assert.deepEqual([fq.from, fq.to, fq.label], ['2026-10-01', '2026-12-31', 'Q3 FY2027'], 'April fiscal year: Oct–Dec is Q3 of FY2027');
  const fq1 = periodRange({ type: 'quarter', fy_start: 4, quarter: '2027-Q1' }, t); assert.deepEqual([fq1.from, fq1.to], ['2026-04-01', '2026-06-30']);
  const fy = periodRange({ type: 'year', fy_start: 7, year: 2026 }, t); assert.deepEqual([fy.from, fy.to], ['2025-07-01', '2026-06-30']);
  assert.throws(() => periodRange({ type: 'custom', from: '2026-05-01', to: '2026-04-01' }), /valid/);
});

test('worst case, projected and best case add up; slipped and undated deals are estimated', async () => {
  const add = (name, amount, stage, prob, close, extra = {}) => Number(run('INSERT INTO deals (name, amount, stage, probability, close_date, created_at, closed_at, owner_id) VALUES (?,?,?,?,?,?,?,?)',
    name, amount, stage, prob, close, extra.created || ts(-5), extra.closed || null, extra.owner || null).lastInsertRowid);
  add('RPT A', 100, 'negotiation', 80, day(20), { owner: repId });
  add('RPT B', 200, 'proposal', 50, day(30));
  add('RPT C', 300, 'qualification', 10, day(40));
  add('RPT S', 400, 'proposal', 60, day(-15));               // slipped: expected date passed
  add('RPT N', 500, 'qualification', 30, null, { created: ts(0) }); // no date: estimated from the sales cycle
  add('RPT W', 1000, 'won', 100, day(-2), { created: ts(-30), closed: ts(-2) });
  add('RPT L', 50, 'lost', 0, day(-1), { created: ts(-20), closed: ts(-1) });
  add('RPT X', 9999, 'proposal', 50, day(200));               // outside the period
  const cfg = { period: { type: 'custom', from: day(-10), to: day(60) }, filters: { q: 'RPT' }, target: 2000 };
  const r = await call(admin, 'POST', '/api/reports/pipeline', cfg); assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = r.body.summary; const names = r.body.deals.map((d) => d.name).sort();
  assert.deepEqual(names, ['RPT A', 'RPT B', 'RPT C', 'RPT L', 'RPT N', 'RPT S', 'RPT W']);
  assert.equal(s.won, 1000); assert.equal(s.lost, 50); assert.equal(s.pipeline, 1500);
  assert.equal(s.worst_case, 1100, 'won + commit (≥75%)');
  assert.equal(s.best_case, 2200, 'worst case + deals ≥25%');
  assert.equal(Math.round(s.projected), 1000 + 100 + 100 + 240 + 150, 'won + commit + best-case deals × probability');
  assert.ok(s.worst_case <= s.projected && s.projected <= s.best_case, 'worst ≤ projected ≤ best');
  assert.equal(Math.round(s.weighted_open), 80 + 100 + 30 + 240 + 150);
  assert.equal(s.slipped_count, 1); assert.equal(s.win_rate, 0.5); assert.equal(s.cycle_days, 28);
  assert.equal(s.attainment, 0.5); assert.equal(s.gap_worst, 900); assert.equal(s.gap_best, -200);
  const by = Object.fromEntries(r.body.deals.map((d) => [d.name, d]));
  assert.equal(by['RPT A'].category, 'commit'); assert.equal(by['RPT B'].category, 'best_case'); assert.equal(by['RPT C'].category, 'pipeline'); assert.equal(by['RPT W'].category, 'won');
  assert.equal(by['RPT N'].estimated, true); assert.equal(by['RPT N'].est_close, day(28), 'created today + 28-day average cycle');
  assert.equal(by['RPT S'].slipped, true);
  assert.equal(r.body.by_month.reduce((a, m) => a + m.count, 0), 7, 'every deal lands in one month');
  // thresholds, scope, filters, grouping
  const t2 = (await call(admin, 'POST', '/api/reports/pipeline', { ...cfg, worst_threshold: 50, best_threshold: 0 })).body.summary;
  assert.equal(t2.worst_case, 1000 + 100 + 200 + 400); assert.equal(t2.best_case, 2500); assert.ok(t2.worst_case <= t2.projected && t2.projected <= t2.best_case);
  // a period with only a commit deal: projected can never fall below worst case
  const only = (await call(admin, 'POST', '/api/reports/pipeline', { ...cfg, filters: { q: 'RPT A' } })).body.summary; assert.equal(only.worst_case, 100); assert.equal(only.projected, 100);
  assert.ok((await call(admin, 'POST', '/api/reports/pipeline', { ...cfg, scope: 'all_open' })).body.deals.some((d) => d.name === 'RPT X'));
  assert.ok(!(await call(admin, 'POST', '/api/reports/pipeline', { ...cfg, include_slipped: false })).body.deals.some((d) => d.name === 'RPT S'));
  assert.deepEqual((await call(admin, 'POST', '/api/reports/pipeline', { ...cfg, filters: { q: 'RPT', categories: ['commit'] } })).body.deals.map((d) => d.name), ['RPT A']);
  assert.deepEqual((await call(admin, 'POST', '/api/reports/pipeline', { ...cfg, filters: { q: 'RPT', min_amount: 400, max_amount: 600 } })).body.deals.map((d) => d.name).sort(), ['RPT N', 'RPT S']);
  const g = (await call(admin, 'POST', '/api/reports/pipeline', { ...cfg, group_by: 'category' })).body.groups; assert.deepEqual(g.map((x) => x.key), ['commit', 'best_case', 'pipeline', 'won', 'lost']);
  // people who may only see their own deals only get their own deals
  run("UPDATE roles SET permissions=json_set(permissions,'$.deals.view','own') WHERE id=(SELECT role_id FROM users WHERE id=?)", repId);
  const mine = (await call(rep, 'POST', '/api/reports/pipeline', { ...cfg, scope: 'all_open', filters: {} })).body;
  assert.ok(mine.deals.length > 0); assert.ok(mine.deals.every((d) => d.owner_id === repId), 'rep sees only own deals');
});

test('report views can be saved, shared and only changed by their owner', async () => {
  const v = await call(rep, 'POST', '/api/reports/views', { name: 'My QBR', shared: true, config: { period: { type: 'quarter', fy_start: 4 }, group_by: 'stage', columns: ['name', 'amount'] } });
  assert.equal(v.status, 200); assert.equal(v.body.config.group_by, 'stage');
  const p = await call(rep, 'POST', '/api/reports/views', { name: 'Private', config: {} });
  const seen = (await call(admin, 'GET', '/api/reports/views')).body.map((x) => x.name); assert.ok(seen.includes('My QBR')); assert.ok(!seen.includes('Private'));
  const other = await login('maya@ovantaa.com', 'Ovantaa@123');
  assert.equal((await call(other, 'PUT', `/api/reports/views/${v.body.id}`, { name: 'Hijack', config: {} })).status, 403);
  assert.equal((await call(rep, 'PUT', `/api/reports/views/${v.body.id}`, { name: 'My QBR 2', shared: false, config: { group_by: 'owner' } })).body.name, 'My QBR 2');
  assert.equal((await call(rep, 'DELETE', `/api/reports/views/${p.body.id}`)).status, 200);
  assert.equal((await call(rep, 'POST', '/api/reports/views', { name: '', config: {} })).status, 400);
});
