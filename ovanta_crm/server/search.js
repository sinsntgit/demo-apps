import { GET, POST, bad } from './http.js';
import { all } from './db.js';
import { STAGES } from './entities.js';
import { hasPerm, scopeOf } from './permissions.js';
import { listFields } from './customfields.js';
import { aiConfigured, callClaude, responseText } from './ai.js';
import { canSeeRecord } from './files.js';
import { currencyPair as cur } from './currency.js';

/*
 * Natural-language search. Claude only ever sees the question plus field NAMES (never record data) and answers with a
 * query plan; the plan is checked against the whitelist below and run as parameterised SQL, so it cannot reach
 * anything the catalogue does not list, and every result still goes through the user's permissions and own/all scope.
 */
const STAGE_KEYS = STAGES.map((s) => s.key);
const FULLNAME = (a) => `TRIM(${a}.first_name || ' ' || COALESCE(${a}.last_name,''))`;
const FILE_RECORD = `CASE f.entity WHEN 'deals' THEN (SELECT name FROM deals WHERE id=f.record_id) WHEN 'accounts' THEN (SELECT name FROM accounts WHERE id=f.record_id)
  WHEN 'contacts' THEN (SELECT TRIM(first_name||' '||COALESCE(last_name,'')) FROM contacts WHERE id=f.record_id) WHEN 'invoices' THEN (SELECT COALESCE(number,'Draft invoice #'||id) FROM invoices WHERE id=f.record_id) END`;
const FILE_ACCOUNT = `CASE f.entity WHEN 'accounts' THEN (SELECT name FROM accounts WHERE id=f.record_id) WHEN 'deals' THEN (SELECT a.name FROM deals x JOIN accounts a ON a.id=x.account_id WHERE x.id=f.record_id)
  WHEN 'contacts' THEN (SELECT a.name FROM contacts x JOIN accounts a ON a.id=x.account_id WHERE x.id=f.record_id) WHEN 'invoices' THEN (SELECT a.name FROM invoices x JOIN accounts a ON a.id=x.account_id WHERE x.id=f.record_id) END`;
const FILE_KIND = `CASE WHEN f.mime LIKE 'image/%' THEN 'image' WHEN f.mime='application/pdf' THEN 'pdf' WHEN f.mime LIKE '%wordprocessing%' OR f.mime LIKE '%msword%' THEN 'document'
  WHEN f.mime LIKE '%spreadsheet%' OR f.mime LIKE '%excel%' OR f.mime='text/csv' THEN 'spreadsheet' WHEN f.mime LIKE '%presentation%' OR f.mime LIKE '%powerpoint%' THEN 'presentation'
  WHEN f.mime LIKE 'video/%' THEN 'video' WHEN f.mime LIKE 'audio/%' THEN 'audio' WHEN f.mime LIKE 'text/%' THEN 'text' ELSE 'other' END`;

