import { all, get, run, nowIso } from './db.js';
import { bad } from './http.js';
import { config } from './config.js';
import { defaultSender, systemSender, getSender, sendLogged } from './mailer.js';
import { isGulf, REGIMES, WHATSAPP_PREFIX } from './regimes.js';
import { renderInvoiceHtml } from './invoice-view.js';
import { sendViaMessaging } from './providers.js';
import {
  getBilling, validateSeller, validateInvoice, validateCustomerRecord, calcLines, verifyChain, balanceOf, daysOverdue, round2, today, logEvent, loadInvoice,
} from './invoicing.js';

const OPEN_TYPES = "doc_type IN ('standard','simplified','debit_note') AND status IN ('issued','partially_paid')";
const BAL = 'ROUND(total - amount_paid - amount_credited, 2)';
const addDays = (d, n) => new Date(new Date(d).getTime() + n * 86400000).toISOString().slice(0, 10);
const diffDays = (a, b) => Math.round((new Date(a) - new Date(b)) / 86400000);

// ======================= Receivables dashboard =======================
export function receivablesSummary() {
  const open = all(`SELECT id, number, doc_type, account_id, buyer_name, buyer_email, buyer_phone, issue_date, due_date, currency, ${BAL} AS balance FROM invoices WHERE ${OPEN_TYPES} AND ${BAL} > 0.005`);
  const t = today();
  const buckets = [['current', 'Not yet due'], ['1-30', '1–30 days'], ['31-60', '31–60 days'], ['61-90', '61–90 days'], ['90+', '90+ days']].map(([key, label]) => ({ key, label, amount: 0, count: 0 }));
  const bucketOf = (days) => (days <= 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4);
  const custs = new Map();
  for (const i of open) {
    const days = diffDays(t, i.due_date || i.issue_date); i.days_overdue = Math.max(0, days);
    const b = buckets[bucketOf(days)]; b.amount = round2(b.amount + i.balance); b.count++;
    const key = i.account_id ? `a${i.account_id}` : `n${i.buyer_name}`;
    const c = custs.get(key) || { key, account_id: i.account_id, name: i.buyer_name || 'Unknown', email: i.buyer_email, phone: i.buyer_phone, outstanding: 0, overdue: 0, invoices: 0, overdue_invoices: 0, max_days_overdue: 0, bucket: buckets.map((x) => ({ key: x.key, amount: 0 })) };
    c.outstanding = round2(c.outstanding + i.balance); c.invoices++; c.bucket[bucketOf(days)].amount = round2(c.bucket[bucketOf(days)].amount + i.balance);
    if (days > 0) { c.overdue = round2(c.overdue + i.balance); c.overdue_invoices++; c.max_days_overdue = Math.max(c.max_days_overdue, days); }
    custs.set(key, c);
  }
  const lastRem = Object.fromEntries(all("SELECT i.account_id a, i.buyer_name n, MAX(r.created_at) at FROM reminder_log r JOIN invoices i ON i.id=r.invoice_id GROUP BY i.account_id, i.buyer_name").map((r) => [r.a ? `a${r.a}` : `n${r.n}`, r.at]));
  const customers = [...custs.values()].map((c) => ({ ...c, last_reminder: lastRem[c.key] || null }));
  const outstanding = round2(open.reduce((a, i) => a + i.balance, 0));
  const overdueAmt = round2(open.filter((i) => i.days_overdue > 0).reduce((a, i) => a + i.balance, 0));

  // monthly: billed vs collected
  const months = []; for (let k = 5; k >= 0; k--) { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - k); months.push(d.toISOString().slice(0, 7)); }
  const coll = Object.fromEntries(all("SELECT strftime('%Y-%m', paid_on) m, SUM(amount) v FROM payments GROUP BY m").map((r) => [r.m, r.v]));
  const billed = Object.fromEntries(all("SELECT strftime('%Y-%m', issue_date) m, SUM(CASE WHEN doc_type='credit_note' THEN -total ELSE total END) v FROM invoices WHERE status<>'draft' GROUP BY m").map((r) => [r.m, r.v]));
  const monthly = months.map((m) => ({ month: m, collected: round2(coll[m] || 0), billed: round2(billed[m] || 0) }));
  const thisMonth = months[months.length - 1];
  const billed90 = get("SELECT COALESCE(SUM(total),0) v FROM invoices WHERE doc_type IN ('standard','simplified','debit_note') AND status<>'draft' AND issue_date >= date('now','-90 day')").v;

  // cash-in forecast: expected pay date = due date + this customer's historical delay; overdue invoices with no better signal are assumed ~14 days out
  const delay = Object.fromEntries(all(`SELECT i.account_id a, i.buyer_name n, AVG(MAX(0, MIN(60, julianday((SELECT MAX(paid_on) FROM payments p WHERE p.invoice_id=i.id)) - julianday(i.due_date)))) d
    FROM invoices i WHERE i.status='paid' AND i.due_date IS NOT NULL AND EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id=i.id) GROUP BY i.account_id, i.buyer_name`).map((r) => [r.a ? `a${r.a}` : `n${r.n}`, r.d || 0]));
  const weeks = Array.from({ length: 8 }, (_, w) => ({ start: addDays(t, w * 7), end: addDays(t, w * 7 + 6), amount: 0, count: 0 })); let beyond = 0;
  for (const i of open) {
    const key = i.account_id ? `a${i.account_id}` : `n${i.buyer_name}`;
    let exp = addDays(i.due_date || i.issue_date, Math.round(delay[key] || 0));
    if (exp < t) exp = addDays(t, 14);
    const w = Math.floor(diffDays(exp, t) / 7);
    if (w < 8) { weeks[w].amount = round2(weeks[w].amount + i.balance); weeks[w].count++; } else beyond = round2(beyond + i.balance);
  }
  const claims = get("SELECT COUNT(*) n FROM payment_claims WHERE status='pending'").n;
  const paidDays = get(`SELECT AVG(julianday((SELECT MAX(paid_on) FROM payments p WHERE p.invoice_id=i.id)) - julianday(i.issue_date)) d FROM invoices i WHERE i.status='paid' AND EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id=i.id)`).d;
  return {
    currency: getBilling().currency,
    kpis: { outstanding, overdue: overdueAmt, overdue_invoices: open.filter((i) => i.days_overdue > 0).length, open_invoices: open.length, collected_this_month: monthly.at(-1).collected, billed_this_month: round2(billed[thisMonth] || 0),
      dso: billed90 > 0 ? Math.round((outstanding / billed90) * 90) : null, avg_days_to_pay: paidDays == null ? null : Math.round(paidDays), pending_claims: claims, collection_rate: monthly.at(-1).billed > 0 ? round2(monthly.at(-1).collected / monthly.at(-1).billed) : null },
    aging: buckets, customers: customers.sort((a, b) => b.overdue - a.overdue || b.outstanding - a.outstanding), overdue_customers: customers.filter((c) => c.overdue > 0).sort((a, b) => b.overdue - a.overdue).slice(0, 15),
    monthly, forecast: { weeks, beyond, total_8w: round2(weeks.reduce((a, w) => a + w.amount, 0)) },
  };
}

