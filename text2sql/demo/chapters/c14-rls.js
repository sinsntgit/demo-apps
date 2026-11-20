const { sleep, vo } = require('../lib');
const state = require('../out/state.json');
exports.storage = null;
exports.route = '/';
exports.step = '14 · Row-level security';
exports.run = async r => {
  const lastQ = () => r.page.locator('.q').last();
  await r.intro('Row-level security', 'The same question. Different people. Different rows.', 'Chapter 14', 3400, undefined, vo('Row-level security. The same question, asked by different people, returns different rows.'));
  await r.say('Tom is an analyst on the **North sales team**.', async () => {
    await r.type('input[type=email]', 'tom.becker@acme.example', 45);
    await r.type('input[type=password]', state.user_password, 45);
    await r.click('button[type=submit]'); await r.page.waitForSelector('.nav');
  }, 3400);
  await r.say('He only sees the data models he was given — the Finance workbook is not even listed.', async () => {
    await r.ring('.ask-bar select >> nth=0'); await sleep(1800); await r.ring(null, false);
    await r.select('.ask-bar select >> nth=0', String(state.retail)); await sleep(600);
  }, 5200);
  r.mark('hl-start');
  await r.say('He asks about revenue by region…', async () => {
    await r.type('.composer textarea', 'How does revenue split by region?', 45); await r.page.keyboard.press('Enter');
    await r.page.waitForSelector('.run .badge.warn', { timeout: 60000 }); await sleep(500); await r.click('.run .btn.sm:text-is("Table")'); await sleep(600); await r.reveal(lastQ(), 'start', 900);
  }, 3600);
  await r.say('…and gets **only North** — the 🔒 badge shows his filters were applied.', async () => {
    await r.ring('.run .badge.warn'); await sleep(2600); await r.ring(null, false);
  }, 5000);
  await r.say('Even hand-written SQL is filtered. The server rewrites every query before it runs.', async () => {
    await r.click('text=✎ Edit SQL'); await r.click('textarea.sql-edit');
    await r.page.keyboard.press('Control+A'); await r.page.keyboard.type('SELECT DISTINCT region FROM customers', { delay: 55 }); await sleep(500);
    await r.click('text=▶ Run edited SQL'); await r.page.waitForSelector('text=edited by you'); await sleep(600);
    await r.click('.run .btn.sm:text-is("Table")'); await sleep(600); await r.reveal('.run .tbl', 'center', 900); await sleep(1800);
  }, 7600);
  r.mark('hl-end');
  await r.say('The same rules apply to **reports and emailed PDFs** — nobody can see rows they should not.', async () => { await sleep(500); }, 4800);
};
