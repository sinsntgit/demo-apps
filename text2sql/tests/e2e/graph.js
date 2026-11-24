// Metadata graph (Training → Relationships): joins found in verified SQL, suggestions a steward confirms or rejects,
// a business entity, and the join paths reaching the AI model on a real question.
// Usage: node tests/e2e/graph.js <screenshot dir>
const { chromium } = require('playwright');
const OUT = process.argv[2], B = 'http://localhost:8010/';
(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1320, height: 900 } })).newPage(); page.setDefaultTimeout(12000);
  const errors = []; page.on('console', m => { if (m.type() === 'error' && !/40[13]/.test(m.text())) errors.push(m.text()); }); page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
  const call = (method, path, body) => page.evaluate(async ([m, u, b]) => (await fetch(u, { method: m, headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json(), [method, path, body]);
  const step = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { console.log('FAIL', name, '-', e.message.split('\n')[0]); await page.screenshot({ path: `${OUT}/FAIL-${name.replace(/\W+/g, '_')}.png` }); } };
  await page.goto(B); await call('POST', '/api/auth/login', { email: 'admin@example.com', password: 'Admin-Passw0rd!' });
  await call('POST', '/api/admin/models', { name: 'Demo model', provider: 'openai_compatible', model_id: 'fake-1', base_url: 'http://127.0.0.1:8765/v1', is_default: true });
  const sap = (await call('GET', '/api/connections')).find(c => c.name.includes('SAP'));
  const item = text => page.locator('.item', { hasText: text });

  await step('relationships tab shows joins from verified SQL and suggestions', async () => {
    await page.goto(B + '#/training/' + sap.id); await page.reload(); await page.waitForSelector('.tabs');
    await page.click('.tabs button:has-text("Relationships")'); await page.waitForSelector('svg.kg');            // opens on the diagram
    await page.click('summary:has-text("Where these joins come from")');       // closed when joins already exist
    const found = await page.locator('details:has-text("Where these joins come from")').innerText();
    if (!found.includes('Approved question → SQL examples: 19, of which')) throw new Error('source panel: ' + found.slice(0, 200));
    await page.locator('details:has-text("Where these joins come from")').screenshot({ path: `${OUT}/relationships-sources.png` });
    await page.click('button:text-is("☰ List")'); await page.waitForSelector('h2:has-text("Confirmed joins")');
    await page.waitForSelector('code:text("vbrk.VBELN = vbrp.VBELN")');
    await page.waitForSelector('code:text("kna1.KUNNR = vbrk.KUNRG")');
    const n = Number((await page.locator('h2:has-text("Confirmed joins")').innerText()).match(/\((\d+)\)/)[1]);
    if (n < 15) throw new Error('confirmed joins: ' + n);
    await page.waitForSelector('h2:has-text("Suggestions to check")');
    await page.screenshot({ path: `${OUT}/relationships.png`, fullPage: false });
  });

  await step('steward confirms one suggestion and rejects another', async () => {
    if (await page.locator('.item:has-text("vbap.MATNR = mara.MATNR")').count() === 0) await page.click('button:has-text("Show all")');
    const ok = item('vbap.MATNR = mara.MATNR');
    await ok.locator('button:text-is("Edit")').click(); await page.waitForSelector('.modal >> text=Edit join');
    await page.locator('.modal label.field', { hasText: 'Rows on each side' }).locator('select').selectOption('N:1');
    await page.locator('.modal').screenshot({ path: `${OUT}/relationship-edit.png` });
    await page.click('.modal footer .primary'); await page.waitForSelector('.toast:has-text("Saved")');
    await page.waitForSelector('h2:has-text("Confirmed joins") + .card code:text("vbap.MATNR = mara.MATNR")');
    if (await page.locator('.item:has-text("POSNR")').count() === 0) await page.click('button:has-text("Show all")');
    const bad = page.locator('.item', { hasText: 'POSNR' }).first();
    const txt = await bad.locator('code').innerText();
    await bad.locator('button:text-is("✗ Reject")').click(); await page.waitForSelector('.toast:has-text("Rejected")');
    await page.click('summary:has-text("Rejected")'); await page.waitForSelector(`details code:text("${txt}")`);
  });

  await step('steward adds a business entity', async () => {
    await page.click('button:text-is("＋ Add entity")'); await page.waitForSelector('.modal >> text=Add a business entity');
    await page.fill('.modal input[placeholder="e.g. Customer"]', 'Customer');
    await page.fill('.modal input[placeholder^="e.g. client"]', 'client, sold-to party, account');
    await page.locator('.modal select[aria-label="Table"]').selectOption('kna1');
    await page.locator('.modal select[aria-label="Key column"]').selectOption('KUNNR');
    await page.locator('.modal').screenshot({ path: `${OUT}/entity-form.png` });
    await page.click('.modal footer .primary'); await page.waitForSelector('.item:has-text("also called client, sold-to party, account")');
    await page.evaluate(() => document.querySelector('h2[style]:nth-of-type(1)') && [...document.querySelectorAll('h2')].find(x => x.textContent.startsWith('Confirmed joins')).scrollIntoView());
    await page.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove())); await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/relationships-confirmed.png` });
  });

  await step('the diagram shows tables, joins and the entity, and a click shows a table\'s joins', async () => {
    await page.click('button:text-is("◉ Diagram")'); await page.waitForSelector('svg.kg g.n');
    if (await page.locator('svg.kg line.e.sugg').count() !== 0) throw new Error('suggestions should be hidden by default');
    const n = await page.locator('svg.kg g.n').count(), confirmedLines = await page.locator('svg.kg line.e:not(.sugg):not(.ent)').count();
    if (n < 20 || confirmedLines < 17) throw new Error(`nodes ${n}, confirmed lines ${confirmedLines}`);
    if (await page.locator('svg.kg g.n.ent').count() !== 1) throw new Error('entity node missing');
    const box = await page.locator('svg.kg').boundingBox();
    const inside = await page.evaluate(() => [...document.querySelectorAll('svg.kg g.n')].every(g => { const r = g.getBoundingClientRect(), s = document.querySelector('svg.kg').getBoundingClientRect();
      return r.left >= s.left - 1 && r.right <= s.right + 1 && r.top >= s.top - 1 && r.bottom <= s.bottom + 1; }));
    if (!inside) throw new Error('some tables are drawn outside the diagram');
    await page.locator('svg.kg').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${OUT}/relationships-diagram.png` });
    await page.click('label.check:has-text("Show suggestions")'); await page.waitForSelector('svg.kg line.e.sugg');
    await page.click('label.check:has-text("Show suggestions")'); await page.waitForFunction(() => !document.querySelector('svg.kg line.e.sugg'));
    await page.locator('svg.kg g.n:has(text:text-is("vbrk"))').click();
    await page.waitForSelector('.card .item b:text-is("vbrk")');
    await page.waitForSelector('.card code:text("kna1.KUNNR = vbrk.KUNRG")');
    if (await page.locator('svg.kg text.elabel').count() < 2) throw new Error('join labels not shown for the selected table');
    if (await page.locator('svg.kg g.n.dim').count() === 0) throw new Error('unrelated tables not dimmed');
    await page.locator('svg.kg').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${OUT}/relationships-diagram-selected.png` });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, -400); await page.waitForTimeout(200);
    const vb = await page.getAttribute('svg.kg', 'viewBox'); if (vb.split(' ')[2] >= 1100) throw new Error('zoom did nothing: ' + vb);
  });

  await step('the join paths and the entity reach the AI model', async () => {
    await page.goto(B + '#/ask'); await page.waitForSelector('.ask-bar');
    await page.selectOption('.ask-bar select >> nth=0', String(sap.id));
    await page.fill('.composer textarea', 'Net sales by sales organisation in 2025'); await page.press('.composer textarea', 'Enter');
    await page.waitForSelector('.run .chart-box canvas', { timeout: 30000 });
    const reqs = await (await fetch('http://127.0.0.1:8765/requests')).json();
    const sys = reqs[reqs.length - 1].messages.find(m => m.role === 'system').content;
    if (!sys.includes('## Join paths') || !sys.includes('tvkot.VKORG = vbrk.VKORG')) throw new Error('join paths missing from the prompt');
    if (sys.includes('POSNR = ')) throw new Error('a rejected join reached the prompt');
    await page.fill('.composer textarea', 'How many invoices per client?'); await page.press('.composer textarea', 'Enter');
    await page.waitForFunction(() => document.querySelectorAll('.q').length === 2 && !document.querySelector('.spinner'), null, { timeout: 30000 });
    const r2 = await (await fetch('http://127.0.0.1:8765/requests')).json();
    const sys2 = r2[r2.length - 1].messages.find(m => m.role === 'system').content;
    if (!sys2.includes('Customer (also called: client, sold-to party, account): kna1 (key KUNNR)')) throw new Error('entity missing from the prompt');
  });
  console.log('console errors:', errors.length ? errors : 'none'); await browser.close();
})();
