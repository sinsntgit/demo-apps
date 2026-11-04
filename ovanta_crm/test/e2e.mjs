// Browser smoke test: node --no-warnings test/e2e.mjs  (needs Playwright + Chromium available)
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright'); // not a project dependency; preinstalled globally
process.env.DB_PATH = ':memory:'; process.env.SESSION_SECRET = 'e2e'; process.env.SEND_DELAY_MS = '1';
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
for (const r of ['contacts', 'accounts', 'deals', 'tasks', 'campaigns', 'segments', 'templates', 'team', 'settings']) {
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
// segment builder + deal drag/drop
await page.click('a[data-nav=segments]'); await page.click('text=+ New segment'); await page.fill('.modal input[name=name]', 'E2E seg');
await page.waitForSelector('#segprev b'); await page.click('.modal button[type=submit]'); await page.waitForSelector('td:has-text("E2E seg")');
await page.click('a[data-nav=deals]'); await page.waitForSelector('.dcard');
const countIn = (stage) => page.$$eval(`.col[data-stage=${stage}] .dcard`, (e) => e.length);
const [p0, q0] = [await countIn('prospecting'), await countIn('proposal')];
await page.dragAndDrop('.col[data-stage=prospecting] .dcard >> nth=0', '.col[data-stage=proposal] .cards');
await page.waitForFunction((n) => document.querySelectorAll('.col[data-stage=proposal] .dcard').length === n, q0 + 1, { timeout: 5000 })
  .catch(() => errors.push('drag-drop did not move a deal into Proposal'));
if ((await countIn('prospecting')) !== p0 - 1) errors.push('deal was not removed from Prospecting');
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'E2E OK');
await browser.close(); server.close(); process.exit(errors.length ? 1 : 0);
