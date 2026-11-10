import { GET, POST, bad, notFound, forbidden } from './http.js';
import { all, get, run, tx, audit, nowIso } from './db.js';
import { ENTITIES, STAGES, create, getOne } from './entities.js';
import { hasPerm, scopeOf, canOnRecord } from './permissions.js';
import { listFields } from './customfields.js';

const fullName = (c) => `${c.first_name || ''} ${c.last_name || ''}`.trim();
const domainOf = (email) => String(email || '').split('@')[1]?.toLowerCase() || '';
const FREE_MAIL = new Set(['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'live.com', 'proton.me', 'protonmail.com', 'aol.com', 'msn.com']);
const siteHost = (w) => String(w || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];

/** Accounts that probably belong to this contact: same company web domain as their e-mail. */
function accountSuggestions(c, user) {
  const d = domainOf(c.email); if (!d || FREE_MAIL.has(d)) return [];
  const own = scopeOf(user, 'accounts.view') === 'own' ? ' AND owner_id=' + Number(user.id) : '';
  return all(`SELECT id, name, website FROM accounts WHERE website IS NOT NULL AND website<>''${own}`).filter((a) => siteHost(a.website) === d || siteHost(a.website).endsWith('.' + d)).slice(0, 5);
}
const dupesOfContact = (c) => (c.email ? all("SELECT id, first_name, last_name, email FROM contacts WHERE id<>? AND (email=? OR (LOWER(first_name)=LOWER(?) AND LOWER(COALESCE(last_name,''))=LOWER(?) AND ?<>''))", c.id, c.email, c.first_name, c.last_name || '', c.last_name || '')
  : all("SELECT id, first_name, last_name, email FROM contacts WHERE id<>? AND LOWER(first_name)=LOWER(?) AND LOWER(COALESCE(last_name,''))=LOWER(?) AND ?<>''", c.id, c.first_name, c.last_name || '', c.last_name || ''));

function loadContact(id, user) {
  const c = getOne(ENTITIES.contacts, id, user);
  if (!canOnRecord(user, 'contacts.edit', c.owner_id)) throw forbidden('Your role can only change contacts you own.');
  return c;
}

GET('/api/contacts/:id/convert-preview', ({ params, user }) => {
  const c = loadContact(params.id, user);
  return {
    contact: { id: c.id, name: fullName(c), email: c.email, status: c.status, account_id: c.account_id, account_name: c.account_name, converted_at: c.converted_at, converted_deal_id: c.converted_deal_id },
    suggested_accounts: accountSuggestions(c, user),
    suggested_account_name: c.account_name || '',
    suggested_deal_name: `${c.account_name || fullName(c)} — new opportunity`,
    can_create_account: hasPerm(user, 'accounts.create'), can_create_deal: hasPerm(user, 'deals.create'),
    stages: STAGES.filter((s) => !['won', 'lost'].includes(s.key)),
  };
});

/**
 * Convert a lead: optionally create/link an account and open a deal, mark the contact qualified (or customer), and keep a permanent link
 * back to what was created. All or nothing.
 */
POST('/api/contacts/:id/convert', ({ params, body, user }) => {
  const c = loadContact(params.id, user);
  if (c.converted_at) throw bad('This contact was already converted');
  const acc = body.account || { mode: 'none' }, deal = body.deal || {};
  const status = ['qualified', 'customer'].includes(body.status) ? body.status : 'qualified';
  return tx(() => {
    let accountId = c.account_id || null, createdAccount = null, createdDeal = null;
    if (acc.mode === 'existing') {
      const a = get('SELECT id, owner_id FROM accounts WHERE id=?', Number(acc.id)); if (!a) throw bad('Choose an existing account');
      accountId = a.id;
    } else if (acc.mode === 'new') {
      if (!hasPerm(user, 'accounts.create')) throw forbidden('Your role cannot create accounts.');
      const name = String(acc.name || '').trim(); if (!name) throw bad('Enter the account name');
      createdAccount = create(ENTITIES.accounts, { name, website: acc.website || (domainOf(c.email) && !FREE_MAIL.has(domainOf(c.email)) ? domainOf(c.email) : null), owner_id: c.owner_id || user.id }, user);
      accountId = createdAccount.id;
    }
    if (deal.create) {
      if (!hasPerm(user, 'deals.create')) throw forbidden('Your role cannot create deals.');
      const name = String(deal.name || '').trim(); if (!name) throw bad('Enter the deal name');
      if (deal.stage && !STAGES.some((s) => s.key === deal.stage)) throw bad('Unknown stage');
      createdDeal = create(ENTITIES.deals, { name, amount: Number(deal.amount) || 0, stage: deal.stage || 'qualification', close_date: deal.close_date || null, account_id: accountId, contact_id: c.id, owner_id: c.owner_id || user.id, stage_comment: `Converted from lead ${fullName(c)}` }, user);
    }
    run('UPDATE contacts SET account_id=?, status=?, converted_at=?, converted_by=?, converted_deal_id=?, converted_account_id=? WHERE id=?', accountId, status, nowIso(), user.id, createdDeal?.id ?? null, createdAccount?.id ?? accountId, c.id);
    run("INSERT INTO activities (type, body, contact_id, deal_id, account_id, user_id) VALUES ('note', ?, ?, ?, ?, ?)",
      `Lead converted${createdAccount ? ` — account “${createdAccount.name}” created` : accountId ? ' — linked to account' : ''}${createdDeal ? ` — deal “${createdDeal.name}” opened` : ''}.`, c.id, createdDeal?.id ?? null, accountId, user.id);
    audit(user, 'convert', 'contacts', c.id, fullName(c));
    return { contact: getOne(ENTITIES.contacts, c.id), account_id: accountId, deal_id: createdDeal?.id ?? null, created_account: !!createdAccount };
  });
});

// ---------------------------------------------------------------- duplicates
GET('/api/duplicates/contacts', () => {
  const groups = [];
  const byEmail = all("SELECT LOWER(email) k FROM contacts WHERE email IS NOT NULL AND email<>'' GROUP BY LOWER(email) HAVING COUNT(*)>1");
  const seen = new Set();
  for (const { k } of byEmail) { const rows = all("SELECT id, first_name, last_name, email, phone, status, created_at FROM contacts WHERE LOWER(email)=?", k); rows.forEach((r) => seen.add(r.id)); groups.push({ reason: 'Same email', rows }); }
  const byName = all("SELECT LOWER(first_name)||'|'||LOWER(last_name) k FROM contacts WHERE last_name IS NOT NULL AND last_name<>'' GROUP BY k HAVING COUNT(*)>1");
  for (const { k } of byName) { const [f, l] = k.split('|'); const rows = all("SELECT id, first_name, last_name, email, phone, status, created_at FROM contacts WHERE LOWER(first_name)=? AND LOWER(last_name)=?", f, l).filter((r) => !seen.has(r.id)); if (rows.length > 1) groups.push({ reason: 'Same name', rows }); }
  return groups;
});
GET('/api/duplicates/accounts', () => {
  const groups = []; const seen = new Set();
  for (const { k } of all("SELECT LOWER(TRIM(name)) k FROM accounts GROUP BY k HAVING COUNT(*)>1")) { const rows = all('SELECT id, name, website, city, vat_number, created_at FROM accounts WHERE LOWER(TRIM(name))=?', k); rows.forEach((r) => seen.add(r.id)); groups.push({ reason: 'Same name', rows }); }
  for (const { k } of all("SELECT vat_number k FROM accounts WHERE vat_number IS NOT NULL AND vat_number<>'' GROUP BY vat_number HAVING COUNT(*)>1")) { const rows = all('SELECT id, name, website, city, vat_number, created_at FROM accounts WHERE vat_number=?', k).filter((r) => !seen.has(r.id)); if (rows.length > 1) groups.push({ reason: 'Same VAT number', rows }); }
  return groups;
});

/** Re-point every custom "link to another record" value that referenced `fromId` so nothing is left dangling. */
function repointLookups(target, fromId, toId) {
  for (const ent of ['contacts', 'accounts', 'deals']) for (const f of listFields(ent, { archived: true })) {
    if (f.type !== 'lookup' || f.config.target !== target) continue;
    run(`UPDATE ${ent} SET custom = json_set(custom, '$.${f.key}', ?) WHERE json_extract(custom, '$.${f.key}') = ?`, toId, fromId);
  }
}

function merge(entName, params, body, user, { fields, relink }) {
  const ent = ENTITIES[entName]; const fromId = Number(params.id), toId = Number(body.into);
  if (!toId || fromId === toId) throw bad('Choose a different record to merge into');
  const from = getOne(ent, fromId, user), to = getOne(ent, toId, user);
  for (const r of [from, to]) if (!canOnRecord(user, `${entName}.edit`, r.owner_id) || !canOnRecord(user, `${entName}.delete`, r.owner_id)) throw forbidden(`Your role can only merge ${entName} you own.`);
  const pick = body.prefer && typeof body.prefer === 'object' ? body.prefer : {};
  return tx(() => {
    const upd = {};
    for (const f of fields) {
      const a = to[f] ?? null, b = from[f] ?? null;
      if (b === null || b === '') continue;
      if (a === null || a === '' || pick[f] === 'source') upd[f] = b;
    }
    if (entName === 'contacts') { // tags union; unsubscribed stays unsubscribed
      const tags = [...new Set([...(String(to.tags || '').split(',')), ...(String(from.tags || '').split(','))].map((t) => t.trim()).filter(Boolean))].join(', '); if (tags) upd.tags = tags;
      if (!from.subscribed || !to.subscribed) upd.subscribed = 0;
      if (to.converted_at == null && from.converted_at) for (const k of ['converted_at', 'converted_by', 'converted_deal_id', 'converted_account_id']) upd[k] = from[k];
    }
    const custom = { ...(from.custom || {}), ...(to.custom || {}) };
    for (const k of Object.keys(pick)) if (k.startsWith('cf_') && pick[k] === 'source' && from.custom?.[k] !== undefined) custom[k] = from.custom[k];
    relink(fromId, toId);
    repointLookups(entName, fromId, toId);
    run('UPDATE files SET record_id=? WHERE entity=? AND record_id=?', toId, entName, fromId);
    run(`DELETE FROM ${entName} WHERE id=?`, fromId); // after the re-link, and before copying a unique email onto the survivor
    upd.custom = JSON.stringify(custom);
    run(`UPDATE ${entName} SET ${Object.keys(upd).map((c) => `${c}=?`).join(',')} WHERE id=?`, ...Object.values(upd), toId);
    audit(user, 'merge', entName, toId, `${from.name || fullName(from)} (#${fromId}) merged into ${to.name || fullName(to)}`);
    return getOne(ent, toId);
  });
}
POST('/api/contacts/:id/merge', ({ params, body, user }) => merge('contacts', params, body, user, {
  fields: ['first_name', 'last_name', 'email', 'phone', 'title', 'account_id', 'source', 'status', 'owner_id'],
  relink: (f, t) => {
    for (const tb of ['deals', 'tasks', 'activities', 'invoices', 'campaign_recipients']) run(`UPDATE ${tb} SET contact_id=? WHERE contact_id=?`, t, f);
  },
}));
POST('/api/accounts/:id/merge', ({ params, body, user }) => merge('accounts', params, body, user, {
  fields: ['name', 'industry', 'website', 'size', 'city', 'country', 'phone', 'notes', 'owner_id', 'name_ar', 'vat_number', 'street', 'building_no', 'district', 'postal_code', 'country_code', 'billing_email', 'billing_phone'],
  relink: (f, t) => { for (const tb of ['contacts', 'deals', 'invoices', 'activities']) run(`UPDATE ${tb} SET account_id=? WHERE account_id=?`, t, f); },
}));
