import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'test-secret';
process.env.SEND_DELAY_MS = '1';
process.env.BASE_URL = 'http://crm.test';
const { server } = await import('../server/index.js');
const { seedIfEmpty } = await import('../server/seed.js');
const { signUrl } = await import('../server/campaigns.js');

let base, cookie = '';
before(async () => { seedIfEmpty(); await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; });
after(() => server.close());

async function api(method, path, body, opts = {}) {
  const r = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(opts.nocookie ? {} : { cookie }) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc && path.includes('login')) cookie = sc.split(';')[0];
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j, headers: r.headers };
}
const login = (email = 'admin@ovantaa.com', password = 'Ovantaa@123') => api('POST', '/api/auth/login', { email, password }, { nocookie: true });

test('rejects unauthenticated and bad logins', async () => {
  assert.equal((await api('GET', '/api/contacts', null, { nocookie: true })).status, 401);
  assert.equal((await login('admin@ovantaa.com', 'wrong')).status, 401);
  assert.equal((await login()).status, 200);
  assert.equal((await api('GET', '/api/auth/me')).body.user.role, 'admin');
});

test('contacts CRUD, validation, search, uniqueness', async () => {
  const bad = await api('POST', '/api/contacts', { first_name: 'X', email: 'nope' });
  assert.equal(bad.status, 400);
  const c = await api('POST', '/api/contacts', { first_name: 'Test', last_name: 'Person', email: 'Test.Person@Example.com', status: 'lead', tags: 'a, b' });
  assert.equal(c.status, 200); assert.equal(c.body.email, 'test.person@example.com');
  assert.equal((await api('POST', '/api/contacts', { first_name: 'Dup', email: 'test.person@example.com' })).status, 409);
  const s = await api('GET', '/api/contacts?q=Test%20Person'); assert.equal(s.body.total, 1);
  const u = await api('PUT', `/api/contacts/${c.body.id}`, { status: 'customer' }); assert.equal(u.body.status, 'customer');
  assert.equal((await api('PUT', `/api/contacts/${c.body.id}`, { status: 'bogus' })).status, 400);
  assert.equal((await api('DELETE', `/api/contacts/${c.body.id}`)).status, 200);
  assert.equal((await api('GET', `/api/contacts/${c.body.id}`)).status, 404);
});

test('SQL injection attempts in filters/sort are inert', async () => {
  const r = await api('GET', "/api/contacts?sort=name;DROP TABLE contacts&q=' OR 1=1 --&status=lead' OR '1'='1");
  assert.equal(r.status, 200); assert.equal(r.body.total, 0);
  assert.ok((await api('GET', '/api/contacts')).body.total > 50);
});

test('deal stage change updates probability and closed_at', async () => {
  const d = await api('POST', '/api/deals', { name: 'T deal', amount: 5000 });
  assert.equal(d.body.stage, 'prospecting');
  const w = await api('POST', `/api/deals/${d.body.id}/stage`, { stage: 'won' });
  assert.equal(w.body.probability, 100); assert.ok(w.body.closed_at);
  const o = await api('POST', `/api/deals/${d.body.id}/stage`, { stage: 'proposal' });
  assert.equal(o.body.probability, 50); assert.equal(o.body.closed_at, null);
});

test('import upserts by email and creates companies', async () => {
  const r = await api('POST', '/api/contacts/import', { rows: [
    { first_name: 'Imp', last_name: 'One', email: 'imp1@newco.example', company: 'NewCo' },
    { first_name: 'Imp', last_name: 'Two', email: 'imp1@newco.example', title: 'CTO' },
    { first_name: '', email: '' }, { first_name: 'Bad', email: 'bad-email' }] });
  assert.equal(r.body.created, 1); assert.equal(r.body.updated, 1); assert.equal(r.body.skipped, 2);
  const csv = await api('GET', '/api/contacts/export.csv?q=imp1');
  assert.match(csv.body, /imp1@newco.example/);
});

test('segment resolves only subscribed contacts and rejects bad fields', async () => {
  const p = await api('POST', '/api/segments/preview', { filter: { match: 'all', rules: [{ field: 'status', op: 'is', value: 'customer' }] } });
  assert.ok(p.body.emailable > 0 && p.body.emailable <= p.body.matching);
  assert.equal((await api('POST', '/api/segments/preview', { filter: { rules: [{ field: 'password_hash', op: 'is', value: 'x' }] } })).status, 400);
});

