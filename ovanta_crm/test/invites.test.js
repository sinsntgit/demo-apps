import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { SMTPServer } = createRequire(import.meta.url)('smtp-server');

const inbox = [];
const smtp = new SMTPServer({ authOptional: false, logger: false, onAuth(_a, _s, cb) { cb(null, { user: 1 }); },
  onData(stream, s, cb) { let raw = ''; stream.on('data', (c) => (raw += c)); stream.on('end', () => { inbox.push({ raw: raw.replace(/=\r?\n/g, '').replace(/=3D/g, '='), to: s.envelope.rcptTo.map((r) => r.address) }); cb(); }); } });
await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
Object.assign(process.env, { SEED_BILLING_DEMO: '0', DB_PATH: ':memory:', SESSION_SECRET: 'inv', BASE_URL: 'https://crm.example.com', SMTP_TLS_INSECURE: '1', SMTP_TIMEOUT_MS: '3000' });
const { server } = await import('../server/index.js');
const { seedIfEmpty } = await import('../server/seed.js');
const { run, get } = await import('../server/db.js');
let base, admin;
before(async () => { seedIfEmpty(); await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; admin = await login('admin@ovantaa.com', 'Ovantaa@123'); });
after(() => { server.close(); smtp.close(); });
async function call(ck, method, p, body) { const r = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie: ck || '' }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j, cookie: r.headers.get('set-cookie')?.split(';')[0] }; }
async function login(email, password) { const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }); return r.status === 200 ? r.headers.get('set-cookie').split(';')[0] : null; }
const tokenIn = (raw, kind) => raw.match(new RegExp(`/#/${kind}/([\\w-]{20,})`))?.[1];