const BASE = {
  deals: {
    label: 'Deals', perm: 'deals.view', owner: 'd.owner_id', alias: 'd',
    from: 'deals d LEFT JOIN accounts ac ON ac.id=d.account_id LEFT JOIN contacts c ON c.id=d.contact_id LEFT JOIN users u ON u.id=d.owner_id LEFT JOIN deal_fx fx ON fx.deal_id=d.id',
    select: "d.id, d.name, d.amount, fx.amount2, d.stage, d.close_date, d.custom, ac.name AS account_name, u.name AS owner_name", text: ['d.name', 'ac.name'], sort: 'd.created_at DESC',
    fields: { name: ['d.name', 'text'], amount: ['d.amount', 'number'], amount_currency2: ['fx.amount2', 'number'], stage: ['d.stage', 'enum', STAGE_KEYS], probability: ['d.probability', 'number'], close_date: ['d.close_date', 'date'],
      created_at: ['d.created_at', 'date'], closed_at: ['d.closed_at', 'date'], owner: ['u.name', 'text'], account: ['ac.name', 'text'], contact: [FULLNAME('c'), 'text'],
      file_count: ["(SELECT COUNT(*) FROM files fx WHERE fx.entity='deals' AND fx.record_id=d.id)", 'number'] },
    row: (r) => ({ id: r.id, title: r.name, subtitle: [STAGES.find((s) => s.key === r.stage)?.label, money(r.amount) + (r.amount2 != null ? ` (${money(r.amount2, cur().c2)})` : ''), r.account_name, r.owner_name && `owner ${r.owner_name}`].filter(Boolean).join(' · '), link: `#/deals/${r.id}` }),
  },
  contacts: {
    label: 'Contacts', perm: 'contacts.view', owner: 'c.owner_id', alias: 'c',
    from: 'contacts c LEFT JOIN accounts ac ON ac.id=c.account_id LEFT JOIN users u ON u.id=c.owner_id',
    select: 'c.id, c.first_name, c.last_name, c.email, c.title, c.status, c.custom, ac.name AS account_name', text: [FULLNAME('c'), 'c.email', 'c.title', 'ac.name', 'c.phone'], sort: 'c.created_at DESC',
    fields: { name: [FULLNAME('c'), 'text'], email: ['c.email', 'text'], phone: ['c.phone', 'text'], title: ['c.title', 'text'], status: ['c.status', 'enum', ['lead', 'qualified', 'customer', 'churned']],
      source: ['c.source', 'text'], tags: ['c.tags', 'text'], subscribed: ['c.subscribed', 'bool'], converted: ['(c.converted_at IS NOT NULL)', 'bool'], owner: ['u.name', 'text'], account: ['ac.name', 'text'], created_at: ['c.created_at', 'date'] },
    row: (r) => ({ id: r.id, title: `${r.first_name} ${r.last_name || ''}`.trim(), subtitle: [r.title, r.account_name, r.email, r.status].filter(Boolean).join(' · '), link: `#/contacts/${r.id}` }),
  },
  accounts: {
    label: 'Accounts', perm: 'accounts.view', owner: 'a.owner_id', alias: 'a',
    from: 'accounts a LEFT JOIN users u ON u.id=a.owner_id',
    select: 'a.id, a.name, a.industry, a.city, a.country, a.custom, u.name AS owner_name', text: ['a.name', 'a.industry', 'a.city', 'a.country', 'a.website'], sort: 'a.name ASC',
    fields: { name: ['a.name', 'text'], industry: ['a.industry', 'text'], city: ['a.city', 'text'], country: ['a.country', 'text'], size: ['a.size', 'text'], website: ['a.website', 'text'], vat_number: ['a.vat_number', 'text'],
      owner: ['u.name', 'text'], created_at: ['a.created_at', 'date'], contact_count: ['(SELECT COUNT(*) FROM contacts x WHERE x.account_id=a.id)', 'number'],
      won_value: ["(SELECT COALESCE(SUM(amount),0) FROM deals x WHERE x.account_id=a.id AND x.stage='won')", 'number'], open_deal_count: ["(SELECT COUNT(*) FROM deals x WHERE x.account_id=a.id AND x.stage NOT IN ('won','lost'))", 'number'] },
    row: (r) => ({ id: r.id, title: r.name, subtitle: [r.industry, [r.city, r.country].filter(Boolean).join(', '), r.owner_name && `owner ${r.owner_name}`].filter(Boolean).join(' · '), link: `#/accounts/${r.id}` }),
  },
  files: {
    label: 'Files', perm: 'attachments.view', alias: 'f', from: 'files f',
    select: `f.id, f.entity, f.record_id, f.stage, f.name, f.mime, f.size, f.created_at, f.uploaded_by_name, ${FILE_RECORD} AS record_name`, text: ['f.name', 'f.note', FILE_RECORD], sort: 'f.created_at DESC',
    fields: { name: ['f.name', 'text'], kind: [FILE_KIND, 'enum', ['pdf', 'image', 'document', 'spreadsheet', 'presentation', 'video', 'audio', 'text', 'other']], stage: ['f.stage', 'enum', STAGE_KEYS],
      attached_to: ['f.entity', 'enum', ['deals', 'accounts', 'contacts', 'invoices']], record_name: [FILE_RECORD, 'text'], account: [FILE_ACCOUNT, 'text'], uploaded_by: ['f.uploaded_by_name', 'text'],
      created_at: ['f.created_at', 'date'], size_bytes: ['f.size', 'number'], note: ['f.note', 'text'] },
    row: (r) => ({ id: r.id, title: r.name, subtitle: [r.record_name, r.stage && `${STAGES.find((s) => s.key === r.stage)?.label} folder`, r.uploaded_by_name].filter(Boolean).join(' · '), link: `#/${r.entity}/${r.record_id}`,
      file: { id: r.id, name: r.name, mime: r.mime, size: r.size, entity: r.entity, record_id: r.record_id, stage: r.stage } }),
    visible: (r, user) => canSeeRecord(r.entity, r.record_id, user),
  },
  campaigns: {
    label: 'Campaigns', perm: 'campaigns.view', alias: 'm', from: 'campaigns m LEFT JOIN segments s ON s.id=m.segment_id',
    select: 'm.id, m.name, m.subject, m.status, m.sent_at, m.scheduled_at, m.created_at, s.name AS segment_name', text: ['m.name', 'm.subject'], sort: 'm.created_at DESC',
    fields: { name: ['m.name', 'text'], subject: ['m.subject', 'text'], status: ['m.status', 'enum', ['draft', 'scheduled', 'sending', 'sent', 'cancelled']], sent_at: ['m.sent_at', 'date'], scheduled_at: ['m.scheduled_at', 'date'],
      created_at: ['m.created_at', 'date'], from_email: ['m.from_email', 'text'], segment: ['s.name', 'text'],
      recipients: ['(SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id=m.id)', 'number'], opened: ['(SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id=m.id AND r.first_open_at IS NOT NULL)', 'number'],
      clicked: ['(SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id=m.id AND r.first_click_at IS NOT NULL)', 'number'] },
    row: (r) => ({ id: r.id, title: r.name, subtitle: [r.status, r.subject, r.segment_name && `segment ${r.segment_name}`, r.sent_at && `sent ${String(r.sent_at).slice(0, 10)}`].filter(Boolean).join(' · '), link: `#/campaigns/${r.id}` }),
  },
  segments: {
    label: 'Segments', perm: 'segments.view', alias: 'g', from: 'segments g', select: 'g.id, g.name, g.description, g.created_at', text: ['g.name', 'g.description'], sort: 'g.name ASC',
    fields: { name: ['g.name', 'text'], description: ['g.description', 'text'], created_at: ['g.created_at', 'date'], used_by_campaigns: ['(SELECT COUNT(*) FROM campaigns x WHERE x.segment_id=g.id)', 'number'] },
    row: (r) => ({ id: r.id, title: r.name, subtitle: r.description || '', link: '#/segments' }),
  },
};
export const SEARCH_ENTITIES = Object.keys(BASE);
const OPS = ['eq', 'neq', 'contains', 'starts_with', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'empty', 'not_empty'];
function money(n, code = cur().c1) { try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: code || 'USD', maximumFractionDigits: 0 }).format(n || 0); } catch { return `${code} ${Math.round(n || 0)}`; } }

