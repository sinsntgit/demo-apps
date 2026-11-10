// Backup primitives. No imports from db.js on purpose (db.js uses this before the schema is touched).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const stamp = () => new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const safeLabel = (l) => String(l || 'manual').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);

/** Consistent online snapshot of a live database (VACUUM INTO). Returns the file path. */
export function backupDatabase(db, dir, label = 'manual') {
  fs.mkdirSync(dir, { recursive: true });
  let file = path.join(dir, `ovantaa-${stamp()}-${safeLabel(label)}.db`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `ovantaa-${stamp()}-${safeLabel(label)}-${i}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  return file;
}

/** Open a backup read-only and check it is a healthy Ovantaa database. */
export function verifyBackup(file) {
  let d;
  try {
    d = new DatabaseSync(file, { readOnly: true });
    const integrity = d.prepare('PRAGMA integrity_check').get();
    const ok = Object.values(integrity)[0] === 'ok';
    const hasUsers = !!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get();
    const users = hasUsers ? d.prepare('SELECT COUNT(*) n FROM users').get().n : 0;
    const version = d.prepare("SELECT 1 FROM sqlite_master WHERE name='schema_migrations'").get() ? d.prepare('SELECT MAX(version) v FROM schema_migrations').get().v : 0;
    return { ok: ok && hasUsers, integrity: Object.values(integrity)[0], users, schema_version: version, size: fs.statSync(file).size };
  } catch (e) { return { ok: false, error: e.message }; }
  finally { try { d?.close(); } catch {} }
}

export function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^ovantaa-.*\.db$/.test(f)).map((name) => {
    const st = fs.statSync(path.join(dir, name)); const m = name.match(/^ovantaa-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-(.+)\.db$/);
    return { name, file: path.join(dir, name), size: st.size, mtime: st.mtime.toISOString(), label: m ? m[1].replace(/-\d+$/, '') : 'unknown' };
  }).sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}

/** Keep only the newest `keep` backups whose label starts with `labelPrefix`. */
export function pruneBackups(dir, labelPrefix, keep) {
  const mine = listBackups(dir).filter((b) => b.label.startsWith(labelPrefix));
  for (const b of mine.slice(Math.max(1, keep))) { try { fs.unlinkSync(b.file); } catch {} }
}

/**
 * Replace the database file at targetPath with a verified backup. The server MUST be stopped.
 * The current database (if any) is first copied aside so a restore can itself be undone.
 */
export function restoreBackup(file, targetPath) {
  const v = verifyBackup(file); if (!v.ok) throw new Error(`Backup is not usable: ${v.error || v.integrity}`);
  let aside = null;
  if (fs.existsSync(targetPath)) { aside = `${targetPath}.before-restore-${stamp()}`; fs.copyFileSync(targetPath, aside); }
  for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(targetPath + ext); } catch {} }
  fs.copyFileSync(file, targetPath);
  return { restored: targetPath, previous_copy: aside, ...v };
}
