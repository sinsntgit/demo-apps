// Browser smoke test: node --no-warnings test/e2e.mjs  (needs Playwright + Chromium available)
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright'); // not a project dependency; preinstalled globally
import http from 'node:http';
import { makeXlsx, makeDocx } from './fixtures.mjs';
process.env.SEED_BILLING_DEMO = '0'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const e2eDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovantaa-e2e-')); process.env.DB_PATH = path.join(e2eDir, 'e2e.db'); process.env.DATA_DIR = e2eDir; process.env.SESSION_SECRET = 'e2e'; process.env.SEND_DELAY_MS = '1';
const PLAN = { explanation: 'PDF files in Proposal stage folders', queries: [{ entity: 'files', text: '', filters: [{ field: 'stage', op: 'eq', value: 'proposal', value2: '', values: [] }, { field: 'kind', op: 'eq', value: 'pdf', value2: '', values: [] }], sort_field: '', sort_dir: 'desc', limit: 25 }] };
const ai = http.createServer((q, r) => { let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => { r.writeHead(200, { 'content-type': 'application/json' }); if (JSON.parse(b).output_config) return r.end(JSON.stringify({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(PLAN) }] })); r.end(JSON.stringify({ model: 'claude-sonnet-5-5', content: [{ type: 'text', text: JSON.stringify({ subject: 'AI subject line', subject_alternatives: ['Alt one', 'Alt two'], preheader: 'p', body_html: '<p>Hi {{first_name|there}}, AI wrote this.</p>' }) }] })); }); });
await new Promise((r) => ai.listen(0, '127.0.0.1', r)); process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${ai.address().port}`;
const { server } = await import('../server/index.js');
const { seedIfEmpty } = await import('../server/seed.js');
seedIfEmpty(); await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errors = []; page.on('pageerror', (e) => errors.push('pageerror: ' + e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/401|status of 400/.test(m.text()))  errors.push('console: ' + m.text()); });
const shot = (n) => page.screenshot({ path: `${process.env.SHOTS || '/tmp'}/${n}.png` });
await page.goto(base);
await page.fill('input[name=email]', 'admin@ovantaa.com'); await page.fill('input[name=password]', 'Ovantaa@123'); await page.click('button.primary');
await page.waitForSelector('.kpi'); await shot('dashboard');
for (const r of ['contacts', 'accounts', 'deals', 'tasks', 'campaigns', 'segments', 'templates', 'senders', 'notifications', 'team', 'settings']) {
  await page.click(`a[data-nav=${r}]`); await page.waitForTimeout(400);
  const bad = await page.$('.empty h2'); if (bad) errors.push(`route ${r} failed: ${await bad.textContent()}`);
  await shot(r);
}
// create contact via UI
await page.click('a[data-nav=contacts]'); await page.click('text=+ New contact'); await page.fill('input[name=f__first_name]', 'Zed'); await page.fill('input[name=f__last_name]', 'Tester'); await page.fill('input[name=f__email]', 'zed@example.com');
await page.click('.modal button[type=submit]'); await page.waitForSelector('h1:has-text("Zed Tester")'); await shot('contact');
// campaign flow
await page.click('a[data-nav=campaigns]'); await page.click('text=+ New campaign'); await page.fill('.modal input[name=name]', 'E2E campaign'); await page.click('.modal button[type=submit]');
await page.waitForSelector('textarea[name=body_html]'); await page.fill('input[name=subject]', 'Hello {{first_name|there}}');
const opt = await page.$$eval('select[name=segment_id] option', (os) => os.find((o) => /Customers/.test(o.textContent))?.value); await page.selectOption('select[name=segment_id]', opt);
await page.waitForTimeout(700); await shot('editor');
await page.click('text=Send now'); await page.click('.modal button[type=submit]'); await page.waitForSelector('text=Open rate', { timeout: 8000 }); await page.waitForTimeout(1500); await shot('report');
// sender + notification rule via UI
await page.click('a[data-nav=senders]'); await page.click('text=+ Add sender'); await page.fill('.modal input[name=label]', 'E2E sender'); await page.fill('.modal input[name=from_email]', 'e2e@syncsense.in');
await page.selectOption('.modal select[name=mode]', 'simulate'); await page.click('.modal button[type=submit]'); await page.waitForSelector('td:has-text("E2E sender")'); await shot('senders-list');
await page.click('a[data-nav=notifications]'); await page.click('text=+ New rule'); await page.fill('.modal input[name=name]', 'E2E rule'); await page.fill('.modal textarea, .modal input[name=extra_emails]', 'boss@syncsense.in');
await page.click('.modal button[type=submit]'); await page.waitForSelector('td:has-text("E2E rule")'); await shot('notifications');
// xlsx import with column mapping
await page.click('a[data-nav=contacts]'); await page.click('text=Import CSV');
await page.setInputFiles('#csvfile', { name: 'people.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: makeXlsx([['Full Name', 'E-mail', 'Mobile', 'Organisation'], ['Meera Iyer', 'meera@xl.example', 9876543210, 'XL Corp'], ['Karan Shah', 'karan@xl.example', 9123456789, 'XL Corp']]) });
await page.waitForSelector('text=2 rows found'); await page.fill('.modal input[name=tag]', 'xlsx-test'); await shot('import');
await page.click('.modal button[type=submit]'); await page.waitForSelector('.toast:has-text("2 new")');
const imp = await page.evaluate(async () => (await (await fetch('/api/contacts?q=meera@xl.example')).json()).rows[0]);
if (!imp || imp.first_name !== 'Meera Iyer' || imp.phone !== '9876543210' || imp.account_name !== 'XL Corp' || !/xlsx-test/.test(imp.tags)) errors.push('xlsx import produced wrong data ' + JSON.stringify(imp));
// theme: preset + save, persists to login page
await page.click('a[data-nav=settings]'); await page.click('button.swatch[title=Teal]');
if ((await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--brand').trim())) !== '#0d9488') errors.push('theme preview did not apply');
await page.click('text=Save company theme'); await page.waitForSelector('.toast:has-text("theme saved")'); await shot('settings-teal');
// AI key via settings, then Claude panel in editor
await page.fill('#aiform input[name=api_key]', 'sk-ant-e2e'); await page.click('#aiform button.primary'); await page.waitForSelector('.badge:has-text("connected")');
await page.click('a[data-nav=campaigns]'); await page.click('text=+ New campaign'); await page.fill('.modal input[name=name]', 'AI campaign'); await page.click('.modal button[type=submit]');
await page.waitForSelector('#ai_brief'); await page.fill('#ai_brief', 'Announce the new analytics module to customers'); await page.click('text=Generate draft');
await page.waitForFunction(() => document.querySelector('input[name=subject]').value === 'AI subject line', null, { timeout: 8000 }).catch(() => errors.push('AI draft was not applied'));
await page.click('button.chip:has-text("Alt one")'); if ((await page.inputValue('input[name=subject]')) !== 'Alt one') errors.push('alt subject not applied'); await shot('ai-editor');
await page.click('[data-act=aiundo]'); if ((await page.inputValue('input[name=subject]')) === 'Alt one') errors.push('AI undo failed');
await page.waitForSelector('#senderwarn .banner'); // simulation banner visible for the demo sender
// reload: saved theme applied on the login screen too
await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' })); await page.goto(base); await page.waitForSelector('#login');
if ((await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--brand').trim())) !== '#0d9488') errors.push('saved theme missing on login page');
await page.fill('input[name=email]', 'admin@ovantaa.com'); await page.fill('input[name=password]', 'Ovantaa@123'); await page.click('button.primary'); await page.waitForSelector('.kpi');
// delete all: submit stays disabled until DELETE is typed
await page.click('a[data-nav=templates]'); await page.click('text=Delete all…');
if (!(await page.isDisabled('.modal button[type=submit]'))) errors.push('delete-all submit should start disabled');
await page.fill('.modal input[name=confirm]', 'delete'); if (!(await page.isDisabled('.modal button[type=submit]'))) errors.push('lowercase should not enable delete');
await page.fill('.modal input[name=confirm]', 'DELETE'); await page.click('.modal button[type=submit]'); await page.waitForSelector('.toast:has-text("Deleted 3 email templates")');
await page.waitForSelector('text=No templates yet'); await shot('purged-templates');
await page.click('a[data-nav=settings]'); await page.waitForSelector('text=Data management'); await shot('data-management');
// ===== Billing: settings -> invoice (live compliance check) -> issue -> pay -> credit note -> portal -> receivables -> readiness -> import =====
await page.click('a[data-nav=billing-settings]'); await page.waitForSelector('text=Business profile');
await page.fill('input[name=seller_name]', 'E2E Trading Co'); await page.fill('input[name=seller_name_ar]', 'شركة الاختبار'); await page.fill('input[name=vat_number]', '399999999900003');
await page.fill('input[name=a_street]', 'King Fahd Rd'); await page.fill('input[name=a_building_no]', '1234'); await page.fill('input[name=a_district]', 'Olaya'); await page.fill('input[name=a_city]', 'Riyadh'); await page.fill('input[name=a_postal_code]', '12211');
await page.fill('input[name=b_iban]', 'SA0380000000608010167519'); await page.fill('input[name=b_bank_name]', 'Al Rajhi'); await page.click('text=Save settings'); await page.waitForSelector('.toast:has-text("Billing settings saved")'); await shot('billing-settings');
const acct = await page.evaluate(async () => (await (await fetch('/api/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'E2E Customer', name_ar: 'عميل', vat_number: '311111111100003', street: 'Prince Sultan', building_no: '4321', district: 'Malaz', city: 'Riyadh', postal_code: '11564', country_code: 'SA', billing_email: 'ap@e2e.example', billing_phone: '0501234567' }) })).json()).id);
await page.click('a[data-nav=invoices]'); await page.click('text=+ New invoice'); await page.waitForSelector('select[name=account_id]');
await page.waitForSelector('#issues .issue'); // compliance check runs immediately (customer missing)
await page.selectOption('select[name=account_id]', String(acct)); await page.fill('#lines tr:first-child [data-k=description]', 'Consulting services'); await page.fill('#lines tr:first-child [data-k=description_ar]', 'خدمات استشارية');
await page.fill('#lines tr:first-child [data-k=qty]', '2'); await page.fill('#lines tr:first-child [data-k=unit_price]', '500');
await page.waitForSelector('#issues:has-text("Ready to issue")', { timeout: 6000 }).catch(() => errors.push('live compliance check never reported ready')); await shot('invoice-editor');
if (!(await page.textContent('#totals')).includes('1,150.00')) errors.push('live totals wrong: ' + (await page.textContent('#totals')));
await page.click('text=Save & issue'); await page.waitForSelector('h1:has-text("INV-")', { timeout: 8000 }); await page.waitForSelector('.modal input[name=to]', { timeout: 5000 }).then(() => page.keyboard.press('Escape')).catch(() => errors.push('email dialog not offered after issuing')); await shot('invoice-detail');
const invId = Number(page.url().split('/invoices/')[1]);
if (!(await page.textContent('body')).includes('INV-000001')) errors.push('first invoice should be INV-000001');
await page.click('button:has-text("Record payment")'); await page.fill('.modal input[name=amount]', '400'); await page.click('.modal button[type=submit]'); await page.waitForSelector('text=Partially paid');
await page.click('button:has-text("Credit note")'); await page.fill('.modal input[name=reason]', 'E2E: service cancelled'); await page.click('.modal button[type=submit]'); await page.waitForSelector('text=against');
await page.fill('#lines tr:first-child [data-k=unit_price]', '100'); await page.click('text=Save & issue'); await page.waitForSelector('h1:has-text("CN-000001")', { timeout: 8000 });
await page.goto(`${base}/#/invoices/${invId}`); await page.waitForSelector('text=Credit / debit notes');
const portal = (await page.$eval('a[href*="/pay/"]:has-text("Open")', (a) => a.href)).replace('http://localhost:3000', base); await page.goto(portal); await page.waitForSelector('text=How to pay'); await shot('portal');
if (!(await page.textContent('body')).includes('SA0380000000608010167519')) errors.push('portal missing IBAN');
await page.fill('input[name=paid_on]', new Date().toISOString().slice(0, 10)); await page.fill('input[name=reference]', 'E2E-REF'); await page.click('button:has-text("Notify payment")'); await page.waitForSelector('text=recorded your payment notice');
await page.goto(`${portal}?lang=ar`); if ((await page.getAttribute('html', 'dir')) !== 'rtl') errors.push('Arabic portal is not RTL'); await shot('portal-ar');
await page.goto(`${base}/#/invoices/${invId}`); await page.waitForSelector('text=Customer says they paid'); await page.click('button:has-text("Confirm received")'); await page.waitForSelector('.toast:has-text("Payment confirmed")');
await page.click('a[data-nav=receivables]'); await page.waitForSelector('text=Ageing'); await shot('receivables');
await page.click('a[data-nav=readiness]'); await page.waitForSelector('text=Audit chain integrity'); await shot('readiness');
await page.click('button:has-text("Import & check invoices")');
await page.setInputFiles('#csvfile', { name: 'zoho.csv', mimeType: 'text/csv', buffer: Buffer.from('Invoice Number,Invoice Date,Due Date,Customer Name,Tax Registration Number,Item Name,Quantity,Item Price,Item Tax %\nZB-1,15/03/2026,14/04/2026,Tabuk Foods,344444444400003,Rice,10,90,15\nZB-1,15/03/2026,14/04/2026,Tabuk Foods,344444444400003,Oil,4,25.5,15\nZB-2,16/03/2026,,Bad VAT Ltd,999,Service,1,100,15\n') });
await page.waitForSelector('text=3 rows found'); await page.click('.modal button[type=submit]'); await page.waitForSelector('text=Imported 2 invoice drafts'); await shot('import-result');
if (!(await page.textContent('.modal')).includes('2 with errors')) errors.push('import should flag the bad VAT number and the missing customer address'); await page.keyboard.press('Escape');
// ===== Roles & permissions UI: custom role -> user -> restricted session =====
await page.click('a[data-nav=team]'); await page.click('button[data-t=roles]'); await page.waitForSelector('text=Roles & permissions'); await page.click('text=+ New role');
await page.fill('.modal input[name=name]', 'E2E Seller'); await page.selectOption('.modal select[name=p__contacts__view]', 'own'); await page.selectOption('.modal select[name=p__contacts__edit]', 'own');
await page.check('.modal input[name=p__contacts__create]'); await page.selectOption('.modal select[name=p__deals__view]', 'all'); await page.click('.modal button[type=submit]'); await page.waitForSelector('td:has-text("E2E Seller")'); await shot('roles');
await page.click('button[data-t=users]'); await page.click('text=+ Invite user'); await page.fill('.modal input[name=name]', 'E2E Seller User'); await page.fill('.modal input[name=email]', 'e2eseller@example.com'); await page.fill('.modal input[name=password]', 'Seller@12345');
await page.selectOption('.modal select[name=role_id]', { label: 'E2E Seller (custom)' }); await page.click('.modal button[type=submit]'); await page.waitForSelector('td:has-text("e2eseller@example.com")');
const ctx2 = await browser.newContext({ viewport: { width: 1360, height: 900 } }); const p2 = await ctx2.newPage();
await p2.goto(base); await p2.fill('input[name=email]', 'e2eseller@example.com'); await p2.fill('input[name=password]', 'Seller@12345'); await p2.click('button.primary'); await p2.waitForSelector('.kpi');
const nav = await p2.evaluate(() => Array.from(document.querySelectorAll('.nav a')).map((x) => x.textContent.trim()));
for (const hidden of ['Team & roles', 'Billing settings', 'Receivables', 'E-invoicing readiness', 'Notifications', 'Email senders']) if (nav.includes(hidden)) errors.push(`restricted user still sees "${hidden}" in the menu`);
if (!nav.includes('Contacts')) errors.push('restricted user lost the Contacts menu');
if ((await p2.textContent('.me')).indexOf('E2E Seller') < 0) errors.push('role name not shown in the sidebar');
await p2.click('a[data-nav=contacts]'); await p2.waitForSelector('table'); if ((await p2.locator('text=Delete all').count()) > 0) errors.push('non-admin sees Delete all');
await p2.goto(`${base}/#/team`); await p2.waitForSelector('.empty', { timeout: 5000 }).catch(() => errors.push('direct URL to Team did not show an access error')); await ctx2.close();
await page.click('a[data-nav=settings]'); await page.waitForSelector('text=Backups'); await page.click('button:has-text("Create backup now")'); await page.waitForSelector('.toast:has-text("Backup")', { timeout: 5000 }).catch(() => errors.push('backup toast missing'));
const dragTo = async (srcSel, dstSel) => { const src = page.locator(srcSel).first(); await src.scrollIntoViewIfNeeded(); const dst = page.locator(dstSel).first(); await dst.scrollIntoViewIfNeeded(); const a = await src.boundingBox(), b = await dst.boundingBox();
  await page.mouse.move(a.x + 40, a.y + a.height / 2); await page.mouse.down(); await page.mouse.move(a.x + 60, a.y + a.height / 2 + 10, { steps: 5 }); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 15 }); await page.mouse.up(); };