/** The catalogue for this moment: built-ins plus the admin's custom fields (deals, contacts, accounts). */
function catalogue() {
  const cat = {};
  for (const [ent, b] of Object.entries(BASE)) {
    const fields = Object.fromEntries(Object.entries(b.fields).map(([k, [col, type, values]]) => [k, { col, type, values, label: k }]));
    const text = [...b.text];
    if (['deals', 'contacts', 'accounts'].includes(ent)) for (const d of listFields(ent)) {
      const col = `json_extract(${b.alias}.custom, '$.${d.key}')`;
      const type = ['number', 'percent', 'currency'].includes(d.type) ? 'number' : d.type === 'date' ? 'date' : d.type === 'checkbox' ? 'bool' : d.type === 'dropdown' ? 'enum' : d.type === 'multiselect' ? 'multi' : d.type === 'lookup' ? null : 'text';
      if (!type) continue;
      fields[d.key] = { col, type, values: ['dropdown', 'multiselect'].includes(d.type) ? d.options : undefined, label: d.label, custom: true };
      if (d.searchable || ['text', 'textarea', 'dropdown'].includes(d.type)) text.push(col);
    }
    cat[ent] = { ...b, fields, text };
  }
  return cat;
}

// ---------------------------------------------------------------- SQL from a checked plan
const esc = (s) => String(s).replace(/[\\%_]/g, (m) => '\\' + m);
const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v).trim()) ? String(v).trim() : null);
function enumValue(fd, v) { // accept the key or the human label ("Closed Won" → won)
  const s = String(v ?? '').trim().toLowerCase(); if (!s) return null;
  const hit = (fd.values || []).find((x) => String(x).toLowerCase() === s) ?? STAGES.find((x) => x.label.toLowerCase() === s && fd.values?.includes(x.key))?.key;
  return hit ?? null;
}
function condition(fd, f) {
  const { col, type } = fd; const op = f.op; const v = f.value ?? ''; const vals = Array.isArray(f.values) ? f.values : [];
  if (op === 'empty') return [`(${col} IS NULL OR ${col} = '')`, []];
  if (op === 'not_empty') return [`(${col} IS NOT NULL AND ${col} <> '')`, []];
  if (type === 'bool') { const b = /^(true|yes|1)$/i.test(String(v)) ? 1 : /^(false|no|0)$/i.test(String(v)) ? 0 : null; if (b === null || !['eq', 'neq'].includes(op)) return null; return [`COALESCE(${col},0) ${op === 'eq' ? '=' : '<>'} ?`, [b]]; }
  if (type === 'number') {
    const n = Number(v), n2 = Number(f.value2);
    const cmp = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
    if (cmp && Number.isFinite(n)) return [`CAST(${col} AS REAL) ${cmp} ?`, [n]];
    if (op === 'between' && Number.isFinite(n) && Number.isFinite(n2)) return [`CAST(${col} AS REAL) BETWEEN ? AND ?`, [n, n2]];
    return null;
  }
  if (type === 'date') {
    const d = isoDate(v), d2 = isoDate(f.value2); const cmp = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op]; const c = `substr(${col},1,10)`;
    if (cmp && d) return [`${c} ${cmp} ?`, [d]];
    if (op === 'between' && d && d2) return [`${c} BETWEEN ? AND ?`, [d, d2]];
    return null;
  }
  if (type === 'enum') {
    if (op === 'in') { const xs = vals.map((x) => enumValue(fd, x)).filter((x) => x !== null); return xs.length ? [`${col} IN (${xs.map(() => '?').join(',')})`, xs] : null; }
    const x = enumValue(fd, v); if (x === null || !['eq', 'neq'].includes(op)) return null; return [`${col} ${op === 'eq' ? '=' : '<>'} ?`, [x]];
  }
  if (type === 'multi') { if (!['contains', 'eq', 'in'].includes(op)) return null; const xs = op === 'in' ? vals : [v]; const ok = xs.filter((x) => String(x).trim()); if (!ok.length) return null; return [`(${ok.map(() => `${col} LIKE ? ESCAPE '\\'`).join(' OR ')})`, ok.map((x) => `%"${esc(x)}"%`)]; }
  // text
  const s = String(v).trim();
  if (op === 'in') { const xs = vals.map((x) => String(x).trim().toLowerCase()).filter(Boolean); return xs.length ? [`LOWER(${col}) IN (${xs.map(() => '?').join(',')})`, xs] : null; }
  if (!s) return null;
  if (op === 'eq') return [`LOWER(${col}) = LOWER(?)`, [s]];
  if (op === 'neq') return [`(${col} IS NULL OR LOWER(${col}) <> LOWER(?))`, [s]];
  if (op === 'contains') return [`LOWER(${col}) LIKE LOWER(?) ESCAPE '\\'`, [`%${esc(s)}%`]];
  if (op === 'starts_with') return [`LOWER(${col}) LIKE LOWER(?) ESCAPE '\\'`, [`${esc(s)}%`]];
  return null;
}

