import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
const { SMTPServer } = createRequire(import.meta.url)('smtp-server');

// ---- fake SMTP server (captures mail) and fake Claude API ----
const inbox = []; let rejectAddr = null;
const smtp = new SMTPServer({
  authOptional: false, logger: false,
  onAuth(auth, _s, cb) { const ok = (auth.username === 'santosh@syncsense.in' && auth.password === 'app-pass-1234') || (auth.username === 'titan@syncsense.in' && auth.password === 'P#ss w0rd é$!&"<>'); ok ? cb(null, { user: 1 }) : cb(Object.assign(new Error('authentication failed: '), { responseCode: 535 })); },
  onRcptTo(addr, _s, cb) { if (addr.address === rejectAddr) { const e = new Error('550 mailbox unavailable'); e.responseCode = 550; return cb(e); } cb(); },
  onData(stream, session, cb) { let raw = ''; stream.on('data', (c) => (raw += c)); stream.on('end', () => { inbox.push({ raw, to: session.envelope.rcptTo.map((r) => r.address), from: session.envelope.mailFrom.address }); cb(); }); },
});
const aiCalls = [];
const ai = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    aiCalls.push({ headers: req.headers, body: JSON.parse(b) });
    if (req.headers['x-api-key'] !== 'sk-ant-test-key') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"invalid x-api-key"}}'); }
    const draft = { subject: 'Meet Ovantaa CRM', subject_alternatives: ['A', 'B', 'C'], preheader: 'Pre', body_html: '<p onclick="x()">Hello {{first_name|there}}</p><script>alert(1)</script><a href="javascript:alert(1)">bad</a><a href="https://example.com/go">Go</a>' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Here you go:\n' + JSON.stringify(draft) }] }));
  });
});
await new Promise((r) => smtp.listen(0, '127.0.0.1', r)); await new Promise((r) => ai.listen(0, '127.0.0.1', r));
process.env.DB_PATH = ':memory:'; process.env.SESSION_SECRET = 'feat-secret'; process.env.SEND_DELAY_MS = '1';
process.env.BASE_URL = 'http://crm.test'; process.env.SMTP_TLS_INSECURE = '1';
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${ai.address().port}`;
const { server } = await import('../server/index.js');
const { seedIfEmpty } = await import('../server/seed.js');
const { db } = await import('../server/db.js');
const { processCampaign } = await import('../server/campaigns.js');

let base, cookie = '';
before(async () => { seedIfEmpty(); await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; });
after(() => { server.close(); smtp.close(); ai.close(); });
async function api(method, path, body, { nocookie, ck } = {}) {
  const r = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(nocookie ? {} : { cookie: ck ?? cookie }) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc && path.includes('login') && !ck) cookie = sc.split(';')[0];
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
}
const wait = async (fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 40)); } return null; };
const smtpSender = (extra = {}) => ({ label: 'Santosh (SyncSense)', from_name: 'Santosh T', from_email: 'santosh@syncsense.in', host: '127.0.0.1', port: smtp.server.address().port, secure: false, username: 'santosh@syncsense.in', password: 'app-pass-1234', delay_ms: 0, ...extra });

test('login', async () => { assert.equal((await api('POST', '/api/auth/login', { email: 'admin@ovantaa.com', password: 'Ovantaa@123' }, { nocookie: true })).status, 200); });

test('senders: validation, encrypted password, never returned, verify + test send', async () => {
  assert.equal((await api('POST', '/api/senders', { label: 'x', from_email: 'bad' })).status, 400);
  assert.equal((await api('POST', '/api/senders', { label: 'x', from_email: 'a@b.co', mode: 'smtp' })).status, 400, 'host required');
  const bad = await api('POST', '/api/senders', smtpSender({ password: 'wrong' }));
  const v1 = await api('POST', `/api/senders/${bad.body.id}/verify`);
  assert.equal(v1.body.ok, false); assert.match(v1.body.error, /Authentication failed/);
  const good = await api('POST', '/api/senders', smtpSender({ is_default: true }));
  assert.equal(good.status, 200); assert.equal(good.body.has_password, true); assert.equal(good.body.password, undefined);
  assert.ok(!JSON.stringify((await api('GET', '/api/senders')).body).includes('app-pass-1234'));
  const stored = db.prepare('SELECT password_enc FROM senders WHERE id=?').get(good.body.id).password_enc;
  assert.ok(stored.startsWith('v1:') && !stored.includes('app-pass'));
  assert.equal((await api('POST', `/api/senders/${good.body.id}/verify`)).body.ok, true);
  const t = await api('POST', `/api/senders/${good.body.id}/test`, { to: 'me@example.com' });
  assert.equal(t.status, 200); assert.equal(t.body.simulated, false);
  const m = await wait(() => inbox.find((x) => x.to.includes('me@example.com')));
  assert.ok(m); assert.equal(m.from, 'santosh@syncsense.in'); assert.match(m.raw, /From: "?Santosh T"? <santosh@syncsense.in>/);
  // wrong-password sender reports a readable failure on test send
  const f = await api('POST', `/api/senders/${bad.body.id}/test`, { to: 'x@example.com' });
  assert.equal(f.status, 400); assert.match(f.body.error, /Authentication failed/);
  await api('DELETE', `/api/senders/${bad.body.id}`);
  // multiple senders, single default
  const s2 = await api('POST', '/api/senders', { label: 'Janvi', from_email: 'janvi@syncsense.in', mode: 'simulate', is_default: true });
  const list = (await api('GET', '/api/senders')).body; assert.equal(list.filter((s) => s.is_default).length, 1); assert.equal(list.find((s) => s.is_default).id, s2.body.id);
  await api('PUT', `/api/senders/${good.body.id}`, { ...smtpSender(), is_default: true });
  assert.equal((await api('GET', '/api/senders')).body.find((s) => s.is_default).label, 'Santosh (SyncSense)');
});

test('passwords with spaces/special characters survive storage; pasted outer spaces are trimmed; error names the provider', async () => {
  const t = await api('POST', '/api/senders', smtpSender({ label: 'Titan-like', from_email: 'titan@syncsense.in', username: 'titan@syncsense.in', host: '127.0.0.1', password: '  P#ss w0rd é$!&"<>  ' }));
  assert.equal(t.status, 200);
  assert.equal((await api('POST', `/api/senders/${t.body.id}/verify`)).body.ok, true);
  const bad = await api('PUT', `/api/senders/${t.body.id}`, { ...smtpSender({ label: 'Titan-like', from_email: 'titan@syncsense.in', username: 'titan@syncsense.in' }), password: 'nope' });
  const v = await api('POST', `/api/senders/${bad.body.id}/verify`);
  assert.equal(v.body.ok, false); assert.match(v.body.error, /server was reached but rejected the login/);
  await api('PUT', `/api/senders/${t.body.id}`, { ...smtpSender({ label: 'Titan-like', from_email: 'titan@syncsense.in', username: 'titan@syncsense.in' }), password: '' }); // blank keeps saved ('nope')
  assert.equal((await api('POST', `/api/senders/${t.body.id}/verify`)).body.ok, false, 'blank password keeps the previously saved one');
  await api('DELETE', `/api/senders/${t.body.id}`);
});

test('campaign sends through SMTP sender: headers, tracking, per-recipient failure, statuses', async () => {
  const sender = (await api('GET', '/api/senders')).body.find((s) => s.is_default);
  const seg = await api('POST', '/api/segments', { name: 'vip', filter: { match: 'all', rules: [{ field: 'tags', op: 'is', value: 'vip' }] } });
  const prev = await api('POST', '/api/segments/preview', { filter: { match: 'all', rules: [{ field: 'tags', op: 'is', value: 'vip' }] } });
  assert.ok(prev.body.emailable >= 3);
  rejectAddr = prev.body.sample[0].email; inbox.length = 0;
  const c = await api('POST', '/api/campaigns', { name: 'SMTP camp', subject: 'Hi {{first_name|there}}', body_html: '<p>Hello</p><a href="https://example.org/x">x</a>', segment_id: seg.body.id, sender_id: sender.id });
  const L = await api('POST', `/api/campaigns/${c.body.id}/launch`);
  assert.equal(L.status, 200); assert.equal(L.body.simulated, false);
  const done = await wait(async () => (await api('GET', `/api/campaigns/${c.body.id}`)).body.status === 'sent');
  assert.ok(done);
  const d = (await api('GET', `/api/campaigns/${c.body.id}`)).body;
  assert.equal(d.stats.failed, 1); assert.equal(d.stats.sent, L.body.recipients - 1); assert.equal(d.simulated, 0);
  assert.match(d.stats.failures[0].error, /Rejected by server/);
  const mails = inbox.filter((m) => m.raw.includes('List-Unsubscribe'));
  assert.equal(mails.length, d.stats.sent);
  assert.match(mails[0].raw, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/); assert.match(mails[0].raw.replace(/=\r?\n/g, ""), /crm\.test\/t\/o\//); assert.match(mails[0].raw, /From: "?Santosh T"?/);
  const rec = (await api('GET', `/api/campaigns/${c.body.id}/recipients`)).body;
  assert.ok(rec.some((r) => r.state === 'failed' && r.error) && rec.some((r) => r.state === 'sent' && r.message_id));
  const ok = rec.find((r) => r.state === 'sent');
  const token = db.prepare('SELECT token FROM campaign_recipients WHERE id=?').get(ok.id).token;
  await fetch(`${base}/t/o/${token}.gif`);
  assert.equal((await api('GET', `/api/campaigns/${c.body.id}/recipients`)).body.find((r) => r.id === ok.id).state, 'opened');
  rejectAddr = null;
});

test('daily limit pauses a campaign and resumes when raised', async () => {
  const sender = (await api('GET', '/api/senders')).body.find((s) => s.is_default);
  await api('PUT', `/api/senders/${sender.id}`, { ...smtpSender(), daily_limit: 1 });
  const seg = await api('POST', '/api/segments', { name: 'cust', filter: { match: 'all', rules: [{ field: 'status', op: 'is', value: 'customer' }] } });
  const c = await api('POST', '/api/campaigns', { name: 'Limit camp', subject: 's', body_html: '<p>x</p>', segment_id: seg.body.id, sender_id: sender.id });
  await api('POST', `/api/campaigns/${c.body.id}/launch`);
  const paused = await wait(async () => (await api('GET', `/api/campaigns/${c.body.id}`)).body.note);
  assert.match(paused, /daily limit/); 
  const st = (await api('GET', `/api/campaigns/${c.body.id}`)).body; assert.equal(st.status, 'sending'); assert.ok(st.stats.queued > 0);
  await api('PUT', `/api/senders/${sender.id}`, { ...smtpSender(), daily_limit: 5000 });
  processCampaign(c.body.id);
  assert.ok(await wait(async () => (await api('GET', `/api/campaigns/${c.body.id}`)).body.status === 'sent'));
});

test('simulated sender never touches the network and is flagged', async () => {
  const sim = (await api('GET', '/api/senders')).body.find((s) => s.mode === 'simulate');
  const seg = (await api('GET', '/api/segments')).body[0];
  const before = inbox.length;
  const c = await api('POST', '/api/campaigns', { name: 'Sim', subject: 's', body_html: '<p>x</p>', segment_id: seg.id, sender_id: sim.id });
  const L = await api('POST', `/api/campaigns/${c.body.id}/launch`); assert.equal(L.body.simulated, true);
  await wait(async () => (await api('GET', `/api/campaigns/${c.body.id}`)).body.status === 'sent');
  assert.equal(inbox.length, before); assert.equal((await api('GET', `/api/campaigns/${c.body.id}`)).body.simulated, 1);
});

test('notification rules: CRUD, permissions, deal/contact/import events, dedupe, filters, log', async () => {
  const sender = (await api('GET', '/api/senders')).body.find((s) => s.label.startsWith('Santosh'));
  assert.equal((await api('POST', '/api/notifications/rules', { name: 'x', event: 'nope', extra_emails: 'a@b.co' })).status, 400);
  assert.equal((await api('POST', '/api/notifications/rules', { name: 'x', event: 'deal.created' })).status, 400, 'needs a recipient');
  assert.equal((await api('POST', '/api/notifications/rules', { name: 'x', event: 'deal.created', extra_emails: 'not-an-email' })).status, 400);
  const mk = (b) => api('POST', '/api/notifications/rules', { sender_id: sender.id, ...b });
  const r1 = await mk({ name: 'Stage moves', event: 'deal.stage_changed', extra_emails: 'boss@syncsense.in', notify_owner: true });
  const r2 = await mk({ name: 'Any deal change', event: 'deal.updated', extra_emails: 'boss@syncsense.in' });
  const r3 = await mk({ name: 'Big deals only', event: 'deal.created', extra_emails: 'big@syncsense.in', min_amount: 50000 });
  const r4 = await mk({ name: 'New contacts', event: 'contact.created', user_ids: [1], subject_template: 'Welcome {{name}}' });
  const r5 = await mk({ name: 'Imports', event: 'contact.imported', extra_emails: 'ops@syncsense.in' });
  assert.equal(r1.status, 200);
  inbox.length = 0;
  const deal = await api('POST', '/api/deals', { name: 'Small deal', amount: 1000 });
  const big = await api('POST', '/api/deals', { name: 'Big deal', amount: 90000 });
  await api('POST', `/api/deals/${deal.body.id}/stage`, { stage: 'proposal' });
  const bossMails = await wait(() => inbox.filter((m) => m.to.includes('boss@syncsense.in')).length >= 1 && inbox.filter((m) => m.to.includes('big@syncsense.in')).length >= 1);
  assert.ok(bossMails);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(inbox.filter((m) => m.to.includes('boss@syncsense.in')).length, 1, 'one email despite two matching rules');
  assert.equal(inbox.filter((m) => m.to.includes('big@syncsense.in')).length, 1, 'only the >= $50k deal triggers rule 3');
  assert.match(inbox.find((m) => m.to.includes('boss@syncsense.in')).raw, /Deal moved to proposal/);
  const c1 = await api('POST', '/api/contacts', { first_name: 'Nora', email: 'nora@example.com' });
  assert.ok(await wait(() => inbox.some((m) => /Welcome Nora/.test(m.raw))));
  inbox.length = 0;
  await api('POST', '/api/contacts/import', { rows: [{ first_name: 'A', email: 'a1@imp.example' }, { first_name: 'B', email: 'b1@imp.example' }, { first_name: 'C', email: 'c1@imp.example' }] });
  assert.ok(await wait(() => inbox.some((m) => m.to.includes('ops@syncsense.in'))));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(inbox.filter((m) => m.to.includes('ops@syncsense.in')).length, 1, 'import sends one summary, not one per row');
  assert.equal(inbox.filter((m) => /Welcome/.test(m.raw)).length, 0, 'no per-row contact.created for imports');
  const log = (await api('GET', '/api/email-log?kind=notification')).body;
  assert.ok(log.length >= 4 && log.every((l) => l.status === 'sent'));
  // test-send a rule, toggle off, and permissions
  const t = await api('POST', `/api/notifications/rules/${r4.body.id}/test`); assert.equal(t.status, 200);
  assert.ok(await wait(() => inbox.some((m) => /\[TEST\]/.test(m.raw))));
  await api('PUT', `/api/notifications/rules/${r3.body.id}`, { ...r3.body, active: false });
  inbox.length = 0; await api('POST', '/api/deals', { name: 'Big 2', amount: 99000 }); await new Promise((r) => setTimeout(r, 400));
  assert.equal(inbox.filter((m) => m.to.includes('big@syncsense.in')).length, 0, 'inactive rule is silent');
  const rep = await api('POST', '/api/auth/login', { email: 'liam@ovantaa.com', password: 'Ovantaa@123' }, { nocookie: true, ck: 'x' });
  const repCookie = (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'liam@ovantaa.com', password: 'Ovantaa@123' }) })).headers.get('set-cookie').split(';')[0];
  assert.equal((await api('GET', '/api/notifications/rules', null, { ck: repCookie })).status, 403);
  assert.equal((await api('POST', '/api/notifications/rules', { name: 'x', event: 'deal.created', extra_emails: 'a@b.co' }, { ck: repCookie })).status, 403);
  assert.equal((await api('POST', '/api/senders', smtpSender(), { ck: repCookie })).status, 403);
  assert.equal((await api('DELETE', `/api/notifications/rules/${r5.body.id}`)).status, 200);
});

test('AI: not configured → clear error; configured → sanitised draft; bad key → friendly error', async () => {
  assert.equal((await api('GET', '/api/ai/status')).body.configured, false);
  const none = await api('POST', '/api/ai/campaign', { brief: 'Announce our new analytics module to customers' });
  assert.equal(none.status, 400); assert.match(none.body.error, /not configured/);
  assert.equal((await api('PUT', '/api/settings/ai', { api_key: 'nope' })).status, 400);
  await api('PUT', '/api/settings/ai', { api_key: 'sk-ant-wrong' });
  const wrong = await api('POST', '/api/ai/campaign', { brief: 'Announce our new analytics module to customers' });
  assert.equal(wrong.status, 502); assert.match(wrong.body.error, /key was rejected/);
  await api('PUT', '/api/settings/ai', { api_key: 'sk-ant-test-key' });
  assert.equal((await api('GET', '/api/ai/status')).body.configured, true);
  assert.ok(!db.prepare("SELECT value FROM settings WHERE key='anthropic_api_key'").get().value.includes('sk-ant'), 'key stored encrypted');
  assert.equal((await api('POST', '/api/ai/campaign', { brief: 'short' })).status, 400);
  const r = await api('POST', '/api/ai/campaign', { brief: 'Announce our new analytics module to customers', tone: 'friendly', cta_url: 'https://example.com/go', audience: 'CFOs' });
  assert.equal(r.status, 200); assert.equal(r.body.subject, 'Meet Ovantaa CRM'); assert.equal(r.body.subject_alternatives.length, 3);
  assert.ok(!/script|onclick|javascript:/i.test(r.body.body_html), 'model HTML is sanitised'); assert.match(r.body.body_html, /https:\/\/example.com\/go/);
  const call = aiCalls.at(-1); assert.equal(call.headers['x-api-key'], 'sk-ant-test-key'); assert.equal(call.headers['anthropic-version'], '2023-06-01');
  assert.match(call.body.messages[0].content, /CFOs/); assert.match(call.body.messages[0].content, /https:\/\/example.com\/go/); assert.equal(call.body.model, 'claude-sonnet-5-5');
  assert.equal((await api('POST', '/api/ai/campaign', { brief: 'x'.repeat(20), cta_url: 'javascript:alert(1)' })).status, 400);
  const rw = await api('POST', '/api/ai/campaign', { task: 'rewrite', instruction: 'shorter', current_html: '<p>long text</p>', current_subject: 's' });
  assert.equal(rw.status, 200); assert.match(aiCalls.at(-1).body.messages[0].content, /long text/);
});

test('theme: public read, admin-only write, invalid colours ignored', async () => {
  assert.equal((await api('GET', '/api/theme', null, { nocookie: true })).body.primary, '#4f46e5');
  const t = await api('PUT', '/api/theme', { primary: '#0d9488', sidebar: 'red; background:url(x)', mode: 'dark' });
  assert.equal(t.body.primary, '#0d9488'); assert.equal(t.body.sidebar, '#12142b'); assert.equal(t.body.mode, 'dark');
  assert.equal((await api('GET', '/api/theme', null, { nocookie: true })).body.mode, 'dark');
});

test('import options: default tag/source, subscribed column, skip-existing', async () => {
  const r = await api('POST', '/api/contacts/import', { options: { tag: 'expo-2026', source: 'Expo', status: 'qualified' }, rows: [{ first_name: 'Opt', email: 'opt1@imp.example', subscribed: 'no' }, { first_name: 'Opt2', email: 'opt2@imp.example', tags: 'vip' }] });
  assert.equal(r.body.created, 2);
  const c = (await api('GET', '/api/contacts?q=opt1@imp.example')).body.rows[0];
  assert.equal(c.subscribed, 0); assert.equal(c.source, 'Expo'); assert.equal(c.status, 'qualified'); assert.match(c.tags, /expo-2026/);
  assert.match((await api('GET', '/api/contacts?q=opt2@imp.example')).body.rows[0].tags, /vip.*expo-2026|expo-2026.*vip/);
  const again = await api('POST', '/api/contacts/import', { options: { update_existing: false }, rows: [{ first_name: 'Opt', email: 'opt1@imp.example' }] });
  assert.equal(again.body.skipped, 1); assert.equal(again.body.updated, 0);
});
