// Combined data models (Data models → ＋ Combined data model): the bundled "Sample: SAP + CRM", its confirmed customer-number
// match with the "strip leading zeros" rule, the value check (percentages only), the diagram's orange match line, creating a
// combined model, deciding on suggestions, and the Ask page refusing combined models for now.
// Usage: node tests/e2e/combined.js <screenshot dir>
const { chromium } = require('playwright');
const OUT = process.argv[2], B = 'http://localhost:8010/';
(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1320, height: 900 } })).newPage(); page.setDefaultTimeout(12000);
  const errors = []; page.on('console', m => { if (m.type() === 'error' && !/40[013]/.test(m.text())) errors.push(m.text()); }); page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
  const call = (method, path, body) => page.evaluate(async ([m, u, b]) => (await fetch(u, { method: m, headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json(), [method, path, body]);
  const step = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { console.log('FAIL', name, '-', e.message.split('\n')[0]); await page.screenshot({ path: `${OUT}/FAIL-${name.replace(/\W+/g, '_')}.png` }); } };
  const noToasts = async () => { await page.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove())); await page.waitForTimeout(200); };
  await page.goto(B); await call('POST', '/api/auth/login', { email: 'admin@example.com', password: 'Admin-Passw0rd!' });
  await call('POST', '/api/admin/models', { name: 'Demo model', provider: 'openai_compatible', model_id: 'fake-1', base_url: 'http://127.0.0.1:8765/v1', is_default: true });
  const card = name => page.locator('.card', { has: page.locator(`h2:text-is("${name}")`) });

  await step('data models page shows the combined sample, linked', async () => {
    await page.goto(B + '#/data'); await page.reload(); await page.waitForSelector('h2:text-is("Sample: SAP + CRM")');
    const t = await card('Sample: SAP + CRM').innerText();
    for (const want of ['Combined data model', '✓ linked', 'Sample: SAP Sales & Finance (sap)', 'Sample: CRM (crm)', '1 confirmed match']) if (!t.includes(want)) throw new Error('card lacks ' + want + ': ' + t);
    await card('Sample: SAP + CRM').screenshot({ path: `${OUT}/combined-card.png` });
    await page.screenshot({ path: `${OUT}/datamodels.png` });
  });

  await step('matches screen: the confirmed customer-number match and its value check', async () => {
    await card('Sample: SAP + CRM').locator('button:has-text("Matches")').click();
    await page.waitForSelector('.modal h3:has-text("Confirmed matches (1)")');
    const m = page.locator('.modal .item', { hasText: 'sap.kna1.KUNNR = crm.accounts.sap_no' });
    if (!(await m.innerText()).includes('Strip leading zeros')) throw new Error('key rule missing');
    await m.locator('button:text-is("Check values")').click(); await page.waitForSelector('.toast:has-text("Values checked")');
    const after = await page.locator('.modal .item', { hasText: 'sap.kna1.KUNNR = crm.accounts.sap_no' }).innerText();
    if (!/values 100%/.test(after)) throw new Error('value check: ' + after);
    if (!/of crm\.accounts values exist in Sample: SAP Sales/.test(after)) throw new Error('direction text: ' + after);
    await noToasts(); await page.locator('.modal').screenshot({ path: `${OUT}/combined-matches.png` });
  });

  await step('diagram draws the match as an orange line between the two data models', async () => {
    await page.click('.modal button:text-is("◉ Diagram")'); await page.waitForSelector('.modal svg.kg');
    if (await page.locator('.modal svg.kg line.e.match:not(.sugg)').count() < 1) throw new Error('no confirmed match line');
    const stroke = await page.locator('.modal svg.kg line.e.match:not(.sugg)').first().evaluate(l => getComputedStyle(l).stroke);
    if (stroke !== 'rgb(217, 130, 43)') throw new Error('match line colour ' + stroke);
    if (await page.locator('.modal svg.kg g.n:has(text:text-is("crm.accounts"))').count() !== 1) throw new Error('crm.accounts missing');
    await page.locator('.modal svg.kg g.n:has(text:text-is("crm.accounts"))').click();
    await page.waitForSelector('.modal .card .item:has-text("crm.accounts")');
    await page.locator('.modal').screenshot({ path: `${OUT}/combined-diagram.png` });
    await page.click('.modal button:text-is("☰ List")');
  });

  await step('confirm one suggestion, reject another, restore it', async () => {
    const sugg = page.locator('h3:has-text("Suggestions to check") + .card .item');
    const n0 = await sugg.count(); if (n0 < 2) throw new Error('suggestions: ' + n0);
    const first = (await sugg.nth(0).locator('code').innerText());
    await sugg.nth(0).locator('button:text-is("✓ Confirm")').click(); await page.waitForSelector('.toast:has-text("Confirmed")');
    await page.waitForSelector(`h3:has-text("Confirmed matches (2)")`);
    const second = (await sugg.nth(0).locator('code').innerText());
    await sugg.nth(0).locator('button:text-is("✗ Reject")').click(); await page.waitForSelector('.toast:has-text("Rejected")');
    await page.click('.modal summary:has-text("Rejected")'); await page.waitForSelector(`.modal details code:text("${second}")`);
    await page.locator('.modal details .item', { hasText: second }).locator('button:text-is("Restore")').click(); await page.waitForSelector('.toast:has-text("Restored")');
    await page.waitForSelector(`h3:has-text("Suggestions to check") + .card code:text("${second}")`);
    if (!first) throw new Error('no first');
    await page.click('.modal .close, .modal button[aria-label="Close"]').catch(() => page.keyboard.press('Escape'));
  });

  await step('create a combined model: retail + CRM, with the value check on', async () => {
    await page.goto(B + '#/data'); await page.reload(); await page.waitForSelector('h2:text-is("Sample: SAP + CRM")');
    await page.click('button:text-is("＋ Combined data model")'); await page.waitForSelector('.modal >> text=Answer questions that need two or more');
    await page.fill('.modal input[placeholder="e.g. SAP + CRM"]', 'Retail + CRM');
    const opts = await page.locator('.modal select[aria-label="Data model 1"] option').allInnerTexts();
    const pick = (i, name) => page.locator(`.modal select[aria-label="Data model ${i}"]`).selectOption({ label: opts.find(o => o.startsWith(name)) });
    await pick(1, 'Sample: Retail sales'); await pick(2, 'Sample: CRM');
    if (await page.inputValue('.modal input[aria-label="Short name 1"]') !== 'retail') throw new Error('alias guess');
    await page.locator('.modal label', { hasText: 'Check values to confirm matches' }).locator('input').check();
    await page.locator('.modal').screenshot({ path: `${OUT}/combined-form.png` });
    await page.click('.modal footer .primary'); await page.waitForSelector('.modal h3:has-text("Suggestions to check")');
    await page.waitForSelector('.modal >> text=Matches · Retail + CRM');
    await page.click('.modal button:has-text("Find matches")'); await page.waitForSelector('.toast:has-text("values checked for")');
  });

  await step('add a match by hand; the model becomes linked', async () => {
    await page.click('.modal button:text-is("＋ Add match")'); await page.waitForSelector('.modal >> text=Add a match');
    const top = page.locator('.modal').last();
    const sides = top.locator('label.field');
    const t1 = sides.nth(0).locator('select[aria-label="Table"]'); const tables1 = await t1.locator('option').allInnerTexts();
    await t1.selectOption(tables1.find(t => /customers/.test(t)));
    const c1 = sides.nth(0).locator('select[aria-label="Column"]'); await c1.selectOption({ index: 1 });
    await sides.nth(1).locator('select[aria-label="Table"]').selectOption('crm.accounts');
    await sides.nth(1).locator('select[aria-label="Column"]').selectOption('account_id');
    await top.locator('footer .primary').click(); await page.waitForSelector('.toast:has-text("Match added")');
    await page.waitForSelector('.modal >> text=✓ every data model is linked');
  });

  await step('ask page does not offer combined models yet; the server refuses them', async () => {
    const conns = await call('GET', '/api/connections');
    const combo = conns.find(c => c.name === 'Retail + CRM');
    const r = await call('POST', '/api/chat/ask', { connection_id: combo.id, question: 'how many accounts' });
    if (!/next update|not yet/i.test(JSON.stringify(r))) throw new Error('ask: ' + JSON.stringify(r).slice(0, 200));
    await page.goto(B + '#/ask'); await page.reload(); await page.waitForSelector('select');
    const all = (await page.locator('select').allInnerTexts()).join('|');
    if (all.includes('SAP + CRM') || all.includes('Retail + CRM')) throw new Error('combined offered on Ask');
  });

  await step('delete the combined model keeps its data models', async () => {
    await page.goto(B + '#/data'); await page.reload(); await page.waitForSelector('h2:text-is("Retail + CRM")');
    await card('Retail + CRM').locator('button:text-is("Delete")').click(); await page.click('.modal footer .danger, .modal footer .primary');
    await page.waitForSelector('h2:text-is("Retail + CRM")', { state: 'detached' });
    if (await page.locator('h2:text-is("Sample: CRM")').count() !== 1) throw new Error('member deleted');
  });

  await step('settings show the combined-model limits', async () => {
    await page.goto(B + '#/admin/settings'); await page.reload(); await page.waitForSelector('h2:text-is("Combined data models")');
    await page.locator('.card', { has: page.locator('h2:text-is("Combined data models")') }).screenshot({ path: `${OUT}/combined-settings.png` });
  });

  console.log('console errors:', errors.length ? errors.join(' | ') : 'none');
  await browser.close();
})();