// ======================= Readiness / exception scan =======================
export function readinessReport() {
  const company = getBilling(); const jur = company.jurisdiction;
  const seller = validateSeller(company).map((i) => ({ ...i, ref: { type: 'settings', label: 'Business profile' } }));
  const accounts = all(`SELECT a.*, (SELECT COUNT(*) FROM invoices i WHERE i.account_id=a.id) AS invoice_count FROM accounts a ORDER BY a.name LIMIT 2000`);
  const customers = [];
  const byVat = new Map(), byName = new Map();
  for (const a of accounts) {
    for (const i of validateCustomerRecord(a, jur)) customers.push({ ...i, used: a.invoice_count > 0, ref: { type: 'account', id: a.id, label: a.name } });
    if (a.vat_number) byVat.set(a.vat_number.trim(), [...(byVat.get(a.vat_number.trim()) || []), a]);
    const nk = a.name.toLowerCase().replace(/[^a-z0-9؀-ۿ]/g, ''); byName.set(nk, [...(byName.get(nk) || []), a]);
  }
  for (const [vat, list] of byVat) if (list.length > 1) for (const a of list) customers.push({ severity: 'warning', code: 'CUST_DUP_VAT', field: 'vat_number', message: `VAT/TRN ${vat} is also used by ${list.filter((x) => x.id !== a.id).map((x) => x.name).join(', ')} — possible duplicate customer.`, used: a.invoice_count > 0, ref: { type: 'account', id: a.id, label: a.name } });
  for (const [, list] of byName) if (list.length > 1) for (const a of list) customers.push({ severity: 'warning', code: 'CUST_DUP_NAME', field: 'name', message: 'Another customer has the same name — possible duplicate.', used: a.invoice_count > 0, ref: { type: 'account', id: a.id, label: a.name } });

  const invoices = [];
  for (const d of all("SELECT id FROM invoices WHERE status='draft' ORDER BY id DESC LIMIT 1000")) {
    const inv = loadInvoice(d.id); let calc; try { calc = calcLines(inv.lines, inv.jurisdiction); } catch (e) { invoices.push({ severity: 'error', code: 'LINES', message: e.message, ref: { type: 'invoice', id: inv.id, label: inv.external_number || `Draft #${inv.id}` } }); continue; }
    const original = inv.ref_invoice_id ? get('SELECT * FROM invoices WHERE id=?', inv.ref_invoice_id) : null;
    const dup = inv.external_number ? !!get("SELECT 1 FROM invoices WHERE id<>? AND external_number=? AND status<>'draft'", inv.id, inv.external_number) : false;
    for (const i of validateInvoice({ ...inv, total_stored: inv.total }, calc, { original, duplicateNumber: dup })) invoices.push({ ...i, source: inv.source, ref: { type: 'invoice', id: inv.id, label: inv.external_number || `Draft #${inv.id}`, customer: inv.buyer_name } });
  }
  const compliance = [];
  for (const i of all("SELECT id, number, doc_type, compliance_status, issued_at, jurisdiction FROM invoices WHERE status<>'draft' AND compliance_status IN ('ready','failed','rejected')")) {
    const hrs = (Date.now() - new Date(i.issued_at.replace(' ', 'T') + 'Z').getTime()) / 3600000;
    const ref = { type: 'invoice', id: i.id, label: i.number };
    if (i.compliance_status === 'rejected') compliance.push({ severity: 'error', code: 'REJECTED', message: `${i.number} was rejected by the provider/authority — issue a credit note and a corrected invoice.`, ref });
    else if (i.compliance_status === 'failed') compliance.push({ severity: 'error', code: 'SUBMIT_FAILED', message: `${i.number}: submission to your provider failed — retry from the invoice page.`, ref });
    else if (i.doc_type === 'simplified' && hrs > 24 && i.jurisdiction === 'KSA') compliance.push({ severity: 'error', code: 'REPORT_24H', message: `${i.number}: simplified invoices must be reported to ZATCA within 24 hours (issued ${Math.floor(hrs)}h ago, not yet reported).`, ref });
    else if (i.doc_type !== 'simplified' && i.jurisdiction === 'KSA') compliance.push({ severity: hrs > 1 ? 'warning' : 'info', code: 'NOT_CLEARED', message: `${i.number}: not yet cleared by ZATCA — do not send it to the customer until it is.`, ref });
    else compliance.push({ severity: 'info', code: 'NOT_SUBMITTED', message: `${i.number}: generated but not yet submitted to your e-invoicing provider.`, ref });
  }
  const chain = verifyChain();
  const reconciliation = [];
  for (const p of all("SELECT p.id, p.amount, p.paid_on, p.method, i.number, i.id inv_id, i.currency FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE p.reconciled=0 AND p.method='bank_transfer' AND p.paid_on < date('now','-7 day') ORDER BY p.paid_on LIMIT 200"))
    reconciliation.push({ severity: 'warning', code: 'UNRECONCILED', message: `Bank transfer of ${p.amount.toFixed(2)} ${p.currency} on ${p.paid_on} against ${p.number} is not marked reconciled with the bank statement.`, ref: { type: 'invoice', id: p.inv_id, label: p.number } });
  for (const c of all("SELECT c.id, c.amount, c.created_at, i.number, i.id inv_id FROM payment_claims c JOIN invoices i ON i.id=c.invoice_id WHERE c.status='pending' AND c.created_at < datetime('now','-2 day')"))
    reconciliation.push({ severity: 'warning', code: 'CLAIM_PENDING', message: `Customer says they paid ${c.amount.toFixed(2)} on ${c.number} (${c.created_at.slice(0, 10)}) — confirm or reject it.`, ref: { type: 'invoice', id: c.inv_id, label: c.number } });
  for (const i of all("SELECT id, number FROM invoices WHERE status='paid' AND amount_credited=0 AND doc_type<>'credit_note' AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id=invoices.id)")) reconciliation.push({ severity: 'warning', code: 'PAID_NO_PAYMENT', message: `${i.number} is marked paid but has no payment record.`, ref: { type: 'invoice', id: i.id, label: i.number } });

  const count = (arr, sev) => arr.filter((x) => x.severity === sev).length;
  const usedCustomers = customers.filter((c) => c.used);
  const sections = { seller, customers, invoices, compliance, reconciliation, chain: chain.problems.map((p) => ({ severity: 'error', code: 'CHAIN', message: `${p.number}: ${p.message}`, ref: { type: 'invoice', label: p.number } })) };
  const total = (sev) => Object.values(sections).reduce((a, s) => a + count(s, sev), 0);
  const draftCount = get("SELECT COUNT(*) n FROM invoices WHERE status='draft'").n;
  const draftsWithErrors = new Set(invoices.filter((i) => i.severity === 'error').map((i) => i.ref.id)).size;
  return { jurisdiction: jur, generated_at: nowIso(), summary: { errors: total('error'), warnings: total('warning'), info: total('info'), drafts: draftCount, drafts_ready: Math.max(0, draftCount - draftsWithErrors), customers_checked: accounts.length, customers_in_use_with_issues: new Set(usedCustomers.filter((c) => c.severity !== 'info').map((c) => c.ref.id)).size, chain_checked: chain.checked }, sections };
}

