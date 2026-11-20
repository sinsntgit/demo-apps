const { sleep, vo } = require('../lib');
exports.step = '16 · And more';
exports.route = '/#/history';
exports.run = async r => {
  await r.intro('And a few things you will use every day', 'History, built-in help and a dark theme.', 'Chapter 16', 3000, undefined, vo('And a few things you will use every day.'));
  await r.say('**History**: search everything you have asked, grouped by month.', async () => {
    await r.page.waitForSelector('tr.group'); await sleep(800);
    await r.type('.page input[type=search]', 'revenue', 70); await sleep(1500);
  }, 5000);
  await r.say('A built-in **manual with screenshots** — searchable, printable, for users and admins alike.', async () => {
    await r.nav('help', 1500);
    await r.type('.help input[type=search]', 'forecast', 70); await sleep(1800);
    await r.click('.help-toc a >> nth=0'); await sleep(1500);
  }, 6400);
  await r.say('Light or dark — your choice.', async () => {
    await r.nav('ask', 900);
    await r.click('button:has-text("Theme")'); await sleep(2000);
    await r.click('button:has-text("Theme")'); await sleep(800);
  }, 3800);
};
