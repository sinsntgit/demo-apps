import crypto from 'node:crypto';
import { all, get, run, tx, nowIso } from './db.js';
import { config } from './config.js';
import { hmac } from './auth.js';
import { resolveSegment } from './segments.js';
import { bad } from './http.js';

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

export function contactVars(c, token) {
  return {
    first_name: c.first_name || '', last_name: c.last_name || '',
    full_name: [c.first_name, c.last_name].filter(Boolean).join(' '),
    email: c.email || '', company: c.account_name || '', title: c.title || '',
    unsubscribe_url: token ? `${config.baseUrl}/u/${token}` : `${config.baseUrl}/u/preview`,
  };
}

/** Render a message. When token is given, links are tracked and an open pixel is added. */
export function renderMessage(campaign, contact, token) {
  const vars = contactVars(contact, token);
  let htmlBody = mergeTags(campaign.body_html, vars);
  const subject = plainMerge(campaign.subject, vars);
  if (token) {
    htmlBody = htmlBody.replace(/href\s*=\s*"(https?:\/\/[^"]+)"/gi, (m, url) => {
      const raw = url.replace(/&amp;/g, '&');
      if (raw.startsWith(`${config.baseUrl}/u/`)) return m;
      return `href="${config.baseUrl}/t/c/${token}?u=${encodeURIComponent(raw)}&amp;s=${signUrl(token, raw)}"`;
    });
  }
  const hasUnsub = /\{\{\s*unsubscribe_url/.test(campaign.body_html);
  const footer = hasUnsub ? '' : `<p style="font-size:12px;color:#6b7280;margin-top:32px;border-top:1px solid #e5e7eb;padding-top:12px">${esc(config.companyAddress)}<br>You received this because you are in our contact list. <a href="${vars.unsubscribe_url}">Unsubscribe</a></p>`;
  const pixel = token ? `<img src="${config.baseUrl}/t/o/${token}.gif" width="1" height="1" alt="" style="display:none">` : '';
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#111827;line-height:1.5;max-width:640px;margin:0 auto;padding:16px">${htmlBody}${footer}${pixel}</body></html>`;
  const text = htmlBody.replace(/<(br|\/p|\/div|\/h\d|\/li)\s*\/?>/gi, '\n').replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim() + `\n\nUnsubscribe: ${vars.unsubscribe_url}`;
  return { subject, html, text };
}

// ---- Transports ----------------------------------------------------------
export const outboxLog = []; // last messages handled by the "log" transport (for the in-app Outbox view)

async function deliver(msg) {
  if (config.mailTransport === 'webhook') {
    if (!config.mailWebhookUrl) throw new Error('MAIL_WEBHOOK_URL is not configured');
    const r = await fetch(config.mailWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.mailWebhookToken ? { Authorization: `Bearer ${config.mailWebhookToken}` } : {}) },
      body: JSON.stringify(msg), signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`Mail webhook responded ${r.status}`);
    return;
  }
  outboxLog.unshift({ at: new Date().toISOString(), to: msg.to, subject: msg.subject, from: msg.from, campaign_id: msg.campaign_id });
  if (outboxLog.length > 200) outboxLog.length = 200;
}

const fromOf = (c) => `${c.from_name || config.defaultFromName} <${c.from_email || config.defaultFromEmail}>`;

export async function sendTest(campaign, to, sampleContact) {
  const m = renderMessage(campaign, sampleContact, null);
  await deliver({ from: fromOf(campaign), to, subject: `[TEST] ${m.subject}`, html: m.html, text: m.text, campaign_id: campaign.id });
}

// ---- Launch / send engine --------------------------------------------------
const active = new Set();

export function validateForLaunch(c) {
  if (!c.segment_id) throw bad('Choose an audience segment before launching');
  if (!c.subject?.trim()) throw bad('Subject line is required');
  if (!c.body_html?.trim()) throw bad('Campaign content is empty');
  const seg = get('SELECT * FROM segments WHERE id=?', c.segment_id);
  if (!seg) throw bad('The selected segment no longer exists');
  return seg;
}

