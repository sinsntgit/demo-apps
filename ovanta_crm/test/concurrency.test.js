import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { SEED_BILLING_DEMO: '0', DB_PATH: ':memory:', SESSION_SECRET: 'cc' });
const { server } = await import('../server/index.js');
const { seedIfEmpty } = await import('../server/seed.js');
const { get, run } = await import('../server/db.js');
let base, admin, maya, liam; const ids = {}; const streams = [];
before(async () => {
  seedIfEmpty(); await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  [admin, maya, liam] = await Promise.all(['admin@ovantaa.com', 'maya@ovantaa.com', 'liam@ovantaa.com'].map(login));
  for (const u of (await call(admin, 'GET', '/api/users')).body) ids[u.email.split('@')[0]] = u.id;
});
after(() => { for (const s of streams) s.abort(); server.closeAllConnections?.(); server.close(); });
async function call(ck, method, p, body) { const r = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie: ck || '' }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j }; }
async function login(email) { return (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Ovantaa@123' }) })).headers.get('set-cookie').split(';')[0]; }
/** Open the live stream as a user and collect events. */
async function listen(ck) {
  const ac = new AbortController(); streams.push(ac); const events = [];
  const r = await fetch(`${base}/api/live`, { headers: { cookie: ck }, signal: ac.signal });
  assert.equal(r.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  (async () => { const rd = r.body.getReader(); let buf = ''; try { for (;;) { const { value, done } = await rd.read(); if (done) break; buf += new TextDecoder().decode(value); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); const ev = /event: (\w+)/.exec(chunk)?.[1], data = /data: (.*)/.exec(chunk)?.[1]; if (ev && data) events.push({ ev, ...JSON.parse(data) }); } } } catch {} })();
  return events;
}
const waitFor = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 30)); } return fn(); };

let deal;
test('edits to different fields merge; the version goes up and remembers who saved', async () => {
  deal = (await call(admin, 'POST', '/api/deals', { name: 'Acme rollout', amount: 50000, stage: 'proposal', close_date: '2026-12-31' })).body;
  assert.equal(deal.version, 1);
  const loaded = { amount: 50000, close_date: '2026-12-31' }; // both opened the form now
  const l = await call(liam, 'PUT', `/api/deals/${deal.id}`, { amount: '60000', __base: { amount: loaded.amount } }); assert.equal(l.status, 200); assert.equal(l.body.version, 2); assert.equal(l.body.updated_by, ids.liam);
  const m = await call(maya, 'PUT', `/api/deals/${deal.id}`, { close_date: '2027-01-15', __base: { close_date: loaded.close_date } });
  assert.equal(m.status, 200); assert.equal(m.body.amount, 60000, "Liam's amount is kept"); assert.equal(m.body.close_date, '2027-01-15'); assert.equal(m.body.version, 3);
});

test('two people changing the same field: the second save stops and shows both values; choosing "mine" overwrites', async () => {
  const c = await call(maya, 'PUT', `/api/deals/${deal.id}`, { amount: 55000, __base: { amount: 50000 } });
  assert.equal(c.status, 409); assert.equal(c.body.conflict, true); assert.equal(c.body.updated_by_name, 'Maya Patel', 'last saver named (Maya saved the close date)');
  assert.deepEqual(c.body.conflicts.map((x) => [x.field, x.label, x.base, x.theirs, x.yours]), [['amount', 'Amount (USD)', '50000', '60000', '55000']]);
  assert.equal(get('SELECT amount FROM deals WHERE id=?', deal.id).amount, 60000, 'nothing saved on conflict');
  const same = await call(maya, 'PUT', `/api/deals/${deal.id}`, { amount: 60000, __base: { amount: 50000 } }); assert.equal(same.status, 200, 'same value as theirs is not a conflict');
  const forced = await call(maya, 'PUT', `/api/deals/${deal.id}`, { amount: 55000, __base: { amount: 50000 }, __force: ['amount'] }); assert.equal(forced.status, 200); assert.equal(forced.body.amount, 55000);
  const owner = await call(liam, 'PUT', `/api/deals/${deal.id}`, { owner_id: ids.liam, __base: { owner_id: deal.owner_id } }); assert.equal(owner.status, 200);
  const o2 = await call(maya, 'PUT', `/api/deals/${deal.id}`, { owner_id: ids.maya, __base: { owner_id: deal.owner_id } }); assert.equal(o2.status, 409); assert.match(o2.body.conflicts[0].theirs, /^Liam/, 'names, not ids');
  assert.equal((await call(maya, 'PUT', `/api/deals/${deal.id}`, { stage: 'won' })).status, 200, 'saves without __base (API, older clients) still work');
});

