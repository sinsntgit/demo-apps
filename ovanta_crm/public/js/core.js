// Shared helpers: safe HTML templating, API client, modals, toasts, formatting.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const raw = (s) => ({ __raw: String(s) });
const toHtml = (v) => (v == null || v === false ? '' : typeof v === 'object' && '__raw' in v ? v.__raw : Array.isArray(v) ? v.map(toHtml).join('') : esc(v));
/** Tagged template that HTML-escapes every interpolation unless wrapped in raw()/html``. */
export const html = (s, ...v) => raw(s.reduce((a, str, i) => a + str + (i < v.length ? toHtml(v[i]) : ''), ''));
export const setHtml = (el, h) => { el.innerHTML = h.__raw ?? esc(h); };

export const store = { user: null, meta: null };

export class ApiError extends Error { constructor(m, status) { super(m); this.status = status; } }
export async function api(method, path, body) {
  const r = await fetch('/api' + path, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch {}
  if (r.status === 401 && !path.startsWith('/auth/login')) { store.user = null; location.hash = '#/login'; window.dispatchEvent(new Event('ovantaa:logout')); }
  if (!r.ok) throw new ApiError(data?.error || `Request failed (${r.status})`, r.status);
  return data;
}
export const qs = (o) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== '' && v != null) p.set(k, v); const s = p.toString(); return s ? '?' + s : ''; };

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---- formatting ----
export const money = (n, compact = false) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0, ...(compact ? { notation: 'compact', maximumFractionDigits: 1 } : {}) }).format(n || 0);
export const pct = (n, d = 1) => `${((n || 0) * 100).toFixed(d)}%`;
export const num = (n) => new Intl.NumberFormat('en-US').format(n || 0);
const parseDt = (s) => (s ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + (s.length <= 10 ? 'T00:00:00' : '') + (s.length > 10 ? 'Z' : '')) : null);
export const fmtDate = (s) => { const d = parseDt(s); return d && !isNaN(d) ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'; };
export const fmtDateTime = (s) => { const d = parseDt(s); return d && !isNaN(d) ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'; };
export const ago = (s) => {
  const d = parseDt(s); if (!d) return '—';
  const m = Math.round((Date.now() - d) / 60000);
  if (m < 1) return 'just now'; if (m < 60) return `${m}m ago`; if (m < 1440) return `${Math.round(m / 60)}h ago`;
  if (m < 43200) return `${Math.round(m / 1440)}d ago`; return fmtDate(s);
};
export const initials = (n) => String(n || '?').split(/\s+/).slice(0, 2).map((x) => x[0]).join('').toUpperCase();
export const fullName = (c) => [c.first_name, c.last_name].filter(Boolean).join(' ');
export const badge = (v) => html`<span class="badge ${String(v).replace(/[^a-z]/gi, '')}">${v}</span>`;
export const todayStr = () => new Date().toISOString().slice(0, 10);
export const can = (...roles) => roles.includes(store.user?.role);

// ---- toasts ----
export function toast(msg, type = '') {
  const t = document.createElement('div'); t.className = `toast ${type}`; t.textContent = msg; t.setAttribute('role', 'status');
  $('#toasts').append(t); setTimeout(() => t.remove(), type === 'bad' ? 6000 : 3200);
}
export const fail = (e) => toast(e.message || 'Something went wrong', 'bad');

// ---- modal & forms ----
export function field(f, values = {}) {
  const v = values[f.name] ?? f.default ?? '';
  const req = f.required ? html`<span class="req">*</span>` : '';
  const attrs = `name="${esc(f.name)}"${f.required ? ' required' : ''}${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}`;
  if (f.type === 'checkbox') return html`<label class="check"><input type="checkbox" name="${f.name}" ${v ? raw('checked') : ''}> ${f.label}</label>`;
  let input;
  if (f.type === 'select') {
    input = html`<select ${raw(attrs)}>${f.blank !== false ? html`<option value="">${f.blank || '—'}</option>` : ''}${(f.options || []).map((o) => { const [val, label] = Array.isArray(o) ? o : [o, o]; return html`<option value="${val}" ${String(val) === String(v) ? raw('selected') : ''}>${label}</option>`; })}</select>`;
  } else if (f.type === 'textarea') input = html`<textarea ${raw(attrs)} rows="${f.rows || 3}">${v}</textarea>`;
  else input = html`<input ${raw(attrs)} type="${f.type || 'text'}" value="${v}" ${f.step ? raw(`step="${f.step}"`) : ''} ${f.min != null ? raw(`min="${f.min}"`) : ''} ${f.max != null ? raw(`max="${f.max}"`) : ''}>`;
  return html`<label>${f.label}${req}${input}</label>`;
}
export function formValues(form, fields) {
  const out = {}; const fd = new FormData(form);
  for (const f of fields) out[f.name] = f.type === 'checkbox' ? fd.has(f.name) : (fd.get(f.name) ?? '');
  return out;
}

/** Open a modal. opts: {title, body (html), submitLabel, onSubmit(form)->Promise, wide, hideFooter, danger} */
export function modal(opts) {
  const ov = document.createElement('div'); ov.className = 'overlay';
  setHtml(ov, html`<form class="modal ${opts.wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${opts.title}">
    <header><h2>${opts.title}</h2><button type="button" class="btn sm" data-close aria-label="Close">✕</button></header>
    <div class="body"><div class="err" hidden></div>${opts.body}</div>
    ${opts.hideFooter ? '' : html`<footer><button type="button" class="btn" data-close>Cancel</button><button class="btn ${opts.danger ? 'danger' : 'primary'}" type="submit">${opts.submitLabel || 'Save'}</button></footer>`}
  </form>`);
  const form = $('form', ov); const err = $('.err', ov);
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  ov.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.hidden = true;
    const btn = $('button[type=submit]', form); if (btn) btn.disabled = true;
    try { await opts.onSubmit?.(form, close); close(); }
    catch (x) { err.textContent = x.message || 'Failed'; err.hidden = false; ov.querySelector('.body').scrollTop = 0; }
    finally { if (btn) btn.disabled = false; }
  });
  document.body.append(ov);
  (form.querySelector('input:not([type=hidden]),select,textarea') || form).focus?.();
  opts.onOpen?.(form, close);
  return close;
}
export function confirmBox(message, label = 'Confirm', danger = true) {
  return new Promise((resolve) => {
    let done = false;
    modal({ title: 'Please confirm', body: html`<p>${message}</p>`, submitLabel: label, danger, onSubmit: async () => { done = true; resolve(true); } });
    const t = setInterval(() => { if (!document.querySelector('.overlay')) { clearInterval(t); if (!done) resolve(false); } }, 150);
  });
}

