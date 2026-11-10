import crypto from 'node:crypto';

// ---- RFC 4648 base32 (what authenticator apps expect) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, ''); let bits = 0, value = 0; const out = [];
  for (const ch of clean) { const i = B32.indexOf(ch); if (i < 0) throw new Error('Invalid base32'); value = (value << 5) | i; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}

// ---- RFC 6238 TOTP (HMAC-SHA1, 30 s step) ----
export const STEP_SECONDS = 30;
export function totpAt(secret, counter, digits = 6) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secret).update(msg).digest(); const o = h[h.length - 1] & 0xf;
  const code = (((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 10 ** digits;
  return String(code).padStart(digits, '0');
}
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
/**
 * Check a 6-digit code against a base32 secret, allowing ±1 step of clock drift.
 * Returns the matched step counter, or null. Steps <= lastStep are rejected, so a code can never be used twice.
 */
export function verifyTotp(secretB32, code, { lastStep = 0, now = Date.now(), window = 1 } = {}) {
  const c = String(code ?? '').replace(/\s/g, ''); if (!/^\d{6}$/.test(c)) return null;
  const secret = base32Decode(secretB32); const cur = Math.floor(now / 1000 / STEP_SECONDS); let hit = null;
  for (let d = -window; d <= window; d++) { const step = cur + d; if (step > lastStep && same(totpAt(secret, step), c)) hit = hit === null || step > hit ? step : hit; }
  return hit;
}
export const newSecret = () => base32Encode(crypto.randomBytes(20));
export const otpauthUrl = (secret, account, issuer = 'Ovantaa CRM') => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;

// ---- one-time recovery codes (no look-alike characters) ----
const RC = 'abcdefghjkmnpqrstuvwxyz23456789';
export function newRecoveryCodes(n = 10) {
  return Array.from({ length: n }, () => { const b = crypto.randomBytes(10); const s = Array.from(b, (x) => RC[x % RC.length]).join(''); return `${s.slice(0, 5)}-${s.slice(5)}`; });
}
export const normalizeRecovery = (c) => String(c ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const hashRecovery = (c) => crypto.createHash('sha256').update(normalizeRecovery(c)).digest('hex');
