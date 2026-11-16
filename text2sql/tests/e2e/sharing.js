// Shared chats (owner shares; a group member views with their own filters; another person adds a question)
// and the SAP sample data model. Usage: node tests/e2e/sharing.js <screenshot dir>
const { chromium } = require('playwright');
const OUT = process.argv[2], B = 'http://localhost:8010/';
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const newPage = async () => {
    const p = await (await browser.newContext({ viewport: { width: 1320, height: 860 } })).newPage(); p.setDefaultTimeout(12000);
    p.on('console', m => { if (m.type() === 'error' && !/40[13]/.test(m.text())) errors.push(m.text()); }); p.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
    return p;
  };
  const call = (p, method, path, body) => p.evaluate(async ([m, u, b]) => (await fetch(u, { method: m, headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json(), [method, path, body]);
  const step = async (page, name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { console.log('FAIL', name, '-', e.message.split('\n')[0]); await page.screenshot({ path: `${OUT}/FAIL-${name.replace(/\W+/g, '_')}.png` }); } };
  const signIn = async (p, email, pw, fresh) => {        // fresh: first sign-in with a temporary password
    await p.goto(B); await call(p, 'POST', '/api/auth/login', { email, password: pw });
    if (fresh) await call(p, 'POST', '/api/auth/change-password', { current: pw, new: 'Share-Passw0rd-1' });
    await p.goto(B + '#/ask'); await p.reload(); await p.waitForSelector('.nav');
  };

  const admin = await newPage();
  await signIn(admin, 'admin@example.com', 'Admin-Passw0rd!');
  await call(admin, 'POST', '/api/admin/models', { name: 'Demo model', provider: 'openai_compatible', model_id: 'fake-1', base_url: 'http://127.0.0.1:8765/v1', is_default: true });
  const conns = await call(admin, 'GET', '/api/connections');
  const retail = conns.find(c => c.name.includes('Retail')), sap = conns.find(c => c.name.includes('SAP'));
  const tom = await call(admin, 'POST', '/api/admin/users', { email: 'tom@example.com', name: 'Tom Becker', role: 'analyst' });
  const lena = await call(admin, 'POST', '/api/admin/users', { email: 'lena@example.com', name: 'Lena Okafor', role: 'analyst' });
  await call(admin, 'POST', '/api/admin/groups', { name: 'North sales team', description: 'Account managers in the North', user_ids: [tom.id] });
  await call(admin, 'POST', '/api/admin/filters', { connection_id: retail.id, table_name: 'customers', condition: "region = 'North'", scope: 'user', user_id: tom.id });

  await step(admin, 'SAP sample data model with training', async () => {
    if (!sap || sap.table_count < 30) throw new Error('SAP data model missing: ' + JSON.stringify(sap));
    await admin.goto(B + '#/training/' + sap.id); await admin.waitForSelector('.tabs');
    await admin.waitForSelector('text=Net sales by sales organisation in 2025');
    await admin.screenshot({ path: `${OUT}/sap-training.png` });
    await admin.click('.tabs >> text=Documentation'); await admin.waitForSelector('text=Debit / credit and signs in FI');
    await admin.click('.tabs >> text=Extra DDL'); await admin.waitForSelector('text=SAP field dictionary - Finance');
    await admin.screenshot({ path: `${OUT}/sap-dictionary.png` });
  });

  let convId;
  await step(admin, 'owner asks and shares the chat', async () => {
    await admin.goto(B + '#/ask'); await admin.waitForSelector('.ask-bar');
    await admin.selectOption('.ask-bar select >> nth=0', String(retail.id));
    await admin.fill('.composer textarea', 'revenue and orders by region'); await admin.press('.composer textarea', 'Enter');
    await admin.waitForSelector('.run .chart-box canvas');
    convId = Number(admin.url().split('/').pop());
    await admin.click('text=👥 Share chat'); await admin.waitForSelector('.modal >> text=User groups');
    const row = name => admin.locator('.modal .item', { hasText: name }).locator('select');
    await row('North sales team').selectOption('view'); await row('Lena Okafor').selectOption('edit');
    await admin.locator('.modal').screenshot({ path: `${OUT}/chat-share.png` });
    await admin.click('.modal footer .primary'); await admin.waitForSelector('text=Chat shared with 2 people or groups');
    await admin.waitForSelector('.conv.on b:has-text("👥")');
  });

  const tp = await newPage();
  await signIn(tp, 'tom@example.com', tom.temporary_password, true);
  await step(tp, 'group member sees it read-only with their own rows', async () => {
    await tp.waitForSelector('.conv-group:has-text("Shared with me")');
    await tp.click('.conv:has-text("revenue and orders by region")');
    await tp.waitForSelector('text=Shared by'); await tp.waitForSelector('text=view only');
    if (!await tp.locator('.composer textarea').isDisabled()) throw new Error('composer should be disabled');
    if (await tp.locator('text=✎ Edit SQL').count()) throw new Error('edit SQL shown to a viewer');
    await tp.waitForSelector('text=Asked by'); await tp.waitForSelector('.run .chart-box canvas');
    await tp.click('.run .btn.sm:text-is("Table")');
    const regions = await tp.locator('.run .tbl tbody tr td:first-child').allTextContents();
    if (regions.join() !== 'North') throw new Error('viewer saw regions ' + regions.join());
    await tp.screenshot({ path: `${OUT}/chat-shared-view.png` });
  });

  const lp = await newPage();
  await signIn(lp, 'lena@example.com', lena.temporary_password, true);
  await step(lp, 'editor adds a question to the shared chat', async () => {
    await lp.goto(B + `#/ask/${convId}`); await lp.waitForSelector('text=you can view it and add questions');
    await lp.fill('.composer textarea', 'revenue by category'); await lp.press('.composer textarea', 'Enter');
    await lp.waitForFunction(() => document.querySelectorAll('.q').length === 2 && !document.querySelector('.spinner'));
  });
  await step(admin, 'owner sees the added question', async () => {
    await admin.goto(B + '#/ask'); await admin.goto(B + `#/ask/${convId}`);
    await admin.waitForSelector('text=Asked by Lena Okafor');
    await admin.locator('.q').last().scrollIntoViewIfNeeded(); await admin.waitForTimeout(400);
    await admin.screenshot({ path: `${OUT}/chat-shared-owner.png` });
  });
  console.log('console errors:', errors.length ? errors : 'none'); await browser.close();
})();
