import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { get, run, nowIso } from './db.js';
import { normalizePerms, SYSTEM_ROLES } from './permissions.js';

function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(config.dataDir, '.secret');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  try { fs.mkdirSync(config.dataDir, { recursive: true }); fs.writeFileSync(f, s, { mode: 0o600 }); } catch {}
  return s;
}
const SECRET = loadSecret();
const ENC_KEY = crypto.scryptSync(SECRET, 'ovantaa-secrets-v1', 32);

/** AES-256-GCM encryption for stored credentials (SMTP passwords, API keys). */
export function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}
export function decryptSecret(blob) {
  if (!blob) return '';
  const [v, iv, tag, enc] = String(blob).split(':');
  if (v !== 'v1') return '';
  const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

export const hmac = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
export function verifyPassword(pw, stored) {
  const [alg, s, k] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const key = crypto.scryptSync(pw, Buffer.from(s, 'base64'), 64);
  const expected = Buffer.from(k, 'base64');
  return expected.length === key.length && crypto.timingSafeEqual(key, expected);
}

// ---- server-side sessions: random opaque token in the cookie, only its hash is stored, so sessions can be listed and revoked ----
const SESSION_TTL = 1000 * 60 * 60 * 12;      // 12 h absolute
const IDLE_TIMEOUT = 1000 * 60 * 60 * 8;      // 8 h without any request
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
/** `limited` sessions (two-factor setup still required) can only reach the 2FA set-up endpoints. */
export function makeSession(userId, { ip = null, ua = null, limited = false } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  run('INSERT INTO sessions (token_hash,user_id,expires_at,ip,user_agent,limited) VALUES (?,?,?,?,?,?)', hashToken(token), userId, sqlTime(Date.now() + SESSION_TTL), ip, String(ua || '').slice(0, 200) || null, limited ? 1 : 0);
  return token;
}
export function readSession(token) {
  if (!token || String(token).length < 20) return null;
  const s = get('SELECT * FROM sessions WHERE token_hash=? AND revoked_at IS NULL', hashToken(token)); if (!s) return null;
  const now = Date.now();
  if (s.expires_at <= sqlTime(now) || s.last_seen_at <= sqlTime(now - IDLE_TIMEOUT)) return null;
  const u = loadUser(s.user_id); if (!u) return null;
  if (s.last_seen_at <= sqlTime(now - 60000)) run('UPDATE sessions SET last_seen_at=? WHERE id=?', sqlTime(now), s.id);
  return { ...u, session_id: s.id, limited: !!s.limited };
}
export const revokeSession = (id) => run("UPDATE sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL", nowIso(), id);
export const revokeUserSessions = (userId, exceptId = null) => run("UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND id IS NOT ?", nowIso(), userId, exceptId);
export function purgeOldSessions() { run("DELETE FROM sessions WHERE (revoked_at IS NOT NULL AND revoked_at < datetime('now','-7 day')) OR expires_at < datetime('now','-7 day')"); }

/** Short-lived signed token handed out after a correct password when a second factor is still needed. */
export function makeChallenge(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp: Date.now() + 5 * 60 * 1000, n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
  return `${payload}.${hmac(payload)}`;
}
export function readChallenge(token) {
  const [payload, sig] = String(token || '').split('.'); if (!payload || !sig) return null;
  const good = hmac(payload); if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try { const c = JSON.parse(Buffer.from(payload, 'base64url').toString()); return c.exp > Date.now() ? c : null; } catch { return null; }
}
export const verifyPasswordFor = (userId, pw) => { const u = get('SELECT password_hash FROM users WHERE id=?', userId); return !!u && verifyPassword(String(pw || ''), u.password_hash); };

/** Load an active user with their role name and resolved permissions. */
export function loadUser(uid) {
  const u = get(`SELECT u.id, u.name, u.email, u.role_id, u.totp_enabled, COALESCE(r.name, u.role) AS role, COALESCE(r.label, u.role) AS role_label, r.permissions AS perms_json, r.is_system AS role_is_system
    FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ? AND u.active = 1`, uid);
  if (!u) return null;
  let raw = {}; try { raw = JSON.parse(u.perms_json || '{}'); } catch {}
  const { perms_json, role_is_system, totp_enabled, ...rest } = u;
  const perms = role_is_system && u.role === 'admin' ? SYSTEM_ROLES[0].permissions : normalizePerms(raw); // the Administrator role is always full access, including permissions added in later versions
  return { ...rest, twofa_enabled: !!totp_enabled, is_admin: !!(role_is_system && u.role === 'admin'), perms };
}
export function parseCookies(header = '') {
  const out = {};
  for (const p of header.split(';')) { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }
  return out;
}
export const sessionCookie = (token, maxAge = SESSION_TTL / 1000) =>
  `ovantaa_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${config.secureCookies ? '; Secure' : ''}`;

// naive in-memory login throttle: 8 failures / 10 min per ip+email
const fails = new Map();
export function throttled(key) {
  const now = Date.now();
  const arr = (fails.get(key) || []).filter((t) => now - t < 600000);
  fails.set(key, arr);
  return arr.length >= 8;
}
export const recordFail = (key) => fails.set(key, [...(fails.get(key) || []), Date.now()]);
export const clearFails = (key) => fails.delete(key);
