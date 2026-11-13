import crypto from 'node:crypto';
import { all, get, run, tx, nowIso } from './db.js';
import { config } from './config.js';
import { hmac } from './auth.js';
import { resolveSegment } from './segments.js';
import { bad } from './http.js';
import { runReminders } from './receivables.js';
import { maybeDailyBackup } from './backup.js';
import { sendMail, getSender, defaultSender, sentLast24h } from './mailer.js';
import { addressReach } from './deliverability.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const MERGE_TAGS = ['first_name', 'last_name', 'full_name', 'email', 'company', 'title', 'unsubscribe_url'];

/** Replace {{tag}} (HTML-escaped values; optional fallback: {{first_name|there}}). */
export function mergeTags(template, vars) {
  return String(template).replace(/\{\{\s*(\w+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g, (m, k, fallback) => {
    if (!(k in vars)) return m;
    const v = vars[k];
    if (k === 'unsubscribe_url') return v;
    return esc(v || fallback || '');
  });
}
const plainMerge = (t, vars) => String(t).replace(/\{\{\s*(\w+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g, (m, k, fb) => (k in vars ? (vars[k] || fb || '') : m));

export const signUrl = (token, url) => hmac(`${token}|${url}`).slice(0, 22);

/** Can recipients reach our tracking/unsubscribe links? (ALLOW_PRIVATE_TRACKING=1 for internal-only audiences on the same network.) */
export const webLinksWork = () => addressReach().public || process.env.ALLOW_PRIVATE_TRACKING === '1';
/** Unsubscribe by email — used when the CRM is not reachable from the internet. */
export const unsubMailto = (sender) => `mailto:${encodeURIComponent(sender?.reply_to || sender?.from_email || config.defaultFromEmail).replace(/%40/g, '@')}?subject=Unsubscribe`;
/** Whether a campaign's emails get tracked links and an open pixel, and why not. */
export function trackingPlan(c) {
  if (c.track === 0) return { tracked: false, note: 'Open and click tracking was turned off for this campaign.' };
  if (!webLinksWork()) return { tracked: false, note: `${addressReach().reason} Set an internet address under Settings → Email delivery to track opens and clicks.` };
  return { tracked: true, note: null };
}

export function contactVars(c, token, unsubscribe) {
  return {
    first_name: c.first_name || '', last_name: c.last_name || '',
    full_name: [c.first_name, c.last_name].filter(Boolean).join(' '),
    email: c.email || '', company: c.account_name || '', title: c.title || '',
    unsubscribe_url: unsubscribe || (token ? `${config.baseUrl}/u/${token}` : `${config.baseUrl}/u/preview`),
  };
}

/** Render a message. When token is given, links are tracked and an open pixel is added. */
export function renderMessage(campaign, contact, token) {
  const web = webLinksWork();
  const track = !!token && (campaign.tracked != null ? !!campaign.tracked : trackingPlan(campaign).tracked);
  const vars = contactVars(contact, token, web ? null : unsubMailto(resolveSender(campaign)));
  let htmlBody = mergeTags(campaign.body_html, vars);
  const subject = plainMerge(campaign.subject, vars);
  if (track) {
    htmlBody = htmlBody.replace(/href\s*=\s*"(https?:\/\/[^"]+)"/gi, (m, url) => {
      const raw = url.replace(/&amp;/g, '&');
      if (raw.startsWith(`${config.baseUrl}/u/`)) return m;
      return `href="${config.baseUrl}/t/c/${token}?u=${encodeURIComponent(raw)}&amp;s=${signUrl(token, raw)}"`;
    });
  }
  const hasUnsub = /\{\{\s*unsubscribe_url/.test(campaign.body_html);
  const footer = hasUnsub ? '' : `<p style="font-size:12px;color:#6b7280;margin-top:32px;border-top:1px solid #e5e7eb;padding-top:12px">${esc(config.companyAddress)}<br>You received this because you are in our contact list. ${web ? `<a href="${vars.unsubscribe_url}">Unsubscribe</a>` : `To stop receiving these emails, <a href="${vars.unsubscribe_url}">reply with “Unsubscribe”</a>.`}</p>`;
  // a 1×1 image that mail apps load with the message; not display:none — some apps skip hidden images
  const pixel = track ? `<img src="${config.baseUrl}/t/o/${token}.gif" width="1" height="1" alt="" border="0" style="height:1px!important;width:1px!important;border:0;margin:0;padding:0">` : '';
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#111827;line-height:1.5;max-width:640px;margin:0 auto;padding:16px">${htmlBody}${footer}${pixel}</body></html>`;
  const text = htmlBody.replace(/<(br|\/p|\/div|\/h\d|\/li)\s*\/?>/gi, '\n').replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim() + `\n\nUnsubscribe: ${vars.unsubscribe_url}`;
  return { subject, html, text, unsubscribe: vars.unsubscribe_url, tracked: track };
}

// ---- Sender resolution & sending -------------------------------------------
export { outboxLog } from './mailer.js';

/** The sender a campaign will use: its chosen one, else the default, else null (legacy env transport / simulation). */
export function resolveSender(c) {
  const s = c.sender_id ? getSender(c.sender_id) : defaultSender();
  return s || null;
}
export const isSimulated = (sender) => (sender ? sender.mode === 'simulate' : config.mailTransport !== 'webhook');

export async function sendTest(campaign, to, sampleContact) {
  const m = renderMessage(campaign, sampleContact, null);
  const sender = resolveSender(campaign);
  const r = await sendMail(sender, { to, subject: `[TEST] ${m.subject}`, html: m.html, text: m.text, campaign_id: campaign.id, copyToSent: true });
  return { ...r, sender };
}

// ---- Launch / send engine --------------------------------------------------
const active = new Set();

export function validateForLaunch(c) {
  if (!c.segment_id) throw bad('Choose an audience segment before launching');
  if (!c.subject?.trim()) throw bad('Subject line is required');
  if (!c.body_html?.trim()) throw bad('Campaign content is empty');
  const seg = get('SELECT * FROM segments WHERE id=?', c.segment_id);
  if (!seg) throw bad('The selected segment no longer exists');
  if (c.sender_id) {
    const s = getSender(c.sender_id);
    if (!s) throw bad('The selected sender no longer exists');
    if (!s.active) throw bad(`Sender "${s.label}" is disabled`);
  }
  return seg;
}

/** Freeze the audience into recipient rows and begin sending. */
export function launchCampaign(id) {
  const c = get('SELECT * FROM campaigns WHERE id=?', id);
  if (!c) throw bad('Campaign not found');
  if (!['draft', 'scheduled'].includes(c.status)) throw bad(`Campaign is already ${c.status}`);
  const seg = validateForLaunch(c);
  const sender = resolveSender(c);
  const contacts = resolveSegment(seg.filter);
  if (!contacts.length) throw bad('This segment has no emailable (subscribed, with email) contacts');
  tx(() => {
    for (const ct of contacts) {
      run('INSERT INTO campaign_recipients (campaign_id,contact_id,email,token,sender_id) VALUES (?,?,?,?,?)', id, ct.id, ct.email, crypto.randomBytes(12).toString('base64url'), sender?.id ?? null);
    }
    const plan = trackingPlan(c);
    run("UPDATE campaigns SET status='sending', sender_id=?, simulated=?, note=NULL, tracked=?, tracking_note=? WHERE id=?", sender?.id ?? null, isSimulated(sender) ? 1 : 0, plan.tracked ? 1 : 0, plan.note, id);
  });
  processCampaign(id);
  return { recipients: contacts.length, simulated: isSimulated(sender), sender: sender?.label || null, tracked: trackingPlan(c).tracked };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function processCampaign(id) {
  if (active.has(id)) return;
  active.add(id);
  (async () => {
    try {
      const c = get('SELECT * FROM campaigns WHERE id=?', id);
      const sender = c.sender_id ? getSender(c.sender_id) : null;
      const delay = sender && sender.mode === 'smtp' ? sender.delay_ms : config.sendDelayMs;
      let paused = false;
      for (;;) {
        const batch = all(`SELECT r.*, ct.first_name, ct.last_name, ct.title, ac.name AS account_name
          FROM campaign_recipients r LEFT JOIN contacts ct ON ct.id=r.contact_id LEFT JOIN accounts ac ON ac.id=ct.account_id
          WHERE r.campaign_id=? AND r.status='queued' LIMIT ?`, id, config.sendBatchSize);
        if (!batch.length) break;
        for (const r of batch) {
          if (sender && sender.mode === 'smtp' && sentLast24h(sender.id) >= sender.daily_limit) { paused = true; break; }
          // Skip anyone who unsubscribed after the audience was frozen
          const still = r.contact_id ? get('SELECT subscribed FROM contacts WHERE id=?', r.contact_id) : { subscribed: 1 };
          if (still && !still.subscribed) { run("UPDATE campaign_recipients SET status='failed', error='Unsubscribed before send' WHERE id=?", r.id); continue; }
          try {
            const m = renderMessage(c, { ...r, email: r.email }, r.token);
            const res = await sendMail(sender, { to: r.email, subject: m.subject, html: m.html, text: m.text, campaign_id: id, copyToSent: true,
              headers: m.unsubscribe.startsWith('mailto:') ? { 'List-Unsubscribe': `<${m.unsubscribe}>` }
                : { 'List-Unsubscribe': `<${config.baseUrl}/u/${r.token}>, <${unsubMailto(sender)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } });
            run("UPDATE campaign_recipients SET status='sent', sent_at=?, message_id=?, response=?, error=NULL WHERE id=?", nowIso(), res.messageId, res.response, r.id);
            if (res.sent_copy === 'saved') run('UPDATE campaigns SET copies_saved=copies_saved+1 WHERE id=?', id);
            else if (res.sent_copy === 'failed') run('UPDATE campaigns SET copies_failed=copies_failed+1, copy_error=? WHERE id=?', res.copy_error, id);
          } catch (e) {
            run("UPDATE campaign_recipients SET status='failed', error=? WHERE id=?", String(e.message).slice(0, 400), r.id);
          }
          await sleep(delay);
        }
        if (paused) break;
      }
      if (paused) run("UPDATE campaigns SET note=? WHERE id=?", `Paused: "${sender.label}" reached its daily limit of ${sender.daily_limit}. Remaining emails send automatically as the 24-hour window frees up.`, id);
      else run("UPDATE campaigns SET status='sent', sent_at=?, note=NULL WHERE id=? AND status='sending'", nowIso(), id);
    } catch (e) { console.error('Campaign send failed', id, e); }
    finally { active.delete(id); }
  })();
}

export function startScheduler() {
  const tick = () => {
    runReminders().catch((e) => console.error('Reminder run failed', e));
    try { maybeDailyBackup(); } catch (e) { console.error('Daily backup failed', e.message); }
    try {
      for (const c of all("SELECT id FROM campaigns WHERE status='scheduled' AND scheduled_at <= ?", nowIso())) {
        try { launchCampaign(c.id); } catch (e) { console.error('Scheduled launch failed', c.id, e.message); run("UPDATE campaigns SET status='draft', note=? WHERE id=?", `Scheduled send failed: ${e.message}`, c.id); }
      }
      for (const c of all("SELECT id FROM campaigns WHERE status='sending'")) processCampaign(c.id); // resume after restart / daily-limit pause
    } catch (e) { console.error('Scheduler error', e); }
  };
  tick();
  return setInterval(tick, 30000);
}

// ---- Tracking & stats --------------------------------------------------------
export function recordEvent(token, type, url) {
  const r = get('SELECT id,campaign_id,first_open_at,first_click_at FROM campaign_recipients WHERE token=?', token);
  if (!r) return null;
  const now = nowIso();
  run('INSERT INTO campaign_events (campaign_id,recipient_id,type,url) VALUES (?,?,?,?)', r.campaign_id, r.id, type, url ?? null);
  if (type === 'open') run('UPDATE campaign_recipients SET open_count=open_count+1, first_open_at=COALESCE(first_open_at,?) WHERE id=?', now, r.id);
  if (type === 'click') run('UPDATE campaign_recipients SET click_count=click_count+1, first_click_at=COALESCE(first_click_at,?), first_open_at=COALESCE(first_open_at,?) WHERE id=?', now, now, r.id);
  return r;
}

export function campaignStats(id) {
  const s = get(`SELECT COUNT(*) AS total,
    SUM(status='sent') AS sent, SUM(status='failed') AS failed, SUM(status='queued') AS queued,
    SUM(first_open_at IS NOT NULL) AS opened, SUM(first_click_at IS NOT NULL) AS clicked,
    SUM(unsubscribed_at IS NOT NULL) AS unsubscribed, COALESCE(SUM(open_count),0) AS total_opens, COALESCE(SUM(click_count),0) AS total_clicks
    FROM campaign_recipients WHERE campaign_id=?`, id);
  const n = (v) => Number(v || 0);
  const out = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, n(v)]));
  const base = out.sent || 0;
  out.open_rate = base ? out.opened / base : 0;
  out.click_rate = base ? out.clicked / base : 0;
  out.click_to_open = out.opened ? out.clicked / out.opened : 0;
  out.unsub_rate = base ? out.unsubscribed / base : 0;
  out.failures = all("SELECT error, COUNT(*) AS n FROM campaign_recipients WHERE campaign_id=? AND status='failed' GROUP BY error ORDER BY n DESC LIMIT 5", id);
  out.top_links = all("SELECT url, COUNT(*) AS clicks, COUNT(DISTINCT recipient_id) AS unique_clicks FROM campaign_events WHERE campaign_id=? AND type='click' GROUP BY url ORDER BY clicks DESC LIMIT 10", id);
  out.timeline = all("SELECT DATE(created_at) AS day, SUM(type='open') AS opens, SUM(type='click') AS clicks FROM campaign_events WHERE campaign_id=? AND type IN ('open','click') GROUP BY DATE(created_at) ORDER BY day", id)
    .map((r) => ({ day: r.day, opens: n(r.opens), clicks: n(r.clicks) }));
  return out;
}
