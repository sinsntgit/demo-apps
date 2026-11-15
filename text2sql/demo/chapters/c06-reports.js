const { sleep } = require('../lib');
const state = require('../out/state.json');
exports.step = '06 · Reports';
exports.run = async r => {
  const lastRun = () => r.page.locator('.run').last();
  await r.intro('Turn answers into reports', 'Designed by drag and drop. Always live. Shared and scheduled.', 'Chapter 6', 3200, async () => {
    await r.page.evaluate(id => { location.hash = '#/ask/' + id; }, state.seed_conv); await r.page.waitForSelector('.run .chart-box canvas'); await sleep(1200); });
  r.mark('hl-start');
  await r.say('Any answer can go into a report: **Export → Add to a report**.', async () => {
    await r.reveal('.run >> nth=-1', 'start', 900);
    await r.click(lastRun().locator('text=⬇ Export')); await sleep(700);
    await r.click('.pop:not(.hidden) >> text=＋ Add to a report…');
    await r.page.waitForSelector('.modal input');
    await r.type('.modal input', 'Quarterly sales pack', 50); await sleep(300);
    await r.click('.modal >> text=Create new report'); await r.page.waitForSelector('.toast'); await sleep(1400);
  }, 6400);
  await r.say('Add results from **as many chats as you like**.', async () => {
    await r.reveal('.run >> nth=0', 'start', 900);
    await r.click(r.page.locator('.run').first().locator('text=⬇ Export')); await sleep(600);
    await r.click('.pop:not(.hidden) >> text=＋ Add to a report…');
    await r.click('.modal .item:has-text("Quarterly sales pack") >> text=Add here'); await r.page.waitForSelector('.toast'); await sleep(1400);
  }, 4600);
  await r.say('A report stores the **queries, not the numbers** — every time it opens, it refreshes with the latest data.', async () => {
    await r.nav('reports', 1000);
    await r.click('.report-card:has-text("Quarterly sales pack")');
    await r.page.waitForSelector('.paper .rep-result canvas'); await sleep(1800);
  }, 6200);
  await r.say('Open the designer: **drag objects onto the page**.', async () => {
    await r.click('text=✎ Edit'); await r.page.waitForSelector('.rep-designer .rep-comp'); await sleep(800);
    await r.drag('.pal:has-text("Heading")', '.rep-comp >> nth=0', { toFy: 0.05 });
    await r.page.waitForFunction(() => document.querySelectorAll('.rep-comp').length === 3);
    await r.type('.rep-comp >> nth=0 >> input[type=text]', 'Quarterly sales review – {{date}}', 40); await sleep(500);
  }, 6400);
  await r.say('Set an object to **half width** to place results side by side.', async () => {
    for (const i of [1, 2]) { await r.click(`.rep-comp >> nth=${i} >> .seg button:has-text("½")`); }
    await sleep(1600);
  }, 4600);
  await r.say('Add **live text**: placeholders such as the date, the viewer or a result’s summary refresh on every open.', async () => {
    await r.drag('.pal:has-text("Text")', '.rep-dropzone');
    await r.page.waitForFunction(() => document.querySelectorAll('.rep-comp').length === 4);
    await r.type('.rep-comp >> nth=3 >> textarea', 'Prepared for {{viewer}}. {{summary:1}}', 38); await sleep(800);
  }, 7000);
  await r.say('Save — header, footer and page numbers are added to the PDF.', async () => {
    await r.click('text=Save report'); await r.page.waitForSelector('.paper .rep-result canvas'); await sleep(1400);
    await r.click('button:has-text("⬇ PDF")'); await sleep(1800);
  }, 5000);
  r.mark('hl-end');
  await r.say('Share with **user groups, roles or individuals** — everyone sees only the data they are allowed to.', async () => {
    await r.click('text=👥 Share'); await r.page.waitForSelector('.modal');
    await r.select('.modal .item:has-text("Sales leadership") select', 'view'); await sleep(1200);
    await r.click('.modal footer .primary'); await r.page.waitForSelector('.toast'); await sleep(900);
  }, 6200);
  await r.say('**Schedule** it: daily, weekly or monthly — emailed as a PDF to groups, people and outside addresses.', async () => {
    await r.click('text=🕒 Schedule'); await r.page.waitForSelector('.modal .ticklist');
    await r.click('.modal label.check >> nth=0'); await sleep(500);
    await r.click('.modal .ticklist >> nth=0 >> label:has-text("Sales leadership")'); await sleep(400);
    await r.click('.modal .ticklist >> nth=1 >> label:has-text("Dana Cho")'); await sleep(400);
    await r.type('.modal textarea', 'board@partner.example', 40); await sleep(900);
  }, 7600);
  await r.say('Every person gets **their own copy**, rendered with **their own** data access.', async () => {
    await r.click('.modal label.check:has-text("Also email it now")'); await sleep(500);
    await r.click('.modal >> text=▶ Run now');
    await r.page.waitForSelector('.toast:has-text("emailed")', { timeout: 60000 }); await sleep(2600);
  }, 6000);
};
