import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from './config.js';

/*
 * Deliverability helpers:
 *  - addressReach(): can people on the internet reach the CRM's public address? Open/click tracking and the unsubscribe
 *    page only work when they can — otherwise links in emails would point at a private address (broken for the reader,
 *    and a strong spam signal), so campaigns then go out without tracking.
 *  - lintCampaign(): content patterns that push mail into spam / Promotions.
 *  - checkDomain(): SPF, DKIM, DMARC and MX for the sender's domain, read from public DNS.
 */

const PRIVATE_V4 = [/^10\./, /^127\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
export function addressReach(url = config.baseUrl) {
  let u; try { u = new URL(url); } catch { return { public: false, https: false, host: '', reason: 'The public address is not a valid URL.' }; }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase(), https = u.protocol === 'https:';
  const priv = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal') || host.endsWith('.home')
    || (net.isIPv4(host) && PRIVATE_V4.some((r) => r.test(host))) || (net.isIPv6(host) && /^(::1|f[cd]|fe80)/.test(host)) || (!net.isIP(host) && !host.includes('.'));
  if (priv) return { public: false, https, host, reason: `${url} is a private address (this computer or your office network). People who receive your emails cannot reach it, so opens, clicks and the unsubscribe page cannot work.` };
  return { public: true, https, host, reason: https ? null : 'The public address uses http:// — use https:// so links are not flagged as insecure.' };
}

const SPAMMY = ['free', 'guarantee', 'guaranteed', 'winner', 'won', 'cash', 'act now', 'urgent', 'limited time', 'click here', 'buy now', 'order now', '100%', 'risk-free', 'risk free', 'no cost', 'earn money', 'make money', 'double your', 'congratulations', 'offer expires', 'call now', 'cheap', 'lowest price', 'best price', 'dear friend', 'credit card', 'no obligation'];
const SHORTENERS = /https?:\/\/(bit\.ly|tinyurl\.com|goo\.gl|t\.co|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly|shorturl\.at)\//i;

/** Warnings about the content, most important first. Each is { level: 'high'|'medium'|'tip', text }. */
export function lintCampaign({ subject = '', body_html = '' } = {}) {
  const w = []; const add = (level, text) => w.push({ level, text });
  const text = body_html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\{\{[^}]+\}\}/g, 'x').replace(/\s+/g, ' ').trim();
  const words = text ? text.split(' ').length : 0;
  const links = [...body_html.matchAll(/href\s*=\s*"(https?:\/\/[^"]+)"/gi)].map((m) => m[1]);
  const images = (body_html.match(/<img\b/gi) || []).length;
  const subj = subject.replace(/\{\{[^}]+\}\}/g, '');
  const letters = subj.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 8 && letters === letters.toUpperCase()) add('high', 'The subject is in CAPITAL LETTERS — a classic spam signal. Write it in normal sentence case.');
  if (/[!?]{2,}|!.*!/.test(subj)) add('high', 'The subject has several exclamation marks. Use none or one.');
  if (/[$€£₹]{2,}|\$\d/.test(subj)) add('medium', 'Money amounts or symbols in the subject are often filtered as spam.');
  const hits = SPAMMY.filter((p) => new RegExp(`(^|[^a-z])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i').test(`${subj} ${text}`));
  if (hits.length) add(hits.length > 2 ? 'high' : 'medium', `Words that spam filters and Gmail's Promotions tab react to: ${hits.slice(0, 6).map((h) => `“${h}”`).join(', ')}. Rephrase them in plain, specific language.`);
  if (SHORTENERS.test(body_html)) add('high', 'Link shorteners (bit.ly, tinyurl…) are heavily used by spammers. Link to your own website instead.');
  if (links.some((l) => /^https?:\/\/(\d{1,3}\.){3}\d{1,3}/.test(l))) add('high', 'A link points to a raw IP address. Use a domain name.');
  if (images && words < 60) add('high', 'Mostly image, little text. Filters cannot read images — write the message as text and keep images small and few.');
  if (links.length > 3) add('medium', `${links.length} links. Personal-looking emails with one or two links are far more likely to reach the inbox (and Gmail's Primary tab).`);
  if (images > 2) add('medium', `${images} images. Heavy, newsletter-style layouts are sent to Promotions — fewer images look more personal.`);
  if (!/\{\{\s*first_name/.test(body_html + subject)) add('tip', 'Greet people by name ({{first_name|there}}). Personal emails are more likely to land in Primary.');
  if (words > 400) add('tip', `${words} words. Short, conversational emails (under ~200 words) perform better.`);
  if (/<(table|style)\b/i.test(body_html) && /background(-color)?\s*:/i.test(body_html)) add('tip', 'Designed, newsletter-style HTML (tables, backgrounds) tells Gmail it is a promotion. A plain letter-style email is more likely to reach Primary.');
  if (!config.companyAddress || /123 Example|example/i.test(config.companyAddress)) add('medium', 'Set your real postal address (COMPANY_ADDRESS) — bulk-mail rules and filters expect one in the footer.');
  return w;
}

// The include each provider's SPF must have; and DKIM selectors to look for (we cannot list a domain's DKIM keys, only try names).
const PROVIDERS = [
  { test: /secureserver\.net/, name: 'GoDaddy', spf: /secureserver\.net/, spfHint: 'include:secureserver.net', selectors: ['default', 'titan1', 'titan', 'selector1', 'selector2', 'gd', 'k1'] },
  { test: /titan\.email/, name: 'Titan', spf: /titan\.email/, spfHint: 'include:spf.titan.email', selectors: ['titan1', 'titan', 'default', 'k1'] },
  { test: /gmail|google/, name: 'Google', spf: /_spf\.google\.com/, spfHint: 'include:_spf.google.com', selectors: ['google', 'google1', 'default'] },
  { test: /office365|outlook/, name: 'Microsoft 365', spf: /spf\.protection\.outlook\.com/, spfHint: 'include:spf.protection.outlook.com', selectors: ['selector1', 'selector2'] },
  { test: /zoho/, name: 'Zoho', spf: /zoho\.(com|in|eu)/, spfHint: 'include:zoho.in (or zoho.com)', selectors: ['zmail', 'zoho', 'default', 'mail'] },
];
const FREEMAIL = /^(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|icloud|me|aol|rediffmail|proton|protonmail|zoho)\.[a-z.]+$/;
const txt = async (name) => { try { return (await dns.resolveTxt(name)).map((r) => r.join('')); } catch { return []; } };

/** Check the sender's domain in public DNS. Each item: { key, label, status: 'ok'|'warn'|'bad', detail, fix }. */
export async function checkDomain(sender) {
  const domain = String(sender.from_email || '').split('@')[1]?.toLowerCase() || '';
  const prov = PROVIDERS.find((p) => p.test.test(String(sender.host || '').toLowerCase()));
  const items = [];
  const item = (key, label, status, detail, fix = null) => items.push({ key, label, status, detail, fix });
  if (!domain) return { domain, items: [{ key: 'domain', label: 'From address', status: 'bad', detail: 'No domain in the From address.' }] };
  if (FREEMAIL.test(domain)) return { domain, provider: prov?.name || null, items: [{ key: 'domain', label: 'Sending from a free mailbox', status: 'warn', detail: `${domain} belongs to the email provider, so you cannot add SPF, DKIM or DMARC for it. Gmail and Yahoo limit and filter bulk mail sent from free addresses.`, fix: 'Send campaigns from an address on your own domain (e.g. you@syncsense.in), where you control those records.' }] };
  // make sure public DNS is reachable from here before reporting anything as missing
  try { await dns.resolveMx('gmail.com'); } catch (e) {
    return { domain, provider: prov?.name || null, items: [{ key: 'dns', label: 'DNS lookup', status: 'warn', detail: `This computer could not look up public DNS (${e.code || e.message}), so the records could not be checked.`, fix: `Check from any computer with internet access at mxtoolbox.com (SPF, DKIM, DMARC lookups for ${domain}), or try again later.` }] };
  }

  let mx = []; try { mx = await dns.resolveMx(domain); } catch { /* none */ }
  if (mx.length) item('mx', 'MX (can receive replies)', 'ok', mx.sort((a, b) => a.priority - b.priority).slice(0, 2).map((m) => m.exchange).join(', '));
  else item('mx', 'MX (can receive replies)', 'bad', `No MX record for ${domain}, or DNS could not be reached from this computer.`, 'Your domain must be able to receive email — check the MX records at your DNS host.');

  const spf = (await txt(domain)).filter((t) => /^v=spf1\b/i.test(t));
  if (!spf.length) item('spf', 'SPF', 'bad', `No SPF record on ${domain}.`, `Add a TXT record on ${domain}: v=spf1 ${prov ? prov.spfHint + ' ' : ''}~all`);
  else if (spf.length > 1) item('spf', 'SPF', 'bad', `${spf.length} SPF records — receivers treat that as an error.`, 'Merge them into one TXT record that starts with v=spf1.');
  else if (prov && !prov.spf.test(spf[0])) item('spf', 'SPF', 'bad', `${spf[0]} — does not include ${prov.name}, which sends your mail.`, `Add ${prov.spfHint} to that record, before the ~all.`);
  else item('spf', 'SPF', /\+all\b/.test(spf[0]) ? 'warn' : 'ok', spf[0], /\+all\b/.test(spf[0]) ? '+all lets anyone send as you — use ~all or -all.' : null);

  const selectors = [...new Set([...(prov?.selectors || []), 'default', 'selector1', 'selector2', 'google', 'k1', 's1', 's2', 'dkim', 'mail', 'titan1', 'zmail'])];
  let dkim = null;
  for (const s of selectors) {
    const recs = await txt(`${s}._domainkey.${domain}`);
    if (recs.some((r) => /v=DKIM1|k=rsa|p=/i.test(r))) { dkim = s; break; }
    try { const c = await dns.resolveCname(`${s}._domainkey.${domain}`); if (c.length) { dkim = s; break; } } catch { /* none */ }
  }
  if (dkim) item('dkim', 'DKIM (signature)', 'ok', `Found the key “${dkim}._domainkey.${domain}”.`);
  else item('dkim', 'DKIM (signature)', 'warn', 'No DKIM key found under the usual names. It may exist under another name, but if DKIM is off, Gmail and Yahoo treat bulk mail as suspicious.',
    `Turn on DKIM in your ${prov ? prov.name : 'email provider'}'s admin console${prov?.name === 'GoDaddy' ? ' (GoDaddy: Email & Office dashboard → your domain → DKIM / “Email authentication”; Titan: Admin panel → Domain → DKIM)' : ''} and add the TXT/CNAME record it gives you.`);

  const dmarc = (await txt(`_dmarc.${domain}`)).find((t) => /^v=DMARC1/i.test(t));
  if (!dmarc) item('dmarc', 'DMARC', 'bad', `No DMARC record at _dmarc.${domain}. Gmail and Yahoo require one from bulk senders.`, `Add a TXT record named _dmarc with: v=DMARC1; p=none; rua=mailto:${sender.reply_to || sender.from_email}`);
  else item('dmarc', 'DMARC', 'ok', dmarc);

  const reach = addressReach();
  if (!reach.public) item('tracking', 'Tracking & unsubscribe address', 'warn', reach.reason + ' Campaigns are sent without tracked links; unsubscribe works by reply.', 'Make the CRM reachable from the internet over https (for example with a Cloudflare Tunnel) and enter that address under Settings → Email delivery → Public address.');
  else if (!reach.https) item('tracking', 'Tracking & unsubscribe address', 'warn', reach.reason, 'Serve the CRM over https and update the public address.');
  else {
    const same = reach.host === domain || reach.host.endsWith(`.${domain}`);
    item('tracking', 'Tracking & unsubscribe address', same ? 'ok' : 'warn', `${config.baseUrl}${same ? '' : ` — a different domain from ${domain}`}`, same ? null : `Links on a domain that matches the sender (e.g. crm.${domain}) look more trustworthy than a tunnel or hosting domain.`);
  }
  if (prov && ['GoDaddy', 'Titan'].includes(prov.name)) item('volume', 'Sending service', 'warn', `${prov.name} mailboxes are made for person-to-person email. Bulk campaigns from them share IP reputation with other customers and have low daily limits.`, 'For regular campaigns above a few hundred emails, send through a bulk email service (Brevo, Amazon SES, Mailgun, Postmark) on a subdomain such as news.' + domain + '.');
  return { domain, provider: prov?.name || null, items };
}
