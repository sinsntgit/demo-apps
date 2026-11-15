const { sleep } = require('../lib');
const state = require('../out/state.json');
exports.step = '04 · Predict & forecast';
exports.run = async r => {
  const run = () => r.page.locator('.run').last();
  const lastQ = () => r.page.locator('.q').last();
  const ready = async () => { await r.page.waitForSelector('.run >> text=rows analysed on the server', { timeout: 90000 }); await r.page.waitForSelector('.run canvas', { timeout: 30000 }); await sleep(1100); };
  const ask = async q => { await r.type('.composer textarea', q, 45); await sleep(300); await r.page.keyboard.press('Enter'); };

  await r.intro('Go beyond “what happened”', 'Forecast, segment and predict — with the maths shown.', 'Chapter 4', 3200, async () => {
    await r.page.locator('.ask-bar select').first().selectOption(String(state.retail)); });
  await r.say('Tick **Use predictive capability** to forecast, predict, segment and find anomalies.', async () => {
    await r.click('label:has-text("Use predictive capability")');
    await r.ring('label:has-text("Use predictive capability")'); await sleep(1300); await r.ring(null, false);
  }, 4800);

  r.mark('hl-start');
  await r.say('Ask for a forecast, in plain English.', async () => { await ask('Forecast monthly revenue for the next 6 months'); await ready(); await r.reveal(lastQ(), 'start', 1000); }, 3000);
  await r.say('A statistical model runs **on your server**. The AI only chooses the method — it never sees the data.', async () => {
    await r.ring(run().locator('.kpis').first()); await sleep(1800);
  }, 5600);
  await r.say('Accuracy is **tested on recent history** the model has not seen — against a naive guess.', async () => {
    await r.ring(run().locator('.kpi:has-text("vs naive guess")').first()); await sleep(900);
  }, 4800);
  await r.ring(null, false);
  await r.say('The forecast, with a likely range that widens the further ahead it looks.', async () => {
    await r.reveal(run().locator('.chart-box').first(), 'center', 1100);
  }, 4200);
  await r.say('**Show or hide** any part: explanation, charts, results, statistics, code.', async () => {
    await r.reveal(run().locator('label.check:has-text("Statistics")'), 'center', 700);
    await r.click(run().locator('label.check:has-text("Statistics")')); await sleep(900);
    await r.click(run().locator('label.check:has-text("Charts")')); await sleep(1000);
    await r.click(run().locator('label.check:has-text("Charts")')); await sleep(700);
    await r.click(run().locator('label.check:has-text("Statistics")')); await sleep(600);
  }, 6200);
  r.mark('hl-end');
  await r.say('And the **exact Python that ran** — feature engineering and model code included.', async () => {
    await r.reveal(run().locator('pre.code-py'), 'center', 1000);
    await r.page.evaluate(() => { const p = [...document.querySelectorAll('pre.code-py')].pop(); p.scrollTo({ top: 360, behavior: 'smooth' }); });
    await sleep(1800);
    await r.page.evaluate(() => { const p = [...document.querySelectorAll('pre.code-py')].pop(); p.scrollTo({ top: 900, behavior: 'smooth' }); });
    await sleep(1500);
  }, 6800);
  await r.say('Change the horizon and it re-runs on fresh data.', async () => {
    await r.reveal(run().locator('input[aria-label="Periods ahead"]'), 'center', 900);
    await r.click(run().locator('input[aria-label="Periods ahead"]'));
    await r.page.keyboard.press('Control+A'); await r.page.keyboard.type('9', { delay: 120 }); await sleep(300);
    await r.click(run().locator('button:text-is("Update")'));
    await r.page.waitForSelector('.run >> text=Next 9 months'); await sleep(1500);
  }, 5000);

  await r.say('**Segmentation**: groups of similar customers, found automatically.', async () => {
    await r.click('text=＋ New chat'); await ask('Segment our customers by buying behaviour'); await ready(); await r.reveal(run().locator('.chart-box').first(), 'center', 1200);
  }, 4800);
  await r.say('Each segment is profiled — size, behaviour, and how it differs from the rest.', async () => {
    await r.reveal(run().locator('h3:has-text("Segment profiles")'), 'start', 1200); await sleep(1600);
  }, 4800);
  await r.say('**Anomaly detection**: unusual days stand out at a glance.', async () => {
    await r.click('text=＋ New chat'); await ask('Any unusual days in daily revenue this year?'); await ready(); await r.reveal(run().locator('.chart-box').first(), 'center', 1200); await sleep(1400);
  }, 5400);
  await r.say('**Key drivers**: which factors explain the result, ranked.', async () => {
    await r.click('text=＋ New chat'); await ask('What drives order value?'); await ready(); await r.reveal(run().locator('.chart-box').first(), 'center', 1200); await sleep(1500);
  }, 5200);
};
