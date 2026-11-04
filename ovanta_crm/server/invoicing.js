import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { all, get, run, tx, nowIso } from './db.js';
import { getSetting, setSetting, getSecretSetting, setSecretSetting } from './settings.js';
import { bad } from './http.js';

// ======================= Billing profile (seller, numbering, bank, reminders, providers) =======================
export const BILLING_DEFAULTS = {
  jurisdiction: 'KSA', currency: 'SAR', default_lang: 'both', seller_name: '', seller_name_ar: '', vat_number: '', cr_number: '',
  address: { street: '', building_no: '', district: '', city: '', postal_code: '', country_code: 'SA' },
  invoice_prefix: 'INV-', credit_prefix: 'CN-', debit_prefix: 'DN-', payment_terms_days: 30, vat_rate: 15,
  bank: { bank_name: '', account_name: '', iban: '', swift: '' }, portal_note: '',
  reminders: { enabled: false, sender_id: null, create_whatsapp_tasks: true, create_collection_tasks: true, repeat_days: 14,
    schedule: [{ offset: -3, channels: ['email'] }, { offset: 0, channels: ['email'] }, { offset: 3, channels: ['email'] }, { offset: 7, channels: ['email', 'whatsapp'] }, { offset: 14, channels: ['email', 'whatsapp'] }, { offset: 30, channels: ['email', 'whatsapp'] }] },
  messaging: { mode: 'none', url: '' }, asp: { mode: 'none', url: '' },
};
const merge = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b || {})) o[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) ? merge(a[k], v) : v; return o; };
export function getBilling({ withSecrets = false } = {}) {
  let stored = {}; try { stored = JSON.parse(getSetting('billing', '{}')); } catch {}
  const b = merge(BILLING_DEFAULTS, stored);
  b.asp.has_token = !!getSecretSetting('billing_asp_token'); b.messaging.has_token = !!getSecretSetting('billing_msg_token');
  if (withSecrets) { b.asp.token = getSecretSetting('billing_asp_token'); b.messaging.token = getSecretSetting('billing_msg_token'); }
  return b;
}
const str = (v, max = 200) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
export function saveBilling(input) {
  const cur = getBilling(); const i = input || {}; const a = i.address || {}; const bk = i.bank || {};
  if (i.jurisdiction !== undefined && !['KSA', 'UAE'].includes(i.jurisdiction)) throw bad('Jurisdiction must be KSA or UAE');
  const next = {
    jurisdiction: i.jurisdiction ?? cur.jurisdiction, currency: str(i.currency ?? cur.currency, 3).toUpperCase() || cur.currency, default_lang: ['en', 'ar', 'both'].includes(i.default_lang) ? i.default_lang : cur.default_lang,
    seller_name: str(i.seller_name ?? cur.seller_name), seller_name_ar: str(i.seller_name_ar ?? cur.seller_name_ar), vat_number: str(i.vat_number ?? cur.vat_number, 20).replace(/\s/g, ''), cr_number: str(i.cr_number ?? cur.cr_number, 30),
    address: { street: str(a.street ?? cur.address.street), building_no: str(a.building_no ?? cur.address.building_no, 10), district: str(a.district ?? cur.address.district), city: str(a.city ?? cur.address.city), postal_code: str(a.postal_code ?? cur.address.postal_code, 10), country_code: str(a.country_code ?? cur.address.country_code, 2).toUpperCase() || 'SA' },
    invoice_prefix: str(i.invoice_prefix ?? cur.invoice_prefix, 12) || 'INV-', credit_prefix: str(i.credit_prefix ?? cur.credit_prefix, 12) || 'CN-', debit_prefix: str(i.debit_prefix ?? cur.debit_prefix, 12) || 'DN-',
    payment_terms_days: Math.min(365, Math.max(0, parseInt(i.payment_terms_days ?? cur.payment_terms_days, 10) || 0)), vat_rate: Number(i.vat_rate ?? cur.vat_rate) || (i.jurisdiction === 'UAE' ? 5 : 15),
    bank: { bank_name: str(bk.bank_name ?? cur.bank.bank_name), account_name: str(bk.account_name ?? cur.bank.account_name), iban: str(bk.iban ?? cur.bank.iban, 40).replace(/\s/g, '').toUpperCase(), swift: str(bk.swift ?? cur.bank.swift, 15).toUpperCase() },
    portal_note: String(i.portal_note ?? cur.portal_note).slice(0, 500),
    reminders: i.reminders ? { enabled: !!i.reminders.enabled, sender_id: i.reminders.sender_id ? Number(i.reminders.sender_id) : null, create_whatsapp_tasks: i.reminders.create_whatsapp_tasks !== false, create_collection_tasks: i.reminders.create_collection_tasks !== false, repeat_days: Math.min(90, Math.max(0, parseInt(i.reminders.repeat_days ?? cur.reminders.repeat_days, 10) || 0)),
      schedule: (Array.isArray(i.reminders.schedule) ? i.reminders.schedule : cur.reminders.schedule).map((s) => ({ offset: Math.max(-30, Math.min(365, parseInt(s.offset, 10) || 0)), channels: (s.channels || []).filter((c) => ['email', 'whatsapp', 'sms'].includes(c)) })).filter((s) => s.channels.length).slice(0, 12) } : cur.reminders,
    messaging: { mode: i.messaging?.mode === 'webhook' ? 'webhook' : i.messaging ? 'none' : cur.messaging.mode, url: str(i.messaging?.url ?? cur.messaging.url, 500) },
    asp: { mode: i.asp?.mode === 'webhook' ? 'webhook' : i.asp ? 'none' : cur.asp.mode, url: str(i.asp?.url ?? cur.asp.url, 500) },
  };
  for (const u of [next.messaging.url, next.asp.url]) if (u && !/^https?:\/\//i.test(u)) throw bad('Provider URLs must start with http:// or https://');
  setSetting('billing', JSON.stringify(next));
  if (i.asp?.token) setSecretSetting('billing_asp_token', String(i.asp.token).trim()); if (i.asp?.clear_token) setSecretSetting('billing_asp_token', null);
  if (i.messaging?.token) setSecretSetting('billing_msg_token', String(i.messaging.token).trim()); if (i.messaging?.clear_token) setSecretSetting('billing_msg_token', null);
  return getBilling();
}

// ======================= Money & totals =======================
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const today = () => new Date().toISOString().slice(0, 10);
export const defaultVatRate = (jur) => (jur === 'UAE' ? 5 : 15);
export const VAT_CATEGORIES = { S: 'Standard rate', Z: 'Zero rated', E: 'Exempt', O: 'Out of scope' };

export function calcLines(rawLines, jurisdiction = 'KSA') {
  const lines = (rawLines || []).map((l, i) => {
    const qty = Number(l.qty), price = Number(l.unit_price), disc = Number(l.discount || 0);
    if (![qty, price, disc].every(Number.isFinite)) throw bad(`Line ${i + 1}: quantity, price and discount must be numbers`);
    const cat = ['S', 'Z', 'E', 'O'].includes(l.vat_category) ? l.vat_category : 'S';
    const rate = cat === 'S' ? (l.vat_rate === undefined || l.vat_rate === '' || l.vat_rate === null ? defaultVatRate(jurisdiction) : Number(l.vat_rate)) : 0;
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw bad(`Line ${i + 1}: VAT rate must be between 0 and 100`);
    const gross = round2(qty * price), net = round2(gross - disc), vat = round2((net * rate) / 100);
    return { position: i, description: str(l.description, 500), description_ar: str(l.description_ar, 500) || null, qty, unit_price: price, discount: round2(disc), vat_category: cat, vat_rate: rate,
      exemption_reason: cat === 'S' ? null : str(l.exemption_reason, 200) || null, gross, net, vat, total: round2(net + vat) };
  });
  const sum = (k) => round2(lines.reduce((a, l) => a + l[k], 0));
  return { lines, subtotal: sum('gross'), discount_total: round2(lines.reduce((a, l) => a + (l.gross - l.net), 0)), taxable: sum('net'), vat_total: sum('vat'), total: round2(sum('net') + sum('vat')) };
}

// ======================= Validation (the "readiness" rules) =======================
const KSA_VAT = /^3\d{13}3$/;           // ZATCA: 15 digits, starts and ends with 3
const UAE_TRN = /^\d{15}$/;             // UAE TRN: 15 digits (normally starting 100)
export const isValidTaxId = (v, jur) => (jur === 'UAE' ? UAE_TRN : KSA_VAT).test(String(v || '').trim());
const issue = (severity, code, field, message, fix) => ({ severity, code, field, message, fix });

export function validateSeller(co) {
  const out = []; const jur = co.jurisdiction; const a = co.address || {};
  if (!co.seller_name) out.push(issue('error', 'SELLER_NAME', 'seller_name', 'Your registered business name is missing.', 'Billing settings → Business profile'));
  if (!co.vat_number) out.push(issue('error', 'SELLER_VAT', 'vat_number', `Your ${jur === 'UAE' ? 'TRN' : 'VAT registration number'} is missing.`, 'Billing settings → Business profile'));
  else if (!isValidTaxId(co.vat_number, jur)) out.push(issue('error', 'SELLER_VAT_FORMAT', 'vat_number', jur === 'UAE' ? 'TRN must be 15 digits.' : 'KSA VAT number must be 15 digits, starting and ending with 3.', 'Billing settings → Business profile'));
  for (const [k, label] of [['street', 'street'], ['city', 'city']]) if (!a[k]) out.push(issue('error', `SELLER_ADDR_${k.toUpperCase()}`, `address.${k}`, `Seller address: ${label} is missing.`, 'Billing settings → Business profile'));
  if (jur === 'KSA') {
    if (!/^\d{5}$/.test(a.postal_code || '')) out.push(issue('error', 'SELLER_POSTAL', 'address.postal_code', 'Seller postal code must be 5 digits.', 'Billing settings → Business profile'));
    if (!/^\d{4}$/.test(a.building_no || '')) out.push(issue('warning', 'SELLER_BUILDING', 'address.building_no', 'Seller building number should be 4 digits.', 'Billing settings → Business profile'));
    if (!a.district) out.push(issue('warning', 'SELLER_DISTRICT', 'address.district', 'Seller district is missing.', 'Billing settings → Business profile'));
  }
  if (!co.seller_name_ar) out.push(issue('warning', 'SELLER_NAME_AR', 'seller_name_ar', 'Arabic business name is missing (needed on bilingual invoices).', 'Billing settings → Business profile'));
  return out;
}

/** Validate one invoice (with computed lines). `ctx` = { company, original, creditedSoFar, existsNumber } */
export function validateInvoice(inv, calc, ctx = {}) {
  const out = []; const jur = inv.jurisdiction || 'KSA'; const lines = calc.lines; const standard = inv.doc_type === 'standard';
  const note = ['credit_note', 'debit_note'].includes(inv.doc_type);
  if (!lines.length) out.push(issue('error', 'NO_LINES', 'lines', 'The invoice has no line items.', 'Add at least one line'));
  lines.forEach((l, i) => {
    const n = i + 1;
    if (!l.description) out.push(issue('error', 'LINE_DESC', `lines.${i}`, `Line ${n}: description is missing.`));
    if (!(l.qty > 0)) out.push(issue('error', 'LINE_QTY', `lines.${i}`, `Line ${n}: quantity must be greater than 0.`));
    if (l.unit_price < 0) out.push(issue('error', 'LINE_PRICE', `lines.${i}`, `Line ${n}: unit price cannot be negative.`));
    if (l.discount > l.gross + 0.001 || l.discount < 0) out.push(issue('error', 'LINE_DISCOUNT', `lines.${i}`, `Line ${n}: discount must be between 0 and the line amount.`));
    if (l.vat_category === 'S' && jur === 'KSA' && l.vat_rate !== 15) out.push(issue('warning', 'KSA_RATE', `lines.${i}`, `Line ${n}: standard-rated VAT in KSA is 15% (found ${l.vat_rate}%).`));
    if (l.vat_category === 'S' && jur === 'UAE' && l.vat_rate !== 5) out.push(issue('warning', 'UAE_RATE', `lines.${i}`, `Line ${n}: standard-rated VAT in the UAE is 5% (found ${l.vat_rate}%).`));
    if (l.vat_category !== 'S' && !l.exemption_reason) out.push(issue('error', 'VAT_REASON', `lines.${i}`, `Line ${n}: zero-rated, exempt and out-of-scope lines need an exemption reason.`, 'Enter the reason (e.g. VATEX code or text)'));
    if (/\b(advance|deposit|down ?payment|prepayment)\b|دفعة مقدمة|عربون/i.test(l.description)) out.push(issue('warning', 'ADVANCE', `lines.${i}`, `Line ${n} looks like an advance payment: issue a separate advance invoice and deduct it on the final invoice.`));
    if (inv.lang !== 'en' && !l.description_ar) out.push(issue('warning', 'LINE_AR', `lines.${i}`, `Line ${n}: Arabic description is missing for a bilingual invoice.`));
  });
  if (!inv.issue_date) out.push(issue('error', 'ISSUE_DATE', 'issue_date', 'Issue date is required.'));
  else if (inv.issue_date > today()) out.push(issue('error', 'ISSUE_DATE_FUTURE', 'issue_date', 'Issue date cannot be in the future.'));
  if (standard && !inv.supply_date) out.push(issue('warning', 'SUPPLY_DATE', 'supply_date', 'Supply (delivery) date is missing; it is expected on standard tax invoices.'));
  if (inv.due_date && inv.issue_date && inv.due_date < inv.issue_date) out.push(issue('warning', 'DUE_BEFORE_ISSUE', 'due_date', 'Due date is earlier than the issue date.'));
  if (!inv.due_date && !note && inv.doc_type !== 'simplified') out.push(issue('warning', 'NO_DUE', 'due_date', 'No due date — reminders and ageing need one.'));
  const expectCur = jur === 'UAE' ? 'AED' : 'SAR';
  if (inv.currency !== expectCur) out.push(issue('warning', 'CURRENCY', 'currency', `${jur} invoices are normally in ${expectCur}; VAT must also be reported in ${expectCur}.`));
  if (inv.total_stored !== undefined && Math.abs(inv.total_stored - calc.total) > 0.011) out.push(issue('error', 'TOTALS', 'total', `Stored total (${inv.total_stored}) does not match the lines (${calc.total}).`));
  if (standard || note) {
    if (!inv.buyer_name) out.push(issue('error', 'BUYER_NAME', 'buyer_name', 'Customer name is missing.', 'Fix the customer record'));
    if (standard || inv.buyer_vat) {
      if (!inv.buyer_vat) out.push(issue('error', 'BUYER_VAT', 'buyer_vat', `Customer ${jur === 'UAE' ? 'TRN' : 'VAT number'} is required on B2B tax invoices.`, 'Fix the customer record'));
      else if (!isValidTaxId(inv.buyer_vat, jur)) out.push(issue('error', 'BUYER_VAT_FORMAT', 'buyer_vat', jur === 'UAE' ? 'Customer TRN must be 15 digits.' : 'Customer VAT number must be 15 digits, starting and ending with 3.', 'Fix the customer record'));
    }
    for (const [k, label] of [['buyer_street', 'street'], ['buyer_city', 'city'], ['buyer_country', 'country']]) if (standard && !inv[k]) out.push(issue('error', `BUYER_${k.slice(6).toUpperCase()}`, k, `Customer address: ${label} is missing.`, 'Fix the customer record'));
    if (standard && jur === 'KSA') {
      if (!/^\d{5}$/.test(inv.buyer_postal || '')) out.push(issue('error', 'BUYER_POSTAL', 'buyer_postal', 'Customer postal code must be 5 digits.', 'Fix the customer record'));
      if (!/^\d{4}$/.test(inv.buyer_building || '')) out.push(issue('warning', 'BUYER_BUILDING', 'buyer_building', 'Customer building number should be 4 digits.', 'Fix the customer record'));
      if (!inv.buyer_district) out.push(issue('warning', 'BUYER_DISTRICT', 'buyer_district', 'Customer district is missing.', 'Fix the customer record'));
    }
    if (inv.lang !== 'en' && !inv.buyer_name_ar && standard) out.push(issue('warning', 'BUYER_NAME_AR', 'buyer_name_ar', 'Customer Arabic name is missing.', 'Fix the customer record'));
  }
  if (note) {
    const o = ctx.original;
    if (!o) out.push(issue('error', 'NOTE_REF', 'ref_invoice_id', `A ${inv.doc_type === 'credit_note' ? 'credit' : 'debit'} note must reference the original invoice.`));
    else {
      if (o.doc_type === 'credit_note') out.push(issue('error', 'NOTE_REF_TYPE', 'ref_invoice_id', 'A note cannot reference a credit note; reference the original invoice.'));
      if (o.status === 'draft') out.push(issue('error', 'NOTE_REF_DRAFT', 'ref_invoice_id', 'The referenced invoice has not been issued yet.'));
      if (o.currency !== inv.currency) out.push(issue('error', 'NOTE_CURRENCY', 'currency', 'Currency must match the original invoice.'));
      if (inv.doc_type === 'credit_note' && calc.total > round2(o.total - (ctx.creditedSoFar ?? o.amount_credited)) + 0.005) out.push(issue('error', 'CREDIT_EXCEEDS', 'total', `Credit (${calc.total}) exceeds what can still be credited on ${o.number} (${round2(o.total - (ctx.creditedSoFar ?? o.amount_credited))}).`));
    }
    if (!inv.reason) out.push(issue('error', 'NOTE_REASON', 'reason', 'A reason is required for credit and debit notes.'));
  }
  if (ctx.duplicateNumber) out.push(issue('error', 'DUP_NUMBER', 'external_number', `Invoice number ${inv.external_number} already exists in the system.`));
  return out;
}

export function validateCustomerRecord(a, jur = 'KSA') {
  const out = [];
  if (!a.name) out.push(issue('error', 'CUST_NAME', 'name', 'Customer name is missing.'));
  if (!a.vat_number) out.push(issue('warning', 'CUST_VAT_MISSING', 'vat_number', `No ${jur === 'UAE' ? 'TRN' : 'VAT number'} — required for B2B tax invoices.`));
  else if (!isValidTaxId(a.vat_number, jur)) out.push(issue('error', 'CUST_VAT_FORMAT', 'vat_number', jur === 'UAE' ? 'TRN must be 15 digits.' : 'VAT number must be 15 digits, starting and ending with 3.'));
  if (!a.street || !a.city) out.push(issue('warning', 'CUST_ADDR', 'street', 'Address incomplete (street and city are required on B2B invoices).'));
  if (jur === 'KSA' && a.postal_code && !/^\d{5}$/.test(a.postal_code)) out.push(issue('error', 'CUST_POSTAL', 'postal_code', 'Postal code must be 5 digits.'));
  if (jur === 'KSA' && a.vat_number && a.postal_code === undefined) out.push(issue('warning', 'CUST_POSTAL_MISSING', 'postal_code', 'Postal code missing.'));
  if (!a.billing_email && !a.billing_phone) out.push(issue('warning', 'CUST_CONTACT', 'billing_email', 'No billing email or phone — payment reminders cannot be sent.'));
  return out;
}

// ======================= XML, QR, hash chain =======================
export const INITIAL_PIH = 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ=='; // base64(hex(sha256("0"))) — ZATCA's first previous-hash
const xesc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const money = (n) => Number(n).toFixed(2);
const TYPE_CODE = { standard: ['0100000', '388'], simplified: ['0200000', '388'], credit_note: [null, '381'], debit_note: [null, '383'] };

export function buildUbl(inv, lines, seller, { qr = null } = {}) {
  const cur = inv.currency; const [issueDate, issueTime] = [inv.issue_date, (inv.issued_at || nowIso()).slice(11, 19)];
  const subtype = inv.doc_type === 'simplified' || inv.simplified_note ? '0200000' : '0100000';
  const [name, code] = TYPE_CODE[inv.doc_type]; const typeName = name || subtype;
  const addr = (a) => `<cac:PostalAddress><cbc:StreetName>${xesc(a.street)}</cbc:StreetName>${a.building_no ? `<cbc:BuildingNumber>${xesc(a.building_no)}</cbc:BuildingNumber>` : ''}${a.district ? `<cbc:CitySubdivisionName>${xesc(a.district)}</cbc:CitySubdivisionName>` : ''}<cbc:CityName>${xesc(a.city)}</cbc:CityName><cbc:PostalZone>${xesc(a.postal_code)}</cbc:PostalZone><cac:Country><cbc:IdentificationCode>${xesc(a.country_code || 'SA')}</cbc:IdentificationCode></cac:Country></cac:PostalAddress>`;
  const party = (name_, vat, a, crn) => `<cac:Party>${crn ? `<cac:PartyIdentification><cbc:ID schemeID="CRN">${xesc(crn)}</cbc:ID></cac:PartyIdentification>` : ''}${addr(a)}${vat ? `<cac:PartyTaxScheme><cbc:CompanyID>${xesc(vat)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>` : ''}<cac:PartyLegalEntity><cbc:RegistrationName>${xesc(name_)}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party>`;
  const groups = new Map();
  for (const l of lines) { const k = `${l.vat_category}|${l.vat_rate}|${l.exemption_reason || ''}`; const g = groups.get(k) || { cat: l.vat_category, rate: l.vat_rate, reason: l.exemption_reason, taxable: 0, vat: 0 }; g.taxable = round2(g.taxable + l.net); g.vat = round2(g.vat + l.vat); groups.set(k, g); }
  const taxable = round2(lines.reduce((a, l) => a + l.net, 0));
  const ref = inv.ref_number ? `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${xesc(inv.ref_number)}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
<cbc:ProfileID>reporting:1.0</cbc:ProfileID>
<cbc:ID>${xesc(inv.number)}</cbc:ID>
<cbc:UUID>${xesc(inv.uuid)}</cbc:UUID>
<cbc:IssueDate>${issueDate}</cbc:IssueDate>
<cbc:IssueTime>${issueTime}</cbc:IssueTime>
<cbc:InvoiceTypeCode name="${typeName}">${code}</cbc:InvoiceTypeCode>
<cbc:DocumentCurrencyCode>${xesc(cur)}</cbc:DocumentCurrencyCode>
<cbc:TaxCurrencyCode>${xesc(cur)}</cbc:TaxCurrencyCode>
${ref}<cac:AdditionalDocumentReference><cbc:ID>ICV</cbc:ID><cbc:UUID>${inv.icv}</cbc:UUID></cac:AdditionalDocumentReference>
<cac:AdditionalDocumentReference><cbc:ID>PIH</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${xesc(inv.previous_hash)}</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference>
${qr ? `<cac:AdditionalDocumentReference><cbc:ID>QR</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${xesc(qr)}</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference>\n` : ''}<cac:AccountingSupplierParty>${party(seller.seller_name, seller.vat_number, seller.address, seller.cr_number)}</cac:AccountingSupplierParty>
<cac:AccountingCustomerParty>${party(inv.buyer_name || '', inv.buyer_vat, { street: inv.buyer_street, building_no: inv.buyer_building, district: inv.buyer_district, city: inv.buyer_city, postal_code: inv.buyer_postal, country_code: inv.buyer_country || 'SA' })}</cac:AccountingCustomerParty>
<cac:Delivery><cbc:ActualDeliveryDate>${xesc(inv.supply_date || inv.issue_date)}</cbc:ActualDeliveryDate></cac:Delivery>
<cac:PaymentMeans><cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>${inv.reason ? `<cbc:InstructionNote>${xesc(inv.reason)}</cbc:InstructionNote>` : ''}</cac:PaymentMeans>
<cac:TaxTotal><cbc:TaxAmount currencyID="${cur}">${money(inv.vat_total)}</cbc:TaxAmount></cac:TaxTotal>
<cac:TaxTotal><cbc:TaxAmount currencyID="${cur}">${money(inv.vat_total)}</cbc:TaxAmount>${[...groups.values()].map((g) => `<cac:TaxSubtotal><cbc:TaxableAmount currencyID="${cur}">${money(g.taxable)}</cbc:TaxableAmount><cbc:TaxAmount currencyID="${cur}">${money(g.vat)}</cbc:TaxAmount><cac:TaxCategory><cbc:ID>${g.cat}</cbc:ID><cbc:Percent>${money(g.rate)}</cbc:Percent>${g.cat !== 'S' ? `<cbc:TaxExemptionReason>${xesc(g.reason)}</cbc:TaxExemptionReason>` : ''}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>`).join('')}</cac:TaxTotal>
<cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="${cur}">${money(taxable)}</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="${cur}">${money(taxable)}</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="${cur}">${money(inv.total)}</cbc:TaxInclusiveAmount><cbc:AllowanceTotalAmount currencyID="${cur}">${money(inv.discount_total)}</cbc:AllowanceTotalAmount><cbc:PrepaidAmount currencyID="${cur}">0.00</cbc:PrepaidAmount><cbc:PayableAmount currencyID="${cur}">${money(inv.total)}</cbc:PayableAmount></cac:LegalMonetaryTotal>
${lines.map((l, i) => `<cac:InvoiceLine><cbc:ID>${i + 1}</cbc:ID><cbc:InvoicedQuantity unitCode="PCE">${Number(l.qty)}</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="${cur}">${money(l.net)}</cbc:LineExtensionAmount><cac:TaxTotal><cbc:TaxAmount currencyID="${cur}">${money(l.vat)}</cbc:TaxAmount><cbc:RoundingAmount currencyID="${cur}">${money(l.total)}</cbc:RoundingAmount></cac:TaxTotal><cac:Item><cbc:Name>${xesc(l.description)}</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>${l.vat_category}</cbc:ID><cbc:Percent>${money(l.vat_rate)}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item><cac:Price><cbc:PriceAmount currencyID="${cur}">${Number(l.unit_price).toFixed(2)}</cbc:PriceAmount></cac:Price></cac:InvoiceLine>`).join('\n')}
</Invoice>`;
}
export const sha256b64 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('base64');

/** TLV QR payload (tags 1–6: seller, VAT no., timestamp, total, VAT, invoice hash), base64. Signature tags (7–9) are added by a certified signing component. */
export function qrPayload({ seller, vat, timestamp, total, vatTotal, hash }) {
  const tlv = (tag, val) => { const v = Buffer.from(String(val), 'utf8'); return Buffer.concat([Buffer.from([tag, v.length]), v]); };
  return Buffer.concat([tlv(1, seller), tlv(2, vat), tlv(3, timestamp), tlv(4, money(total)), tlv(5, money(vatTotal)), tlv(6, hash)]).toString('base64');
}
export const decodeQr = (b64) => { const b = Buffer.from(b64, 'base64'); const out = {}; for (let i = 0; i < b.length;) { out[b[i]] = b.subarray(i + 2, i + 2 + b[i + 1]).toString('utf8'); i += 2 + b[i + 1]; } return out; };
export const qrSvg = (text) => QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });

// ======================= Loading, audit trail =======================
export function logEvent(invoiceId, type, detail, user) {
  run('INSERT INTO invoice_events (invoice_id,type,detail,user_id,user_name) VALUES (?,?,?,?,?)', invoiceId, type, detail ? String(detail).slice(0, 500) : null, user?.id ?? null, user?.name ?? 'system');
}
export const statusFor = (inv) => { const bal = round2(inv.total - inv.amount_paid - inv.amount_credited); return bal <= 0.005 ? 'paid' : inv.amount_paid > 0 || inv.amount_credited > 0 ? 'partially_paid' : 'issued'; };
export const balanceOf = (inv) => (['credit_note'].includes(inv.doc_type) || inv.status === 'draft' ? 0 : Math.max(0, round2(inv.total - inv.amount_paid - inv.amount_credited)));
export const daysOverdue = (inv) => (['issued', 'partially_paid'].includes(inv.status) && inv.due_date && inv.due_date < today() && inv.doc_type !== 'credit_note' ? Math.round((new Date(today()) - new Date(inv.due_date)) / 86400000) : 0);
export function loadInvoice(id) {
  const inv = get('SELECT * FROM invoices WHERE id=?', id); if (!inv) return null;
  inv.lines = all('SELECT * FROM invoice_lines WHERE invoice_id=? ORDER BY position, id', id).map((l) => ({ ...l, gross: round2(l.qty * l.unit_price) }));
  inv.balance = balanceOf(inv); inv.days_overdue = daysOverdue(inv);
  return inv;
}

