import { GET, POST, PUT, DELETE, HttpError, bad, notFound, forbidden } from './http.js';
import { all, get, run, tx, audit } from './db.js';
import { config } from './config.js';
import {
  hashPassword, verifyPassword, makeSession, sessionCookie, throttled, recordFail, clearFails,
} from './auth.js';
import { ENTITIES, STAGES, list, getOne, create, update, remove, clean } from './entities.js';
import { SEGMENT_FIELDS, SEGMENT_OPS, parseFilter, resolveSegment } from './segments.js';
import {
  MERGE_TAGS, renderMessage, sendTest, launchCampaign, validateForLaunch, campaignStats, outboxLog,
} from './campaigns.js';

const MGR = ['admin', 'manager'];

// ---------- Auth ----------
POST('/api/auth/login', ({ body, req, send }) => {
  const email = String(body.email || '').trim().toLowerCase();
  const key = `${req.socket.remoteAddress}|${email}`;
  if (throttled(key)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  const u = get('SELECT * FROM users WHERE email=? AND active=1', email);
  if (!u || !verifyPassword(String(body.password || ''), u.password_hash)) { recordFail(key); throw Object.assign(bad('Invalid email or password'), { status: 401 }); }
  clearFails(key);
  audit(u, 'login', 'users', u.id);
  send(200, { user: { id: u.id, name: u.name, email: u.email, role: u.role } }, { 'Set-Cookie': sessionCookie(makeSession(u.id)) });
}, { public: true });
POST('/api/auth/logout', ({ send }) => send(200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) }), { public: true });
GET('/api/auth/me', ({ user }) => ({ user }), { public: false });
POST('/api/auth/password', ({ user, body }) => {
  const u = get('SELECT * FROM users WHERE id=?', user.id);
  if (!verifyPassword(String(body.current || ''), u.password_hash)) throw bad('Current password is incorrect');
  checkPassword(body.next);
  run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(body.next), user.id);
  audit(user, 'password_change', 'users', user.id);
  return { ok: true };
});
function checkPassword(p) {
  if (typeof p !== 'string' || p.length < 8) throw bad('Password must be at least 8 characters');
  if (!/[a-zA-Z]/.test(p) || !/\d/.test(p)) throw bad('Password must contain letters and numbers');
}

// ---------- Meta ----------
GET('/api/meta', () => ({
  stages: STAGES, mergeTags: MERGE_TAGS, segmentFields: Object.fromEntries(Object.entries(SEGMENT_FIELDS).map(([k, v]) => [k, { label: v.label, type: v.type, options: v.options }])),
  segmentOps: SEGMENT_OPS, users: all('SELECT id,name,role FROM users WHERE active=1 ORDER BY name'),
  industries: all("SELECT DISTINCT industry v FROM accounts WHERE industry IS NOT NULL ORDER BY 1").map((r) => r.v),
  sources: all("SELECT DISTINCT source v FROM contacts WHERE source IS NOT NULL ORDER BY 1").map((r) => r.v),
  mailTransport: config.mailTransport, baseUrl: config.baseUrl, defaults: { fromName: config.defaultFromName, fromEmail: config.defaultFromEmail },
}));
GET('/api/lookup', ({ query }) => {
  const q = `%${String(query.q || '').replace(/[\\%_]/g, (m) => '\\' + m)}%`;
  const type = query.type;
  if (type === 'accounts') return all("SELECT id, name AS label FROM accounts WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 20", q);
  if (type === 'contacts') return all("SELECT id, TRIM(first_name||' '||COALESCE(last_name,'')) AS label FROM contacts WHERE first_name||' '||COALESCE(last_name,'') LIKE ? ESCAPE '\\' ORDER BY first_name LIMIT 20", q);
  if (type === 'deals') return all("SELECT id, name AS label FROM deals WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 20", q);
  throw bad('Unknown lookup type');
});

