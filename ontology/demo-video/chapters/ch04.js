// The diagram and visual editing.
module.exports = {
  n: 4, title: 'The diagram: view and edit visually', ontology: 'BrightMart Retail', start: c => `/#/o/${c.oid}/diagram`, ready: '.dg-svg .dg-node',
  beats: [
    { say: "The Diagram tab draws the class hierarchy. Click any box to see the class, its definition, its attributes and its relationships.",
      act: async c => {
        await c.sleep(700); await c.click('.dg-node[data-id="Customer"]'); await c.page.waitForSelector('.side h3:text-is("Customer")'); await c.sleep(1100);
        await c.click('.dg-node[data-id="Product"]'); await c.page.waitForSelector('.side h3:text-is("Product")'); await c.sleep(1100);
        await c.click('.dg-node[data-id="Order"]'); await c.page.waitForSelector('.side h3:text-is("Order")'); await c.hl('.side', 2600, 'Definition, attributes, relationships', 'above'); } },
    { say: "You do not edit code to change the model. Add a subclass right on the diagram, for example a gift order, with its definition. It appears in the hierarchy at once.",
      act: async c => {
        await c.click('.side button:text-is("＋ Subclass")'); await c.page.waitForSelector('.modal');
        await c.type('.modal input[type=text] >> nth=0', 'Gift order', { delay: 45 });
        await c.type('.modal textarea >> nth=0', 'An order placed as a gift for someone else.', { delay: 16 });
        await c.click('.modal button:text-is("Save")'); await c.page.waitForSelector('.dg-node[data-id="GiftOrder"]'); await c.sleep(400); await c.hl('.dg-node[data-id="GiftOrder"]', 2600, 'The new class'); } },
    { say: "Add a relationship the same way. Name it, point it at another class, and name the inverse, so it can be read from both ends. The form shows, in plain words, how the relationship will read.",
      act: async c => {
        await c.click('.side button:text-is("＋ Relationship")'); await c.page.waitForSelector('.modal');
        await c.select('.modal select >> nth=1', 'Person');
        await c.type('.modal input[type=text] >> nth=0', 'gift for', { delay: 50 });
        await c.hl('.modal .banner', 2400, 'Reads as: Gift order, gift for, Person', 'above');
        await c.type('.modal input[type=text] >> nth=1', 'receives gift', { delay: 40 });
        await c.sleep(500); await c.click('.modal button:text-is("Save")'); await c.page.waitForSelector('.side li:has-text("gift for")'); } },
    { say: "Click a line to edit the relationship. Switch views to see everything around one class, or the relationships within a module.",
      act: async c => {
        await c.click('.side button:text-is("◎ Show everything around this class")'); await c.page.waitForSelector('.dg-elabel:text-is("gift for")'); await c.sleep(900);
        await c.click('.dg-elabel:text-is("gift for")'); await c.page.waitForSelector('.modal h2:has-text("Edit relationship")'); await c.sleep(1100); await c.page.keyboard.press('Escape'); await c.sleep(400);
        await c.select('.row.wrap select >> nth=0', 'module'); await c.sleep(1400); } },
    { say: "Large models stay readable. Expand or collapse any branch, or the whole tree at once, to look at the big picture or to focus on one area.",
      act: async c => {
        await c.select('.row.wrap select >> nth=0', 'hierarchy'); await c.page.selectOption('.row.wrap select >> nth=1', ''); await c.sleep(700);
        await c.click('.dg-toggle[data-id="Party"]'); await c.sleep(900);
        await c.click('button:has-text("Collapse all")'); await c.sleep(1200);
        await c.click('button:has-text("Expand all")'); await c.sleep(900); } },
    { say: "And maximise the diagram to fill the window, with the class panel beside it.",
      act: async c => {
        await c.click('button:has-text("Maximise")'); await c.sleep(1000);
        await c.click('.dg-node[data-id="Shipment"]'); await c.sleep(1300); await c.page.keyboard.press('Escape'); await c.sleep(300); } },
    { say: "Every change is saved as a new version, so nothing is ever lost.",
      act: async c => { await c.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' })); await c.sleep(600); await c.hl('.badge:has-text("Version")', 2800, 'Every edit is a version'); } },
  ],
};
