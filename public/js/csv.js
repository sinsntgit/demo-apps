/** Minimal RFC 4180 CSV parser -> array of arrays. */
export function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}
const ALIASES = {
  first_name: ['first_name', 'firstname', 'first name', 'given name'], last_name: ['last_name', 'lastname', 'last name', 'surname', 'family name'],
  email: ['email', 'e-mail', 'email address'], phone: ['phone', 'telephone', 'mobile'], title: ['title', 'job title', 'position'],
  company: ['company', 'organization', 'organisation', 'account', 'company name'], status: ['status', 'stage'], source: ['source', 'lead source'], tags: ['tags', 'tag'],
};
export function csvToContacts(text) {
  const rows = parseCsv(text); if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const idx = {}; for (const [k, names] of Object.entries(ALIASES)) idx[k] = head.findIndex((h) => names.includes(h));
  if (idx.first_name < 0 && idx.email < 0) throw new Error('CSV needs a first_name or email column');
  return rows.slice(1).map((r) => Object.fromEntries(Object.keys(ALIASES).map((k) => [k, idx[k] >= 0 ? (r[idx[k]] || '').trim() : ''])));
}
