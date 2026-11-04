import { all, get } from './db.js';
import { config } from './config.js';
import { getSender, defaultSender, sendLogged } from './mailer.js';

export const EVENTS = {
  'contact.created': 'Contact added',
  'contact.imported': 'Contacts imported (one summary email)',
  'contact.updated': 'Contact updated',
  'contact.deleted': 'Contact deleted',
  'account.created': 'Account created',
  'deal.created': 'Deal created',
  'deal.updated': 'Deal updated (any field)',
  'deal.stage_changed': 'Deal stage changed',
  'deal.won': 'Deal won',
  'deal.lost': 'Deal lost',
  'deal.deleted': 'Deal deleted',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

export const parseEmails = (s) => String(s || '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter((x) => EMAIL_RE.test(x));

function describe(event, rec) {
  const kind = event.split('.')[0];
  if (kind === 'contact') return { label: [rec.first_name, rec.last_name].filter(Boolean).join(' ') || rec.email || 'contact', path: rec.id ? `#/contacts/${rec.id}` : '#/contacts' };
  if (kind === 'deal') return { label: rec.name, path: rec.id ? `#/deals/${rec.id}` : '#/deals' };
  if (kind === 'account') return { label: rec.name, path: rec.id ? `#/accounts/${rec.id}` : '#/accounts' };
  return { label: '', path: '' };
}

function facts(event, rec) {
  const rows = [];
  if (event.startsWith('deal.')) rows.push(['Deal', rec.name], ['Amount', money(rec.amount)], ['Stage', rec.stage], ['Probability', `${rec.probability}%`], ['Account', rec.account_name], ['Expected close', rec.close_date], ['Owner', rec.owner_name]);
  else if (event.startsWith('contact.') && event !== 'contact.imported') rows.push(['Name', [rec.first_name, rec.last_name].filter(Boolean).join(' ')], ['Email', rec.email], ['Phone', rec.phone], ['Title', rec.title], ['Company', rec.account_name], ['Status', rec.status], ['Source', rec.source], ['Owner', rec.owner_name]);
  else if (event === 'account.created') rows.push(['Account', rec.name], ['Industry', rec.industry], ['Location', [rec.city, rec.country].filter(Boolean).join(', ')], ['Owner', rec.owner_name]);
  return rows.filter(([, v]) => v !== null && v !== undefined && v !== '');
}

function defaultSubject(event, rec, ctx) {
  const d = describe(event, rec);
  switch (event) {
    case 'contact.created': return `New contact added: ${d.label}`;
    case 'contact.imported': return `${ctx.count} contacts imported`;
    case 'contact.updated': return `Contact updated: ${d.label}`;
    case 'contact.deleted': return `Contact deleted: ${d.label}`;
    case 'account.created': return `New account: ${d.label}`;
    case 'deal.created': return `New deal: ${d.label} (${money(rec.amount)})`;
    case 'deal.stage_changed': return `Deal moved to ${rec.stage}: ${d.label}`;
    case 'deal.won': return `🎉 Deal won: ${d.label} (${money(rec.amount)})`;
    case 'deal.lost': return `Deal lost: ${d.label}`;
    case 'deal.deleted': return `Deal deleted: ${d.label}`;
    default: return `Deal updated: ${d.label}`;
  }
}

const fill = (tpl, vars) => String(tpl).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in vars ? String(vars[k] ?? '') : m));

function render(event, rec, ctx, rule, actor) {
  const d = describe(event, rec);
  const vars = { name: d.label, event: EVENTS[event], actor: actor?.name || 'Someone', stage: rec.stage, amount: rec.amount != null ? money(rec.amount) : '', owner: rec.owner_name || '' };
  const subject = (rule.subject_template ? fill(rule.subject_template, vars) : defaultSubject(event, rec, ctx)).replace(/[\r\n]+/g, ' ').slice(0, 200);
  const rows = facts(event, rec);
  const changes = (ctx.changes || []).map((c) => `<tr><td style="padding:4px 12px 4px 0;color:#6b7280">${esc(c.field)}</td><td style="padding:4px 0">${esc(c.from ?? '—')} &rarr; <b>${esc(c.to ?? '—')}</b></td></tr>`).join('');
  const link = d.path ? `${config.baseUrl}/${d.path}` : config.baseUrl;
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;color:#111827">
    <p style="color:#6b7280;margin:0 0 4px">${esc(EVENTS[event])} · by ${esc(vars.actor)}</p>
    <h2 style="margin:0 0 12px">${esc(subject)}</h2>
    ${rule.intro ? `<p>${esc(rule.intro)}</p>` : ''}
    ${event === 'contact.imported' ? `<p>${esc(ctx.count)} contacts were imported (${esc(ctx.created)} new, ${esc(ctx.updated)} updated).</p>` : ''}
    ${rows.length ? `<table style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#6b7280">${esc(k)}</td><td style="padding:4px 0">${esc(v)}</td></tr>`).join('')}</table>` : ''}
    ${ctx.comment ? `<p style="margin:12px 0"><b>Comment:</b> ${esc(ctx.comment)}</p>` : ''}
    ${changes ? `<p style="margin:16px 0 4px"><b>What changed</b></p><table style="border-collapse:collapse">${changes}</table>` : ''}
    <p style="margin-top:20px"><a href="${link}" style="background:#4f46e5;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none">Open in Ovantaa CRM</a></p>
    <p style="font-size:12px;color:#9ca3af">You receive this because of the notification rule “${esc(rule.name)}”. Manage rules in Ovantaa CRM → Notifications.</p></div>`;
  const text = `${subject}\n${EVENTS[event]} by ${vars.actor}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}${ctx.changes?.length ? '\n\nChanged:\n' + ctx.changes.map((c) => `${c.field}: ${c.from ?? '—'} -> ${c.to ?? '—'}`).join('\n') : ''}\n\n${link}`;
  return { subject, html, text };
}

