// Multi-company: the platform administrator adds a company and shares a model with it; the company's
// administrator sees only their company, uploads a logo and uses the shared model.
// Usage: node tests/e2e/tenancy.js <screenshot dir>
const path = require('path');
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
  const call = (p, method, url, body) => p.evaluate(async ([m, u, b]) => (await fetch(u, { method: m, headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json(), [method, url, body]);
  const step = async (page, name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { console.log('FAIL', name, '-', e.message.split('\n')[0]); await page.screenshot({ path: `${OUT}/FAIL-${name.replace(/\W+/g, '_')}.png` }); } };
  const signIn = async (p, email, pw, fresh) => {
    await p.goto(B); await call(p, 'POST', '/api/auth/login', { email, password: pw });
    if (fresh) await call(p, 'POST', '/api/auth/change-password', { current: pw, new: 'Company-Passw0rd-1' });
    await p.goto(B + '#/ask'); await p.reload(); await p.waitForSelector('.nav');
  };
  const admin = await newPage();
  await signIn(admin, 'admin@example.com', 'Admin-Passw0rd!');
  await call(admin, 'POST', '/api/admin/models', { name: 'Our own model', provider: 'openai_compatible', model_id: 'fake-1', base_url: 'http://127.0.0.1:8765/v1', is_default: true });
  await call(admin, 'POST', '/api/admin/models', { name: 'Claude (shared)', provider: 'openai_compatible', model_id: 'fake-1', base_url: 'http://127.0.0.1:8765/v1', scope: 'platform', price_in: 3, price_out: 15 });
  let tempPw;

  await step(admin, 'platform admin adds a company', async () => {
    await admin.goto(B + '#/admin/companies'); await admin.reload(); await admin.waitForSelector('text=＋ Add company');
    await admin.click('text=＋ Add company');
    await admin.fill('.modal label.field:has-text("Company name") input', 'Northwind Traders');
    await admin.fill('.modal input[type=email]', 'maria@northwind.example'); await admin.fill('.modal label.field:has-text("Name") >> nth=1 >> input', 'Maria Anders');
    await admin.locator('.modal').screenshot({ path: `${OUT}/company-add.png` });
    await admin.click('.modal footer .primary'); await admin.waitForSelector('text=Temporary password');
    tempPw = (await admin.locator('.modal .codes').innerText()).trim(); await admin.keyboard.press('Escape');
    await admin.waitForSelector('td:has-text("Northwind Traders")');
    if (!(await admin.locator('.nav .company').innerText()).includes('Default company')) throw new Error('own company not shown');
    await admin.screenshot({ path: `${OUT}/companies.png` });
  });

  await step(admin, 'platform admin shares a model with the company', async () => {
    await admin.goto(B + '#/admin/models'); await admin.waitForSelector('text=Platform models — shared with companies');
    const row = admin.locator('.item', { hasText: 'Claude (shared)' }).last();
    await row.locator('button:text-is("Companies…")').click(); await admin.waitForSelector('.modal >> text=Which companies may use');
    await admin.locator('.modal .item', { hasText: 'Northwind Traders' }).locator('input').check();
    await admin.locator('.modal').screenshot({ path: `${OUT}/model-sharing.png` });
    await admin.click('.modal footer .primary'); await admin.waitForSelector('text=Sharing saved');
    await row.locator('.badge:has-text("Default company, Northwind Traders")').waitFor();
  });

  const nw = await newPage();
  await signIn(nw, 'maria@northwind.example', tempPw, true);
  await step(nw, 'company admin sees only their company', async () => {
    if (!(await nw.locator('.nav .company').innerText()).includes('Northwind Traders')) throw new Error('company not in menu');
    await nw.goto(B + '#/admin'); await nw.waitForSelector('table.tbl');
    if (await nw.locator('.tabs >> text=Companies').count()) throw new Error('Companies tab shown to a company admin');
    const emails = await nw.locator('table.tbl tbody .small.dim').allTextContents();
    if (emails.join() !== 'maria@northwind.example') throw new Error('users: ' + emails);
    await nw.goto(B + '#/admin/models'); await nw.waitForSelector('text=Shared with your company by the platform');
    if (await nw.locator('text=Our own model').count()) throw new Error('another company\'s model is visible');
    if (await nw.locator('text=Platform models').count()) throw new Error('platform section visible');
    await nw.screenshot({ path: `${OUT}/models-company.png` });
  });
  await step(nw, 'company admin uploads a logo', async () => {
    await nw.goto(B + '#/admin/settings'); await nw.waitForSelector('text=⬆ Upload logo');
    await nw.locator('input[type=file][accept^="image"]').setInputFiles(path.join(__dirname, 'fixtures', 'northwind-logo.png'));
    await nw.waitForSelector('.nav .company img');
    await nw.waitForFunction(() => document.querySelector('.nav .company img').naturalWidth > 0);
    await nw.goto(B + '#/admin/settings'); await nw.waitForSelector('.logo-box img');
    await nw.locator('.card', { hasText: 'Upload logo' }).screenshot({ path: `${OUT}/company-logo.png` });
  });
  await step(nw, 'company uses the shared model on its own data', async () => {
    await nw.goto(B + '#/ask'); await nw.waitForSelector('.ask-bar');
    const models = await nw.locator('.ask-bar select >> nth=1 >> option').allTextContents();
    if (models.join() !== 'Claude (shared)') throw new Error('models: ' + models);
    const conns = await nw.locator('.ask-bar select >> nth=0 >> option').allTextContents();
    if (conns.length !== 4 || !conns.every(c => c.startsWith('Sample:'))) throw new Error('data models: ' + conns);
    await nw.selectOption('.ask-bar select >> nth=0', { index: conns.findIndex(c => c.includes('Retail')) });
    await nw.fill('.composer textarea', 'revenue by category'); await nw.press('.composer textarea', 'Enter');
    await nw.waitForSelector('.run .chart-box canvas');
    await nw.screenshot({ path: `${OUT}/company-ask.png` });
  });
  await step(admin, 'platform admin uploads a company PowerPoint template', async () => {
    await admin.goto(B + '#/admin/companies'); await admin.reload(); await admin.waitForSelector('td:has-text("Northwind Traders")');
    await admin.locator('tr', { hasText: 'Northwind Traders' }).locator('button:text-is("Edit")').click();
    await admin.locator('.modal label.field', { hasText: 'PowerPoint template' }).locator('input[type=file]').setInputFiles(path.join(__dirname, 'fixtures', 'corporate-template.potx'));
    await admin.locator('.modal').screenshot({ path: `${OUT}/company-template.png` });
    await admin.click('.modal footer .primary'); await admin.waitForSelector('.toast:has-text("Saved")');
    await admin.waitForSelector('tr:has-text("Northwind Traders") >> text=PowerPoint template');
  });
  await step(admin, 'platform admin sees the usage, not the data', async () => {
    await admin.goto(B + '#/admin/companies'); await admin.reload(); await admin.waitForSelector('td:has-text("Northwind Traders")');
    const row = await admin.locator('tr', { hasText: 'Northwind Traders' }).innerText();
    if (!row.includes('logo') || !/\t1\t/.test(row.replace(/\n/g, '\t'))) throw new Error('row: ' + row.replace(/\n/g, ' | '));
    await admin.screenshot({ path: `${OUT}/companies.png` });
  });
  let peterPw;
  await step(admin, 'platform admin adds a user straight into a company', async () => {
    await admin.locator('tr', { hasText: 'Northwind Traders' }).locator('button:text-is("＋ User")').click();
    const m = admin.locator('.modal').last(); await m.locator('text=Add a user to Northwind Traders').waitFor();
    await m.locator('label.field:has-text("Email") input').fill('peter@northwind.example');
    await m.locator('label.field:has-text("Name") input').fill('Peter Franken');
    await m.locator('label.field:has-text("What answers show") select').selectOption('results');
    await m.screenshot({ path: `${OUT}/company-add-user.png` });
    await m.locator('footer .primary').click(); await admin.waitForSelector('text=Temporary password');
    peterPw = (await admin.locator('.modal .codes').innerText()).trim(); await admin.keyboard.press('Escape');
    const people = await call(admin, 'GET', '/api/admin/companies');
    if (people.find(c => c.name === 'Northwind Traders').users !== 2) throw new Error('not added');
  });
  const pe = await newPage();
  await signIn(pe, 'peter@northwind.example', peterPw, true);
  await call(pe, 'POST', '/api/reports', { title: 'Peter’s weekly pack', components: [] });
  await step(admin, 'platform admin moves a user to another company', async () => {
    await admin.goto(B + '#/admin/companies'); await admin.reload(); await admin.waitForSelector('td:has-text("Northwind Traders")');
    await admin.locator('tr', { hasText: 'Northwind Traders' }).locator('button:text-is("People…")').click();
    const list = admin.locator('.modal').last(); await list.locator('td:has-text("peter@northwind.example")').waitFor();
    await list.screenshot({ path: `${OUT}/company-people.png` });
    await list.locator('tr', { hasText: 'peter@northwind.example' }).locator('button:text-is("Move…")').click();
    const m = admin.locator('.modal').last(); await m.locator('text=Move Peter Franken to another company').waitFor();
    if ((await m.locator('label.field:has-text("Move to") select option').allTextContents()).join() !== 'Default company') throw new Error('targets');
    const heir = await m.locator('label.field:has-text("takes over") select').innerText();
    if (!heir.includes('maria@northwind.example')) throw new Error('heir: ' + heir);
    await m.screenshot({ path: `${OUT}/company-move.png` });
    await m.locator('footer .primary').click(); await admin.waitForSelector('.toast:has-text("moved")');
    await list.locator('td:has-text("peter@northwind.example")').waitFor({ state: 'detached' });
    const toast = await admin.locator('.toast').last().innerText();
    if (!toast.includes('maria@northwind.example')) throw new Error('toast: ' + toast);
  });
  await step(pe, 'the moved user is signed out and lands in the new company', async () => {
    const me = await pe.evaluate(async () => (await fetch('/api/auth/me')).status);
    if (me !== 401) throw new Error('still signed in: ' + me);
    await signIn(pe, 'peter@northwind.example', 'Company-Passw0rd-1');
    if (!(await pe.locator('.nav .company').innerText()).includes('Default company')) throw new Error('company not in menu');
    const reps = await call(pe, 'GET', '/api/reports');
    if (reps.some(r => r.title.startsWith('Peter'))) throw new Error('old report still visible');
    const mreps = await call(nw, 'GET', '/api/reports');
    const kept = mreps.find(r => r.title.startsWith('Peter'));
    if (!kept) throw new Error('report not handed over to Maria');
  });
  console.log('console errors:', errors.length ? errors : 'none'); await browser.close();
})();
