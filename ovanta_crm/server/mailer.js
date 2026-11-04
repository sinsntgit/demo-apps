import { get, all, run } from './db.js';
import { config } from './config.js';
import { decryptSecret } from './auth.js';

/** Recent simulated messages (shown in the UI when a sender is in simulation mode). */
export const outboxLog = [];

const clean = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
export const fromHeader = (s) => (s.from_name ? `"${clean(s.from_name).replace(/"/g, '')}" <${clean(s.from_email)}>` : clean(s.from_email));

let nodemailer;
async function loadNodemailer() {
  if (nodemailer) return nodemailer;
  try { nodemailer = (await import('nodemailer')).default; return nodemailer; }
  catch { throw new Error('The "nodemailer" package is not installed. Run "npm install" in the ovanta_crm folder, then restart.'); }
}

const transports = new Map(); // senderId -> { sig, transporter }
async function transportFor(sender) {
  const sig = [sender.host, sender.port, sender.secure, sender.username, sender.password_enc].join('|');
  const hit = transports.get(sender.id);
  if (hit && hit.sig === sig) return hit.transporter;
  hit?.transporter.close?.();
  const nm = await loadNodemailer();
  const transporter = nm.createTransport({
    host: sender.host, port: sender.port, secure: !!sender.secure, requireTLS: !sender.secure,
    auth: sender.username ? { user: sender.username, pass: decryptSecret(sender.password_enc) } : undefined,
    pool: true, maxConnections: 2, maxMessages: 100,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
    ...(config.smtpTlsInsecure ? { tls: { rejectUnauthorized: false } } : {}),
  });
  transports.set(sender.id, { sig, transporter });
  return transporter;
}
export const forgetTransport = (id) => { transports.get(id)?.transporter.close?.(); transports.delete(id); };

export const getSender = (id) => get('SELECT * FROM senders WHERE id=?', id);
export const defaultSender = () => get('SELECT * FROM senders WHERE active=1 AND is_default=1') || get('SELECT * FROM senders WHERE active=1 ORDER BY id LIMIT 1');

/** Messages this sender delivered in the last 24h (campaigns + notifications). */
export function sentLast24h(senderId) {
  const a = get("SELECT COUNT(*) n FROM campaign_recipients WHERE sender_id=? AND status='sent' AND sent_at > datetime('now','-1 day')", senderId).n;
  const b = get("SELECT COUNT(*) n FROM email_log WHERE sender_id=? AND status='sent' AND created_at > datetime('now','-1 day')", senderId).n;
  return a + b;
}

/**
 * Send one message. `sender` may be a senders row, or null for the legacy env-configured transport.
 * Returns { status: 'sent'|'simulated', messageId, response }. Throws on failure with a readable message.
 */
export async function sendMail(sender, msg) {
  const from = sender ? fromHeader(sender) : `"${config.defaultFromName}" <${config.defaultFromEmail}>`;
  const base = { from, to: msg.to, subject: clean(msg.subject), html: msg.html, text: msg.text, headers: msg.headers || {} };
  if (sender?.reply_to) base.replyTo = clean(sender.reply_to);

  if (sender?.mode === 'smtp') {
    const t = await transportFor(sender);
    try {
      const info = await t.sendMail(base);
      if (info.rejected?.length) throw new Error(`Recipient rejected by server: ${info.rejected.join(', ')}`);
      return { status: 'sent', messageId: info.messageId, response: String(info.response || '').slice(0, 300) };
    } catch (e) { throw new Error(explainSmtpError(e, sender)); }
  }
  if (!sender && config.mailTransport === 'webhook') {
    if (!config.mailWebhookUrl) throw new Error('MAIL_WEBHOOK_URL is not configured');
    const r = await fetch(config.mailWebhookUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(config.mailWebhookToken ? { Authorization: `Bearer ${config.mailWebhookToken}` } : {}) },
      body: JSON.stringify(base), signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`Mail webhook responded ${r.status}`);
    return { status: 'sent', messageId: null, response: `webhook ${r.status}` };
  }
  outboxLog.unshift({ at: new Date().toISOString(), to: msg.to, subject: base.subject, from, campaign_id: msg.campaign_id ?? null });
  if (outboxLog.length > 200) outboxLog.length = 200;
  return { status: 'simulated', messageId: null, response: 'simulated (nothing was sent)' };
}

/** Turn low-level SMTP errors into guidance an admin can act on. `sender` lets the hint match the provider. */
export function explainSmtpError(e, sender = null) {
  const code = e.responseCode, msg = String(e.response || e.message || e);
  const host = String(sender?.host || '').toLowerCase();
  if (e.code === 'EAUTH' || code === 535 || code === 534) {
    const hint = host.includes('gmail') || host.includes('google') ? 'Google needs an App Password (2-Step Verification on), not your normal password.'
      : host.includes('office365') || host.includes('outlook') ? 'Microsoft 365 needs SMTP AUTH enabled for this mailbox by your admin.'
      : host.includes('titan') ? 'For Titan, use the mailbox password set in Titan (the one that works in Titan webmail). If unsure, reset it in Titan and re-enter it here.'
      : host.includes('zoho') ? 'Zoho needs an application-specific password if two-factor is on, and the host must match your data centre (smtp.zoho.in for India).'
      : 'Check the username (usually the full email address) and password.';
    return `Authentication failed — the server was reached but rejected the login (${msg.replace(/\s+/g, ' ').slice(0, 100)}). ${hint} Re-type the password with “Show password” ticked, then Verify again.`;
  }
  if (e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT' || e.code === 'ESOCKET' || e.code === 'ECONNECTION') return `Cannot reach the mail server (${e.code}). Check host/port and that outbound SMTP isn't blocked by your network or firewall. Port 587 = STARTTLS, 465 = SSL/TLS.`;
  if (e.code === 'ENOTFOUND' || e.code === 'EDNS') return 'Mail server host name not found. Check the host.';
  if (code === 550 || code === 553 || code === 554) return `Rejected by server: ${msg.slice(0, 200)} (the From address may not be allowed for this account, or the recipient is invalid).`;
  if (code === 421 || code === 450 || code === 451 || code === 452) return `Temporary server refusal: ${msg.slice(0, 200)} (often rate limiting — try again later).`;
  return msg.slice(0, 300);
}

export async function verifySender(sender) {
  if (sender.mode !== 'smtp') return { ok: true, note: 'Simulation sender — nothing to verify.' };
  const t = await transportFor(sender);
  try { await t.verify(); return { ok: true }; } catch (e) { return { ok: false, error: explainSmtpError(e, sender) }; }
}

/** Send a one-off system email (notifications, tests) and record it in the email log. */
export async function sendLogged({ sender, to, subject, html, text, kind, rule_id = null, event = null, headers }) {
  let status, error = null, messageId = null, response = null;
  try { const r = await sendMail(sender, { to, subject, html, text, headers }); status = r.status; messageId = r.messageId; response = r.response; }
  catch (e) { status = 'failed'; error = e.message; }
  run('INSERT INTO email_log (kind,to_email,subject,sender_id,status,error,message_id,response,rule_id,event) VALUES (?,?,?,?,?,?,?,?,?,?)',
    kind, to, String(subject).slice(0, 250), sender?.id ?? null, status, error, messageId, response, rule_id, event);
  return { status, error };
}
