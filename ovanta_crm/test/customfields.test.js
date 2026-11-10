import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.SEED_BILLING_DEMO = '0'; process.env.DB_PATH = ':memory:'; process.env.SESSION_SECRET = 'cf-secret'; process.env.BASE_URL = 'http://crm.test';
const { server } = await import('../server/index.js');
const { seedIfEmpty } = await import('../server/seed.js');
const { db } = await import('../server/db.js');

let base, admin, rep;
before(async () => { seedIfEmpty(); await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; });
after(() => server.close());
async function call(ck, method, path, body) {
  const r = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie: ck || '' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j, headers: r.headers };
}
const login = async (email) => (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Ovantaa@123' }) })).headers.get('set-cookie').split(';')[0];
const A = (m, p, b) => call(admin, m, p, b);
const mk = async (entity, label, type, extra = {}) => { const r = await A('POST', '/api/customization/fields', { entity, label, type, ...extra }); assert.equal(r.status, 200, `${label}: ${JSON.stringify(r.body)}`); return r.body; };
const F = {}; // created fields

test('setup: only the Customisation permission can manage fields; everyone can read the bundle', async () => {
  admin = await login('admin@ovantaa.com'); rep = await login('liam@ovantaa.com'); const mgr = await login('maya@ovantaa.com');
  assert.equal((await call(rep, 'GET', '/api/customization')).status, 200);
  assert.equal((await call(rep, 'POST', '/api/customization/fields', { entity: 'deals', label: 'X', type: 'text' })).status, 403);
  assert.equal((await call(mgr, 'POST', '/api/customization/fields', { entity: 'deals', label: 'X', type: 'text' })).status, 403, 'managers cannot customise by default');
  assert.equal((await call(rep, 'PUT', '/api/customization/layout/deals', { sections: [] })).status, 403);
  const me = (await A('GET', '/api/auth/me')).body.user; assert.equal(me.perms.customization.manage, true, 'admin keeps full access including the new permission');
  const b = (await call(rep, 'GET', '/api/customization')).body; assert.deepEqual(Object.keys(b.entities).sort(), ['accounts', 'contacts', 'deals']); assert.ok(b.types.dropdown && b.entities.deals.builtin.length >= 8);
  assert.equal(b.entities.deals.layout.saved, false); assert.deepEqual(b.entities.deals.layout.sections[0].fields.slice(0, 3), ['name', 'amount', 'stage']);
});

test('field definitions: every type, validation of labels/options/config, keys unique and safe', async () => {
  F.dealType = await mk('deals', 'Deal type', 'dropdown', { options: ['Direct', 'Partner', 'Reseller'], required: true, show_in_list: true, filterable: true, help_text: 'How was this sold?' });
  assert.equal(F.dealType.key, 'cf_deal_type'); assert.deepEqual(F.dealType.options, ['Direct', 'Partner', 'Reseller']);
  F.partner = await mk('deals', 'Partner', 'lookup', { config: { target: 'accounts' }, visible_when: { field: 'cf_deal_type', values: ['Partner', 'Reseller'] }, show_in_list: true });
  F.margin = await mk('deals', 'Partner margin', 'percent', { visible_when: { field: 'cf_deal_type', values: ['Partner', 'Reseller'] }, required: true, config: { decimals: 1 } });
  F.details = await mk('deals', 'Deal details', 'textarea', { searchable: true });
  F.po = await mk('deals', 'PO reference', 'text', { searchable: true, config: { maxLength: 20 } });
  F.signed = await mk('deals', 'Contract signed on', 'date', {}); F.value2 = await mk('deals', 'Partner fee', 'currency', { config: { decimals: 2, min: 0, code: 'sar' } });
  F.nda = await mk('deals', 'NDA signed', 'checkbox', { default_value: false }); F.tags = await mk('deals', 'Regions', 'multiselect', { options: ['KSA', 'UAE', 'Qatar'], filterable: true });
  F.web = await mk('deals', 'Portal link', 'url'); F.mail = await mk('deals', 'Partner email', 'email'); F.tel = await mk('deals', 'Partner phone', 'phone'); F.num = await mk('deals', 'Seats', 'number', { config: { decimals: 0, min: 1, max: 1000 } });
  assert.equal(F.value2.config.code, 'SAR'); assert.equal(F.margin.config.min, 0); assert.equal(F.margin.config.max, 100, 'percent defaults to 0–100');
  assert.equal((await mk('deals', 'Deal type', 'text')).key, 'cf_deal_type_2', 'duplicate labels get a unique key');
  assert.equal((await mk('deals', 'Nom d’été', 'text')).key.startsWith('cf_nom_d_ete'), true, 'accents/punctuation become a safe key');
  const bad = (b) => A('POST', '/api/customization/fields', b);
  assert.equal((await bad({ entity: 'tasks', label: 'x', type: 'text' })).status, 400, 'tasks are not customisable');
  assert.equal((await bad({ entity: 'deals', label: '', type: 'text' })).status, 400); assert.equal((await bad({ entity: 'deals', label: 'x'.repeat(61), type: 'text' })).status, 400);
  assert.equal((await bad({ entity: 'deals', label: 'x', type: 'nope' })).status, 400); assert.equal((await bad({ entity: 'deals', label: 'Pick', type: 'dropdown', options: [] })).status, 400, 'a list needs options');
  assert.equal((await bad({ entity: 'deals', label: 'Pick', type: 'dropdown', options: ['A', 'a'] })).status, 400, 'options must differ'); assert.equal((await bad({ entity: 'deals', label: 'L', type: 'lookup' })).status, 400, 'lookup needs a target');
  assert.equal((await bad({ entity: 'deals', label: 'N', type: 'number', config: { min: 5, max: 1 } })).status, 400); assert.equal((await bad({ entity: 'deals', label: 'K', type: 'text', key: "cf_x'); DROP TABLE deals;--" })).status, 400, 'explicit keys are validated');
  assert.equal((await bad({ entity: 'deals', label: 'V', type: 'text', visible_when: { field: 'nonexistent', values: ['x'] } })).status, 400); assert.equal((await bad({ entity: 'deals', label: 'D', type: 'dropdown', options: ['A'], default_value: 'B' })).status, 400, 'default must be valid');
  assert.equal((await bad({ entity: 'deals', label: 'D2', type: 'dropdown', options: ['A', 'B'], default_value: 'B' })).status, 200);
  const list = (await call(rep, 'GET', '/api/customization')).body.entities.deals.fields; assert.ok(list.length >= 13);
  const ed = (await A('PUT', `/api/customization/fields/${F.num.id}`, { label: 'Seat count', type: 'text' })).body; assert.equal(ed.type, 'number', 'a field type can never change'); assert.equal(ed.key, 'cf_seats', 'the key never changes'); assert.equal(ed.label, 'Seat count');
});

test('saving deals with custom values: types, required, conditional required, defaults, unknown keys', async () => {
  const mkDeal = (custom, extra = {}) => A('POST', '/api/deals', { name: 'Partner deal', amount: 1000, ...extra, ...(custom === undefined ? {} : { custom }) });
  assert.equal((await mkDeal(undefined)).status, 400, 'required "Deal type" is enforced on create even when no custom block is sent');
  const direct = await mkDeal({ cf_deal_type: 'Direct' }); assert.equal(direct.status, 200, JSON.stringify(direct.body)); assert.equal(direct.body.custom.cf_nda_signed, false, 'default applied'); assert.equal(direct.body.custom.cf_partner_margin, undefined, 'conditional field not required for Direct');
  const noMargin = await mkDeal({ cf_deal_type: 'Partner' }); assert.equal(noMargin.status, 400); assert.match(noMargin.body.error, /Partner margin is required/);
  const partner = (await A('POST', '/api/accounts', { name: 'Gulf Partner LLC' })).body;
  const ok = await mkDeal({ cf_deal_type: 'Partner', cf_partner: partner.id, cf_partner_margin: '12.55', cf_deal_details: '  Resell via Gulf Partner  ', cf_po_reference: 'PO-1', cf_contract_signed_on: '2026-11-01', cf_partner_fee: '1,500.456', cf_nda_signed: 'true', cf_regions: ['KSA', 'UAE', 'KSA'], cf_portal_link: 'https://p.example/x', cf_partner_email: 'ABC@Partner.EXAMPLE', cf_partner_phone: '+966 50 123 4567', cf_seats: '25.7', cf_bogus: 'ignored' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); const c = ok.body.custom;
  assert.equal(c.cf_partner_margin, 12.6, 'percent rounded to 1 decimal'); assert.equal(c.cf_deal_details, 'Resell via Gulf Partner'); assert.equal(c.cf_partner_fee, 1500.46); assert.equal(c.cf_nda_signed, true); assert.deepEqual(c.cf_regions, ['KSA', 'UAE'], 'duplicates removed');
  assert.equal(c.cf_partner_email, 'abc@partner.example'); assert.equal(c.cf_seats, 26); assert.equal(c.cf_bogus, undefined, 'unknown keys are dropped'); assert.equal(c.cf_partner, partner.id); assert.equal(ok.body.custom_labels.cf_partner, 'Gulf Partner LLC', 'lookup shows the record name');
  const err = async (custom, re) => { const r = await mkDeal({ cf_deal_type: 'Direct', ...custom }); assert.equal(r.status, 400, JSON.stringify(custom)); assert.match(r.body.error, re, JSON.stringify(r.body)); };
  await err({ cf_deal_type: 'Bogus' }, /Deal type is not one of the available options/); await err({ cf_partner_margin: '150' }, /at most 100/); await err({ cf_partner_margin: 'abc' }, /must be a number/); await err({ cf_partner_fee: '-1' }, /at least 0/);
  await err({ cf_contract_signed_on: '2026-13-45' }, /valid date/); await err({ cf_partner_email: 'nope' }, /valid email/); await err({ cf_partner_phone: 'abc' }, /valid phone/); await err({ cf_portal_link: 'javascript:alert(1)' }, /web address/);
  await err({ cf_regions: ['KSA', 'Mars'] }, /"Mars" is not one of/); await err({ cf_po_reference: 'x'.repeat(21) }, /at most 20/); await err({ cf_partner: 999999 }, /does not exist/); await err({ cf_seats: '5000' }, /at most 1000/); await err({ cf_seats: '0' }, /at least 1/);
  assert.ok(Array.isArray(noMargin.body.errors)); const multi = await mkDeal({ cf_deal_type: 'Direct', cf_partner_margin: 'x', cf_partner_email: 'y' }); assert.equal(multi.body.errors.length, 2, 'all problems are reported together');
  // update semantics: only sent keys change; clearing; required re-checked when custom is sent; plain edits leave custom alone
  const id = ok.body.id;
  const up = (await A('PUT', `/api/deals/${id}`, { custom: { cf_po_reference: 'PO-2', cf_deal_details: '' } })).body; assert.equal(up.custom.cf_po_reference, 'PO-2'); assert.equal(up.custom.cf_deal_details, undefined, 'empty clears'); assert.equal(up.custom.cf_partner_margin, 12.6, 'untouched keys keep their value');
  assert.equal((await A('PUT', `/api/deals/${id}`, { name: 'Renamed' })).body.custom.cf_po_reference, 'PO-2', 'edits without custom leave it alone'); assert.equal((await A('POST', `/api/deals/${id}/stage`, { stage: 'proposal' })).status, 200, 'stage moves never touch custom validation');
  assert.equal((await A('PUT', `/api/deals/${id}`, { custom: { cf_partner_margin: '' } })).status, 400, 'cannot blank a required visible field');
  assert.equal((await A('PUT', `/api/deals/${id}`, { custom: { cf_deal_type: 'Direct', cf_partner_margin: '' } })).status, 200, 'hidden (conditional) fields are not required');
  F.dealId = id; F.partnerAcc = partner;
});

test('lists: filters, ranges, multiselect, text search, sorting — keys come only from stored definitions (no injection)', async () => {
  const mk2 = (n, c) => A('POST', '/api/deals', { name: n, amount: 5, custom: { cf_deal_type: 'Direct', ...c } });
  await mk2('Alpha deal', { cf_seats: 5, cf_regions: ['KSA'], cf_po_reference: 'ALPHA-1', cf_contract_signed_on: '2026-01-10' }); await mk2('Beta deal', { cf_seats: 50, cf_regions: ['UAE', 'Qatar'], cf_po_reference: 'BETA-9', cf_contract_signed_on: '2026-03-10', cf_nda_signed: true });
  await mk2('Gamma deal', { cf_seats: 500, cf_deal_details: 'special terms apply', cf_contract_signed_on: '2026-06-10' });
  const q = async (qs) => (await A('GET', `/api/deals?limit=100&${qs}`)).body.rows.map((r) => r.name);
  assert.deepEqual((await q('cf_deal_type=Partner')).sort(), ['Renamed'].sort().filter(() => false).concat([]), 'moved to Direct above');
  assert.ok((await q('cf_deal_type=Direct')).includes('Alpha deal')); assert.deepEqual((await q('cf_regions=Qatar')), ['Beta deal']); assert.deepEqual((await q('cf_seats_min=40&cf_seats_max=100')), ['Beta deal']);
  assert.deepEqual((await q('cf_contract_signed_on_min=2026-02-01&cf_contract_signed_on_max=2026-04-01')), ['Beta deal']); assert.ok((await q('cf_nda_signed=true')).includes('Beta deal') && !(await q('cf_nda_signed=true')).includes('Alpha deal')); assert.deepEqual((await q('cf_po_reference=alpha')), ['Alpha deal']);
  assert.ok((await q('q=special terms')).includes('Gamma deal'), 'searchable custom text is included in search'); assert.ok(!(await q('q=ALPHA-1')).includes('Beta deal')); assert.ok((await q('q=ALPHA-1')).includes('Alpha deal'));
  const sorted = (await A('GET', '/api/deals?limit=100&sort=cf_seats&dir=desc&cf_deal_type=Direct')).body.rows.map((r) => r.custom.cf_seats).filter((x) => x != null); assert.deepEqual(sorted, [...sorted].sort((a, b) => b - a), 'numeric sort');
  // hostile input is inert
  for (const evil of ["cf_deal_type=x' OR '1'='1", "cf_bogus=1", "cf_deal_type_min=1", "cf_seats=1;DROP TABLE deals", 'cf_regions=" OR 1=1 --']) { const r = await A('GET', `/api/deals?limit=5&${evil}`); assert.equal(r.status, 200, evil); }
  assert.equal((await A('GET', '/api/deals?sort=cf_seats;DROP%20TABLE%20deals')).status, 200); assert.equal((await A('GET', '/api/deals?sort=cf_nope')).status, 200);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM deals').get().n > 3, 'table still intact');
  assert.ok((await A('GET', '/api/deals?cf_deal_type=Direct&limit=2')).body.total >= 4);
});

test('layout: validated, saved, effective layout adds new fields automatically, required fields cannot be hidden', async () => {
  const eff = (await call(rep, 'GET', '/api/customization')).body.entities.deals.layout; const all = eff.sections.flatMap((s) => s.fields);
  assert.ok(all.includes('cf_deal_type') && all.includes('cf_partner') && all.includes('name'), 'custom fields are placed automatically'); assert.equal(eff.sections.at(-1).title, 'Additional information');
  const put = (b) => A('PUT', '/api/customization/layout/deals', b);
  const sections = [
    { title: 'Deal', columns: 2, fields: ['name', 'amount', 'stage', 'close_date', 'owner_id', 'account_id', 'contact_id'] },
    { title: 'Partner details', columns: 1, fields: ['cf_deal_type', 'cf_partner', 'cf_partner_margin', 'cf_partner_fee', 'cf_partner_email', 'cf_partner_phone'] },
    { title: 'Commercials', columns: 2, fields: ['cf_deal_details', 'cf_po_reference', 'cf_contract_signed_on', 'cf_nda_signed', 'cf_regions', 'cf_portal_link', 'cf_seats', 'cf_deal_type_2', 'cf_nom_d_ete', 'cf_d2'] }];
  const names = (await A('GET', '/api/customization')).body.entities.deals.fields.map((f) => f.key); const extra = names.filter((k) => !sections.flatMap((s) => s.fields).includes(k));
  sections[2].fields = sections[2].fields.filter((k) => names.includes(k)).concat(extra);
  assert.equal((await put({ sections: [] })).status, 400); assert.equal((await put({ sections: [{ title: 'x', fields: ['name', 'bogus'] }] })).status, 400, 'unknown field');
  assert.equal((await put({ sections: [{ title: 'x', fields: ['name', 'name', 'amount'] }] })).status, 400, 'duplicate'); assert.equal((await put({ sections: [{ title: '', fields: ['name'] }] })).status, 400, 'section title');
  const hideName = await put({ sections: sections.map((s, i) => (i ? s : { ...s, fields: s.fields.filter((k) => k !== 'name') })) }); assert.equal(hideName.status, 400); assert.match(hideName.body.error, /Deal name.*required/);
  const hideCf = await put({ sections: sections.map((s) => ({ ...s, fields: s.fields.filter((k) => k !== 'cf_deal_type') })) }); assert.equal(hideCf.status, 400); assert.match(hideCf.body.error, /Deal type.*required/);
  const saved = await put({ sections }); assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.equal(saved.body.saved, true); assert.equal(saved.body.sections[1].columns, 1);
  const hiddenOk = await put({ sections: sections.map((s) => ({ ...s, fields: s.fields.filter((k) => k !== 'probability' && k !== 'cf_portal_link') })) }); assert.equal(hiddenOk.status, 200, 'optional fields may be removed from the form');
  await put({ sections });
  const later = await mk('deals', 'Late addition', 'text'); const eff2 = (await call(rep, 'GET', '/api/customization')).body.entities.deals.layout;
  assert.ok(eff2.sections.flatMap((s) => s.fields).includes(later.key), 'a field created after the layout was saved still shows up'); assert.equal(eff2.sections.find((s) => s.title === 'Partner details').fields[0], 'cf_deal_type', 'saved order preserved');
  const reset = (await A('DELETE', '/api/customization/layout/deals')).body; assert.equal(reset.saved, false); assert.equal(reset.sections[0].title, 'Deal');
  await put({ sections: [...sections, { title: 'Misc', columns: 2, fields: [later.key] }].map((s) => ({ ...s, fields: s.fields.filter((k) => k !== later.key || s.title === 'Misc') })) });
});

test('archive, restore, purge: data kept until permanently deleted; dependants protected; option renames migrate data', async () => {
  assert.equal((await A('POST', `/api/customization/fields/${F.dealType.id}/archive`)).status, 400, 'other fields depend on Deal type');
  const arch = await A('POST', `/api/customization/fields/${F.po.id}/archive`); assert.equal(arch.body.archived, true);
  assert.ok(!(await call(rep, 'GET', '/api/customization')).body.entities.deals.layout.sections.flatMap((s) => s.fields).includes('cf_po_reference'), 'archived fields leave the layout');
  assert.equal((await A('POST', '/api/deals', { name: 'x', custom: { cf_deal_type: 'Direct', cf_po_reference: 'ignored' } })).body.custom.cf_po_reference, undefined, 'archived fields are not writable');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM deals WHERE custom LIKE '%cf_po_reference%'").get().n > 0, true, 'values are kept while archived');
  assert.equal((await A('DELETE', `/api/customization/fields/${F.signed.id}`)).status, 400, 'only archived fields can be purged');
  await A('POST', `/api/customization/fields/${F.po.id}/restore`); assert.ok((await A('GET', `/api/deals/${F.dealId}`)).body.custom.cf_po_reference);
  await A('POST', `/api/customization/fields/${F.po.id}/archive`); const purge = (await A('DELETE', `/api/customization/fields/${F.po.id}`)).body; assert.ok(purge.records_updated >= 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM deals WHERE custom LIKE '%cf_po_reference%'").get().n, 0, 'purge removes the values everywhere');
  // renaming a dropdown option rewrites stored values
  const before = (await A('GET', '/api/deals?cf_deal_type=Direct&limit=100')).body.total;
  const ren = await A('PUT', `/api/customization/fields/${F.dealType.id}`, { options: ['Direct sale', 'Partner', 'Reseller'], option_renames: { Direct: 'Direct sale' } }); assert.equal(ren.status, 200);
  assert.equal((await A('GET', '/api/deals?cf_deal_type=Direct%20sale&limit=100')).body.total, before); assert.equal((await A('GET', '/api/deals?cf_deal_type=Direct&limit=100')).body.total, 0);
  const ms = await A('PUT', `/api/customization/fields/${F.tags.id}`, { options: ['Saudi Arabia', 'UAE', 'Qatar'], option_renames: { KSA: 'Saudi Arabia' } }); assert.equal(ms.status, 200);
  assert.ok((await A('GET', '/api/deals?cf_regions=Saudi%20Arabia&limit=100')).body.total >= 2);
  // removing an option keeps old values readable and re-savable unchanged, but blocks picking it again
  await A('PUT', `/api/customization/fields/${F.dealType.id}`, { options: ['Direct sale', 'Partner'] });
  const keep = await A('PUT', `/api/deals/${F.dealId}`, { custom: { cf_deal_type: 'Reseller' } }); assert.equal(keep.status, 400, 'removed option cannot be newly chosen');
  await A('PUT', `/api/customization/fields/${F.dealType.id}`, { options: ['Direct sale', 'Partner', 'Reseller'] });
});

test('accounts & contacts: independent fields, lookups, export, import, segments, own-scope', async () => {
  const cType = await mk('contacts', 'Preferred language', 'dropdown', { options: ['Arabic', 'English'], filterable: true, show_in_list: true }); const cNum = await mk('contacts', 'Lifetime value', 'currency', {});
  const cBool = await mk('contacts', 'Decision maker', 'checkbox', {}); const cPartner = await mk('contacts', 'Referred by', 'lookup', { config: { target: 'contacts' } });
  const aType = await mk('accounts', 'Partner tier', 'dropdown', { options: ['Gold', 'Silver'], filterable: true }); const aReq = await mk('accounts', 'Region manager', 'text', {});
  assert.equal((await A('GET', '/api/customization')).body.entities.accounts.fields.filter((f) => f.key.startsWith('cf_partner')).length, 1, 'fields are per record type');
  const acc = (await A('POST', '/api/accounts', { name: 'Tiered Co', custom: { cf_partner_tier: 'Gold', cf_region_manager: 'Sara' } })).body; assert.equal(acc.custom.cf_partner_tier, 'Gold');
  assert.equal((await A('GET', '/api/accounts?cf_partner_tier=Gold')).body.total, 1); assert.equal((await A('GET', '/api/accounts?cf_partner_tier=Silver')).body.total, 0);
  const c1 = (await A('POST', '/api/contacts', { first_name: 'Nadia', email: 'nadia@cf.example', custom: { cf_preferred_language: 'Arabic', cf_lifetime_value: 12000, cf_decision_maker: true } })).body;
  const c2 = (await A('POST', '/api/contacts', { first_name: 'Omar', email: 'omar@cf.example', custom: { cf_referred_by: c1.id } })).body; assert.equal(c2.custom_labels.cf_referred_by, 'Nadia');
  // export includes custom columns with readable values
  const csv = await (await fetch(base + '/api/contacts/export.csv?q=cf.example', { headers: { cookie: admin } })).text(); const [head, ...rows] = csv.trim().split('\r\n');
  assert.ok(head.includes('Preferred language') && head.includes('Lifetime value') && head.includes('Referred by')); assert.ok(rows.some((r) => r.includes('Nadia') && r.includes('Arabic') && r.includes('12000') && r.includes('yes'))); assert.ok(rows.some((r) => r.includes('Omar') && r.includes(',Nadia')), 'lookup exported by name');
  // import with custom values (validated per row; required rules apply)
  const imp = (await A('POST', '/api/contacts/import', { rows: [{ first_name: 'Imp1', email: 'imp1@cf.example', custom: { cf_preferred_language: 'English' } }, { first_name: 'Imp2', email: 'imp2@cf.example', custom: { cf_preferred_language: 'Klingon' } }, { first_name: 'Nadia', email: 'nadia@cf.example', custom: { cf_lifetime_value: 99 } }] })).body;
  assert.equal(imp.created, 1); assert.equal(imp.updated, 1); assert.equal(imp.skipped, 1); assert.match(imp.errors[0], /Preferred language is not one of/);
  const nadia = (await A('GET', `/api/contacts/${c1.id}`)).body; assert.equal(nadia.custom.cf_lifetime_value, 99); assert.equal(nadia.custom.cf_preferred_language, 'Arabic', 'import merges, it does not wipe other fields');
  // campaign segments can use custom fields (contact and account)
  const f = (rules) => ({ match: 'all', rules }); const prev = async (rules) => (await A('POST', '/api/segments/preview', { filter: f(rules) })).body;
  assert.ok((await A('GET', '/api/meta')).body.segmentFields['custom.cf_preferred_language'].options.includes('Arabic'));
  assert.equal((await prev([{ field: 'custom.cf_preferred_language', op: 'is', value: 'Arabic' }])).matching, 1); assert.equal((await prev([{ field: 'custom.cf_lifetime_value', op: 'after', value: '50' }])).matching, 1, 'numeric comparison (99 > 50, not a text comparison)'); assert.equal((await prev([{ field: 'custom.cf_lifetime_value', op: 'is', value: '99' }])).matching, 1);
  assert.equal((await prev([{ field: 'custom.cf_lifetime_value', op: 'before', value: '1000' }])).matching, 1, 'Nadia 99 < 1000 after the import update'); assert.equal((await prev([{ field: 'custom.cf_decision_maker', op: 'is', value: 'yes' }])).matching, 1);
  assert.equal((await A('POST', '/api/segments/preview', { filter: f([{ field: 'custom.cf_nope', op: 'is', value: 'x' }]) })).status, 400);
  const acct = await A('POST', '/api/contacts', { first_name: 'AcctLink', email: 'al@cf.example', account_id: acc.id }); assert.equal(acct.status, 200);
  assert.equal((await prev([{ field: 'acustom.cf_partner_tier', op: 'is', value: 'Gold' }])).matching, 1, 'account custom fields reach their contacts');
  // own-scope users see custom values only on records they can see
  const role = (await A('POST', '/api/roles', { name: 'Own sales', permissions: { contacts: { view: 'own', create: true, edit: 'own' } } })).body;
  await A('POST', '/api/users', { name: 'Own', email: 'own@cf.example', password: 'Test@12345', role_id: role.id }); const own = (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'own@cf.example', password: 'Test@12345' }) })).headers.get('set-cookie')).split(';')[0];
  assert.equal((await call(own, 'GET', `/api/contacts/${c1.id}`)).status, 404); assert.equal((await call(own, 'GET', '/api/contacts?cf_preferred_language=Arabic')).body.total, 0, 'filtering cannot reveal hidden records');
  const mine = (await call(own, 'POST', '/api/contacts', { first_name: 'Mine', custom: { cf_preferred_language: 'English' } })).body; assert.equal(mine.custom.cf_preferred_language, 'English');
  assert.equal((await call(own, 'POST', '/api/customization/fields', { entity: 'contacts', label: 'x', type: 'text' })).status, 403);
  F.cPartner = cPartner; F.cType = cType;
});