function runQuery(cat, q, user) {
  const e = cat[q.entity]; const warnings = [];
  if (!e) return { warnings: [`Unknown kind of record “${q.entity}”`] };
  if (!hasPerm(user, e.perm)) return { denied: true, warnings: [`Your role cannot view ${e.label.toLowerCase()}`] };
  const where = [], params = [];
  if (e.owner && scopeOf(user, e.perm) === 'own') { where.push(`${e.owner} = ?`); params.push(user.id); }
  const text = String(q.text || '').trim();
  if (text) for (const word of text.split(/\s+/).slice(0, 6)) { where.push(`(${e.text.map((c) => `LOWER(${c}) LIKE LOWER(?) ESCAPE '\\'`).join(' OR ')})`); e.text.forEach(() => params.push(`%${esc(word)}%`)); }
  const used = [];
  for (const f of (q.filters || []).slice(0, 12)) {
    const fd = e.fields[f.field]; if (!fd || !OPS.includes(f.op)) { warnings.push(`Ignored a condition on “${f.field}”`); continue; }
    const c = condition(fd, f); if (!c) { warnings.push(`Ignored “${fd.label} ${f.op} ${f.value || (f.values || []).join(', ')}” (value not understood)`); continue; }
    where.push(c[0]); params.push(...c[1]); used.push({ field: fd.label, op: f.op, value: f.op === 'between' ? `${f.value} – ${f.value2}` : f.op === 'in' ? (f.values || []).join(', ') : f.value });
  }
  const sf = e.fields[q.sort_field]; const order = sf ? `${sf.col} ${q.sort_dir === 'asc' ? 'ASC' : 'DESC'}` : e.sort;
  const limit = Math.min(Math.max(Number(q.limit) || 25, 1), 100);
  const sql = `SELECT ${e.select} FROM ${e.from}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ${e.visible ? Math.min(limit * 4, 500) : limit + 1}`;
  let rows = all(sql, ...params);
  if (e.visible) rows = rows.filter((r) => e.visible(r, user));
  const more = rows.length > limit; rows = rows.slice(0, limit);
  return { entity: q.entity, label: e.label, text, filters: used, rows: rows.map(e.row), more, warnings };
}

