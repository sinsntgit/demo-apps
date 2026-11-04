import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { get } from './db.js';

function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(config.dataDir, '.secret');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  try { fs.mkdirSync(config.dataDir, { recursive: true }); fs.writeFileSync(f, s, { mode: 0o600 }); } catch {}
  return s;
}
const SECRET = loadSecret();

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

const SESSION_TTL = 1000 * 60 * 60 * 12;
export function makeSession(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp: Date.now() + SESSION_TTL })).toString('base64url');
  return `${payload}.${hmac(payload)}`;
}
export function readSession(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const good = hmac(payload);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (exp < Date.now()) return null;
    return get('SELECT id,name,email,role FROM users WHERE id=? AND active=1', uid) || null;
  } catch { return null; }
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
