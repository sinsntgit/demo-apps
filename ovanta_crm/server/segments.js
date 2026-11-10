import { all } from './db.js';
import { bad } from './http.js';
import { listFields } from './customfields.js';

// Whitelisted segment fields -> SQL expressions (contacts aliased c, accounts ac)
export const SEGMENT_FIELDS = {
  status: { sql: 'c.status', type: 'enum', options: ['lead', 'qualified', 'customer', 'churned'], label: 'Contact status' },
  source: { sql: 'c.source', type: 'text', label: 'Source' },
  tags: { sql: "(',' || REPLACE(COALESCE(c.tags,''),' ','') || ',')", type: 'tags', label: 'Tag' },
  title: { sql: 'c.title', type: 'text', label: 'Job title' },
  email_domain: { sql: "SUBSTR(c.email, INSTR(c.email,'@')+1)", type: 'text', label: 'Email domain' },
  industry: { sql: 'ac.industry', type: 'text', label: 'Account industry' },
  country: { sql: 'ac.country', type: 'text', label: 'Account country' },
  city: { sql: 'ac.city', type: 'text', label: 'Account city' },
  account_size: { sql: 'ac.size', type: 'text', label: 'Account size' },
  owner_id: { sql: 'c.owner_id', type: 'number', label: 'Owner (user id)' },
  created_at: { sql: 'DATE(c.created_at)', type: 'date', label: 'Created date' },
};
const CUSTOM_TYPE = { text: 'text', textarea: 'text', email: 'text', phone: 'text', url: 'text', multiselect: 'text', number: 'number', percent: 'number', currency: 'number', date: 'date', dropdown: 'enum', checkbox: 'bool' };
/** Built-in segment fields plus the admin-defined custom fields of contacts ("custom.cf_x") and accounts ("acustom.cf_x"). */
export function segmentFields() {
  const out = { ...SEGMENT_FIELDS };
  for (const [entity, prefix, alias, who] of [['contacts', 'custom', 'c', 'Contact'], ['accounts', 'acustom', 'ac', 'Account']]) {
    for (const d of listFields(entity)) {
      const type = CUSTOM_TYPE[d.type]; if (!type) continue;
      out[`${prefix}.${d.key}`] = { sql: `json_extract(${alias}.custom,'$.${d.key}')`, type, label: `${who}: ${d.label}`, ...(type === 'enum' ? { options: d.options } : {}), ...(type === 'bool' ? { type: 'enum', options: ['yes', 'no'], bool: true } : {}) };
    }
  }
  return out;
}
export const SEGMENT_OPS = ['is', 'is_not', 'contains', 'not_contains', 'starts_with', 'before', 'after', 'is_empty', 'is_not_empty'];

export function parseFilter(raw) {
  let f = raw;
  if (typeof raw === 'string') { try { f = JSON.parse(raw); } catch { throw bad('Invalid segment filter'); } }
  if (!f || typeof f !== 'object') f = {};
  const match = f.match === 'any' ? 'any' : 'all';
  const rules = Array.isArray(f.rules) ? f.rules : [];
  for (const r of rules) {
    if (!segmentFields()[r.field]) throw bad(`Unknown segment field: ${r.field}`);
    if (!SEGMENT_OPS.includes(r.op)) throw bad(`Unknown operator: ${r.op}`);
  }
  return { match, rules: rules.map((r) => ({ field: r.field, op: r.op, value: r.value ?? '' })) };
}

const like = (v) => String(v).replace(/[\\%_]/g, (m) => '\\' + m);

export function buildWhere(filterRaw) {
  const { match, rules } = parseFilter(filterRaw);
  const parts = []; const params = [];
  const FIELDS = segmentFields();
  for (const r of rules) {
    const f = FIELDS[r.field]; const col = f.sql; const v = String(r.value).trim();
    const tags = f.type === 'tags';
    if (f.type === 'number' && ['is', 'is_not', 'before', 'after'].includes(r.op)) { const op = { is: '=', is_not: '<>', before: '<', after: '>' }[r.op]; parts.push(`${col} ${op} CAST(? AS REAL)`); params.push(v); continue; }
    if (f.bool && ['is', 'is_not'].includes(r.op)) { const want = /^(yes|true|1)$/i.test(v) ? 1 : 0; parts.push(r.op === 'is' ? `COALESCE(${col},0) = ?` : `COALESCE(${col},0) <> ?`); params.push(want); continue; }
    switch (r.op) {
      case 'is': if (tags) { parts.push(`${col} LIKE ? ESCAPE '\\'`); params.push(`%,${like(v.replace(/\s/g, ''))},%`); } else { parts.push(`${col} = ? COLLATE NOCASE`); params.push(v); } break;
      case 'is_not': if (tags) { parts.push(`${col} NOT LIKE ? ESCAPE '\\'`); params.push(`%,${like(v.replace(/\s/g, ''))},%`); } else { parts.push(`(${col} IS NULL OR ${col} <> ? COLLATE NOCASE)`); params.push(v); } break;
      case 'contains': parts.push(`${col} LIKE ? ESCAPE '\\'`); params.push(`%${like(v)}%`); break;
      case 'not_contains': parts.push(`(${col} IS NULL OR ${col} NOT LIKE ? ESCAPE '\\')`); params.push(`%${like(v)}%`); break;
      case 'starts_with': parts.push(`${col} LIKE ? ESCAPE '\\'`); params.push(`${like(v)}%`); break;
      case 'before': parts.push(`${col} < ?`); params.push(v); break;
      case 'after': parts.push(`${col} > ?`); params.push(v); break;
      case 'is_empty': parts.push(`(${col} IS NULL OR ${col} = '' OR ${col} = ',,')`); break;
      case 'is_not_empty': parts.push(`(${col} IS NOT NULL AND ${col} <> '' AND ${col} <> ',,')`); break;
    }
  }
  return { sql: parts.length ? '(' + parts.join(match === 'any' ? ' OR ' : ' AND ') + ')' : '1=1', params };
}

const FROM = 'FROM contacts c LEFT JOIN accounts ac ON ac.id=c.account_id';

/** Contacts matching a segment that can actually be emailed (valid email, subscribed). */
export function resolveSegment(filter, { onlyEmailable = true, limit = null } = {}) {
  const w = buildWhere(filter);
  const extra = onlyEmailable ? " AND c.subscribed=1 AND c.email IS NOT NULL AND c.email <> ''" : '';
  return all(`SELECT c.id, c.first_name, c.last_name, c.email, c.title, c.status, ac.name AS account_name ${FROM} WHERE ${w.sql}${extra} ORDER BY c.id ${limit ? 'LIMIT ' + Number(limit) : ''}`, ...w.params);
}
