const { chromium } = require('playwright');
const fs = require('fs');
const OUT = process.argv[2], MAIL = process.argv[3], B = 'http://localhost:8010/';
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage(); page.setDefaultTimeout(9000);
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('401')) errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
  const shot = (n, sel) => sel ? page.locator(sel).first().screenshot({ path: `${OUT}/${n}.png` }) : page.screenshot({ path: `${OUT}/${n}.png` });
  const step = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { console.log('FAIL', name, '-', e.message.split('\n')[0]); await page.screenshot({ path: `${OUT}/FAIL-${name.replace(/\W+/g, '_')}.png` }).catch(() => {}); } };
  const ask = async q => { const n = await page.locator('.run').count(); await page.fill('.composer textarea', q); await page.keyboard.press('Enter'); await page.waitForFunction(k => document.querySelectorAll('.run').length > k, n); await page.waitForTimeout(500); };
  const post = (path, body) => page.evaluate(async ([p, b]) => (await fetch(p, { method: 'POST', headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json(), [path, body]);
  const mails = () => fs.readFileSync(MAIL, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);

  await page.goto(B);
  await page.fill('input[type=email]', 'admin@example.com'); await page.fill('input[type=password]', 'Admin-Passw0rd!');
  await page.click('button[type=submit]'); await page.waitForSelector('.nav');
  await post('/api/admin/models', { name: 'Demo model', provider: 'openai_compatible', model_id: 'fake-1', base_url: 'http://127.0.0.1:8765/v1', is_default: true });
  await post('/api/admin/users', { email: 'priya@example.com', name: 'Priya Nair', role: 'steward' });
  await post('/api/admin/users', { email: 'tom@example.com', name: 'Tom Becker', role: 'analyst' });
  await post('/api/admin/users', { email: 'lena@example.com', name: 'Lena Okafor', role: 'analyst' });

  await step('email senders: add, verify, test', async () => {
    await page.goto(B + '#/admin/senders'); await page.waitForSelector('text=No real sending is configured yet');
    await page.click('text=＋ Add sender'); await page.waitForSelector('.modal');
    const host = await page.locator('.modal input[placeholder="smtp.gmail.com"]').inputValue(); if (host !== 'smtpout.secureserver.net') throw new Error('preset host ' + host);
    await page.fill('.modal input[placeholder^="e.g. Reports mailbox"]', 'Reports mailbox'); await page.fill('.modal input[placeholder^="e.g. AskData"]', 'AskData Reports');
    await page.fill('.modal input[type=email] >> nth=0', 'reports@example.com'); await page.locator('.modal input[type=email]').first().blur();
    await shot('sender-form', '.modal');
    await page.locator('.modal select').nth(1).selectOption('custom'); await page.fill('.modal input[placeholder="smtp.gmail.com"]', '127.0.0.1'); await page.fill('.modal input[type=number]', '2525');
    await page.fill('.modal input[placeholder^="usually the full"]', ''); await page.click('.modal footer .primary'); await page.waitForSelector('td:has-text("Reports mailbox")');
    await page.click('text=Verify'); await page.waitForSelector('.badge.good:has-text("verified")');
    await page.click('button:text-is("Send test")'); await page.fill('.modal input[type=text]', 'me@example.com, colleague@example.com'); await page.click('.modal footer .primary');
    await page.waitForSelector('.modal .banner.good:has-text("Test email sent")'); await shot('sender-test', '.modal'); await page.click('.modal footer >> text=Close');
    await page.waitForSelector('td:has-text("colleague@example.com")');
    const m = mails(); if (m.length !== 1 || m[0].to.length !== 2) throw new Error('mail sink: ' + JSON.stringify(m));
    await page.locator('.main').evaluate(e => e.scrollTo(0, 0)); await shot('senders');
  });
  await step('user groups', async () => {
    await page.goto(B + '#/admin/groups'); await page.click('text=＋ New group'); await page.fill('.modal input[placeholder^="e.g. Finance"]', 'Sales leadership');
    await page.locator('.modal label.check:has-text("Tom Becker")').click(); await page.locator('.modal label.check:has-text("Priya Nair")').click(); await shot('group-form', '.modal');
    await page.click('.modal footer .primary'); await page.waitForSelector('.item:has-text("Sales leadership") >> text=2 members'); await shot('groups');
  });
  await step('build report', async () => {
    await page.goto(B + '#/ask'); await page.waitForSelector('.composer textarea');
    await ask('revenue and orders by region'); await page.click('text=⬇ Export'); await page.click('text=＋ Add to a report…');
    await page.fill('.modal input', 'Weekly sales pack'); await page.click('text=Create new report'); await page.waitForSelector('.toast:has-text("Added to")');
    await ask('revenue by category'); await page.click('.run >> nth=1 >> text=⬇ Export'); await page.click('.pop:not(.hidden) >> text=＋ Add to a report…'); await page.click('.modal >> text=Add here'); await page.waitForSelector('.toast:has-text("Added to")');
    await ask('What is revenue by month?');
  });
  let rid;
  await step('designer: drag from palette, reorder, side by side', async () => {
    await page.goto(B + '#/reports'); await page.click('.report-card'); await page.waitForSelector('.paper .rep-result canvas'); rid = Number(page.url().split('/').pop());
    await page.click('text=✎ Edit'); await page.waitForSelector('.rep-designer .rep-comp');
    // drag a Heading from the palette onto the first card (upper half => before it)
    await page.dragAndDrop('.pal:has-text("Heading")', '.rep-comp >> nth=0', { targetPosition: { x: 200, y: 8 } });
    await page.waitForFunction(() => document.querySelectorAll('.rep-comp').length === 3);
    let kinds = await page.locator('.rep-comp .badge').allTextContents(); if (kinds[0] !== 'Heading') throw new Error('after palette drop: ' + kinds);
    await page.locator('.rep-comp').first().locator('input[type=text]').fill('Sales overview — {{date}}');
    // drag Text to the end zone
    await page.locator('.rep-dropzone').scrollIntoViewIfNeeded(); await page.dragAndDrop('.pal:has-text("Text")', '.rep-dropzone'); await page.waitForFunction(() => document.querySelectorAll('.rep-comp').length === 4);
    await page.locator('.rep-comp').last().locator('textarea').fill('{{summary:1}}');
    // move the text card above the results by dragging its grip onto card #2
    await page.locator('.main').evaluate(e => e.scrollTo(0, 150)); await page.waitForTimeout(200);
    await page.locator('.rep-comp').last().locator('.grip').hover(); await page.mouse.down();
    const box = await page.locator('.rep-comp').nth(1).boundingBox(); await page.mouse.move(box.x + 200, box.y + 10, { steps: 8 }); await page.mouse.move(box.x + 210, box.y + 12, { steps: 3 }); await page.mouse.up();
    await page.waitForTimeout(300); kinds = await page.locator('.rep-comp .badge').allTextContents();
    if (kinds.join('|') !== 'Heading|Text|Result from a chat|Result from a chat') throw new Error('after reorder: ' + kinds.join('|'));
    // two results side by side
    for (const i of [2, 3]) await page.locator('.rep-comp').nth(i).locator('.seg button:has-text("½")').click();
    const b2 = await page.locator('.rep-comp').nth(2).boundingBox(), b3 = await page.locator('.rep-comp').nth(3).boundingBox();
    if (Math.abs(b2.y - b3.y) > 3 || b3.x < b2.x + b2.width) throw new Error('not side by side in designer');
    // click-to-add from the palette, then choose a result in the picker
    await page.click('.pal:has-text("Result from a chat")'); await page.waitForSelector('.modal label.item'); await page.locator('.modal label.item:has-text("month")').click(); await page.click('text=Add selected');
    await page.waitForFunction(() => document.querySelectorAll('.rep-comp').length === 5);
    await page.locator('.rep-comp').nth(2).locator('summary').click(); await page.waitForSelector('.rep-comp .chart-controls');
    await page.locator('.main').evaluate(e => e.scrollTo(0, 230)); await page.waitForTimeout(500); await shot('report-designer');
    await page.click('text=Save report'); await page.waitForSelector('.paper .rep-result canvas'); await page.waitForTimeout(900);
    const r = await page.locator('.rep-result').evaluateAll(els => els.map(e => { const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width)]; }));
    if (r.length !== 3 || Math.abs(r[0][1] - r[1][1]) > 3 || r[1][0] <= r[0][0] + r[0][2] - 5 || r[2][2] < r[0][2] * 1.8) throw new Error('view layout: ' + JSON.stringify(r));
    await page.locator('.main').evaluate(e => e.scrollTo(0, 0)); await shot('report-view');
  });
  await step('pdf keeps the layout', async () => { const [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=⬇ PDF')]); await dl.saveAs(`${OUT}/report.pdf`); });
  await step('share with a group', async () => {
    await page.click('text=👥 Share'); await page.locator('.modal .item:has-text("Sales leadership") select').selectOption('view'); await shot('report-share', '.modal');
    await page.click('.modal footer .primary'); await page.waitForSelector('.toast:has-text("Sharing updated")');
  });
  await step('schedule to group + people + addresses, run now', async () => {
    const before = mails().length;
    await page.click('text=🕒 Schedule'); await page.waitForSelector('.modal .ticklist');
    await page.locator('.modal label.check >> nth=0').click();
    await page.locator('.modal .ticklist').nth(0).locator('label:has-text("Sales leadership")').click();
    await page.locator('.modal .ticklist').nth(1).locator('label:has-text("Lena Okafor")').click(); await page.locator('.modal .ticklist').nth(1).locator('label:has-text("Tom Becker")').click();
    await page.fill('.modal textarea', 'board@partner.com, cfo@partner.com');
    const total = await page.locator('.modal b').filter({ hasText: 'people' }).textContent(); if (!total.includes('2 people + 1 group(s) (2 members) + 2 other')) throw new Error('count: ' + total);
    await shot('report-schedule', '.modal');
    await page.locator('.modal label.check:has-text("Also email it now")').click(); await page.click('text=▶ Run now');
    await page.waitForSelector('.toast:has-text("emailed to 5 recipient")');
    const sent = mails().slice(before); const all = sent.flatMap(m => m.to).sort();
    if (all.join() !== ['board@partner.com', 'cfo@partner.com', 'lena@example.com', 'priya@example.com', 'tom@example.com'].join()) throw new Error('recipients: ' + all);
    if (sent.length !== 4 || sent.some(m => m.size < 20000)) throw new Error('messages: ' + JSON.stringify(sent));
    await page.click('text=Save schedule'); await page.waitForSelector('.toast:has-text("Scheduled for 5 recipient")');
    await page.goto(B + '#/admin/senders'); await page.waitForSelector('td:has-text("report: Weekly sales pack")'); await page.locator('h2:has-text("Email log")').scrollIntoViewIfNeeded(); await shot('email-log');
  });
  console.log('console errors:', errors.length ? errors : 'none');
  await browser.close();
})();
