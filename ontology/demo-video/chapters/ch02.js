// Create an ontology from a domain, use cases and documents, and watch the AI build it.
const path = require('path');
const A = f => path.join(__dirname, '..', 'assets', f);
module.exports = {
  n: 2, title: 'Build with AI', start: '/#/library', ready: '.ocard',
  beats: [
    { say: "Give the ontology a name, its domain and its scope, in plain words. The more precise the scope, the better the result. The size setting controls how detailed the first version will be.",
      act: async c => {
        await c.click('button:text-is("＋ New ontology")'); await c.page.waitForSelector('.modal');
        await c.type('.modal input[type=text] >> nth=0', 'BrightMart Retail');
        await c.type('.modal input[type=text] >> nth=1', 'Online retail and e-commerce', { delay: 30 });
        await c.type('.modal textarea >> nth=0', 'From browsing to delivery and returns: customers, orders, products, payments and shipments. Not marketing campaigns.', { delay: 11 });
        await c.hl('.modal select >> nth=0', 2400, 'Size: how detailed the first version is'); await c.hover('.modal select >> nth=0'); } },
    { say: "Next, tell it what the ontology must be able to answer. These use cases shape the design, and every one of them is checked later.",
      act: async c => {
        await c.click('.steps button:has-text("Use cases")');
        await c.type('.modal textarea >> nth=0', 'Which customers returned more than two orders last quarter?\nWhat is the delivery status of each order?', { delay: 16 });
        await c.type('.modal textarea >> nth=1', 'Must track gift cards and returns.', { delay: 22 }); } },
    { say: "You can also add documents, a database schema, or a ready-made data source, and the ontology is grounded in what you already have.",
      act: async c => {
        await c.click('.steps button:has-text("More documents")'); await c.sleep(400);
        await c.hover('.modal .drop'); await c.page.locator('.modal .drop input[type=file]').first().setInputFiles(A('returns-policy.txt'));
        await c.page.waitForSelector('.modal .item:has-text("returns-policy.txt")'); await c.hl('.modal .item:has-text("returns-policy.txt")', 2400, 'Read when the ontology is built'); } },
    { say: "Press build. A reasoning model researches published standards, designs the class hierarchy, adds relationships, attributes and controlled values, reviews its own work for gaps, then writes the explanation and use cases.",
      act: async c => {
        await c.click('.steps button:has-text("Build")'); await c.sleep(1800);
        await c.hl('.modal .banner.info', 3200, 'What happens when you build');
        await c.sleep(2600); await c.click('button:has-text("Create and build with AI")'); await c.page.waitForSelector('.joblog', { timeout: 30000 }); } },
    { say: "It runs on the server, so you can keep working, or close the page. You can pause or cancel it at any time.",
      act: async c => { await c.hl('.card:has(.joblog)', 2800, 'Live progress, on the server'); await c.sleep(2800); await c.hl('button:text-is("⏸ Pause")', 2200); await c.hl('button:text-is("✕ Cancel")', 2200); } },
    { say: "And a few minutes later, the first version is ready.",
      act: async c => { await c.page.waitForSelector('.prose', { timeout: 150000 }); await c.sleep(800); } },
  ],
};
