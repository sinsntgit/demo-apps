import crypto from 'node:crypto';
import { GET, POST, PUT, bad, notFound, HttpError } from './http.js';
import { get, run, audit, nowIso } from './db.js';
import { config } from './config.js';
import { hashPassword, loadUser, revokeUserSessions, throttled, recordFail } from './auth.js';
import { systemSender, sendLogged } from './mailer.js';
import { startSession, checkPassword } from './api.js';

/*
 * Invitations and password resets: a one-time link emailed to the person, who then chooses their own password.
 * Only a hash of the token is stored; links expire (invite 7 days, reset 2 hours) and work once.
 * The token travels in the URL fragment (#/invite/…), so it is never sent to the server in a URL or logged.
 */
const TTL = { invite: 7 * 24 * 3600 * 1000, reset: 2 * 3600 * 1000 };
const hashTok = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isLocal = () => /\/\/(localhost|127\.|0\.0\.0\.0)/.test(config.baseUrl);
const until = (ms) => new Date(Date.now() + ms).toISOString().replace('T', ' ').slice(0, 19);

function makeToken(userId, kind, by) {
  const token = crypto.randomBytes(32).toString('base64url');
  run("UPDATE user_tokens SET used_at=? WHERE user_id=? AND kind=? AND used_at IS NULL", nowIso(), userId, kind); // only the newest link works
  run('INSERT INTO user_tokens (user_id, kind, token_hash, expires_at, created_by) VALUES (?,?,?,?,?)', userId, kind, hashTok(token), until(TTL[kind]), by?.id ?? null);
  return token;
}
const linkFor = (kind, token) => `${config.baseUrl}/#/${kind}/${token}`;

