const { sleep, vo } = require('../lib');
exports.step = '15 · Quality & usage dashboard';
exports.route = '/#/dashboard';
exports.run = async r => {
  await r.intro('Know how well it works', 'Accuracy, speed, spend and every single query.', 'Chapter 15', 3200, undefined, vo('Finally, know how well it works: accuracy, speed, spend, and every single query.'));
  await r.say('Track **accuracy** from real user verdicts, success rate, speed and spend.', async () => {
    await r.ring('.kpis'); await sleep(2800); await r.ring(null, false);
  }, 5000);
  await r.say('Even **rephrasing** is tracked: how often it is used, what it costs, and whether it helps questions succeed first time.', async () => {
    await r.ring('.kpi:has-text("Rephrased")'); await sleep(2400); await r.ring(null, false);
  }, 5600);
  await r.say('Compare **AI models** side by side, per data model and per user.', async () => {
    await r.reveal('.dash-grid >> nth=0', 'start', 1200); await sleep(1400);
    await r.reveal('h2:has-text("By AI model")', 'start', 1200); await r.ring('h2:has-text("By AI model") >> xpath=..'); await sleep(1800); await r.ring(null, false);
  }, 5400);
  await r.say('Drill into any query: the SQL, the answer, and **exactly what was sent to the AI**.', async () => {
    await r.reveal('h2:has-text("Query log")', 'start', 1200);
    await r.click('tr.click:has(.badge.good) >> nth=0'); await r.page.waitForSelector('.modal .run'); await sleep(900);
    await r.ring('.modal :text("Sent to the model")'); await sleep(3200); await r.ring(null, false);
    await r.page.keyboard.press('Escape'); await sleep(500);
  }, 8200);
};
