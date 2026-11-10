import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { backupDatabase, verifyBackup, listBackups, pruneBackups, restoreBackup } from '../server/backup-core.js';
import { runMigrations, MIGRATIONS, LATEST_VERSION } from '../server/migrations.js';

const run = promisify(execFile);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ovantaa-test-'));
const SERVER = path.resolve('server/index.js');

// The users table exactly as it was before roles existed
const OLD_USERS = `CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'rep' CHECK (role IN ('admin','manager','rep')), active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')))`;

test('migrating an existing pre-roles database: restore point first, data intact, roles mapped', async () => {
  const dir = tmp(); const dbFile = path.join(dir, 'old.db');
  const old = new DatabaseSync(dbFile); old.exec(OLD_USERS);
  old.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('Alice Admin','alice@x.example','hash-a','admin'),('Mo Manager','mo@x.example','hash-m','manager'),('Rita Rep','rita@x.example','hash-r','rep')").run(); old.close();
  const { stdout } = await run('node', ['--no-warnings', '-e', "import('./server/db.js').then(({db})=>{console.log(JSON.stringify({v:db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v,users:db.prepare('SELECT u.email,u.role,u.role_id,r.name rname,u.password_hash h FROM users u JOIN roles r ON r.id=u.role_id ORDER BY u.id').all(),roles:db.prepare('SELECT name,is_system FROM roles ORDER BY id').all()}))})"],
    { cwd: process.cwd(), env: { ...process.env, DB_PATH: dbFile, DATA_DIR: dir, SEED_DEMO: '0' } });
  const r = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(r.v, LATEST_VERSION); assert.deepEqual(r.roles.map((x) => x.name), ['admin', 'manager', 'rep']);
  assert.deepEqual(r.users.map((u) => [u.email, u.role, u.rname, u.h]), [['alice@x.example', 'admin', 'admin', 'hash-a'], ['mo@x.example', 'manager', 'manager', 'hash-m'], ['rita@x.example', 'rep', 'rep', 'hash-r']]);
  const backups = listBackups(path.join(dir, 'backups')); assert.equal(backups.length, 1); assert.match(backups[0].name, /premigration-v0-to-v\d+/);
  const b = new DatabaseSync(backups[0].file, { readOnly: true }); // the restore point is the OLD database: no roles table yet
  assert.equal(b.prepare('SELECT COUNT(*) n FROM users').get().n, 3); assert.equal(b.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('roles','schema_migrations')").get().n, 0); b.close();
  // second start: nothing pending → no new backup, idempotent
  await run('node', ['--no-warnings', '-e', "import('./server/db.js')"], { env: { ...process.env, DB_PATH: dbFile, DATA_DIR: dir, SEED_DEMO: '0' } });
  assert.equal(listBackups(path.join(dir, 'backups')).length, 1);
});

test('a failing migration rolls back completely and says so; earlier ones stay applied', () => {
  const db = new DatabaseSync(':memory:');
  const list = [{ version: 1, name: 'one', up: (d) => d.exec('CREATE TABLE t1 (a)') }, { version: 2, name: 'boom', up: (d) => { d.exec('CREATE TABLE t2 (a)'); throw new Error('kaboom'); } }];
  assert.throws(() => runMigrations(db, list), /Migration 2 \(boom\) failed and was rolled back: kaboom/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='t2'").get().n, 0, 'partial work undone');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='t1'").get().n, 1);
  assert.deepEqual(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version), [1]);
  assert.deepEqual(runMigrations(db, [list[0]]), [], 'applying again is a no-op');
  assert.ok(MIGRATIONS.every((m, i) => m.version === i + 1), 'versions are consecutive');
});