/** Email an invitation (or reset) link. Never throws for delivery problems: the result says what happened and includes the link. */
export async function sendAccessLink(u, kind, by) {
  const token = makeToken(u.id, kind, by); const link = linkFor(kind, token);
  const role = get('SELECT COALESCE(r.label, u.role) AS label FROM users u LEFT JOIN roles r ON r.id=u.role_id WHERE u.id=?', u.id)?.label || '';
  const invite = kind === 'invite';
  const subject = invite ? `${by?.name || 'Your administrator'} invited you to Ovantaa CRM` : 'Reset your Ovantaa CRM password';
  const lines = invite
    ? [`Hello ${u.name},`, `${by?.name || 'Your administrator'} has invited you to Ovantaa CRM${role ? ` as ${role}` : ''}.`, 'Click the button to choose your password and sign in. The link works once and expires in 7 days.', `Your sign-in email: ${u.email}`]
    : [`Hello ${u.name},`, 'We received a request to reset your Ovantaa CRM password. Click the button to choose a new one. The link works once and expires in 2 hours.', 'If you did not ask for this, you can ignore this email — your password stays the same.'];
  const button = invite ? 'Accept invitation' : 'Choose a new password';
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;color:#1f2937;line-height:1.55">${lines.map((l) => `<p>${esc(l)}</p>`).join('')}
    <p style="margin:22px 0"><a href="${esc(link)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">${button}</a></p>
    <p style="font-size:12px;color:#6b7280">If the button does not work, copy this address into your browser:<br>${esc(link)}</p></div>`;
  const sender = systemSender();
  const r = await sendLogged({ sender, to: u.email, subject, html, text: `${lines.join('\n\n')}\n\n${button}: ${link}\n`, kind: invite ? 'invite' : 'password_reset', event: `user:${u.email}` });
  if (invite) run('UPDATE users SET invited_at=? WHERE id=?', nowIso(), u.id);
  audit(by || u, invite ? 'invite_sent' : 'password_reset_sent', 'users', u.id, `${u.email} · ${r.status}${r.error ? ' · ' + r.error : ''}`);
  return { status: r.status, error: r.error || null, to: u.email, link, expires_in: invite ? '7 days' : '2 hours', via: sender ? `${sender.label} (${sender.from_email})` : 'no sender',
    simulated: !sender || sender.mode !== 'smtp', base_url_local: isLocal(), base_url: config.baseUrl };
}

/** The address people use to reach the CRM — used in every emailed link (invitations, tasks, invoices, tracking). */
export function applySavedBaseUrl() { if (!process.env.BASE_URL) { const v = get("SELECT value FROM settings WHERE key='base_url'")?.value; if (v) config.baseUrl = v; } }
applySavedBaseUrl();
GET('/api/settings/base-url', () => ({ base_url: config.baseUrl, from_env: !!process.env.BASE_URL, local: isLocal() }));
PUT('/api/settings/base-url', ({ body, user }) => {
  if (process.env.BASE_URL) throw bad('The address is set by the BASE_URL environment variable on the server; change it there.');
  const v = String(body.base_url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/?#]+(:\d+)?(\/[^\s?#]*)?$/i.test(v)) throw bad('Enter the full address, e.g. http://crm-server:3000 or https://crm.yourcompany.com');
  run("INSERT INTO settings (key,value,updated_at) VALUES ('base_url',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", v);
  config.baseUrl = v; audit(user, 'update', 'settings', 0, `public address ${v}`);
  return { base_url: v, from_env: false, local: isLocal() };
});

/** Resend an invitation (or send a "choose your password" link to an existing user). */
POST('/api/users/:id/invite', async ({ params, user }) => {
  const u = get('SELECT id, name, email, active FROM users WHERE id=?', params.id); if (!u) throw notFound();
  if (!u.active) throw bad('This user is deactivated. Activate them first.');
  return sendAccessLink(u, 'invite', user);
});

function tokenRow(kind, token) {
  const t = get("SELECT t.*, u.name, u.email, u.active, u.totp_enabled FROM user_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.kind=?", hashTok(token), kind);
  if (!t || t.used_at || t.expires_at < nowIso() || !t.active) return null;
  return t;
}
for (const kind of ['invite', 'reset']) {
  GET(`/api/${kind}/:token`, ({ params }) => {
    const t = tokenRow(kind, params.token);
    if (!t) throw new HttpError(410, kind === 'invite' ? 'This invitation link has expired or was already used. Ask your administrator to send a new one.' : 'This reset link has expired or was already used. Request a new one from the sign-in page.');
    return { name: t.name, email: t.email, kind };
  }, { public: true });
  POST(`/api/${kind}/:token`, ({ params, body, req, send }) => {
    const t = tokenRow(kind, params.token); if (!t) throw new HttpError(410, 'This link has expired or was already used.');
    checkPassword(body.password);
    run('UPDATE users SET password_hash=?, invite_pending=0 WHERE id=?', hashPassword(body.password), t.user_id);
    run('UPDATE user_tokens SET used_at=? WHERE id=?', nowIso(), t.id);
    revokeUserSessions(t.user_id); // a new password ends every other session
    audit(loadUser(t.user_id), kind === 'invite' ? 'invite_accepted' : 'password_reset', 'users', t.user_id, t.email);
    // someone with two-factor on still has to pass it: send them to the normal sign-in
    if (t.totp_enabled) return send(200, { ok: true, login_required: true });
    startSession(loadUser(t.user_id), req, send);
  }, { public: true });
}

/** "Forgot password?" — always answers the same way so it does not reveal which emails have accounts. */
POST('/api/auth/forgot', async ({ body, req }) => {
  const email = String(body.email || '').trim().toLowerCase(); const key = `forgot|${req.socket.remoteAddress}`;
  if (throttled(key)) throw new HttpError(429, 'Too many requests. Try again in a few minutes.');
  recordFail(key); // counts requests, not failures: at most 8 per 10 minutes per address
  const u = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? get('SELECT id, name, email FROM users WHERE email=? AND active=1', email) : null;
  if (u) await sendAccessLink(u, 'reset', null);
  return { ok: true, message: 'If that email has an account, we have sent a link to reset the password. Check your inbox and spam folder.' };
}, { public: true });
