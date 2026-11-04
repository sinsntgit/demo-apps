import { run, nowIso } from './db.js';
import { getBilling, logEvent } from './invoicing.js';

/**
 * Hand an issued invoice to your certified e-invoicing provider (ASP / ZATCA-integrated solution).
 * Contract (JSON POST, optional Bearer token): { number, uuid, type, jurisdiction, issue_date, currency, total, vat_total, hash, icv, qr, xml_base64 }
 * Expected reply: { status: "cleared" | "reported" | "rejected", message?, errors?: [...] }
 * NOTE: ZATCA clearance/reporting requires onboarding (CSID) and a cryptographically signed XML. This app generates the unsigned UBL, hash and QR;
 * signing and submission are performed by the provider you configure here.
 */
export async function submitToProvider(inv, user) {
  const b = getBilling({ withSecrets: true });
  if (b.asp.mode !== 'webhook' || !b.asp.url) return { status: 'ready', message: 'No provider connected: invoice is generated and validated but not submitted to the tax authority.' };
  let res, body = {};
  try {
    res = await fetch(b.asp.url, {
      method: 'POST', signal: AbortSignal.timeout(25000),
      headers: { 'content-type': 'application/json', ...(b.asp.token ? { authorization: `Bearer ${b.asp.token}` } : {}) },
      body: JSON.stringify({ number: inv.number, uuid: inv.uuid, type: inv.doc_type, jurisdiction: inv.jurisdiction, issue_date: inv.issue_date, currency: inv.currency, total: inv.total, vat_total: inv.vat_total, hash: inv.invoice_hash, icv: inv.icv, qr: inv.qr, xml_base64: Buffer.from(inv.xml, 'utf8').toString('base64') }),
    });
    body = await res.json().catch(() => ({}));
  } catch (e) {
    return finish(inv, 'failed', `Could not reach the provider (${e.name === 'TimeoutError' ? 'timed out' : e.message}). Retry from the invoice page.`, user);
  }
  if (!res.ok) return finish(inv, 'failed', `Provider error ${res.status}: ${String(body.message || '').slice(0, 200) || 'no details'}`, user);
  const st = ['cleared', 'reported', 'rejected'].includes(body.status) ? body.status : 'failed';
  const msg = st === 'failed' ? 'Provider returned an unrecognised status.' : [body.message, ...(Array.isArray(body.errors) ? body.errors : [])].filter(Boolean).join(' · ').slice(0, 800) || st;
  return finish(inv, st, msg, user);
}
function finish(inv, status, message, user) {
  run('UPDATE invoices SET compliance_status=?, compliance_response=?, compliance_at=? WHERE id=?', status, message, nowIso(), inv.id);
  logEvent(inv.id, `compliance_${status}`, message, user);
  return { status, message };
}

/** SMS / WhatsApp through your own gateway (Twilio, Unifonic, Meta WhatsApp Cloud API relay, ...). JSON: { channel, to, message, invoice_number } */
export async function sendViaMessaging({ channel, to, message, invoice_number }) {
  const b = getBilling({ withSecrets: true });
  if (b.messaging.mode !== 'webhook' || !b.messaging.url) return { ok: false, notConfigured: true };
  try {
    const r = await fetch(b.messaging.url, { method: 'POST', signal: AbortSignal.timeout(20000), headers: { 'content-type': 'application/json', ...(b.messaging.token ? { authorization: `Bearer ${b.messaging.token}` } : {}) }, body: JSON.stringify({ channel, to, message, invoice_number }) });
    return r.ok ? { ok: true } : { ok: false, error: `Gateway responded ${r.status}` };
  } catch (e) { return { ok: false, error: e.name === 'TimeoutError' ? 'Gateway timed out' : e.message }; }
}
