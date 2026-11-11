import { watchFormRecord, conflictPanel, changedOnly } from './live.js';
import { api, html, raw, setHtml, esc, store, toast, modal, badge, money, fmtDate, $, $$ } from './core.js';

// ------------------------------------------------------------------ bundle (field definitions + layouts)
export async function loadCustomization() { store.custom = await api('GET', '/customization'); return store.custom; }
const bundle = (entity) => store.custom?.entities?.[entity] || { builtin: [], fields: [], layout: { sections: [] } };
export const activeFields = (entity) => bundle(entity).fields.filter((f) => !f.archived);

/** Uniform descriptor for built-in and custom fields: { key, name, label, type, options, builtin, ... } */
function descriptors(entity, lk) {
  const out = {};
  const opts = (b) => (b.options ? b.options.map((v) => [v, v]) : b.source === 'users' ? store.meta.users.map((u) => [u.id, u.name]) : b.source === 'stages' ? store.meta.stages.map((s) => [s.key, s.label]) : b.source === 'accounts' ? lk?.accounts || [] : b.source === 'contacts' ? lk?.contacts || [] : []);
  for (const b of bundle(entity).builtin) out[b.key] = { ...b, name: `f__${b.key}`, builtin: true, options: opts(b) };
  for (const f of activeFields(entity)) out[f.key] = { ...f, name: `c__${f.key}`, builtin: false, help: f.help_text };
  return out;
}

// ------------------------------------------------------------------ controls
const stepFor = (d) => { const dec = d.config?.decimals; return d.step || (dec === 0 ? '1' : dec ? String(1 / 10 ** dec) : 'any'); };
function control(d, value, lk) {
  const req = d.required ? raw(' required') : ''; const ph = d.placeholder ? raw(` placeholder="${esc(d.placeholder)}"`) : ''; const name = d.name; const v = value ?? '';
  switch (d.type) {
    case 'textarea': return html`<textarea name="${name}" rows="3" maxlength="${d.config?.maxLength || 5000}" ${req} ${ph}>${v}</textarea>`;
    case 'number': case 'percent': case 'currency': return html`<input type="number" name="${name}" step="${stepFor(d)}" ${d.min != null ? raw(`min="${d.min}"`) : d.config?.min != null ? raw(`min="${d.config.min}"`) : ''} ${d.max != null ? raw(`max="${d.max}"`) : d.config?.max != null ? raw(`max="${d.config.max}"`) : ''} value="${v}" ${req} ${ph}>`;
    case 'date': return html`<input type="date" name="${name}" value="${v}" ${req}>`;
    case 'email': case 'url': case 'tel': case 'text': case 'phone': return html`<input type="${d.type === 'phone' ? 'tel' : d.type}" name="${name}" value="${v}" maxlength="${d.config?.maxLength || 255}" ${d.dir ? raw(`dir="${d.dir}"`) : ''} ${req} ${ph}>`;
    case 'select': case 'dropdown': case 'lookup': {
      const options = d.type === 'dropdown' ? d.options.map((o) => [o, o]) : d.type === 'lookup' ? (lk?.[d.config.target] || []) : d.options;
      const known = options.some(([val]) => String(val) === String(v));
      return html`<select name="${name}" ${req}>${d.noBlank ? '' : html`<option value="">—</option>`}${options.map(([val, label]) => html`<option value="${val}" ${String(val) === String(v) ? raw('selected') : ''}>${label}</option>`)}${v !== '' && !known ? html`<option value="${v}" selected>${v} (no longer in the list)</option>` : ''}</select>`;
    }
    case 'multiselect': { const cur = Array.isArray(value) ? value : []; const all = [...d.options, ...cur.filter((x) => !d.options.includes(x))];
      return html`<div class="ms" data-ms="${name}">${all.map((o) => html`<label class="check small" style="margin:0"><input type="checkbox" name="${name}" value="${o}" ${cur.includes(o) ? raw('checked') : ''}> ${o}</label>`)}</div>`; }
    default: return html`<input name="${name}" value="${v}" ${req}>`;
  }
}
const isWide = (d) => ['textarea', 'multiselect'].includes(d.type);

