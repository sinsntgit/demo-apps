import { GET, POST, PUT, DELETE, HttpError, bad, notFound } from './http.js';
import { all, get, run, audit } from './db.js';
import {
  readChallenge, verifyPasswordFor, encryptSecret, decryptSecret, revokeSession, revokeUserSessions, throttled, recordFail, clearFails, loadUser,
} from './auth.js';
import { verifyTotp, newSecret, otpauthUrl, newRecoveryCodes, hashRecovery } from './totp.js';
import { getSetting, setSetting } from './settings.js';
import { startSession, twofaRequired } from './api.js';

const POLICIES = ['off', 'admins', 'all'];
const remaining = (uid) => get('SELECT COUNT(*) n FROM recovery_codes WHERE user_id=? AND used_at IS NULL', uid).n;

function issueRecoveryCodes(uid) {
  const codes = newRecoveryCodes(10);
  run('DELETE FROM recovery_codes WHERE user_id=?', uid);
  for (const c of codes) run('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?,?)', uid, hashRecovery(c));
  return codes;
}

/** Second step of login: a correct authenticator code or an unused recovery code, within the signed challenge window. */
POST('/api/auth/2fa', ({ body, req, send }) => {
  const ch = readChallenge(body.challenge); if (!ch) throw Object.assign(bad('Your sign-in expired. Enter your password again.'), { status: 401 });
  const key = `2fa|${ch.uid}`;
  if (throttled(key)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  const u = get('SELECT * FROM users WHERE id=? AND active=1 AND totp_enabled=1', ch.uid); if (!u) throw Object.assign(bad('Your sign-in expired. Enter your password again.'), { status: 401 });
  let ok = false;
  if (body.recovery_code) {
    const h = hashRecovery(body.recovery_code);
    const rc = get('SELECT id FROM recovery_codes WHERE user_id=? AND code_hash=? AND used_at IS NULL', u.id, h);
    if (rc) { run("UPDATE recovery_codes SET used_at=datetime('now') WHERE id=?", rc.id); ok = true; audit(u, '2fa_recovery_used', 'users', u.id, `${remaining(u.id)} left`); }
  } else {
    const step = verifyTotp(decryptSecret(u.totp_secret_enc), body.code, { lastStep: u.totp_last_step });
    if (step !== null) { run('UPDATE users SET totp_last_step=? WHERE id=?', step, u.id); ok = true; }
  }
  if (!ok) { recordFail(key); throw Object.assign(bad(body.recovery_code ? 'That recovery code is not valid or was already used' : 'That code is not correct'), { status: 401 }); }
  clearFails(key);
  startSession(loadUser(u.id), req, send);
}, { public: true });

// ---------- own two-factor settings ----------
GET('/api/2fa/status', ({ user }) => ({ enabled: user.twofa_enabled, recovery_left: user.twofa_enabled ? remaining(user.id) : 0, required: twofaRequired(user), policy: getSetting('security.require_2fa', 'off') }));

POST('/api/2fa/setup', async ({ user }) => {
  if (user.twofa_enabled) throw bad('Two-factor authentication is already on. Turn it off first to set up a new device.');
  const secret = newSecret();
  run('UPDATE users SET totp_secret_enc=?, totp_enabled=0, totp_last_step=0 WHERE id=?', encryptSecret(secret), user.id);
  const url = otpauthUrl(secret, user.email);
  let qr = null;
  try { const QR = (await import('qrcode')).default; qr = await QR.toDataURL(url, { margin: 1, width: 220 }); } catch { /* the typed secret still works */ }
  return { secret, url, qr };
});

POST('/api/2fa/enable', ({ user, body }) => {
  const u = get('SELECT * FROM users WHERE id=?', user.id);
  if (u.totp_enabled) throw bad('Two-factor authentication is already on');
  if (!u.totp_secret_enc) throw bad('Start the set-up first');
  const step = verifyTotp(decryptSecret(u.totp_secret_enc), body.code, { lastStep: 0 });
  if (step === null) throw bad('That code is not correct. Check the time on your phone and try the next code.');
  run("UPDATE users SET totp_enabled=1, totp_last_step=?, twofa_enabled_at=datetime('now') WHERE id=?", step, u.id);
  const codes = issueRecoveryCodes(u.id);
  run('UPDATE sessions SET limited=0 WHERE id=?', user.session_id); // finishing set-up lifts the restriction
  revokeUserSessions(u.id, user.session_id);
  audit(user, '2fa_enable', 'users', u.id);
  return { ok: true, recovery_codes: codes };
});

POST('/api/2fa/disable', ({ user, body }) => {
  if (!user.twofa_enabled) throw bad('Two-factor authentication is not on');
  if (twofaRequired(user)) throw bad('Your company requires two-factor authentication, so it cannot be turned off.');
  if (!verifyPasswordFor(user.id, body.password)) throw bad('Password is incorrect');
  run('UPDATE users SET totp_enabled=0, totp_secret_enc=NULL, totp_last_step=0, twofa_enabled_at=NULL WHERE id=?', user.id);
  run('DELETE FROM recovery_codes WHERE user_id=?', user.id);
  audit(user, '2fa_disable', 'users', user.id);
  return { ok: true };
});

POST('/api/2fa/recovery-codes', ({ user, body }) => {
  if (!user.twofa_enabled) throw bad('Turn on two-factor authentication first');
  if (!verifyPasswordFor(user.id, body.password)) throw bad('Password is incorrect');
  audit(user, '2fa_recovery_regenerate', 'users', user.id);
  return { recovery_codes: issueRecoveryCodes(user.id) };
});

// ---------- sessions ----------
const sessionRows = (uid, cur) => all("SELECT id, created_at, last_seen_at, ip, user_agent FROM sessions WHERE user_id=? AND revoked_at IS NULL AND expires_at > datetime('now') ORDER BY last_seen_at DESC", uid).map((s) => ({ ...s, current: s.id === cur }));
GET('/api/sessions', ({ user }) => sessionRows(user.id, user.session_id));
DELETE('/api/sessions/:id', ({ user, params }) => {
  const s = get('SELECT id FROM sessions WHERE id=? AND user_id=?', params.id, user.id); if (!s) throw notFound();
  revokeSession(s.id); return { ok: true };
});
POST('/api/sessions/revoke-others', ({ user }) => { revokeUserSessions(user.id, user.session_id); return { ok: true }; });

// ---------- administration ----------
POST('/api/users/:id/reset-2fa', ({ user, params }) => {
  const u = get('SELECT id,email FROM users WHERE id=?', params.id); if (!u) throw notFound();
  run('UPDATE users SET totp_enabled=0, totp_secret_enc=NULL, totp_last_step=0, twofa_enabled_at=NULL WHERE id=?', u.id);
  run('DELETE FROM recovery_codes WHERE user_id=?', u.id);
  revokeUserSessions(u.id);
  audit(user, '2fa_reset', 'users', u.id, u.email);
  return { ok: true };
});
GET('/api/settings/security', () => ({ require_2fa: getSetting('security.require_2fa', 'off'), users_with_2fa: get('SELECT COUNT(*) n FROM users WHERE totp_enabled=1 AND active=1').n, users_total: get('SELECT COUNT(*) n FROM users WHERE active=1').n }));
PUT('/api/settings/security', ({ user, body }) => {
  if (!POLICIES.includes(body.require_2fa)) throw bad('Choose off, admins or all');
  setSetting('security.require_2fa', body.require_2fa);
  audit(user, 'update', 'settings', 0, `require 2FA: ${body.require_2fa}`);
  return { ok: true };
});
