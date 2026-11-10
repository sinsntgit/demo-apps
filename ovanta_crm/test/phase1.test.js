import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-'));
process.env.SEED_BILLING_DEMO = '0'; process.env.DB_PATH = ':memory:'; process.env.SESSION_SECRET = 'p1-secret'; process.env.FILES_DIR = path.join(tmp, 'files'); process.env.MAX_UPLOAD_MB = '1';
const { server } = await import('../server/index.js');
const { seedIfEmpty } = await import('../server/seed.js');
const { totpAt, verifyTotp, base32Decode, base32Encode } = await import('../server/totp.js');

let base;
before(async () => { seedIfEmpty(); await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; });
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
async function call(ck, method, p, body) {
  const r = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie: ck || '' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j, headers: r.headers };
}
const rawLogin = (email, password = 'Ovantaa@123') => fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
const login = async (email) => (await rawLogin(email)).headers.get('set-cookie').split(';')[0];
let seq = 0;
/** A user on a custom role that can only see/edit its own records. */
async function ownScopeUser(admin) {
  const role = (await call(admin, 'POST', '/api/roles', { name: 'Own only ' + (++seq), permissions: { contacts: { view: 'own', create: true, edit: 'own', delete: 'own' }, deals: { view: 'own', create: true, edit: 'own', delete: 'own' }, accounts: { view: 'own' }, attachments: { view: true, upload: true, delete: true } } })).body;
  const email = `own${seq}@p1.example`; assert.equal((await call(admin, 'POST', '/api/users', { name: 'Own', email, password: 'Ovantaa@123', role_id: role.id })).status, 200);
  return login(email);
}
const code = (secret, off = 0) => totpAt(base32Decode(secret), Math.floor(Date.now() / 30000) + off);

test('TOTP matches the RFC 6238 test vectors and refuses replays', () => {
  const secret = Buffer.from('12345678901234567890');
  assert.equal(totpAt(secret, Math.floor(59 / 30)), '287082'); assert.equal(totpAt(secret, Math.floor(1111111109 / 30)), '081804');
  assert.equal(base32Decode(base32Encode(secret)).toString(), secret.toString());
  const b = base32Encode(secret); const now = 1111111109 * 1000;
  const step = verifyTotp(b, '081804', { now }); assert.equal(step, Math.floor(1111111109 / 30));
  assert.equal(verifyTotp(b, '081804', { now, lastStep: step }), null, 'a used code cannot be used again');
  assert.equal(verifyTotp(b, '000000', { now }), null); assert.equal(verifyTotp(b, 'abc', { now }), null);
});