// ===== Custom fields & layouts: the partner-deal scenario =====
await page.click('a[data-nav=customize]'); await page.waitForSelector('text=Custom fields');
const addField = async (label, type, fill) => { await page.click('text=+ Add field'); await page.fill('.modal input[name=label]', label); await page.selectOption('.modal select[name=type]', type); if (fill) await fill(); await page.click('.modal button[type=submit]'); await page.waitForSelector(`td:has-text("${label}")`); };
await addField('Deal type', 'dropdown', async () => { const rows = page.locator('.modal [data-opt]'); await rows.nth(0).fill('Direct'); await rows.nth(1).fill('Partner'); await page.click('.modal button[data-act=oadd]'); await page.locator('.modal [data-opt]').nth(2).fill('Reseller'); await page.check('.modal input[name=required]'); await page.check('.modal input[name=show_in_list]'); await page.check('.modal input[name=filterable]'); });
await addField('Partner', 'lookup', async () => { await page.selectOption('.modal select[name=cfg_target]', 'accounts'); await page.selectOption('.modal select[name=vw_field]', 'cf_deal_type'); await page.check('.modal input[name=vw_val][value=Partner]'); await page.check('.modal input[name=show_in_list]'); });
await addField('Partner margin', 'percent', async () => { await page.selectOption('.modal select[name=vw_field]', 'cf_deal_type'); await page.check('.modal input[name=vw_val][value=Partner]'); await page.check('.modal input[name=required]'); });
await addField('Deal details', 'textarea', async () => { await page.check('.modal input[name=searchable]'); });
await shot('custom-fields');
// arrange: new section "Partner details" and drag the partner fields into it, then save
await page.click('text=+ Add section'); const secId = await page.locator('.lsec').last().getAttribute('data-sec'); await page.locator('.lsec').last().locator('input[data-sectitle]').fill('Partner details');
for (const k of ['cf_deal_type', 'cf_partner', 'cf_partner_margin']) { await dragTo(`.lchip[data-key=${k}]`, `[data-zone="${secId}"]`); await page.waitForTimeout(150); }
await page.waitForFunction((id) => document.querySelectorAll(`[data-zone="${id}"] .lchip`).length === 3, secId, { timeout: 5000 }).catch(() => errors.push('dragging fields into the new section failed'));
await shot('layout-editor'); await page.click('button[data-act=lsave]'); await page.waitForSelector('.toast:has-text("Layout saved")');
// create a deal using the saved layout
await page.click('a[data-nav=deals]'); await page.click('text=+ New deal'); await page.waitForSelector('.modal .fsec h3:has-text("Partner details")');
await page.fill('.modal input[name=f__name]', 'E2E partner deal'); await page.fill('.modal input[name=f__amount]', '25000');
if (await page.locator('.modal .fld[data-key=cf_partner_margin]').isVisible()) errors.push('partner margin visible before Deal type is chosen');
await page.selectOption('.modal select[name=c__cf_deal_type]', 'Direct'); if (await page.locator('.modal .fld[data-key=cf_partner]').isVisible()) errors.push('Partner shown for a Direct deal');
await page.selectOption('.modal select[name=c__cf_deal_type]', 'Partner'); await page.waitForSelector('.modal .fld[data-key=cf_partner_margin]:not([hidden])');
await page.selectOption('.modal select[name=c__cf_partner]', { index: 1 }); await page.fill('.modal input[name=c__cf_partner_margin]', '12.5'); await page.fill('.modal textarea[name=c__cf_deal_details]', 'Resold through the partner, 2-year term');
await shot('deal-form'); await page.click('.modal button[type=submit]'); await page.waitForSelector('.toast:has-text("Deal saved")');
const created = await page.evaluate(async () => (await (await fetch('/api/deals?q=E2E%20partner%20deal')).json()).rows[0]);
if (!created || created.custom.cf_deal_type !== 'Partner' || created.custom.cf_partner_margin !== 12.5 || !created.custom.cf_partner) errors.push('custom values not saved ' + JSON.stringify(created?.custom));
await page.goto(`${base}/#/deals/${created.id}`); await page.waitForSelector('text=Partner margin'); if (!(await page.textContent('body')).includes('12.5%')) errors.push('detail page missing the margin'); await shot('deal-detail-custom');
await page.click('button:has-text("Edit")'); await page.waitForSelector('.modal input[name=c__cf_partner_margin]'); if ((await page.inputValue('.modal input[name=c__cf_partner_margin]')) !== '12.5') errors.push('edit form did not load the saved value'); await page.keyboard.press('Escape');
// list view: custom column and filter
await page.click('a[data-nav=deals]'); await page.click('button:has-text("List")'); await page.waitForSelector('th:has-text("Deal type")'); await page.selectOption('select[data-filter=cf_deal_type]', 'Partner');
await page.waitForFunction(() => document.body.innerText.includes('E2E partner deal'), null, { timeout: 5000 }).catch(() => errors.push('filtering by the custom dropdown failed')); await shot('deals-list-custom');
await page.click('button:has-text("Board")');
// a normal user sees the fields but cannot customise
const ctx3 = await browser.newContext({ viewport: { width: 1360, height: 900 } }); const p3 = await ctx3.newPage();
await p3.goto(base); await p3.fill('input[name=email]', 'liam@ovantaa.com'); await p3.fill('input[name=password]', 'Ovantaa@123'); await p3.click('button.primary'); await p3.waitForSelector('.kpi');
if ((await p3.locator('a[data-nav=customize]').count()) > 0) errors.push('rep can see the Customisation menu');
await p3.click('a[data-nav=deals]'); await p3.click('text=+ New deal'); await p3.waitForSelector('.modal select[name=c__cf_deal_type]'); await ctx3.close();
// ===== Phase 1: lead conversion, attachments, duplicates, two-factor =====
const { totpAt, base32Decode } = await import('../server/totp.js');
const codeNow = (secret, off = 0) => totpAt(base32Decode(secret.replace(/\s/g, '')), Math.floor(Date.now() / 30000) + off);
const lead = await page.evaluate(async () => (await (await fetch('/api/contacts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ first_name: 'Lia', last_name: 'Leadson', email: 'lia@leadson-corp.com', status: 'lead' }) })).json()));
await page.goto(`${base}/#/contacts/${lead.id}`); await page.waitForSelector('button:has-text("Convert lead")'); await page.click('button:has-text("Convert lead")');
await page.waitForSelector('.modal input[name=amode][value=new]'); await page.check('.modal input[name=amode][value=new]'); await page.fill('.modal input[name=aname]', 'Leadson Corp'); await page.fill('.modal input[name=dname]', 'Leadson rollout'); await page.fill('.modal input[name=damount]', '12000'); await page.selectOption('.modal select[name=c__cf_deal_type]', 'Direct'); await shot('convert-lead');
await page.click('.modal button[type=submit]'); await page.waitForSelector('h1:has-text("Leadson rollout")', { timeout: 5000 }).catch(() => errors.push('conversion did not open the new deal'));
// attachments on the deal
await page.waitForSelector('#attach-box button:has-text("Add files")'); await page.setInputFiles('#attach-box [data-file]', { name: 'term-sheet.txt', mimeType: 'text/plain', buffer: Buffer.from('terms') });
await page.waitForSelector('#attach-box a:has-text("term-sheet.txt")', { timeout: 5000 }).catch(() => errors.push('attached file not listed')); await shot('attachments');
await page.setInputFiles('#attach-box [data-file]', { name: 'bad.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') }); await page.waitForSelector('.toast.bad:has-text("not allowed")', { timeout: 5000 }).catch(() => errors.push('blocked file type was not rejected'));
await page.goto(`${base}/#/contacts/${lead.id}`); await page.waitForSelector('.badge:has-text("Converted")', { timeout: 5000 }).catch(() => errors.push('contact not marked converted'));
// duplicates
await page.evaluate(async () => { for (let i = 0; i < 2; i++) await fetch('/api/contacts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ first_name: 'Twin', last_name: 'Peaks', phone: i ? '+100' : null }) }); });
await page.click('a[data-nav=duplicates]'); await page.waitForSelector('button[data-act=merge]'); await shot('duplicates'); await page.click('button[data-act=merge]'); await page.click('.modal button[type=submit]');
await page.waitForSelector('.toast:has-text("Merged")', { timeout: 5000 }).catch(() => errors.push('merge failed'));
// two-factor: self-service set-up, then sign-in with code
const ctx4 = await browser.newContext({ viewport: { width: 1360, height: 900 } }); const p4 = await ctx4.newPage();
p4.on('pageerror', (e) => errors.push('pageerror(2fa): ' + e.message));
await p4.goto(base); await p4.fill('input[name=email]', 'maya@ovantaa.com'); await p4.fill('input[name=password]', 'Ovantaa@123'); await p4.click('button.primary'); await p4.waitForSelector('.kpi');
await p4.click('a[data-nav=settings]'); await p4.waitForSelector('button:has-text("Set up")'); await p4.click('#seccard button[data-act=on]'); await p4.waitForSelector('#tf-enable');
const secret = (await p4.textContent('.twofa .mono')).trim(); await p4.screenshot({ path: `${process.env.SHOTS || '/tmp'}/2fa-setup.png` });
await p4.fill('#tf-enable input[name=code]', codeNow(secret)); await p4.click('#tf-enable button'); await p4.waitForSelector('.modal:has-text("recovery codes")');
const rcodes = (await p4.$$eval('.modal .mono div', (d) => d.map((x) => x.textContent))); if (rcodes.length !== 10) errors.push('expected 10 recovery codes'); await p4.click('.modal button:has-text("I have saved them")');
await p4.click('button[data-act=logout]'); await p4.waitForSelector('#login'); await p4.fill('input[name=email]', 'maya@ovantaa.com'); await p4.fill('input[name=password]', 'Ovantaa@123'); await p4.click('button.primary');
await p4.waitForSelector('#tf'); await p4.fill('#tf input[name=code]', '000000'); await p4.click('#tf button.primary'); await p4.waitForSelector('#tf .err:not([hidden])', { timeout: 5000 }).catch(() => errors.push('wrong 2FA code did not show an error'));
await p4.fill('#tf input[name=code]', codeNow(secret, 1)); await p4.click('#tf button.primary'); await p4.waitForSelector('.kpi', { timeout: 5000 }).catch(() => errors.push('2FA sign-in with a valid code failed'));
await p4.click('button[data-act=logout]'); await p4.waitForSelector('#login'); await p4.fill('input[name=email]', 'maya@ovantaa.com'); await p4.fill('input[name=password]', 'Ovantaa@123'); await p4.click('button.primary'); await p4.waitForSelector('#tf'); await p4.click('#tf-alt');
await p4.fill('#tf input[name=code]', rcodes[0]); await p4.click('#tf button.primary'); await p4.waitForSelector('.kpi', { timeout: 5000 }).catch(() => errors.push('recovery-code sign-in failed')); await ctx4.close();
// company policy forces set-up at the next sign-in
await page.evaluate(() => fetch('/api/settings/security', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ require_2fa: 'all' }) }));
const ctx5 = await browser.newContext({ viewport: { width: 1360, height: 900 } }); const p5 = await ctx5.newPage();
await p5.goto(base); await p5.fill('input[name=email]', 'liam@ovantaa.com'); await p5.fill('input[name=password]', 'Ovantaa@123'); await p5.click('button.primary');
await p5.waitForSelector('h2:has-text("Set up two-factor sign-in")', { timeout: 5000 }).catch(() => errors.push('forced 2FA set-up page not shown'));
const secret5 = (await p5.textContent('.twofa .mono')).trim(); await p5.fill('#tf-enable input[name=code]', codeNow(secret5)); await p5.click('#tf-enable button'); await p5.waitForSelector('.modal:has-text("recovery codes")'); await p5.click('.modal button:has-text("I have saved them")');
await p5.waitForSelector('.kpi', { timeout: 5000 }).catch(() => errors.push('did not reach the app after forced set-up')); await ctx5.close();
await page.evaluate(() => fetch('/api/settings/security', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ require_2fa: 'off' }) }));
// ===== Stage folders, file viewer, AI search =====
const sdeal = await page.evaluate(async () => (await (await fetch('/api/deals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Folder demo deal', amount: 64000, stage: 'proposal', custom: { cf_deal_type: 'Direct' } }) })).json()));
await page.goto(`${base}/#/deals/${sdeal.id}`); await page.waitForSelector('#attach-box details[data-folder=proposal][open]');
await page.setInputFiles('#attach-box [data-file]', [{ name: 'Proposal v2.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%fake\n') }, { name: 'Price list.csv', mimeType: 'text/csv', buffer: Buffer.from('Item,Price\nLicence,1200\nSupport,300\n') },
  { name: 'Sizing.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: makeXlsx([['Users', 'Seats'], ['Sales', 40]]) }, { name: 'SOW.docx', mimeType: 'application/octet-stream', buffer: makeDocx('Statement of work', ['Phase one covers onboarding.']) }]);
await page.waitForFunction(() => document.querySelectorAll('#attach-box details[data-folder=proposal] .frow').length === 4, null, { timeout: 5000 }).catch(() => errors.push('4 files not shown in the Proposal folder'));
await shot('stage-folders');
await page.click('#attach-box a:has-text("Price list.csv")'); await page.waitForSelector('.modal td:has-text("Licence")', { timeout: 5000 }).catch(() => errors.push('CSV viewer did not show the table')); await shot('viewer-csv');
await page.keyboard.press('Escape'); await page.click('#attach-box a:has-text("Sizing.xlsx")'); await page.waitForSelector('.modal td:has-text("Sales")', { timeout: 5000 }).catch(() => errors.push('xlsx viewer did not show the sheet'));
await page.click('.modal button[data-act=prev]'); await page.waitForSelector('.modal h3:has-text("Statement of work")', { timeout: 5000 }).catch(() => errors.push('docx viewer (via the arrow) did not show the text')); await shot('viewer-docx');
await page.keyboard.press('Escape'); await page.click('#attach-box a:has-text("Proposal v2.pdf")'); await page.waitForSelector('.modal iframe[src*="/view"]', { timeout: 5000 }).catch(() => errors.push('PDF viewer iframe missing'));
await page.keyboard.press('Escape');
// move to the next stage with files attached in the stage dialog -> they appear in that folder and in the stage history
await page.click('button[data-act=stage]'); await page.selectOption('.modal select[name=stage]', 'negotiation'); await page.fill('.modal textarea[name=comment]', 'Customer reviewing PO');
await page.setInputFiles('.modal input[name=stagefiles]', [{ name: 'PO draft.txt', mimeType: 'text/plain', buffer: Buffer.from('PO 4471') }, { name: 'Redlines.txt', mimeType: 'text/plain', buffer: Buffer.from('clause 7') }]);
await page.click('.modal button[type=submit]');
await page.waitForSelector('.timeline a[data-act=viewfile]:has-text("PO draft.txt")', { timeout: 5000 }).catch(() => errors.push('stage-history file link missing'));
if ((await page.locator('.timeline a[data-act=viewfile]:has-text("Proposal v2.pdf")').count()) !== 1) errors.push('proposal files not linked under the Proposal stage entry');
await shot('stage-history-files');
await page.click('.timeline a[data-act=viewfile]:has-text("PO draft.txt")'); await page.waitForSelector('.modal pre:has-text("PO 4471")', { timeout: 5000 }).catch(() => errors.push('text viewer failed from history link'));
await page.keyboard.press('Escape');
// move a file between folders
const poId = await page.$eval('#attach-box a:has-text("Redlines.txt")', (a) => a.dataset.id);
await page.selectOption(`#attach-box select[data-move="${poId}"]`, 'proposal'); await page.waitForSelector('#attach-box details[data-folder=proposal] a:has-text("Redlines.txt")', { timeout: 5000 }).catch(() => errors.push('moving a file between folders failed'));
// deep link to a file opens the viewer
await page.goto(`${base}/#/dashboard`); await page.goto(`${base}/#/deals/${sdeal.id}?file=${poId}`); await page.waitForSelector('.modal pre:has-text("clause 7")', { timeout: 5000 }).catch(() => errors.push('file deep link did not open the viewer')); await page.keyboard.press('Escape');
// AI search (fake Claude returns a plan for proposal-folder PDFs)
await page.keyboard.press('Control+k'); await page.waitForSelector('#sq input[name=q]', { timeout: 5000 }).catch(() => errors.push('Ctrl+K did not open search'));
await page.fill('#sq input[name=q]', 'proposal pdfs'); await page.click('#sq button.primary');
await page.waitForSelector('#sres a[data-act=file]:has-text("Proposal v2.pdf")', { timeout: 8000 }).catch(() => errors.push('AI search did not find the PDF')); await shot('ai-search');
await page.click('#sres a[data-act=file]:has-text("Proposal v2.pdf")'); await page.waitForSelector('.modal iframe', { timeout: 5000 }).catch(() => errors.push('viewer did not open from search')); await page.keyboard.press('Escape');
await page.selectOption('#sq select[name=mode]', 'keyword'); await page.fill('#sq input[name=q]', 'Folder demo'); await page.click('#sq button.primary');
await page.waitForSelector('#sres a:has-text("Folder demo deal")', { timeout: 5000 }).catch(() => errors.push('keyword search did not find the deal'));
await page.selectOption('#sq select[name=mode]', 'ai');
// ===== Task assignment between team members =====
const { all: dbAll } = await import('../server/db.js');
const taskMails = (to) => dbAll("SELECT subject FROM email_log WHERE kind='task' AND to_email=? ORDER BY id", to).map((r) => r.subject);
const liamId = await page.evaluate(async () => (await (await fetch('/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Tina Field', email: 'tina@ovantaa.com', password: 'Ovantaa@123', role: 'rep' }) })).json()).id);
await page.goto(`${base}/#/tasks`); await page.reload(); await page.waitForSelector('text=+ New task'); await page.click('text=+ New task'); await page.fill('.modal input[name=title]', 'E2E: collect signed PO');
await page.fill('.modal input[name=due_date]', '2026-12-15');
await page.selectOption('.modal select[name=owner_id]', String(liamId)); await page.waitForSelector('.modal textarea[name=assign_note]:visible'); await page.fill('.modal textarea[name=assign_note]', 'Customer promised it this week');
await shot('task-assign'); await page.click('.modal button[type=submit]'); await page.waitForSelector('.toast:has-text("Task assigned to Tina Field")', { timeout: 5000 }).catch(() => errors.push('assign toast missing'));
await new Promise((r) => setTimeout(r, 200)); if (!taskMails('tina@ovantaa.com').some((s) => /New task for you: E2E: collect signed PO \(due Tue, 15 Dec 2026\)/.test(s))) errors.push('assignee email not sent ' + JSON.stringify(taskMails('tina@ovantaa.com')));
const ctx6 = await browser.newContext({ viewport: { width: 1360, height: 900 } }); const p6 = await ctx6.newPage(); p6.on('pageerror', (e) => errors.push('pageerror(tasks): ' + e.message));
await p6.goto(base); await p6.fill('input[name=email]', 'tina@ovantaa.com'); await p6.fill('input[name=password]', 'Ovantaa@123'); await p6.click('button.primary');
await p6.waitForSelector('.kpi'); await p6.waitForSelector('a[data-nav=tasks] .badge', { timeout: 5000 }).catch(() => errors.push('no task count badge in the menu for the assignee'));
await p6.click('a[data-nav=tasks]'); await p6.click('button[data-act=tab][data-t=to_me]'); await p6.click('a[data-act=open]:has-text("E2E: collect signed PO")');
await p6.waitForSelector('.modal button[data-act=issue]'); await p6.click('.modal button[data-act=issue]'); await p6.fill('#tp-form textarea[name=note]', 'Customer says the PO needs a revised quote first');
await p6.setInputFiles('#tp-form input[name=tfiles]', [{ name: 'customer-email.txt', mimeType: 'text/plain', buffer: Buffer.from('Please revise') }, { name: 'old-quote.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2') }]);
await p6.click('#tp-form button[data-act=go]'); await p6.waitForSelector('.modal .timeline :text("Customer says the PO needs a revised quote first")', { timeout: 5000 }).catch(() => errors.push('issue not on the timeline'));
await p6.waitForSelector('.modal #tp-files a:has-text("customer-email.txt")', { timeout: 5000 }).catch(() => errors.push('issue files not attached')); await p6.screenshot({ path: `${process.env.SHOTS || '/tmp'}/task-issue.png` });
await new Promise((r) => setTimeout(r, 200)); if (!taskMails('admin@ovantaa.com').some((s) => /Issue raised on task: E2E: collect signed PO/.test(s))) errors.push('assigner not emailed about the issue');
await page.goto(`${base}/#/dashboard`); await page.click('a[data-nav=tasks]'); await page.click('button[data-act=tab][data-t=by_me]'); await page.waitForSelector('tr.row-issue a[data-act=open]:has-text("E2E: collect signed PO")', { timeout: 5000 }).catch(() => errors.push('issue row not highlighted for the assigner'));
await shot('tasks-by-me'); await page.click('tr.row-issue a[data-act=open]'); await page.click('.modal button[data-act=reassign]'); await page.fill('#tp-form input[name=due]', '2026-12-18'); await page.fill('#tp-form textarea[name=note]', 'Revised quote attached');
await page.setInputFiles('#tp-form input[name=tfiles]', { name: 'quote-v3.txt', mimeType: 'text/plain', buffer: Buffer.from('v3') }); await page.click('#tp-form button[data-act=go]');
await page.waitForSelector('.modal .timeline :text("Sent back to Tina")', { timeout: 5000 }).catch(() => errors.push('send back not recorded'));
await new Promise((r) => setTimeout(r, 200)); if (!taskMails('tina@ovantaa.com').some((s) => /sent back to you: E2E: collect signed PO \(due Fri, 18 Dec 2026\)/.test(s))) errors.push('assignee not emailed on send back');
await page.keyboard.press('Escape');
await p6.goto(`${base}/#/dashboard`); await p6.goto(`${base}/#/tasks?task=${await page.evaluate(() => fetch('/api/tasks?q=E2E%3A%20collect').then((r) => r.json()).then((j) => j.rows[0].id))}`);
await p6.waitForSelector('.modal button[data-act=done]', { timeout: 5000 }).catch(() => errors.push('email link did not open the task')); await p6.click('.modal button[data-act=done]'); await p6.fill('#tp-form textarea[name=note]', 'PO received');
await p6.click('#tp-form button[data-act=go]'); await p6.waitForSelector('.modal button[data-act=reopen]', { timeout: 5000 }).catch(() => errors.push('task not completed')); await ctx6.close();
await new Promise((r) => setTimeout(r, 200)); if (!taskMails('admin@ovantaa.com').some((s) => /Task completed: E2E: collect signed PO/.test(s))) errors.push('assigner not emailed on completion');
// ===== Two people on the same deal: presence, merged edits, conflicts, live refresh =====
const ctx7 = await browser.newContext({ viewport: { width: 1360, height: 900 } }); const tina = await ctx7.newPage(); tina.on('pageerror', (e) => errors.push('pageerror(live): ' + e.message));
await tina.goto(base); await tina.fill('input[name=email]', 'tina@ovantaa.com'); await tina.fill('input[name=password]', 'Ovantaa@123'); await tina.click('button.primary'); await tina.waitForSelector('.kpi');
await page.goto(`${base}/#/deals/${sdeal.id}`); await page.waitForSelector('h1:has-text("Folder demo deal")');
await tina.goto(`${base}/#/deals/${sdeal.id}`); await tina.waitForSelector('h1:has-text("Folder demo deal")');
await page.waitForSelector('[data-presence] :text("Tina Field is viewing")', { timeout: 8000 }).catch(() => errors.push('presence (viewing) not shown'));
await tina.click('button[data-act=edit]'); await tina.waitForSelector('.modal input[name=f__amount]');
await page.waitForSelector('[data-presence] :text("Tina Field is editing")', { timeout: 8000 }).catch(() => errors.push('presence (editing) not shown')); await shot('presence-editing');
// admin changes the amount while Tina's form is open -> Tina is warned; Tina changes only the close date -> both changes kept
await page.click('button[data-act=edit]'); await page.fill('.modal input[name=f__amount]', '70000'); await page.click('.modal button[type=submit]'); await page.waitForSelector('.toast:has-text("Deal saved")');
await tina.waitForSelector('.modal [data-live-note]', { timeout: 8000 }).catch(() => errors.push('editing user not warned about the other save'));
await tina.fill('.modal input[name=f__close_date]', '2027-02-01'); await tina.click('.modal button[type=submit]'); await tina.waitForSelector('.toast:has-text("Deal saved")', { timeout: 5000 }).catch(() => errors.push('merge save failed'));
const merged = await page.evaluate((id) => fetch(`/api/deals/${id}`).then((r) => r.json()), sdeal.id);
if (merged.amount !== 70000 || merged.close_date !== '2027-02-01') errors.push('edits were not merged ' + JSON.stringify([merged.amount, merged.close_date]));
await page.waitForSelector('.toast:has-text("Tina Field updated this just now")', { timeout: 8000 }).catch(() => errors.push('other user\'s page did not refresh'));
// both change the amount -> the second one gets the conflict chooser and picks their own value
await tina.click('button[data-act=edit]'); await tina.waitForSelector('.modal input[name=f__amount]');
await page.click('button[data-act=edit]'); await page.fill('.modal input[name=f__amount]', '80000'); await page.click('.modal button[type=submit]'); await page.waitForSelector('.toast:has-text("Deal saved")');
await tina.fill('.modal input[name=f__amount]', '75000'); await tina.click('.modal button[type=submit]');
await tina.waitForSelector('.modal [data-conflicts] :text("Amount")', { timeout: 5000 }).catch(() => errors.push('conflict chooser not shown')); await tina.screenshot({ path: `${process.env.SHOTS || '/tmp'}/conflict.png` });
await tina.check('.modal input[name="cf__amount"][value=mine]'); await tina.click('.modal button[type=submit]'); await tina.waitForSelector('.toast:has-text("Deal saved")', { timeout: 5000 }).catch(() => errors.push('save after choosing failed'));
if ((await page.evaluate((id) => fetch(`/api/deals/${id}`).then((r) => r.json()), sdeal.id)).amount !== 75000) errors.push('chosen value not saved');
await ctx7.close();
// ===== Two currencies with yearly rates =====
const YR = new Date().getFullYear();
await page.goto(`${base}/#/settings`); await page.waitForSelector('#fxpair');
await page.selectOption('#fxpair select[name=c2]', 'SAR'); await page.click('#fxpair button'); await page.waitForSelector('#fxcard button[data-act=add]');
await page.click('#fxcard button[data-act=add]'); await page.fill('.modal input[name=year]', String(YR)); await page.fill('.modal input[name=rate]', '3.75'); await page.fill('.modal input[name=note]', 'Finance budget rate');
await page.click('.modal button[type=submit]'); await page.waitForSelector(`#fxcard td:has-text("1 USD = 3.75 SAR")`, { timeout: 5000 }).catch(() => errors.push('yearly rate not listed'));
await page.click('#fxcard button[data-act=edit]'); await page.fill('.modal input[name=rate]', '3.76'); await page.click('.modal button[type=submit]'); await page.waitForSelector('#fxcard td:has-text("1 USD = 3.76 SAR")');
await page.click('#fxcard details summary'); if (!(await page.textContent('#fxcard details')).includes('3.75 → 3.76')) errors.push('rate change history missing'); if (!(await page.textContent('#fxcard table')).includes('Finance budget rate')) errors.push('note lost when editing the rate');
await page.evaluate(() => document.getElementById('fxcard').scrollIntoView()); await shot('currencies');
const fxDeal = await page.evaluate(async (y) => (await (await fetch('/api/deals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'FX demo deal', amount: 10000, close_date: `${y}-12-20`, custom: { cf_deal_type: 'Direct' } }) })).json()), YR);
if (fxDeal.amount2 !== 37600) errors.push('deal not converted on save ' + fxDeal.amount2);
await page.goto(`${base}/#/deals/${fxDeal.id}`); await page.waitForSelector('.stat-big:has-text("SAR")', { timeout: 5000 }).catch(() => errors.push('converted amount not on the deal page'));
if (!(await page.textContent('body')).includes(`Rate ${YR}: 1 USD = 3.76 SAR`)) errors.push('rate explanation missing on the deal page'); await shot('deal-two-currencies');
await page.click('a[data-nav=deals]'); await page.click('button:has-text("List")'); await page.waitForSelector('th:has-text("Amount (SAR)")', { timeout: 5000 }).catch(() => errors.push('SAR column missing in the deals list'));
await page.click('button:has-text("Board")'); await page.waitForSelector('.col .ch :text("SAR")', { timeout: 5000 }).catch(() => errors.push('SAR totals missing on the board')); await shot('board-two-currencies');
await page.click('a[data-nav=dashboard]'); await page.waitForSelector('.kpi .s b:has-text("SAR")', { timeout: 5000 }).catch(() => errors.push('SAR totals missing on the dashboard'));
// ===== General invoicing: India GST mode, email, payment + receipt, reversal =====
const { gstinValid } = await import('../server/regimes.js');
const mkGstin = (st, pan) => { for (const c of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ') if (gstinValid(`${st}${pan}1Z${c}`)) return `${st}${pan}1Z${c}`; };
await page.goto(`${base}/#/billing-settings`); await page.waitForSelector('select[name=jurisdiction][data-switch]');
await page.selectOption('select[name=jurisdiction][data-switch]', 'IN'); await page.click('.modal button[type=submit]');
await page.waitForSelector('select[name=a_state]', { timeout: 5000 }).catch(() => errors.push('India fields not shown after switching mode'));
await page.fill('input[name=seller_name]', 'Ovantaa India Pvt Ltd'); await page.fill('input[name=vat_number]', mkGstin('27', 'AAPFU0939F')); await page.fill('input[name=a_street]', 'FC Road'); await page.fill('input[name=a_city]', 'Pune');
await page.selectOption('select[name=a_state]', '27'); await page.fill('input[name=a_postal_code]', '411004'); await page.fill('input[name=b_account_number]', '50100123456789'); await page.fill('input[name=b_bank_code]', 'HDFC0001234'); await page.fill('input[name=b_upi]', 'ovantaa@hdfcbank');
await page.click('button[data-act=save]'); await page.waitForSelector('.toast:has-text("Billing settings saved")'); await shot('billing-india');
if ((await page.locator('.banner.bad').count()) > 0) errors.push('India profile still incomplete: ' + (await page.textContent('.banner.bad')));
const inAcc = await page.evaluate(async (g) => (await (await fetch('/api/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Bengaluru Books Pvt Ltd', vat_number: g, state: 'Karnataka', country_code: 'IN', street: '12 MG Road', city: 'Bengaluru', billing_email: 'accounts@blrbooks.in' }) })).json()), mkGstin('29', 'AABCT1332L'));
await page.goto(`${base}/#/invoices/new`); await page.waitForSelector('select[name=account_id]'); await page.reload(); await page.waitForSelector('select[name=account_id]');
await page.selectOption('select[name=account_id]', String(inAcc.id)); await page.waitForFunction(() => document.querySelector('select[name=buyer_state]')?.value === 'Karnataka', null, { timeout: 5000 }).catch(() => errors.push('customer state not filled from the account'));
await page.fill('#lines input[data-k=description]', 'CRM implementation'); await page.fill('#lines input[data-k=hsn_code]', '998314'); await page.fill('#lines input[data-k=qty]', '1'); await page.fill('#lines input[data-k=unit_price]', '100000');
await page.waitForSelector('#totals :text("IGST")', { timeout: 5000 }).catch(() => errors.push('IGST not shown in the editor totals'));
await page.waitForSelector('#issues :text("Ready to issue")', { timeout: 6000 }).catch(async () => errors.push('India invoice not ready: ' + (await page.textContent('#issues'))));
await shot('invoice-india-editor'); await page.click('button[data-act=saveissue]');
await page.waitForSelector('.modal input[name=to]', { timeout: 8000 }).catch(() => errors.push('email dialog did not open after issuing'));
if ((await page.inputValue('.modal input[name=to]')) !== 'accounts@blrbooks.in') errors.push('email To not prefilled'); await shot('invoice-email');
await page.click('.modal button[type=submit]'); await page.waitForSelector('.toast:has-text("Emailed to"), .toast:has-text("Not really sent")', { timeout: 8000 }).catch(() => errors.push('email send gave no result'));
await page.waitForSelector('.badge:has-text("emailed")', { timeout: 5000 }).catch(() => errors.push('emailed badge missing'));
const inInvId = Number(page.url().match(/invoices\/(\d+)/)[1]);
const printed = await page.evaluate((id) => fetch(`/api/invoices/${id}/print`).then((r) => r.text()), inInvId);
for (const x of ['IGST 18%', 'GSTIN', 'Karnataka (29)', 'One Lakh Eighteen Thousand', 'ovantaa@hdfcbank']) if (!printed.includes(x)) errors.push('printed India invoice missing ' + x);
await page.click('button[data-act=pay]'); await page.waitForSelector('.modal input[name=send_receipt]'); await page.click('.modal button[type=submit]');
await page.waitForSelector('.toast:has-text("invoice fully paid")', { timeout: 6000 }).catch(() => errors.push('payment not recorded as full'));
await page.waitForSelector('button[data-act=unpay]'); await shot('invoice-paid'); await page.click('button[data-act=unpay]'); await page.fill('.modal input[name=reason]', 'Entered against the wrong invoice'); await page.click('.modal button[type=submit]');
await page.waitForSelector('.toast:has-text("Payment reversed")', { timeout: 5000 }).catch(() => errors.push('payment reversal failed'));
await page.waitForSelector('input[data-pause]'); await page.uncheck('input[data-pause]'); await page.waitForSelector('.toast:has-text("paused")', { timeout: 5000 }).catch(() => errors.push('pausing reminders failed'));
await page.evaluate(() => fetch('/api/billing/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jurisdiction: 'KSA' }) }));
// segment builder + deal drag/drop
await page.click('a[data-nav=segments]'); await page.click('text=+ New segment'); await page.fill('.modal input[name=name]', 'E2E seg');
await page.waitForSelector('#segprev b'); await page.click('.modal button[type=submit]'); await page.waitForSelector('td:has-text("E2E seg")');
await page.click('a[data-nav=deals]'); await page.waitForSelector('.dcard');
const countIn = (stage) => page.$$eval(`.col[data-stage=${stage}] .dcard`, (e) => e.length);
const [p0, q0] = [await countIn('prospecting'), await countIn('proposal')];
const movedId = await page.$eval('.col[data-stage=prospecting] .dcard >> nth=0', (e) => e.dataset.id).catch(async () => (await page.$eval('.col[data-stage=prospecting] .dcard', (e) => e.dataset.id)));
await page.dragAndDrop('.col[data-stage=prospecting] .dcard >> nth=0', '.col[data-stage=proposal] .cards');
await page.waitForSelector('.modal textarea[name=comment]'); // drag opens the move dialog
await page.fill('.modal textarea[name=comment]', 'E2E: proposal accepted by finance'); await page.click('.modal button[type=submit]');
await page.waitForFunction((n) => document.querySelectorAll('.col[data-stage=proposal] .dcard').length === n, q0 + 1, { timeout: 5000 })
  .catch(() => errors.push('drag-drop did not move a deal into Proposal'));
if ((await countIn('prospecting')) !== p0 - 1) errors.push('deal was not removed from Prospecting');
// history: modal from the board, then full page
const movedCard = await page.$eval('.col[data-stage=proposal] .dcard >> nth=0', (e) => e.dataset.id).catch(() => null);
const hist = await page.evaluate(async () => { const rows = (await (await fetch('/api/deals?limit=1000')).json()).rows; const out = []; for (const r of rows) { const h = await (await fetch(`/api/deals/${r.id}/history`)).json(); if (h.some((x) => x.comment === 'E2E: proposal accepted by finance')) out.push({ id: r.id, h }); } return out; });
if (hist.length !== 1 || hist[0].h.at(-1).to_stage !== 'proposal' || hist[0].h.at(-1).changed_by_name !== 'Admin User') errors.push('history not stored for the drag-drop move ' + JSON.stringify(hist).slice(0, 200));
await page.click(`button[data-act=hist][data-id="${hist[0]?.id}"]`); await page.waitForSelector('.modal .timeline li'); await shot('history-modal');
if (!(await page.textContent('.modal')).includes('E2E: proposal accepted by finance')) errors.push('comment missing in history modal');
await page.keyboard.press('Escape');
await page.goto(`${base}/#/deals/${hist[0]?.id}`); await page.waitForSelector('text=Stage history'); await shot('deal-detail-history');
await page.click('text=Change stage'); await page.selectOption('.modal select[name=stage]', 'won'); await page.fill('.modal textarea[name=comment]', 'E2E: signed'); await page.click('.modal button[type=submit]');
await page.waitForSelector('.timeline li:has-text("E2E: signed")', { timeout: 5000 }).catch(() => errors.push('stage change from detail page not shown in history'));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'E2E OK');
await browser.close(); server.close(); ai.close(); process.exit(errors.length ? 1 : 0);