test('custom fields and tasks are protected the same way', async () => {
  await call(admin, 'POST', '/api/customization/fields', { entity: 'deals', label: 'Partner margin', type: 'percent' });
  await call(liam, 'PUT', `/api/deals/${deal.id}`, { custom: { cf_partner_margin: 10 }, __base: { custom: { cf_partner_margin: null } } });
  const c = await call(maya, 'PUT', `/api/deals/${deal.id}`, { custom: { cf_partner_margin: 12 }, __base: { custom: { cf_partner_margin: '' } } });
  assert.equal(c.status, 409); assert.equal(c.body.conflicts[0].label, 'Partner margin'); assert.equal(c.body.conflicts[0].theirs, '10');
  const t = (await call(admin, 'POST', '/api/tasks', { title: 'Shared task', due_date: '2026-12-01', owner_id: ids.maya })).body;
  assert.equal((await call(admin, 'PUT', `/api/tasks/${t.id}`, { due_date: '2026-12-05', __base: { due_date: '2026-12-01' } })).status, 200);
  const tc = await call(maya, 'PUT', `/api/tasks/${t.id}`, { due_date: '2026-12-09', __base: { due_date: '2026-12-01' } }); assert.equal(tc.status, 409); assert.equal(tc.body.conflicts[0].label, 'Due date');
});

test('changes made outside the edit form (bulk actions, background jobs) still bump the version', async () => {
  const v = get('SELECT version FROM deals WHERE id=?', deal.id).version;
  run('UPDATE deals SET probability=33 WHERE id=?', deal.id);
  const r = get('SELECT version, updated_by FROM deals WHERE id=?', deal.id); assert.equal(r.version, v + 1); assert.equal(r.updated_by, null);
});

test('live updates: changes and presence reach people who can see the record, and nobody else', async () => {
  const mayaEv = await listen(maya), adminEv = await listen(admin);
  const role = (await call(admin, 'POST', '/api/roles', { name: 'Own deals', permissions: { deals: { view: 'own', edit: 'own', create: true } } })).body;
  await call(admin, 'POST', '/api/users', { name: 'Olly', email: 'olly@cc.example', password: 'Ovantaa@123', role_id: role.id }); const olly = await login('olly@cc.example'); const ollyEv = await listen(olly);
  await new Promise((r) => setTimeout(r, 100));
  await call(liam, 'PUT', `/api/deals/${deal.id}`, { name: 'Acme rollout (phase 2)' });
  const ch = await waitFor(() => mayaEv.find((e) => e.ev === 'changed' && e.id === deal.id)); assert.ok(ch); assert.match(ch.by, /^Liam/); assert.equal(ch.entity, 'deals'); assert.ok(ch.version > 1);
  assert.ok(await waitFor(() => adminEv.some((e) => e.ev === 'changed' && e.id === deal.id)));
  await new Promise((r) => setTimeout(r, 150)); assert.ok(!ollyEv.some((e) => e.ev === 'changed' && e.id === deal.id), 'own-scope user does not hear about deals they cannot see');
  const p = await call(liam, 'POST', '/api/live/presence', { entity: 'deals', id: deal.id, mode: 'editing' }); assert.equal(p.status, 200); assert.equal(p.body.people[0].mode, 'editing');
  const pe = await waitFor(() => mayaEv.find((e) => e.ev === 'presence' && e.id === deal.id && e.people.some((x) => x.mode === 'editing'))); assert.ok(pe); assert.match(pe.people[0].name, /^Liam/);
  await call(liam, 'POST', '/api/live/presence', { entity: 'deals', id: deal.id, mode: 'left' });
  assert.ok(await waitFor(() => mayaEv.some((e) => e.ev === 'presence' && e.id === deal.id && e.people.length === 0)));
  assert.equal((await call(olly, 'POST', '/api/live/presence', { entity: 'deals', id: deal.id, mode: 'viewing' })).status, 400, 'cannot announce presence on a record you cannot see');
  // task status changes and file uploads are announced too
  const t = (await call(admin, 'POST', '/api/tasks', { title: 'Live task', owner_id: ids.maya })).body; mayaEv.length = 0;
  await call(admin, 'POST', `/api/tasks/${t.id}/comment`, { body: 'hello' });
  assert.ok(await waitFor(() => mayaEv.some((e) => e.ev === 'changed' && e.entity === 'tasks' && e.id === t.id && e.action === 'activity')));
  const fd = new FormData(); fd.append('file', new Blob(['x']), 'x.txt'); await fetch(`${base}/api/files?entity=deals&id=${deal.id}`, { method: 'POST', headers: { cookie: liam }, body: fd });
  assert.ok(await waitFor(() => mayaEv.some((e) => e.ev === 'changed' && e.id === deal.id && e.action === 'files')));
  assert.equal((await fetch(`${base}/api/live`)).status, 401, 'login required');
});
