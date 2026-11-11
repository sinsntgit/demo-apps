import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { SMTPServer } = createRequire(import.meta.url)('smtp-server');

// A real (local) SMTP server: proves task emails are actually delivered, not just logged.
const inbox = [];
const smtp = new SMTPServer({ authOptional: false, logger: false,
  onAuth(a, _s, cb) { a.username === 'crm@syncsense.in' && a.password === 'good-pass' ? cb(null, { user: 1 }) : cb(Object.assign(new Error('authentication failed'), { responseCode: 535 })); },
  onData(stream, s, cb) { let raw = ''; stream.on('data', (c) => (raw += c)); stream.on('end', () => { inbox.push({ raw: raw.replace(/=\r?\n/g, ''), to: s.envelope.rcptTo.map((r) => r.address) }); cb(); }); } });
await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
Object.assign(process.env, { SEED_BILLING_DEMO: '0', DB_PATH: ':memory:', SESSION_SECRET: 'te', BASE_URL: 'https://crm.example.com', SMTP_TIMEOUT_MS: '3000', SMTP_TLS_INSECURE: '1' });
const { server } = await import('../server/index.js');
const { seedIfEmpty } = await import('../server/seed.js');
const { all, get } = await import('../server/db.js');
let base, admin; const ids = {};
before(async () => { seedIfEmpty(); await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; admin = await login('admin@ovantaa.com'); for (const u of (await call(admin, 'GET', '/api/users')).body) ids[u.email.split('@')[0]] = u.id; });
after(() => { server.close(); smtp.close(); });
async function call(ck, method, p, body) { const r = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie: ck || '' }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j }; }
async function login(email) { return (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Ovantaa@123' }) })).headers.get('set-cookie').split(';')[0]; }
const waitFor = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } return fn(); };
const sender = (extra = {}) => ({ label: 'SyncSense CRM', from_name: 'Ovantaa', from_email: 'crm@syncsense.in', mode: 'smtp', host: '127.0.0.1', port: smtp.server.address().port, secure: false, username: 'crm@syncsense.in', password: 'good-pass', delay_ms: 0, ...extra });

test('with only the demo simulation sender, the UI is told nothing was emailed', async () => {
  assert.equal((await call(admin, 'GET', '/api/tasks-summary')).body.email.real, false);
  const t = (await call(admin, 'POST', '/api/tasks', { title: 'Sim task', owner_id: ids.maya, due_date: '2026-12-01' })).body;
  assert.equal(t.email_notice.simulated, true); assert.match(t.email_notice.to[0], /maya@ovantaa.com/);
});