// ======================= Numbering & issuing =======================
function nextCounter(key) {
  run('INSERT INTO counters (key,value) VALUES (?,0) ON CONFLICT(key) DO NOTHING', key);
  run('UPDATE counters SET value=value+1 WHERE key=?', key);
  return get('SELECT value FROM counters WHERE key=?', key).value;
}
const seriesOf = (t) => (t === 'credit_note' ? 'credit' : t === 'debit_note' ? 'debit' : 'invoice');

/** Validate, then assign a gap-free number, ICV, previous-hash link, UUID, XML, hash and QR — atomically. */
export function issueInvoice(id, user) {
  const company = getBilling();
  let result;
  tx(() => {
    const inv = loadInvoice(id); if (!inv) throw bad('Invoice not found');
    if (inv.status !== 'draft') throw bad('This invoice has already been issued.');
    const calc = calcLines(inv.lines, inv.jurisdiction);
    const original = inv.ref_invoice_id ? get('SELECT * FROM invoices WHERE id=?', inv.ref_invoice_id) : null;
    const issues = [...validateSeller(company), ...validateInvoice(inv, calc, { company, original })];
    const errors = issues.filter((i) => i.severity === 'error');
    if (errors.length) throw bad(`Cannot issue: ${errors.length} compliance error${errors.length === 1 ? '' : 's'} must be fixed first.`, { issues });
    const seq = nextCounter(`seq_${seriesOf(inv.doc_type)}`), icv = nextCounter('icv');
    const prefix = inv.doc_type === 'credit_note' ? company.credit_prefix : inv.doc_type === 'debit_note' ? company.debit_prefix : company.invoice_prefix;
    const number = `${prefix}${String(seq).padStart(6, '0')}`;
    const prev = get("SELECT invoice_hash FROM invoices WHERE icv IS NOT NULL ORDER BY icv DESC LIMIT 1");
    const issuedAt = nowIso();
    const seller = { seller_name: company.seller_name, seller_name_ar: company.seller_name_ar, vat_number: company.vat_number, cr_number: company.cr_number, address: company.address, jurisdiction: company.jurisdiction };
    const doc = { ...inv, ...calc, number, icv, uuid: crypto.randomUUID(), previous_hash: prev?.invoice_hash || INITIAL_PIH, issued_at: issuedAt, total: calc.total, vat_total: calc.vat_total, discount_total: calc.discount_total };
    const hash = sha256b64(buildUbl(doc, calc.lines, seller));
    const qr = qrPayload({ seller: seller.seller_name, vat: seller.vat_number, timestamp: `${doc.issue_date}T${issuedAt.slice(11, 19)}Z`, total: calc.total, vatTotal: calc.vat_total, hash });
    const xml = buildUbl(doc, calc.lines, seller, { qr });
    inv.lines.forEach((l, i) => run('UPDATE invoice_lines SET net=?, vat=?, total=?, vat_rate=?, exemption_reason=? WHERE id=?', calc.lines[i].net, calc.lines[i].vat, calc.lines[i].total, calc.lines[i].vat_rate, calc.lines[i].exemption_reason, l.id)); // still a draft: freeze exact computed amounts
    run(`UPDATE invoices SET status='issued', number=?, seq=?, icv=?, uuid=?, previous_hash=?, invoice_hash=?, qr=?, xml=?, seller_json=?, issued_at=?, issued_by=?, issued_by_name=?,
         subtotal=?, discount_total=?, vat_total=?, total=?, compliance_status='ready', portal_token=?, updated_at=? WHERE id=?`,
      number, seq, icv, doc.uuid, doc.previous_hash, hash, qr, xml, JSON.stringify(seller), issuedAt, user?.id ?? null, user?.name ?? null,
      calc.subtotal, calc.discount_total, calc.vat_total, calc.total, crypto.randomBytes(18).toString('base64url'), issuedAt, id);
    if (inv.doc_type === 'credit_note' && original) {
      const credited = round2(original.amount_credited + calc.total);
      const upd = { ...original, amount_credited: credited };
      run('UPDATE invoices SET amount_credited=?, status=?, updated_at=? WHERE id=?', credited, statusFor(upd), issuedAt, original.id);
      logEvent(original.id, 'credit_note_issued', `${number} for ${calc.total.toFixed(2)} ${inv.currency} — ${inv.reason}`, user);
      closeCollectionTasksIfSettled(original.id);
    }
    logEvent(id, 'issued', `${number} · ICV ${icv} · total ${calc.total.toFixed(2)} ${inv.currency}${issues.length ? ` · ${issues.length} warning(s)` : ''}`, user);
    result = { id, number, warnings: issues.filter((i) => i.severity === 'warning') };
  });
  return result;
}