// ---- generic delegated click handling for a container ----
export function on(root, handlers) {
  // Idempotent per root: repeated calls (e.g. on every redraw) merge handlers instead of stacking listeners.
  const had = root.__handlers;
  root.__handlers = { ...(had || {}), ...handlers };
  if (had) return;
  root.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]'); if (!el || !root.contains(el)) return;
    const h = root.__handlers[el.dataset.act]; if (!h) return;
    e.preventDefault();
    try { await h(el, e); } catch (x) { fail(x); }
  });
}
export const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

export const icons = {
  home: '<path d="M3 11l9-8 9 8v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.5 3-6 7-6s7 2.5 7 6"/><path d="M16 4.5a3.5 3.5 0 010 7M18 14c2.5.6 4 2.5 4 6"/>',
  building: '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M8 7h2M14 7h2M8 11h2M14 11h2M8 15h2M14 15h2"/>',
  deal: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  task: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 12l3 3 5-6"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  seg: '<path d="M3 5h18l-7 8v6l-4-2v-4z"/>',
  tpl: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
  team: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.5-7 8-7s8 3 8 7"/>',
  send: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>',
  bell: '<path d="M6 8a6 6 0 0112 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 003.4 0"/>',
  invoice: '<path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6M9 13h6M9 17h6"/>',
  wallet: '<path d="M3 7h16a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><path d="M3 7l12-4v4"/><circle cx="16" cy="14" r="1.2"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  cog: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
};
export const icon = (n) => raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[n]}</svg>`);

// ---- theming ----
const lum = (hex) => { const n = parseInt(hex.slice(1), 16); const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
export const DEFAULT_THEME = { primary: '#4f46e5', sidebar: '#12142b', mode: 'auto' };
export const THEME_PRESETS = [
  ['Indigo', '#4f46e5', '#12142b'], ['Teal', '#0d9488', '#0b2a2e'], ['Emerald', '#059669', '#10261f'], ['Rose', '#e11d48', '#2a1219'],
  ['Amber', '#d97706', '#2a1f0e'], ['Sky', '#0284c7', '#0c2233'], ['Violet', '#7c3aed', '#1c1233'], ['Slate', '#334155', '#0f172a'],
];
/** Apply org theme + this browser's personal light/dark choice. */
export function applyTheme(theme = store.theme || DEFAULT_THEME) {
  store.theme = theme; const r = document.documentElement.style;
  const ok = (h, d) => (/^#[0-9a-f]{6}$/i.test(h) ? h : d);
  const primary = ok(theme.primary, DEFAULT_THEME.primary), side = ok(theme.sidebar, DEFAULT_THEME.sidebar);
  r.setProperty('--brand', primary); r.setProperty('--side', side);
  r.setProperty('--on-brand', lum(primary) > 0.5 ? '#111827' : '#ffffff');
  const light = lum(side) > 0.45;
  r.setProperty('--side-ink', light ? '#111827' : '#ffffff'); r.setProperty('--side-ink2', light ? '#374151' : '#c9cde6');
  let mine = null; try { mine = localStorage.getItem('ovantaa_mode'); } catch {}
  const mode = mine && mine !== 'org' ? mine : theme.mode;
  if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode; else delete document.documentElement.dataset.theme;
}

/** "Delete all" for one data type (admin only). Shows the count and side effects and requires typing DELETE. */
export async function purgeModal(entity, done) {
  const info = (await api('GET', '/admin/data-counts'))[entity];
  if (!info) throw new Error('Unknown data type');
  if (!info.count) { toast(`There are no ${info.label} to delete.`); return; }
  modal({ title: `Delete all ${info.label}?`, danger: true, submitLabel: `Delete all ${info.count}`,
    body: html`<div class="banner bad"><b>This permanently deletes all ${info.count} ${info.label}.</b> It cannot be undone.${info.effects ? html`<div class="small mt">${info.effects}</div>` : ''}</div>
      <label>Type <b>DELETE</b> to confirm<input name="confirm" autocomplete="off" placeholder="DELETE"></label>`,
    onOpen: (form) => { const b = form.querySelector('button[type=submit]'); b.disabled = true; form.confirm.addEventListener('input', () => { b.disabled = form.confirm.value !== 'DELETE'; }); },
    onSubmit: async (form) => { const r = await api('POST', '/admin/purge', { entity, confirm: form.confirm.value }); toast(`Deleted ${r.deleted} ${info.label}`, 'ok'); done?.(r); } });
}
