const { sleep, vo } = require('../lib');
exports.step = '08 · SAP sales & finance sample';
exports.route = '/#/training';
exports.run = async r => {
  const lastQ = () => r.page.locator('.q').last();
  const run = () => r.page.locator('.run').last();
  let sap;
  await r.intro('A test on SAP-style data', 'Thirty SAP tables, SAP names, and training that explains them.', 'Chapter 8', 3600, async () => {
    sap = (await r.page.evaluate(async () => (await (await fetch('/api/connections')).json()).find(c => c.name.includes('SAP')))).id;
    await r.page.locator('.page-head select').first().selectOption(String(sap)); await sleep(800); },
    vo('To show it on an S A P landscape, the product includes a sample: thirty tables with real S A P table and field names, and training that explains what they mean.'));
  await r.say('The data model holds sales and distribution, finance, controlling and materials tables — named exactly as in SAP.', async () => {
    await r.tab('Schema', 1000); await r.click('details.schema-table summary >> nth=0'); await sleep(2400);
  }, 7000);
  await r.say('Training turns cryptic field names into business language: **verified example questions**…', async () => {
    await r.tab('Question', 1000); await r.hover('.item pre.sql >> nth=0', 900); await r.ring('.card.flush'); await sleep(1800); await r.ring(null, false);
  }, 6000);
  await r.say('…**business rules** such as debit and credit signs in finance…', async () => {
    await r.tab('Documentation', 1000); await sleep(2200);
  }, 4800);
  await r.say('…and a **field dictionary** that says what VBELN, KUNNR and NETWR actually mean.', async () => {
    await r.tab('Extra DDL', 1000); await sleep(2400);
  }, 5800);
  r.mark('hl-start');
  await r.say('Now ask the way a sales manager would.', async () => {
    await r.nav('ask', 1000);
    await r.page.locator('.ask-bar select').first().selectOption(String(sap)); await sleep(700);
    await r.type('.composer textarea', 'Net sales by sales organisation in 2025', 42); await sleep(400);
  }, 3600);
  await r.say('The system joins the right billing and text tables, and answers in seconds.', async () => {
    await r.page.keyboard.press('Enter');
    await r.page.waitForSelector('.run .chart-box canvas', { timeout: 60000 }); await sleep(600);
    await r.reveal(lastQ(), 'start', 900);
  }, 6000);
  await r.say('Finance questions work the same way: which customers have the most overdue receivables?', async () => {
    await r.click('text=＋ New chat');
    await r.page.locator('.ask-bar select').first().selectOption(String(sap)); await sleep(500);
    await r.type('.composer textarea', 'Which customers have the most overdue receivables?', 40); await r.page.keyboard.press('Enter');
    await r.page.waitForSelector('.run .chart-box canvas', { timeout: 60000 }); await sleep(600);
    await r.reveal(lastQ(), 'start', 900);
    await r.click(run().locator('.sec-head button:text-is("Table")')); await sleep(1800);
  }, 8000);
  r.mark('hl-end');
  await r.say('SAP data is usually copied into a reporting database or warehouse. AskData reads those tables, read-only.', async () => { await sleep(600); }, 6200);
};
