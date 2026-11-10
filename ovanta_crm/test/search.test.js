import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

// fake Claude API: returns whatever plan the test queued, and records what it was sent
let nextPlan = null; const seen = [];
const fake = http.createServer((q, r) => { let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => {
  const body = JSON.parse(b); seen.push(body);
  r.writeHead(200, { 'content-type': 'application/json' });
  r.end(JSON.stringify({ model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(nextPlan) }] }));
}); });
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srch-'));
Object.assign(process.env, { SEED_BILLING_DEMO: '0', DB_PATH: ':memory:', SESSION_SECRET: 'srch', FILES_DIR: path.join(tmp, 'files'), ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${fake.address().port}`, BASE_URL: 'https://crm.example.com' });
const { server } = await import('../server/index.js');
const { seedIfEmpty } = await import('../server/seed.js');
let base, admin;
before(async () => { seedIfEmpty(); await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; admin = await login('admin@ovantaa.com'); });
after(() => { server.close(); fake.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
async function call(ck, method, p, body) {
  const r = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie: ck || '' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j, headers: r.headers };
}
async function login(email) { return (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Ovantaa@123' }) })).headers.get('set-cookie').split(';')[0]; }
const fd = (files) => { const f = new FormData(); for (const [name, content, type] of files) f.append('file', new Blob([content], { type: type || 'text/plain' }), name); return f; };
const upload = (ck, q, form) => fetch(`${base}/api/files?${q}`, { method: 'POST', headers: { cookie: ck }, body: form });
const Q = (entity, extra = {}) => ({ entity, text: '', filters: [], sort_field: '', sort_dir: 'desc', limit: 25, ...extra });
const F = (field, op, value = '', extra = {}) => ({ field, op, value, value2: '', values: [], ...extra });

let deal;
test('deal stage folders: several files at once, stored under deals/<id>/<stage>/, movable between folders', async () => {
  deal = (await call(admin, 'POST', '/api/deals', { name: 'Folder deal', amount: 90000, stage: 'proposal' })).body;
  const r = await upload(admin, `entity=deals&id=${deal.id}&stage=proposal`, fd([['Proposal v1.pdf', '%PDF-1.4 fake', 'application/pdf'], ['Pricing.csv', 'item,price\nA,10\n', 'text/csv'], ['tool.exe', 'MZ']]));
  assert.equal(r.status, 200); const j = await r.json();
  assert.equal(j.files.length, 2); assert.equal(j.errors.length, 1); assert.match(j.errors[0].error, /not allowed/);
  assert.ok(j.files.every((f) => f.stage === 'proposal' && f.folder === `deals/${deal.id}/proposal`));
  const onDisk = fs.readdirSync(path.join(process.env.FILES_DIR, 'deals', String(deal.id), 'proposal')); assert.equal(onDisk.length, 2); assert.ok(onDisk.some((n) => n.endsWith('Proposal v1.pdf')));
  assert.equal((await upload(admin, `entity=deals&id=${deal.id}&stage=nope`, fd([['a.txt', 'x']]))).status, 400);
  assert.equal((await upload(admin, `entity=contacts&id=1&stage=proposal`, fd([['a.txt', 'x']]))).status, 400, 'stage folders only on deals');
  const g = await (await upload(admin, `entity=deals&id=${deal.id}`, fd([['notes.txt', 'general notes']]))).json(); assert.equal(g.files[0].stage, null); assert.equal(g.files[0].folder, `deals/${deal.id}/general`);
  const mv = await call(admin, 'PUT', `/api/files/${g.files[0].id}`, { stage: 'negotiation' }); assert.equal(mv.status, 200); assert.equal(mv.body.stage, 'negotiation');
  assert.ok(fs.existsSync(path.join(process.env.FILES_DIR, 'deals', String(deal.id), 'negotiation'))); assert.equal((await fetch(`${base}/api/files/${g.files[0].id}/view`, { headers: { cookie: admin } }).then((x) => x.text())), 'general notes', 'still readable after the move');
  const list = (await call(admin, 'GET', `/api/files?entity=deals&id=${deal.id}`)).body; assert.equal(list.length, 3);
});

test('viewer: inline for PDF/images/text, text-like (HTML/SVG) shown as plain text, downloads stay attachments', async () => {
  const files = (await call(admin, 'GET', `/api/files?entity=deals&id=${deal.id}`)).body; const pdf = files.find((f) => f.name.endsWith('.pdf')), csv = files.find((f) => f.name.endsWith('.csv'));
  const v = await fetch(`${base}/api/files/${pdf.id}/view`, { headers: { cookie: admin } }); assert.equal(v.headers.get('content-type'), 'application/pdf'); assert.match(v.headers.get('content-disposition'), /^inline/); assert.match(v.headers.get('content-security-policy'), /default-src 'none'/); 
  const c = await fetch(`${base}/api/files/${csv.id}/view`, { headers: { cookie: admin } }); assert.match(c.headers.get('content-type'), /^text\/plain/);
  const h = (await (await upload(admin, `entity=deals&id=${deal.id}`, fd([['page.html', '<script>alert(1)</script>', 'text/html']]))).json()).files[0];
  const hv = await fetch(`${base}/api/files/${h.id}/view`, { headers: { cookie: admin } }); assert.match(hv.headers.get('content-type'), /^text\/plain/, 'HTML is never rendered'); assert.match(hv.headers.get('content-security-policy'), /sandbox/);
  const dl = await fetch(`${base}/api/files/${pdf.id}/download`, { headers: { cookie: admin } }); assert.match(dl.headers.get('content-disposition'), /^attachment/); assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
});

test('temporary public link: works without login for an hour, tamper-proof, audited', async () => {
  const pdf = (await call(admin, 'GET', `/api/files?entity=deals&id=${deal.id}`)).body.find((f) => f.name.endsWith('.pdf'));
  const l = await call(admin, 'POST', `/api/files/${pdf.id}/link`); assert.equal(l.status, 200); assert.ok(l.body.url.startsWith('https://crm.example.com/f/'));
  const local = l.body.url.replace('https://crm.example.com', base);
  const r = await fetch(local); assert.equal(r.status, 200); assert.equal(await r.text(), '%PDF-1.4 fake');
  assert.equal((await fetch(local.replace(/\/f\/(\d+)\//, (m, id) => `/f/${Number(id) + 1}/`))).status, 404, 'signature is bound to the file');
  const parts = local.split('/'); parts[5] = String(Number(parts[5]) + 99); assert.equal((await fetch(parts.join('/'))).status, 404, 'expiry cannot be extended');
  const old = `${base}/f/${pdf.id}/1000/${'a'.repeat(32)}/x`; assert.equal((await fetch(old)).status, 404);
  assert.ok((await call(admin, 'GET', '/api/audit')).body.some((a) => a.action === 'share_file_link'));
});

test('AI search: Claude gets field names (not data) and a json_schema; the plan is run with whitelisted, parameterised SQL', async () => {
  await call(admin, 'POST', '/api/deals', { name: 'Big Acme expansion', amount: 250000, stage: 'negotiation' });
  nextPlan = { explanation: 'Open deals over $100k', queries: [Q('deals', { filters: [F('amount', 'gt', '100000'), F('stage', 'in', '', { values: ['prospecting', 'qualification', 'proposal', 'Negotiation'] })], sort_field: 'amount', sort_dir: 'desc' })] };
  const r = await call(admin, 'POST', '/api/search/ai', { q: 'open deals bigger than 100k' }); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'ai'); const rows = r.body.groups[0].rows; assert.ok(rows.length >= 1 && rows.some((x) => x.title === 'Big Acme expansion'));
  assert.ok(rows.every((x) => !/Closed/.test(x.subtitle))); assert.ok(r.body.groups[0].filters.length === 2);
  const sent = seen.at(-1); assert.equal(sent.output_config.format.type, 'json_schema'); assert.match(sent.system, /amount: number/); assert.match(sent.messages[0].content, /Today is \d{4}-\d{2}-\d{2}/);
  assert.ok(!JSON.stringify(sent).includes('Big Acme expansion'), 'record data is never sent to Claude');
  // files by stage folder + kind
  nextPlan = { explanation: 'PDFs in proposal folders', queries: [Q('files', { filters: [F('stage', 'eq', 'proposal'), F('kind', 'eq', 'pdf')] })] };
  const fr = (await call(admin, 'POST', '/api/search/ai', { q: 'proposal pdfs' })).body; assert.equal(fr.groups[0].rows.length, 1); assert.equal(fr.groups[0].rows[0].file.name, 'Proposal v1.pdf');
  // several kinds at once + custom fields are searchable
  await call(admin, 'POST', '/api/customization/fields', { entity: 'deals', label: 'Deal type', type: 'dropdown', options: ['Direct', 'Partner'] });
  await call(admin, 'POST', '/api/deals', { name: 'Partner thing', custom: { cf_deal_type: 'Partner' } });
  nextPlan = { explanation: 'x', queries: [Q('deals', { filters: [F('cf_deal_type', 'eq', 'partner')] }), Q('contacts', { text: 'zzzz-nothing' })] };
  const m = (await call(admin, 'POST', '/api/search/ai', { q: 'partner deals' })).body; assert.equal(m.groups.length, 2); assert.deepEqual(m.groups[0].rows.map((x) => x.title), ['Partner thing']); assert.equal(m.groups[1].rows.length, 0);
  assert.match(seen.at(-1).system, /cf_deal_type \("Deal type", custom\): enum \[Direct \| Partner\]/);
});

test('AI search is safe: unknown fields/ops/injection ignored with a warning, permissions and own scope respected', async () => {
  nextPlan = { explanation: 'x', queries: [Q('deals', { filters: [F("name'; DROP TABLE deals; --", 'eq', 'x'), F('amount', 'gt', "1 OR 1=1"), F('name', 'contains', "%' OR '1'='1")], sort_field: 'amount; DROP TABLE users', limit: 100000 })] };
  const r = (await call(admin, 'POST', '/api/search/ai', { q: 'tricky' })).body;
  assert.equal(r.warnings.length, 2); assert.equal(r.groups[0].rows.length, 0, 'the literal text is searched, nothing injected');
  assert.ok((await call(admin, 'GET', '/api/deals?limit=1')).body.total > 0, 'tables intact');
  // a role without campaigns + own-scope deals
  const role = (await call(admin, 'POST', '/api/roles', { name: 'Own deals only', permissions: { deals: { view: 'own', create: true, edit: 'own' } } })).body;
  await call(admin, 'POST', '/api/users', { name: 'Scoped', email: 'scoped@s.example', password: 'Ovantaa@123', role_id: role.id }); const me = await login('scoped@s.example');
  await call(me, 'POST', '/api/deals', { name: 'My own little deal' });
  nextPlan = { explanation: 'x', queries: [Q('deals'), Q('campaigns'), Q('files')] };
  const s = (await call(me, 'POST', '/api/search/ai', { q: 'everything' })).body;
  assert.deepEqual(s.groups.map((g) => g.entity), ['deals']); assert.deepEqual(s.groups[0].rows.map((x) => x.title), ['My own little deal']);
  assert.ok(!/campaigns:/.test(seen.at(-1).system), 'kinds the user cannot see are not even offered to Claude');
});

test('keyword fallback when AI is off or fails; empty query rejected', async () => {
  const k = (await call(admin, 'POST', '/api/search/ai', { q: 'Acme', mode: 'keyword' })).body; assert.equal(k.mode, 'keyword'); assert.ok(k.groups.some((g) => g.entity === 'deals' && g.rows.some((x) => x.title === 'Big Acme expansion')));
  nextPlan = 'not json at all';
  const f = (await call(admin, 'POST', '/api/search/ai', { q: 'Acme' })).body; assert.equal(f.mode, 'keyword'); assert.match(f.notice, /unavailable/);
  assert.equal((await call(admin, 'POST', '/api/search/ai', { q: '  ' })).status, 400);
  assert.ok((await call(admin, 'GET', '/api/search/fields')).body.entities.some((e) => e.entity === 'files'));
});
