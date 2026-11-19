import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { SEED_BILLING_DEMO: '0', DB_PATH: ':memory:', SESSION_SECRET: 'stages', BASE_URL: 'https://crm.example.com' });
const { server } = await import('../server/index.js');
const { seedIfEmpty } = await import('../server/seed.js');
const { get, run } = await import('../server/db.js');
let base, admin, rep;
before(async () => { seedIfEmpty(); await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; admin = await login('admin@ovantaa.com', 'Ovantaa@123'); rep = await login('liam@ovantaa.com', 'Ovantaa@123'); });
after(() => server.close());
async function call(ck, method, p, body) { const r = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie: ck || '' }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j }; }
async function login(email, password) { const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }); return r.status === 200 ? r.headers.get('set-cookie').split(';')[0] : null; }
const stages = async () => (await call(admin, 'GET', '/api/customization/stages')).body;
const send = (list, moves) => call(admin, 'PUT', '/api/customization/stages', { stages: list, moves });

test('only customisers can change stages; won and lost cannot be removed', async () => {
  const s = await stages(); assert.deepEqual(s.stages.map((x) => x.key), ['prospecting', 'qualification', 'proposal', 'negotiation', 'won', 'lost']);
  assert.equal((await call(rep, 'PUT', '/api/customization/stages', { stages: s.stages })).status, 403);
  assert.match((await send(s.stages.filter((x) => x.key !== 'won'))).body.error, /cannot be removed/);
  assert.match((await send(s.stages.map((x) => (x.key === 'proposal' ? { ...x, label: 'Qualification' } : x)))).body.error, /Two stages/);
  assert.match((await send(s.stages.map((x) => (x.key === 'proposal' ? { ...x, prob: 140 } : x)))).body.error, /0–100/);
});

test('rename, reorder, add a stage and change probabilities', async () => {
  const s = await stages(); const by = Object.fromEntries(s.stages.map((x) => [x.key, x]));
  const atDefault = get("SELECT COUNT(*) n FROM deals WHERE stage='proposal' AND probability=50").n;
  const custom = Number(run("INSERT INTO deals (name, amount, stage, probability) VALUES ('Own guess', 10, 'proposal', 42)").lastInsertRowid);
  const r = await send([by.prospecting, { label: 'Discovery call', prob: 15 }, { ...by.qualification, label: 'Qualified' }, { ...by.proposal, prob: 60 }, by.negotiation, { ...by.won, label: 'Won 🎉', prob: 5 }, by.lost]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.stages.map((x) => x.label), ['Prospecting', 'Discovery call', 'Qualified', 'Proposal', 'Negotiation', 'Won 🎉', 'Closed Lost']);
  assert.equal(r.body.stages.find((x) => x.label === 'Discovery call').key, 'discovery_call');
  assert.equal(r.body.stages.find((x) => x.key === 'won').prob, 100, 'won stays 100%');
  assert.equal(get("SELECT COUNT(*) n FROM deals WHERE stage='proposal' AND probability=60").n, atDefault, 'deals on the old default follow the new one');
  assert.equal(get('SELECT probability FROM deals WHERE id=?', custom).probability, 42, 'a typed probability is kept');
  const meta = (await call(rep, 'GET', '/api/meta')).body; assert.equal(meta.stages[1].key, 'discovery_call'); assert.equal(meta.stages[1].prob, 15);
  // the new stage works everywhere a stage is used
  const d = await call(rep, 'POST', '/api/deals', { name: 'New stage deal', amount: 1000, stage: 'discovery_call' }); assert.equal(d.status, 200, JSON.stringify(d.body)); assert.equal(d.body.probability, 15);
  assert.equal((await call(rep, 'POST', `/api/deals/${d.body.id}/stage`, { stage: 'proposal' })).body.probability, 60);
  assert.equal((await call(rep, 'POST', '/api/deals', { name: 'Bad', stage: 'nope' })).status, 400);
  assert.ok((await call(admin, 'GET', '/api/deals?stage=discovery_call')).status === 200);
});

test('deleting a stage with deals asks where to move them, then moves deals, history and folder files', async () => {
  const s = await stages(); const keep = s.stages.filter((x) => x.key !== 'negotiation');
  const n = get("SELECT COUNT(*) n FROM deals WHERE stage='negotiation'").n; assert.ok(n > 0);
  const deal = get("SELECT id FROM deals WHERE stage='negotiation' LIMIT 1").id;
  run("INSERT INTO files (entity, record_id, stage, name, path, mime, size, sha256) VALUES ('deals', ?, 'negotiation', 'terms.pdf', 'x/terms.pdf', 'application/pdf', 1, 'abc')", deal);
  const ask = await send(keep); assert.equal(ask.status, 400); assert.equal(ask.body.needs_move, 'negotiation'); assert.equal(ask.body.deals, n);
  assert.equal(get("SELECT COUNT(*) n FROM deals WHERE stage='negotiation'").n, n, 'nothing changed');
  const r = await send(keep, { negotiation: 'proposal' }); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.moved, [{ from: 'Negotiation', to: 'Proposal', deals: n, files: 1 }]);
  assert.equal(get("SELECT COUNT(*) n FROM deals WHERE stage='negotiation'").n, 0);
  assert.equal(get("SELECT stage FROM files WHERE name='terms.pdf'").stage, 'proposal');
  assert.match(get("SELECT comment FROM deal_stage_history WHERE deal_id=? ORDER BY id DESC LIMIT 1", deal).comment, /“Negotiation” was removed/);
  const meta = (await call(admin, 'GET', '/api/meta')).body;
  assert.ok(!meta.stages.some((x) => x.key === 'negotiation')); assert.equal(meta.stageLabels.negotiation, 'Negotiation', 'old history still reads well');
  // an empty stage can go without a move; moving to a brand-new stage works by its name
  const s2 = await stages(); const r2 = await send([...s2.stages.filter((x) => x.key !== 'discovery_call' && x.key !== 'prospecting'), { label: 'Lead in' }].map((x) => ({ prob: 10, ...x })), { prospecting: 'Lead in' });
  assert.equal(r2.status, 200, JSON.stringify(r2.body)); assert.equal(get("SELECT COUNT(*) n FROM deals WHERE stage='prospecting'").n, 0);
  assert.ok(get("SELECT COUNT(*) n FROM deals WHERE stage='lead_in'").n > 0);
  assert.equal((await call(admin, 'GET', '/api/customization')).status, 200);
});