// ======================= Reminders & collection tasks =======================
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const portalUrl = (inv) => `${config.baseUrl}/pay/${inv.portal_token}`;
const amountStr = (inv) => `${Number(inv.balance ?? balanceOf(inv)).toFixed(2)} ${inv.currency}`;

/** Payment instructions in plain text: IBAN, or account number + IFSC / sort code / routing number, and UPI. */
export function bankText(company, inv) {
  const b = company.bank || {}; const parts = [];
  if (b.bank_name) parts.push(`Bank: ${b.bank_name}`); if (b.account_name) parts.push(`Account name: ${b.account_name}`);
  if (b.iban) parts.push(`IBAN: ${b.iban}`); if (b.account_number) parts.push(`Account no.: ${b.account_number}`);
  if (b.bank_code) parts.push(`${b.bank_code_label || 'Bank code'}: ${b.bank_code}`); if (b.swift) parts.push(`SWIFT/BIC: ${b.swift}`); if (b.upi) parts.push(`UPI: ${b.upi}`);
  return parts.length ? `\n${parts.join(' · ')} · Reference${isGulf(inv.jurisdiction) && inv.lang !== 'en' ? ' / المرجع' : ''}: ${inv.number}` : '';
}
const senderFor = (company) => { const s = company.reminders.sender_id && getSender(company.reminders.sender_id); return s && s.active !== 0 ? s : systemSender(); };
const money = (n, cur) => { try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: 2 }).format(n || 0); } catch { return `${Number(n || 0).toFixed(2)} ${cur}`; } };
const docTitle = (inv, company) => { const sj = inv.seller_json ? JSON.parse(inv.seller_json) : company; if (inv.doc_type === 'credit_note') return 'Credit note'; if (inv.doc_type === 'debit_note') return 'Debit note'; return isGulf(inv.jurisdiction) ? 'Tax invoice' : inv.jurisdiction === 'IN' ? (sj.tax_registered === false ? 'Invoice' : 'Tax invoice') : sj.invoice_title || 'Invoice'; };
const emailList = (v) => String(v || '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const button = (url, label) => `<p style="margin:18px 0"><a href="${esc(url)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600">${esc(label)}</a></p>`;

/** Email an issued invoice: personal message, summary, a "view & pay" link and (by default) the invoice attached as a printable file. */
export async function sendInvoiceEmail(inv, { to, cc, subject, message, attach = true, user } = {}) {
  const company = getBilling(); const sj = inv.seller_json ? JSON.parse(inv.seller_json) : company;
  const toList = emailList(to || inv.buyer_email), ccList = emailList(cc);
  if (!toList.length) throw bad('Add the customer email address (or type one).');
  for (const e of [...toList, ...ccList]) if (!EMAIL_RE.test(e)) throw bad(`"${e}" is not a valid email address`);
  const title = docTitle(inv, company); const bal = inv.balance ?? balanceOf(inv);
  const subj = String(subject || `${title} ${inv.number} from ${sj.seller_name || company.seller_name}`).replace(/[\r\n]+/g, ' ').slice(0, 200);
  const msg = String(message || `Dear ${inv.buyer_name || 'customer'},\n\nPlease find attached ${title.toLowerCase()} ${inv.number} for ${money(inv.total, inv.currency)}${inv.due_date && bal > 0 ? `, due on ${inv.due_date}` : ''}.\n\nThank you for your business.\n${sj.seller_name || company.seller_name}`).slice(0, 5000);
  const rows = [['Number', inv.number], ['Date', inv.issue_date], inv.due_date && ['Due date', inv.due_date], ['Total', money(inv.total, inv.currency)], inv.amount_paid > 0 && ['Paid', money(inv.amount_paid, inv.currency)], inv.doc_type !== 'credit_note' && ['Balance due', money(bal, inv.currency)]].filter(Boolean);
  const bank = bankText(company, inv);
  const html = `<div style="font-family:Arial,sans-serif;max-width:580px;color:#1f2937"><div style="white-space:pre-line;line-height:1.55">${esc(msg)}</div>
    <table style="border-collapse:collapse;margin:16px 0;font-size:14px">${rows.map(([k, v]) => `<tr><td style="padding:4px 18px 4px 0;color:#6b7280">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join('')}</table>
    ${inv.portal_token ? button(portalUrl(inv), bal > 0 ? 'View invoice & pay' : 'View invoice') : ''}
    ${bank && bal > 0 ? `<p style="font-size:13px;color:#374151;white-space:pre-line">${esc(bank.trim())}</p>` : ''}
    ${attach ? '<p style="font-size:12px;color:#6b7280">The invoice is attached — open it in your browser and use Print → Save as PDF to keep a copy.</p>' : ''}</div>`;
  const attachments = attach ? [{ filename: `${String(inv.number).replace(/[^\w.-]+/g, '_')}.html`, content: await renderInvoiceHtml(inv, { portal: false, standalone: true }), contentType: 'text/html; charset=utf-8' }] : [];
  const sender = senderFor(company);
  const r = await sendLogged({ sender, to: toList.join(', '), cc: ccList.length ? ccList.join(', ') : undefined, subject: subj, html, text: `${msg}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}${inv.portal_token ? `\n\nView online: ${portalUrl(inv)}` : ''}${bank}`, kind: 'invoice', event: `invoice:${inv.number}`, attachments, copyToSent: true });
  if (r.status !== 'failed') run('UPDATE invoices SET emailed_at=?, email_count=email_count+1 WHERE id=?', nowIso(), inv.id);
  logEvent(inv.id, r.status === 'failed' ? 'email_failed' : 'emailed', `${r.status === 'simulated' ? '(simulated) ' : ''}to ${toList.join(', ')}${ccList.length ? ` cc ${ccList.join(', ')}` : ''}${r.error ? ` — ${r.error}` : ''}`, user);
  return { status: r.status, error: r.error, to: toList, cc: ccList, via: sender ? `${sender.label} (${sender.from_email})` : 'no sender', simulated: !sender || sender.mode !== 'smtp' };
}

/** "Payment received — thank you" email after a payment is recorded. */
export async function sendPaymentReceipt(inv, amount, user) {
  if (!inv.buyer_email) return { status: 'skipped', detail: 'No customer email on the invoice.' };
  const company = getBilling(); const sj = inv.seller_json ? JSON.parse(inv.seller_json) : company; const bal = inv.balance ?? balanceOf(inv);
  const text = `Dear ${inv.buyer_name || 'customer'},\n\nThank you — we have received your payment of ${money(amount, inv.currency)} for invoice ${inv.number}.\n${bal > 0 ? `Remaining balance: ${money(bal, inv.currency)}.` : 'The invoice is now fully paid.'}\n\n${sj.seller_name || company.seller_name}`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;white-space:pre-line;line-height:1.55">${esc(text)}</div>${inv.portal_token ? button(portalUrl(inv), 'View invoice') : ''}`;
  const sender = senderFor(company);
  const r = await sendLogged({ sender, to: inv.buyer_email, subject: `Payment received — ${inv.number}`, html, text, kind: 'receipt', event: `invoice:${inv.number}`, copyToSent: true });
  logEvent(inv.id, r.status === 'failed' ? 'receipt_failed' : 'receipt_sent', `${r.status === 'simulated' ? '(simulated) ' : ''}to ${inv.buyer_email}${r.error ? ` — ${r.error}` : ''}`, user);
  return { status: r.status, detail: r.error || `to ${inv.buyer_email}` };
}

