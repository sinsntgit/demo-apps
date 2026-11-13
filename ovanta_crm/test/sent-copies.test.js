import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';
const { SMTPServer } = createRequire(import.meta.url)('smtp-server');

// a local SMTP sink and a small IMAP server that understands LOGIN / LIST / APPEND (with literals) / LOGOUT
const inbox = [];
const smtp = new SMTPServer({ authOptional: false, logger: false, onAuth(_a, _s, cb) { cb(null, { user: 1 }); },
  onData(stream, s, cb) { let raw = ''; stream.on('data', (c) => (raw += c)); stream.on('end', () => { inbox.push({ raw, to: s.envelope.rcptTo.map((r) => r.address) }); cb(); }); } });
await new Promise((r) => smtp.listen(0, '127.0.0.1', r));

const imap = { appended: [], logins: [], password: 'mailbox-pw', folders: [['\\HasNoChildren', 'INBOX'], ['\\HasNoChildren \\Sent', 'Sent Items'], ['\\HasNoChildren \\Trash', 'Deleted']], connections: 0 };
const imapServer = net.createServer((sock) => {
  imap.connections++; let buf = Buffer.alloc(0), pending = null;
  sock.write('* OK fake IMAP ready\r\n');
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (pending) { // waiting for literal bytes + CRLF
        if (buf.length < pending.n + 2) return;
        const lit = buf.subarray(0, pending.n).toString(); buf = buf.subarray(pending.n + 2); const p = pending; pending = null;
        if (p.kind === 'append') { imap.appended.push({ folder: p.folder, flags: p.flags, raw: lit }); sock.write(`${p.tag} OK APPEND completed\r\n`); }
        else if (p.kind === 'login') { imap.logins.push([p.user, lit]); sock.write(lit === imap.password ? `${p.tag} OK LOGIN done\r\n` : `${p.tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`); }
        continue;
      }
      const i = buf.indexOf('\r\n'); if (i < 0) return;
      const line = buf.subarray(0, i).toString(); buf = buf.subarray(i + 2);
      const [tag, cmd] = line.split(' ');
      const unq = (s) => s.replace(/^"|"$/g, '').replace(/\\(.)/g, '$1');
      if (/^LOGIN$/i.test(cmd)) {
        const m = line.match(/^\S+ LOGIN ("(?:[^"\\]|\\.)*") (?:("(?:[^"\\]|\\.)*")|\{(\d+)\})$/i);
        if (m[3]) { pending = { kind: 'login', tag, user: unq(m[1]), n: Number(m[3]) }; sock.write('+ go\r\n'); continue; }
        imap.logins.push([unq(m[1]), unq(m[2])]);
        sock.write(unq(m[2]) === imap.password ? `${tag} OK LOGIN done\r\n` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
      } else if (/^CAPABILITY$/i.test(cmd)) sock.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK\r\n`);
      else if (/^LIST$/i.test(cmd)) { sock.write(imap.folders.map(([f, n]) => `* LIST (${f}) "/" "${n}"\r\n`).join('') + `${tag} OK LIST done\r\n`); }
      else if (/^APPEND$/i.test(cmd)) { const m = line.match(/^\S+ APPEND ("(?:[^"\\]|\\.)*") \(([^)]*)\) \{(\d+)\}$/i); pending = { kind: 'append', tag, folder: unq(m[1]), flags: m[2], n: Number(m[3]) }; sock.write('+ Ready for literal data\r\n'); }
      else if (/^LOGOUT$/i.test(cmd)) { sock.write(`* BYE\r\n${tag} OK\r\n`); sock.end(); }
      else sock.write(`${tag} BAD unknown\r\n`);
    }
  });
  sock.on('error', () => {});
});
await new Promise((r) => imapServer.listen(0, '127.0.0.1', r));

Object.assign(process.env, { SEED_BILLING_DEMO: '0', DB_PATH: ':memory:', SESSION_SECRET: 'sent', BASE_URL: 'https://crm.example.com', SMTP_TLS_INSECURE: '1', SMTP_TIMEOUT_MS: '3000' });
const { server } = await import('../server/index.js');
const { seedIfEmpty } = await import('../server/seed.js');
let base, admin;
before(async () => { seedIfEmpty(); await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; admin = await login('admin@ovantaa.com', 'Ovantaa@123'); });
after(() => { server.close(); smtp.close(); imapServer.close(); });
async function call(ck, method, p, body) { const r = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie: ck || '' }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j }; }
async function login(email, password) { const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }); return r.status === 200 ? r.headers.get('set-cookie').split(';')[0] : null; }
const smtpSender = (extra) => ({ label: 'Santosh', from_name: 'Santosh T', from_email: 'santosh@syncsense.in', mode: 'smtp', host: '127.0.0.1', port: smtp.server.address().port, secure: false, username: 'santosh@syncsense.in', password: imap.password, delay_ms: 0, ...extra });
let senderId, plainId;

test('a sender can save copies in Sent: Verify finds the folder marked \\Sent', async () => {
  assert.equal((await call(admin, 'POST', '/api/senders', smtpSender({ label: 'No IMAP', save_sent: true }))).status, 400, 'an IMAP server is needed');
  const s = await call(admin, 'POST', '/api/senders', smtpSender({ save_sent: true, imap_host: '127.0.0.1', imap_port: imapServer.address().port }));
  assert.equal(s.status, 200); assert.equal(s.body.save_sent, true); senderId = s.body.id;
  const v = await call(admin, 'POST', `/api/senders/${senderId}/verify`); assert.equal(v.body.ok, true, JSON.stringify(v.body)); assert.equal(v.body.sent_folder, 'Sent Items');
  plainId = (await call(admin, 'POST', '/api/senders', smtpSender({ label: 'Second mailbox', from_email: 'sales@syncsense.in' }))).body.id;
});

test('a campaign sent from the chosen mailbox files every email in its Sent folder', async () => {
  const seg = await call(admin, 'POST', '/api/segments', { name: 'VIPs', filter: { match: 'all', rules: [{ field: 'tags', op: 'is', value: 'vip' }] } });
  const c = await call(admin, 'POST', '/api/campaigns', { name: 'Copies', subject: 'Hello {{first_name|there}}', body_html: '<p>Hi {{first_name}}</p>', segment_id: seg.body.id, sender_id: senderId });
  const n0 = imap.appended.length, conns0 = imap.connections;
  const L = await call(admin, 'POST', `/api/campaigns/${c.body.id}/launch`); assert.equal(L.status, 200); assert.ok(L.body.recipients > 1);
  let done; for (let i = 0; i < 100; i++) { done = await call(admin, 'GET', `/api/campaigns/${c.body.id}`); if (done.body.status === 'sent') break; await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(done.body.status, 'sent'); assert.equal(done.body.copies_saved, L.body.recipients); assert.equal(done.body.copies_failed, 0);
  const copies = imap.appended.slice(n0); assert.equal(copies.length, L.body.recipients);
  assert.ok(copies.every((x) => x.folder === 'Sent Items' && x.flags === '\\Seen'));
  assert.match(copies[0].raw, /From: "?Santosh T"? <santosh@syncsense\.in>/); assert.match(copies[0].raw, /Subject: Hello /);
  // the copy is the message that was delivered (same Message-ID)
  const id = copies[0].raw.match(/Message-ID: (<[^>]+>)/i)[1]; assert.ok(inbox.some((m) => m.raw.includes(id)));
  assert.equal(imap.connections - conns0, 1, 'one IMAP connection reused for the whole campaign');
});

test('without the option nothing is filed; a wrong IMAP password does not stop sending and is reported', async () => {
  const n0 = imap.appended.length;
  assert.equal((await call(admin, 'POST', `/api/senders/${plainId}/test`, { to: 'me@syncsense.in' })).body.sent_copy, undefined);
  assert.equal(imap.appended.length, n0);
  imap.password = 'changed';
  await call(admin, 'PUT', `/api/senders/${senderId}`, smtpSender({ password: '', save_sent: true, imap_host: '127.0.0.1', imap_port: imapServer.address().port }));
  const t = await call(admin, 'POST', `/api/senders/${senderId}/test`, { to: 'me@syncsense.in' });
  assert.equal(t.status, 200, 'the email itself still went out'); assert.equal(t.body.sent_copy, 'failed'); assert.match(t.body.copy_error, /IMAP login failed/);
  const s = (await call(admin, 'GET', '/api/senders')).body.find((x) => x.id === senderId); assert.match(s.copy_error, /IMAP login failed/);
  const v = await call(admin, 'POST', `/api/senders/${senderId}/verify`); assert.equal(v.body.ok, false); assert.match(v.body.error, /saving copies in Sent does not/);
  imap.password = 'mailbox-pw';
  const ok = await call(admin, 'POST', `/api/senders/${senderId}/test`, { to: 'me@syncsense.in' }); assert.equal(ok.body.sent_copy, 'saved');
  assert.equal((await call(admin, 'GET', '/api/senders')).body.find((x) => x.id === senderId).copy_error, null, 'cleared after a success');
});

test('a typed folder name is used as is, and non-ASCII passwords go as IMAP literals', async () => {
  imap.password = 'pässwörd{1}"x';
  await call(admin, 'PUT', `/api/senders/${senderId}`, smtpSender({ password: imap.password, save_sent: true, imap_host: '127.0.0.1', imap_port: imapServer.address().port, sent_folder: 'INBOX.Sent' }));
  const t = await call(admin, 'POST', `/api/senders/${senderId}/test`, { to: 'me@syncsense.in' });
  assert.equal(t.body.sent_copy, 'saved', JSON.stringify(t.body)); assert.equal(t.body.sent_folder, 'INBOX.Sent'); assert.equal(imap.appended.at(-1).folder, 'INBOX.Sent');
  assert.deepEqual(imap.logins.at(-1), ['santosh@syncsense.in', 'pässwörd{1}"x']);
});
