import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.SEED_BILLING_DEMO = '0'; process.env.DB_PATH = ':memory:'; process.env.SESSION_SECRET = 'perm-secret'; process.env.BASE_URL = 'http://crm.test';
const { server } = await import('../server/index.js');
const { seedIfEmpty } = await import('../server/seed.js');
const { db } = await import('../server/db.js');
const { listRoutes } = await import('../server/http.js');
const { ROUTE_PERMS, LOGIN_ONLY } = await import('../server/route-permissions.js');
const { RESOURCES, SYSTEM_ROLES, normalizePerms, check } = await import('../server/permissions.js');

let base; const PW = 'Test@12345';
before(async () => { seedIfEmpty(); await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; });
after(() => server.close());
async function call(ck, method, path, body) {
  const r = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie: ck || '' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j };
}
const loginAs = async (email, password = 'Ovantaa@123') => { const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }); return { ck: r.headers.get('set-cookie')?.split(';')[0], body: await r.json(), status: r.status }; };
let admin, manager, rep;
const ids = { c: 0 };
async function makeRole(name, grants) { const r = await call(admin, 'POST', '/api/roles', { name, permissions: grants }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; }
async function makeUser(roleId, label) { const email = `${label}${++ids.c}@perm.example`; const r = await call(admin, 'POST', '/api/users', { name: label, email, password: PW, role_id: roleId }); assert.equal(r.status, 200, JSON.stringify(r.body)); const l = await loginAs(email, PW); return { ...l, id: r.body.id, email }; }

test('setup', async () => { admin = (await loginAs('admin@ovantaa.com')).ck; manager = (await loginAs('maya@ovantaa.com')).ck; rep = (await loginAs('liam@ovantaa.com')).ck; assert.ok(admin && manager && rep); });

test('the access matrix is complete and consistent: every route is classified, every key is real', () => {
  const routes = listRoutes().filter((r) => !r.public); const keys = new Set(routes.map((r) => `${r.method} ${r.pattern}`));
  const unclassified = [...keys].filter((k) => !ROUTE_PERMS[k] && !LOGIN_ONLY.has(k));
  assert.deepEqual(unclassified, [], 'new routes must be added to route-permissions.js (or LOGIN_ONLY)');
  const ghosts = Object.keys(ROUTE_PERMS).filter((k) => !keys.has(k)); assert.deepEqual(ghosts, [], 'matrix entries for routes that do not exist');
  const badKeys = Object.values(ROUTE_PERMS).filter((k) => { const [r, a] = k.split('.'); return !RESOURCES[r]?.actions?.[a]; }); assert.deepEqual(badKeys, []);
  for (const k of LOGIN_ONLY) assert.ok(keys.has(k), `LOGIN_ONLY lists a missing route ${k}`);
});

test('system roles: /auth/me exposes role label and permissions; manager/rep match the previous behaviour', async () => {
  const me = (await call(rep, 'GET', '/api/auth/me')).body.user;
  assert.equal(me.role, 'rep'); assert.equal(me.role_label, 'Sales rep'); assert.equal(me.perms.contacts.delete, 'own'); assert.equal(me.perms.invoices.issue, false); assert.equal(me.perms.users.manage, false);
  assert.equal((await call(admin, 'GET', '/api/auth/me')).body.user.perms.data.purge, true);
  const mgr = (await call(manager, 'GET', '/api/auth/me')).body.user; assert.equal(mgr.perms.invoices.issue, true); assert.equal(mgr.perms.users.view, false); assert.equal(mgr.perms.contacts.delete, 'all');
  for (const [m, p] of [['GET', '/api/users'], ['GET', '/api/roles'], ['GET', '/api/audit'], ['GET', '/api/admin/backups'], ['POST', '/api/admin/purge'], ['GET', '/api/billing/settings'], ['GET', '/api/senders'], ['GET', '/api/receivables']]) assert.equal((await call(rep, m, p, m === 'POST' ? {} : undefined)).status, 403, `rep ${m} ${p}`);
  for (const [m, p] of [['GET', '/api/users'], ['GET', '/api/audit'], ['GET', '/api/admin/backups'], ['PUT', '/api/billing/settings']]) assert.equal((await call(manager, m, p, m === 'PUT' ? {} : undefined)).status, 403, `manager ${m} ${p}`);
  for (const [m, p] of [['GET', '/api/billing/settings'], ['GET', '/api/receivables'], ['GET', '/api/senders'], ['GET', '/api/email-log']]) assert.equal((await call(manager, m, p)).status, 200, `manager ${m} ${p}`);
  assert.deepEqual(SYSTEM_ROLES.map((r) => r.name), ['admin', 'manager', 'rep']);
});

test('role definitions are normalised: unknown keys dropped, missing = denied, edit/delete never exceed view', async () => {
  const n = normalizePerms({ contacts: { view: 'own', edit: 'all', delete: true, create: 'yes', bogus: true }, nope: { view: true }, campaigns: { view: true, send: 'true' } });
  assert.equal(n.contacts.view, 'own'); assert.equal(n.contacts.edit, 'own', 'edit capped at view'); assert.equal(n.contacts.delete, 'own'); assert.equal(n.contacts.create, false, '"yes" is not true');
  assert.equal(n.contacts.bogus, undefined); assert.equal(n.nope, undefined); assert.equal(n.campaigns.send, true); assert.equal(n.invoices.issue, false);
  assert.equal(check(n, 'contacts.view'), 'own'); assert.equal(check(n, 'contacts.nonexistent'), false); assert.equal(check(undefined, 'contacts.view'), false);
  const r = await makeRole('Capped', { contacts: { view: 'none', edit: 'all' } }); assert.equal(r.permissions.contacts.edit, 'none');
});

test('custom role "Read-only": can look, cannot touch', async () => {
  const role = await makeRole('Read only', { contacts: { view: 'all', export: false }, accounts: { view: 'all' }, deals: { view: 'all' }, tasks: { view: 'all' }, invoices: { view: 'all' }, campaigns: { view: true } });
  const u = await makeUser(role.id, 'viewer');
  assert.equal((await call(u.ck, 'GET', '/api/contacts')).status, 200); assert.equal((await call(u.ck, 'GET', '/api/campaigns')).status, 200);
  const target = (await call(admin, 'GET', '/api/contacts?limit=1')).body.rows[0];
  assert.equal((await call(u.ck, 'POST', '/api/contacts', { first_name: 'X' })).status, 403);
  assert.equal((await call(u.ck, 'PUT', `/api/contacts/${target.id}`, { title: 'x' })).status, 403);
  assert.equal((await call(u.ck, 'DELETE', `/api/contacts/${target.id}`)).status, 403);
  assert.equal((await call(u.ck, 'GET', '/api/contacts/export.csv')).status, 403, 'export is its own permission');
  assert.equal((await call(u.ck, 'POST', '/api/contacts/import', { rows: [{ first_name: 'A', email: 'a@zz.example' }] })).status, 403);
  assert.equal((await call(u.ck, 'POST', '/api/contacts/bulk', { action: 'tag', value: 'x', ids: [target.id] })).status, 403);
  assert.equal((await call(u.ck, 'POST', '/api/deals/1/stage', { stage: 'won' })).status, 403);
  assert.equal((await call(u.ck, 'POST', '/api/invoices', { lines: [] })).status, 403);
  assert.equal((await call(u.ck, 'POST', '/api/campaigns', { name: 'x' })).status, 403); assert.equal((await call(u.ck, 'GET', '/api/segments')).status, 403, 'segments not granted');
  assert.equal((await call(u.ck, 'GET', '/api/auth/me')).body.user.role, 'Read only');
});

test('own-scope role: sees, edits and deletes only its own contacts, deals, tasks, notes; dashboard and lookups follow', async () => {
  const role = await makeRole('My records only', {
    contacts: { view: 'own', create: true, edit: 'own', delete: 'own', export: true, import: true }, accounts: { view: 'own', create: true, edit: 'own', delete: 'own' },
    deals: { view: 'own', create: true, edit: 'own', delete: 'own' }, tasks: { view: 'own', create: true, edit: 'own', delete: 'own' }, activities: { create: true, delete: 'own' } });
  const me = await makeUser(role.id, 'seller'); const mine = (await call(me.ck, 'POST', '/api/contacts', { first_name: 'Mine', email: 'mine@own.example' })).body;
  const others = (await call(admin, 'GET', '/api/contacts?limit=5')).body.rows.filter((c) => c.owner_id !== me.id); const theirs = others[0];
  assert.equal(mine.owner_id, me.id);
  const list = (await call(me.ck, 'GET', '/api/contacts?limit=100')).body; assert.equal(list.total, 1); assert.equal(list.rows[0].id, mine.id);
  assert.equal((await call(me.ck, 'GET', `/api/contacts/${theirs.id}`)).status, 404, 'other records look nonexistent'); assert.equal((await call(me.ck, 'GET', `/api/contacts/${theirs.id}/360`)).status, 404);
  assert.equal((await call(me.ck, 'PUT', `/api/contacts/${theirs.id}`, { title: 'hack' })).status, 404); assert.equal((await call(me.ck, 'DELETE', `/api/contacts/${theirs.id}`)).status, 404);
  assert.equal((await call(me.ck, 'PUT', `/api/contacts/${mine.id}`, { title: 'Boss' })).status, 200); assert.equal((await call(me.ck, 'GET', '/api/contacts?q=Mine')).body.total, 1);
  assert.ok((await call(me.ck, 'GET', '/api/lookup?type=contacts&q=')).body.every((r) => r.id === mine.id), 'lookups are scoped');
  const csv = await fetch(base + '/api/contacts/export.csv', { headers: { cookie: me.ck } }); const text = await csv.text(); assert.equal(text.trim().split('\r\n').length, 2, 'export holds only my contact'); assert.ok(!text.includes(theirs.email));
  // bulk operations touch only my records; bulk delete needs "all"
  const before = (await call(admin, 'GET', `/api/contacts/${theirs.id}`)).body.status;
  await call(me.ck, 'POST', '/api/contacts/bulk', { action: 'status', value: 'churned', ids: [theirs.id, mine.id] });
  assert.equal((await call(admin, 'GET', `/api/contacts/${theirs.id}`)).body.status, before, 'not changed'); assert.equal((await call(admin, 'GET', `/api/contacts/${mine.id}`)).body.status, 'churned');
  assert.equal((await call(me.ck, 'POST', '/api/contacts/bulk', { action: 'delete', ids: [mine.id] })).status, 403);
  // import cannot overwrite a contact that belongs to someone else
  const imp = (await call(me.ck, 'POST', '/api/contacts/import', { rows: [{ first_name: 'Hijack', email: theirs.email }] })).body; assert.equal(imp.updated, 0); assert.equal(imp.skipped, 1);
  assert.notEqual((await call(admin, 'GET', `/api/contacts/${theirs.id}`)).body.first_name, 'Hijack');
  // dashboard numbers are mine only
  assert.equal((await call(me.ck, 'GET', '/api/dashboard')).body.kpis.contacts, 1);
  // deals & tasks
  const theirDeal = (await call(admin, 'GET', '/api/deals?limit=1')).body.rows[0];
  assert.equal((await call(me.ck, 'GET', `/api/deals/${theirDeal.id}/history`)).status, 404); assert.equal((await call(me.ck, 'POST', `/api/deals/${theirDeal.id}/stage`, { stage: 'won' })).status, 404);
  const myDeal = (await call(me.ck, 'POST', '/api/deals', { name: 'My deal', amount: 10 })).body; assert.equal((await call(me.ck, 'POST', `/api/deals/${myDeal.id}/stage`, { stage: 'proposal', comment: 'ok' })).status, 200);
  assert.equal((await call(me.ck, 'GET', '/api/deals?limit=100')).body.total, 1);
  const theirTask = (await call(admin, 'GET', '/api/tasks?limit=1')).body.rows[0]; assert.equal((await call(me.ck, 'POST', `/api/tasks/${theirTask.id}/toggle`)).status, 404);
  const myTask = (await call(me.ck, 'POST', '/api/tasks', { title: 'mine' })).body; assert.equal((await call(me.ck, 'POST', `/api/tasks/${myTask.id}/toggle`)).status, 200);
  // activity notes: delete only my own
  const note = (await call(admin, 'POST', '/api/activities', { type: 'note', body: 'admin note', contact_id: mine.id })).body;
  assert.equal((await call(me.ck, 'DELETE', `/api/activities/${note.id}`)).status, 403);
  const mineNote = (await call(me.ck, 'POST', '/api/activities', { type: 'note', body: 'my note', contact_id: mine.id })).body; assert.equal((await call(me.ck, 'DELETE', `/api/activities/${mineNote.id}`)).status, 200);
  assert.equal((await call(me.ck, 'DELETE', `/api/contacts/${mine.id}`)).status, 200, 'may delete own');
});

test('own-scope invoices: list/detail/xml/print/edit/delete restricted to the owner', async () => {
  const cust = (await call(admin, 'POST', '/api/accounts', { name: 'Scope Co' })).body;
  const role = await makeRole('Invoice drafter', { invoices: { view: 'own', create: true, edit: 'own', delete: 'own' }, accounts: { view: 'all' } });
  const me = await makeUser(role.id, 'drafter');
  const line = { description: 'Work', qty: 1, unit_price: 100, vat_category: 'S' };
  const adminInv = (await call(admin, 'POST', '/api/invoices', { buyer_name: 'A', doc_type: 'simplified', lines: [line] })).body;
  const myInv = (await call(me.ck, 'POST', '/api/invoices', { buyer_name: 'B', doc_type: 'simplified', lines: [line] })).body;
  assert.equal(myInv.owner_id, me.id); const l = (await call(me.ck, 'GET', '/api/invoices')).body; assert.equal(l.total, 1); assert.equal(l.rows[0].id, myInv.id);
  for (const p of [`/api/invoices/${adminInv.id}`, `/api/invoices/${adminInv.id}/xml`, `/api/invoices/${adminInv.id}/print`]) assert.equal((await call(me.ck, 'GET', p)).status, 404, p);
  assert.equal((await call(me.ck, 'PUT', `/api/invoices/${adminInv.id}`, { notes: 'x' })).status, 404); assert.equal((await call(me.ck, 'DELETE', `/api/invoices/${adminInv.id}`)).status, 404);
  assert.equal((await call(me.ck, 'PUT', `/api/invoices/${myInv.id}`, { notes: 'mine' })).status, 200);
  assert.equal((await call(me.ck, 'POST', `/api/invoices/${myInv.id}/issue`)).status, 403, 'no issue permission');
  assert.equal((await call(me.ck, 'DELETE', `/api/invoices/${myInv.id}`)).status, 200);
  assert.equal((await call(admin, 'GET', `/api/invoices/${adminInv.id}`)).status, 200);
});

test('no privilege escalation: you can only grant what you hold', async () => {
  const delegator = await makeRole('Delegated admin', { users: { view: true, manage: true }, contacts: { view: 'all' } });
  const d = await makeUser(delegator.id, 'delegate');
  const tryRole = (name, perms) => call(d.ck, 'POST', '/api/roles', { name, permissions: perms });
  assert.equal((await tryRole('Sneaky purge', { data: { purge: true } })).status, 403);
  assert.equal((await tryRole('Sneaky edit', { contacts: { view: 'all', edit: 'all' } })).status, 403);
  assert.equal((await tryRole('Fine', { contacts: { view: 'own' } })).status, 200, 'granting less than you have is allowed');
  const full = (await call(admin, 'GET', '/api/roles')).body.roles.find((r) => r.name === 'admin');
  assert.equal((await call(d.ck, 'PUT', `/api/roles/${delegator.id}`, { permissions: { ...delegator.permissions, data: { backup: true } } })).status, 403, 'cannot raise own role');
  assert.equal((await call(d.ck, 'PUT', `/api/roles/${full.id}`, { permissions: {} })).status, 403);
  // a delegate could still assign an existing powerful role to a user — but only users.manage holders reach this endpoint at all
  assert.equal((await call(rep, 'POST', '/api/roles', { name: 'x', permissions: {} })).status, 403);
});

test('role management: CRUD, protections, duplicate, delete rules, live effect on existing sessions', async () => {
  const roles = (await call(admin, 'GET', '/api/roles')).body; assert.ok(roles.catalogue.find((c) => c.key === 'invoices').actions.some((a) => a.key === 'issue'));
  const adminRole = roles.roles.find((r) => r.name === 'admin'), repRole = roles.roles.find((r) => r.name === 'rep');
  assert.equal(adminRole.is_system, true); assert.ok(adminRole.user_count >= 1);
  assert.equal((await call(admin, 'PUT', `/api/roles/${adminRole.id}`, { permissions: {} })).status, 403); assert.equal((await call(admin, 'DELETE', `/api/roles/${adminRole.id}`)).status, 403); assert.equal((await call(admin, 'DELETE', `/api/roles/${repRole.id}`)).status, 403);
  assert.equal((await call(admin, 'POST', '/api/roles', { name: 'rep', permissions: {} })).status, 400, 'duplicate name'); assert.equal((await call(admin, 'POST', '/api/roles', { name: '<b>', permissions: {} })).status, 400, 'bad name');
  const r = await makeRole('Temp role', { contacts: { view: 'all', create: true } }); const u = await makeUser(r.id, 'temp');
  assert.equal((await call(u.ck, 'POST', '/api/contacts', { first_name: 'Ok' })).status, 200);
  // change the role: effect is immediate for the already-logged-in user
  await call(admin, 'PUT', `/api/roles/${r.id}`, { name: 'Temp role', permissions: { contacts: { view: 'all' } } });
  assert.equal((await call(u.ck, 'POST', '/api/contacts', { first_name: 'Nope' })).status, 403, 'permission change applies to live sessions');
  assert.equal((await call(admin, 'DELETE', `/api/roles/${r.id}`)).status, 400, 'role in use'); assert.match((await call(admin, 'DELETE', `/api/roles/${r.id}`)).body.error, /1 user still has/);
  const dup = (await call(admin, 'POST', `/api/roles/${r.id}/duplicate`)).body; assert.equal(dup.name, 'Temp role (copy)'); assert.equal(dup.is_system, false); assert.equal((await call(admin, 'DELETE', `/api/roles/${dup.id}`)).status, 200);
  // editing a system role (manager) is allowed and persists
  const mgr = roles.roles.find((x) => x.name === 'manager'); const edited = (await call(admin, 'PUT', `/api/roles/${mgr.id}`, { name: 'ignored', permissions: { ...mgr.permissions, invoices: { ...mgr.permissions.invoices, issue: false } } })).body;
  assert.equal(edited.name, 'manager', 'system role names are fixed'); assert.equal((await call(manager, 'POST', '/api/invoices/1/issue')).status, 403);
  await call(admin, 'PUT', `/api/roles/${mgr.id}`, { permissions: mgr.permissions }); assert.notEqual((await call(manager, 'POST', '/api/invoices/99999/issue')).status, 403, 'restored');
  assert.ok((await call(admin, 'GET', '/api/audit')).body.some((a) => a.entity === 'roles' && a.action === 'create'));
});

test('users: role assignment, last-admin and self protection, deactivation', async () => {
  const role = await makeRole('Plain', { contacts: { view: 'all' } });
  const list = (await call(admin, 'GET', '/api/users')).body; const me = list.find((x) => x.email === 'admin@ovantaa.com');
  assert.equal(me.role, 'admin'); assert.equal(me.role_label, 'Administrator'); assert.ok(me.role_id);
  assert.equal((await call(admin, 'PUT', `/api/users/${me.id}`, { role_id: role.id })).status, 400, 'cannot change own role');
  assert.equal((await call(admin, 'PUT', `/api/users/${me.id}`, { active: false })).status, 400);
  assert.equal((await call(admin, 'POST', '/api/users', { name: 'X', email: 'x@bad.example', password: PW, role_id: 99999 })).status, 400);
  assert.equal((await call(admin, 'POST', '/api/users', { name: 'Legacy', email: 'legacy@perm.example', password: PW, role: 'manager' })).body.role, 'manager', 'role names still work');
  // promote a second admin, then the original can be changed; the last admin cannot be removed
  const adminRole = (await call(admin, 'GET', '/api/roles')).body.roles.find((r) => r.name === 'admin');
  const second = await makeUser(adminRole.id, 'admin2'); assert.equal((await call(second.ck, 'GET', '/api/users')).status, 200);
  assert.equal((await call(second.ck, 'PUT', `/api/users/${me.id}`, { role_id: role.id })).status, 200, 'second admin may demote the first');
  assert.equal((await call(second.ck, 'GET', '/api/users')).status, 200);
  const only = (await call(second.ck, 'GET', '/api/users')).body.find((x) => x.id === second.id);
  assert.equal((await call(second.ck, 'PUT', `/api/users/${only.id}`, { active: false })).status, 400, 'cannot deactivate yourself');
  admin = (await loginAs('admin@ovantaa.com')).ck; // the first admin is now a "Plain" user
  assert.equal((await call(admin, 'GET', '/api/users')).status, 403);
  await call(second.ck, 'PUT', `/api/users/${me.id}`, { role_id: adminRole.id }); admin = (await loginAs('admin@ovantaa.com')).ck; assert.equal((await call(admin, 'GET', '/api/users')).status, 200);
  const victim = (await call(admin, 'GET', '/api/users')).body.find((x) => x.email.startsWith('legacy')); await call(admin, 'PUT', `/api/users/${victim.id}`, { active: false });
  assert.equal((await loginAs('legacy@perm.example', PW)).status, 401, 'deactivated users cannot log in');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE role_id IS NULL').get().n, 0, 'every user has a role row');
});