export function reminderMessage(inv, company, days) {
  const en = days < 0 ? `a friendly reminder that invoice ${inv.number} for ${amountStr(inv)} is due on ${inv.due_date} (in ${-days} day${days === -1 ? '' : 's'}).`
    : days === 0 ? `invoice ${inv.number} for ${amountStr(inv)} is due today.` : `invoice ${inv.number} for ${amountStr(inv)} was due on ${inv.due_date} and is now ${days} day${days === 1 ? '' : 's'} overdue.`;
  const ar = days < 0 ? `تذكير ودّي بأن الفاتورة رقم ${inv.number} بمبلغ ${amountStr(inv)} تستحق في ${inv.due_date} (بعد ${-days} يوم).`
    : days === 0 ? `الفاتورة رقم ${inv.number} بمبلغ ${amountStr(inv)} تستحق اليوم.` : `الفاتورة رقم ${inv.number} بمبلغ ${amountStr(inv)} كان استحقاقها في ${inv.due_date} وقد تأخر السداد ${days} يوم.`;
  const bank = bankText(company, inv);
  const link = `\n${portalUrl(inv)}`;
  const name = inv.buyer_name || '';
  const lang = isGulf(inv.jurisdiction) ? inv.lang : 'en';
  const text = lang === 'ar' ? `السادة ${inv.buyer_name_ar || name}،\n${ar}${bank}${link}\nشكراً — ${company.seller_name_ar || company.seller_name}`
    : lang === 'en' ? `Dear ${name},\n${en.charAt(0).toUpperCase() + en.slice(1)}${bank}${link}\nThank you — ${company.seller_name}`
    : `Dear ${name},\n${en.charAt(0).toUpperCase() + en.slice(1)}\n\n${ar}${bank}${link}\nThank you / شكراً — ${company.seller_name}`;
  const subject = days < 0 ? `Upcoming payment: invoice ${inv.number}` : days === 0 ? `Payment due today: invoice ${inv.number}` : `Overdue payment: invoice ${inv.number} (${days} days)`;
  return { subject: lang === 'ar' ? `تذكير بالدفع: فاتورة ${inv.number}` : subject, text };
}
export function whatsappLink(phone, text, country = 'SA') {
  let d = String(phone || '').replace(/[^\d+]/g, ''); if (!d) return null;
  const cc = WHATSAPP_PREFIX[country] || '966';
  if (d.startsWith('+')) d = d.slice(1); else if (d.startsWith('00')) d = d.slice(2); else if (d.startsWith('0')) d = cc + d.slice(1); else if (country === 'IN' && /^[6-9]\d{9}$/.test(d)) d = '91' + d;
  return /^\d{8,15}$/.test(d) ? `https://wa.me/${d}?text=${encodeURIComponent(text)}` : null;
}