// ---------- Generic CRUD for core entities ----------
for (const [name, ent] of Object.entries(ENTITIES)) {
  GET(`/api/${name}`, ({ query }) => list(ent, query));
  GET(`/api/${name}/:id`, ({ params }) => getOne(ent, params.id));
  POST(`/api/${name}`, ({ body, user }) => create(ent, body, user));
  PUT(`/api/${name}/:id`, ({ params, body, user }) => update(ent, params.id, body, user));
  DELETE(`/api/${name}/:id`, ({ params, user }) => remove(ent, params.id, user));
}

// Contact 360 / Account 360
GET('/api/contacts/:id/360', ({ params }) => {
  const contact = getOne(ENTITIES.contacts, params.id);
  return {
    contact,
    activities: all('SELECT a.*, u.name AS user_name FROM activities a LEFT JOIN users u ON u.id=a.user_id WHERE a.contact_id=? ORDER BY a.created_at DESC, a.id DESC', params.id),
    deals: all('SELECT * FROM deals WHERE contact_id=? ORDER BY created_at DESC', params.id),
    tasks: all('SELECT * FROM tasks WHERE contact_id=? ORDER BY done, due_date', params.id),
    campaigns: all(`SELECT c.id, c.name, r.status, r.sent_at, r.first_open_at, r.first_click_at, r.unsubscribed_at
      FROM campaign_recipients r JOIN campaigns c ON c.id=r.campaign_id WHERE r.contact_id=? ORDER BY r.id DESC`, params.id),
  };
});
GET('/api/accounts/:id/360', ({ params }) => {
  const account = getOne(ENTITIES.accounts, params.id);
  return {
    account,
    contacts: all('SELECT id, first_name, last_name, email, title, status FROM contacts WHERE account_id=? ORDER BY first_name', params.id),
    deals: all('SELECT id, name, amount, stage, close_date FROM deals WHERE account_id=? ORDER BY created_at DESC', params.id),
    activities: all('SELECT a.*, u.name AS user_name FROM activities a LEFT JOIN users u ON u.id=a.user_id WHERE a.account_id=? ORDER BY a.created_at DESC LIMIT 50', params.id),
  };
});
GET('/api/deals/:id/360', ({ params }) => ({
  deal: getOne(ENTITIES.deals, params.id),
  activities: all('SELECT a.*, u.name AS user_name FROM activities a LEFT JOIN users u ON u.id=a.user_id WHERE a.deal_id=? ORDER BY a.created_at DESC, a.id DESC', params.id),
  tasks: all('SELECT * FROM tasks WHERE deal_id=? ORDER BY done, due_date', params.id),
}));

POST('/api/tasks/:id/toggle', ({ params, user }) => {
  getOne(ENTITIES.tasks, params.id);
  run('UPDATE tasks SET done = 1 - done WHERE id=?', params.id);
  audit(user, 'toggle', 'tasks', params.id);
  return getOne(ENTITIES.tasks, params.id);
});
POST('/api/deals/:id/stage', ({ params, body, user }) => update(ENTITIES.deals, params.id, { stage: body.stage }, user));

// Activities
POST('/api/activities', ({ body, user }) => {
  const type = ['note', 'call', 'email', 'meeting'].includes(body.type) ? body.type : null;
  const text = String(body.body || '').trim();
  if (!type) throw bad('Invalid activity type');
  if (!text) throw bad('Activity text is required');
  const ids = ['contact_id', 'deal_id', 'account_id'].map((k) => (body[k] ? Number(body[k]) : null));
  if (!ids.some(Boolean)) throw bad('Activity must be linked to a contact, deal or account');
  const r = run('INSERT INTO activities (type,body,contact_id,deal_id,account_id,user_id) VALUES (?,?,?,?,?,?)', type, text.slice(0, 5000), ...ids, user.id);
  return get('SELECT a.*, u.name AS user_name FROM activities a LEFT JOIN users u ON u.id=a.user_id WHERE a.id=?', Number(r.lastInsertRowid));
});
DELETE('/api/activities/:id', ({ params, user }) => {
  const a = get('SELECT * FROM activities WHERE id=?', params.id);
  if (!a) throw notFound();
  if (a.user_id !== user.id && user.role === 'rep') throw forbidden();
  run('DELETE FROM activities WHERE id=?', params.id);
  return { ok: true };
});