test('two-factor: set up, sign in with a code, replay blocked, recovery code works once, sessions revocable', async () => {
  const ck = await login('maya@ovantaa.com');
  assert.equal((await call(ck, 'GET', '/api/2fa/status')).body.enabled, false);
  const s = (await call(ck, 'POST', '/api/2fa/setup')).body; assert.match(s.secret, /^[A-Z2-7]{32}$/); assert.match(s.url, /^otpauth:\/\/totp\//);
  assert.equal((await call(ck, 'POST', '/api/2fa/enable', { code: '000000' })).status, 400);
  const en = await call(ck, 'POST', '/api/2fa/enable', { code: code(s.secret) }); assert.equal(en.status, 200); assert.equal(en.body.recovery_codes.length, 10);
  // password alone no longer signs in
  const l = await (await rawLogin('maya@ovantaa.com')).json(); assert.equal(l.needs_2fa, true); assert.ok(l.challenge); assert.equal(l.user, undefined);
  assert.equal((await call(null, 'POST', '/api/auth/2fa', { challenge: l.challenge, code: '123456' })).status, 401);
  // the code used to enable it is already spent -> replay rejected; next step is accepted
  assert.equal((await call(null, 'POST', '/api/auth/2fa', { challenge: l.challenge, code: code(s.secret) })).status, 401, 'same time-step code cannot be reused');
  const ok = await call(null, 'POST', '/api/auth/2fa', { challenge: l.challenge, code: code(s.secret, 1) }); assert.equal(ok.status, 200); assert.equal(ok.body.user.twofa_enabled, true);
  const ck2 = ok.headers.get('set-cookie').split(';')[0]; assert.equal((await call(ck2, 'GET', '/api/auth/me')).status, 200);
  assert.equal((await call(null, 'POST', '/api/auth/2fa', { challenge: 'forged.token', code: code(s.secret, 1) })).status, 401);
  // recovery codes: single use
  const l2 = await (await rawLogin('maya@ovantaa.com')).json(); const rc = en.body.recovery_codes[0];
  const r1 = await call(null, 'POST', '/api/auth/2fa', { challenge: l2.challenge, recovery_code: rc.toUpperCase() }); assert.equal(r1.status, 200);
  assert.equal((await call(null, 'POST', '/api/auth/2fa', { challenge: l2.challenge, recovery_code: rc })).status, 401, 'recovery code is single-use');
  assert.equal((await call(ck2, 'GET', '/api/2fa/status')).body.recovery_left, 9);
  // sessions: list + revoke + logout kills the server-side session
  const ck3 = r1.headers.get('set-cookie').split(';')[0];
  const list = (await call(ck3, 'GET', '/api/sessions')).body; assert.ok(list.length >= 2 && list.some((x) => x.current));
  const other = list.find((x) => !x.current); assert.equal((await call(ck3, 'DELETE', `/api/sessions/${other.id}`)).status, 200);
  assert.equal((await call(ck3, 'POST', '/api/sessions/revoke-others')).status, 200); assert.equal((await call(ck2, 'GET', '/api/auth/me')).status, 401, 'revoked session stops working immediately');
  await call(ck3, 'POST', '/api/auth/logout'); assert.equal((await call(ck3, 'GET', '/api/auth/me')).status, 401, 'logout revokes server-side, not just the cookie');
  // disable needs the password
  const l3 = await (await rawLogin('maya@ovantaa.com')).json(); const ck4 = (await call(null, 'POST', '/api/auth/2fa', { challenge: l3.challenge, recovery_code: en.body.recovery_codes[1] })).headers.get('set-cookie').split(';')[0];
  assert.equal((await call(ck4, 'POST', '/api/2fa/disable', { password: 'wrong' })).status, 400);
  assert.equal((await call(ck4, 'POST', '/api/2fa/disable', { password: 'Ovantaa@123' })).status, 200);
  assert.equal((await rawLogin('maya@ovantaa.com')).status, 200); assert.equal((await (await rawLogin('maya@ovantaa.com')).json()).needs_2fa, undefined);
});

test('company policy: required 2FA forces set-up (limited session), admin can reset a locked-out user', async () => {
  const admin = await login('admin@ovantaa.com');
  assert.equal((await call(await login('liam@ovantaa.com'), 'PUT', '/api/settings/security', { require_2fa: 'all' })).status, 403);
  assert.equal((await call(admin, 'PUT', '/api/settings/security', { require_2fa: 'bogus' })).status, 400);
  assert.equal((await call(admin, 'PUT', '/api/settings/security', { require_2fa: 'all' })).status, 200);
  const r = await rawLogin('liam@ovantaa.com'); const j = await r.json(); assert.equal(j.limited, true); const ck = r.headers.get('set-cookie').split(';')[0];
  const blocked = await call(ck, 'GET', '/api/contacts'); assert.equal(blocked.status, 403); assert.equal(blocked.body.need_2fa_setup, true);
  assert.equal((await call(ck, 'GET', '/api/auth/me')).body.user.limited, true);
  const s = (await call(ck, 'POST', '/api/2fa/setup')).body; assert.equal((await call(ck, 'POST', '/api/2fa/enable', { code: code(s.secret) })).status, 200);
  assert.equal((await call(ck, 'GET', '/api/contacts')).status, 200, 'finishing set-up lifts the restriction');
  assert.equal((await call(ck, 'POST', '/api/2fa/disable', { password: 'Ovantaa@123' })).status, 400, 'cannot turn it off while required');
  // lost device: admin resets, user is signed out everywhere and must set up again
  const liam = (await call(admin, 'GET', '/api/users')).body.find((u) => u.email === 'liam@ovantaa.com');
  assert.equal((await call(admin, 'POST', `/api/users/${liam.id}/reset-2fa`)).status, 200); assert.equal((await call(ck, 'GET', '/api/auth/me')).status, 401);
  assert.equal((await (await rawLogin('liam@ovantaa.com')).json()).limited, true);
  await call(admin, 'PUT', '/api/settings/security', { require_2fa: 'off' });
});

test('lead conversion: account + deal created together, link kept, cannot convert twice, rep scope respected', async () => {
  const admin = await login('admin@ovantaa.com');
  const c = (await call(admin, 'POST', '/api/contacts', { first_name: 'Lena', last_name: 'Park', email: 'lena@acme-widgets.com', status: 'lead' })).body;
  await call(admin, 'POST', '/api/accounts', { name: 'Acme Widgets', website: 'https://www.acme-widgets.com' });
  const pv = (await call(admin, 'GET', `/api/contacts/${c.id}/convert-preview`)).body; assert.equal(pv.suggested_accounts[0].name, 'Acme Widgets');
  assert.equal((await call(admin, 'POST', `/api/contacts/${c.id}/convert`, { account: { mode: 'new', name: '' }, deal: {} })).status, 400);
  const r = await call(admin, 'POST', `/api/contacts/${c.id}/convert`, { account: { mode: 'new', name: 'Park Holdings' }, deal: { create: true, name: 'Park rollout', amount: 5000 }, status: 'qualified' });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.contact.status, 'qualified'); assert.ok(r.body.deal_id && r.body.contact.account_name === 'Park Holdings'); assert.equal(r.body.contact.converted_deal_id, r.body.deal_id);
  const deal = (await call(admin, 'GET', `/api/deals/${r.body.deal_id}`)).body; assert.equal(deal.contact_id, c.id); assert.equal(deal.account_id, r.body.account_id);
  assert.equal((await call(admin, 'POST', `/api/contacts/${c.id}/convert`, { account: { mode: 'none' } })).status, 400, 'already converted');
  // all or nothing: a bad deal stage rolls back the new account
  const c2 = (await call(admin, 'POST', '/api/contacts', { first_name: 'Zed', email: 'zed@zz.io' })).body; const before = (await call(admin, 'GET', '/api/accounts?limit=500')).body.total;
  assert.equal((await call(admin, 'POST', `/api/contacts/${c2.id}/convert`, { account: { mode: 'new', name: 'ZZ' }, deal: { create: true, name: 'x', stage: 'nope' } })).status, 400);
  assert.equal((await call(admin, 'GET', '/api/accounts?limit=500')).body.total, before);
  const rep = await ownScopeUser(admin); assert.equal((await call(rep, 'GET', `/api/contacts/${c2.id}/convert-preview`)).status, 404, 'cannot touch a contact outside own scope');
});

