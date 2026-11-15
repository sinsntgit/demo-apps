const { sleep } = require('../lib');
const state = require('../out/state.json');
exports.step = '02 · Ask in plain English';
exports.run = async r => {
  const run = () => r.page.locator('.run').last();
  const lastQ = () => r.page.locator('.q').last();
  await r.intro('Ask in plain English', 'Pick a data model, pick an AI model, type a question.', 'Chapter 2', 3000);

  await r.say('Choose a data model: **PostgreSQL, SQL Server, Oracle, MySQL, Snowflake, SingleStore** — or Excel and CSV folders.', async () => {
    for (const v of [state.fin, state.retail, state.pg]) { await r.select('.ask-bar select >> nth=0', String(v)); await sleep(900); }
  }, 6200);
  await r.say('Pick which **AI model** writes the SQL — Claude, OpenAI, or your own self-hosted model.', async () => {
    await r.select('.ask-bar select >> nth=1', String(state.deep)); await sleep(600);
    await r.select('.ask-bar select >> nth=1', String(state.fast));
  }, 4600);

  r.mark('hl-start');
  await r.say('Now just ask, the way you would ask a colleague.', async () => {
    await r.type('.composer textarea', 'What is revenue by month?', 48);
    await sleep(500);
  }, 2800);
  await r.say('The AI writes the SQL. Your server runs it **read-only** on your database.', async () => {
    await r.page.keyboard.press('Enter');
    await r.page.waitForSelector('.run .chart-box canvas', { timeout: 60000 });
    await sleep(500);
    await r.reveal(lastQ(), 'start', 900);
    await r.ring('.run pre.sql >> nth=-1');
  }, 5600);
  await r.ring(null, false);
  await r.say('A chart, a table and a plain-language summary — one click each.', async () => {
    await r.reveal(run().locator('.chart-controls'), 'start', 900);
    await r.click(run().locator('.sec-head button:text-is("Table")')); await sleep(1600);
    await r.click(run().locator('.sec-head button:text-is("Summary")')); await sleep(2600);
    await r.click(run().locator('.sec-head button:text-is("Chart")')); await sleep(900);
  }, 6200);
  await r.say('Change the chart, the axes or the split — and export to **PDF, Excel or CSV**.', async () => {
    await r.select(run().locator('.chart-controls select').first(), 'area'); await sleep(1100);
    await r.select(run().locator('.chart-controls select').first(), 'bar'); await sleep(900);
    await r.click(run().locator('text=⬇ Export')); await sleep(2400);
    await r.click('.ask-bar', { fx: 0.97, fy: 0.5 });
  }, 6200);
  await r.say('Suggested follow-ups keep the conversation going — context carries over.', async () => {
    await r.reveal(run().locator('.chips'), 'end', 900);
    await r.click(run().locator('.chip').first());
    await r.page.waitForFunction(() => { const rs = document.querySelectorAll('.run'); return rs.length >= 2 && rs[rs.length - 1].querySelector('.chart-box canvas'); }, null, { timeout: 60000 });
    await sleep(500); await r.reveal(lastQ(), 'start', 1000); await sleep(1400);
  }, 5600);
  r.mark('hl-end');
  await r.say('Every chat is saved and grouped by date. **Rename, search or reopen** any of them.', async () => {
    await r.hover('.conv >> nth=0', 500);
    await r.click('.conv >> nth=0 >> [title="Rename chat"]');
    await r.page.waitForSelector('.modal input');
    await r.click('.modal input'); await r.page.keyboard.press('Control+A');
    await r.page.keyboard.type('Revenue trend – warehouse', { delay: 45 }); await sleep(500);
    await r.click('.modal footer .primary'); await sleep(900);
    await r.hover('.convs input[type=search]', 400);
  }, 7000);
};
