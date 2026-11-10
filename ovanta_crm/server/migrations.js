import { SYSTEM_ROLES } from './permissions.js';

/**
 * Versioned migrations. Version 1 is the baseline: the schema that db.js creates idempotently (everything up to the invoicing release).
 * From version 2 on, every schema change is a numbered migration here — never an ad-hoc ALTER elsewhere.
 * Each migration runs in a transaction and is recorded in schema_migrations. Existing databases are backed up automatically first (see db.js).
 */
const hasColumn = (db, table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);

export const MIGRATIONS = [
  { version: 1, name: 'baseline', up() {} },
  {
    version: 2, name: 'roles_and_permissions',
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS roles (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, label TEXT, description TEXT, permissions TEXT NOT NULL,
        is_system INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
      const ins = db.prepare('INSERT OR IGNORE INTO roles (name,label,description,permissions,is_system) VALUES (?,?,?,?,1)');
      for (const r of SYSTEM_ROLES) ins.run(r.name, r.label, r.description, JSON.stringify(r.permissions));
      if (!hasColumn(db, 'users', 'role_id')) db.exec('ALTER TABLE users ADD COLUMN role_id INTEGER REFERENCES roles(id)');
      db.exec('UPDATE users SET role_id = (SELECT id FROM roles WHERE roles.name = users.role) WHERE role_id IS NULL');
      db.exec(`CREATE TRIGGER IF NOT EXISTS trg_users_role_id AFTER INSERT ON users WHEN NEW.role_id IS NULL
        BEGIN UPDATE users SET role_id = (SELECT id FROM roles WHERE name = NEW.role) WHERE id = NEW.id; END`);
    },
  },
];
export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export function currentVersion(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()) return 0;
  return db.prepare('SELECT COALESCE(MAX(version),0) v FROM schema_migrations').get().v;
}

export function runMigrations(db, list = MIGRATIONS) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
  const done = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  const applied = [];
  for (const m of list) {
    if (done.has(m.version)) continue;
    db.exec('BEGIN');
    try { m.up(db); db.prepare('INSERT INTO schema_migrations (version,name) VALUES (?,?)').run(m.version, m.name); db.exec('COMMIT'); applied.push(m.version); }
    catch (e) { db.exec('ROLLBACK'); throw new Error(`Migration ${m.version} (${m.name}) failed and was rolled back: ${e.message}. Your data is unchanged; restore point is in data/backups.`); }
  }
  return applied;
}