/** One field block (label + control + help), wrapped for layout and "show only when". */
function fieldBlock(d, rec, isNew, lk) {
  const cur = d.builtin ? rec[d.key] : rec.custom?.[d.key];
  let value = cur;
  if (isNew || cur === undefined) { const def = d.builtin ? d.default : d.default_value; if (isNew && def !== undefined && def !== null) value = def === '@me' ? store.user.id : def; }
  if (!d.builtin && d.type === 'checkbox' && value === undefined) value = false;
  const when = d.visible_when ? raw(` data-when="${esc(JSON.stringify(d.visible_when))}"`) : '';
  const star = d.required ? html`<span class="req">*</span>` : '';
  if (d.type === 'checkbox') return html`<div class="fld" data-key="${d.key}" ${when}><label class="check"><input type="checkbox" name="${d.name}" ${value ? raw('checked') : ''}> ${d.label}</label>${d.help ? html`<div class="small muted">${d.help}</div>` : ''}</div>`;
  return html`<div class="fld ${isWide(d) ? 'span2' : ''}" data-key="${d.key}" ${when}><label>${d.label}${star}${control(d, value, lk)}</label>${d.help ? html`<div class="small muted" style="margin-top:-6px;margin-bottom:8px">${d.help}</div>` : ''}</div>`;
}

/** The whole form body for a record type, drawn from the saved (or a supplied) layout. */
export function renderFields(entity, rec = {}, lk = null, { layout } = {}) {
  const ds = descriptors(entity, lk); const isNew = !rec.id; const L = layout || bundle(entity).layout;
  return html`${L.sections.map((s) => html`<div class="fsec"><h3>${s.title}</h3><div class="fgrid ${s.columns === 1 ? 'one' : ''}">${s.fields.map((k) => (ds[k] ? fieldBlock(ds[k], rec, isNew, lk) : '')).filter(Boolean)}</div></div>`)}`;
}

// ------------------------------------------------------------------ reading values & conditional visibility
function currentValues(form, entity, lk) {
  const out = {}; const ds = descriptors(entity, lk);
  for (const w of $$('.fld', form)) {
    const k = w.dataset.key; const d = ds[k]; if (!d) continue; const els = [...w.querySelectorAll('[name]')]; if (!els.length) continue;
    if (d.type === 'checkbox') out[k] = els[0].checked; else if (d.type === 'multiselect') out[k] = els.filter((e) => e.checked).map((e) => e.value); else out[k] = els[0].value;
  }
  return out;
}
export function applyVisibility(form, entity, lk) {
  const vals = currentValues(form, entity, lk); const ds = descriptors(entity, lk);
  for (const w of $$('.fld[data-when]', form)) {
    let c; try { c = JSON.parse(w.dataset.when); } catch { continue; }
    const v = vals[c.field]; const ok = Array.isArray(v) ? v.some((x) => c.values.includes(String(x))) : typeof v === 'boolean' ? c.values.includes(v ? 'true' : 'false') : v !== undefined && v !== '' && c.values.includes(String(v));
    w.hidden = !ok; w.querySelectorAll('[name]').forEach((e) => { e.disabled = !ok; });
    const d = ds[w.dataset.key]; if (d?.required) w.querySelectorAll('input,select,textarea').forEach((e) => { if (e.type !== 'checkbox') e.required = ok; });
  }
}
/** Collect submitted values: built-ins as { key: value }, custom as { custom: { cf_key: value } }. Hidden (conditional) fields are left out so their stored value is kept. */
export function readValues(form, entity, lk) {
  const ds = descriptors(entity, lk); const body = {}; const custom = {};
  for (const w of $$('.fld', form)) {
    if (w.hidden) continue; const d = ds[w.dataset.key]; if (!d) continue; const els = [...w.querySelectorAll('[name]')].filter((e) => !e.disabled); if (!els.length) continue;
    const v = d.type === 'checkbox' ? els[0].checked : d.type === 'multiselect' ? els.filter((e) => e.checked).map((e) => e.value) : els[0].value;
    if (d.builtin) body[d.key] = v; else custom[d.key] = v;
  }
  if (activeFields(entity).length) body.custom = custom;
  return body;
}

