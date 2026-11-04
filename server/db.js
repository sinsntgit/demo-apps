import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

if (config.dbPath !== ':memory:') fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

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