test('campaign lifecycle: launch, tracking, signed redirect, unsubscribe', async () => {
  const seg = await api('POST', '/api/segments', { name: 'Test seg', filter: { match: 'all', rules: [{ field: 'tags', op: 'is', value: 'vip' }] } });
  const c = await api('POST', '/api/campaigns', { name: 'T camp', subject: 'Hi {{first_name|there}}', body_html: '<p>Hello {{first_name}}</p><a href="https://example.org/x?a=1&b=2">go</a>', segment_id: seg.body.id });
  assert.equal(c.status, 200);
  const prev = await api('POST', '/api/campaigns/preview', { subject: 'S {{first_name}}', body_html: '<p>{{first_name}} {{company}}</p><script>x</script>' });
  assert.match(prev.body.html, /Alex/);
  const noSeg = await api('POST', '/api/campaigns', { name: 'No seg', subject: 's', body_html: 'b' });
  assert.equal((await api('POST', `/api/campaigns/${noSeg.body.id}/launch`)).status, 400);
  const L = await api('POST', `/api/campaigns/${c.body.id}/launch`);
  assert.equal(L.status, 200); assert.ok(L.body.recipients > 0);
  for (let i = 0; i < 50; i++) { const s = await api('GET', `/api/campaigns/${c.body.id}`); if (s.body.status === 'sent') break; await new Promise((r) => setTimeout(r, 50)); }
  const done = await api('GET', `/api/campaigns/${c.body.id}`);
  assert.equal(done.body.status, 'sent'); assert.equal(done.body.stats.sent, L.body.recipients);
  assert.equal((await api('PUT', `/api/campaigns/${c.body.id}`, { name: 'x' })).status, 400, 'sent campaigns are immutable');
  assert.equal((await api('POST', `/api/campaigns/${c.body.id}/launch`)).status, 400, 'no double launch');

  const rec = (await api('GET', `/api/campaigns/${c.body.id}/recipients`)).body[0];
  const { db } = await import('../server/db.js');
  const token = db.prepare('SELECT token FROM campaign_recipients WHERE id=?').get(rec.id).token;
  const px = await fetch(`${base}/t/o/${token}.gif`); assert.equal(px.headers.get('content-type'), 'image/gif');
  const url = 'https://example.org/x?a=1&b=2';
  const ok = await fetch(`${base}/t/c/${token}?u=${encodeURIComponent(url)}&s=${signUrl(token, url)}`, { redirect: 'manual' });
  assert.equal(ok.status, 302); assert.equal(ok.headers.get('location'), url);
  const evil = await fetch(`${base}/t/c/${token}?u=${encodeURIComponent('https://evil.test')}&s=${signUrl(token, url)}`, { redirect: 'manual' });
  assert.equal(evil.status, 400, 'unsigned redirect refused');
  const un = await fetch(`${base}/u/${token}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
  assert.equal(un.status, 200);
  const st = (await api('GET', `/api/campaigns/${c.body.id}`)).body.stats;
  assert.equal(st.opened, 1); assert.equal(st.clicked, 1); assert.equal(st.unsubscribed, 1);
  assert.equal(db.prepare('SELECT subscribed FROM contacts WHERE id=?').get(rec.contact_id).subscribed, 0);
});

test('role permissions: rep cannot launch campaigns or manage users', async () => {
  const rep = await api('POST', '/api/auth/login', { email: 'liam@ovantaa.com', password: 'Ovantaa@123' }, { nocookie: true });
  assert.equal(rep.status, 200);
  assert.equal((await api('GET', '/api/users')).status, 403);
  assert.equal((await api('POST', '/api/campaigns/1/launch')).status, 403);
  await login();
});

test('dashboard returns expected shape', async () => {
  const d = (await api('GET', '/api/dashboard')).body;
  assert.ok(d.kpis.contacts > 0 && d.pipeline.length === 6 && d.revenueByMonth.length === 6);
});

test('static app and security headers served', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200); assert.equal(r.headers.get('x-frame-options'), 'DENY');
});
