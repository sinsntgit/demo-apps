const { sleep, vo } = require('../lib');
const state = require('../out/state.json');
exports.step = '03 · Rephrase';
exports.run = async r => {
  const lastQ = () => r.page.locator('.q').last();
  await r.intro('Say it badly. Ask it well.', 'One click turns a rough question into a clear one.', 'Chapter 3', 3000, async () => {
    await r.page.locator('.ask-bar select').first().selectOption(String(state.retail)); },
    vo('Not everyone words a question well. The Rephrase button turns a rough question into a clear, complete one, before anything is sent.'));
  r.mark('hl-start');
  await r.say('Type it the way you would text a colleague, abbreviations and all.', async () => {
    await r.type('.composer textarea', 'rev by cat pls', 60); await sleep(500);
  }, 3400);
  await r.say('Press **Rephrase**. A small, inexpensive AI model suggests a clearer wording.', async () => {
    await r.click('.composer button:text-is("✨ Rephrase")');
    await r.page.waitForSelector('.rephrase .card >> text=Suggested wording', { timeout: 60000 }); await sleep(600);
    await r.ring('.rephrase .card');
  }, 5200);
  await r.say('It also finds **verified questions** your team has already confirmed — matched locally, for free.', async () => {
    await r.ring('.rephrase .chip >> nth=0'); await sleep(2400);
  }, 5400);
  await r.ring(null, false);
  await r.say('Use the suggestion and ask: fewer misunderstandings, fewer retries, a lower AI bill.', async () => {
    await r.click('.rephrase button:text-is("Use and ask")');
    await r.page.waitForSelector('.run .chart-box canvas', { timeout: 60000 }); await sleep(600);
    await r.reveal(lastQ(), 'start', 1000); await sleep(800);
  }, 6200);
  r.mark('hl-end');
  await r.say('You can rephrase a question you already asked, too — and keep your own wording if you prefer.', async () => {
    await r.hover(lastQ(), 700);
    await r.click(lastQ().locator('.q-re')); await r.page.waitForSelector('.rephrase .card >> text=Suggested wording', { timeout: 60000 }); await sleep(1800);
    await r.click('.rephrase button:text-is("Keep mine")'); await sleep(900);
  }, 7000);
  await r.say('Administrators choose which model does the rephrasing — usually a cheaper one.', async () => {
    await r.nav('admin', 1000); await r.tab('Settings', 1000);
    await r.ring('.card:has-text("Rephrasing questions")'); await sleep(2600); await r.ring(null, false);
  }, 6200);
};
