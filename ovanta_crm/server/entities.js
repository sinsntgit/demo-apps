import { all, get, run, audit, nowIso } from './db.js';
import { bad, notFound, forbidden } from './http.js';
import { notify, dealEvents } from './notifications.js';

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
    table: 'accounts', alias: 'a', noun: 'Account',
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
    table: 'contacts', alias: 'c', noun: 'Contact',
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
    table: 'deals', alias: 'd', noun: 'Deal',
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
    filters: { done: 't.done', owner_id: 't.owner_id', priority: 't.priority', contact_id: 't.contact_id', deal_id: 't.deal_id' },
    sorts: { title: 't.title', due_date: 't.due_date', priority: 't.priority', created_at: 't.created_at' },
    defaultSort: 't.done ASC, t.due_date IS NULL, t.due_date ASC',
    select: `SELECT t.*, TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) AS contact_name, d.name AS deal_name, u.name AS owner_name
      FROM tasks t LEFT JOIN contacts c ON c.id=t.contact_id LEFT JOIN deals d ON d.id=t.deal_id LEFT JOIN users u ON u.id=t.owner_id`,
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

function listQuery(ent, q) {
  const where = []; const params = [];
  if (q.q) {
    where.push('(' + ent.search.map((s) => `${s} LIKE ? ESCAPE '\\'`).join(' OR ') + ')');
    const like = `%${String(q.q).replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    ent.search.forEach(() => params.push(like));
  }
  for (const [k, col] of Object.entries(ent.filters)) {
    if (q[k] !== undefined && q[k] !== '') {
      if (q[k] === 'null') where.push(`${col} IS NULL`); else { where.push(`${col} = ?`); params.push(q[k]); }
    }
  }
  if (ent.table === 'contacts' && q.tag) { where.push(`(',' || REPLACE(COALESCE(c.tags,''),' ','') || ',') LIKE ?`); params.push(`%,${String(q.tag).replace(/\s/g, '')},%`); }
  if (ent.table === 'tasks' && q.due === 'overdue') where.push(`t.done=0 AND t.due_date < date('now')`);
  if (ent.table === 'tasks' && q.due === 'today') where.push(`t.done=0 AND t.due_date = date('now')`);
  if (ent.table === 'tasks' && q.due === 'week') where.push(`t.done=0 AND t.due_date BETWEEN date('now') AND date('now','+7 day')`);
  return { where: where.length ? ' WHERE ' + where.join(' AND ') : '', params };
}

export function list(ent, q) {
  const { where, params } = listQuery(ent, q);
  const limit = Math.min(Math.max(parseInt(q.limit || '25', 10) || 25, 1), 1000);
  const page = Math.max(parseInt(q.page || '1', 10) || 1, 1);
  const dir = q.dir === 'desc' ? 'DESC' : 'ASC';
  const order = ent.sorts[q.sort] ? `${ent.sorts[q.sort]} ${dir}` : ent.defaultSort;
  const total = get(`SELECT COUNT(*) AS n FROM (${ent.select}${where})`, ...params).n;
  const rows = all(`${ent.select}${where} ORDER BY ${order}, ${ent.alias}.id DESC LIMIT ? OFFSET ?`, ...params, limit, (page - 1) * limit);
  return { rows, total, page, limit };
}

export function getOne(ent, id) {
  const row = get(`${ent.select} WHERE ${ent.alias}.id = ?`, id);
  if (!row) throw notFound(`${ent.noun} not found`);
  return row;
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

export function create(ent, body, user) {
  const data = clean(ent, body);
  if (ent.table === 'deals') applyDealStage(data, null);
  if (ent.table === 'contacts' && data.email === undefined) data.email = null;
  if (!('owner_id' in data) && ent.fields.owner_id) data.owner_id = user.id;
  const id = insert(ent.table, data);
  audit(user, 'create', ent.table, id, data.name || data.title || data.first_name);
  const created = getOne(ent, id);
  const ev = { contacts: 'contact.created', deals: 'deal.created', accounts: 'account.created' }[ent.table];
  if (ent.table === 'deals') recordStageChange(created, null, body.stage_comment || 'Deal created', user);
  if (ev) notify([ev], created, {}, user);
  return created;
}

export function update(ent, id, body, user) {
  const existing = getOne(ent, id);
  const data = clean(ent, body, { partial: true });
  if (ent.table === 'deals') applyDealStage(data, existing);
  const cols = Object.keys(data);
  if (cols.length) run(`UPDATE ${ent.table} SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`, ...Object.values(data), id);
  audit(user, 'update', ent.table, id, existing.name || existing.title || existing.first_name);
  const updated = getOne(ent, id);
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

export function remove(ent, id, user) {
  const existing = getOne(ent, id);
  if (user.role === 'rep' && existing.owner_id !== user.id) throw forbidden('Reps can only delete records they own');
  run(`DELETE FROM ${ent.table} WHERE id=?`, id);
  audit(user, 'delete', ent.table, id, existing.name || existing.title || existing.first_name);
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
