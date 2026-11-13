import net from 'node:net';
import tls from 'node:tls';
import { config } from './config.js';
import { decryptSecret } from './auth.js';

/*
 * Saving a copy of sent emails in the mailbox's "Sent" folder.
 * Sending by SMTP never puts anything in Sent (Gmail and Microsoft 365 are exceptions: they file SMTP mail themselves),
 * so after a successful send we APPEND the same message to the Sent folder over IMAP — what desktop mail apps do.
 * A tiny client is enough: LOGIN, LIST (to find the folder marked \Sent), APPEND, LOGOUT. One connection per sender is
 * reused while a campaign runs and closed after a short idle time.
 */
const TIMEOUT = () => Math.min(config.smtpTimeoutMs || 60000, 30000);
const IDLE_MS = 20000;
const isLoopback = (h) => /^(127\.|localhost$|::1$)/i.test(String(h));
const quote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const needsLiteral = (s) => /[^\x20-\x7e]/.test(String(s));
const SENT_NAMES = ['sent', 'sent items', 'sent messages', 'sent mail', 'inbox.sent', 'inbox.sent items', 'inbox/sent', '[gmail]/sent mail'];

class Session {
  constructor(sender) { this.sender = sender; this.buf = Buffer.alloc(0); this.waiters = []; this.n = 0; this.closed = false; }

  async open() {
    const s = this.sender, host = s.imap_host, port = Number(s.imap_port) || 993, implicit = port === 993 || (port !== 143 && !!s.secure);
    const tlsOpts = { host, servername: net.isIP(host) ? undefined : host, ...(config.smtpTlsInsecure ? { rejectUnauthorized: false } : {}) };
    this.sock = implicit ? tls.connect({ ...tlsOpts, port }) : net.connect({ host, port });
    await this.wire(implicit ? 'secureConnect' : 'connect');
    const greet = await this.line();
    if (!/^\* (OK|PREAUTH)/i.test(greet)) throw new Error(`Unexpected IMAP greeting: ${greet.slice(0, 120)}`);
    if (!implicit) {
      const caps = await this.cmd('CAPABILITY');
      if (/STARTTLS/i.test(caps.untagged.join(' '))) {
        await this.cmd('STARTTLS'); const raw = this.sock; raw.removeAllListeners('data');
        this.sock = tls.connect({ ...tlsOpts, socket: raw }); await this.wire('secureConnect');
      } else if (!isLoopback(host)) throw new Error(`The IMAP server ${host}:${port} does not offer encryption. Use port 993 (SSL/TLS).`);
    }
    const pass = decryptSecret(s.password_enc) || '';
    try { await this.cmd('LOGIN', s.username || s.from_email, pass); }
    catch (e) { throw new Error(`IMAP login failed on ${host} (${e.message}). The IMAP username and password are the same as for SMTP — check that IMAP access is enabled for this mailbox.`); }
    return this;
  }

