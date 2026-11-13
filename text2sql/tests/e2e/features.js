const { chromium } = require('playwright');
const { execSync } = require('child_process');
const OUT = process.argv[2], DB = process.argv[3];
const B = 'http://localhost:8010/';
(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage();
  page.setDefaultTimeout(9000);
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('401')) errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
  const shot = (n, sel) => sel ? page.locator(sel).first().screenshot({ path: `${OUT}/${n}.png` }) : page.screenshot({ path: `${OUT}/${n}.png` });
  const step = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { console.log('FAIL', name, '-', e.message.split('\n')[0]); await page.screenshot({ path: `${OUT}/../FAIL-${name.replace(/\W+/g, '_')}.png` }).catch(() => {}); } };
  const ask = async q => { const n = await page.locator('.run').count(); await page.fill('.composer textarea', q); await page.keyboard.press('Enter'); await page.waitForFunction(k => document.querySelectorAll('.run').length > k, n); await page.waitForTimeout(700); };
  const post = (path, body) => page.evaluate(async ([p, b]) => (await fetch(p, { method: 'POST', headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json(), [path, body]);
  const sql = q => execSync(`python3 -c "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(sys.argv[2]); c.commit()" "${DB}" "${q}"`);

  await page.goto(B);
  await page.fill('input[type=email]', 'admin@example.com'); await page.fill('input[type=password]', 'Admin-Passw0rd!');
  await page.click('button[type=submit]'); await page.waitForSelector('.nav');
  await post('/api/admin/models', { name: 'Demo model', provider: 'openai_compatible', model_id: 'fake-1', base_url: 'http://127.0.0.1:8765/v1', is_default: true, price_in: 2, price_out: 10 });
  await post('/api/admin/users', { email: 'priya@example.com', name: 'Priya Nair', role: 'steward' });
  await post('/api/admin/users', { email: 'tom@example.com', name: 'Tom Becker', role: 'analyst' });

  // older chats, to show date grouping
  await page.goto(B + '#/ask'); await page.waitForSelector('.composer textarea');
  for (const q of ['Who are the top customers?', 'How many orders by status?', 'What is revenue by category?']) { await page.click('text=＋ New chat'); await ask(q); }
  sql("update conversations set updated_at = datetime('now','-40 days') where id = 1"); sql("update query_runs set created_at = datetime('now','-40 days') where conversation_id = 1");
  sql("update conversations set updated_at = datetime('now','-3 days') where id = 2");
  sql("update conversations set updated_at = datetime('now','-1 days') where id = 3");

  await step('ask + chart', async () => {
    await page.reload(); await page.waitForSelector('.composer textarea'); await page.click('text=＋ New chat');
    await ask('What is revenue by month?'); await page.waitForSelector('.chart-box canvas'); await shot('ask');
  });
  await step('chat grouping + rename', async () => {
    const groups = await page.locator('.conv-group').allTextContents();
    if (!(groups.includes('Today') && groups.includes('Yesterday') && groups.includes('Earlier this week') && groups.length === 4)) throw new Error('groups: ' + groups);
    await page.hover('.conv >> nth=1'); await page.click('.conv >> nth=1 >> [title="Rename chat"]');
    await page.fill('.modal input', 'Category revenue review'); await page.click('.modal footer .primary');
    await page.waitForSelector('.conv:has-text("Category revenue review")');
    await page.hover('.conv >> nth=1'); await shot('chats', '.convs');
    await page.fill('.convs input[type=search]', 'status'); if (await page.locator('.conv').count() !== 1) throw new Error('filter'); await page.fill('.convs input[type=search]', '');
  });
  await step('two measures -> panels', async () => {
    await ask('revenue and orders by region'); const run = page.locator('.run').last();
    await run.locator('.chart-controls select').nth(3).selectOption('orders');
    await page.waitForFunction(() => document.querySelectorAll('.run:last-of-type .chart-box canvas').length >= 1); await page.waitForTimeout(700);
    if (await run.locator('.chart-box canvas').count() !== 2) throw new Error('expected 2 panels, got ' + await run.locator('.chart-box canvas').count());
    await run.locator('.chart-controls').scrollIntoViewIfNeeded(); await shot('chart-panels', '.thread-inner > div:last-child .card .sec:nth-child(2)');
  });
  await step('split by controls', async () => {
    await ask('revenue by channel and category'); const run = page.locator('.run').last();
    await page.waitForTimeout(500); await shot('chart-controls', '.thread-inner > div:last-child .chart-controls');
  });
  await step('pivot: id is a category', async () => {
    await ask('pivot sales by product and month'); const run = page.locator('.run').last();
    if (await run.locator('.chart-box').count()) throw new Error('pivot should open as table');
    await run.locator('.sec-head button:text-is("Chart")').click(); await page.waitForTimeout(500);
    const labels = await run.locator('.chart-controls label').allTextContents();
    const ysel = run.locator('.chart-controls select').nth(2);
    const opts = await ysel.locator('option').allTextContents();
    if (opts.includes('product_id') || !opts.includes('2025-01') || !opts.includes('Count of rows')) throw new Error('Y options: ' + opts);
    const xopts = await run.locator('.chart-controls select').nth(1).locator('option').allTextContents();
    if (xopts[0] !== 'product_id' && xopts[0] !== 'product_name') throw new Error('X options: ' + xopts);
    await run.locator('.sec-head button:text-is("Summary")').click();
    const row = await run.locator('tbody tr:has-text("product_id")').first().textContent();
    if (!row.includes('category (number)')) throw new Error('summary row: ' + row);
    await page.screenshot({ path: `${OUT}/../pivot-summary.png` });
  });
  await step('no measures -> count of rows', async () => {
    await ask('show the product list'); const run = page.locator('.run').last();
    await run.locator('.sec-head button:text-is("Chart")').click(); await page.waitForTimeout(400);
    await run.locator('.chart-controls select').nth(1).selectOption('category'); await page.waitForTimeout(600);
    const note = await run.locator('p.small.dim').last().textContent();
    if (!note.includes('Counting result rows')) throw new Error('note: ' + note);
    await page.screenshot({ path: `${OUT}/../count.png` });
  });
  await step('summary shot', async () => { await page.click('text=＋ New chat'); await ask('What is revenue by category?'); await page.locator('.run').last().locator('.sec-head button:text-is("Summary")').click(); await page.waitForTimeout(300); await shot('summary', '.thread-inner > div:last-child .card .sec:nth-child(2)'); await page.locator('.run').last().locator('text=✓ Correct').click(); });
  await step('review + edit shots', async () => {
    await page.click('text=＋ New chat'); await page.check('.ask-bar input[type=checkbox]'); await ask('How many orders by status?');
    await page.waitForSelector('text=▶ Run this SQL'); await shot('review');
    await page.click('text=✎ Edit SQL'); await page.fill('textarea.sql-edit', "SELECT status, COUNT(*) AS orders\nFROM orders\nWHERE status <> 'pending'\nGROUP BY status\nORDER BY orders DESC");
    await shot('edit'); await page.click('text=▶ Run edited SQL'); await page.waitForSelector('.chart-box canvas'); await page.click('text=save my correction'); await page.waitForSelector('text=Corrected SQL saved');
    await page.uncheck('.ask-bar input[type=checkbox]'); await ask('delete all orders'); await ask('what is the weather');
  });
  await step('history grouped', async () => { await page.goto(B + '#/history'); await page.waitForSelector('tr.group'); if (await page.locator('tr.group').count() !== 2) throw new Error('month groups ' + await page.locator('tr.group').count()); await page.screenshot({ path: `${OUT}/../history.png` }); });
  for (const [hash, sel, name] of [['#/training', '.tabs', 'training'], ['#/data', '.card h2', 'datamodels'], ['#/dashboard', 'tr.click', 'dashboard'], ['#/admin', 'table.tbl', 'users'], ['#/admin/models', '.item', 'models'], ['#/admin/settings', 'text=Save settings', 'settings']])
    await step(name, async () => { await page.goto(B + hash); await page.waitForSelector(sel); await page.waitForTimeout(900); await shot(name); });
  await step('connect form', async () => { await page.goto(B + '#/data'); await page.click('text=＋ Connect a data source'); await page.waitForTimeout(300); await shot('connect', '.modal'); await page.keyboard.press('Escape'); });
  await step('query detail', async () => { await page.goto(B + '#/dashboard'); await page.waitForSelector('tr.click'); await page.click('tr.click:has-text("revenue by category")'); await page.waitForSelector('.modal .run'); await page.waitForTimeout(700); await shot('querydetail', '.modal'); await page.keyboard.press('Escape'); });
  await step('2fa', async () => { await page.goto(B + '#/account'); await page.click('text=Set up 2FA'); await page.waitForSelector('.qr svg'); await page.evaluate(() => { document.querySelector('.qr').style.filter = 'blur(5px)'; document.querySelector('.qr + p .mono').textContent = 'XXXX XXXX XXXX XXXX'; }); await shot('2fa'); });
  await step('help page', async () => {
    await page.goto(B + '#/help/charts'); await page.waitForSelector('.help-body section#charts'); await page.waitForTimeout(1200);
    const broken = await page.evaluate(async () => { const imgs = [...document.querySelectorAll('.help-body img')]; imgs.forEach(i => i.loading = 'eager'); await new Promise(r => setTimeout(r, 1500)); return [document.querySelectorAll('.help-body img').length, imgs.length, [...document.querySelectorAll('.help-body img')].filter(i => !i.naturalWidth).map(i => i.src)]; });
    console.log('     help images present/declared/unloaded:', JSON.stringify(broken));
    await page.screenshot({ path: `${OUT}/../help.png` });
    await page.fill('.help input[type=search]', 'recovery codes'); const n = await page.locator('.help-body section:not(.hidden)').count(); console.log('     search "recovery codes" ->', n, 'sections');
    await page.fill('.help input[type=search]', ''); await page.click('.help-toc a:has-text("Troubleshooting")'); await page.waitForTimeout(300); await page.screenshot({ path: `${OUT}/../help2.png` });
  });
  console.log('console errors:', errors.length ? errors : 'none');
  await browser.close();
})();
