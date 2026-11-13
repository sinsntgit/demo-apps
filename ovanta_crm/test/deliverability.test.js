import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { createRequire } from 'node:module';
const { SMTPServer } = createRequire(import.meta.url)('smtp-server');

const inbox = [];
const smtp = new SMTPServer({ authOptional: true, logger: false, onAuth(_a, _s, cb) { cb(null, { user: 1 }); },
  onData(stream, s, cb) { let raw = ''; stream.on('data', (c) => (raw += c)); stream.on('end', () => { inbox.push({ raw: raw.replace(/=\r?\n/g, '').replace(/=3D/g, '='), to: s.envelope.rcptTo.map((r) => r.address) }); cb(); }); } });
await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
Object.assign(process.env, { SEED_BILLING_DEMO: '0', DB_PATH: ':memory:', SESSION_SECRET: 'deliv', SMTP_TLS_INSECURE: '1', SMTP_TIMEOUT_MS: '3000', COMPANY_ADDRESS: 'SyncSense, 12 MG Road, Bengaluru' });
delete process.env.BASE_URL;
const { server } = await import('../server/index.js');
const { seedIfEmpty } = await import('../server/seed.js');
const { config } = await import('../server/config.js');
const { addressReach, lintCampaign, checkDomain, dnsBackends, dohBackend } = await import('../server/deliverability.js');
let base, admin, senderId, segId;
before(async () => {
  seedIfEmpty(); await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; admin = await login('admin@ovantaa.com', 'Ovantaa@123');
  senderId = (await call(admin, 'POST', '/api/senders', { label: 'Santosh', from_email: 'santosh@syncsense.in', mode: 'smtp', host: '127.0.0.1', port: smtp.server.address().port, secure: false, delay_ms: 0 })).body.id;
  segId = (await call(admin, 'POST', '/api/segments', { name: 'VIPs', filter: { match: 'all', rules: [{ field: 'tags', op: 'is', value: 'vip' }] } })).body.id;
});
after(() => { server.close(); smtp.close(); });
async function call(ck, method, p, body) { const r = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie: ck || '' }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j }; }
async function login(email, password) { const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }); return r.status === 200 ? r.headers.get('set-cookie').split(';')[0] : null; }
async function sendCampaign(extra) {
  const c = await call(admin, 'POST', '/api/campaigns', { name: 'C', subject: 'Hi {{first_name|there}}', body_html: '<p>Hi {{first_name}}</p><a href="https://syncsense.in/offer">See it</a>', segment_id: segId, sender_id: senderId, ...extra });
  const n0 = inbox.length; const L = await call(admin, 'POST', `/api/campaigns/${c.body.id}/launch`); assert.equal(L.status, 200, JSON.stringify(L.body));
  let d; for (let i = 0; i < 100; i++) { d = await call(admin, 'GET', `/api/campaigns/${c.body.id}`); if (d.body.status === 'sent') break; await new Promise((r) => setTimeout(r, 50)); }
  return { campaign: d.body, launch: L.body, mails: inbox.slice(n0) };
}