test('a real sender is used for task emails even if the simulation sender is still the default', async () => {
  const s = (await call(admin, 'POST', '/api/senders', sender())).body; assert.equal(s.is_default, true, 'first real mailbox becomes the default');
  const sim = (await call(admin, 'GET', '/api/senders')).body.find((x) => x.mode === 'simulate');
  await call(admin, 'PUT', `/api/senders/${sim.id}`, { ...sim, is_default: true }); // someone puts the demo sender back as default
  assert.equal((await call(admin, 'GET', '/api/tasks-summary')).body.email.real, true);
  const t = (await call(admin, 'POST', '/api/tasks', { title: 'Collect signed PO', owner_id: ids.maya, due_date: '2026-12-15', assign_note: 'Customer promised it' })).body;
  assert.equal(t.email_notice.simulated, false); assert.match(t.email_notice.via, /crm@syncsense.in/);
  const m = await waitFor(() => inbox.find((x) => x.to.includes('maya@ovantaa.com') && /Collect signed PO/.test(x.raw)));
  assert.ok(m, 'assignment email delivered over SMTP'); assert.match(m.raw, /15 Dec 2026/); assert.match(m.raw, /Customer promised it/); assert.match(m.raw, /https:\/\/crm\.example\.com\/#\/tasks\?task=/);
  // any change: editing the due date emails the assignee
  const maya = await login('maya@ovantaa.com'); const n0 = inbox.length;
  const e = (await call(admin, 'PUT', `/api/tasks/${t.id}`, { due_date: '2026-12-20', priority: 'high' })).body; assert.equal(e.email_notice.to.length, 1);
  const um = await waitFor(() => inbox.slice(n0).find((x) => /Task updated: Collect signed PO/.test(x.raw))); assert.ok(um); assert.match(um.raw, /20 Dec 2026/); assert.match(um.raw, /Priority: medium/); assert.match(um.raw, /Due date: /);
  // reassign, comment, issue, complete: every step sends a real email
  const steps = [
    () => call(admin, 'POST', `/api/tasks/${t.id}/assign`, { owner_id: ids.liam, note: 'Liam takes over' }),
    () => call(admin, 'POST', `/api/tasks/${t.id}/comment`, { body: 'Ping' }),
  ];
  for (const s of steps) { const r = await s(); assert.equal(r.status, 200); assert.equal(r.body.mail.simulated, false); }
  const liam = await login('liam@ovantaa.com');
  assert.equal((await call(liam, 'POST', `/api/tasks/${t.id}/status`, { status: 'issue', note: 'PO missing' })).body.mail.to[0].includes('admin@ovantaa.com'), true);
  await waitFor(() => inbox.filter((x) => x.to.includes('admin@ovantaa.com')).length >= 1);
  const subjects = () => inbox.map((x) => (x.raw.match(/^Subject: (.*)$/m) || [])[1]);
  assert.ok(await waitFor(() => subjects().some((s) => /Task reassigned to you/.test(s)) && subjects().some((s) => /Task moved to Liam/.test(s)) && subjects().some((s) => /New reply on task/.test(s)) && subjects().some((s) => /Issue raised on task/.test(s))), JSON.stringify(subjects()));
  await call(admin, 'DELETE', `/api/tasks/${t.id}`); assert.ok(await waitFor(() => subjects().some((s) => /Task deleted: Collect signed PO/.test(s))));
  void maya;
});

test('a failed email is shown on the task timeline with the server error', async () => {
  const bad = (await call(admin, 'GET', '/api/senders')).body.find((x) => x.mode === 'smtp');
  await call(admin, 'PUT', `/api/senders/${bad.id}`, { ...sender(), password: 'wrong-pass', is_default: true });
  const t = (await call(admin, 'POST', '/api/tasks', { title: 'Will fail', owner_id: ids.maya })).body;
  const ev = await waitFor(() => get("SELECT * FROM task_events WHERE task_id=? AND kind='email_failed'", t.id), 8000);
  assert.ok(ev, 'failure recorded'); assert.match(ev.body, /maya@ovantaa.com/); assert.match(ev.body, /Authentication failed/i);
  assert.ok(all("SELECT * FROM email_log WHERE kind='task' AND status='failed'").length >= 1);
});

test('"Send me a test task email" reports the real outcome', async () => {
  const s = (await call(admin, 'GET', '/api/senders')).body.find((x) => x.mode === 'smtp');
  await call(admin, 'PUT', `/api/senders/${s.id}`, { ...sender(), is_default: true });
  const ok = (await call(admin, 'POST', '/api/tasks/test-email')).body; assert.equal(ok.status, 'sent', JSON.stringify(ok)); assert.equal(ok.to, 'admin@ovantaa.com');
  assert.ok(await waitFor(() => inbox.find((x) => /test task email/i.test(x.raw) && x.to.includes('admin@ovantaa.com'))));
  await call(admin, 'PUT', `/api/senders/${s.id}`, { ...sender(), password: 'nope' });
  const bad = (await call(admin, 'POST', '/api/tasks/test-email')).body; assert.equal(bad.status, 'failed'); assert.match(bad.error, /Authentication failed/i);
  assert.match((await call(admin, 'GET', '/api/meta')).body.version, /^\d+\.\d+\.\d+$/);
});

test('tasks only you are on: the app says why nobody was emailed, and "copy me" sends you the email', async () => {
  const s = (await call(admin, 'GET', '/api/senders')).body.find((x) => x.mode === 'smtp');
  await call(admin, 'PUT', `/api/senders/${s.id}`, { ...sender(), is_default: true });
  const mine = (await call(admin, 'POST', '/api/tasks', { title: 'Solo task', due_date: '2026-12-02' })).body;
  assert.deepEqual(mine.email_notice.to, []); assert.match(mine.email_notice.skipped[0], /only person on this task/);
  assert.equal((await call(admin, 'GET', '/api/tasks-summary')).body.copy_me, false);
  assert.equal((await call(admin, 'POST', '/api/tasks/prefs', { copy_me: true })).status, 200); assert.equal((await call(admin, 'GET', '/api/tasks-summary')).body.copy_me, true);
  const n0 = inbox.length;
  const solo2 = (await call(admin, 'POST', '/api/tasks', { title: 'Solo with copy', due_date: '2026-12-03' })).body; assert.deepEqual(solo2.email_notice.to, ['Admin User <admin@ovantaa.com>']);
  const ed = (await call(admin, 'PUT', `/api/tasks/${solo2.id}`, { due_date: '2026-12-09' })).body; assert.equal(ed.email_notice.to.length, 1);
  const got = await waitFor(() => inbox.slice(n0).filter((x) => x.to.includes('admin@ovantaa.com')).length >= 2 && inbox.slice(n0));
  assert.ok(got, 'copies delivered'); assert.ok(got.some((x) => /New task for you: Solo with copy/.test(x.raw)) && got.some((x) => /Task updated: Solo with copy/.test(x.raw)));
  // a teammate without an email address is named in the explanation
  await call(admin, 'POST', '/api/tasks/prefs', { copy_me: false });
  const t = (await call(admin, 'POST', '/api/tasks', { title: 'To Maya', owner_id: ids.maya })).body; assert.match(t.email_notice.to[0], /maya@ovantaa.com/);
});
