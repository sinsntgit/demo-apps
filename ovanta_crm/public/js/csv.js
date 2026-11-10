/** Spreadsheet file reading for contact import: CSV/TSV/TXT (any common delimiter) and Excel .xlsx. All parsing happens in the browser. */

export function parseCsv(text, delim) {
  text = text.replace(/^﻿/, '');
  if (!delim) { const first = text.split(/\r?\n/, 1)[0] || ''; const n = (c) => first.split(c).length; delim = [[',', n(',')], [';', n(';')], ['\t', n('\t')]].sort((a, b) => b[1] - a[1])[0][0]; }
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

// ---- minimal .xlsx reader (zip + XML) ----
async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter(); w.write(bytes); w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}
export async function unzip(buf, want = /^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml|workbook\.xml)$/) {
  const v = new DataView(buf), u8 = new Uint8Array(buf); const files = {};
  let eocd = -1; for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This does not look like an Office (.xlsx/.docx) file');
  const count = v.getUint16(eocd + 10, true); let p = v.getUint32(eocd + 16, true);
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true), nlen = v.getUint16(p + 28, true), elen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true), off = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen)); p += 46 + nlen + elen + clen;
    if (!want.test(name)) continue;
    const start = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true), data = u8.subarray(start, start + csize);
    files[name] = new TextDecoder().decode(method === 0 ? data : await inflateRaw(data));
  }
  return files;
}
const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/[^A-Z]/gi, '').toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
export async function parseXlsx(buf) {
  const files = await unzip(buf); const dom = (x) => new DOMParser().parseFromString(x, 'application/xml');
  const sheetName = Object.keys(files).filter((n) => /worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/(\d+)\.xml/)[1]) - parseInt(b.match(/(\d+)\.xml/)[1]))[0];
  if (!sheetName) throw new Error('No worksheet found in this file');
  const shared = files['xl/sharedStrings.xml'] ? [...dom(files['xl/sharedStrings.xml']).getElementsByTagName('si')].map((si) => [...si.getElementsByTagName('t')].map((t) => t.textContent).join('')) : [];
  const rows = [];
  for (const r of dom(files[sheetName]).getElementsByTagName('row')) {
    const row = [];
    for (const c of r.getElementsByTagName('c')) {
      const t = c.getAttribute('t'), vEl = c.getElementsByTagName('v')[0]; let val = '';
      if (t === 'inlineStr') val = [...c.getElementsByTagName('t')].map((x) => x.textContent).join('');
      else if (vEl) val = t === 's' ? shared[Number(vEl.textContent)] ?? '' : vEl.textContent;
      if (t === 'b') val = val === '1' ? 'yes' : 'no';
      row[colIndex(c.getAttribute('r') || 'A1')] = String(val).trim();
    }
    if (row.some((x) => x)) rows.push(Array.from(row, (x) => x ?? ''));
  }
  return rows;
}

/** Read a File into {rows: string[][]} (first row = headers). */
export async function readTable(file) {
  if (file.size > 8 * 1024 * 1024) throw new Error('File is larger than 8 MB — split it into smaller files.');
  const isXlsx = /\.xlsx$/i.test(file.name) || file.type.includes('spreadsheetml');
  if (/\.xls$/i.test(file.name)) throw new Error('Old .xls files are not supported — save as .xlsx or CSV first.');
  const rows = isXlsx ? await parseXlsx(await file.arrayBuffer()) : parseCsv(await file.text());
  if (rows.length < 2) throw new Error('The file needs a header row and at least one data row.');
  return rows;
}

