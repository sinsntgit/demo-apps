// Create a verified backup of the database now:  npm run backup
import { createBackup } from '../server/backup.js';
import { verifyBackup } from '../server/backup-core.js';
const file = createBackup('manual'); const v = verifyBackup(file);
console.log(v.ok ? `Backup created and verified: ${file}\n  ${v.users} users · schema v${v.schema_version} · ${(v.size / 1024).toFixed(0)} KB` : `Backup written to ${file} but FAILED verification: ${v.error || v.integrity}`);
process.exit(v.ok ? 0 : 1);
