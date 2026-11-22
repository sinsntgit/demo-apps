// Classes & properties as tables, and the use cases.
module.exports = {
  n: 5, title: 'Classes, properties and use cases', ontology: 'BrightMart Retail', start: c => `/#/o/${c.oid}/model`, ready: 'table.tbl tr.click',
  beats: [
    { say: "Classes and properties lists everything in tables, with search, and the rules that the model must always satisfy.",
      act: async c => {
        await c.type('input[type=search]', 'gift', { delay: 90 }); await c.sleep(1300); await c.page.fill('input[type=search]', ''); await c.sleep(500);
        await c.click('.seg button:has-text("Rules")'); await c.page.waitForSelector('td:has-text("never overlap")'); await c.hl('td:has-text("never overlap")', 2600, 'A rule a reasoner can check'); } },
    { say: "The Use cases tab holds the questions this ontology must answer. Yours come first, then the ones the AI wrote. Each shows the part of the model that answers it, the path through it, and a query.",
      act: async c => {
        await c.click('.tabs button:text-is("Use cases")'); await c.page.waitForSelector('details.uc'); await c.sleep(900);
        await c.hl('details.uc .badge.info >> nth=0', 2600, 'Required by the owner');
        await c.click('details.uc summary >> nth=0'); await c.page.waitForSelector('details.uc[open] .dg-svg .dg-node'); await c.sleep(2500);
        await c.scrollBy(380, 1400); await c.sleep(1500); } },
  ],
};
