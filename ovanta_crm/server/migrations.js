import { SYSTEM_ROLES } from './permissions.js';

/** Give built-in roles any permission keys they do not have yet (new features), without touching choices an admin already made. */
function fillMissingPerms(db) {
  for (const r of db.prepare('SELECT id, name, permissions FROM roles WHERE is_system=1').all()) {
    const def = SYSTEM_ROLES.find((s) => s.name === r.name)?.permissions; if (!def) continue;
    let cur = {}; try { cur = JSON.parse(r.permissions); } catch {}
    for (const [res, acts] of Object.entries(def)) for (const [a, v] of Object.entries(acts)) if (cur[res]?.[a] === undefined) cur[res] = { ...(cur[res] || {}), [a]: r.name === 'admin' ? v : v };
    db.prepare('UPDATE roles SET permissions=? WHERE id=?').run(JSON.stringify(cur), r.id);
  }
}

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
  {
    version: 3, name: 'custom_fields_and_layouts',
    up(db) {
      for (const t of ['contacts', 'accounts', 'deals']) if (!hasColumn(db, t, 'custom')) db.exec(`ALTER TABLE ${t} ADD COLUMN custom TEXT NOT NULL DEFAULT '{}'`);
      db.exec(`CREATE TABLE IF NOT EXISTS field_defs (
        id INTEGER PRIMARY KEY, entity TEXT NOT NULL CHECK (entity IN ('contacts','accounts','deals')), key TEXT NOT NULL, label TEXT NOT NULL,
        type TEXT NOT NULL, options TEXT NOT NULL DEFAULT '[]', config TEXT NOT NULL DEFAULT '{}', required INTEGER NOT NULL DEFAULT 0, default_value TEXT, help_text TEXT,
        placeholder TEXT, show_in_list INTEGER NOT NULL DEFAULT 0, filterable INTEGER NOT NULL DEFAULT 0, searchable INTEGER NOT NULL DEFAULT 0, visible_when TEXT,
        archived INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (entity, key))`);
      db.exec(`CREATE TABLE IF NOT EXISTS layouts (entity TEXT PRIMARY KEY CHECK (entity IN ('contacts','accounts','deals')), config TEXT NOT NULL, updated_by INTEGER, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
      // new permission area: refresh the stored Administrator permissions (always full) so the roles screen is accurate
      db.prepare("UPDATE roles SET permissions=? WHERE name='admin' AND is_system=1").run(JSON.stringify(SYSTEM_ROLES[0].permissions));
    },
  },
  {
    version: 4, name: 'lead_conversion_attachments_2fa_sessions',
    up(db) {
      for (const [c, ddl] of [['converted_at', 'TEXT'], ['converted_by', 'INTEGER'], ['converted_deal_id', 'INTEGER'], ['converted_account_id', 'INTEGER']]) if (!hasColumn(db, 'contacts', c)) db.exec(`ALTER TABLE contacts ADD COLUMN ${c} ${ddl}`);
      for (const [c, ddl] of [['totp_secret_enc', 'TEXT'], ['totp_enabled', 'INTEGER NOT NULL DEFAULT 0'], ['totp_last_step', 'INTEGER NOT NULL DEFAULT 0'], ['twofa_enabled_at', 'TEXT']]) if (!hasColumn(db, 'users', c)) db.exec(`ALTER TABLE users ADD COLUMN ${c} ${ddl}`);
      db.exec(`CREATE TABLE IF NOT EXISTS recovery_codes (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, code_hash TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_recovery_user ON recovery_codes(user_id)`);
      db.exec(`CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), last_seen_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, ip TEXT, user_agent TEXT, limited INTEGER NOT NULL DEFAULT 0, revoked_at TEXT)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`);
      db.exec(`CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY, entity TEXT NOT NULL CHECK (entity IN ('contacts','accounts','deals','invoices')), record_id INTEGER NOT NULL,
        name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, path TEXT NOT NULL UNIQUE, note TEXT, uploaded_by INTEGER, uploaded_by_name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_files_record ON files(entity, record_id)');
      fillMissingPerms(db);
    },
  },
  {
    version: 5, name: 'file_stage_folders',
    up(db) {
      if (!hasColumn(db, 'files', 'stage')) db.exec('ALTER TABLE files ADD COLUMN stage TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_files_stage ON files(entity, record_id, stage)');
    },
  },
  {
    version: 6, name: 'task_assignment_workflow',
    up(db) {
      for (const [c, ddl] of [['status', "TEXT NOT NULL DEFAULT 'open'"], ['assigned_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL'],
        ['assigned_at', 'TEXT'], ['completed_at', 'TEXT']]) if (!hasColumn(db, 'tasks', c)) db.exec(`ALTER TABLE tasks ADD COLUMN ${c} ${ddl}`);
      db.exec("UPDATE tasks SET status='done' WHERE done=1 AND status='open'");
      db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_assigned_by ON tasks(assigned_by)');
      db.exec(`CREATE TABLE IF NOT EXISTS task_events (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, body TEXT, actor_type TEXT NOT NULL DEFAULT 'user', actor_id INTEGER, actor_name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, id)');
      // files may now belong to tasks too: SQLite cannot change a CHECK constraint, so rebuild the table with the same rows
      const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='files'").get()?.sql || '';
      if (!sql.includes("'tasks'")) {
        db.exec(`CREATE TABLE files_v6 (id INTEGER PRIMARY KEY, entity TEXT NOT NULL CHECK (entity IN ('contacts','accounts','deals','invoices','tasks')), record_id INTEGER NOT NULL,
          name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, path TEXT NOT NULL UNIQUE, note TEXT, uploaded_by INTEGER, uploaded_by_name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), stage TEXT)`);
        db.exec('INSERT INTO files_v6 (id,entity,record_id,name,mime,size,sha256,path,note,uploaded_by,uploaded_by_name,created_at,stage) SELECT id,entity,record_id,name,mime,size,sha256,path,note,uploaded_by,uploaded_by_name,created_at,stage FROM files');
        db.exec('DROP TABLE files'); db.exec('ALTER TABLE files_v6 RENAME TO files');
        db.exec('CREATE INDEX IF NOT EXISTS idx_files_record ON files(entity, record_id)'); db.exec('CREATE INDEX IF NOT EXISTS idx_files_stage ON files(entity, record_id, stage)');
      }
    },
  },
  {
    version: 7, name: 'record_versions_for_concurrent_editing',
    up(db) {
      for (const t of ['contacts', 'accounts', 'deals', 'tasks']) {
        for (const [c, ddl] of [['version', 'INTEGER NOT NULL DEFAULT 1'], ['updated_at', 'TEXT'], ['updated_by', 'INTEGER']]) if (!hasColumn(db, t, c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${ddl}`);
        // Any write that does not bump the version itself (bulk actions, imports, background jobs) still counts as a change
        db.exec(`CREATE TRIGGER IF NOT EXISTS trg_${t}_version AFTER UPDATE ON ${t} WHEN NEW.version = OLD.version
          BEGIN UPDATE ${t} SET version = OLD.version + 1, updated_at = datetime('now'), updated_by = NULL WHERE id = NEW.id; END`);
      }
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
