// Restore the database from a backup:  npm run restore -- data/backups/<file>.db --yes
// STOP THE SERVER FIRST. The current database is copied aside (…before-restore-…) so a restore can be undone.
import path from 'node:path';
import { config } from '../server/config.js';
import { restoreBackup, verifyBackup, listBackups } from '../server/backup-core.js';
const args = process.argv.slice(2); const file = args.find((a) => !a.startsWith('--')); const yes = args.includes('--yes');
if (!file) {
  console.log(`Usage: npm run restore -- <backup file> --yes\n\nAvailable backups in ${config.backupDir}:`);
  for (const b of listBackups(config.backupDir)) console.log(`  ${b.name}  (${(b.size / 1024).toFixed(0)} KB, ${b.label})`);
  process.exit(1);
}
const full = path.resolve(file); const v = verifyBackup(full);
if (!v.ok) { console.error(`That backup is not usable: ${v.error || v.integrity}`); process.exit(1); }
console.log(`Backup OK: ${v.users} users, schema v${v.schema_version}, ${(v.size / 1024).toFixed(0)} KB.\nThis will REPLACE ${config.dbPath}. Make sure the server is stopped.`);
if (!yes) { console.log('Add --yes to proceed.'); process.exit(2); }
const r = restoreBackup(full, config.dbPath);
console.log(`Restored. Previous database saved as ${r.previous_copy || '(there was none)'}\nStart the server again with: npm start`);