// ---------- Contacts: import / export / bulk ----------
POST('/api/contacts/import', ({ body, user }) => {
  const rows = Array.isArray(body.rows) ? body.rows : null;
  if (!rows) throw bad('rows array required');
  if (rows.length > 5000) throw bad('Import is limited to 5,000 rows at a time');
  const res = { created: 0, updated: 0, skipped: 0, errors: [] };
  tx(() => {
    rows.forEach((row, i) => {
      try {
        const account = row.company ? findOrCreateAccount(String(row.company).trim(), user) : null;
        const data = clean(ENTITIES.contacts, {
          first_name: row.first_name, last_name: row.last_name, email: row.email, phone: row.phone, title: row.title,
          status: row.status ? String(row.status).toLowerCase() : undefined, source: row.source, tags: row.tags,
          ...(account ? { account_id: account } : {}),
        }, { partial: true });
        if (!data.first_name && !data.email) { res.skipped++; return; }
        if (!data.first_name) data.first_name = data.email.split('@')[0];
        const existing = data.email ? get('SELECT id FROM contacts WHERE email=?', data.email) : null;
        if (existing) {
          const cols = Object.keys(data).filter((k) => data[k] !== null);
          run(`UPDATE contacts SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`, ...cols.map((c) => data[c]), existing.id);
          res.updated++;
        } else {
          data.owner_id = user.id;
          const cols = Object.keys(data);
          run(`INSERT INTO contacts (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...Object.values(data));
          res.created++;
        }
      } catch (e) { res.skipped++; if (res.errors.length < 20) res.errors.push(`Row ${i + 2}: ${e.message}`); }
    });
  });
  audit(user, 'import', 'contacts', null, `${res.created} created, ${res.updated} updated`);
  return res;
});
function findOrCreateAccount(name, user) {
  const a = get('SELECT id FROM accounts WHERE name=? COLLATE NOCASE', name);
  if (a) return a.id;
  return Number(run('INSERT INTO accounts (name, owner_id) VALUES (?,?)', name, user.id).lastInsertRowid);
}
const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
GET('/api/contacts/export.csv', ({ res, query, user }) => {
  const rows = list({ ...ENTITIES.contacts }, { ...query, limit: 1000, page: 1 }).rows;
  audit(user, 'export', 'contacts', null, `${rows.length} rows`);
  const head = ['first_name', 'last_name', 'email', 'phone', 'title', 'company', 'status', 'source', 'tags', 'subscribed', 'owner', 'created_at'];
  const lines = [head.join(',')].concat(rows.map((r) => [r.first_name, r.last_name, r.email, r.phone, r.title, r.account_name, r.status, r.source, r.tags, r.subscribed ? 'yes' : 'no', r.owner_name, r.created_at].map(csvCell).join(',')));
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="ovantaa-contacts.csv"' });
  res.end(lines.join('\r\n'));
});
POST('/api/contacts/bulk', ({ body, user }) => {
  const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Boolean).slice(0, 1000);
  if (!ids.length) throw bad('No contacts selected');
  const ph = ids.map(() => '?').join(',');
  if (body.action === 'status') { const d = clean(ENTITIES.contacts, { status: body.value }, { partial: true }); run(`UPDATE contacts SET status=? WHERE id IN (${ph})`, d.status, ...ids); }
  else if (body.action === 'owner') run(`UPDATE contacts SET owner_id=? WHERE id IN (${ph})`, Number(body.value) || null, ...ids);
  else if (body.action === 'tag') {
    const tag = String(body.value || '').trim().replace(/[,]/g, '');
    if (!tag) throw bad('Tag required');
    for (const c of all(`SELECT id,tags FROM contacts WHERE id IN (${ph})`, ...ids)) {
      const t = new Set((c.tags || '').split(',').map((x) => x.trim()).filter(Boolean)); t.add(tag);
      run('UPDATE contacts SET tags=? WHERE id=?', [...t].join(', '), c.id);
    }
  } else if (body.action === 'delete') { if (user.role === 'rep') throw forbidden(); run(`DELETE FROM contacts WHERE id IN (${ph})`, ...ids); }
  else throw bad('Unknown bulk action');
  audit(user, `bulk_${body.action}`, 'contacts', null, `${ids.length} contacts`);
  return { ok: true, count: ids.length };
});

// ---------- Segments ----------
const segRow = (s) => ({ ...s, filter: JSON.parse(s.filter) });
GET('/api/segments', () => all('SELECT * FROM segments ORDER BY name').map((s) => ({ ...segRow(s), size: resolveSegment(s.filter).length, total_matching: resolveSegment(s.filter, { onlyEmailable: false }).length })));
POST('/api/segments/preview', ({ body }) => {
  const emailable = resolveSegment(body.filter);
  const all_ = resolveSegment(body.filter, { onlyEmailable: false });
  return { emailable: emailable.length, matching: all_.length, sample: emailable.slice(0, 8) };
});
function segmentInput(body) {
  const name = String(body.name || '').trim();
  if (!name) throw bad('Segment name is required');
  return { name: name.slice(0, 120), description: String(body.description || '').slice(0, 500) || null, filter: JSON.stringify(parseFilter(body.filter)) };
}
POST('/api/segments', ({ body, user }) => {
  const d = segmentInput(body);
  const id = Number(run('INSERT INTO segments (name,description,filter,created_by) VALUES (?,?,?,?)', d.name, d.description, d.filter, user.id).lastInsertRowid);
  return segRow(get('SELECT * FROM segments WHERE id=?', id));
});
PUT('/api/segments/:id', ({ params, body }) => {
  if (!get('SELECT id FROM segments WHERE id=?', params.id)) throw notFound();
  const d = segmentInput(body);
  run('UPDATE segments SET name=?, description=?, filter=? WHERE id=?', d.name, d.description, d.filter, params.id);
  return segRow(get('SELECT * FROM segments WHERE id=?', params.id));
});
DELETE('/api/segments/:id', ({ params }) => {
  const inUse = get("SELECT COUNT(*) n FROM campaigns WHERE segment_id=? AND status IN ('scheduled','sending')", params.id).n;
  if (inUse) throw bad('Segment is used by a scheduled or sending campaign');
  run('DELETE FROM segments WHERE id=?', params.id);
  return { ok: true };
}, { roles: MGR });

// ---------- Templates ----------
GET('/api/templates', () => all('SELECT * FROM templates ORDER BY name'));
function templateInput(b) {
  const name = String(b.name || '').trim(), subject = String(b.subject || '').trim(), body_html = String(b.body_html || '').trim();
  if (!name || !subject || !body_html) throw bad('Name, subject and content are required');
  return { name: name.slice(0, 120), subject: subject.slice(0, 250), body_html };
}
POST('/api/templates', ({ body, user }) => {
  const d = templateInput(body);
  const id = Number(run('INSERT INTO templates (name,subject,body_html,created_by) VALUES (?,?,?,?)', d.name, d.subject, d.body_html, user.id).lastInsertRowid);
  return get('SELECT * FROM templates WHERE id=?', id);
});
PUT('/api/templates/:id', ({ params, body }) => {
  if (!get('SELECT id FROM templates WHERE id=?', params.id)) throw notFound();
  const d = templateInput(body);
  run('UPDATE templates SET name=?, subject=?, body_html=? WHERE id=?', d.name, d.subject, d.body_html, params.id);
  return get('SELECT * FROM templates WHERE id=?', params.id);
});
DELETE('/api/templates/:id', ({ params }) => { run('DELETE FROM templates WHERE id=?', params.id); return { ok: true }; }, { roles: MGR });

// ---------- Campaigns ----------
const CAMPAIGN_LIST = `SELECT c.*, s.name AS segment_name, u.name AS created_by_name,
  (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id=c.id) AS recipients,
  (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id=c.id AND r.status='sent') AS sent,
  (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id=c.id AND r.first_open_at IS NOT NULL) AS opened,
  (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id=c.id AND r.first_click_at IS NOT NULL) AS clicked
  FROM campaigns c LEFT JOIN segments s ON s.id=c.segment_id LEFT JOIN users u ON u.id=c.created_by`;
const campaignById = (id) => { const c = get(`${CAMPAIGN_LIST} WHERE c.id=?`, id); if (!c) throw notFound('Campaign not found'); return c; };

function campaignInput(b, existing) {
  const out = {};
  const str = (k, max) => { if (k in b) out[k] = String(b[k] ?? '').trim().slice(0, max) || null; };
  str('name', 150); str('subject', 250); str('from_name', 100); str('from_email', 200);
  if ('body_html' in b) out.body_html = String(b.body_html ?? '');
  if ('segment_id' in b) {
    out.segment_id = b.segment_id ? Number(b.segment_id) : null;
    if (out.segment_id && !get('SELECT id FROM segments WHERE id=?', out.segment_id)) throw bad('Segment not found');
  }
  if (!existing && !out.name) throw bad('Campaign name is required');
  if ('name' in out && !out.name) throw bad('Campaign name is required');
  if (out.from_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.from_email)) throw bad('From email is not valid');
  return out;
}
GET('/api/campaigns', () => all(`${CAMPAIGN_LIST} ORDER BY c.created_at DESC, c.id DESC`));
GET('/api/campaigns/outbox', () => outboxLog.slice(0, 100), { roles: MGR });
GET('/api/campaigns/:id', ({ params }) => {
  const c = campaignById(params.id);
  return { ...c, stats: campaignStats(c.id) };
});
POST('/api/campaigns', ({ body, user }) => {
  const d = campaignInput(body);
  d.subject ??= ''; d.body_html ??= '<p>Hi {{first_name|there}},</p>\n<p></p>';
  d.created_by = user.id;
  const cols = Object.keys(d);
  const id = Number(run(`INSERT INTO campaigns (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...Object.values(d)).lastInsertRowid);
  audit(user, 'create', 'campaigns', id, d.name);
  return campaignById(id);
});
PUT('/api/campaigns/:id', ({ params, body, user }) => {
  const c = campaignById(params.id);
  if (!['draft', 'scheduled'].includes(c.status)) throw bad(`A ${c.status} campaign can no longer be edited`);
  const d = campaignInput(body, c);
  const cols = Object.keys(d);
  if (cols.length) run(`UPDATE campaigns SET ${cols.map((k) => `${k}=?`).join(',')} WHERE id=?`, ...Object.values(d), c.id);
  audit(user, 'update', 'campaigns', c.id, c.name);
  return campaignById(c.id);
});
DELETE('/api/campaigns/:id', ({ params, user }) => {
  const c = campaignById(params.id);
  if (c.status === 'sending') throw bad('Cannot delete a campaign while it is sending');
  run('DELETE FROM campaigns WHERE id=?', c.id);
  audit(user, 'delete', 'campaigns', c.id, c.name);
  return { ok: true };
}, { roles: MGR });
POST('/api/campaigns/:id/duplicate', ({ params, user }) => {
  const c = campaignById(params.id);
  const id = Number(run('INSERT INTO campaigns (name,subject,body_html,from_name,from_email,segment_id,created_by) VALUES (?,?,?,?,?,?,?)', `${c.name} (copy)`, c.subject, c.body_html, c.from_name, c.from_email, c.segment_id, user.id).lastInsertRowid);
  return campaignById(id);
});
POST('/api/campaigns/preview', ({ body }) => {
  const sample = { first_name: 'Alex', last_name: 'Morgan', email: 'alex@example.com', title: 'VP Operations', account_name: 'Northwind Traders' };
  return renderMessage({ subject: String(body.subject || ''), body_html: String(body.body_html || '') }, sample, null);
});
POST('/api/campaigns/:id/test', async ({ params, body, user }) => {
  const c = campaignById(params.id);
  const to = String(body.to || user.email).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw bad('Enter a valid test email address');
  try { await sendTest(c, to, { first_name: user.name.split(' ')[0], last_name: user.name.split(' ').slice(1).join(' '), email: to, title: 'Test', account_name: 'Test Company' }); }
  catch (e) { throw bad(`Test send failed: ${e.message}`); }
  return { ok: true, to };
}, { roles: MGR });
POST('/api/campaigns/:id/launch', ({ params, user }) => {
  const c = campaignById(params.id);
  const r = launchCampaign(c.id);
  audit(user, 'launch', 'campaigns', c.id, `${r.recipients} recipients`);
  return { ok: true, ...r, campaign: campaignById(c.id) };
}, { roles: MGR });
POST('/api/campaigns/:id/schedule', ({ params, body, user }) => {
  const c = campaignById(params.id);
  if (!['draft', 'scheduled'].includes(c.status)) throw bad(`Campaign is already ${c.status}`);
  validateForLaunch(c);
  const when = new Date(body.at);
  if (Number.isNaN(when.getTime())) throw bad('Invalid schedule date');
  if (when.getTime() < Date.now() + 30000) throw bad('Schedule time must be in the future');
  run("UPDATE campaigns SET status='scheduled', scheduled_at=? WHERE id=?", when.toISOString().replace('T', ' ').slice(0, 19), c.id);
  audit(user, 'schedule', 'campaigns', c.id, when.toISOString());
  return campaignById(c.id);
}, { roles: MGR });
POST('/api/campaigns/:id/unschedule', ({ params }) => {
  const c = campaignById(params.id);
  if (c.status !== 'scheduled') throw bad('Campaign is not scheduled');
  run("UPDATE campaigns SET status='draft', scheduled_at=NULL WHERE id=?", c.id);
  return campaignById(c.id);
}, { roles: MGR });
GET('/api/campaigns/:id/recipients', ({ params, query }) => {
  campaignById(params.id);
  const f = { opened: 'AND r.first_open_at IS NOT NULL', clicked: 'AND r.first_click_at IS NOT NULL', unsubscribed: 'AND r.unsubscribed_at IS NOT NULL', failed: "AND r.status='failed'" }[query.filter] || '';
  return all(`SELECT r.id, r.email, r.status, r.error, r.sent_at, r.first_open_at, r.first_click_at, r.unsubscribed_at, r.open_count, r.click_count, r.contact_id,
    TRIM(COALESCE(c.first_name,'')||' '||COALESCE(c.last_name,'')) AS name FROM campaign_recipients r LEFT JOIN contacts c ON c.id=r.contact_id
    WHERE r.campaign_id=? ${f} ORDER BY r.id LIMIT 500`, params.id);
});

// ---------- Users (admin) ----------
GET('/api/users', () => all('SELECT id,name,email,role,active,created_at FROM users ORDER BY name'), { roles: ['admin'] });
POST('/api/users', ({ body, user }) => {
  const name = String(body.name || '').trim(), email = String(body.email || '').trim().toLowerCase();
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Name and a valid email are required');
  if (!['admin', 'manager', 'rep'].includes(body.role)) throw bad('Invalid role');
  checkPassword(body.password);
  const id = Number(run('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)', name, email, hashPassword(body.password), body.role).lastInsertRowid);
  audit(user, 'create', 'users', id, email);
  return get('SELECT id,name,email,role,active,created_at FROM users WHERE id=?', id);
}, { roles: ['admin'] });
PUT('/api/users/:id', ({ params, body, user }) => {
  const u = get('SELECT * FROM users WHERE id=?', params.id);
  if (!u) throw notFound();
  const role = body.role ?? u.role, active = body.active === undefined ? u.active : body.active ? 1 : 0;
  if (!['admin', 'manager', 'rep'].includes(role)) throw bad('Invalid role');
  if (u.id === user.id && (role !== 'admin' || !active)) throw bad('You cannot demote or deactivate yourself');
  run('UPDATE users SET name=?, role=?, active=? WHERE id=?', String(body.name ?? u.name).trim() || u.name, role, active, u.id);
  if (body.password) { checkPassword(body.password); run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(body.password), u.id); }
  audit(user, 'update', 'users', u.id, u.email);
  return get('SELECT id,name,email,role,active,created_at FROM users WHERE id=?', u.id);
}, { roles: ['admin'] });
GET('/api/audit', () => all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200'), { roles: ['admin'] });

// ---------- Dashboard & reports ----------
GET('/api/dashboard', ({ user, query }) => {
  const mine = query.scope === 'mine';
  const o = mine ? ` AND owner_id=${Number(user.id)}` : '';
  const month = (col) => `strftime('%Y-%m', ${col})`;
  const pipeline = STAGES.map((s) => ({ ...s, ...get(`SELECT COUNT(*) AS count, COALESCE(SUM(amount),0) AS amount FROM deals WHERE stage=?${o}`, s.key) }));
  const open = pipeline.filter((s) => !['won', 'lost'].includes(s.key));
  const forecast = get(`SELECT COALESCE(SUM(amount*probability/100.0),0) AS v FROM deals WHERE stage NOT IN ('won','lost')${o}`).v;
  const won = get(`SELECT COUNT(*) AS n FROM deals WHERE stage='won'${o}`).n, lost = get(`SELECT COUNT(*) AS n FROM deals WHERE stage='lost'${o}`).n;
  const months = [];
  for (let i = 5; i >= 0; i--) { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i); months.push(d.toISOString().slice(0, 7)); }
  const revRows = all(`SELECT ${month('COALESCE(closed_at, close_date, created_at)')} AS m, SUM(amount) AS v FROM deals WHERE stage='won'${o} GROUP BY m`);
  const newRows = all(`SELECT ${month('created_at')} AS m, COUNT(*) AS n FROM contacts WHERE 1=1${o} GROUP BY m`);
  return {
    kpis: {
      contacts: get(`SELECT COUNT(*) n FROM contacts WHERE 1=1${o}`).n,
      accounts: get(`SELECT COUNT(*) n FROM accounts WHERE 1=1${o}`).n,
      openDeals: open.reduce((a, s) => a + s.count, 0), pipelineValue: open.reduce((a, s) => a + s.amount, 0), forecast,
      wonValue: pipeline.find((s) => s.key === 'won').amount, winRate: won + lost ? won / (won + lost) : 0,
      openTasks: get(`SELECT COUNT(*) n FROM tasks WHERE done=0${o}`).n,
      overdueTasks: get(`SELECT COUNT(*) n FROM tasks WHERE done=0 AND due_date < date('now')${o}`).n,
    },
    pipeline,
    revenueByMonth: months.map((m) => ({ month: m, value: revRows.find((r) => r.m === m)?.v || 0, contacts: newRows.find((r) => r.m === m)?.n || 0 })),
    leadSources: all(`SELECT COALESCE(source,'Unknown') AS source, COUNT(*) AS count FROM contacts WHERE 1=1${o} GROUP BY 1 ORDER BY 2 DESC LIMIT 8`),
    contactsByStatus: all(`SELECT status, COUNT(*) AS count FROM contacts WHERE 1=1${o} GROUP BY status`),
    topDeals: all(`SELECT d.id, d.name, d.amount, d.stage, ac.name AS account_name FROM deals d LEFT JOIN accounts ac ON ac.id=d.account_id WHERE d.stage NOT IN ('won','lost')${o.replace('owner_id', 'd.owner_id')} ORDER BY d.amount DESC LIMIT 5`),
    tasksDue: all(`SELECT t.id, t.title, t.due_date, t.priority FROM tasks t WHERE t.done=0${o.replace('owner_id', 't.owner_id')} ORDER BY t.due_date IS NULL, t.due_date LIMIT 6`),
    recentActivity: all('SELECT a.id, a.type, a.body, a.created_at, a.contact_id, a.deal_id, a.account_id, u.name AS user_name FROM activities a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC, a.id DESC LIMIT 8'),
    campaigns: all(`${CAMPAIGN_LIST} WHERE c.status IN ('sent','sending') ORDER BY COALESCE(c.sent_at,c.created_at) DESC LIMIT 4`),
    leaderboard: all("SELECT u.name, COUNT(d.id) AS deals, COALESCE(SUM(d.amount),0) AS value FROM users u JOIN deals d ON d.owner_id=u.id AND d.stage='won' GROUP BY u.id ORDER BY value DESC LIMIT 5"),
  };
});