test('without a real sender the admin is told, and still gets a link to share', async () => {
  const r = await call(admin, 'POST', '/api/users', { name: 'Sim Person', email: 'sim@team.example', role: 'rep' });
  assert.equal(r.status, 200); assert.equal(r.body.invite_pending, 1); assert.equal(r.body.invite.simulated, true);
  assert.match(r.body.invite.link, /^https:\/\/crm\.example\.com\/#\/invite\/[\w-]{40,}$/);
});

test('inviting emails a one-time link; accepting sets the password and signs the person in', async () => {
  await call(admin, 'POST', '/api/senders', { label: 'Team', from_email: 'crm@team.example', mode: 'smtp', host: '127.0.0.1', port: smtp.server.address().port, secure: false, username: 'crm@team.example', password: 'x', delay_ms: 0 });
  const rep = await login('liam@ovantaa.com', 'Ovantaa@123');
  assert.equal((await call(rep, 'POST', '/api/users', { name: 'X', email: 'x@team.example', role: 'rep' })).status, 403, 'only user managers invite');
  const r = await call(admin, 'POST', '/api/users', { name: 'Janvi Rao', email: 'janvi@syncsense.in', role: 'manager' });
  assert.equal(r.body.invite.status, 'sent', JSON.stringify(r.body.invite)); assert.equal(r.body.invite.base_url_local, false);
  const mail = inbox.find((m) => m.to.includes('janvi@syncsense.in')); assert.ok(mail);
  assert.match(mail.raw, /Admin User invited you to Ovantaa CRM/); assert.match(mail.raw, /as Manager/); assert.match(mail.raw, /Accept invitation/);
  const token = tokenIn(mail.raw, 'invite'); assert.ok(token);
  assert.equal(await login('janvi@syncsense.in', ''), null, 'cannot sign in before accepting');
  const info = await call(null, 'GET', `/api/invite/${token}`); assert.equal(info.status, 200); assert.deepEqual(info.body, { name: 'Janvi Rao', email: 'janvi@syncsense.in', kind: 'invite' });
  assert.equal((await call(null, 'POST', `/api/invite/${token}`, { password: 'short' })).status, 400);
  const acc = await call(null, 'POST', `/api/invite/${token}`, { password: 'Welcome2026' }); assert.equal(acc.status, 200); assert.equal(acc.body.user.email, 'janvi@syncsense.in');
  assert.equal((await call(acc.cookie, 'GET', '/api/auth/me')).status, 200, 'signed in straight away');
  assert.ok(await login('janvi@syncsense.in', 'Welcome2026'));
  assert.equal((await call(null, 'GET', `/api/invite/${token}`)).status, 410, 'a link works once');
  assert.equal((await call(null, 'POST', `/api/invite/${token}`, { password: 'Another2026' })).status, 410);
  assert.equal(get('SELECT invite_pending FROM users WHERE email=?', 'janvi@syncsense.in').invite_pending, 0);
  assert.ok((await call(admin, 'GET', '/api/audit')).body.some((a) => a.action === 'invite_accepted'));
});

test('resending replaces the old link; links expire; deactivated users cannot use them; a password can still be set directly', async () => {
  const r = await call(admin, 'POST', '/api/users', { name: 'Ravi K', email: 'ravi@syncsense.in', role: 'rep' });
  const first = tokenIn(r.body.invite.link, 'invite');
  const again = await call(admin, 'POST', `/api/users/${r.body.id}/invite`); assert.equal(again.body.status, 'sent');
  assert.equal((await call(null, 'GET', `/api/invite/${first}`)).status, 410, 'old link no longer works');
  const second = tokenIn(again.body.link, 'invite'); assert.equal((await call(null, 'GET', `/api/invite/${second}`)).status, 200);
  run("UPDATE user_tokens SET expires_at='2000-01-01 00:00:00' WHERE user_id=?", r.body.id); assert.equal((await call(null, 'GET', `/api/invite/${second}`)).status, 410, 'expired');
  const third = tokenIn((await call(admin, 'POST', `/api/users/${r.body.id}/invite`)).body.link, 'invite');
  await call(admin, 'PUT', `/api/users/${r.body.id}`, { name: 'Ravi K', role: 'rep', active: false });
  assert.equal((await call(null, 'GET', `/api/invite/${third}`)).status, 410, 'deactivated'); assert.equal((await call(admin, 'POST', `/api/users/${r.body.id}/invite`)).status, 400);
  const direct = await call(admin, 'POST', '/api/users', { name: 'Direct', email: 'direct@team.example', role: 'rep', send_invite: false, password: 'Direct2026x' });
  assert.equal(direct.body.invite, undefined); assert.equal(direct.body.invite_pending, 0); assert.ok(await login('direct@team.example', 'Direct2026x'));
  assert.equal((await call(admin, 'POST', '/api/users', { name: 'NoPw', email: 'nopw@team.example', role: 'rep', send_invite: false })).status, 400, 'a password is needed when not inviting');
});

test('forgot password: same answer for unknown emails, a 2-hour reset link for real ones, old sessions end', async () => {
  const n0 = inbox.length;
  const unknown = await call(null, 'POST', '/api/auth/forgot', { email: 'nobody@nowhere.example' });
  const known = await call(null, 'POST', '/api/auth/forgot', { email: 'Maya@ovantaa.com' });
  assert.equal(unknown.status, 200); assert.deepEqual(unknown.body, known.body, 'does not reveal which emails exist');
  const mail = inbox.slice(n0).find((m) => m.to.includes('maya@ovantaa.com')); assert.ok(mail); assert.match(mail.raw, /expires in 2 hours/);
  assert.equal(inbox.slice(n0).filter((m) => m.to.includes('nobody@nowhere.example')).length, 0);
  const old = await login('maya@ovantaa.com', 'Ovantaa@123');
  const t = tokenIn(mail.raw, 'reset'); assert.equal((await call(null, 'GET', `/api/invite/${t}`)).status, 410, 'a reset link is not an invitation');
  const r = await call(null, 'POST', `/api/reset/${t}`, { password: 'NewMaya2026' }); assert.equal(r.status, 200);
  assert.equal((await call(old, 'GET', '/api/auth/me')).status, 401, 'other sessions are signed out'); assert.ok(await login('maya@ovantaa.com', 'NewMaya2026'));
  assert.equal(await login('maya@ovantaa.com', 'Ovantaa@123'), null);
});

test('a reset for someone with two-factor still requires the second factor', async () => {
  run("UPDATE users SET totp_enabled=1, totp_secret_enc='x' WHERE email='liam@ovantaa.com'");
  const n0 = inbox.length; await call(null, 'POST', '/api/auth/forgot', { email: 'liam@ovantaa.com' });
  const mail = inbox.slice(n0).find((m) => m.to.includes('liam@ovantaa.com')); const t = tokenIn(mail.raw, 'reset');
  const r = await call(null, 'POST', `/api/reset/${t}`, { password: 'LiamNew2026' }); assert.equal(r.status, 200); assert.equal(r.body.login_required, true); assert.equal(r.cookie, undefined, 'no session without the code');
});

test('the public address can be saved in Settings and is used in links (unless BASE_URL is set)', async () => {
  assert.equal((await call(admin, 'PUT', '/api/settings/base-url', { base_url: 'http://crm-server:3000' })).status, 400, 'BASE_URL from the environment wins');
  const { config } = await import('../server/config.js'); const saved = process.env.BASE_URL; delete process.env.BASE_URL;
  try {
    assert.equal((await call(admin, 'PUT', '/api/settings/base-url', { base_url: 'not a url' })).status, 400);
    const r = await call(admin, 'PUT', '/api/settings/base-url', { base_url: 'http://crm-server:3000/' }); assert.equal(r.status, 200); assert.equal(r.body.base_url, 'http://crm-server:3000');
    const inv = await call(admin, 'POST', '/api/users', { name: 'Linky', email: 'linky@team.example', role: 'rep' }); assert.match(inv.body.invite.link, /^http:\/\/crm-server:3000\/#\/invite\//); assert.equal(inv.body.invite.base_url_local, false);
    const rep = await login('direct@team.example', 'Direct2026x'); assert.equal((await call(rep, 'PUT', '/api/settings/base-url', { base_url: 'http://x:1' })).status, 403);
  } finally { process.env.BASE_URL = saved; config.baseUrl = saved; }
});