export function closeCollectionTasksIfSettled(invoiceId) {
  const inv = get('SELECT status FROM invoices WHERE id=?', invoiceId);
  if (inv?.status === 'paid') run('UPDATE tasks SET done=1 WHERE invoice_id=? AND done=0', invoiceId);
}

export function recordPayment(inv, p, user) {
  if (!['issued', 'partially_paid'].includes(inv.status) || inv.doc_type === 'credit_note') throw bad('Payments can only be recorded against issued invoices with a balance.');
  const amount = round2(p.amount);
  if (!(amount > 0)) throw bad('Payment amount must be greater than zero.');
  if (amount > inv.balance + 0.005) throw bad(`Payment (${amount.toFixed(2)}) is more than the outstanding balance (${inv.balance.toFixed(2)}).`);
  const paidOn = String(p.paid_on || today()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || paidOn > today()) throw bad('Payment date must be a valid date that is not in the future.');
  const method = ['bank_transfer', 'cash', 'card', 'cheque', 'other'].includes(p.method) ? p.method : 'bank_transfer';
  let paymentId;
  tx(() => {
    paymentId = Number(run('INSERT INTO payments (invoice_id,amount,paid_on,method,reference,note,reconciled,recorded_by,recorded_by_name) VALUES (?,?,?,?,?,?,?,?,?)',
      inv.id, amount, paidOn, method, str(p.reference, 100) || null, str(p.note, 300) || null, p.reconciled ? 1 : 0, user?.id ?? null, user?.name ?? null).lastInsertRowid);
    const paid = round2(inv.amount_paid + amount); const status = statusFor({ ...inv, amount_paid: paid });
    run('UPDATE invoices SET amount_paid=?, status=?, updated_at=? WHERE id=?', paid, status, nowIso(), inv.id);
    logEvent(inv.id, 'payment', `${amount.toFixed(2)} ${inv.currency} via ${method}${p.reference ? ` (ref ${str(p.reference, 60)})` : ''} → ${status === 'paid' ? 'fully paid' : 'balance ' + round2(inv.total - paid - inv.amount_credited).toFixed(2)}`, user);
    closeCollectionTasksIfSettled(inv.id);
  });
  return paymentId;
}

