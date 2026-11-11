/*
 * Invoicing modes. The company picks one in Billing settings; each invoice remembers the mode it was created under.
 *   KSA  — Saudi Arabia, ZATCA e-invoicing (bilingual, 15-digit VAT numbers, QR, hash chain, provider submission)
 *   UAE  — UAE FTA VAT (TRN), e-invoicing ready
 *   IN   — India GST (GSTIN, place of supply, CGST+SGST or IGST, HSN/SAC codes, amount in words)
 *   GEN  — any other country: plain invoices with your own tax name/rate/ID label (UK VAT, US sales tax, Thailand VAT…)
 */
export const REGIMES = {
  KSA: { label: 'Saudi Arabia — ZATCA e-invoicing', country: 'SA', currency: 'SAR', rate: 15, tax: 'VAT', taxId: 'VAT number', lang: 'both', einvoicing: true },
  UAE: { label: 'United Arab Emirates — VAT (FTA)', country: 'AE', currency: 'AED', rate: 5, tax: 'VAT', taxId: 'TRN', lang: 'both', einvoicing: true },
  IN: { label: 'India — GST', country: 'IN', currency: 'INR', rate: 18, tax: 'GST', taxId: 'GSTIN', lang: 'en', einvoicing: false },
  GEN: { label: 'Any other country — standard invoices', country: '', currency: 'USD', rate: 0, tax: 'Tax', taxId: 'Tax ID', lang: 'en', einvoicing: false },
};
export const isRegime = (j) => Object.prototype.hasOwnProperty.call(REGIMES, j);
export const isGulf = (j) => j === 'KSA' || j === 'UAE';

/** One-click defaults for "any other country". Tax rates are the common standard rates — always check your own. */
export const COUNTRY_PRESETS = {
  GB: { name: 'United Kingdom', currency: 'GBP', tax: 'VAT', rate: 20, taxId: 'VAT registration no.', title: 'VAT Invoice', bank: 'Sort code' },
  US: { name: 'United States', currency: 'USD', tax: 'Sales tax', rate: 0, taxId: 'EIN / Tax ID', title: 'Invoice', bank: 'Routing (ABA) no.' },
  TH: { name: 'Thailand', currency: 'THB', tax: 'VAT', rate: 7, taxId: 'Tax ID (13 digits)', title: 'Tax Invoice', bank: 'Branch code' },
  SG: { name: 'Singapore', currency: 'SGD', tax: 'GST', rate: 9, taxId: 'GST reg. no.', title: 'Tax Invoice', bank: 'Bank code' },
  MY: { name: 'Malaysia', currency: 'MYR', tax: 'SST', rate: 8, taxId: 'SST reg. no.', title: 'Invoice', bank: 'Bank code' },
  AU: { name: 'Australia', currency: 'AUD', tax: 'GST', rate: 10, taxId: 'ABN', title: 'Tax Invoice', bank: 'BSB' },
  NZ: { name: 'New Zealand', currency: 'NZD', tax: 'GST', rate: 15, taxId: 'GST no.', title: 'Tax Invoice', bank: 'Bank code' },
  CA: { name: 'Canada', currency: 'CAD', tax: 'GST/HST', rate: 5, taxId: 'Business number (BN)', title: 'Invoice', bank: 'Transit / institution no.' },
  DE: { name: 'Germany', currency: 'EUR', tax: 'VAT', rate: 19, taxId: 'VAT ID (USt-IdNr.)', title: 'Invoice', bank: 'BIC' },
  FR: { name: 'France', currency: 'EUR', tax: 'VAT', rate: 20, taxId: 'VAT no. (TVA)', title: 'Invoice', bank: 'BIC' },
  NL: { name: 'Netherlands', currency: 'EUR', tax: 'VAT', rate: 21, taxId: 'VAT ID (BTW)', title: 'Invoice', bank: 'BIC' },
  IE: { name: 'Ireland', currency: 'EUR', tax: 'VAT', rate: 23, taxId: 'VAT no.', title: 'VAT Invoice', bank: 'BIC' },
  BH: { name: 'Bahrain', currency: 'BHD', tax: 'VAT', rate: 10, taxId: 'VAT account no.', title: 'Tax Invoice', bank: 'SWIFT' },
  OM: { name: 'Oman', currency: 'OMR', tax: 'VAT', rate: 5, taxId: 'VATIN', title: 'Tax Invoice', bank: 'SWIFT' },
  QA: { name: 'Qatar', currency: 'QAR', tax: 'Tax', rate: 0, taxId: 'Tax / CR no.', title: 'Invoice', bank: 'SWIFT' },
  KW: { name: 'Kuwait', currency: 'KWD', tax: 'Tax', rate: 0, taxId: 'CR no.', title: 'Invoice', bank: 'SWIFT' },
  EG: { name: 'Egypt', currency: 'EGP', tax: 'VAT', rate: 14, taxId: 'Tax registration no.', title: 'Tax Invoice', bank: 'SWIFT' },
  JO: { name: 'Jordan', currency: 'JOD', tax: 'Sales tax', rate: 16, taxId: 'Tax no.', title: 'Invoice', bank: 'SWIFT' },
  ZA: { name: 'South Africa', currency: 'ZAR', tax: 'VAT', rate: 15, taxId: 'VAT no.', title: 'Tax Invoice', bank: 'Branch code' },
  KE: { name: 'Kenya', currency: 'KES', tax: 'VAT', rate: 16, taxId: 'KRA PIN', title: 'Tax Invoice', bank: 'Bank code' },
  NG: { name: 'Nigeria', currency: 'NGN', tax: 'VAT', rate: 7.5, taxId: 'TIN', title: 'Invoice', bank: 'Bank code' },
  JP: { name: 'Japan', currency: 'JPY', tax: 'Consumption tax', rate: 10, taxId: 'Registration no.', title: 'Invoice', bank: 'Branch code' },
  OTHER: { name: 'Other country', currency: 'USD', tax: 'Tax', rate: 0, taxId: 'Tax ID', title: 'Invoice', bank: 'Bank / routing code' },
};