  wire(ready) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.sock.destroy(); reject(new Error(`Could not connect to the IMAP server ${this.sender.imap_host}:${this.sender.imap_port} (timeout).`)); }, TIMEOUT());
      this.sock.once(ready, () => { clearTimeout(t); resolve(); });
      this.sock.once('error', (e) => { clearTimeout(t); reject(new Error(`Could not connect to the IMAP server ${this.sender.imap_host}:${this.sender.imap_port} (${e.code || e.message}).`)); });
      this.sock.on('error', (e) => this.fail(e));
      this.sock.on('close', () => this.fail(new Error('IMAP connection closed')));
      this.sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.pump(); });
      this.sock.setTimeout(TIMEOUT(), () => this.sock.destroy(new Error('IMAP server stopped responding')));
    });
  }
  fail(e) { this.closed = true; const w = this.waiters; this.waiters = []; w.forEach((x) => x.reject(e)); }
  pump() {
    while (this.waiters.length) {
      const i = this.buf.indexOf('\r\n'); if (i < 0) return;
      let end = i + 2, text = this.buf.subarray(0, i).toString('utf8');
      // a server line may carry a literal: {n}\r\n<n bytes> then the rest of the line
      for (let m = text.match(/\{(\d+)\}$/); m; m = text.match(/\{(\d+)\}$/)) {
        const n = Number(m[1]); if (this.buf.length < end + n) return;
        const lit = this.buf.subarray(end, end + n).toString('utf8'); const j = this.buf.indexOf('\r\n', end + n); if (j < 0) return;
        text = text.slice(0, -m[0].length) + quote(lit) + this.buf.subarray(end + n, j).toString('utf8'); end = j + 2;
      }
      this.buf = this.buf.subarray(end); this.waiters.shift().resolve(text);
    }
  }
  line() { if (this.closed) return Promise.reject(new Error('IMAP connection closed')); return new Promise((resolve, reject) => { this.waiters.push({ resolve, reject }); this.pump(); }); }

  /** Run a command. String args are quoted (or sent as literals when not plain ASCII); a Buffer arg is sent as a literal. */
  async cmd(name, ...args) {
    const tag = `A${++this.n}`; const chunks = []; let cur = `${tag} ${name}`;
    for (const a of args) {
      if (a && a.raw !== undefined) { cur += ' ' + a.raw; continue; }
      if (Buffer.isBuffer(a) || needsLiteral(a)) { const lit = Buffer.isBuffer(a) ? a : Buffer.from(String(a)); chunks.push({ text: `${cur} {${lit.length}}`, lit }); cur = ''; continue; }
      cur += ' ' + quote(a);
    }
    const untagged = [];
    // send up to each literal "{n}", wait for the server's "+", send the bytes, then continue the command
    for (const ch of chunks) {
      this.sock.write(ch.text + '\r\n');
      for (;;) { const l = await this.line(); if (l.startsWith('+')) break; if (l.startsWith(tag + ' ')) throw new Error(l.slice(tag.length + 1).replace(/^(NO|BAD)\s*/i, '')); untagged.push(l); }
      this.sock.write(ch.lit);
    }
    this.sock.write(cur + '\r\n');
    for (;;) {
      const l = await this.line();
      if (l.startsWith(tag + ' ')) { const rest = l.slice(tag.length + 1); if (!/^OK/i.test(rest)) throw new Error(rest.replace(/^(NO|BAD)\s*/i, '').slice(0, 200)); return { untagged, status: rest }; }
      untagged.push(l);
    }
  }

  /** The folder to save into: the one the user typed, else the one the server marks \Sent, else a usual name. */
  async sentFolder() {
    if (this.folder) return this.folder;
    if (this.sender.sent_folder) return (this.folder = this.sender.sent_folder);
    const { untagged } = await this.cmd('LIST', '', '*');
    const boxes = untagged.map((l) => l.match(/^\* LIST \(([^)]*)\) (?:"(?:[^"\\]|\\.)*"|NIL) (.+)$/i)).filter(Boolean)
      .map(([, flags, name]) => ({ flags: flags.toLowerCase(), name: name.startsWith('"') ? name.slice(1, -1).replace(/\\(.)/g, '$1') : name }));
    const hit = boxes.find((b) => /\\sent\b/.test(b.flags)) || SENT_NAMES.map((n) => boxes.find((b) => b.name.toLowerCase() === n)).find(Boolean);
    if (!hit) throw new Error(`No Sent folder found in this mailbox (folders: ${boxes.map((b) => b.name).slice(0, 12).join(', ') || 'none'}). Type the folder name under Email senders → Edit.`);
    return (this.folder = hit.name);
  }
  async append(raw) {
    const folder = await this.sentFolder();
    await this.cmd('APPEND', folder, { raw: '(\\Seen)' }, Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
    return folder;
  }
  close() { if (this.closed) return; this.closed = true; try { this.sock.write(`A${++this.n} LOGOUT\r\n`); this.sock.end(); } catch { /* ignore */ } setTimeout(() => this.sock.destroy(), 1000).unref(); }
}

const sessions = new Map(); // senderId -> { sig, session, chain, timer }
const sigOf = (s) => [s.imap_host, s.imap_port, s.username, s.password_enc, s.sent_folder].join('|');

/** Append one message to the sender's Sent folder. Serialised per sender; reconnects once if a kept connection went stale. */
export function appendSent(sender, raw) {
  let e = sessions.get(sender.id);
  if (e && e.sig !== sigOf(sender)) { e.session?.close(); sessions.delete(sender.id); e = null; }
  if (!e) { e = { sig: sigOf(sender), session: null, chain: Promise.resolve() }; sessions.set(sender.id, e); }
  const run = async () => {
    clearTimeout(e.timer);
    for (let attempt = 0; ; attempt++) {
      try {
        if (!e.session || e.session.closed) e.session = await new Session(sender).open();
        const folder = await e.session.append(raw); return folder;
      } catch (err) {
        e.session?.close(); e.session = null;
        if (attempt || /login failed|No Sent folder|does not offer/i.test(err.message)) throw err;
      } finally { e.timer = setTimeout(() => { e.session?.close(); e.session = null; }, IDLE_MS); e.timer.unref?.(); }
    }
  };
  const p = e.chain.then(run, run); e.chain = p.catch(() => {}); return p;
}
export function forgetImap(id) { const e = sessions.get(id); if (e) { clearTimeout(e.timer); e.session?.close(); sessions.delete(id); } }

/** Check IMAP login and which folder copies will go to (used by Verify). */
export async function checkImap(sender) {
  const s = await new Session(sender).open();
  try { return await s.sentFolder(); } finally { s.close(); }
}