/** Send one reminder. kind: 'auto' | 'manual'. Returns { status, detail, link? }. Never throws for delivery problems. */
export async function sendReminder(inv, channel, { kind = 'manual', offset = null, user = null } = {}) {
  const company = getBilling(); const days = inv.due_date ? diffDays(today(), inv.due_date) : 0; const msg = reminderMessage(inv, company, days);
  let status = 'sent', detail = '', link = null;
  if (channel === 'email') {
    if (!inv.buyer_email) { status = 'skipped'; detail = 'No customer email on the invoice.'; }
    else {
      const sender = senderFor(company);
      const html = `<div style="font-family:Arial,sans-serif;max-width:560px;white-space:pre-line;line-height:1.55">${esc(msg.text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</div>${inv.portal_token ? button(portalUrl(inv), 'View invoice & pay') : ''}`;
      const r = await sendLogged({ sender, to: inv.buyer_email, subject: msg.subject, html, text: msg.text, kind: 'reminder', event: `invoice:${inv.number}`, copyToSent: true });
      status = r.status === 'failed' ? 'failed' : r.status === 'simulated' ? 'simulated' : 'sent'; detail = r.error || (r.status === 'simulated' ? 'Simulation sender: nothing was delivered.' : `Sent to ${inv.buyer_email}`);
    }
  } else if (channel === 'whatsapp' || channel === 'sms') {
    if (!inv.buyer_phone) { status = 'skipped'; detail = 'No customer phone on the invoice.'; }
    else {
      const r = await sendViaMessaging({ channel, to: inv.buyer_phone, message: msg.text, invoice_number: inv.number });
      if (r.ok) detail = `Sent via your ${channel} gateway to ${inv.buyer_phone}`;
      else if (r.notConfigured && channel === 'whatsapp') {
        link = whatsappLink(inv.buyer_phone, msg.text, (inv.buyer_country || REGIMES[inv.jurisdiction]?.country || company.address?.country_code || 'SA').toUpperCase());
        status = link ? 'link' : 'skipped'; detail = link ? 'No WhatsApp gateway connected — open the prepared WhatsApp message and press send.' : 'Phone number is not valid for WhatsApp.';
      } else if (r.notConfigured) { status = 'skipped'; detail = 'No SMS gateway connected (Billing settings → Messaging).'; }
      else { status = 'failed'; detail = r.error; }
    }
  } else { status = 'skipped'; detail = 'Unknown channel'; }
  run('INSERT OR IGNORE INTO reminder_log (invoice_id,kind,offset_days,channel,status,detail) VALUES (?,?,?,?,?,?)', inv.id, kind, kind === 'auto' ? offset : null, channel, status, detail.slice(0, 300));
  logEvent(inv.id, `reminder_${channel}`, `${kind} · ${status}${detail ? ' · ' + detail : ''}`, user);
  return { status, detail, link, message: msg.text };
}

