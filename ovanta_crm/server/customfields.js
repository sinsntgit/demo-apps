import { all, get, run, tx, audit } from './db.js';
import { bad, notFound } from './http.js';

export const ENTITIES_WITH_CUSTOM = ['contacts', 'accounts', 'deals'];
export const FIELD_TYPES = {
  text: 'Text (single line)', textarea: 'Comment (multi-line text)', number: 'Number', percent: 'Percentage', currency: 'Amount (money)', date: 'Date',
  dropdown: 'Dropdown (pick one)', multiselect: 'Multi-select (pick several)', checkbox: 'Checkbox (yes / no)', email: 'Email address', phone: 'Phone number', url: 'Web link', lookup: 'Link to another record',
};
const LIMITS = { fieldsPerEntity: 100, options: 200, optionLength: 100, sections: 20 };

/** Built-in fields per record type: the form catalogue used by layouts. `source` tells the client where select options come from. */
export const BUILTIN = {
  contacts: [
    { key: 'first_name', label: 'First name', type: 'text', required: true }, { key: 'last_name', label: 'Last name', type: 'text' },
    { key: 'email', label: 'Email', type: 'email' }, { key: 'phone', label: 'Phone', type: 'tel' }, { key: 'title', label: 'Job title', type: 'text' },
    { key: 'account_id', label: 'Company', type: 'select', source: 'accounts' }, { key: 'status', label: 'Status', type: 'select', options: ['lead', 'qualified', 'customer', 'churned'], default: 'lead', noBlank: true },
    { key: 'source', label: 'Source', type: 'text', placeholder: 'Website, Referral…' }, { key: 'owner_id', label: 'Owner', type: 'select', source: 'users', noBlank: true, default: '@me' },
    { key: 'tags', label: 'Tags (comma separated)', type: 'text' }, { key: 'subscribed', label: 'Subscribed to marketing email', type: 'checkbox', default: true },
  ],
  accounts: [
    { key: 'name', label: 'Company name', type: 'text', required: true }, { key: 'industry', label: 'Industry', type: 'text' }, { key: 'website', label: 'Website', type: 'url', placeholder: 'https://' },
    { key: 'size', label: 'Company size', type: 'select', options: ['1-50', '51-200', '201-1000', '1000+'] }, { key: 'city', label: 'City', type: 'text' }, { key: 'country', label: 'Country', type: 'text' },
    { key: 'phone', label: 'Phone', type: 'tel' }, { key: 'owner_id', label: 'Owner', type: 'select', source: 'users', noBlank: true, default: '@me' }, { key: 'notes', label: 'Notes', type: 'textarea' },
    { key: 'name_ar', label: 'Name (Arabic)', type: 'text', dir: 'rtl' }, { key: 'vat_number', label: 'VAT / TRN number', type: 'text', placeholder: '15 digits' }, { key: 'street', label: 'Street', type: 'text' },
    { key: 'building_no', label: 'Building no.', type: 'text' }, { key: 'district', label: 'District', type: 'text' }, { key: 'postal_code', label: 'Postal code', type: 'text' },
    { key: 'country_code', label: 'Country code', type: 'text', placeholder: 'SA / AE' }, { key: 'billing_email', label: 'Billing email', type: 'email' }, { key: 'billing_phone', label: 'Billing phone / WhatsApp', type: 'tel' },
  ],
  deals: [
    { key: 'name', label: 'Deal name', type: 'text', required: true }, { key: 'amount', label: 'Amount (USD)', type: 'number', step: '0.01', min: 0, default: 0 },
    { key: 'stage', label: 'Stage', type: 'select', source: 'stages', noBlank: true, default: 'prospecting' }, { key: 'probability', label: 'Probability %', type: 'number', min: 0, max: 100 },
    { key: 'close_date', label: 'Expected close', type: 'date' }, { key: 'owner_id', label: 'Owner', type: 'select', source: 'users', noBlank: true, default: '@me' },
    { key: 'account_id', label: 'Account', type: 'select', source: 'accounts' }, { key: 'contact_id', label: 'Contact', type: 'select', source: 'contacts' },
  ],
};
const sec = (title, fields, columns = 2) => ({ id: title.toLowerCase().replace(/[^a-z0-9]+/g, '_'), title, columns, fields });
export const DEFAULT_LAYOUTS = {
  contacts: { sections: [sec('Contact', ['first_name', 'last_name', 'email', 'phone', 'title', 'account_id', 'status', 'source', 'owner_id', 'tags', 'subscribed'])] },
  accounts: { sections: [sec('Company', ['name', 'industry', 'website', 'size', 'city', 'country', 'phone', 'owner_id', 'notes']), sec('Invoicing details', ['name_ar', 'vat_number', 'street', 'building_no', 'district', 'postal_code', 'country_code', 'billing_email', 'billing_phone'])] },
  deals: { sections: [sec('Deal', ['name', 'amount', 'stage', 'probability', 'close_date', 'owner_id', 'account_id', 'contact_id'])] },
};
const builtinKeys = (entity) => BUILTIN[entity].map((f) => f.key);

