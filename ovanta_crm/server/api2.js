import { GET, POST, PUT, DELETE, HttpError, bad, notFound } from './http.js';
import { all, get, run, tx, audit } from './db.js';
import { encryptSecret } from './auth.js';
import { sentLast24h, getSender, forgetTransport, verifySender, sendLogged } from './mailer.js';
import { forgetImap, checkImap } from './imap.js';
import { EVENTS, parseEmails, testRule } from './notifications.js';
import { aiConfigured, aiModel, generateEmail } from './ai.js';
import { getTheme, saveTheme, setSecretSetting, setSetting, getSetting } from './settings.js';
import { config } from './config.js';
import { STAGES, dropFiles } from './entities.js';

const ADMIN = ['admin'], MGR = ['admin', 'manager'];
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const oneLine = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();

// ---------- Theme (public so the login page can be branded) ----------
GET('/api/theme', () => getTheme(), { public: true });
PUT('/api/theme', ({ body, user }) => { const t = saveTheme(body); audit(user, 'update', 'theme', null); return t; });

// ---------- Senders ----------
const pub = (s) => ({
  id: s.id, label: s.label, from_name: s.from_name, from_email: s.from_email, reply_to: s.reply_to, mode: s.mode, host: s.host, port: s.port,
  secure: !!s.secure, username: s.username, has_password: !!s.password_enc, daily_limit: s.daily_limit, delay_ms: s.delay_ms, active: !!s.active,
  is_default: !!s.is_default, last_verified_at: s.last_verified_at, last_error: s.last_error, sent_24h: sentLast24h(s.id),
  save_sent: !!s.save_sent, imap_host: s.imap_host, imap_port: s.imap_port, sent_folder: s.sent_folder, copy_error: s.copy_error,
});
const senderById = (id) => { const s = getSender(id); if (!s) throw notFound('Sender not found'); return s; };
function senderInput(b, existing) {
  const label = oneLine(b.label), from_email = oneLine(b.from_email).toLowerCase();
  if (!label) throw bad('Label is required');
  if (!EMAIL_RE.test(from_email)) throw bad('From email is not valid');
  const reply_to = oneLine(b.reply_to) || null;
  if (reply_to && !EMAIL_RE.test(reply_to)) throw bad('Reply-to email is not valid');
  const mode = b.mode === 'simulate' ? 'simulate' : 'smtp';
  const port = Number(b.port) || 587, daily = Number(b.daily_limit) || 500, delay = Number(b.delay_ms ?? 1000);
  if (mode === 'smtp') {
    if (!oneLine(b.host)) throw bad('SMTP host is required');
    if (port < 1 || port > 65535) throw bad('Port must be between 1 and 65535');
  }
  if (daily < 1 || daily > 1000000) throw bad('Daily limit must be at least 1');
  if (!(delay >= 0 && delay <= 60000)) throw bad('Delay must be 0–60000 ms');
  return {
    label: label.slice(0, 80), from_name: oneLine(b.from_name).replace(/"/g, '').slice(0, 100) || null, from_email, reply_to, mode,
    host: mode === 'smtp' ? oneLine(b.host) : null, port, secure: b.secure ? 1 : 0, username: oneLine(b.username) || null,
    daily_limit: daily, delay_ms: delay, active: b.active === false ? 0 : 1,
    password_enc: String(b.password || '').trim() ? encryptSecret(String(b.password).trim()) : existing?.password_enc ?? null,
    ...imapInput(b, mode),
  };
}
function imapInput(b, mode) {
  const save_sent = mode === 'smtp' && !!b.save_sent ? 1 : 0, imap_host = oneLine(b.imap_host).toLowerCase() || null, imap_port = Number(b.imap_port) || 993;
  if (save_sent && !imap_host) throw bad('Enter the IMAP server to save copies in the Sent folder (e.g. imap.secureserver.net)');
  if (imap_host && !/^[a-z0-9.-]+$/.test(imap_host)) throw bad('IMAP server is not a valid host name');
  if (imap_port < 1 || imap_port > 65535) throw bad('IMAP port must be between 1 and 65535');
  return { save_sent, imap_host, imap_port, sent_folder: oneLine(b.sent_folder).slice(0, 120) || null };
}
const setDefault = (id) => { run('UPDATE senders SET is_default=0'); run('UPDATE senders SET is_default=1 WHERE id=?', id); };

GET('/api/senders', () => all('SELECT * FROM senders ORDER BY is_default DESC, label').map(pub));
POST('/api/senders', ({ body, user }) => {
  const d = senderInput(body); const cols = Object.keys(d);
  const id = Number(run(`INSERT INTO senders (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...Object.values(d)).lastInsertRowid);
  const curDefault = get('SELECT mode FROM senders WHERE is_default=1 AND active=1 AND id<>?', id);
  // the first real mailbox replaces a simulation default, so notifications and task emails start going out without extra steps
  if (body.is_default || get('SELECT COUNT(*) n FROM senders').n === 1 || (d.mode === 'smtp' && (!curDefault || curDefault.mode !== 'smtp'))) setDefault(id);
  audit(user, 'create', 'senders', id, d.from_email);
  return pub(senderById(id));
});
PUT('/api/senders/:id', ({ params, body, user }) => {
  const s = senderById(params.id); const d = senderInput(body, s);
  run(`UPDATE senders SET ${Object.keys(d).map((k) => `${k}=?`).join(',')}, last_error=NULL, copy_error=NULL WHERE id=?`, ...Object.values(d), s.id);
  forgetTransport(s.id); forgetImap(s.id);
  if (body.is_default) setDefault(s.id);
  audit(user, 'update', 'senders', s.id, d.from_email);
  return pub(senderById(s.id));
});
DELETE('/api/senders/:id', ({ params, user }) => {
  const s = senderById(params.id);
  const inUse = get("SELECT COUNT(*) n FROM campaigns WHERE sender_id=? AND status IN ('scheduled','sending')", s.id).n;
  if (inUse) throw bad('This sender is used by a scheduled or sending campaign');
  forgetTransport(s.id); forgetImap(s.id); run('DELETE FROM senders WHERE id=?', s.id);
  audit(user, 'delete', 'senders', s.id, s.from_email);
  return { ok: true };
});
POST('/api/senders/:id/verify', async ({ params, user }) => {
  const s = senderById(params.id); const r = await verifySender(s);
  if (r.ok && s.mode === 'smtp' && s.save_sent) {
    try { const folder = await checkImap(s); r.note = `Sending works, and copies will be saved in the "${folder}" folder.`; r.sent_folder = folder; run('UPDATE senders SET copy_error=NULL WHERE id=?', s.id); }
    catch (e) { r.ok = false; r.error = `Sending works, but saving copies in Sent does not: ${e.message}`; }
  }
  run("UPDATE senders SET last_verified_at=CASE WHEN ? THEN datetime('now') ELSE last_verified_at END, last_error=? WHERE id=?", r.ok ? 1 : 0, r.ok ? null : r.error, s.id);
  audit(user, 'verify', 'senders', s.id, r.ok ? 'ok' : 'failed');
  return r;
});
POST('/api/senders/:id/test', async ({ params, body, user }) => {
  const s = senderById(params.id); const to = oneLine(body.to || user.email);
  if (!EMAIL_RE.test(to)) throw bad('Enter a valid recipient email');
  const r = await sendLogged({ sender: s, to, subject: 'Ovantaa CRM test email', kind: 'test', copyToSent: true,
    html: `<p>This is a test message from <b>Ovantaa CRM</b> sent through the sender <b>${s.label.replace(/</g, '&lt;')}</b> (${s.from_email}).</p><p>If you can read this, the sender is configured correctly.</p>`,
    text: `This is a test message from Ovantaa CRM sent through ${s.label} (${s.from_email}).` });
  if (r.status === 'failed') throw bad(r.error);
  return { ok: true, simulated: r.status === 'simulated', to, sent_copy: r.sent_copy, sent_folder: r.sent_folder, copy_error: r.copy_error };
});

// ---------- Email log ----------
GET('/api/email-log', ({ query }) => {
  const w = []; const p = [];
  if (query.kind) { w.push('l.kind=?'); p.push(query.kind); }
  if (query.status) { w.push('l.status=?'); p.push(query.status); }
  return all(`SELECT l.*, s.label AS sender_label FROM email_log l LEFT JOIN senders s ON s.id=l.sender_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY l.id DESC LIMIT 300`, ...p);
});

// ---------- Notification rules ----------
const ruleOut = (r) => ({ ...r, active: !!r.active, notify_owner: !!r.notify_owner, user_ids: JSON.parse(r.user_ids || '[]') });
const ruleById = (id) => { const r = get('SELECT * FROM notification_rules WHERE id=?', id); if (!r) throw notFound('Rule not found'); return r; };
function ruleInput(b) {
  const name = oneLine(b.name); if (!name) throw bad('Rule name is required');
  if (!EVENTS[b.event]) throw bad('Unknown event');
  const extra = String(b.extra_emails || '').split(/[,;\s]+/).filter(Boolean);
  for (const e of extra) if (!EMAIL_RE.test(e)) throw bad(`"${e}" is not a valid email address`);
  const ids = (Array.isArray(b.user_ids) ? b.user_ids : []).map(Number).filter(Boolean);
  if (!ids.length && !extra.length && !b.notify_owner) throw bad('Choose at least one recipient (users, record owner, or extra emails)');
  const stages = String(b.only_stage || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const s of stages) if (!STAGES.some((x) => x.key === s)) throw bad(`Unknown stage "${s}"`);
  const min = b.min_amount === '' || b.min_amount == null ? null : Number(b.min_amount);
  if (min !== null && !(min >= 0)) throw bad('Minimum amount must be a positive number');
  const sender_id = b.sender_id ? Number(b.sender_id) : null;
  if (sender_id && !getSender(sender_id)) throw bad('Sender not found');
  return { name: name.slice(0, 120), event: b.event, active: b.active === false ? 0 : 1, notify_owner: b.notify_owner ? 1 : 0, user_ids: JSON.stringify(ids),
    extra_emails: parseEmails(extra.join(',')).join(', ') || null, sender_id, min_amount: min, only_stage: stages.join(',') || null,
    subject_template: oneLine(b.subject_template).slice(0, 200) || null, intro: String(b.intro || '').trim().slice(0, 500) || null };
}
GET('/api/notifications/events', () => EVENTS);
GET('/api/notifications/rules', () => all('SELECT * FROM notification_rules ORDER BY id DESC').map(ruleOut));
POST('/api/notifications/rules', ({ body, user }) => {
  const d = ruleInput(body); const cols = [...Object.keys(d), 'created_by'];
  const id = Number(run(`INSERT INTO notification_rules (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...Object.values(d), user.id).lastInsertRowid);
  audit(user, 'create', 'notification_rules', id, d.name);
  return ruleOut(ruleById(id));
});
PUT('/api/notifications/rules/:id', ({ params, body, user }) => {
  ruleById(params.id); const d = ruleInput(body);
  run(`UPDATE notification_rules SET ${Object.keys(d).map((k) => `${k}=?`).join(',')} WHERE id=?`, ...Object.values(d), params.id);
  audit(user, 'update', 'notification_rules', params.id, d.name);
  return ruleOut(ruleById(params.id));
});
DELETE('/api/notifications/rules/:id', ({ params, user }) => { const r = ruleById(params.id); run('DELETE FROM notification_rules WHERE id=?', r.id); audit(user, 'delete', 'notification_rules', r.id, r.name); return { ok: true }; });
POST('/api/notifications/rules/:id/test', async ({ params, user }) => {
  const r = await testRule(ruleById(params.id), user);
  if (r.status === 'failed') throw bad(r.error);
  return { ok: true, simulated: r.status === 'simulated', to: user.email };
});

// ---------- AI (Claude) ----------
const aiHits = new Map();
GET('/api/ai/status', () => ({ configured: aiConfigured(), model: aiModel(), from_env: !!config.anthropicApiKey }));
POST('/api/ai/campaign', async ({ body, user }) => {
  const now = Date.now(); const hits = (aiHits.get(user.id) || []).filter((t) => now - t < 3600000);
  if (hits.length >= 30) throw new HttpError(429, 'AI generation limit reached (30 per hour). Try again later.');
  const task = body.task === 'rewrite' ? 'rewrite' : 'draft';
  const brief = String(body.brief || '').trim();
  if (task === 'draft' && brief.length < 10) throw bad('Describe the campaign in at least a sentence');
  if (task === 'rewrite' && !String(body.current_html || '').trim()) throw bad('There is no existing content to rewrite');
  const cta = String(body.cta_url || '').trim();
  if (cta && !/^https?:\/\/\S+$/i.test(cta)) throw bad('Call-to-action link must start with http:// or https://');
  hits.push(now); aiHits.set(user.id, hits);
  const out = await generateEmail({ ...Object.fromEntries(['audience', 'tone', 'length', 'instruction', 'current_subject', 'current_html'].map((k) => [k, String(body[k] || '').slice(0, 8000)])),
    task, brief: brief.slice(0, 2000), cta_url: cta, sender_name: user.name });
  audit(user, 'ai_generate', 'campaigns', null, task);
  return out;
});
PUT('/api/settings/ai', ({ body, user }) => {
  if (body.clear_key) setSecretSetting('anthropic_api_key', null);
  else if (body.api_key) { if (!/^sk-ant-/.test(String(body.api_key).trim())) throw bad('That does not look like an Anthropic API key (should start with sk-ant-)'); setSecretSetting('anthropic_api_key', String(body.api_key).trim()); }
  if (body.model !== undefined) setSetting('anthropic_model', oneLine(body.model).slice(0, 80) || null);
  audit(user, 'update', 'settings', null, 'ai');
  return { configured: aiConfigured(), model: aiModel() };
});

// ---------- Data management: delete all (admin only, typed confirmation) ----------
export const PURGEABLE = {
  contacts: { table: 'contacts', label: 'contacts', effects: 'Also removes their tasks and activity notes. Deals and campaign history are kept but lose the contact link.' },
  accounts: { table: 'accounts', label: 'accounts', effects: 'Also removes activity notes logged on accounts. Contacts and deals are kept but lose their company link.' },
  deals: { table: 'deals', label: 'deals', effects: 'Also removes the stage history, tasks and activity notes attached to those deals.' },
  tasks: { table: 'tasks', label: 'tasks', effects: '' },
  activities: { table: 'activities', label: 'activity notes (calls, notes, meetings)', effects: '' },
  campaigns: { table: 'campaigns', label: 'campaigns', effects: 'Also removes all their recipients and open/click tracking history. Not allowed while a campaign is sending.',
    guard: () => { if (get("SELECT COUNT(*) n FROM campaigns WHERE status='sending'").n) throw bad('A campaign is sending right now. Wait for it to finish first.'); } },
  segments: { table: 'segments', label: 'segments', effects: 'Draft campaigns that used them will need a new audience. Not allowed while a scheduled or sending campaign uses a segment.',
    guard: () => { if (get("SELECT COUNT(*) n FROM campaigns WHERE status IN ('scheduled','sending') AND segment_id IS NOT NULL").n) throw bad('A scheduled or sending campaign is using a segment. Unschedule or wait for it first.'); } },
  templates: { table: 'templates', label: 'email templates', effects: '' },
  email_log: { table: 'email_log', label: 'notification & test email log entries', effects: 'Campaign delivery history is stored with each campaign and is not affected.' },
  notification_rules: { table: 'notification_rules', label: 'notification rules', effects: 'Nobody will be emailed about changes until you create new rules.' },
};
GET('/api/admin/data-counts', () => Object.fromEntries(Object.entries(PURGEABLE).map(([k, v]) => [k, { label: v.label, effects: v.effects, count: get(`SELECT COUNT(*) n FROM ${v.table}`).n }])));
POST('/api/admin/purge', ({ body, user }) => {
  const def = PURGEABLE[body.entity];
  if (!def) throw bad('Unknown data type');
  if (body.confirm !== 'DELETE') throw bad('Type DELETE (in capitals) to confirm');
  def.guard?.();
  const before = get(`SELECT COUNT(*) n FROM ${def.table}`).n;
  tx(() => { run(`DELETE FROM ${def.table}`); });
  if (['contacts', 'accounts', 'deals'].includes(def.table)) for (const f of all('SELECT DISTINCT record_id FROM files WHERE entity=?', def.table)) dropFiles(def.table, f.record_id);
  audit(user, 'delete_all', def.table, null, `${before} records`);
  return { ok: true, deleted: before, entity: body.entity };
});
