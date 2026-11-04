import { qrSvg, balanceOf, daysOverdue, getBilling } from './invoicing.js';
import { all } from './db.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const T = {
  tax_invoice: ['Tax Invoice', 'فاتورة ضريبية'], simplified: ['Simplified Tax Invoice', 'فاتورة ضريبية مبسطة'], credit_note: ['Credit Note', 'إشعار دائن'], debit_note: ['Debit Note', 'إشعار مدين'],
  number: ['Invoice no.', 'رقم الفاتورة'], issue: ['Issue date', 'تاريخ الإصدار'], supply: ['Supply date', 'تاريخ التوريد'], due: ['Due date', 'تاريخ الاستحقاق'], ref: ['Original invoice', 'الفاتورة الأصلية'], reason: ['Reason', 'السبب'],
  seller: ['Seller', 'البائع'], buyer: ['Bill to', 'العميل'], vat_no: ['VAT no.', 'الرقم الضريبي'], cr: ['CR no.', 'السجل التجاري'],
  desc: ['Description', 'الوصف'], qty: ['Qty', 'الكمية'], price: ['Unit price', 'سعر الوحدة'], disc: ['Discount', 'الخصم'], vat_pct: ['VAT %', 'نسبة الضريبة'], vat: ['VAT', 'الضريبة'], total: ['Total', 'الإجمالي'],
  subtotal: ['Subtotal', 'المجموع'], discount: ['Discount', 'الخصم'], taxable: ['Taxable amount', 'المبلغ الخاضع للضريبة'], total_vat: ['Total VAT', 'إجمالي الضريبة'], grand: ['Total due', 'الإجمالي المستحق'],
  paid: ['Paid', 'المدفوع'], credited: ['Credited', 'المخصوم'], balance: ['Balance due', 'الرصيد المستحق'],
  pay: ['How to pay', 'طريقة الدفع'], bank: ['Bank', 'البنك'], acct: ['Account name', 'اسم الحساب'], iban: ['IBAN', 'رقم الآيبان'], payref: ['Payment reference', 'مرجع الدفع'],
  paid_chip: ['Paid', 'مدفوعة'], partial_chip: ['Partially paid', 'مدفوعة جزئياً'], due_chip: ['Payment due', 'مستحقة الدفع'], overdue_chip: ['Overdue', 'متأخرة'], na: ['—', '—'],
  claim_title: ['Already paid? Let us know', 'هل قمت بالدفع؟ أبلغنا'], claim_amount: ['Amount paid', 'المبلغ المدفوع'], claim_date: ['Payment date', 'تاريخ الدفع'], claim_ref: ['Transfer reference', 'مرجع التحويل'], claim_name: ['Your name', 'اسمك'],
  claim_btn: ['Notify payment', 'إرسال إشعار الدفع'], claim_note: ['We will confirm once the transfer reaches our account.', 'سنؤكد عند وصول التحويل إلى حسابنا.'],
  claimed: ['Thank you — we have recorded your payment notice and will confirm it shortly.', 'شكراً لك — سجلنا إشعار الدفع وسنؤكده قريباً.'],
  print: ['Print / Save as PDF', 'طباعة / حفظ PDF'], notice_rejected: ['This invoice is being corrected. Please wait for the corrected copy.', 'يجري تصحيح هذه الفاتورة. يرجى انتظار النسخة المصححة.'],
};
const t = (k, lang) => (lang === 'ar' ? T[k][1] : lang === 'en' ? T[k][0] : `${T[k][0]} / ${T[k][1]}`);
const money = (n, cur) => `${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${esc(cur)}`;

