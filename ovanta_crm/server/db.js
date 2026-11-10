import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { backupDatabase, pruneBackups } from './backup-core.js';
import { runMigrations, currentVersion, LATEST_VERSION } from './migrations.js';

if (config.dbPath !== ':memory:') fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

// Safety net: before ANY schema change on an existing database, take a restore point (data/backups/*-premigration-*.db).
export let preMigrationBackup = null;
if (config.dbPath !== ':memory:' && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get()) {
  const from = currentVersion(db);
  if (from < LATEST_VERSION) {
    try { preMigrationBackup = backupDatabase(db, config.backupDir, `premigration-v${from}-to-v${LATEST_VERSION}`); pruneBackups(config.backupDir, 'premigration', 10); console.log(`Upgrading database v${from} → v${LATEST_VERSION}. Restore point: ${preMigrationBackup}`); }
    catch (e) { throw new Error(`Could not create the pre-upgrade backup, so the upgrade was NOT started: ${e.message}`); }
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'rep' CHECK (role IN ('admin','manager','rep')),
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, industry TEXT, website TEXT, size TEXT, city TEXT, country TEXT,
  phone TEXT, notes TEXT, owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT, email TEXT COLLATE NOCASE, phone TEXT, title TEXT,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'lead' CHECK (status IN ('lead','qualified','customer','churned')),
  source TEXT, tags TEXT, subscribed INTEGER NOT NULL DEFAULT 1,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email) WHERE email IS NOT NULL AND email <> '';
CREATE INDEX IF NOT EXISTS idx_contacts_account ON contacts(account_id);
CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, amount REAL NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT 'prospecting' CHECK (stage IN ('prospecting','qualification','proposal','negotiation','won','lost')),
  probability INTEGER NOT NULL DEFAULT 10, close_date TEXT,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  closed_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, due_date TEXT, priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
  done INTEGER NOT NULL DEFAULT 0, notes TEXT,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY, type TEXT NOT NULL CHECK (type IN ('note','call','email','meeting')), body TEXT NOT NULL,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
  account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS segments (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT, filter TEXT NOT NULL DEFAULT '{"match":"all","rules":[]}',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, subject TEXT NOT NULL, body_html TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, subject TEXT NOT NULL, body_html TEXT NOT NULL,
  from_name TEXT, from_email TEXT, segment_id INTEGER REFERENCES segments(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','sent','cancelled')),
  scheduled_at TEXT, sent_at TEXT, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS campaign_recipients (
  id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL, email TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')), error TEXT,
  sent_at TEXT, first_open_at TEXT, first_click_at TEXT, unsubscribed_at TEXT,
  open_count INTEGER NOT NULL DEFAULT 0, click_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_recipients_campaign ON campaign_recipients(campaign_id, status);
CREATE TABLE IF NOT EXISTS campaign_events (
  id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES campaign_recipients(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('open','click','unsubscribe')), url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_campaign ON campaign_events(campaign_id, type);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, user_id INTEGER, user_name TEXT, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id INTEGER, detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS senders (
  id INTEGER PRIMARY KEY, label TEXT NOT NULL, from_name TEXT, from_email TEXT NOT NULL, reply_to TEXT,
  mode TEXT NOT NULL DEFAULT 'smtp' CHECK (mode IN ('smtp','simulate')),
  host TEXT, port INTEGER DEFAULT 587, secure INTEGER NOT NULL DEFAULT 0, username TEXT, password_enc TEXT,
  daily_limit INTEGER NOT NULL DEFAULT 500, delay_ms INTEGER NOT NULL DEFAULT 1000,
  active INTEGER NOT NULL DEFAULT 1, is_default INTEGER NOT NULL DEFAULT 0,
  last_verified_at TEXT, last_error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS notification_rules (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, event TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  notify_owner INTEGER NOT NULL DEFAULT 0, user_ids TEXT NOT NULL DEFAULT '[]', extra_emails TEXT,
  sender_id INTEGER REFERENCES senders(id) ON DELETE SET NULL,
  min_amount REAL, only_stage TEXT, subject_template TEXT, intro TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, to_email TEXT NOT NULL, subject TEXT, sender_id INTEGER REFERENCES senders(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','failed','simulated')), error TEXT, message_id TEXT, response TEXT, rule_id INTEGER, event TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_log_created ON email_log(created_at);
CREATE TABLE IF NOT EXISTS deal_stage_history (
  id INTEGER PRIMARY KEY, deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  from_stage TEXT, to_stage TEXT NOT NULL, comment TEXT, amount REAL,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL, owner_name TEXT,
  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL, changed_by_name TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stage_history_deal ON deal_stage_history(deal_id, id);
`);

function ensureColumn(table, col, ddl) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
// Migrations for databases created by earlier versions
ensureColumn('campaigns', 'sender_id', 'INTEGER REFERENCES senders(id) ON DELETE SET NULL');
ensureColumn('campaigns', 'simulated', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('campaigns', 'note', 'TEXT');
ensureColumn('campaign_recipients', 'sender_id', 'INTEGER');
ensureColumn('campaign_recipients', 'message_id', 'TEXT');
ensureColumn('campaign_recipients', 'response', 'TEXT');

db.exec(`
CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  doc_type TEXT NOT NULL DEFAULT 'standard' CHECK (doc_type IN ('standard','simplified','credit_note','debit_note')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','partially_paid','paid')),
  number TEXT UNIQUE, seq INTEGER, icv INTEGER UNIQUE, external_number TEXT,
  jurisdiction TEXT NOT NULL DEFAULT 'KSA', currency TEXT NOT NULL DEFAULT 'SAR', lang TEXT NOT NULL DEFAULT 'both',
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL, contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  deal_id INTEGER REFERENCES deals(id) ON DELETE SET NULL,
  buyer_name TEXT, buyer_name_ar TEXT, buyer_vat TEXT, buyer_street TEXT, buyer_building TEXT, buyer_district TEXT,
  buyer_city TEXT, buyer_postal TEXT, buyer_country TEXT DEFAULT 'SA', buyer_email TEXT, buyer_phone TEXT,
  issue_date TEXT, supply_date TEXT, due_date TEXT, payment_terms TEXT, notes TEXT,
  ref_invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL, ref_number TEXT, reason TEXT,
  subtotal REAL NOT NULL DEFAULT 0, discount_total REAL NOT NULL DEFAULT 0, vat_total REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0,
  amount_paid REAL NOT NULL DEFAULT 0, amount_credited REAL NOT NULL DEFAULT 0,
  uuid TEXT, previous_hash TEXT, invoice_hash TEXT, qr TEXT, xml TEXT, seller_json TEXT,
  issued_at TEXT, issued_by INTEGER, issued_by_name TEXT,
  compliance_status TEXT NOT NULL DEFAULT 'not_ready', compliance_response TEXT, compliance_at TEXT,
  portal_token TEXT UNIQUE, source TEXT, owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL, created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status, due_date);
CREATE INDEX IF NOT EXISTS idx_invoices_account ON invoices(account_id);
CREATE TABLE IF NOT EXISTS invoice_lines (
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE, position INTEGER NOT NULL DEFAULT 0,
  description TEXT, description_ar TEXT, qty REAL NOT NULL DEFAULT 1, unit_price REAL NOT NULL DEFAULT 0, discount REAL NOT NULL DEFAULT 0,
  vat_category TEXT NOT NULL DEFAULT 'S' CHECK (vat_category IN ('S','Z','E','O')), vat_rate REAL NOT NULL DEFAULT 15, exemption_reason TEXT,
  net REAL NOT NULL DEFAULT 0, vat REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE, amount REAL NOT NULL, paid_on TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'bank_transfer', reference TEXT, note TEXT, reconciled INTEGER NOT NULL DEFAULT 0,
  recorded_by INTEGER, recorded_by_name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS payment_claims (
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE, amount REAL NOT NULL, paid_on TEXT, reference TEXT, payer_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected')), resolved_by_name TEXT, resolved_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS invoice_events (
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE, type TEXT NOT NULL, detail TEXT,
  user_id INTEGER, user_name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invoice_events ON invoice_events(invoice_id, id);
CREATE TABLE IF NOT EXISTS reminder_log (
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE, kind TEXT NOT NULL DEFAULT 'auto', offset_days INTEGER,
  channel TEXT NOT NULL, status TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reminder_auto ON reminder_log(invoice_id, offset_days, channel) WHERE kind='auto';
`);
for (const [col, ddl] of [['name_ar', 'TEXT'], ['vat_number', 'TEXT'], ['street', 'TEXT'], ['building_no', 'TEXT'], ['district', 'TEXT'], ['postal_code', 'TEXT'], ['country_code', "TEXT DEFAULT 'SA'"], ['billing_email', 'TEXT'], ['billing_phone', 'TEXT']]) ensureColumn('accounts', col, ddl);
ensureColumn('tasks', 'invoice_id', 'INTEGER REFERENCES invoices(id) ON DELETE CASCADE');

// Tax documents are immutable once issued (ZATCA: correct with credit/debit notes, never by editing). Enforced in the database itself.
const IMMUTABILITY_SQL = `
CREATE TRIGGER IF NOT EXISTS trg_invoice_immutable BEFORE UPDATE ON invoices
WHEN OLD.status <> 'draft' AND (
  NEW.number IS NOT OLD.number OR NEW.seq IS NOT OLD.seq OR NEW.icv IS NOT OLD.icv OR NEW.uuid IS NOT OLD.uuid OR NEW.previous_hash IS NOT OLD.previous_hash
  OR NEW.invoice_hash IS NOT OLD.invoice_hash OR NEW.xml IS NOT OLD.xml OR NEW.seller_json IS NOT OLD.seller_json OR NEW.total IS NOT OLD.total OR NEW.subtotal IS NOT OLD.subtotal
  OR NEW.vat_total IS NOT OLD.vat_total OR NEW.discount_total IS NOT OLD.discount_total OR NEW.doc_type IS NOT OLD.doc_type OR NEW.currency IS NOT OLD.currency
  OR NEW.jurisdiction IS NOT OLD.jurisdiction OR NEW.issue_date IS NOT OLD.issue_date OR NEW.supply_date IS NOT OLD.supply_date OR NEW.ref_invoice_id IS NOT OLD.ref_invoice_id
  OR NEW.buyer_name IS NOT OLD.buyer_name OR NEW.buyer_vat IS NOT OLD.buyer_vat OR NEW.buyer_street IS NOT OLD.buyer_street OR NEW.buyer_city IS NOT OLD.buyer_city
  OR NEW.buyer_postal IS NOT OLD.buyer_postal OR NEW.buyer_building IS NOT OLD.buyer_building OR NEW.buyer_district IS NOT OLD.buyer_district OR NEW.buyer_country IS NOT OLD.buyer_country)
BEGIN SELECT RAISE(ABORT, 'Issued invoices cannot be changed. Issue a credit or debit note instead.'); END;
CREATE TRIGGER IF NOT EXISTS trg_invoice_no_delete BEFORE DELETE ON invoices WHEN OLD.status <> 'draft'
BEGIN SELECT RAISE(ABORT, 'Issued invoices cannot be deleted (tax records must be retained).'); END;
CREATE TRIGGER IF NOT EXISTS trg_lines_no_update BEFORE UPDATE ON invoice_lines WHEN (SELECT status FROM invoices WHERE id = OLD.invoice_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'Lines of an issued invoice cannot be changed.'); END;
CREATE TRIGGER IF NOT EXISTS trg_lines_no_delete BEFORE DELETE ON invoice_lines WHEN (SELECT status FROM invoices WHERE id = OLD.invoice_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'Lines of an issued invoice cannot be deleted.'); END;
CREATE TRIGGER IF NOT EXISTS trg_lines_no_insert BEFORE INSERT ON invoice_lines WHEN (SELECT status FROM invoices WHERE id = NEW.invoice_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'Lines cannot be added to an issued invoice.'); END;
CREATE TRIGGER IF NOT EXISTS trg_events_no_update BEFORE UPDATE ON invoice_events
BEGIN SELECT RAISE(ABORT, 'The audit trail is append-only.'); END;
`;
const TRIGGER_NAMES = ['trg_invoice_immutable', 'trg_invoice_no_delete', 'trg_lines_no_update', 'trg_lines_no_delete', 'trg_lines_no_insert', 'trg_events_no_update'];
db.exec(IMMUTABILITY_SQL);
/** ONLY for the seed/reset CLI: temporarily lift the immutability triggers, then restore them. */
export function withoutImmutability(fn) {
  for (const t of TRIGGER_NAMES) db.exec(`DROP TRIGGER IF EXISTS ${t}`);
  try { return fn(); } finally { db.exec(IMMUTABILITY_SQL); }
}

/** Give deals that predate history tracking a starting entry so every deal has a timeline. Safe to run repeatedly. */
export function backfillDealHistory() {
  db.exec(`INSERT INTO deal_stage_history (deal_id,from_stage,to_stage,comment,amount,owner_id,owner_name,changed_by_name,changed_at)
    SELECT d.id, NULL, d.stage, 'Existing deal — stage movements before history tracking was added are not available', d.amount, d.owner_id,
      (SELECT name FROM users WHERE id=d.owner_id), NULL, COALESCE(d.closed_at, d.created_at)
    FROM deals d WHERE NOT EXISTS (SELECT 1 FROM deal_stage_history h WHERE h.deal_id=d.id)`);
}
backfillDealHistory();
runMigrations(db);

/** Run fn inside a transaction. */
export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const get = (sql, ...p) => db.prepare(sql).get(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);
export const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export function audit(user, action, entity, entityId, detail) {
  run('INSERT INTO audit_log (user_id,user_name,action,entity,entity_id,detail) VALUES (?,?,?,?,?,?)',
    user?.id ?? null, user?.name ?? null, action, entity, entityId ?? null, detail ? String(detail).slice(0, 300) : null);
}