// ---------------------------------------------------------------- the plan
const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['explanation', 'queries'],
  properties: {
    explanation: { type: 'string', description: 'One short sentence describing what is being searched, in plain words for the user.' },
    queries: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['entity', 'text', 'filters', 'sort_field', 'sort_dir', 'limit'],
      properties: {
        entity: { type: 'string', enum: SEARCH_ENTITIES },
        text: { type: 'string', description: 'Free-text keywords matched against names/descriptions; empty string when the filters already say everything.' },
        filters: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['field', 'op', 'value', 'value2', 'values'],
          properties: { field: { type: 'string' }, op: { type: 'string', enum: OPS }, value: { type: 'string' }, value2: { type: 'string' }, values: { type: 'array', items: { type: 'string' } } } } },
        sort_field: { type: 'string', description: 'A field of this entity, or empty for the default order.' },
        sort_dir: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'integer' },
      } } },
  },
};
function systemPrompt(cat, user) {
  const users = all('SELECT name FROM users WHERE active=1 ORDER BY name').map((u) => u.name);
  const describe = (ent) => Object.entries(cat[ent].fields).map(([k, f]) => `  - ${k}${f.custom ? ` ("${f.label}", custom)` : ''}: ${f.type}${f.values ? ` [${f.values.join(' | ')}]` : ''}`).join('\n');
  return `You turn a CRM user's search request into a query plan. You never see record data; you only choose which records to fetch.
Searchable record kinds and their fields:
${SEARCH_ENTITIES.filter((e) => hasPerm(user, cat[e].perm)).map((e) => `${e}:\n${describe(e)}`).join('\n')}

Deal amounts: "amount" is in ${cur().c1}${cur().c2 ? `; "amount_currency2" is the same amount converted to ${cur().c2}. Use amount_currency2 when the user states a ${cur().c2} value` : ''}.
Deal stages: ${STAGES.map((s) => `${s.key} = "${s.label}"`).join(', ')}. Open deals are those whose stage is not won or lost (use op "in" with the open stages).
Users (for owner / uploaded_by): ${users.join(', ')}. The person asking is ${user.name} — "my"/"mine" means owner = "${user.name}".
Rules:
- Use only the fields listed for that kind. Text ops: eq, neq, contains, starts_with, in, empty, not_empty. Number and date ops: eq, neq, gt, gte, lt, lte, between (value and value2), empty, not_empty. Enum: eq, neq, in (values), empty. bool: eq with "true"/"false". multi: contains.
- Dates are YYYY-MM-DD; resolve relative dates ("this quarter", "last 30 days", "since March") against today's date given in the request.
- Put names of companies, people or topics that you cannot map to a specific field into "text".
- Return one query per kind of record the user wants. If they ask for everything about something (e.g. "everything about Acme"), return several queries (deals, contacts, files, …) that each use "text" or the account field.
- "limit" is how many results to show (default 25, at most 100). For "top N" / "largest" requests set sort_field/sort_dir and limit.
- For files: "kind" is the file type (pdf, spreadsheet, …), "stage" is the deal-stage folder, "record_name" is the deal/account/contact the file is attached to.
- Set fields you do not need to "" (strings) or [] (arrays).`;
}

