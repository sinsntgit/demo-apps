// Browser smoke test: node --no-warnings test/e2e.mjs  (needs Playwright + Chromium available)
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright'); // not a project dependency; preinstalled globally
import http from 'node:http';
import { makeXlsx } from './fixtures.mjs';
process.env.DB_PATH = ':memory:'; process.env.SESSION_SECRET = 'e2e'; process.env.SEND_DELAY_MS = '1';
const ai = http.createServer((q, r) => { let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ model: 'claude-sonnet-5-5', content: [{ type: 'text', text: JSON.stringify({ subject: 'AI subject line', subject_alternatives: ['Alt one', 'Alt two'], preheader: 'p', body_html: '<p>Hi {{first_name|there}}, AI wrote this.</p>' }) }] })); }); });
await new Promise((r) => ai.listen(0, '127.0.0.1', r)); process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${ai.address().port}`;
const { server } = await import('../server/index.js');
const { seedIfEmpty } = await import('../server/seed.js');
seedIfEmpty(); await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errors = []; page.on('pageerror', (e) => errors.push('pageerror: ' + e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/401/.test(m.text()))  errors.push('console: ' + m.text()); });
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
await page.click('a[data-nav=contacts]'); await page.click('text=+ New contact'); await page.fill('input[name=first_name]', 'Zed'); await page.fill('input[name=last_name]', 'Tester'); await page.fill('input[name=email]', 'zed@example.com');
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
