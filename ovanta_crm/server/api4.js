import fs from 'node:fs';
import { GET, POST, PUT, DELETE, bad, notFound, forbidden } from './http.js';
import { all, get, run, audit } from './db.js';
import { RESOURCES, ACTION_LABELS, SYSTEM_ROLES, normalizePerms, check } from './permissions.js';
import { createBackup, listBackups, verifyBackup } from './backup.js';
import { config } from './config.js';

// ---------- Roles ----------
const RANK = { none: 0, own: 1, all: 2 };
const catalogue = () => Object.entries(RESOURCES).map(([key, r]) => ({ key, label: r.label, scoped: !!r.scoped, actions: Object.entries(r.actions).map(([a, kind]) => ({ key: a, kind, label: ACTION_LABELS[a] || a })) }));
const roleRow = (r) => ({ id: r.id, name: r.name, label: r.label || r.name, description: r.description, is_system: !!r.is_system, permissions: normalizePerms(JSON.parse(r.permissions || '{}')), user_count: r.user_count ?? 0 });
const ROLE_SELECT = 'SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS user_count FROM roles r';

/** Nobody can grant more than they hold themselves (stops a delegated "manage users" role from minting an admin). */
function assertNoEscalation(user, perms) {
  for (const [res, def] of Object.entries(RESOURCES)) for (const [act, kind] of Object.entries(def.actions)) {
    const want = perms[res][act]; const have = check(user.perms, `${res}.${act}`);
    const w = kind === 'scope' ? RANK[want] : want ? 1 : 0, h = kind === 'scope' ? RANK[have || 'none'] : have ? 1 : 0;
    if (w > h) throw forbidden(`You cannot grant "${ACTION_LABELS[act] || act} ${def.label}" because your own role does not include it.`);
  }
}
const cleanName = (n) => { const s = String(n || '').trim().replace(/\s+/g, ' '); if (!/^[\p{L}\p{N} _.-]{2,40}$/u.test(s)) throw bad('Role name must be 2–40 letters, numbers, spaces, dashes or dots'); return s; };

GET('/api/roles', () => ({ roles: all(`${ROLE_SELECT} ORDER BY r.is_system DESC, r.id`).map(roleRow), catalogue: catalogue() }));
POST('/api/roles', ({ body, user }) => {
  const name = cleanName(body.name); const perms = normalizePerms(body.permissions);
  if (get('SELECT 1 FROM roles WHERE name=?', name)) throw bad('A role with that name already exists');
  assertNoEscalation(user, perms);
  const id = Number(run('INSERT INTO roles (name,label,description,permissions,is_system) VALUES (?,?,?,?,0)', name, String(body.label || name).trim().slice(0, 60), String(body.description || '').slice(0, 300) || null, JSON.stringify(perms)).lastInsertRowid);
  audit(user, 'create', 'roles', id, name); return roleRow(get(`${ROLE_SELECT} WHERE r.id=?`, id));
});
PUT('/api/roles/:id', ({ params, body, user }) => {
  const r = get('SELECT * FROM roles WHERE id=?', params.id); if (!r) throw notFound('Role not found');
  if (r.is_system && r.name === 'admin') throw forbidden('The Administrator role always has full access and cannot be changed.');
  const perms = body.permissions ? normalizePerms(body.permissions) : normalizePerms(JSON.parse(r.permissions));
  assertNoEscalation(user, perms);
  const name = r.is_system ? r.name : cleanName(body.name ?? r.name);
  if (name !== r.name && get('SELECT 1 FROM roles WHERE name=? AND id<>?', name, r.id)) throw bad('A role with that name already exists');
  run('UPDATE roles SET name=?, label=?, description=?, permissions=? WHERE id=?', name, String(body.label ?? r.label ?? name).trim().slice(0, 60), body.description === undefined ? r.description : String(body.description).slice(0, 300) || null, JSON.stringify(perms), r.id);
  audit(user, 'update', 'roles', r.id, name); return roleRow(get(`${ROLE_SELECT} WHERE r.id=?`, r.id));
});
POST('/api/roles/:id/duplicate', ({ params, user }) => {
  const r = get('SELECT * FROM roles WHERE id=?', params.id); if (!r) throw notFound('Role not found');
  const perms = normalizePerms(JSON.parse(r.permissions)); assertNoEscalation(user, perms);
  let name = `${r.name} (copy)`; for (let i = 2; get('SELECT 1 FROM roles WHERE name=?', name); i++) name = `${r.name} (copy ${i})`;
  const id = Number(run('INSERT INTO roles (name,label,description,permissions,is_system) VALUES (?,?,?,?,0)', name, name, r.description, JSON.stringify(perms)).lastInsertRowid);
  audit(user, 'create', 'roles', id, `duplicate of ${r.name}`); return roleRow(get(`${ROLE_SELECT} WHERE r.id=?`, id));
});
DELETE('/api/roles/:id', ({ params, user }) => {
  const r = get(`${ROLE_SELECT} WHERE r.id=?`, params.id); if (!r) throw notFound('Role not found');
  if (r.is_system) throw forbidden('Built-in roles cannot be deleted.');
  if (r.user_count) throw bad(`${r.user_count} user${r.user_count === 1 ? ' still has' : 's still have'} this role. Move them to another role first.`);
  run('DELETE FROM roles WHERE id=?', r.id); audit(user, 'delete', 'roles', r.id, r.name); return { ok: true };
});

// ---------- Backups ----------
GET('/api/admin/backups', () => listBackups(config.backupDir).map(({ file, ...b }) => b));
POST('/api/admin/backups', ({ user }) => {
  let file; try { file = createBackup('manual'); } catch (e) { throw bad(e.message); }
  const v = verifyBackup(file); audit(user, 'backup', 'database', null, file.split(/[\\/]/).pop());
  return { name: file.split(/[\\/]/).pop(), size: v.size, verified: v.ok, users: v.users };
});
GET('/api/admin/backup', ({ res, user }) => {
  let file; try { file = createBackup('manual'); } catch (e) { throw bad(e.message); }
  const name = file.split(/[\\/]/).pop(); audit(user, 'backup_download', 'database', null, name);
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(file).size, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