test('which addresses people on the internet can reach', () => {
  for (const u of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://192.168.1.20:3000', 'http://10.0.0.5', 'http://172.20.1.1:3000', 'http://SANTOSH-PC:3000', 'http://crm.local:3000']) assert.equal(addressReach(u).public, false, u);
  assert.deepEqual([addressReach('https://crm.syncsense.in').public, addressReach('https://crm.syncsense.in').https], [true, true]);
  assert.equal(addressReach('http://203.0.113.9:3000').public, true); assert.match(addressReach('http://crm.syncsense.in').reason, /https/);
});

test('with a private address, campaigns go out without tracking: direct links, unsubscribe by reply', async () => {
  config.baseUrl = 'http://192.168.1.20:3000';
  const prev = await call(admin, 'POST', '/api/campaigns/preview', { subject: 'Hi', body_html: '<p>x</p>', sender_id: senderId });
  assert.equal(prev.body.tracking.tracked, false); assert.match(prev.body.reach.reason, /private address/);
  const { campaign, launch, mails } = await sendCampaign();
  assert.equal(launch.tracked, false); assert.equal(campaign.tracked, 0); assert.match(campaign.tracking_note, /private address/);
  assert.ok(mails.length > 0);
  for (const m of mails) {
    assert.doesNotMatch(m.raw, /192\.168\.1\.20/, 'no links to the private address');
    assert.match(m.raw, /href="https:\/\/syncsense\.in\/offer"/, 'links go straight to the website');
    assert.match(m.raw, /List-Unsubscribe: <mailto:santosh@syncsense\.in\?subject=Unsubscribe>/); assert.doesNotMatch(m.raw, /List-Unsubscribe-Post/);
    assert.match(m.raw, /reply with/);
  }
});

test('with an internet address, links and the open pixel are tracked; turning tracking off is respected', async () => {
  config.baseUrl = 'https://crm.syncsense.in';
  const on = await sendCampaign();
  assert.equal(on.campaign.tracked, 1);
  const raw = on.mails[0].raw;
  assert.match(raw, /href="https:\/\/crm\.syncsense\.in\/t\/c\/[\w-]+\?u=https%3A%2F%2Fsyncsense\.in%2Foffer/);
  assert.match(raw, /<img src="https:\/\/crm\.syncsense\.in\/t\/o\/[\w-]+\.gif"/); assert.doesNotMatch(raw, /display:none/, 'hidden images are skipped by some mail apps');
  assert.match(raw, /List-Unsubscribe: <https:\/\/crm\.syncsense\.in\/u\/[\w-]+>,\s+<mailto:santosh@syncsense\.in\?subject=Unsubscribe>/); assert.match(raw, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
  const off = await sendCampaign({ track: false });
  assert.equal(off.campaign.tracked, 0); assert.match(off.campaign.tracking_note, /turned off/);
  assert.doesNotMatch(off.mails[0].raw, /\/t\/(c|o)\//); assert.match(off.mails[0].raw, /crm\.syncsense\.in\/u\//, 'unsubscribe page still works');
  const ping = await fetch(`${base}/t/ping`); assert.equal(ping.status, 200); assert.match(await ping.text(), /reachable/);
});

test('the inbox check flags spam signals in the content', () => {
  const bad = lintCampaign({ subject: 'FREE OFFER FOR YOU!!!', body_html: '<img src="https://x/y.png"><a href="https://bit.ly/abc">click here</a>' });
  const t = bad.map((w) => w.text).join(' | ');
  assert.match(t, /CAPITAL/); assert.match(t, /exclamation/); assert.match(t, /shorteners/); assert.match(t, /Mostly image/); assert.match(t, /“free”/);
  const good = lintCampaign({ subject: 'Quick question about your Q3 reporting, {{first_name}}', body_html: `<p>Hi {{first_name|there}},</p><p>${'We helped a team like yours cut month-end reporting from five days to one. '.repeat(5)}</p><p>Worth a 15-minute call next week?</p>` });
  assert.equal(good.filter((w) => w.level !== 'tip').length, 0, JSON.stringify(good));
});

test('domain check reads SPF, DKIM and DMARC from DNS and says how to fix what is missing', async () => {
  const orig = { mx: dns.resolveMx, txt: dns.resolveTxt, cname: dns.resolveCname };
  const zone = { 'syncsense.in': ['v=spf1 include:spf.protection.outlook.com ~all'], 'titan1._domainkey.syncsense.in': ['v=DKIM1; k=rsa; p=MIIB'] };
  const nf = () => Object.assign(new Error('nf'), { code: 'ENOTFOUND' });
  dns.resolveMx = async (d) => (d === 'gmail.com' || d === 'syncsense.in' ? [{ exchange: 'mx.secureserver.net', priority: 0 }] : Promise.reject(nf()));
  dns.resolveTxt = async (d) => (zone[d] ? zone[d].map((t) => [t]) : Promise.reject(nf()));
  dns.resolveCname = async () => { throw nf(); };
  try {
    const r = await checkDomain({ from_email: 'santosh@syncsense.in', host: 'smtpout.secureserver.net' });
    const by = Object.fromEntries(r.items.map((i) => [i.key, i]));
    assert.equal(r.provider, 'GoDaddy'); assert.equal(by.mx.status, 'ok');
    assert.equal(by.spf.status, 'bad'); assert.match(by.spf.fix, /include:secureserver\.net/);
    assert.equal(by.dkim.status, 'ok'); assert.match(by.dkim.detail, /titan1/);
    assert.equal(by.dmarc.status, 'bad'); assert.match(by.dmarc.fix, /v=DMARC1; p=none/);
    assert.equal(by.volume.status, 'warn');
    assert.equal(r.via, 'this computer’s DNS');
    const realList = dnsBackends.list;
    const refused = (name) => ({ name, mx: async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); }, txt: async () => { throw new Error('x'); }, cname: async () => { throw new Error('x'); } });
    try {
      // Windows refusing direct DNS queries: the check falls back to DNS-over-HTTPS (same JSON as Cloudflare/Google)
      const doh = { 'syncsense.in/MX': [{ type: 15, data: '0 mx.secureserver.net.' }], 'gmail.com/MX': [{ type: 15, data: '5 gmail-smtp-in.l.google.com.' }],
        'syncsense.in/TXT': [{ type: 16, data: '"v=spf1 include:secureserver.net " "-all"' }], '_dmarc.syncsense.in/TXT': [{ type: 16, data: '"v=DMARC1; p=none"' }],
        'selector1._domainkey.syncsense.in/CNAME': [{ type: 5, data: 'selector1-syncsense-in._domainkey.x.onmicrosoft.com.' }] };
      const urls = [];
      const fakeFetch = async (u) => { urls.push(u); const q = new URL(u); const ans = doh[`${q.searchParams.get('name')}/${q.searchParams.get('type')}`];
        return { ok: true, json: async () => (ans ? { Status: 0, Answer: ans } : { Status: 3 }) }; };
      dnsBackends.list = () => [refused('this computer’s DNS'), refused('public DNS'), dohBackend('DNS over HTTPS (test)', 'https://doh.test/q', fakeFetch)];
      const viaDoh = await checkDomain({ from_email: 'santosh@syncsense.in', host: 'smtpout.secureserver.net' });
      const d = Object.fromEntries(viaDoh.items.map((i) => [i.key, i]));
      assert.equal(viaDoh.via, 'DNS over HTTPS (test)'); assert.ok(urls[0].includes('accept') === false && urls[0].startsWith('https://doh.test/q?name=gmail.com&type=MX'));
      assert.equal(d.mx.status, 'ok'); assert.equal(d.mx.detail, 'mx.secureserver.net');
      assert.equal(d.spf.status, 'ok'); assert.equal(d.spf.detail, 'v=spf1 include:secureserver.net -all', 'split TXT chunks are joined');
      assert.equal(d.dkim.status, 'ok'); assert.match(d.dkim.detail, /selector1/); assert.equal(d.dmarc.status, 'ok');
      // nothing works at all: say so instead of reporting records as missing
      dnsBackends.list = () => [refused('this computer’s DNS'), refused('public DNS')];
      const offline = await checkDomain({ from_email: 'santosh@syncsense.in', host: 'smtpout.secureserver.net' });
      assert.equal(offline.items.length, 1); assert.equal(offline.items[0].key, 'dns', 'no false "missing" results when DNS is unreachable'); assert.match(offline.items[0].detail, /ECONNREFUSED/);
    } finally { dnsBackends.list = realList; }
    const free = await checkDomain({ from_email: 'me@gmail.com', host: 'smtp.gmail.com' }); assert.match(free.items[0].detail, /cannot add SPF/);
    const api = await call(admin, 'POST', `/api/senders/${senderId}/deliverability`); assert.equal(api.status, 200); assert.equal(api.body.domain, 'syncsense.in');
  } finally { Object.assign(dns, { resolveMx: orig.mx, resolveTxt: orig.txt, resolveCname: orig.cname }); }
});