test('required flag on contacts: enforced for new records, imports and edits that send custom values', async () => {
  const req = await mk('contacts', 'Consent source', 'text', { required: true });
  assert.equal((await A('POST', '/api/contacts', { first_name: 'NoConsent' })).status, 400); assert.equal((await A('POST', '/api/contacts', { first_name: 'WithConsent', custom: { [req.key]: 'web form' } })).status, 200);
  const old = (await A('GET', '/api/contacts?q=Omar')).body.rows[0]; assert.equal((await A('PUT', `/api/contacts/${old.id}`, { title: 'CTO' })).status, 200, 'records created before the rule can still be edited without touching custom fields');
  assert.equal((await A('PUT', `/api/contacts/${old.id}`, { custom: { cf_referred_by: null } })).status, 400, 'but saving the custom block applies the rule');
  assert.equal((await A('POST', '/api/contacts/import', { rows: [{ first_name: 'ImpNoConsent', email: 'impnc@cf.example' }] })).body.skipped, 1);
  await A('PUT', `/api/customization/fields/${req.id}`, { required: false });
});

test('migration v3 on an upgraded database: custom column defaults, admin full permissions, restore point', async () => {
  assert.equal(db.prepare("SELECT COUNT(*) n FROM deals WHERE custom IS NULL OR custom=''").get().n, 0, 'every record has a valid custom object');
  assert.ok(db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v >= 3);
  const adminRole = JSON.parse(db.prepare("SELECT permissions FROM roles WHERE name='admin'").get().permissions); assert.equal(adminRole.customization.manage, true);
  assert.ok((await A('GET', '/api/audit')).body.some((a) => a.entity === 'custom_field' && a.action === 'create') && (await A('GET', '/api/audit')).body.some((a) => a.entity === 'layout'), 'changes are audited');
});