/** Re-derive every hash and link from stored snapshots; reports any tampering or gaps. */
export function verifyChain() {
  const rows = all("SELECT * FROM invoices WHERE icv IS NOT NULL ORDER BY icv"); const problems = []; let prevHash = INITIAL_PIH; let expectIcv = 1;
  for (const inv of rows) {
    if (inv.icv !== expectIcv) problems.push({ number: inv.number, message: `Counter gap: expected ICV ${expectIcv}, found ${inv.icv}.` });
    expectIcv = inv.icv + 1;
    if (inv.previous_hash !== prevHash) problems.push({ number: inv.number, message: 'Previous-hash link does not match the preceding invoice.' });
    const lines = all('SELECT * FROM invoice_lines WHERE invoice_id=? ORDER BY position,id', inv.id).map((l) => ({ ...l, net: round2(l.net), vat: round2(l.vat), total: round2(l.total) }));
    let again; try { again = sha256b64(buildUbl(inv, lines, JSON.parse(inv.seller_json))); } catch { again = null; }
    if (again !== inv.invoice_hash) problems.push({ number: inv.number, message: 'Stored content no longer matches its hash (data was altered after issue).' });
    prevHash = inv.invoice_hash;
  }
  return { checked: rows.length, problems };
}

export { str as cleanStr };