test('duplicates and merge: records re-linked, fields filled, tags united, lookups re-pointed', async () => {
  const admin = await login('admin@ovantaa.com');
  const a = (await call(admin, 'POST', '/api/contacts', { first_name: 'Dup', last_name: 'Person', email: 'dup1@x.io', tags: 'a, b' })).body;
  const b = (await call(admin, 'POST', '/api/contacts', { first_name: 'Dup', last_name: 'Person', phone: '+966500000000', tags: 'b, c', email: null })).body;
  const d = (await call(admin, 'POST', '/api/deals', { name: 'Dup deal', contact_id: b.id })).body;
  await call(admin, 'POST', '/api/tasks', { title: 'Call dup', contact_id: b.id });
  const groups = (await call(admin, 'GET', '/api/duplicates/contacts')).body; assert.ok(groups.some((g) => g.rows.some((r) => r.id === a.id) && g.rows.some((r) => r.id === b.id)));
  assert.equal((await call(admin, 'POST', `/api/contacts/${b.id}/merge`, { into: b.id })).status, 400);
  const m = await call(admin, 'POST', `/api/contacts/${b.id}/merge`, { into: a.id }); assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.phone, '+966500000000'); assert.equal(m.body.email, 'dup1@x.io'); assert.deepEqual(m.body.tags.split(', ').sort(), ['a', 'b', 'c']);
  assert.equal((await call(admin, 'GET', `/api/deals/${d.id}`)).body.contact_id, a.id); assert.equal((await call(admin, 'GET', `/api/contacts/${b.id}`)).status, 404);
  assert.equal((await call(admin, 'GET', `/api/tasks?contact_id=${a.id}`)).body.rows.length, 1);
  assert.equal((await call(await login('liam@ovantaa.com'), 'POST', `/api/contacts/${a.id}/merge`, { into: 1 })).status, 403, 'reps do not hold the merge permission');
  const a1 = (await call(admin, 'POST', '/api/accounts', { name: 'Twin Co' })).body, a2 = (await call(admin, 'POST', '/api/accounts', { name: 'twin co ', vat_number: '300000000000003' })).body;
  assert.ok((await call(admin, 'GET', '/api/duplicates/accounts')).body.some((g) => g.rows.length === 2));
  const ma = await call(admin, 'POST', `/api/accounts/${a2.id}/merge`, { into: a1.id }); assert.equal(ma.status, 200); assert.equal(ma.body.vat_number, '300000000000003');
});