/** Freeze the audience into recipient rows and begin sending. */
export function launchCampaign(id) {
  const c = get('SELECT * FROM campaigns WHERE id=?', id);
  if (!c) throw bad('Campaign not found');
  if (!['draft', 'scheduled'].includes(c.status)) throw bad(`Campaign is already ${c.status}`);
  const seg = validateForLaunch(c);
  const contacts = resolveSegment(seg.filter);
  if (!contacts.length) throw bad('This segment has no emailable (subscribed, with email) contacts');
  tx(() => {
    for (const ct of contacts) {
      run('INSERT INTO campaign_recipients (campaign_id,contact_id,email,token) VALUES (?,?,?,?)', id, ct.id, ct.email, crypto.randomBytes(12).toString('base64url'));
    }
    run("UPDATE campaigns SET status='sending' WHERE id=?", id);
  });
  processCampaign(id);
  return { recipients: contacts.length };
}

export function processCampaign(id) {
  if (active.has(id)) return;
  active.add(id);
  (async () => {
    try {
      const c = get('SELECT * FROM campaigns WHERE id=?', id);
      for (;;) {
        const batch = all(`SELECT r.*, ct.first_name, ct.last_name, ct.title, ac.name AS account_name
          FROM campaign_recipients r LEFT JOIN contacts ct ON ct.id=r.contact_id LEFT JOIN accounts ac ON ac.id=ct.account_id
          WHERE r.campaign_id=? AND r.status='queued' LIMIT ?`, id, config.sendBatchSize);
        if (!batch.length) break;
        for (const r of batch) {
          // Skip anyone who unsubscribed after the audience was frozen
          const still = r.contact_id ? get('SELECT subscribed FROM contacts WHERE id=?', r.contact_id) : { subscribed: 1 };
          if (still && !still.subscribed) { run("UPDATE campaign_recipients SET status='failed', error='Unsubscribed before send' WHERE id=?", r.id); continue; }
          try {
            const m = renderMessage(c, { ...r, email: r.email }, r.token);
            await deliver({ from: fromOf(c), to: r.email, subject: m.subject, html: m.html, text: m.text, campaign_id: id,
              headers: { 'List-Unsubscribe': `<${config.baseUrl}/u/${r.token}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } });
            run("UPDATE campaign_recipients SET status='sent', sent_at=? WHERE id=?", nowIso(), r.id);
          } catch (e) {
            run("UPDATE campaign_recipients SET status='failed', error=? WHERE id=?", String(e.message).slice(0, 300), r.id);
          }
        }
        await new Promise((res) => setTimeout(res, config.sendDelayMs));
      }
      run("UPDATE campaigns SET status='sent', sent_at=? WHERE id=? AND status='sending'", nowIso(), id);
    } catch (e) { console.error('Campaign send failed', id, e); }
    finally { active.delete(id); }
  })();
}

export function startScheduler() {
  const tick = () => {
    try {
      for (const c of all("SELECT id FROM campaigns WHERE status='scheduled' AND scheduled_at <= ?", nowIso())) {
        try { launchCampaign(c.id); } catch (e) { console.error('Scheduled launch failed', c.id, e.message); run("UPDATE campaigns SET status='draft' WHERE id=?", c.id); }
      }
      for (const c of all("SELECT id FROM campaigns WHERE status='sending'")) processCampaign(c.id); // resume after restart
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
  out.top_links = all("SELECT url, COUNT(*) AS clicks, COUNT(DISTINCT recipient_id) AS unique_clicks FROM campaign_events WHERE campaign_id=? AND type='click' GROUP BY url ORDER BY clicks DESC LIMIT 10", id);
  out.timeline = all("SELECT DATE(created_at) AS day, SUM(type='open') AS opens, SUM(type='click') AS clicks FROM campaign_events WHERE campaign_id=? AND type IN ('open','click') GROUP BY DATE(created_at) ORDER BY day", id)
    .map((r) => ({ day: r.day, opens: n(r.opens), clicks: n(r.clicks) }));
  return out;
}
