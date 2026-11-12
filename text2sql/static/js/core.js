// Shared helpers: DOM builder, API client, modal, toast, formatting.
export const state = { me: null, onAuthLost: null };

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'open') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/** replaceChildren that ignores null / false, so conditional children are safe. */
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));
  return el;
}

export async function api(method, path, body) {
  const opts = { method, headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(path, opts); } catch { throw new Error('Cannot reach the server. Check your connection.'); }
  if (res.status === 401 && !path.startsWith('/api/auth/') && state.onAuthLost) { state.onAuthLost(); throw new Error('Please sign in again.'); }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    let msg = data?.detail ?? 'Request failed';
    if (Array.isArray(msg)) msg = msg.map(m => m.msg).join('; ');
    const err = new Error(msg); err.status = res.status; throw err;
  }
  return data;
}

export function toast(msg, bad) {
  const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), bad ? 7000 : 3500);
}
export const fail = e => toast(e.message || String(e), true);

/** Run an async action from a button: disables it, shows errors as a toast. */
export async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { fail(e); } finally { if (btn) btn.disabled = false; }
}

export function modal(title, body, { wide, actions, onClose } = {}) {
  const close = () => { overlay.remove(); document.removeEventListener('keydown', esc); onClose?.(); };
  const esc = e => { if (e.key === 'Escape') close(); };
  const footer = actions ? h('footer', {}, actions(close)) : null;
  const overlay = h('div', { class: 'overlay', onmousedown: e => { if (e.target === overlay) close(); } },
    h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' },
      h('header', {}, h('h2', {}, title), h('button', { class: 'btn ghost sm', onclick: close, 'aria-label': 'Close' }, '✕')),
      h('div', { class: 'body' }, body), footer));
  document.body.append(overlay);
  document.addEventListener('keydown', esc);
  overlay.querySelector('input, textarea, select')?.focus();
  return close;
}

export function confirmDialog(title, message, label = 'Confirm', danger = true) {
  return new Promise(resolve => {
    modal(title, h('p', {}, message), {
      onClose: () => resolve(false),
      actions: close => [
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => { resolve(true); close(); } }, label)],
    });
  });
}

export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', {}, label, hint ? h('span', { class: 'hint' }, ' — ' + hint) : null), input);
}
export function check(label, checked, onchange, hint) {
  const input = h('input', { type: 'checkbox', checked, onchange: e => onchange?.(e.target.checked) });
  const el = h('label', { class: 'check' }, input, h('span', {}, label, hint ? h('div', { class: 'small dim' }, hint) : null));
  el.input = input;
  return el;
}
export function select(options, value, onchange, attrs = {}) {
  const el = h('select', { ...attrs, onchange: e => onchange?.(e.target.value) },
    options.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return h('option', { value: v, selected: String(v) === String(value) }, l); }));
  return el;
}
export function tabs(defs, initial) {
  // defs: [[key, label, renderFn]]
  const body = h('div', {});
  const bar = h('div', { class: 'tabs' });
  const show = key => {
    [...bar.children].forEach(b => b.classList.toggle('on', b.dataset.key === key));
    fill(body);
    const out = defs.find(d => d[0] === key)[2](body);
    if (out?.nodeType) body.append(out);
  };
  defs.forEach(([key, label]) => bar.append(h('button', { 'data-key': key, onclick: () => show(key) }, label)));
  const el = h('div', {}, bar, body);
  el.show = show;
  show(initial || defs[0][0]);
  return el;
}

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function fmtNum(v, digits) {
  if (v == null || v === '') return '';
  if (typeof v !== 'number') return String(v);
  const d = digits ?? (Number.isInteger(v) ? 0 : Math.abs(v) < 1 ? 4 : 2);
  return v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: Number.isInteger(v) ? 0 : Math.min(d, 2) });
}
export function fmtCompact(v) {
  if (typeof v !== 'number') return String(v ?? '');
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(a >= 1e10 ? 1 : 2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'K';
  return fmtNum(v);
}
export const pct = v => v == null ? '–' : (v * 100).toFixed(0) + '%';
export function fmtTime(iso) {
  if (!iso) return '–';
  const d = new Date(iso + (iso.endsWith('Z') ? '' : 'Z'));
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function ago(iso) {
  const s = (Date.now() - new Date(iso + 'Z').getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
export function download(name, content, type = 'text/plain') {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const KW = /\b(select|from|where|group|by|order|having|limit|offset|join|left|right|inner|outer|full|cross|on|as|and|or|not|in|is|null|case|when|then|else|end|with|union|all|distinct|between|like|ilike|asc|desc|over|partition|top|fetch|first|rows|only|exists|cast|interval|qualify|using|count|sum|avg|min|max|round|coalesce|date_trunc)\b/gi;
export function highlightSQL(sql) {
  // tokenise strings / comments / numbers first so keywords inside them are left alone
  return String(sql || '').split(/('(?:[^']|'')*'|--[^\n]*|\b\d+(?:\.\d+)?\b)/g).map((part, i) => {
    if (i % 2) {
      const cls = part.startsWith("'") ? 'str' : part.startsWith('--') ? 'cmt' : 'num';
      return `<span class="${cls}">${esc(part)}</span>`;
    }
    return esc(part).replace(KW, m => `<span class="kw">${m.toUpperCase()}</span>`);
  }).join('');
}

/** Put the main clauses of a one-line query on their own lines (whitespace only - same SQL). */
export function prettySQL(sql) {
  sql = String(sql || '');
  if (sql.includes('\n')) return sql;
  let depth = 0;
  return sql.split(/('(?:[^']|'')*')/g).map((part, i) => {
    if (i % 2) return part;
    let out = '', last = 0;
    for (const m of part.matchAll(/[()]|\b(?:from|where|group\s+by|order\s+by|having|limit|union(?:\s+all)?|(?:left|right|inner|full|cross)(?:\s+outer)?\s+join|join)\b/gi)) {
      if (m[0] === '(') depth++;
      else if (m[0] === ')') depth = Math.max(0, depth - 1);
      else if (depth === 0) { out += part.slice(last, m.index).trimEnd() + '\n'; last = m.index; }
    }
    return out + part.slice(last);
  }).join('');
}

export function theme() { return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'; }
export function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('t2s-theme'); } catch { /* storage blocked */ }
  document.documentElement.dataset.theme = saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
export function toggleTheme() {
  const next = theme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('t2s-theme', next); } catch { /* storage blocked */ }
  window.dispatchEvent(new Event('themechange'));
}
