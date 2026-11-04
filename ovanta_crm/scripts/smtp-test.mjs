// Diagnose an SMTP login problem.
//   node scripts/smtp-test.mjs --list                 show saved senders
//   node scripts/smtp-test.mjs --sender 1             test the credentials SAVED in the app for sender #1
//   node scripts/smtp-test.mjs --host smtp.titan.email --user me@x.com   (password read from env SMTP_PASS, or prompted)
//   add --port 587 to test one port only; add --ipv4 to connect over IPv4 only (use if every attempt says "Greeting never received")
// Tries port 465 (SSL/TLS) and 587 (STARTTLS) with both AUTH PLAIN and AUTH LOGIN and prints the server's replies.
// Credentials are never printed (only length and first/last character of the password).
import { format } from 'node:util';
import readline from 'node:readline';
import dns from 'node:dns/promises';
import { createRequire } from 'node:module';
const nodemailer = createRequire(import.meta.url)('nodemailer');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null)).filter(Boolean));

let host = args.host, user = args.user, pass = process.env.SMTP_PASS;
if (args.list || args.sender) {
  const { all, get } = await import('../server/db.js'); const { decryptSecret } = await import('../server/auth.js');
  if (args.list) { for (const s of all('SELECT id,label,from_email,host,port,secure,username FROM senders')) console.log(`#${s.id}  ${s.label}  <${s.from_email}>  ${s.host}:${s.port}  user=${s.username}`); process.exit(0); }
  const s = get('SELECT * FROM senders WHERE id=?', Number(args.sender)); if (!s) { console.error('No such sender. Use --list.'); process.exit(1); }
  host = s.host; user = s.username || s.from_email; pass = decryptSecret(s.password_enc);
  console.log(`Using saved sender #${s.id} "${s.label}" (${host}, user ${user}).`);
}
if (!host || !user) { console.error('Usage: see the comment at the top of this file.'); process.exit(1); }
if (pass === undefined) { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); pass = await new Promise((r) => rl.question('Password (will be visible): ', (a) => { rl.close(); r(a); })); }

const hint = `${pass.length} characters, starts with "${pass[0] ?? ''}", ends with "${pass.at(-1) ?? ''}"`;
console.log(`Password being used: ${hint}${pass !== pass.trim() ? '  ⚠ HAS LEADING/TRAILING SPACE' : ''}${/[^\x20-\x7e]/.test(pass) ? '  ⚠ contains non-ASCII characters' : ''}`);
if (pass.length === 11 && pass.startsWith('O') && pass.endsWith('3')) console.log('⚠ This looks like the CRM login password (Ovantaa@123) — the browser probably autofilled the wrong password.');
console.log('');

let ok = false; let connectHost = host, tlsExtra = {};
if (args.ipv4) { const r = await dns.lookup(host, { family: 4 }); connectHost = r.address; tlsExtra = { servername: host }; console.log(`Forcing IPv4: ${host} -> ${connectHost}\n`); }
else { const v6 = await dns.resolve6(host).catch(() => []); if (v6.length) console.log(`Note: ${host} also has IPv6 address(es) ${v6.join(', ')} — if all attempts time out, retry with --ipv4\n`); }
const combos = args.port ? [[Number(args.port), Number(args.port) === 465 || args.secure === 'true']] : [[465, true], [587, false]];
for (const [port, secure] of combos) for (const authMethod of ['PLAIN', 'LOGIN']) {
  const lines = [];
  const logger = { level() {}, trace() {}, debug: (_d, m, ...a) => lines.push(format(m, ...a)), info() {}, warn() {}, error: (_d, m, ...a) => lines.push(format(m, ...a)), fatal() {} };
  const t = nodemailer.createTransport({ host: connectHost, port, secure, requireTLS: !secure, auth: { user, pass, method: authMethod }, logger, debug: true, tls: { ...tlsExtra, ...(process.env.SMTP_TLS_INSECURE === '1' ? { rejectUnauthorized: false } : {}) }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000 });
  process.stdout.write(`${host}:${port} ${secure ? 'SSL/TLS' : 'STARTTLS'} AUTH ${authMethod} … `);
  try { await t.verify(); console.log('✅ LOGIN OK'); ok = true; break; }
  catch (e) {
    console.log(`❌ ${e.code || ''} ${e.responseCode || ''} ${String(e.response || e.message).slice(0, 150)}`);
    for (const l of lines.filter((x) => /^(S|C): /.test(x) || /EHLO|AUTH|STARTTLS|250|334|235|535|5\d\d /.test(x)).slice(-12)) console.log('     ' + l.replace(/(AUTH (PLAIN|LOGIN)) \S+/i, '$1 ***').replace(/^(C: )[A-Za-z0-9+/=]{8,}$/, '$1***'));
  } finally { t.close(); }
}
console.log(ok ? '\nCredentials work with the combination above — use that port/SSL setting in the sender.' : `\nEvery combination failed. If the server answered 535 everywhere, it is rejecting this username/password for SMTP. Check:\n  • the username is the FULL address and the password is the one that works in webmail (retype it; avoid autofill)\n  • your provider allows SMTP/third-party access for this mailbox (Titan: check the control panel / ask support)\n  • try the same host, user and password in Thunderbird or Outlook — if that fails too, it is not this app.`);
process.exit(ok ? 0 : 2);