/** Create/edit dialog for contacts, accounts and deals, driven by the admin's layout. */
export function openEntityForm(entity, rec, { lk, onDone, titles, extra, afterBody } = {}) {
  const t = titles || {}; const isNew = !rec?.id; rec = rec || {};
  let pending = null, stopWatch = null; // pending: choices for fields someone else changed meanwhile
  modal({ title: isNew ? t.new : t.edit, wide: true,
    body: html`${renderFields(entity, rec, lk)}${extra ? extra(rec) : ''}`,
    onOpen: (form) => {
      applyVisibility(form, entity, lk); form.addEventListener('input', () => applyVisibility(form, entity, lk)); form.addEventListener('change', () => applyVisibility(form, entity, lk)); afterBody?.(form);
      if (!isNew) stopWatch = watchFormRecord(form, entity, rec.id);
    },
    onClose: () => stopWatch?.(),
    onSubmit: async (form) => {
      // edits send only what changed, with the values originally loaded, so other people's changes to other fields are kept
      let body = isNew ? readValues(form, entity, lk) : changedOnly(readValues(form, entity, lk), rec);
      if (extra) for (const e of $$('[data-extra]', form)) if (e.value) body[e.name] = e.value;
      if (!isNew && !Object.keys(body).some((k) => k !== '__base')) { toast('No changes to save'); return; }
      if (pending) body = pending.apply(body);
      let saved;
      try { saved = isNew ? await api('POST', `/${entity}`, body) : await api('PUT', `/${entity}/${rec.id}`, body); }
      catch (e) { if (e.status === 409 && e.data?.conflict) { pending = conflictPanel(form, e); throw new Error(e.message); } throw e; }
      pending = null; toast(`${t.noun || 'Record'} saved`, 'ok'); onDone?.(saved);
    } });
}

// ------------------------------------------------------------------ display (lists & detail pages)
export function displayValue(d, rec) {
  const v = rec.custom?.[d.key]; if (v === undefined || v === null || v === '') return null;
  switch (d.type) {
    case 'lookup': return rec.custom_labels?.[d.key] ? html`<a href="#/${d.config.target}/${v}">${rec.custom_labels[d.key]}</a>` : html`<span class="muted">(deleted)</span>`;
    case 'date': return fmtDate(v); case 'checkbox': return v ? 'Yes' : 'No'; case 'percent': return `${v}%`;
    case 'currency': return `${Number(v).toLocaleString('en-US', { minimumFractionDigits: d.config.decimals ?? 2, maximumFractionDigits: d.config.decimals ?? 2 })}${d.config.code ? ' ' + d.config.code : ''}`;
    case 'number': return Number(v).toLocaleString('en-US', { maximumFractionDigits: d.config.decimals ?? 2 });
    case 'multiselect': return html`${v.map((x) => html`<span class="badge">${x}</span> `)}`;
    case 'url': return html`<a href="${/^https?:\/\//i.test(v) ? v : '#'}" target="_blank" rel="noopener noreferrer">${v}</a>`;
    case 'email': return html`<a href="mailto:${v}">${v}</a>`; case 'phone': return html`<a href="tel:${v}">${v}</a>`;
    case 'textarea': return html`<span style="white-space:pre-wrap">${v}</span>`;
    default: return String(v);
  }
}
const visibleNow = (d, rec) => { if (!d.visible_when) return true; const { field, values } = d.visible_when; const v = field.startsWith('cf_') ? rec.custom?.[field] : rec[field]; return Array.isArray(v) ? v.some((x) => values.includes(String(x))) : typeof v === 'boolean' ? values.includes(String(v)) : v != null && values.includes(String(v)); };

/** Card(s) with a record's custom values, grouped by the layout's sections. */
export function customDetailCard(entity, rec) {
  const fields = Object.fromEntries(activeFields(entity).map((f) => [f.key, f])); const L = bundle(entity).layout;
  const groups = L.sections.map((s) => ({ title: s.title, rows: s.fields.map((k) => fields[k]).filter((d) => d && visibleNow(d, rec)).map((d) => ({ d, v: displayValue(d, rec) })).filter((x) => x.v !== null) })).filter((g) => g.rows.length);
  if (!groups.length) return '';
  return html`${groups.map((g) => html`<div class="card"><div class="hd"><h2>${g.title}</h2></div><div class="bd" style="display:grid;gap:8px">${g.rows.map(({ d, v }) => html`<div><span class="muted small">${d.label}</span><br>${v}</div>`)}</div></div>`)}`;
}
export function customColumns(entity) {
  return activeFields(entity).filter((f) => f.show_in_list).map((d) => ({ label: d.label, sort: d.key, render: (r) => displayValue(d, r) ?? '—' }));
}
export function customFilters(entity) {
  return activeFields(entity).filter((f) => f.filterable && ['dropdown', 'multiselect', 'checkbox'].includes(f.type)).map((f) => ({ name: f.key, label: f.label, options: f.type === 'checkbox' ? [['true', 'Yes'], ['false', 'No']] : f.options }));
}
export const customCardLines = (entity, rec, n = 2) => activeFields(entity).filter((f) => f.show_in_list).map((d) => ({ d, v: displayValue(d, rec) })).filter((x) => x.v !== null).slice(0, n);
