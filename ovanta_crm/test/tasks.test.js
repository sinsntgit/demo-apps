import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-'));
Object.assign(process.env, { SEED_BILLING_DEMO: '0', DB_PATH: ':memory:', SESSION_SECRET: 'tasks', FILES_DIR: path.join(tmp, 'files'), BASE_URL: 'https://crm.example.com' });
const { server } = await import('../server/index.js');
const { seedIfEmpty } = await import('../server/seed.js');
const { all, get } = await import('../server/db.js');
let base, admin, liam, maya, ids = {};
before(async () => {
  seedIfEmpty(); await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  [admin, liam, maya] = await Promise.all(['admin@ovantaa.com', 'liam@ovantaa.com', 'maya@ovantaa.com'].map(login));
  for (const u of (await call(admin, 'GET', '/api/users')).body) ids[u.email.split('@')[0]] = u.id;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
async function call(ck, method, p, body) {
  const r = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie: ck || '' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j };
}
async function login(email) { return (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Ovantaa@123' }) })).headers.get('set-cookie').split(';')[0]; }
const settle = () => new Promise((r) => setTimeout(r, 80));
const mails = (to) => all("SELECT * FROM email_log WHERE kind='task' AND to_email=? ORDER BY id", to);

let task;
test('assigning a task emails the assignee with the due date and a link', async () => {
  const r = await call(admin, 'POST', '/api/tasks', { title: 'Prepare partner pricing', due_date: '2026-12-05', priority: 'high', owner_id: ids.liam, notes: 'Use the Q4 rate card', assign_note: 'Need it before the review' });
  assert.equal(r.status, 200, JSON.stringify(r.body)); task = r.body;
  assert.equal(task.owner_id, ids.liam); assert.equal(task.assigned_by, ids.admin); assert.equal(task.status, 'open'); assert.equal(task.assigned_by_name, 'Admin User');
  await settle(); const m = mails('liam@ovantaa.com'); assert.equal(m.length, 1);
  assert.match(m[0].subject, /New task for you: Prepare partner pricing \(due Sat, 5 Dec 2026\)/);
  assert.equal(mails('admin@ovantaa.com').length, 0, 'the assigner is not emailed about their own action');
  const self = (await call(admin, 'POST', '/api/tasks', { title: 'Note to self' })).body; assert.equal(self.owner_id, ids.admin); await settle(); assert.equal(mails('admin@ovantaa.com').length, 0, 'no email for a task you give yourself');
  assert.equal((await call(admin, 'POST', '/api/tasks', { title: 'x', owner_id: 99999 })).status, 400);
});

test('the assignee sees their tasks, raises an issue with files, and the assigner is emailed', async () => {
  const mine = (await call(liam, 'GET', '/api/tasks?mine=to_me&limit=100')).body.rows; assert.ok(mine.some((t) => t.id === task.id));
  assert.equal((await call(liam, 'GET', '/api/tasks-summary')).body.to_me_open >= 1, true);
  assert.equal((await call(liam, 'POST', `/api/tasks/${task.id}/status`, { status: 'issue' })).status, 400, 'an issue needs a description');
  const r = await call(liam, 'POST', `/api/tasks/${task.id}/status`, { status: 'issue', note: 'The Q4 rate card is missing the partner tier' });
  assert.equal(r.status, 200); assert.equal(r.body.task.status, 'issue'); assert.equal(r.body.task.done, 0);
  const fd = new FormData(); fd.append('file', new Blob(['draft'], { type: 'text/plain' }), 'draft-pricing.txt'); fd.append('file', new Blob(['a,b'], { type: 'text/csv' }), 'tiers.csv');
  const up = await fetch(`${base}/api/files?entity=tasks&id=${task.id}`, { method: 'POST', headers: { cookie: liam }, body: fd }); assert.equal(up.status, 200); assert.equal((await up.json()).files.length, 2);
  await settle(); const m = mails('admin@ovantaa.com'); assert.equal(m.length, 1); assert.match(m[0].subject, /Issue raised on task: Prepare partner pricing/);
  const act = (await call(admin, 'GET', `/api/tasks/${task.id}/activity`)).body; assert.equal(act.files.length, 2); assert.ok(act.is_assigner);
  assert.deepEqual(act.events.map((e) => e.kind), ['assigned', 'issue']); assert.match(act.events[1].body, /partner tier/);
  assert.equal((await call(admin, 'GET', '/api/tasks-summary')).body.by_me_issues, 1);
});

test('the assigner replies, then sends it back or reassigns; everyone involved is emailed', async () => {
  const c = await call(admin, 'POST', `/api/tasks/${task.id}/comment`, { body: 'Partner tier added to the sheet' }); assert.equal(c.status, 200);
  await settle(); assert.equal(mails('liam@ovantaa.com').length, 2); assert.match(mails('liam@ovantaa.com')[1].subject, /New reply on task/);
  const back = await call(admin, 'POST', `/api/tasks/${task.id}/assign`, { owner_id: ids.liam, due_date: '2026-12-08', note: 'Fixed — please continue' });
  assert.equal(back.status, 200); assert.equal(back.body.task.status, 'open'); assert.equal(back.body.task.due_date, '2026-12-08');
  await settle(); assert.match(mails('liam@ovantaa.com').at(-1).subject, /sent back to you: Prepare partner pricing \(due Tue, 8 Dec 2026\)/);
  const re = await call(admin, 'POST', `/api/tasks/${task.id}/assign`, { owner_id: ids.maya, note: 'Liam is out, Maya please finish' });
  assert.equal(re.status, 200); assert.equal(re.body.task.owner_id, ids.maya); assert.equal(re.body.task.status, 'open');
  await settle(); assert.match(mails('maya@ovantaa.com').at(-1).subject, /Task reassigned to you/); assert.match(mails('liam@ovantaa.com').at(-1).subject, /Task moved to Maya/);
  assert.deepEqual(re.body.events.map((e) => e.kind), ['assigned', 'issue', 'comment', 'reassigned', 'reassigned']);
  const done = await call(maya, 'POST', `/api/tasks/${task.id}/status`, { status: 'done', note: 'Sent to the partner' }); assert.equal(done.status, 200); assert.equal(done.body.task.done, 1); assert.ok(done.body.task.completed_at);
  await settle(); assert.match(mails('admin@ovantaa.com').at(-1).subject, /Task completed: Prepare partner pricing/);
});

test('who can see and act: assigners keep seeing tasks they delegated; outsiders cannot act', async () => {
  const role = (await call(admin, 'POST', '/api/roles', { name: 'Own tasks', permissions: { tasks: { view: 'own', create: true, edit: 'own', delete: 'own' }, attachments: { view: true, upload: true } } })).body;
  for (const n of ['ana', 'ben']) await call(admin, 'POST', '/api/users', { name: n.toUpperCase(), email: `${n}@t.example`, password: 'Ovantaa@123', role_id: role.id });
  const ana = await login('ana@t.example'), ben = await login('ben@t.example'); const users = (await call(admin, 'GET', '/api/users')).body; const benId = users.find((u) => u.email === 'ben@t.example').id;
  const t = (await call(ana, 'POST', '/api/tasks', { title: 'Ana asks Ben', owner_id: benId, due_date: '2026-12-01' })).body; assert.equal(t.owner_id, benId);
  assert.ok((await call(ana, 'GET', '/api/tasks?limit=100')).body.rows.some((x) => x.id === t.id), 'own-scope assigner still sees it');
  assert.ok((await call(ana, 'GET', '/api/tasks?mine=by_me')).body.rows.some((x) => x.id === t.id));
  assert.equal((await call(ben, 'POST', `/api/tasks/${t.id}/status`, { status: 'issue', note: 'Need the customer file' })).status, 200);
  assert.equal((await call(ana, 'POST', `/api/tasks/${t.id}/comment`, { body: 'Attached it' })).status, 200);
  const other = (await call(admin, 'POST', '/api/tasks', { title: 'Admin private', owner_id: ids.maya })).body;
  assert.equal((await call(ana, 'GET', `/api/tasks/${other.id}/activity`)).status, 404); assert.equal((await call(ana, 'POST', `/api/tasks/${other.id}/status`, { status: 'done' })).status, 404);
  const fd = new FormData(); fd.append('file', new Blob(['x']), 'x.txt'); assert.equal((await fetch(`${base}/api/files?entity=tasks&id=${other.id}`, { method: 'POST', headers: { cookie: ana }, body: fd })).status, 404);
  // the old checkbox toggle follows the same rules and keeps status in step
  const tg = await call(ben, 'POST', `/api/tasks/${t.id}/toggle`); assert.equal(tg.status, 200); assert.equal(tg.body.status, 'done');
  assert.equal(get('SELECT done FROM tasks WHERE id=?', t.id).done, 1);
});

test('only administrators can delete files (deal stage folders and tasks) — not managers, reps or custom roles', async () => {
  const deal = (await call(admin, 'POST', '/api/deals', { name: 'File-guard deal', stage: 'proposal', owner_id: ids.maya })).body;
  const up = async (ck, q) => { const fd = new FormData(); fd.append('file', new Blob(['x']), 'po.txt'); return (await (await fetch(`${base}/api/files?${q}`, { method: 'POST', headers: { cookie: ck }, body: fd })).json()).files[0]; };
  const dealFile = await up(maya, `entity=deals&id=${deal.id}&stage=proposal`); const taskFile = await up(maya, `entity=tasks&id=${task.id}`);
  const role = (await call(admin, 'POST', '/api/roles', { name: 'Everything but admin', permissions: { deals: { view: 'all', edit: 'all', delete: 'all' }, tasks: { view: 'all', edit: 'all', delete: 'all' }, attachments: { view: true, upload: true, delete: true } } })).body;
  await call(admin, 'POST', '/api/users', { name: 'Power', email: 'power@t.example', password: 'Ovantaa@123', role_id: role.id }); const power = await login('power@t.example');
  assert.equal((await call(power, 'GET', '/api/auth/me')).body.user.perms.attachments.delete, undefined, 'the delete permission cannot be granted any more');
  for (const ck of [maya, liam, power]) for (const f of [dealFile, taskFile]) assert.equal((await call(ck, 'DELETE', `/api/files/${f.id}`)).status, 403);
  assert.equal((await call(maya, 'GET', `/api/files?entity=deals&id=${deal.id}`)).body.length, 1, 'file still there');
  assert.equal((await call(admin, 'GET', '/api/auth/me')).body.user.is_admin, true); assert.equal((await call(maya, 'GET', '/api/auth/me')).body.user.is_admin, false);
  for (const f of [dealFile, taskFile]) assert.equal((await call(admin, 'DELETE', `/api/files/${f.id}`)).status, 200);
  assert.ok(all("SELECT * FROM audit_log WHERE action='delete_file'").length >= 2);
});
