import { api, html, raw, setHtml, store, toast, $ } from './core.js';

/*
 * Live collaboration in the browser:
 *  - one EventSource to /api/live; "changed" and "presence" events are re-dispatched as window events
 *  - watchRecord(): tells others you are viewing / editing a record (heartbeat) and shows who else is
 *  - onPageChange(): lets the current page refresh itself when someone else changes what it shows
 *  - conflictPanel(): the "someone else changed this" chooser used by edit forms
 */
let es = null;
export function startLive() {
  if (es || !window.EventSource || !store.user || store.user.limited) return;
  es = new EventSource('/api/live');
  es.addEventListener('changed', (e) => { try { window.dispatchEvent(new CustomEvent('ovantaa:changed', { detail: JSON.parse(e.data) })); } catch {} });
  es.addEventListener('presence', (e) => { try { window.dispatchEvent(new CustomEvent('ovantaa:presence', { detail: JSON.parse(e.data) })); } catch {} });
}
export function stopLive() { es?.close(); es = null; }
const mine = (d) => d.by_id === store.user?.id;

// ---------------------------------------------------------------- presence
const watched = new Map(); // key -> { entity, id, mode, timer, el }
const send = (entity, id, mode) => api('POST', '/live/presence', { entity, id, mode }).catch(() => ({ people: [] }));
function drawPresence(w, people) {
  if (!w.el) return;
  const others = (people || []).filter((p) => p.user_id !== store.user.id);
  setHtml(w.el, others.length ? html`<div class="presence" role="status">${others.map((p) => html`<span class="badge plain ${p.mode === 'editing' ? 'proposal' : 'qualification'}" title="${p.name} is ${p.mode} this record">${p.mode === 'editing' ? '✏️' : '👁'} ${p.name} is ${p.mode}</span>`)}</div>` : '');
}
/** Start announcing that you are on this record; `el` (optional) shows who else is. Returns a function to change mode. */
export function watchRecord(entity, id, el, mode = 'viewing') {
  const key = `${entity}:${id}`; let w = watched.get(key);
  if (!w) { w = { entity, id: Number(id), mode, el }; watched.set(key, w); w.timer = setInterval(() => send(entity, id, w.mode).then((r) => drawPresence(w, r.people)), 20000); }
  if (el) w.el = el; w.mode = mode;
  send(entity, id, mode).then((r) => drawPresence(w, r.people));
  return (m) => { w.mode = m; send(entity, id, m).then((r) => drawPresence(w, r.people)); };
}
export function setEditing(entity, id, editing) {
  const w = watched.get(`${entity}:${id}`);
  if (w) { w.mode = editing ? 'editing' : 'viewing'; send(entity, id, w.mode).then((r) => drawPresence(w, r.people)); }
  else if (editing) watchRecord(entity, id, null, 'editing');
}
/** Called on every page change: stop announcing presence on the page we left. */
export function leaveAll() {
  for (const w of watched.values()) { clearInterval(w.timer); send(w.entity, w.id, 'left'); }
  watched.clear(); pageHandler = null;
}
window.addEventListener('ovantaa:presence', (e) => { const w = watched.get(`${e.detail.entity}:${e.detail.id}`); if (w) drawPresence(w, e.detail.people); });

// ---------------------------------------------------------------- refresh pages when others change things
let pageHandler = null; let timer = null;
/**
 * Register what the current page shows: match(detail) decides if a change matters; refresh() redraws.
 * While a dialog is open the refresh waits (and the dialog itself may show a notice) so nobody loses what they are typing.
 */
export function onPageChange(match, refresh) { pageHandler = { match, refresh }; }
window.addEventListener('ovantaa:changed', (e) => {
  const d = e.detail; if (mine(d) || !pageHandler || !pageHandler.match(d)) return;
  clearTimeout(timer);
  const run = () => {
    if (document.querySelector('.overlay')) { timer = setTimeout(run, 1500); return; }
    pageHandler?.refresh(d);
  };
  timer = setTimeout(run, 400);
});
export const changedBy = (d) => `${d.by || 'Someone'} ${d.action === 'deleted' ? 'deleted' : d.action === 'created' ? 'added' : 'updated'} this just now`;