test('backup core: consistent snapshot, verification, retention, restore with an undo copy', () => {
  const dir = tmp(); const live = path.join(dir, 'live.db'); const d = new DatabaseSync(live);
  d.exec("PRAGMA journal_mode=WAL; CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO users (name) VALUES ('a'),('b'),('c')");
  const f1 = backupDatabase(d, path.join(dir, 'b'), 'daily'); const v = verifyBackup(f1);
  assert.equal(v.ok, true); assert.equal(v.users, 3); assert.equal(v.integrity, 'ok');
  d.exec("INSERT INTO users (name) VALUES ('d')"); const f2 = backupDatabase(d, path.join(dir, 'b'), 'daily'); backupDatabase(d, path.join(dir, 'b'), 'manual');
  assert.equal(verifyBackup(f1).users, 3, 'earlier backup unaffected'); assert.equal(verifyBackup(f2).users, 4);
  for (let i = 0; i < 3; i++) backupDatabase(d, path.join(dir, 'b'), 'daily');
  pruneBackups(path.join(dir, 'b'), 'daily', 2);
  const left = listBackups(path.join(dir, 'b')); assert.equal(left.filter((b) => b.label === 'daily').length, 2); assert.equal(left.filter((b) => b.label === 'manual').length, 1, 'other labels untouched');
  // corrupt files are refused and the target is left alone
  const bad = path.join(dir, 'bad.db'); fs.writeFileSync(bad, 'this is not a database'); assert.equal(verifyBackup(bad).ok, false);
  assert.throws(() => restoreBackup(bad, live), /not usable/);
  d.exec("INSERT INTO users (name) VALUES ('e'),('f')"); d.close();                 // live now has 6 rows
  const manual = left.find((b) => b.label === 'manual');                              // the snapshot taken when there were 4
  const r = restoreBackup(manual.file, live);
  assert.equal(new DatabaseSync(live).prepare('SELECT COUNT(*) n FROM users').get().n, 4); assert.ok(r.previous_copy && fs.existsSync(r.previous_copy));
  assert.equal(new DatabaseSync(r.previous_copy).prepare('SELECT COUNT(*) n FROM users').get().n, 6, 'undo copy holds the pre-restore state');
});

test('running server: daily backup at startup, admin backup endpoints, download is a valid database, rep forbidden', async () => {
  const dir = tmp(); const port = 3900 + Math.floor(Math.random() * 90);
  const child = spawn('node', ['--no-warnings', SERVER], { env: { ...process.env, PORT: String(port), DB_PATH: path.join(dir, 'app.db'), DATA_DIR: dir, SEED_BILLING_DEMO: '0', BASE_URL: `http://localhost:${port}` }, stdio: 'pipe' });
  try {
    const base = `http://localhost:${port}`;
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    const login = async (email) => (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Ovantaa@123' }) })).headers.get('set-cookie').split(';')[0];
    const admin = await login('admin@ovantaa.com'), rep = await login('liam@ovantaa.com');
    const get = (p, ck, opts = {}) => fetch(base + p, { headers: { cookie: ck }, ...opts });
    assert.ok(listBackups(path.join(dir, 'backups')).some((b) => b.label === 'daily'), 'automatic daily backup was taken at startup');
    assert.equal((await get('/api/admin/backups', rep)).status, 403); assert.equal((await get('/api/admin/backup', rep)).status, 403);
    const made = await (await get('/api/admin/backups', admin, { method: 'POST' })).json(); assert.equal(made.verified, true); assert.ok(made.users >= 4);
    const list = await (await get('/api/admin/backups', admin)).json(); assert.ok(list.length >= 2 && list.every((b) => !b.file), 'server paths are not exposed');
    const dl = await get('/api/admin/backup', admin); assert.equal(dl.status, 200); assert.match(dl.headers.get('content-disposition'), /attachment; filename="ovantaa-.*\.db"/);
    const out = path.join(dir, 'downloaded.db'); fs.writeFileSync(out, Buffer.from(await dl.arrayBuffer())); const v = verifyBackup(out); assert.equal(v.ok, true); assert.ok(v.schema_version >= 2);
  } finally { child.kill(); }
});

test('in-memory databases give a clear error instead of a crash', async () => {
  process.env.DB_PATH = ':memory:'; process.env.SESSION_SECRET = 'x';
  const { createBackup } = await import('../server/backup.js');
  assert.throws(() => createBackup('manual'), /in-memory/);
});
