import { get, run } from './db.js';
import { encryptSecret, decryptSecret } from './auth.js';

export const getSetting = (key, fallback = null) => get('SELECT value FROM settings WHERE key=?', key)?.value ?? fallback;
export function setSetting(key, value) {
  if (value === null || value === undefined) run('DELETE FROM settings WHERE key=?', key);
  else run("INSERT INTO settings (key,value,updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", key, String(value));
}
export const getSecretSetting = (key) => { try { return decryptSecret(getSetting(key)); } catch { return ''; } };
export const setSecretSetting = (key, v) => setSetting(key, v ? encryptSecret(v) : null);

export const DEFAULT_THEME = { primary: '#4f46e5', sidebar: '#12142b', mode: 'auto' };
const HEX = /^#[0-9a-fA-F]{6}$/;
export function getTheme() {
  try { return { ...DEFAULT_THEME, ...JSON.parse(getSetting('theme', '{}')) }; } catch { return { ...DEFAULT_THEME }; }
}
export function saveTheme(t) {
  const out = {
    primary: HEX.test(t.primary) ? t.primary : DEFAULT_THEME.primary,
    sidebar: HEX.test(t.sidebar) ? t.sidebar : DEFAULT_THEME.sidebar,
    mode: ['auto', 'light', 'dark'].includes(t.mode) ? t.mode : 'auto',
  };
  setSetting('theme', JSON.stringify(out));
  return out;
}