// ---------------------------------------------------------------- edit-form helpers
/** Inside an open edit form: warn when someone else saves the same record meanwhile. */
export function watchFormRecord(form, entity, id) {
  const onChange = (e) => {
    const d = e.detail; if (mine(d) || d.entity !== entity || Number(d.id) !== Number(id) || !document.body.contains(form)) return;
    let note = form.querySelector('[data-live-note]');
    if (!note) { note = document.createElement('div'); note.dataset.liveNote = ''; note.className = 'banner'; note.style.cssText = 'margin-bottom:10px;padding:8px 12px;border-radius:8px;background:#fef3c7;color:#78350f'; form.querySelector('.body').prepend(note); }
    note.textContent = d.action === 'deleted' ? `${d.by || 'Someone'} deleted this record — saving will fail.` : `${d.by || 'Someone'} just saved changes to this record. When you save, your edits are combined with theirs; if you both changed the same field you will be asked which value to keep.`;
  };
  window.addEventListener('ovantaa:changed', onChange);
  setEditing(entity, id, true);
  return () => { window.removeEventListener('ovantaa:changed', onChange); setEditing(entity, id, false); };
}
/**
 * Show the conflicts returned by a 409 inside the form and remember the choices.
 * Returns { apply(body) } which removes "theirs" fields from the body and marks "mine" fields as forced.
 */
export function conflictPanel(form, err) {
  const c = err.data.conflicts; let box = form.querySelector('[data-conflicts]');
  if (!box) { box = document.createElement('div'); box.dataset.conflicts = ''; form.querySelector('.body').prepend(box); }
  setHtml(box, html`<div class="card" style="border:2px solid #f59e0b;margin-bottom:12px"><div class="bd">
    <b>⚠️ ${err.data.updated_by_name || 'Someone else'} changed ${c.length === 1 ? 'this field' : 'these fields'} while you were editing.</b>
    <p class="small muted" style="margin:4px 0 8px">Choose which value to keep for each, then click Save again. Your other changes are kept.</p>
    <table class="small" style="width:100%"><thead><tr><th>Field</th><th>Was</th><th>Their value</th><th>Your value</th></tr></thead><tbody>${c.map((x) => html`<tr>
      <td><b>${x.label}</b></td><td class="muted">${x.base}</td>
      <td><label class="check" style="margin:0"><input type="radio" name="cf__${x.field}" value="theirs" checked> ${x.theirs}</label></td>
      <td><label class="check" style="margin:0"><input type="radio" name="cf__${x.field}" value="mine"> ${x.yours}</label></td></tr>`)}</tbody></table></div></div>`);
  box.scrollIntoView?.({ block: 'start' });
  return {
    apply(body) {
      const force = new Set(body.__force || []);
      for (const x of c) {
        const pick = form.querySelector(`[name="cf__${x.field}"]:checked`)?.value || 'theirs';
        if (pick === 'mine') force.add(x.field);
        else if (x.field.startsWith('cf_')) { if (body.custom) delete body.custom[x.field]; }
        else delete body[x.field];
      }
      body.__force = [...force]; return body;
    },
  };
}
/** Only the fields that differ from what was loaded, plus the loaded values (so the server can detect real conflicts). */
const same = (a, b) => JSON.stringify(a ?? '') === JSON.stringify(b ?? '') || String(a ?? '') === String(b ?? '');
export function changedOnly(now, orig) {
  const body = {}; const base = {};
  for (const [k, v] of Object.entries(now)) {
    if (k === 'custom') {
      const cn = {}, cb = {};
      for (const [ck, cv] of Object.entries(v || {})) if (!same(cv, orig.custom?.[ck])) { cn[ck] = cv; cb[ck] = orig.custom?.[ck] ?? null; }
      if (Object.keys(cn).length) { body.custom = cn; base.custom = cb; }
    } else if (!same(v, orig[k])) { body[k] = v; base[k] = orig[k] ?? null; }
  }
  body.__base = base; return body;
}
