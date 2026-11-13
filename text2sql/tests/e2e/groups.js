const { chromium } = require('playwright');
const OUT = process.argv[2], B = 'http://localhost:8010/';
(async () => {
  const browser = await chromium.launch(); const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage(); page.setDefaultTimeout(9000);
  const errors = []; page.on('console', m => { if (m.type() === 'error' && !m.text().includes('401')) errors.push(m.text()); }); page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
  const post = (path, body) => page.evaluate(async ([p, b]) => (await fetch(p, { method: 'POST', headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json(), [path, body]);
  const step = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { console.log('FAIL', name, '-', e.message.split('\n')[0]); await page.screenshot({ path: `${OUT}/FAIL-${name.replace(/\W+/g, '_')}.png` }); } };
  await page.goto(B); await page.fill('input[type=email]', 'admin@example.com'); await page.fill('input[type=password]', 'Admin-Passw0rd!'); await page.click('button[type=submit]'); await page.waitForSelector('.nav');
  const ids = []; for (const [e, n, r] of [['priya@example.com', 'Priya Nair', 'steward'], ['tom@example.com', 'Tom Becker', 'analyst'], ['lena@example.com', 'Lena Okafor', 'analyst']]) ids.push((await post('/api/admin/users', { email: e, name: n, role: r })).id);
  await post('/api/admin/groups', { name: 'North sales team', description: 'Regional sales', user_ids: [ids[1], ids[2]] });
  await post('/api/admin/groups', { name: 'Finance', user_ids: [ids[0]] });
  await step('grant access to a group', async () => {
    await page.goto(B + '#/admin/access'); await page.waitForSelector('text=Data filters');
    await page.locator('label.check:has-text("Only selected groups and users")').click();
    await page.locator('label.check:has-text("North sales team")').click();
    await page.waitForSelector('text=already has access via North sales team');
    await page.click('text=Save access'); await page.waitForSelector('.badge.warn:has-text("1 group(s) + 0 user(s)")');
  });
  await step('filter for a group', async () => {
    await page.click('text=＋ Add filter'); await page.fill('.modal input[list]', 'customers'); await page.fill('.modal textarea', "region = 'North'");
    await page.selectOption('.modal select >> nth=0', 'group'); await page.selectOption('.modal select >> nth=1', { label: 'North sales team (2)' });
    await page.locator('.modal').screenshot({ path: `${OUT}/filter-form.png` }); await page.click('.modal footer .primary');
    await page.waitForSelector('td:has-text("Group: North sales team")'); await page.waitForTimeout(3800); await page.screenshot({ path: `${OUT}/access.png` });
  });
  console.log('console errors:', errors.length ? errors : 'none'); await browser.close();
})();
