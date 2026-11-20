const { sleep, vo } = require('../lib');
exports.step = '13 · Admin & governance';
exports.route = '/#/admin';
exports.run = async r => {
  await r.intro('Built for enterprise control', 'Users, groups, data access, AI models, email and a full audit trail.', 'Chapter 13', 3400, undefined, vo('Behind the scenes, administrators stay in control: users, groups, data access, A I models, email, and a full audit trail.'));
  await r.say('**Users**: roles, two-factor status and sign-in history, managed in one place.', async () => {
    await r.ring('.tbl-wrap'); await sleep(2600); await r.ring(null, false);
  }, 5000);
  await r.say('**User groups**: add people once, then use the group for access, sharing and email.', async () => {
    await r.tab('User groups', 900);
    await r.click('.item:has-text("North sales team") >> text=Edit'); await r.page.waitForSelector('.modal'); await sleep(2800);
    await r.page.keyboard.press('Escape'); await sleep(500);
  }, 6000);
  r.mark('hl-start');
  await r.say('**Data access**: switch a data model on or off, and open it only to the groups or people who need it.', async () => {
    await r.tab('Data access', 1100);
    await r.ring('.card:has-text("Finance workbook")'); await sleep(2600); await r.ring(null, false);
  }, 6400);
  await r.say('**Row-level filters**: the North sales team only ever sees North customers.', async () => {
    await r.reveal('.card:has-text("Retail sales")', 'start', 1100);
    await r.ring('.card:has-text("Retail sales") .tbl-wrap'); await sleep(2600); await r.ring(null, false);
  }, 5600);
  r.mark('hl-end');
  await r.say('**Email senders** with presets for Gmail, Microsoft 365, Zoho and Titan. Verify, then send a test.', async () => {
    await r.tab('Email senders', 1000);
    await r.click('button:text-is("Send test") >> nth=0'); await r.page.waitForSelector('.modal input');
    await r.click('.modal input'); await r.page.keyboard.press('Control+A'); await r.page.keyboard.type('you@acme.example', { delay: 45 }); await sleep(400);
    await r.click('.modal footer .primary'); await r.page.waitForSelector('.modal .banner.good', { timeout: 30000 }); await sleep(1800);
    await r.click('.modal footer >> text=Close'); await sleep(600);
  }, 7600);
  await r.say('Every email is logged — who received which report, and whether it was delivered.', async () => {
    await r.reveal('h2:has-text("Email log")', 'start', 1100); await r.ring('.tbl-wrap >> nth=-1'); await sleep(2400); await r.ring(null, false);
  }, 5600);
  await r.say('Connect **Anthropic Claude, OpenAI or a self-hosted model**. Keys are encrypted at rest.', async () => {
    await r.tab('AI models', 1000);
    await r.click('text=＋ Add model'); await r.page.waitForSelector('.modal select');
    for (const v of ['openai', 'openai_compatible', 'anthropic']) { await r.select('.modal select >> nth=0', v); await sleep(1100); }
    await r.page.keyboard.press('Escape'); await sleep(400);
  }, 6800);
  await r.say('Enforce **two-factor authentication**, session length, rate limits and row limits.', async () => {
    await r.tab('Settings', 1000);
    await r.ring('.card:has-text("Security")'); await sleep(2600); await r.ring(null, false);
  }, 5400);
  await r.say('A complete **audit trail**: sign-ins, questions, SQL edits, sharing and every admin change.', async () => {
    await r.tab('Audit log', 1000);
    await r.ring('.tbl-wrap'); await sleep(2800); await r.ring(null, false);
  }, 5600);
};