export const FIELDS = [
  ['first_name', 'First name', ['first_name', 'firstname', 'first name', 'given name', 'first']],
  ['last_name', 'Last name', ['last_name', 'lastname', 'last name', 'surname', 'family name', 'last']],
  ['email', 'Email', ['email', 'e-mail', 'email address', 'mail', 'email id']],
  ['phone', 'Phone', ['phone', 'telephone', 'mobile', 'phone number', 'contact number', 'mobile number']],
  ['title', 'Job title', ['title', 'job title', 'position', 'designation', 'role']],
  ['company', 'Company', ['company', 'organization', 'organisation', 'account', 'company name', 'employer']],
  ['status', 'Status (lead/qualified/customer/churned)', ['status', 'stage', 'lifecycle']],
  ['source', 'Source', ['source', 'lead source']],
  ['tags', 'Tags', ['tags', 'tag', 'labels']],
  ['subscribed', 'Subscribed (yes/no)', ['subscribed', 'opt in', 'opt-in', 'consent', 'marketing consent']],
];
/** Guess a header→field mapping. Returns {field: columnIndex | -1}. */
export function guessMapping(headers, extra = []) {
  const h = headers.map((x) => String(x).trim().toLowerCase()); const m = {};
  for (const [key, , names] of [...FIELDS, ...extra]) m[key] = h.findIndex((x) => names.includes(x));
  if (m.first_name < 0 && m.last_name < 0) { const i = h.findIndex((x) => ['name', 'full name', 'contact name', 'contact'].includes(x)); if (i >= 0) m.first_name = i; }
  return m;
}
/** `extra` = custom-field targets [['custom:cf_key', label, [header names]]]; their values go into row.custom. */
export function applyMapping(rows, map, extra = []) {
  return rows.slice(1).map((r) => {
    const o = Object.fromEntries(FIELDS.map(([k]) => [k, map[k] >= 0 ? String(r[map[k]] ?? '').trim() : '']));
    const custom = {}; for (const [key] of extra) { const i = map[key]; if (i >= 0 && String(r[i] ?? '').trim() !== '') custom[key.slice(7)] = String(r[i]).trim(); }
    if (Object.keys(custom).length) o.custom = custom; return o;
  });
}
export const TEMPLATE_CSV = 'first_name,last_name,email,phone,title,company,status,source,tags,subscribed\nAsha,Rao,asha.rao@example.com,+91 98765 43210,Head of Operations,Example Pvt Ltd,lead,Website,"newsletter, expo-2026",yes\n';

// ---- invoice import (Zoho Books, QuickBooks, Xero and generic exports) ----
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
export const INVOICE_FIELDS = [
  ['invoice_number', 'Invoice number', ['invoicenumber', 'invoiceno', 'invoice', 'num', 'number', 'invoiceid', 'docnumber', 'billnumber']],
  ['issue_date', 'Invoice date', ['invoicedate', 'date', 'txndate', 'issuedate', 'created']],
  ['due_date', 'Due date', ['duedate', 'due', 'paymentdue']],
  ['customer', 'Customer name', ['customername', 'customer', 'contactname', 'contact', 'clientname', 'client', 'billto', 'name']],
  ['customer_vat', 'Customer VAT / TRN', ['taxregistrationnumber', 'taxregistrationno', 'trn', 'vatnumber', 'vatno', 'vat', 'taxnumber', 'customervat', 'taxid', 'customertrn']],
  ['customer_email', 'Customer email', ['email', 'emailaddress', 'customeremail', 'contactemail']],
  ['customer_phone', 'Customer phone', ['phone', 'mobile', 'customerphone', 'phonenumber']],
  ['currency', 'Currency', ['currencycode', 'currency']],
  ['description', 'Item / description', ['itemdescription', 'description', 'itemdesc', 'itemname', 'productservice', 'productservicedescription', 'item', 'lineitemdescription']],
  ['qty', 'Quantity', ['quantity', 'qty']],
  ['unit_price', 'Unit price', ['itemprice', 'unitamount', 'unitprice', 'rate', 'price', 'unitcost']],
  ['discount', 'Discount amount', ['discount', 'discountamount', 'itemdiscount']],
  ['vat_rate', 'VAT rate %', ['itemtaxpercentage', 'itemtax', 'taxpercentage', 'taxrate', 'vatrate', 'vat', 'tax']],
];
export function guessInvoiceMapping(headers) {
  const h = headers.map(norm); const m = {}; const used = new Set();
  for (const [key, , names] of INVOICE_FIELDS) { const i = h.findIndex((x, idx) => !used.has(idx) && names.includes(x)); m[key] = i; if (i >= 0) used.add(i); }
  return m;
}
export const applyInvoiceMapping = (rows, map) => rows.slice(1).map((r) => Object.fromEntries(INVOICE_FIELDS.map(([k]) => [k, map[k] >= 0 ? String(r[map[k]] ?? '').trim() : ''])));
