const { chromium } = require('playwright');
const B = 'http://localhost:8010/';
(async () => {
  const browser = await chromium.launch(); const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage(); page.setDefaultTimeout(8000);
  const nav = async p => (await p.locator('.nav a').allTextContents()).map(t => t.replace(/[^\w ]/g, '').trim()).join(' | ');
  const post = (p, path, body) => p.evaluate(async ([u, b]) => (await fetch(u, { method: 'POST', headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json(), [path, body]);
  const login = async (p, email, pw) => { await p.fill('input[type=email]', email); await p.fill('input[type=password]', pw); await p.click('button[type=submit]'); };
  await page.goto(B); await login(page, 'admin@example.com', 'Admin-Passw0rd!'); await page.waitForSelector('.nav');
  const tom = await post(page, '/api/admin/users', { email: 'tom@example.com', name: 'Tom', role: 'analyst' });
  const pri = await post(page, '/api/admin/users', { email: 'pri@example.com', name: 'Pri', role: 'steward' });
  console.log('admin      :', await nav(page));
  // 1. same tab: sign out, sign in as analyst
  await page.click('text=Sign out'); await page.waitForSelector('input[type=email]'); await login(page, 'tom@example.com', tom.temporary_password);
  await page.waitForSelector('input[autocomplete=new-password]'); await page.fill('input[autocomplete=current-password]', tom.temporary_password);
  await page.locator('input[autocomplete=new-password]').nth(0).fill('Tom-Passw0rd-1'); await page.locator('input[autocomplete=new-password]').nth(1).fill('Tom-Passw0rd-1'); await page.click('button[type=submit]');
  await page.waitForSelector('.nav'); console.log('analyst    :', await nav(page), '| url', page.url());
  await page.goto(B + '#/admin'); await page.waitForTimeout(600); console.log('analyst /#/admin ->', (await page.locator('.main').innerText()).slice(0, 60).replace(/\n/g, ' '));
  // 2. two tabs, same browser: admin in tab A, then analyst signs in in tab B
  await page.click('text=Sign out'); await page.waitForSelector('input[type=email]'); await login(page, 'admin@example.com', 'Admin-Passw0rd!'); await page.waitForSelector('.nav');
  const tabB = await ctx.newPage(); await tabB.goto(B); await tabB.waitForSelector('.nav'); await tabB.click('text=Sign out'); await tabB.waitForSelector('input[type=email]');
  await login(tabB, 'tom@example.com', 'Tom-Passw0rd-1'); await tabB.waitForSelector('.nav');
  console.log('tab B (analyst):', await nav(tabB));
  console.log('tab A (was admin, now analyst cookie), before any click:', await nav(page));
  await page.click('.nav a:has-text("History")'); await page.waitForTimeout(700);
  console.log('tab A after navigating:', await nav(page));
  // 3. role changed by an admin while the person is signed in
  const adminCtx = await browser.newContext(); const ap = await adminCtx.newPage(); await ap.goto(B); await login(ap, 'admin@example.com', 'Admin-Passw0rd!'); await ap.waitForSelector('.nav');
  const users = await ap.evaluate(async () => (await fetch('/api/admin/users')).json()); const t = users.find(u => u.email === 'tom@example.com');
  await ap.evaluate(async id => fetch('/api/admin/users/' + id, { method: 'PUT', headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'tom@example.com', name: 'Tom', role: 'steward', is_active: true }) }), t.id);
  await tabB.click('.nav a:has-text("History")'); await tabB.waitForTimeout(700); console.log('tab B after promotion to steward + click:', await nav(tabB));
  await ap.evaluate(async id => fetch('/api/admin/users/' + id, { method: 'PUT', headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'tom@example.com', name: 'Tom', role: 'analyst', is_active: true }) }), t.id);
  await tabB.click('.nav a:has-text("Training")'); await tabB.waitForTimeout(900); console.log('tab B after demotion + clicking Training:', await nav(tabB), '|', (await tabB.locator('.main').innerText()).slice(0, 30).replace(/\n/g, ' '));
  await browser.close();
})();