let lastRun = 0;
export async function runReminders({ force = false } = {}) {
  if (!force && Date.now() - lastRun < 30 * 60 * 1000) return { sent: 0, tasks: 0 };
  lastRun = Date.now();
  const company = getBilling(); const out = { sent: 0, tasks: 0 };
  const invoices = all(`SELECT id FROM invoices WHERE ${OPEN_TYPES} AND ${BAL} > 0.005 AND due_date IS NOT NULL AND compliance_status NOT IN ('rejected') AND COALESCE(reminders_paused,0)=0 ORDER BY due_date LIMIT 2000`).map((r) => loadInvoice(r.id));
  for (const inv of invoices) {
    const days = diffDays(today(), inv.due_date);
    if (company.reminders.enabled && !get("SELECT 1 FROM payment_claims WHERE invoice_id=? AND status='pending'", inv.id)) {
      const sched = [...company.reminders.schedule].sort((a, b) => a.offset - b.offset);
      let reached = sched.filter((s) => s.offset <= days && days - s.offset <= 3).sort((a, b) => b.offset - a.offset)[0];
      const last = sched.at(-1), rep = company.reminders.repeat_days;
      if (!reached && last && rep > 0 && days > last.offset) { // keep chasing every N days after the final step
        const k = Math.floor((days - last.offset) / rep), virtual = last.offset + k * rep;
        if (k >= 1 && days - virtual <= 3) reached = { offset: virtual, channels: last.channels };
      }
      if (reached) for (const ch of reached.channels) {
        if (get("SELECT 1 FROM reminder_log WHERE invoice_id=? AND kind='auto' AND offset_days=? AND channel=?", inv.id, reached.offset, ch)) continue;
        const r = await sendReminder(inv, ch, { kind: 'auto', offset: reached.offset });
        out.sent++;
        if (ch === 'whatsapp' && r.status === 'link' && company.reminders.create_whatsapp_tasks) {
          createTask(inv, `Send WhatsApp reminder for ${inv.number} to ${inv.buyer_name}`, `Open this prepared message and press send:\n${r.link}`, days > 14 ? 'high' : 'medium'); out.tasks++;
        }
      }
    }
    if (company.reminders.create_collection_tasks && days > 0 && !get('SELECT 1 FROM tasks WHERE invoice_id=? AND done=0 AND title LIKE ?', inv.id, 'Collect %')) {
      createTask(inv, `Collect ${inv.number} from ${inv.buyer_name} — ${amountStr(inv)}, ${days} day${days === 1 ? '' : 's'} overdue`, `Call or visit the customer. Payment link: ${portalUrl(inv)}`, days > 30 ? 'high' : 'medium'); out.tasks++;
    }
  }
  return out;
}
function createTask(inv, title, notes, priority) {
  const owner = inv.owner_id || inv.created_by || get("SELECT id FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1")?.id || null;
  run('INSERT INTO tasks (title,due_date,priority,owner_id,contact_id,invoice_id,notes) VALUES (?,?,?,?,?,?,?)', title.slice(0, 250), today(), priority, owner, inv.contact_id || null, inv.id, notes.slice(0, 1000));
}
