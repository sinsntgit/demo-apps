// "✨ Rephrase": before asking, on an asked question, the admin setting and the dashboard tile.
// Usage: node tests/e2e/rephrase.js <screenshot dir>
const { chromium } = require('playwright');
const OUT = process.argv[2], B = 'http://localhost:8010/';
(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1320, height: 860 } })).newPage(); page.setDefaultTimeout(12000);
  const errors = []; page.on('console', m => { if (m.type() === 'error' && !/40[13]/.test(m.text())) errors.push(m.text()); }); page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
  const call = (method, path, body) => page.evaluate(async ([m, u, b]) => (await fetch(u, { method: m, headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json(), [method, path, body]);
  const step = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { console.log('FAIL', name, '-', e.message.split('\n')[0]); await page.screenshot({ path: `${OUT}/FAIL-${name.replace(/\W+/g, '_')}.png` }); } };
  await page.goto(B); await call('POST', '/api/auth/login', { email: 'admin@example.com', password: 'Admin-Passw0rd!' });
  await call('POST', '/api/admin/models', { name: 'Accurate model', provider: 'openai_compatible', model_id: 'fake-1', base_url: 'http://127.0.0.1:8765/v1', is_default: true, price_in: 3, price_out: 15 });
  await call('POST', '/api/admin/models', { name: 'Fast model', provider: 'openai_compatible', model_id: 'fake-1', base_url: 'http://127.0.0.1:8765/v1', price_in: 0.8, price_out: 4 });
  const retail = (await call('GET', '/api/connections')).find(c => c.name.includes('Retail'));

  await step('admin picks the rephrasing model', async () => {
    await page.goto(B + '#/admin/settings'); await page.reload(); await page.waitForSelector('text=Rephrasing questions');
    const card = page.locator('.card', { hasText: 'Rephrasing questions' });
    await card.locator('select').selectOption({ label: 'Fast model' });
    await card.screenshot({ path: `${OUT}/rephrase-settings.png` });
    await page.click('text=Save settings'); await page.waitForSelector('text=Settings saved');
  });

  await step('rephrase before asking, then use and ask', async () => {
    await page.goto(B + '#/ask'); await page.waitForSelector('.ask-bar');
    await page.selectOption('.ask-bar select >> nth=0', String(retail.id));
    await page.fill('.composer textarea', 'rev by cat pls');
    await page.click('.composer button:text-is("✨ Rephrase")');
    await page.waitForSelector('.rephrase .card >> text=Suggested wording');
    const suggested = await page.inputValue('.rephrase textarea');
    if (suggested !== 'What is the total revenue by category?') throw new Error('suggestion: ' + suggested);
    await page.waitForSelector('.rephrase >> text=Fast model');                                   // the admin's choice
    await page.waitForSelector('.rephrase .chip:has-text("What is total revenue by product category?")');
    await page.locator('.composer').screenshot({ path: `${OUT}/rephrase.png` });
    await page.click('.rephrase button:text-is("Use and ask")');
    await page.waitForSelector('.q >> text=What is the total revenue by category?');
    await page.waitForSelector('.run .chart-box canvas');
    if (await page.locator('.rephrase .card').count()) throw new Error('panel still open');
  });

  await step('keep mine leaves the question unchanged', async () => {
    await page.fill('.composer textarea', 'top cust');
    await page.click('.composer button:text-is("✨ Rephrase")'); await page.waitForSelector('.rephrase .card');
    await page.click('.rephrase button:text-is("Keep mine")');
    if (await page.inputValue('.composer textarea') !== 'top cust') throw new Error('question changed');
    await page.fill('.composer textarea', '');
  });

  await step('rephrase an asked question', async () => {
    await page.hover('.q'); await page.locator('.q .q-re').first().click();
    await page.waitForSelector('.rephrase .card >> text=Suggested wording');
    if (await page.inputValue('.composer textarea') !== 'What is the total revenue by category?') throw new Error('question not copied to the box');
    await page.click('.rephrase button:text-is("Use this wording")');
    if (await page.locator('.rephrase .card').count()) throw new Error('panel still open');
  });

  await step('dashboard shows rephrasing use and cost', async () => {
    await page.goto(B + '#/dashboard'); await page.waitForSelector('.kpi:has-text("Rephrased")');
    const t = await page.locator('.kpi:has-text("Rephrased")').innerText();
    if (!/Rephrased\s*3/.test(t) || !t.includes('1 used')) throw new Error('tile: ' + t.replace(/\n/g, ' | '));
    await page.locator('.kpis').screenshot({ path: `${OUT}/rephrase-dashboard.png` });
  });
  console.log('console errors:', errors.length ? errors : 'none'); await browser.close();
})();