function form(name, content, filename, type = 'text/plain', extra = {}) {
  const fd = new FormData(); for (const [k, v] of Object.entries(extra)) fd.append(k, v); fd.append('file', new Blob([content], { type }), filename); return fd;
}
const upload = (ck, entity, id, fd) => fetch(`${base}/api/files?entity=${entity}&id=${id}`, { method: 'POST', headers: { cookie: ck }, body: fd });

test('attachments: upload, list, download safely, size/type limits, scope, cleanup on delete', async () => {
  const admin = await login('admin@ovantaa.com'), rep = await ownScopeUser(admin);
  const mine = (await call(rep, 'POST', '/api/deals', { name: 'Rep deal' })).body; const others = (await call(admin, 'POST', '/api/deals', { name: 'Admin deal', owner_id: 1 })).body;
  const up = await upload(rep, 'deals', mine.id, form('f', 'hello contract', 'Contract v1.txt', 'text/plain', { note: 'signed copy' })); assert.equal(up.status, 200); const f = await up.json();
  assert.equal(f.name, 'Contract v1.txt'); assert.equal(f.size, 14); assert.equal(f.sha256.length, 64);
  assert.equal((await call(rep, 'GET', `/api/files?entity=deals&id=${mine.id}`)).body.length, 1);
  const dl = await fetch(`${base}/api/files/${f.id}/download`, { headers: { cookie: rep } }); assert.equal(await dl.text(), 'hello contract'); assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
  const html = await (await upload(admin, 'deals', mine.id, form('f', '<script>alert(1)</script>', 'x.html', 'text/html'))).json();
  const hd = await fetch(`${base}/api/files/${html.id}/download`, { headers: { cookie: admin } }); assert.match(hd.headers.get('content-disposition'), /^attachment/); assert.equal(hd.headers.get('content-type'), 'application/octet-stream');
  assert.equal((await upload(admin, 'deals', mine.id, form('f', 'MZ', 'setup.exe', 'application/octet-stream'))).status, 400);
  assert.equal((await upload(admin, 'deals', mine.id, form('f', Buffer.alloc(1.5 * 1024 * 1024, 1), 'big.bin', 'application/octet-stream'))).status, 413);
  assert.equal((await upload(admin, 'deals', mine.id, form('f', '', 'empty.txt'))).status, 400);
  assert.equal((await upload(admin, 'nothing', 1, form('f', 'x', 'a.txt'))).status, 400);
  assert.equal((await upload(rep, 'deals', others.id, form('f', 'x', 'a.txt'))).status, 404, 'cannot attach to a record you cannot see');
  assert.equal((await call(rep, 'GET', `/api/files?entity=deals&id=${others.id}`)).status, 404);
  assert.equal((await fetch(`${base}/api/files/${f.id}/download`)).status, 401);
  const stored = path.join(process.env.FILES_DIR, (await import('../server/db.js')).get('SELECT path FROM files WHERE id=?', f.id).path); assert.ok(fs.existsSync(stored));
  assert.equal((await call(rep, 'DELETE', `/api/files/${f.id}`)).status, 200); assert.ok(!fs.existsSync(stored)); assert.equal((await fetch(`${base}/api/files/${f.id}/download`, { headers: { cookie: rep } })).status, 404);
  // deleting the record removes its files
  await upload(rep, 'deals', mine.id, form('f', 'bye', 'bye.txt')); assert.equal((await call(rep, 'DELETE', `/api/deals/${mine.id}`)).status, 200);
  assert.equal((await import('../server/db.js')).get('SELECT COUNT(*) n FROM files WHERE entity=? AND record_id=?', 'deals', mine.id).n, 0);
});
