const { sleep } = require('../lib');
const state = require('../out/state.json');
exports.step = '03 · Trust, correct, teach';
exports.run = async r => {
  const lastQ = () => r.page.locator('.q').last();
  await r.intro('Trust, but verify', 'See the SQL. Fix it. Teach the system.', 'Chapter 3', 3000, async () => {
    await r.page.locator('.ask-bar select').first().selectOption(String(state.retail)); });

  await r.say('Prefer to check first? Tick **Review SQL before running**.', async () => {
    await r.click('label:has-text("Review SQL before running")');
  }, 3200);
  await r.say('Nothing touches your database until you approve it.', async () => {
    await r.type('.composer textarea', 'What is revenue by category?', 45);
    await r.page.keyboard.press('Enter');
    await r.page.waitForSelector('text=▶ Run this SQL', { timeout: 60000 });
    await r.reveal(lastQ(), 'start', 800);
    await r.ring('text=▶ Run this SQL');
  }, 4200);
  await r.ring(null, false);
  r.mark('hl-start');
  await r.say('Something off? **Edit the SQL** yourself. Only read-only SELECT statements can ever run.', async () => {
    await r.click('text=✎ Edit SQL');
    await r.click('textarea.sql-edit');
    await r.page.keyboard.press('Control+End');
    await r.page.keyboard.type('\nLIMIT 3', { delay: 80 });
    await sleep(600);
  }, 5600);
  await r.say('Run it — and when it is right, **teach the system** with one click.', async () => {
    await r.click('text=▶ Run edited SQL');
    await r.page.waitForSelector('.run .chart-box canvas', { timeout: 40000 });
    await sleep(900);
    await r.ring('text=save my correction'); await sleep(1600);
    await r.click('text=save my correction');
    await r.page.waitForSelector('.toast'); await sleep(2000);
  }, 6800);
  await r.ring(null, false);
  r.mark('hl-end');
  await r.say('The correction becomes a verified example for **this data model** — used from the very next question.', async () => { await sleep(500); }, 4400);

  await r.say('Even if the AI writes something dangerous, the **read-only guard** blocks it.', async () => {
    await r.click('label:has-text("Review SQL before running")');
    await r.click('text=＋ New chat');
    await r.type('.composer textarea', 'Delete all the orders', 45);
    await r.page.keyboard.press('Enter');
    await r.page.waitForSelector('.run .banner.bad', { timeout: 60000 });
    await r.reveal(lastQ(), 'start', 800);
    await r.ring('.run .banner.bad'); await sleep(2200);
  }, 6400);
  await r.ring(null, false);
  await r.say('The AI sees your question and the table structure — **never your query results**.', async () => {
    await r.ring('.privacy-note'); await sleep(3400);
  }, 4800);
  await r.ring(null, false);
};
