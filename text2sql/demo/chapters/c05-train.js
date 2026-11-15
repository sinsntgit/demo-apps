const { sleep } = require('../lib');
const state = require('../out/state.json');
exports.step = '05 · Teach it your business';
exports.route = '/#/training';
exports.run = async r => {
  await r.intro('Teach it your business', 'Examples, notes and documents — separately for each data model.', 'Chapter 5', 3200, async () => {
    await r.page.locator('.page-head select').first().selectOption(String(state.retail)); await sleep(800); });
  await r.say('Each data model learns **separately**. Verified question-and-SQL examples are the strongest signal.', async () => {
    await r.tab('Question', 900);
    await r.hover('.item pre.sql >> nth=0', 900); await r.ring('.card.flush'); await sleep(1400); await r.ring(null, false);
  }, 5400);
  await r.say('Answers your users confirm wait here for a **data steward** to approve.', async () => {
    await r.tab('Review queue', 1000);
    await r.hover('.item >> nth=0', 1200);
    if (await r.page.locator('button:has-text("✓ Approve")').count()) { await r.click('button:has-text("✓ Approve") >> nth=0'); await sleep(1400); }
  }, 5600);
  await r.say('Write business rules in plain English — the AI uses them when they are relevant.', async () => {
    await r.tab('Documentation', 900);
    await r.click('text=＋ Add note');
    await r.page.waitForSelector('.modal');
    await r.type('.modal input[type=text]', 'Fiscal year', 55);
    await r.type('.modal textarea', 'Our fiscal year starts on 1 April. Quarters are Q1 = Apr–Jun, Q2 = Jul–Sep, Q3 = Oct–Dec, Q4 = Jan–Mar.', 22);
    await sleep(500);
    await r.click('.modal footer .primary'); await sleep(1200);
  }, 7600);
  await r.say('Upload **PDFs, Word documents or data dictionaries** — they are split into passages and retrieved per question.', async () => {
    await r.tab('Documents', 900);
    await r.click('details.schema-table summary >> nth=0'); await sleep(2200);
  }, 6200);
  await r.say('Schema sync reads table and column names — **never row data**.', async () => {
    await r.tab('Schema', 900);
    await r.click('details.schema-table summary >> nth=1'); await sleep(2600);
  }, 5000);
  await r.say('Edit in a **full-screen editor** when the SQL gets long.', async () => {
    await r.tab('Question', 900);
    await r.click('.item >> nth=0 >> text=Edit');
    await r.page.waitForSelector('.modal');
    await r.click('.modal [title="Maximise"]'); await sleep(2200);
    await r.click('.modal [title="Restore size"]'); await sleep(700);
    await r.page.keyboard.press('Escape'); await sleep(500);
  }, 5200);
};