export async function renderInvoiceHtml(inv, { lang, portal = false, claimed = false, claimError = '' } = {}) {
  lang = ['ar', 'en', 'both'].includes(lang) ? lang : inv.lang || 'both';
  const seller = inv.seller_json ? JSON.parse(inv.seller_json) : getBilling(); const co = getBilling();
  const lines = inv.lines || all('SELECT * FROM invoice_lines WHERE invoice_id=? ORDER BY position,id', inv.id);
  const rtl = lang === 'ar'; const bal = balanceOf(inv); const over = daysOverdue(inv);
  const chip = inv.doc_type === 'credit_note' ? null : inv.status === 'paid' ? ['paid_chip', 'ok'] : over > 0 ? ['overdue_chip', 'bad'] : inv.status === 'partially_paid' ? ['partial_chip', 'warn'] : ['due_chip', 'info'];
  const title = inv.doc_type === 'simplified' ? 'simplified' : inv.doc_type === 'credit_note' ? 'credit_note' : inv.doc_type === 'debit_note' ? 'debit_note' : 'tax_invoice';
  const svg = inv.qr ? await qrSvg(inv.qr) : '';
  const addr = (a) => [a.street, a.building_no, a.district, a.city, a.postal_code].filter(Boolean).map(esc).join(', ');
  const nm = (en, ar) => (lang === 'ar' ? esc(ar || en) : lang === 'en' ? esc(en) : esc(en) + (ar && ar !== en ? `<br><span class="ar">${esc(ar)}</span>` : ''));
  const rejected = inv.compliance_status === 'rejected';
  const claimForm = portal && !rejected && bal > 0 ? `<form method="post" action="/pay/${esc(inv.portal_token)}/claim" class="card"><h3>${t('claim_title', lang)}</h3>
    <div class="grid"><label>${t('claim_amount', lang)}<input name="amount" type="number" step="0.01" min="0.01" max="${bal}" value="${bal}" required></label>
    <label>${t('claim_date', lang)}<input name="paid_on" type="date" required></label><label>${t('claim_ref', lang)}<input name="reference" maxlength="100"></label><label>${t('claim_name', lang)}<input name="payer" maxlength="100"></label></div>
    <button>${t('claim_btn', lang)}</button><p class="muted">${t('claim_note', lang)}</p></form>` : '';
  return `<!doctype html><html lang="${rtl ? 'ar' : 'en'}" dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(inv.number || 'Invoice')} · ${esc(seller.seller_name)}</title><style>
*{box-sizing:border-box}body{font:14px/1.5 -apple-system,"Segoe UI",Tahoma,Arial,sans-serif;background:#f3f4f8;color:#161a2b;margin:0;padding:20px}.sheet{max-width:880px;margin:0 auto;background:#fff;border-radius:14px;padding:32px;box-shadow:0 6px 24px rgba(20,22,50,.08)}
h1{margin:0;font-size:24px}.ar{font-size:.95em;color:#4b5563}.muted{color:#6b7285;font-size:12px}.top{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:20px}
.chip{display:inline-block;padding:3px 12px;border-radius:99px;font-weight:700;font-size:12px}.chip.ok{background:#dcfce7;color:#15803d}.chip.bad{background:#fee2e2;color:#b91c1c}.chip.warn{background:#fef3c7;color:#b45309}.chip.info{background:#e0e7ff;color:#3730a3}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:18px}.box{border:1px solid #e6e8f0;border-radius:10px;padding:12px 14px}.box h4{margin:0 0 6px;color:#6b7285;font-size:11px;text-transform:uppercase;letter-spacing:.06em}
table{width:100%;border-collapse:collapse;margin:8px 0}th,td{padding:8px 6px;border-bottom:1px solid #e6e8f0;text-align:start;vertical-align:top}th{font-size:11px;text-transform:uppercase;color:#6b7285}td.n,th.n{text-align:end;white-space:nowrap}
.totals{margin-inline-start:auto;width:min(360px,100%)}.totals div{display:flex;justify-content:space-between;padding:4px 0}.totals .big{font-size:17px;font-weight:700;border-top:2px solid #161a2b;margin-top:4px;padding-top:8px}
.qr{width:128px;height:128px}.qr svg{width:100%;height:100%}.card{border:1px solid #e6e8f0;border-radius:12px;padding:16px;margin-top:18px}.card h3{margin:0 0 10px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}label{display:block;font-size:12px;font-weight:600}input{display:block;width:100%;padding:8px;margin-top:4px;border:1px solid #cfd3e0;border-radius:8px;font:inherit}
button,.btn{margin-top:12px;background:#4f46e5;color:#fff;border:0;border-radius:8px;padding:10px 18px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block}.ok-msg{background:#dcfce7;color:#15803d;padding:10px 14px;border-radius:8px;margin-bottom:12px}.err-msg{background:#fee2e2;color:#b91c1c;padding:10px 14px;border-radius:8px;margin-bottom:12px}
.warn-msg{background:#fef3c7;color:#92400e;padding:10px 14px;border-radius:8px;margin-bottom:12px}.noprint{margin:0 auto 12px;max-width:880px;text-align:end}.mono{font-family:ui-monospace,Menlo,monospace;direction:ltr;unicode-bidi:embed;overflow-wrap:anywhere}.grid>div{min-width:0}
@media print{body{background:#fff;padding:0}.sheet{box-shadow:none;padding:0}.noprint,form,.card.pay-claim{display:none}}@media(max-width:640px){.cols{grid-template-columns:1fr}.sheet{padding:18px}}
</style></head><body>${portal ? '' : `<div class="noprint"><a class="btn" id="printbtn" href="#">${t('print', 'both')}</a></div>`}
<div class="sheet">${claimed ? `<div class="ok-msg">${t('claimed', lang)}</div>` : ''}${claimError ? `<div class="err-msg">${esc(claimError)}</div>` : ''}${rejected && portal ? `<div class="warn-msg">${t('notice_rejected', lang)}</div>` : ''}
<div class="top"><div><h1>${t(title, lang)}</h1><div class="mono">${esc(inv.number)}</div>${chip ? `<div style="margin-top:6px"><span class="chip ${chip[1]}">${t(chip[0], lang)}${over > 0 ? ` · ${over}d` : ''}</span></div>` : ''}</div>
<div style="text-align:end">${svg ? `<div class="qr" style="margin-inline-start:auto">${svg}</div>` : ''}</div></div>
<div class="cols"><div class="box"><h4>${t('seller', lang)}</h4><b>${nm(seller.seller_name, seller.seller_name_ar)}</b><div>${addr(seller.address || {})}</div><div class="muted">${t('vat_no', lang)}: <span class="mono">${esc(seller.vat_number)}</span>${seller.cr_number ? ` · ${t('cr', lang)}: ${esc(seller.cr_number)}` : ''}</div></div>
<div class="box"><h4>${t('buyer', lang)}</h4><b>${nm(inv.buyer_name || '—', inv.buyer_name_ar)}</b><div>${addr({ street: inv.buyer_street, building_no: inv.buyer_building, district: inv.buyer_district, city: inv.buyer_city, postal_code: inv.buyer_postal })}</div>${inv.buyer_vat ? `<div class="muted">${t('vat_no', lang)}: <span class="mono">${esc(inv.buyer_vat)}</span></div>` : ''}</div></div>
<div class="cols"><div class="box"><div>${t('issue', lang)}: <b>${esc(inv.issue_date)}</b></div>${inv.supply_date ? `<div>${t('supply', lang)}: ${esc(inv.supply_date)}</div>` : ''}${inv.due_date ? `<div>${t('due', lang)}: <b>${esc(inv.due_date)}</b></div>` : ''}</div>
<div class="box">${inv.ref_number ? `<div>${t('ref', lang)}: <b class="mono">${esc(inv.ref_number)}</b></div>` : ''}${inv.reason ? `<div>${t('reason', lang)}: ${esc(inv.reason)}</div>` : ''}${inv.payment_terms ? `<div class="muted">${esc(inv.payment_terms)}</div>` : ''}</div></div>
<table><thead><tr><th>#</th><th>${t('desc', lang)}</th><th class="n">${t('qty', lang)}</th><th class="n">${t('price', lang)}</th><th class="n">${t('disc', lang)}</th><th class="n">${t('vat_pct', lang)}</th><th class="n">${t('vat', lang)}</th><th class="n">${t('total', lang)}</th></tr></thead><tbody>
${lines.map((l, i) => `<tr><td>${i + 1}</td><td>${nm(l.description, l.description_ar)}${l.exemption_reason ? `<div class="muted">${esc(l.exemption_reason)}</div>` : ''}</td><td class="n">${Number(l.qty)}</td><td class="n">${Number(l.unit_price).toFixed(2)}</td><td class="n">${Number(l.discount).toFixed(2)}</td><td class="n">${l.vat_category === 'S' ? Number(l.vat_rate) + '%' : esc(l.vat_category)}</td><td class="n">${Number(l.vat).toFixed(2)}</td><td class="n">${Number(l.total).toFixed(2)}</td></tr>`).join('')}</tbody></table>
<div class="totals"><div><span>${t('subtotal', lang)}</span><span>${money(inv.subtotal, inv.currency)}</span></div>${inv.discount_total ? `<div><span>${t('discount', lang)}</span><span>− ${money(inv.discount_total, inv.currency)}</span></div>` : ''}<div><span>${t('taxable', lang)}</span><span>${money(inv.subtotal - inv.discount_total, inv.currency)}</span></div><div><span>${t('total_vat', lang)}</span><span>${money(inv.vat_total, inv.currency)}</span></div>
<div class="big"><span>${t('grand', lang)}</span><span>${money(inv.total, inv.currency)}</span></div>${inv.amount_paid ? `<div><span>${t('paid', lang)}</span><span>− ${money(inv.amount_paid, inv.currency)}</span></div>` : ''}${inv.amount_credited ? `<div><span>${t('credited', lang)}</span><span>− ${money(inv.amount_credited, inv.currency)}</span></div>` : ''}${inv.doc_type !== 'credit_note' ? `<div class="big"><span>${t('balance', lang)}</span><span>${money(bal, inv.currency)}</span></div>` : ''}</div>
${inv.notes ? `<p class="muted">${esc(inv.notes)}</p>` : ''}
${inv.doc_type !== 'credit_note' && bal > 0 && (co.bank.iban || co.portal_note) ? `<div class="card"><h3>${t('pay', lang)}</h3>${co.bank.iban ? `<div class="grid"><div>${t('bank', lang)}<br><b>${esc(co.bank.bank_name || '—')}</b></div><div>${t('acct', lang)}<br><b>${esc(co.bank.account_name || seller.seller_name)}</b></div><div>${t('iban', lang)}<br><b class="mono">${esc(co.bank.iban)}</b></div><div>${t('payref', lang)}<br><b class="mono">${esc(inv.number)}</b></div></div>` : ''}${co.portal_note ? `<p class="muted">${esc(co.portal_note)}</p>` : ''}</div>` : ''}
${claimForm}
</div><script src="/js/print.js"></script></body></html>`;
}