function ruleMatches(rule, event, rec) {
  if (event.startsWith('deal.')) {
    if (rule.min_amount != null && (rec.amount || 0) < rule.min_amount) return false;
    if (rule.only_stage && !rule.only_stage.split(',').map((s) => s.trim()).includes(rec.stage)) return false;
  }
  return true;
}

function recipientsFor(rule, rec) {
  const set = new Set(parseEmails(rule.extra_emails));
  let ids = []; try { ids = JSON.parse(rule.user_ids || '[]'); } catch {}
  for (const id of ids) { const u = get('SELECT email FROM users WHERE id=? AND active=1', id); if (u) set.add(u.email.toLowerCase()); }
  if (rule.notify_owner && rec.owner_id) { const u = get('SELECT email FROM users WHERE id=? AND active=1', rec.owner_id); if (u) set.add(u.email.toLowerCase()); }
  return set;
}

// Notifications are sent one at a time in the background so API calls never wait on SMTP.
let chain = Promise.resolve();
const enqueue = (fn) => { chain = chain.then(fn).catch((e) => console.error('Notification error', e)); };

/**
 * Fire notifications for one user action. `events` may list several events (e.g. deal.updated + deal.won);
 * each recipient receives at most one email per action (first matching rule wins).
 */
export function notify(events, rec, ctx = {}, actor = null) {
  try {
    const rules = all(`SELECT * FROM notification_rules WHERE active=1 AND event IN (${events.map(() => '?').join(',')}) ORDER BY id`, ...events);
    const plan = new Map(); // email -> {rule, event}
    for (const rule of rules) {
      if (!ruleMatches(rule, rule.event, rec)) continue;
      for (const email of recipientsFor(rule, rec)) if (!plan.has(email)) plan.set(email, { rule, event: rule.event });
    }
    for (const [email, { rule, event }] of plan) {
      const msg = render(event, rec, ctx, rule, actor);
      const sender = (rule.sender_id && getSender(rule.sender_id)) || defaultSender() || null;
      enqueue(() => sendLogged({ sender: sender?.active === 0 ? defaultSender() : sender, to: email, ...msg, kind: 'notification', rule_id: rule.id, event }));
    }
  } catch (e) { console.error('notify failed', e); }
}

/** Resolve which events a deal update should fire, plus the human-readable change list. */
export function dealEvents(before, after) {
  const fields = { name: 'Name', amount: 'Amount', stage: 'Stage', probability: 'Probability', close_date: 'Close date', account_id: 'Account', contact_id: 'Contact', owner_id: 'Owner' };
  const changes = [];
  for (const [k, label] of Object.entries(fields)) {
    if ((before[k] ?? null) !== (after[k] ?? null)) {
      const show = (r, key) => (key === 'owner_id' ? r.owner_name : key === 'account_id' ? r.account_name : key === 'contact_id' ? r.contact_name : key === 'amount' ? money(r.amount) : r[key]);
      changes.push({ field: label, from: show(before, k), to: show(after, k) });
    }
  }
  if (!changes.length) return { events: [], changes };
  const events = ['deal.updated'];
  if (before.stage !== after.stage) { events.push('deal.stage_changed'); if (after.stage === 'won') events.push('deal.won'); if (after.stage === 'lost') events.push('deal.lost'); }
  return { events, changes };
}

/** Send a sample of a rule's email to the person testing it. */
export async function testRule(rule, user) {
  const sample = { id: 0, name: 'Sample deal — Acme renewal', amount: 42000, stage: 'negotiation', probability: 75, account_name: 'Acme Corp', close_date: '2026-12-15', owner_name: user.name,
    first_name: 'Sample', last_name: 'Contact', email: 'sample@example.com', title: 'VP Sales', status: 'lead', source: 'Website', industry: 'Software' };
  const msg = render(rule.event, sample, { count: 25, created: 20, updated: 5, changes: [{ field: 'Stage', from: 'proposal', to: 'negotiation' }] }, rule, user);
  const sender = (rule.sender_id && getSender(rule.sender_id)) || defaultSender() || null;
  return sendLogged({ sender, to: user.email, ...msg, subject: `[TEST] ${msg.subject}`, kind: 'test', rule_id: rule.id, event: rule.event });
}