// ---------------------------------------------------------------- definitions
const parse = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };
export const fieldOut = (r) => ({
  id: r.id, entity: r.entity, key: r.key, label: r.label, type: r.type, options: parse(r.options, []), config: parse(r.config, {}), required: !!r.required, default_value: r.default_value == null ? null : parse(r.default_value, null),
  help_text: r.help_text, placeholder: r.placeholder, show_in_list: !!r.show_in_list, filterable: !!r.filterable, searchable: !!r.searchable, visible_when: r.visible_when ? parse(r.visible_when, null) : null, archived: !!r.archived, position: r.position,
});
export const listFields = (entity, { archived = false } = {}) => all(`SELECT * FROM field_defs WHERE entity=? ${archived ? '' : 'AND archived=0'} ORDER BY position, id`, entity).map(fieldOut);
const activeByKey = (entity) => Object.fromEntries(listFields(entity).map((f) => [f.key, f]));

const slug = (label) => String(label).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
function uniqueKey(entity, label, wanted) {
  let base = wanted ? String(wanted).toLowerCase() : `cf_${slug(label) || 'field'}`;
  if (!/^cf_[a-z0-9_]{1,40}$/.test(base)) throw bad('Field key must look like cf_partner_name (letters, digits, underscores)');
  let key = base; for (let i = 2; get('SELECT 1 FROM field_defs WHERE entity=? AND key=?', entity, key); i++) key = `${base}_${i}`;
  return key;
}
const optList = (v) => {
  const arr = (Array.isArray(v) ? v : String(v ?? '').split('\n')).map((x) => String(x).trim()).filter(Boolean);
  if (arr.length > LIMITS.options) throw bad(`A list can have at most ${LIMITS.options} options`);
  for (const o of arr) if (o.length > LIMITS.optionLength) throw bad(`Option "${o.slice(0, 20)}…" is longer than ${LIMITS.optionLength} characters`);
  if (new Set(arr.map((x) => x.toLowerCase())).size !== arr.length) throw bad('Dropdown options must be different from each other');
  return arr;
};
const num = (v, label) => { if (v === '' || v == null) return undefined; const n = Number(v); if (!Number.isFinite(n)) throw bad(`${label} must be a number`); return n; };

