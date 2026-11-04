import { all, get, run } from './db.js';
import { saveBilling, issueInvoice, recordPayment, loadInvoice, calcLines, today, round2, logEvent } from './invoicing.js';

// deterministic PRNG so the demo is stable
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const daysFrom = (d, n) => new Date(new Date(d).getTime() + n * 86400000).toISOString().slice(0, 10);

/** Demo receivables: a fictional Saudi seller, 8 customers with valid tax data, ~14 invoices issued through the real numbering/hash-chain path. */
export function seedBillingDemo() {
  if (get('SELECT COUNT(*) n FROM invoices').n) return;
  const admin = get("SELECT id, name FROM users WHERE role='admin' ORDER BY id LIMIT 1"); if (!admin) return;
  saveBilling({ jurisdiction: 'KSA', currency: 'SAR', default_lang: 'en', seller_name: 'Ovantaa Demo Trading Co', seller_name_ar: 'شركة أوفانتا التجريبية', vat_number: '300000000000003', cr_number: '1010000000',
    address: { street: 'Olaya Street', building_no: '2345', district: 'Al Olaya', city: 'Riyadh', postal_code: '12211', country_code: 'SA' },
    bank: { bank_name: 'Demo Bank', account_name: 'Ovantaa Demo Trading Co', iban: 'SA0380000000608010167519', swift: 'DEMOSARI' }, portal_note: 'Demo data — payments shown here are illustrative.' });
  const accounts = all('SELECT id, name FROM accounts ORDER BY id LIMIT 8');
  accounts.forEach((a, i) => run('UPDATE accounts SET vat_number=?, street=?, building_no=?, district=?, city=?, postal_code=?, country_code=?, billing_email=?, billing_phone=? WHERE id=?',
    `3${String(1000000000 + i * 7919).padStart(13, '0')}3`, `${10 + i} King Abdulaziz Road`, String(1000 + i * 37), 'Al Malaz', 'Riyadh', String(11500 + i * 13), 'SA', `accounts@${a.name.toLowerCase().replace(/[^a-z0-9]/g, '')}.example`, `05${int(10000000, 99999999)}`, a.id));
  const items = [['Platform subscription', 4800], ['Implementation services', 12500], ['Annual support plan', 3600], ['Consulting (per day)', 2200], ['Training workshop', 5400], ['Analytics add-on', 1900]];
  const mk = (acc, age, terms, nLines) => {
    const a = get('SELECT * FROM accounts WHERE id=?', acc.id); const issue = daysAgo(age);
    const lines = Array.from({ length: nLines }, () => { const [d, p] = items[int(0, items.length - 1)]; return { description: d, qty: int(1, 4), unit_price: p, vat_category: 'S', vat_rate: 15 }; });
    const calc = calcLines(lines, 'KSA');
    const id = Number(run(`INSERT INTO invoices (doc_type,jurisdiction,currency,lang,account_id,buyer_name,buyer_name_ar,buyer_vat,buyer_street,buyer_building,buyer_district,buyer_city,buyer_postal,buyer_country,buyer_email,buyer_phone,
      issue_date,supply_date,due_date,subtotal,discount_total,vat_total,total,owner_id,created_by,source) VALUES ('standard','KSA','SAR','en',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'demo')`,
      a.id, a.name, a.name_ar, a.vat_number, a.street, a.building_no, a.district, a.city, a.postal_code, 'SA', a.billing_email, a.billing_phone, issue, issue, daysFrom(issue, terms), calc.subtotal, calc.discount_total, calc.vat_total, calc.total, admin.id, admin.id).lastInsertRowid);
    calc.lines.forEach((l, i) => run('INSERT INTO invoice_lines (invoice_id,position,description,qty,unit_price,discount,vat_category,vat_rate,net,vat,total) VALUES (?,?,?,?,?,?,?,?,?,?,?)', id, i, l.description, l.qty, l.unit_price, l.discount, l.vat_category, l.vat_rate, l.net, l.vat, l.total));
    issueInvoice(id, admin); return loadInvoice(id);
  };
  // [account index, age in days, payment terms, lines, outcome]
  const plan = [[0, 95, 30, 2, 'paid'], [1, 80, 30, 1, 'paid'], [2, 70, 30, 3, 'partial'], [3, 62, 30, 2, 'none'], [4, 50, 30, 1, 'paid'], [5, 44, 15, 2, 'none'], [6, 38, 30, 2, 'partial'], [7, 33, 30, 1, 'none'],
    [0, 28, 30, 2, 'paid'], [1, 21, 30, 3, 'none'], [2, 14, 30, 1, 'none'], [3, 9, 30, 2, 'none'], [4, 4, 30, 1, 'none'], [5, 2, 30, 2, 'none']];
  for (const [ai, age, terms, n, outcome] of plan) {
    const inv = mk(accounts[ai], age, terms, n);
    const due = inv.due_date;
    if (outcome === 'paid') recordPayment(inv, { amount: inv.total, paid_on: [daysFrom(due, int(-3, 12)), today()].sort()[0], method: 'bank_transfer', reference: `SARIE-${int(10000, 99999)}`, reconciled: true }, admin);
    if (outcome === 'partial') recordPayment(inv, { amount: round2(inv.total * 0.4), paid_on: [daysFrom(due, int(0, 6)), today()].sort()[0], method: 'bank_transfer', reference: `SARIE-${int(10000, 99999)}`, reconciled: true }, admin);
  }
  // one credit note on an unpaid invoice
  const target = get("SELECT id, account_id FROM invoices WHERE status='issued' AND amount_paid=0 ORDER BY id LIMIT 1");
  if (target) {
    const o = loadInvoice(target.id); const lines = [{ description: 'Credit: service level adjustment', qty: 1, unit_price: round2(o.subtotal * 0.1), vat_category: 'S', vat_rate: 15 }]; const calc = calcLines(lines, 'KSA');
    const id = Number(run(`INSERT INTO invoices (doc_type,jurisdiction,currency,lang,account_id,buyer_name,buyer_vat,buyer_street,buyer_building,buyer_district,buyer_city,buyer_postal,buyer_country,issue_date,supply_date,subtotal,discount_total,vat_total,total,ref_invoice_id,ref_number,reason,owner_id,created_by,source)
      VALUES ('credit_note','KSA','SAR','en',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'demo')`, o.account_id, o.buyer_name, o.buyer_vat, o.buyer_street, o.buyer_building, o.buyer_district, o.buyer_city, o.buyer_postal, 'SA', today(), today(), calc.subtotal, 0, calc.vat_total, calc.total, o.id, o.number, 'Service level adjustment agreed with customer', admin.id, admin.id).lastInsertRowid);
    calc.lines.forEach((l, i) => run('INSERT INTO invoice_lines (invoice_id,position,description,qty,unit_price,discount,vat_category,vat_rate,net,vat,total) VALUES (?,?,?,?,?,?,?,?,?,?,?)', id, i, l.description, l.qty, l.unit_price, 0, 'S', 15, l.net, l.vat, l.total));
    issueInvoice(id, admin);
  }
  // make the demo history look lived-in: one invoice has a pending customer payment notice
  const open = get("SELECT id FROM invoices WHERE status='issued' AND doc_type='standard' AND due_date < date('now') ORDER BY id DESC LIMIT 1");
  if (open) { const o = loadInvoice(open.id); run('INSERT INTO payment_claims (invoice_id,amount,paid_on,reference,payer_name) VALUES (?,?,?,?,?)', o.id, round2(o.balance / 2), daysAgo(1), 'SARIE-DEMO-1', 'Accounts team'); logEvent(o.id, 'payment_claim', 'Customer notified a payment (demo) — awaiting confirmation', null); }
}
