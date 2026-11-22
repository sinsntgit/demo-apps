// The library and the pre-built starter ontologies.
module.exports = {
  n: 1, title: 'The library', start: '/#/library', ready: '.ocard',
  beats: [
    { say: "This is OntoStudio. The library holds every ontology in your organisation, in folders, with access levels for each person.",
      act: async c => { await c.hl('.tree', 3000, 'Folders, with access levels'); await c.sleep(2200); await c.hl('.ocard >> nth=0', 3000, 'Size, owner and your level of access'); await c.hover('.ocard >> nth=0'); await c.sleep(3200); } },
    { say: "You can start from a ready-made model. The pre-built library has twenty-two starter ontologies across nineteen industries, from banking and insurance to healthcare, manufacturing and retail.",
      act: async c => {
        await c.click('.nav a[data-path="templates"]'); await c.page.waitForSelector('.ocard'); await c.sleep(600);
        await c.hl('button:has-text("All industries")', 2600, 'Nineteen industries'); await c.sleep(2400);
        await c.click('button:has-text("Retail & e-commerce")'); await c.sleep(1800);
        await c.click('button:has-text("All industries")'); } },
    { say: "Search by name, concept or standard. Preview any of them as a diagram, then copy it into your library and extend it, or have AI tailor it for you at once.",
      act: async c => {
        await c.type('input[type=search]', 'lending', { delay: 55 }); await c.sleep(700);
        await c.click('.ocard >> nth=0'); await c.page.waitForSelector('.modal .dg-svg .dg-node'); await c.sleep(1200);
        await c.hl('.modal .dg-svg', 2400, 'The model as a diagram'); await c.sleep(2300);
        await c.hl('.modal button:text-is("＋ Use this ontology")', 3000, 'Copy it, optionally tailored by AI', 'above'); await c.sleep(2000);
        await c.page.keyboard.press('Escape'); await c.sleep(400); } },
    { say: "Or start from your own material. Let's build an ontology for an online retailer from scratch.",
      act: async c => { await c.page.fill('input[type=search]', ''); await c.click('.nav a[data-path="library"]'); await c.page.waitForSelector('.ocard'); await c.sleep(500);
        await c.hover('button:text-is("＋ New ontology")'); } },
  ],
};