/** Validate and normalise a field definition from the admin UI. */
function cleanDef(entity, body, existing) {
  const label = String(body.label ?? existing?.label ?? '').replace(/\s+/g, ' ').trim();
  if (label.length < 1 || label.length > 60) throw bad('Field label is required (up to 60 characters)');
  const type = existing ? existing.type : body.type; // the type of an existing field never changes (it would corrupt stored values)
  if (!FIELD_TYPES[type]) throw bad('Choose a field type');
  const cfg = body.config || existing?.config || {}; const config = {};
  if (['number', 'percent', 'currency'].includes(type)) {
    const dec = num(cfg.decimals, 'Decimals'); config.decimals = dec == null ? (type === 'number' ? 2 : type === 'percent' ? 2 : 2) : Math.min(6, Math.max(0, Math.round(dec)));
    const min = num(cfg.min, 'Minimum'), max = num(cfg.max, 'Maximum'); if (min != null) config.min = min; if (max != null) config.max = max;
    if (min != null && max != null && min > max) throw bad('Minimum cannot be greater than maximum');
    if (type === 'percent' && min == null) config.min = 0; if (type === 'percent' && max == null) config.max = 100;
    if (type === 'currency' && cfg.code) config.code = String(cfg.code).toUpperCase().slice(0, 3);
  }
  if (['text', 'textarea'].includes(type)) config.maxLength = Math.min(type === 'text' ? 1000 : 5000, Math.max(1, Math.round(num(cfg.maxLength, 'Maximum length') ?? (type === 'text' ? 255 : 2000))));
  if (type === 'lookup') { if (!['accounts', 'contacts'].includes(cfg.target ?? existing?.config?.target)) throw bad('Choose what the field links to (accounts or contacts)'); config.target = cfg.target ?? existing.config.target; }
  const options = ['dropdown', 'multiselect'].includes(type) ? optList(body.options ?? existing?.options ?? []) : [];
  if (['dropdown', 'multiselect'].includes(type) && !options.length) throw bad('Add at least one option to the list');
  let vw = body.visible_when === undefined ? existing?.visible_when ?? null : body.visible_when;
  if (vw) {
    const key = String(vw.field || ''); const vals = (Array.isArray(vw.values) ? vw.values : [vw.values]).map((x) => String(x)).filter((x) => x !== '');
    const known = builtinKeys(entity).includes(key) || !!activeByKey(entity)[key];
    if (!known) throw bad('The "show only when" field does not exist'); if (existing && key === existing.key) throw bad('A field cannot depend on itself'); if (!vals.length) throw bad('Choose at least one value for "show only when"');
    vw = { field: key, values: vals.slice(0, 50) };
  } else vw = null;
  let def = body.default_value === undefined ? existing?.default_value ?? null : body.default_value;
  const out = { label, type, options, config, required: body.required === undefined ? !!existing?.required : !!body.required, help_text: String(body.help_text ?? existing?.help_text ?? '').slice(0, 200) || null, placeholder: String(body.placeholder ?? existing?.placeholder ?? '').slice(0, 100) || null,
    show_in_list: body.show_in_list === undefined ? !!existing?.show_in_list : !!body.show_in_list, filterable: body.filterable === undefined ? !!existing?.filterable : !!body.filterable, searchable: body.searchable === undefined ? !!existing?.searchable : !!body.searchable, visible_when: vw };
  if (def !== null && def !== '' && def !== undefined) { const t = validateValue({ ...out, key: 'default' }, def, { forDefault: true }); if (t.error) throw bad(`Default value: ${t.error}`); def = t.value; } else def = null;
  out.default_value = def;
  if (out.filterable && !['dropdown', 'multiselect', 'checkbox', 'text', 'number', 'percent', 'currency', 'date', 'email', 'phone', 'lookup'].includes(type)) out.filterable = false;
  if (out.searchable && !['text', 'textarea', 'email', 'phone', 'url', 'dropdown'].includes(type)) out.searchable = false;
  return out;
}

