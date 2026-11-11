import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { all, get, run, audit, nowIso } from './db.js';
import { bad, notFound, forbidden } from './http.js';
import { notify, dealEvents } from './notifications.js';
import { scopeOf, canOnRecord } from './permissions.js';
import { mergeCustom, shapeRows, customQuery, BUILTIN, listFields } from './customfields.js';
import { publishChange } from './live.js';
import { HttpError } from './http.js';

export const STAGES = [
  { key: 'prospecting', label: 'Prospecting', prob: 10 },
  { key: 'qualification', label: 'Qualification', prob: 25 },
  { key: 'proposal', label: 'Proposal', prob: 50 },
  { key: 'negotiation', label: 'Negotiation', prob: 75 },
  { key: 'won', label: 'Closed Won', prob: 100 },
  { key: 'lost', label: 'Closed Lost', prob: 0 },
];

const T = { text: 'text', int: 'int', real: 'real', bool: 'bool', date: 'date', fk: 'fk' };

/** Declarative entity definitions driving the generic CRUD endpoints. */
export const ENTITIES = {
  accounts: {
    custom: true, table: 'accounts', alias: 'a', noun: 'Account',
    fields: { name: T.text, industry: T.text, website: T.text, size: T.text, city: T.text, country: T.text, phone: T.text, notes: T.text, owner_id: T.fk,
      name_ar: T.text, vat_number: T.text, street: T.text, building_no: T.text, district: T.text, postal_code: T.text, country_code: T.text, billing_email: T.text, billing_phone: T.text },
    required: ['name'],
    search: ['a.name', 'a.industry', 'a.city', 'a.country'],
    filters: { industry: 'a.industry', country: 'a.country', owner_id: 'a.owner_id' },
    sorts: { name: 'a.name', industry: 'a.industry', created_at: 'a.created_at', contact_count: 'contact_count', won_value: 'won_value' },
    defaultSort: 'a.name ASC',
    select: `SELECT a.*, u.name AS owner_name,
      (SELECT COUNT(*) FROM contacts c WHERE c.account_id=a.id) AS contact_count,
      (SELECT COALESCE(SUM(amount),0) FROM deals d WHERE d.account_id=a.id AND d.stage='won') AS won_value
      FROM accounts a LEFT JOIN users u ON u.id=a.owner_id`,
  },
  contacts: {
    custom: true, table: 'contacts', alias: 'c', noun: 'Contact',
    fields: { first_name: T.text, last_name: T.text, email: T.text, phone: T.text, title: T.text, account_id: T.fk, status: T.text, source: T.text, tags: T.text, subscribed: T.bool, owner_id: T.fk },
    required: ['first_name'],
    enums: { status: ['lead', 'qualified', 'customer', 'churned'] },
    search: ['c.first_name', 'c.last_name', 'c.email', 'c.title', 'ac.name', "c.first_name || ' ' || COALESCE(c.last_name,'')"],
    filters: { status: 'c.status', source: 'c.source', owner_id: 'c.owner_id', account_id: 'c.account_id', subscribed: 'c.subscribed' },
    sorts: { name: 'c.first_name', email: 'c.email', status: 'c.status', created_at: 'c.created_at', account: 'ac.name' },
    defaultSort: 'c.created_at DESC',
    select: `SELECT c.*, ac.name AS account_name, u.name AS owner_name
      FROM contacts c LEFT JOIN accounts ac ON ac.id=c.account_id LEFT JOIN users u ON u.id=c.owner_id`,
  },
  deals: {
    custom: true, table: 'deals', alias: 'd', noun: 'Deal',
    fields: { name: T.text, amount: T.real, stage: T.text, probability: T.int, close_date: T.date, account_id: T.fk, contact_id: T.fk, owner_id: T.fk },
    required: ['name'],
    enums: { stage: STAGES.map((s) => s.key) },
    search: ['d.name', 'ac.name'],
    filters: { stage: 'd.stage', owner_id: 'd.owner_id', account_id: 'd.account_id', contact_id: 'd.contact_id' },
    sorts: { name: 'd.name', amount: 'd.amount', stage: 'd.stage', close_date: 'd.close_date', created_at: 'd.created_at' },
    defaultSort: 'd.created_at DESC',
    select: `SELECT d.*, ac.name AS account_name, TRIM(c.first_name || ' ' || COALESCE(c.last_name,'')) AS contact_name, u.name AS owner_name
      FROM deals d LEFT JOIN accounts ac ON ac.id=d.account_id LEFT JOIN contacts c ON c.id=d.contact_id LEFT JOIN users u ON u.id=d.owner_id`,
  },
  tasks: {
    table: 'tasks', alias: 't', noun: 'Task',
    fields: { title: T.text, due_date: T.date, priority: T.text, done: T.bool, notes: T.text, owner_id: T.fk, contact_id: T.fk, deal_id: T.fk },
    required: ['title'],
    enums: { priority: ['low', 'medium', 'high'] },
    search: ['t.title', 'c.first_name', 'c.last_name', 'd.name'],
    filters: { done: 't.done', owner_id: 't.owner_id', priority: 't.priority', contact_id: 't.contact_id', deal_id: 't.deal_id', status: 't.status', assigned_by: 't.assigned_by' },
    sorts: { title: 't.title', due_date: 't.due_date', priority: 't.priority', created_at: 't.created_at', status: 't.status' },
    defaultSort: 't.done ASC, t.due_date IS NULL, t.due_date ASC',
    select: `SELECT t.*, TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) AS contact_name, d.name AS deal_name, u.name AS owner_name,
      ab.name AS assigned_by_name,
      (SELECT COUNT(*) FROM files fx WHERE fx.entity='tasks' AND fx.record_id=t.id) AS file_count
      FROM tasks t LEFT JOIN contacts c ON c.id=t.contact_id LEFT JOIN deals d ON d.id=t.deal_id LEFT JOIN users u ON u.id=t.owner_id
      LEFT JOIN users ab ON ab.id=t.assigned_by`,
  },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function clean(ent, input, { partial = false } = {}) {
  const out = {};
  for (const [f, type] of Object.entries(ent.fields)) {
    if (!(f in input) || input[f] === undefined) continue;
    let v = input[f];
    if (v === '' || v === undefined) v = null;
    if (v !== null) {
      if (type === T.text) v = String(v).trim().slice(0, 5000) || null;
      else if (type === T.int || type === T.fk) { v = Number.parseInt(v, 10); if (Number.isNaN(v)) throw bad(`${f} must be a number`); }
      else if (type === T.real) { v = Number(v); if (!Number.isFinite(v) || v < 0) throw bad(`${f} must be a non-negative number`); }
      else if (type === T.bool) v = v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
      else if (type === T.date) { v = String(v).slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad(`${f} must be a valid date`); }
    }
    if (ent.enums?.[f] && v !== null && !ent.enums[f].includes(v)) throw bad(`Invalid ${f}`);
    if (type === T.bool && v === null) v = 0;
    out[f] = v;
  }
  if (!partial) for (const r of ent.required) if (!out[r]) throw bad(`${r.replace('_', ' ')} is required`);
  for (const r of ent.required) if (r in out && !out[r]) throw bad(`${r.replace('_', ' ')} is required`);
  if (out.email) {
    if (!EMAIL_RE.test(out.email)) throw bad('Email address is not valid');
    out.email = out.email.toLowerCase();
  }
  if ('probability' in out && out.probability !== null && (out.probability < 0 || out.probability > 100)) throw bad('Probability must be 0-100');
  return out;
}

function listQuery(ent, q, user) {
  const where = []; const params = [];
  if (user && scopeOf(user, `${ent.table}.view`) === 'own') {
    if (ent.table === 'tasks') { where.push('(t.owner_id = ? OR t.assigned_by = ?)'); params.push(user.id, user.id); } // a task you assigned stays visible to you
    else { where.push(`${ent.alias}.owner_id = ?`); params.push(user.id); }
  }
  const cq = ent.custom ? customQuery(ent.table, ent.alias, q) : null;
  if (q.q) {
    const cols = [...ent.search, ...(cq?.searchCols || [])];
    where.push('(' + cols.map((s) => `${s} LIKE ? ESCAPE '\\'`).join(' OR ') + ')');
    const like = `%${String(q.q).replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    cols.forEach(() => params.push(like));
  }
  if (cq) { where.push(...cq.where); params.push(...cq.params); }
  for (const [k, col] of Object.entries(ent.filters)) {
    if (q[k] !== undefined && q[k] !== '') {
      if (q[k] === 'null') where.push(`${col} IS NULL`); else { where.push(`${col} = ?`); params.push(q[k]); }
    }
  }
  if (ent.table === 'contacts' && q.tag) { where.push(`(',' || REPLACE(COALESCE(c.tags,''),' ','') || ',') LIKE ?`); params.push(`%,${String(q.tag).replace(/\s/g, '')},%`); }
  if (ent.table === 'tasks' && user && q.mine === 'to_me') { where.push('t.owner_id = ?'); params.push(user.id); }
  if (ent.table === 'tasks' && user && q.mine === 'by_me') { where.push('t.assigned_by = ?'); params.push(user.id); }
  if (ent.table === 'tasks' && q.due === 'overdue') where.push(`t.done=0 AND t.due_date < date('now')`);
  if (ent.table === 'tasks' && q.due === 'today') where.push(`t.done=0 AND t.due_date = date('now')`);
  if (ent.table === 'tasks' && q.due === 'week') where.push(`t.done=0 AND t.due_date BETWEEN date('now') AND date('now','+7 day')`);
  return { where: where.length ? ' WHERE ' + where.join(' AND ') : '', params };
}

const builtinDefaults = (entity) => Object.fromEntries(BUILTIN[entity].filter((f) => f.default !== undefined && f.default !== '@me').map((f) => [f.key, f.default]));

export function list(ent, q, user) {
  const { where, params } = listQuery(ent, q, user);
  const limit = Math.min(Math.max(parseInt(q.limit || '25', 10) || 25, 1), 1000);
  const page = Math.max(parseInt(q.page || '1', 10) || 1, 1);
  const dir = q.dir === 'desc' ? 'DESC' : 'ASC';
  const cq = ent.custom && /^cf_[a-z0-9_]+$/.test(q.sort || '') ? customQuery(ent.table, ent.alias, {}) : null;
  const customSort = cq && cq.sortable.has(q.sort) ? `(${cq.path(q.sort)} IS NULL), ${cq.path(q.sort)} ${dir}` : null;
  const order = customSort || (ent.sorts[q.sort] ? `${ent.sorts[q.sort]} ${dir}` : ent.defaultSort);
  const total = get(`SELECT COUNT(*) AS n FROM (${ent.select}${where})`, ...params).n;
  let rows = all(`${ent.select}${where} ORDER BY ${order}, ${ent.alias}.id DESC LIMIT ? OFFSET ?`, ...params, limit, (page - 1) * limit);
  if (ent.custom) rows = shapeRows(ent.table, rows);
  return { rows, total, page, limit };
}

export function getOne(ent, id, user) {
  const row = get(`${ent.select} WHERE ${ent.alias}.id = ?`, id);
  if (!row) throw notFound(`${ent.noun} not found`);
  if (user && scopeOf(user, `${ent.table}.view`) === 'own' && row.owner_id !== user.id && !(ent.table === 'tasks' && row.assigned_by === user.id)) throw notFound(`${ent.noun} not found`); // hide records outside the user's scope
  return ent.custom ? shapeRows(ent.table, [row])[0] : row;
}

/** Append one stage-movement row. `deal` is the row AFTER the change (joined, with owner_name). */
export function recordStageChange(deal, fromStage, comment, user) {
  run(`INSERT INTO deal_stage_history (deal_id,from_stage,to_stage,comment,amount,owner_id,owner_name,changed_by,changed_by_name,changed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`, deal.id, fromStage, deal.stage, String(comment || '').trim().slice(0, 1000) || null, deal.amount, deal.owner_id, deal.owner_name || null, user?.id ?? null, user?.name ?? null, nowIso());
}

function insert(table, data) {
  const cols = Object.keys(data);
  const r = run(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...Object.values(data));
  return Number(r.lastInsertRowid);
}

/** Per-table extension points (e.g. task assignment): before(data, body, existing, user) may adjust the row; after(row, existing, body, user) runs side effects. */
export const hooks = { before: {}, after: {} };
const canEdit = (user, ent, rec) => canOnRecord(user, `${ent.table}.edit`, rec.owner_id) || (ent.table === 'tasks' && rec.assigned_by === user?.id);
export function create(ent, body, user) {
  const data = clean(ent, body);
  if (ent.custom) data.custom = JSON.stringify(mergeCustom(ent.table, body.custom, { existing: {}, record: { ...builtinDefaults(ent.table), ...data }, isCreate: true }));
  if (ent.table === 'deals') applyDealStage(data, null);
  if (ent.table === 'contacts' && data.email === undefined) data.email = null;
  hooks.before[ent.table]?.(data, body, null, user);
  if (!('owner_id' in data) && ent.fields.owner_id) data.owner_id = user.id;
  const id = insert(ent.table, data);
  audit(user, 'create', ent.table, id, data.name || data.title || data.first_name);
  const created = getOne(ent, id);
  const ev = { contacts: 'contact.created', deals: 'deal.created', accounts: 'account.created' }[ent.table];
  if (ent.table === 'deals') recordStageChange(created, null, body.stage_comment || 'Deal created', user);
  if (ev) notify([ev], created, {}, user);
  hooks.after[ent.table]?.(created, null, body, user);
  publishChange(ent.table, created, user, 'created');
  return created;
}

// ---------------------------------------------------------------- concurrent edits
/** Comparable form of a value as forms send it ("25000" == 25000, '' == null, arrays order-free). */
const norm = (v) => {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (Array.isArray(v)) return JSON.stringify(v.map(String).sort());
  const s = String(v).trim(); return s !== '' && !isNaN(s) ? String(Number(s)) : s;
};
const TASK_LABELS = { title: 'Task', due_date: 'Due date', priority: 'Priority', notes: 'Details', owner_id: 'Assigned to', contact_id: 'Related contact', deal_id: 'Related deal' };
function fieldLabel(table, f) { return (BUILTIN[table] || []).find((b) => b.key === f)?.label || TASK_LABELS[f] || listFields(table).find((d) => d.key === f)?.label || f; }
function display(table, f, v) {
  if (v === null || v === undefined || v === '') return '—';
  const one = (sql) => get(sql, v)?.n ?? `#${v}`;
  if (f === 'owner_id') return one('SELECT name n FROM users WHERE id=?');
  if (f === 'account_id') return one('SELECT name n FROM accounts WHERE id=?');
  if (f === 'contact_id') return one("SELECT TRIM(first_name||' '||COALESCE(last_name,'')) n FROM contacts WHERE id=?");
  if (f === 'deal_id') return one('SELECT name n FROM deals WHERE id=?');
  if (f === 'stage') return STAGES.find((s) => s.key === v)?.label || v;
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}
/**
 * Three-way check: for each field this save changes, compare what the editor originally loaded (`body.__base`) with what is stored now.
 * If someone else changed that same field in the meantime (and not to the same value), it is a conflict. Fields listed in
 * `body.__force` are ones the editor has already decided to overwrite. Fields nobody else touched simply merge.
 */
function findConflicts(ent, existing, data, body) {
  const base = body.__base; if (!base || typeof base !== 'object') return [];
  const force = new Set(Array.isArray(body.__force) ? body.__force.map(String) : []); const out = [];
  const check = (f, cur, was, mine) => { if (force.has(f)) return; if (norm(cur) !== norm(was) && norm(cur) !== norm(mine)) out.push({ field: f, label: fieldLabel(ent.table, f), base: display(ent.table, f, was), theirs: display(ent.table, f, cur), yours: display(ent.table, f, mine), theirs_raw: cur ?? null }); };
  for (const f of Object.keys(data)) if (f !== 'custom' && Object.prototype.hasOwnProperty.call(base, f)) check(f, existing[f], base[f], data[f]);
  if (ent.custom && body.custom && base.custom && typeof base.custom === 'object') for (const k of Object.keys(body.custom)) if (Object.prototype.hasOwnProperty.call(base.custom, k)) check(k, existing.custom?.[k], base.custom[k], body.custom[k]);
  return out;
}

export function update(ent, id, body, user) {
  const existing = getOne(ent, id, user);
  if (!canEdit(user, ent, existing)) throw forbidden(`Your role can only edit ${ent.noun.toLowerCase()}s you own.`);
  const data = clean(ent, body, { partial: true });
  const conflicts = findConflicts(ent, existing, data, body);
  if (conflicts.length) {
    const who = existing.updated_by ? get('SELECT name FROM users WHERE id=?', existing.updated_by)?.name : null;
    throw new HttpError(409, `${who || 'Someone else'} changed ${conflicts.map((c) => c.label).join(', ')} while you were editing. Choose which values to keep.`, { conflict: true, conflicts, updated_by_name: who, updated_at: existing.updated_at, version: existing.version });
  }
  hooks.before[ent.table]?.(data, body, existing, user);
  if (ent.custom && body.custom !== undefined) data.custom = JSON.stringify(mergeCustom(ent.table, body.custom, { existing: existing.custom || {}, record: { ...existing, ...data }, isCreate: false }));
  if (ent.table === 'deals') applyDealStage(data, existing);
  const cols = Object.keys(data);
  if (cols.length) run(`UPDATE ${ent.table} SET ${cols.map((c) => `${c}=?`).join(',')}, version = version + 1, updated_at = ?, updated_by = ? WHERE id=?`, ...Object.values(data), nowIso(), user?.id ?? null, id);
  audit(user, 'update', ent.table, id, existing.name || existing.title || existing.first_name);
  const updated = getOne(ent, id);
  if (cols.length) publishChange(ent.table, updated, user, 'updated');
  hooks.after[ent.table]?.(updated, existing, body, user);
  if (ent.table === 'deals') {
    if (existing.stage !== updated.stage) recordStageChange(updated, existing.stage, body.stage_comment, user);
    const d = dealEvents(existing, updated); if (d.events.length) notify(d.events, updated, { changes: d.changes, comment: existing.stage !== updated.stage ? String(body.stage_comment || '').trim().slice(0, 1000) : '' }, user);
  }
  if (ent.table === 'contacts') {
    const changes = ['first_name', 'last_name', 'email', 'phone', 'title', 'status', 'source', 'tags'].filter((k) => (existing[k] ?? null) !== (updated[k] ?? null)).map((k) => ({ field: k, from: existing[k], to: updated[k] }));
    if (changes.length) notify(['contact.updated'], updated, { changes }, user);
  }
  return updated;
}

/** Remove attachments (rows and stored bytes) of a record that no longer exists. */
export function dropFiles(entity, id) {
  for (const f of all('SELECT id, path FROM files WHERE entity=? AND record_id=?', entity, id)) { try { fs.unlinkSync(path.join(config.filesDir, f.path)); } catch {} }
  run('DELETE FROM files WHERE entity=? AND record_id=?', entity, id);
}
export function remove(ent, id, user) {
  const existing = getOne(ent, id, user);
  if (!canOnRecord(user, `${ent.table}.delete`, existing.owner_id)) throw forbidden(`Your role can only delete ${ent.noun.toLowerCase()}s you own.`);
  run(`DELETE FROM ${ent.table} WHERE id=?`, id);
  dropFiles(ent.table, id);
  audit(user, 'delete', ent.table, id, existing.name || existing.title || existing.first_name);
  hooks.removed?.[ent.table]?.(existing, user);
  publishChange(ent.table, existing, user, 'deleted');
  if (ent.table === 'deals') notify(['deal.deleted'], existing, {}, user);
  if (ent.table === 'contacts') notify(['contact.deleted'], existing, {}, user);
  return { ok: true };
}

function applyDealStage(data, existing) {
  if (data.stage && (!existing || data.stage !== existing.stage)) {
    const st = STAGES.find((s) => s.key === data.stage);
    if (!('probability' in data) || data.probability === null) data.probability = st.prob;
    data.closed_at = data.stage === 'won' || data.stage === 'lost' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null;
  }
}