async function aiPlan(question, cat, user) {
  const today = new Date().toISOString().slice(0, 10);
  const data = await callClaude({
    max_tokens: 4000, system: systemPrompt(cat, user),
    output_config: { format: { type: 'json_schema', schema: PLAN_SCHEMA } },
    messages: [{ role: 'user', content: `Today is ${today}.\nSearch request: ${question}` }],
  });
  let plan; try { const t = responseText(data); plan = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)); } catch { throw bad('Claude returned a plan that could not be read. Try rephrasing.'); }
  if (!Array.isArray(plan.queries)) throw bad('Claude returned an incomplete plan. Try rephrasing.');
  return { ...plan, queries: plan.queries.slice(0, 6), model: data.model };
}
/** Without AI: the words are matched against every kind of record the user can see. */
const keywordPlan = (q) => ({ explanation: `Records containing “${q}”`, queries: SEARCH_ENTITIES.map((entity) => ({ entity, text: q, filters: [], limit: 10 })) });

export async function search(user, body) {
  const q = String(body.q || '').trim(); if (!q) throw bad('Type what you are looking for');
  if (q.length > 500) throw bad('Keep the search under 500 characters');
  const cat = catalogue(); let mode = body.mode === 'keyword' || !aiConfigured() ? 'keyword' : 'ai'; let plan, notice = null;
  if (mode === 'ai') {
    try { plan = await aiPlan(q, cat, user); }
    catch (e) { mode = 'keyword'; notice = `AI search was unavailable (${e.message}) — showing a keyword search instead.`; }
  } else if (!aiConfigured()) notice = 'AI is not configured, so this is a keyword search. An admin can add an Anthropic API key in Settings → AI assistant.';
  if (!plan) plan = keywordPlan(q);
  const groups = []; const warnings = [];
  for (const query of plan.queries) {
    const r = runQuery(cat, query, user); warnings.push(...(r.warnings || []));
    if (r.rows && (r.rows.length || mode === 'ai')) groups.push(r);
  }
  return { mode, q, explanation: plan.explanation, notice, warnings: [...new Set(warnings)], groups, model: plan.model || null };
}

POST('/api/search/ai', ({ user, body }) => search(user, body));
/** What can be searched (for the help panel). */
GET('/api/search/fields', ({ user }) => { const cat = catalogue(); return { ai: aiConfigured(), entities: SEARCH_ENTITIES.filter((e) => hasPerm(user, cat[e].perm)).map((e) => ({ entity: e, label: cat[e].label, fields: Object.entries(cat[e].fields).map(([k, f]) => ({ key: k, label: f.label, type: f.type })) })) }; });