export function createField(user, entity, body) {
  if (!ENTITIES_WITH_CUSTOM.includes(entity)) throw bad('Custom fields can be added to contacts, accounts and deals');
  if (get('SELECT COUNT(*) n FROM field_defs WHERE entity=?', entity).n >= LIMITS.fieldsPerEntity) throw bad(`Limit of ${LIMITS.fieldsPerEntity} custom fields reached`);
  const d = cleanDef(entity, body, null); const key = uniqueKey(entity, d.label, body.key);
  const pos = (get('SELECT MAX(position) p FROM field_defs WHERE entity=?', entity).p ?? 0) + 1;
  const id = Number(run(`INSERT INTO field_defs (entity,key,label,type,options,config,required,default_value,help_text,placeholder,show_in_list,filterable,searchable,visible_when,position,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    entity, key, d.label, d.type, JSON.stringify(d.options), JSON.stringify(d.config), d.required ? 1 : 0, d.default_value === null ? null : JSON.stringify(d.default_value), d.help_text, d.placeholder, d.show_in_list ? 1 : 0, d.filterable ? 1 : 0, d.searchable ? 1 : 0, d.visible_when ? JSON.stringify(d.visible_when) : null, pos, user?.id ?? null).lastInsertRowid);
  audit(user, 'create', 'custom_field', id, `${entity}.${key} (${d.type})`);
  return fieldOut(get('SELECT * FROM field_defs WHERE id=?', id));
}

export function updateField(user, id, body) {
  const row = get('SELECT * FROM field_defs WHERE id=?', id); if (!row) throw notFound('Field not found');
  const cur = fieldOut(row); const d = cleanDef(row.entity, body, cur);
  // option renames keep existing data meaningful: { "Old name": "New name" }
  const renames = body.option_renames && typeof body.option_renames === 'object' ? body.option_renames : {};
  tx(() => {
    run(`UPDATE field_defs SET label=?, options=?, config=?, required=?, default_value=?, help_text=?, placeholder=?, show_in_list=?, filterable=?, searchable=?, visible_when=? WHERE id=?`,
      d.label, JSON.stringify(d.options), JSON.stringify(d.config), d.required ? 1 : 0, d.default_value === null ? null : JSON.stringify(d.default_value), d.help_text, d.placeholder, d.show_in_list ? 1 : 0, d.filterable ? 1 : 0, d.searchable ? 1 : 0, d.visible_when ? JSON.stringify(d.visible_when) : null, id);
    if (['dropdown', 'multiselect'].includes(cur.type)) for (const [from, to] of Object.entries(renames)) {
      if (from === to || !d.options.includes(to)) continue;
      for (const r of all(`SELECT id, custom FROM ${row.entity} WHERE custom LIKE ?`, `%"${row.key}"%`)) {
        const c = parse(r.custom, {}); const v = c[row.key]; let changed = false;
        if (cur.type === 'dropdown' && v === from) { c[row.key] = to; changed = true; }
        if (cur.type === 'multiselect' && Array.isArray(v) && v.includes(from)) { c[row.key] = [...new Set(v.map((x) => (x === from ? to : x)))]; changed = true; }
        if (changed) run(`UPDATE ${row.entity} SET custom=? WHERE id=?`, JSON.stringify(c), r.id);
      }
    }
  });
  audit(user, 'update', 'custom_field', id, `${row.entity}.${row.key}`);
  return fieldOut(get('SELECT * FROM field_defs WHERE id=?', id));
}

export function setArchived(user, id, archived) {
  const row = get('SELECT * FROM field_defs WHERE id=?', id); if (!row) throw notFound('Field not found');
  if (archived) {
    const dependants = listFields(row.entity).filter((f) => f.visible_when?.field === row.key);
    if (dependants.length) throw bad(`Other fields only show when this one has a value: ${dependants.map((d) => d.label).join(', ')}. Change them first.`);
  }
  run('UPDATE field_defs SET archived=? WHERE id=?', archived ? 1 : 0, id);
  if (archived) removeFromLayout(row.entity, row.key);
  audit(user, archived ? 'archive' : 'restore', 'custom_field', id, `${row.entity}.${row.key}`);
  return fieldOut(get('SELECT * FROM field_defs WHERE id=?', id));
}

/** Permanently remove an archived field and its stored values from every record. */
export function purgeField(user, id) {
  const row = get('SELECT * FROM field_defs WHERE id=?', id); if (!row) throw notFound('Field not found');
  if (!row.archived) throw bad('Archive the field first; permanent deletion is only for archived fields.');
  let touched = 0;
  tx(() => {
    for (const r of all(`SELECT id, custom FROM ${row.entity} WHERE custom LIKE ?`, `%"${row.key}"%`)) { const c = parse(r.custom, {}); if (row.key in c) { delete c[row.key]; run(`UPDATE ${row.entity} SET custom=? WHERE id=?`, JSON.stringify(c), r.id); touched++; } }
    run('DELETE FROM field_defs WHERE id=?', id);
  });
  audit(user, 'purge', 'custom_field', id, `${row.entity}.${row.key} (values removed from ${touched} records)`);
  return { ok: true, records_updated: touched };
}

// ---------------------------------------------------------------- values
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; const PHONE = /^[+()\d\s.\-]{5,25}$/;
const isEmpty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const roundTo = (n, d) => { const f = 10 ** d; return Math.round((n + Number.EPSILON) * f) / f; };

/** Validate one value against its definition. Returns { value } (null = unset) or { error }. `existing` lets an unchanged legacy option pass. */
export function validateValue(def, raw, { existing, forDefault } = {}) {
  if (isEmpty(raw)) return { value: null };
  const c = def.config || {};
  switch (def.type) {
    case 'text': case 'textarea': { const s = String(raw).trim(); if (!s) return { value: null }; const max = c.maxLength || (def.type === 'text' ? 255 : 2000); return s.length > max ? { error: `must be at most ${max} characters` } : { value: s }; }
    case 'number': case 'percent': case 'currency': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[,\s]/g, '')); if (!Number.isFinite(n)) return { error: 'must be a number' };
      const v = roundTo(n, c.decimals ?? 2); if (c.min != null && v < c.min) return { error: `must be at least ${c.min}` }; if (c.max != null && v > c.max) return { error: `must be at most ${c.max}` }; return { value: v };
    }
    case 'date': { const s = String(raw).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? { value: s } : { error: 'must be a valid date (YYYY-MM-DD)' }; }
    case 'dropdown': { const s = String(raw); return def.options.includes(s) || (existing !== undefined && existing === s) ? { value: s } : { error: 'is not one of the available options' }; }
    case 'multiselect': {
      const arr = (Array.isArray(raw) ? raw : String(raw).split(',')).map((x) => String(x).trim()).filter(Boolean); const keep = Array.isArray(existing) ? existing : [];
      const badOne = arr.find((x) => !def.options.includes(x) && !keep.includes(x)); if (badOne) return { error: `"${badOne.slice(0, 30)}" is not one of the available options` };
      return { value: [...new Set(arr)] };
    }
    case 'checkbox': return { value: raw === true || raw === 1 || raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes' };
    case 'email': { const s = String(raw).trim().toLowerCase(); return EMAIL.test(s) && s.length <= 200 ? { value: s } : { error: 'must be a valid email address' }; }
    case 'phone': { const s = String(raw).trim(); return PHONE.test(s) ? { value: s } : { error: 'must be a valid phone number' }; }
    case 'url': { const s = String(raw).trim(); return /^https?:\/\/[^\s]+$/i.test(s) && s.length <= 500 ? { value: s } : { error: 'must be a web address starting with http:// or https://' }; }
    case 'lookup': {
      const id = Number.parseInt(raw, 10); if (!Number.isInteger(id)) return { error: 'must pick a record' }; if (forDefault) return { error: 'cannot have a default' };
      return get(`SELECT 1 FROM ${c.target} WHERE id=?`, id) ? { value: id } : { error: `refers to a ${c.target.slice(0, -1)} that does not exist` };
    }
    default: return { error: 'has an unsupported type' };
  }
}

const builtinValue = (record, key) => record?.[key];
/** Is a field shown given the record's current values? (visible_when: another field must equal one of the listed values) */
export function isVisible(def, record, custom) {
  if (!def.visible_when) return true;
  const { field, values } = def.visible_when; const v = field.startsWith('cf_') ? custom?.[field] : builtinValue(record, field);
  if (Array.isArray(v)) return v.some((x) => values.includes(String(x)));
  if (typeof v === 'boolean') return values.includes(v ? 'true' : 'false');
  return v !== undefined && v !== null && values.includes(String(v));
}

/**
 * Merge incoming custom values into a record. Returns the JSON object to store.
 * - create: defaults applied, required fields enforced; update: only keys sent are touched, required enforced when `custom` is sent.
 * - unknown / archived keys are ignored; invalid values throw 400 naming the field.
 */
export function mergeCustom(entity, incoming, { existing = {}, record = {}, isCreate = false } = {}) {
  const defs = listFields(entity); const out = { ...existing }; const errors = [];
  const sent = incoming && typeof incoming === 'object' ? incoming : {};
  for (const d of defs) {
    if (Object.prototype.hasOwnProperty.call(sent, d.key)) {
      const r = validateValue(d, sent[d.key], { existing: existing[d.key] });
      if (r.error) errors.push(`${d.label} ${r.error}`); else if (r.value === null) delete out[d.key]; else out[d.key] = r.value;
    } else if (isCreate && d.default_value !== null && out[d.key] === undefined) out[d.key] = d.default_value;
  }
  if (isCreate || incoming !== undefined) for (const d of defs) if (d.required && isEmpty(out[d.key]) && isVisible(d, record, out)) errors.push(`${d.label} is required`);
  if (errors.length) throw bad(errors[0], { errors });
  return out;
}

// ---------------------------------------------------------------- layout
export function effectiveLayout(entity) {
  const saved = get('SELECT config, updated_at FROM layouts WHERE entity=?', entity);
  const defs = listFields(entity); const have = new Set([...builtinKeys(entity), ...defs.map((d) => d.key)]);
  const base = saved ? parse(saved.config, null) : null;
  const layout = JSON.parse(JSON.stringify(base?.sections ? base : DEFAULT_LAYOUTS[entity]));
  for (const s of layout.sections) s.fields = s.fields.filter((k) => have.has(k));
  const placed = new Set(layout.sections.flatMap((s) => s.fields));
  for (const b of BUILTIN[entity]) if (b.required && !placed.has(b.key)) { layout.sections[0].fields.unshift(b.key); placed.add(b.key); }
  const loose = defs.filter((d) => !placed.has(d.key)).map((d) => d.key);
  if (loose.length) { let s = layout.sections.find((x) => x.id === 'additional'); if (!s) { s = { id: 'additional', title: 'Additional information', columns: 2, fields: [] }; layout.sections.push(s); } s.fields.push(...loose); }
  layout.sections = layout.sections.filter((s) => s.fields.length || layout.sections.length === 1);
  return { ...layout, saved: !!saved, updated_at: saved?.updated_at || null };
}
function removeFromLayout(entity, key) {
  const saved = get('SELECT config FROM layouts WHERE entity=?', entity); if (!saved) return;
  const l = parse(saved.config, null); if (!l?.sections) return;
  for (const s of l.sections) s.fields = s.fields.filter((k) => k !== key);
  run("UPDATE layouts SET config=?, updated_at=datetime('now') WHERE entity=?", JSON.stringify(l), entity);
}
export function saveLayout(user, entity, body) {
  if (!ENTITIES_WITH_CUSTOM.includes(entity)) throw bad('Unknown record type');
  const secs = Array.isArray(body?.sections) ? body.sections : null; if (!secs || !secs.length) throw bad('A layout needs at least one section');
  if (secs.length > LIMITS.sections) throw bad(`At most ${LIMITS.sections} sections`);
  const defs = activeByKey(entity); const allowed = new Set([...builtinKeys(entity), ...Object.keys(defs)]); const seen = new Set(); const ids = new Set();
  const sections = secs.map((s, i) => {
    const title = String(s.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 60); if (!title) throw bad(`Section ${i + 1} needs a title`);
    let id = String(s.id || title).toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40) || `s${i}`; while (ids.has(id)) id += '_';
    ids.add(id); const fields = (Array.isArray(s.fields) ? s.fields : []).map(String);
    for (const k of fields) { if (!allowed.has(k)) throw bad(`Unknown field "${k}"`); if (seen.has(k)) throw bad(`Field "${k}" appears twice`); seen.add(k); }
    return { id, title, columns: Number(s.columns) === 1 ? 1 : 2, fields };
  });
  for (const b of BUILTIN[entity]) if (b.required && !seen.has(b.key)) throw bad(`"${b.label}" is required and must stay on the form`);
  for (const d of Object.values(defs)) if (d.required && !seen.has(d.key)) throw bad(`"${d.label}" is a required field and must stay on the form`);
  run("INSERT INTO layouts (entity,config,updated_by,updated_at) VALUES (?,?,?,datetime('now')) ON CONFLICT(entity) DO UPDATE SET config=excluded.config, updated_by=excluded.updated_by, updated_at=excluded.updated_at", entity, JSON.stringify({ sections }), user?.id ?? null);
  audit(user, 'update', 'layout', null, `${entity}: ${sections.length} section(s)`);
  return effectiveLayout(entity);
}
export function resetLayout(user, entity) { run('DELETE FROM layouts WHERE entity=?', entity); audit(user, 'reset', 'layout', null, entity); return effectiveLayout(entity); }

/** Everything the browser needs to draw forms, lists and detail pages. */
export function customizationBundle() {
  const out = { types: FIELD_TYPES, entities: {} };
  const c1 = get("SELECT value FROM settings WHERE key='currency.c1'")?.value || 'USD';
  for (const e of ENTITIES_WITH_CUSTOM) out.entities[e] = { builtin: BUILTIN[e].map((b) => (e === 'deals' && b.key === 'amount' ? { ...b, label: `Amount (${c1})` } : b)), fields: listFields(e, { archived: true }), layout: effectiveLayout(e) };
  return out;
}

// ---------------------------------------------------------------- records: shaping & SQL helpers
export function shapeRows(entity, rows) {
  const defs = listFields(entity, { archived: true }); const lookups = defs.filter((d) => d.type === 'lookup');
  const names = { accounts: new Map(), contacts: new Map() };
  const parsed = rows.map((r) => ({ ...r, custom: typeof r.custom === 'string' ? parse(r.custom, {}) : r.custom || {} }));
  for (const d of lookups) { const ids = [...new Set(parsed.map((r) => r.custom[d.key]).filter(Number.isInteger))]; if (!ids.length) continue;
    const q = d.config.target === 'accounts' ? `SELECT id, name AS label FROM accounts WHERE id IN (${ids.map(() => '?').join(',')})` : `SELECT id, TRIM(first_name||' '||COALESCE(last_name,'')) AS label FROM contacts WHERE id IN (${ids.map(() => '?').join(',')})`;
    for (const x of all(q, ...ids)) names[d.config.target].set(x.id, x.label); }
  return parsed.map((r) => { const labels = {}; for (const d of lookups) if (r.custom[d.key] != null) labels[d.key] = names[d.config.target].get(r.custom[d.key]) || null; return lookups.length ? { ...r, custom_labels: labels } : r; });
}

const jpath = (alias, key) => `json_extract(${alias}.custom,'$.${key}')`;
/** Extra WHERE parts for list endpoints: cf_<key>=value filters (+ _min/_max) and searchable text. All keys are checked against stored definitions. */
export function customQuery(entity, alias, q) {
  const defs = activeByKey(entity); const where = []; const params = [];
  for (const [k, v] of Object.entries(q)) {
    if (v === '' || v == null || !k.startsWith('cf_')) continue;
    const m = k.match(/^(cf_[a-z0-9_]+?)(_min|_max)?$/); const d = defs[k] || (m && defs[m[1]] && ['number', 'percent', 'currency', 'date'].includes(defs[m[1]].type) ? defs[m[1]] : null); if (!d) continue;
    const range = d.key !== k ? m[2] : null; const col = jpath(alias, d.key);
    if (range) { where.push(`${col} ${range === '_min' ? '>=' : '<='} ${['date'].includes(d.type) ? '?' : 'CAST(? AS REAL)'}`); params.push(String(v)); }
    else if (d.type === 'multiselect') { where.push(`EXISTS (SELECT 1 FROM json_each(${alias}.custom,'$.${d.key}') WHERE value = ?)`); params.push(String(v)); }
    else if (d.type === 'checkbox') { where.push(`${col} = ?`); params.push(v === 'true' || v === '1' ? 1 : 0); }
    else if (['number', 'percent', 'currency', 'lookup'].includes(d.type)) { where.push(`${col} = CAST(? AS REAL)`); params.push(String(v)); }
    else if (['text', 'email', 'phone'].includes(d.type)) { where.push(`${col} LIKE ? ESCAPE '\\'`); params.push(`%${String(v).replace(/[\\%_]/g, (c) => '\\' + c)}%`); }
    else { where.push(`${col} = ?`); params.push(String(v)); }
  }
  return { where, params, searchCols: Object.values(defs).filter((d) => d.searchable).map((d) => jpath(alias, d.key)), sortable: new Set(Object.keys(defs)), path: (key) => jpath(alias, key) };
}

export function contactCustomColumns() { return listFields('contacts'); }
export { activeByKey, LIMITS };
