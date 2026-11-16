// "Results only" users and the reported-problem loop: user reports -> steward fixes in the review queue -> user sees it.
// Usage: node tests/e2e/resultsonly.js <screenshot dir>
const { chromium } = require('playwright');
const OUT = process.argv[2], B = 'http://localhost:8010/';
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const newPage = async () => {
    const p = await (await browser.newContext({ viewport: { width: 1320, height: 860 } })).newPage(); p.setDefaultTimeout(12000);
    p.on('console', m => { if (m.type() === 'error' && !/40[013]/.test(m.text())) errors.push(m.text()); }); p.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
    return p;
  };
  const call = (p, method, path, body) => p.evaluate(async ([m, u, b]) => (await fetch(u, { method: m, headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json(), [method, path, body]);
  const step = async (page, name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { console.log('FAIL', name, '-', e.message.split('\n')[0]); await page.screenshot({ path: `${OUT}/FAIL-${name.replace(/\W+/g, '_')}.png` }); } };
  const signIn = async (p, email, pw, fresh) => {
    await p.goto(B); await call(p, 'POST', '/api/auth/login', { email, password: pw });
    if (fresh) await call(p, 'POST', '/api/auth/change-password', { current: pw, new: 'Results-Passw0rd-1' });
    await p.goto(B + '#/ask'); await p.reload(); await p.waitForSelector('.nav');
  };

  const admin = await newPage();
  await signIn(admin, 'admin@example.com', 'Admin-Passw0rd!');
  await call(admin, 'POST', '/api/admin/models', { name: 'Demo model', provider: 'openai_compatible', model_id: 'fake-1', base_url: 'http://127.0.0.1:8765/v1', is_default: true });
  const retail = (await call(admin, 'GET', '/api/connections')).find(c => c.name.includes('Retail'));
  let bea;
  await step(admin, 'admin sets a user to results only', async () => {
    await admin.goto(B + '#/admin'); await admin.waitForSelector('text=＋ Add user'); await admin.click('text=＋ Add user');
    await admin.fill('.modal input[type=email]', 'bea@example.com'); await admin.fill('.modal input[type=text]', 'Bea Business');
    const view = admin.locator('.modal label.field', { hasText: 'What answers show' }).locator('select');
    await view.selectOption('results');
    await admin.locator('.modal').screenshot({ path: `${OUT}/user-results-only.png` });
    const roleSel = admin.locator('.modal label.field', { hasText: 'Role' }).locator('select');
    await roleSel.selectOption('steward'); if (!await view.isDisabled()) throw new Error('should be disabled for stewards');
    await roleSel.selectOption('analyst'); await view.selectOption('results');
    await admin.click('.modal footer .primary'); await admin.waitForSelector('text=Temporary password');
    const pw = (await admin.locator('.modal .codes').innerText()).trim(); await admin.keyboard.press('Escape');
    await admin.waitForSelector('td:has-text("results only")');
    bea = pw;
  });

  const bp = await newPage();
  await signIn(bp, 'bea@example.com', bea, true);
  await step(bp, 'results-only user sees no SQL', async () => {
    if (await bp.locator('text=Review SQL before running').count()) throw new Error('review option shown');
    await bp.selectOption('.ask-bar select >> nth=0', String(retail.id));
    await bp.fill('.composer textarea', 'revenue by category'); await bp.press('.composer textarea', 'Enter');
    await bp.waitForSelector('.run .chart-box canvas'); await bp.waitForSelector('text=How this was answered');
    for (const t of ['✎ Edit SQL', '✎ Fix it', 'Copy']) if (await bp.locator(`.run button:text-is("${t}")`).count()) throw new Error(t + ' shown');
    if (await bp.locator('.run pre.sql').count()) throw new Error('SQL shown');
    await bp.waitForSelector('text=Are these results correct?');
    await bp.screenshot({ path: `${OUT}/results-only-answer.png` });
  });
  await step(bp, 'user reports what is wrong and why', async () => {
    await bp.click('button:text-is("✗ No, something is wrong")'); await bp.waitForSelector('.modal >> text=Report an incorrect answer');
    await bp.click('.modal footer .danger'); await bp.waitForSelector('text=Choose what is incorrect');         // required
    await bp.locator('.modal select').selectOption('wrong_numbers');
    await bp.fill('.modal textarea', 'Accessories look far too high — I think returns are counted as sales.');
    await bp.locator('.modal').screenshot({ path: `${OUT}/report-incorrect.png` });
    await bp.click('.modal footer .danger'); await bp.waitForSelector('text=waiting for a data steward');
  });

  await step(admin, 'steward fixes it from the review queue', async () => {
    await admin.goto(B + '#/training/' + retail.id); await admin.reload(); await admin.waitForSelector('text=Reported problems (1)');
    await admin.waitForSelector('.issue >> text=Accessories look far too high');
    await admin.screenshot({ path: `${OUT}/review-reported.png` });
    await admin.click('.issue button:text-is("✎ Fix the SQL")'); await admin.waitForSelector('.modal >> text=Corrected SQL');
    await admin.click('.modal button:text-is("▶ Test")'); await admin.waitForSelector('.modal >> text=5 row(s)');
    await admin.fill('.modal input[placeholder^="Optional"]', 'Fixed: returns are now excluded from revenue.');
    await admin.locator('.modal').screenshot({ path: `${OUT}/review-fix.png` });
    await admin.click('.modal footer .primary'); await admin.waitForSelector('text=Saved to training');
    await admin.waitForSelector('text=Nothing waiting for review');
  });

  await step(bp, 'user sees the outcome', async () => {
    await bp.reload(); await bp.waitForSelector('text=Corrected by a data steward'); await bp.waitForSelector('text=returns are now excluded');
  });
  console.log('console errors:', errors.length ? errors : 'none'); await browser.close();
})();
