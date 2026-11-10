import fs from 'node:fs';
import { db } from './db.js';
import { config } from './config.js';
import { backupDatabase, pruneBackups, listBackups, verifyBackup } from './backup-core.js';

export function createBackup(label = 'manual') {
  if (config.dbPath === ':memory:') throw new Error('An in-memory database cannot be backed up.');
  const file = backupDatabase(db, config.backupDir, label);
  pruneBackups(config.backupDir, label.split('-')[0], label.startsWith('premigration') ? 10 : config.backupKeep);
  return file;
}
/** One automatic backup per day (kept: BACKUP_KEEP newest). Safe to call every scheduler tick. */
export function maybeDailyBackup() {
  if (!config.backupDaily || config.dbPath === ':memory:') return null;
  const day = new Date().toISOString().slice(0, 10);
  if (listBackups(config.backupDir).some((b) => b.label === 'daily' && b.name.startsWith(`ovantaa-${day}-`))) return null;
  return createBackup('daily');
}
export { listBackups, verifyBackup, fs };