/** GST state codes (first two digits of a GSTIN). */
export const INDIAN_STATES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  10: 'Bihar', 11: 'Sikkim', 12: 'Arunachal Pradesh', 13: 'Nagaland', 14: 'Manipur', 15: 'Mizoram', 16: 'Tripura', 17: 'Meghalaya', 18: 'Assam', 19: 'West Bengal', 20: 'Jharkhand',
  21: 'Odisha', 22: 'Chhattisgarh', 23: 'Madhya Pradesh', 24: 'Gujarat', 26: 'Dadra and Nagar Haveli and Daman and Diu', 27: 'Maharashtra', 29: 'Karnataka', 30: 'Goa', 31: 'Lakshadweep',
  32: 'Kerala', 33: 'Tamil Nadu', 34: 'Puducherry', 35: 'Andaman and Nicobar Islands', 36: 'Telangana', 37: 'Andhra Pradesh', 38: 'Ladakh', 97: 'Other Territory',
};
/** "Karnataka", "29", "29-Karnataka", "karnataka " → "29". */
export function stateCode(v) {
  const s = String(v ?? '').trim(); if (!s) return null;
  const m = /^(\d{1,2})\b/.exec(s); if (m) { const c = m[1].padStart(2, '0'); return INDIAN_STATES[c] ? c : null; }
  const low = s.toLowerCase(); return Object.entries(INDIAN_STATES).find(([, n]) => n.toLowerCase() === low)?.[0] ?? null;
}
export const stateLabel = (code) => (code && INDIAN_STATES[code] ? `${INDIAN_STATES[code]} (${code})` : '');

// GSTIN: 2-digit state + 10-char PAN + entity number + Z + check character (mod-36 checksum)
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export function gstinValid(v) {
  const g = String(v || '').trim().toUpperCase(); if (!GSTIN.test(g) || !INDIAN_STATES[g.slice(0, 2)]) return false;
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'; let sum = 0;
  for (let i = 0; i < 14; i++) { const p = chars.indexOf(g[i]) * (i % 2 ? 2 : 1); sum += Math.floor(p / 36) + (p % 36); }
  return chars[(36 - (sum % 36)) % 36] === g[14];
}

/** How GST applies to an Indian invoice: within the seller's state → CGST+SGST; another state → IGST; outside India → export. */
export function gstSupplyType(sellerState, inv) {
  if ((inv.buyer_country || 'IN').toUpperCase() !== 'IN') return 'export';
  const pos = stateCode(inv.place_of_supply || inv.buyer_state);
  if (!pos || !sellerState) return 'intra';
  return pos === stateCode(sellerState) ? 'intra' : 'inter';
}

// ---- amount in words (Indian numbering for INR: lakh / crore; international otherwise) ----
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const under1000 = (n) => { const h = Math.floor(n / 100), r = n % 100; return [h ? `${ONES[h]} Hundred` : '', r < 20 ? ONES[r] : `${TENS[Math.floor(r / 10)]}${r % 10 ? ' ' + ONES[r % 10] : ''}`].filter(Boolean).join(' '); };
function words(n, indian) {
  if (n === 0) return 'Zero'; const parts = [];
  const scales = indian ? [[1e7, 'Crore'], [1e5, 'Lakh'], [1e3, 'Thousand']] : [[1e12, 'Trillion'], [1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand']];
  for (const [v, name] of scales) if (n >= v) { const q = Math.floor(n / v); parts.push(`${indian && q >= 1000 ? words(q, true) : under1000(q)} ${name}`); n %= v; }
  if (n) parts.push(under1000(n)); return parts.join(' ');
}
const UNITS = { INR: ['Rupees', 'Paise'], USD: ['US Dollars', 'Cents'], GBP: ['Pounds', 'Pence'], EUR: ['Euros', 'Cents'], AED: ['Dirhams', 'Fils'], SAR: ['Riyals', 'Halalas'], THB: ['Baht', 'Satang'] };
export function amountInWords(amount, currency) {
  const a = Math.round(Math.abs(Number(amount) || 0) * 100); const whole = Math.floor(a / 100), frac = a % 100;
  const [major, minor] = UNITS[currency] || [currency, 'cents'];
  return `${major} ${words(whole, currency === 'INR')}${frac ? ` and ${words(frac, false)} ${minor}` : ''} Only`;
}

/** Validate a tax ID for a mode; GEN accepts any sensible registration number. */
export function taxIdValid(v, jur) {
  const s = String(v || '').trim(); if (!s) return false;
  if (jur === 'KSA') return /^3\d{13}3$/.test(s);
  if (jur === 'UAE') return /^\d{15}$/.test(s);
  if (jur === 'IN') return gstinValid(s);
  return /^[A-Za-z0-9][A-Za-z0-9 .\-/]{2,29}$/.test(s);
}
export const WHATSAPP_PREFIX = { SA: '966', AE: '971', IN: '91', GB: '44', US: '1', TH: '66', SG: '65', MY: '60', AU: '61', NZ: '64', CA: '1', DE: '49', FR: '33', NL: '31', IE: '353', BH: '973', OM: '968', QA: '974', KW: '965', EG: '20', JO: '962', ZA: '27', KE: '254', NG: '234', JP: '81' };
