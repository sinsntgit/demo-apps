// Data sources: set up once, profiled, documented, described by AI.
const path = require('path');
const A = f => path.join(__dirname, '..', 'assets', f);
module.exports = {
  n: 8, title: 'Data sources', start: '/#/datasources', ready: 'h1:text-is("Data sources")',
  beats: [
    { say: "Ontologies become far more useful when they are connected to real data. Data sources are set up once, and reused by any number of ontologies.",
      act: async c => { await c.sleep(1200); await c.click('button:text-is("＋ New data source")'); await c.page.waitForSelector('.modal'); await c.sleep(500); await c.hl('.modal .seg', 3200, 'Upload files, or connect a live database'); await c.sleep(2400); } },
    { say: "Connect a database: PostgreSQL, MySQL, SingleStore, SQL Server, Oracle or Snowflake. Or simply upload files: spreadsheets, CSV, JSON, and documents.",
      act: async c => {
        await c.click('.modal .seg button:has-text("Connect a database")'); await c.sleep(500);
        for (const v of ['postgresql', 'mysql', 'singlestore', 'mssql', 'oracle', 'snowflake']) { await c.page.selectOption('.modal select', v); await c.sleep(780); }
        await c.click('.modal .seg button:has-text("Upload datasets and documents")'); await c.sleep(500); } },
    { say: "Give it a name and a short description, so everyone knows what it holds.",
      act: async c => {
        await c.type('.modal input[type=text] >> nth=0', 'BrightMart shop data', { delay: 40 });
        await c.type('.modal textarea >> nth=0', 'Orders, customers and products exported from the web shop.', { delay: 16 }); await c.sleep(500); } },
    { say: "Then upload the shop's exports. Each table is profiled on the server: row counts, types, keys, how the values are spread, and code lists.",
      act: async c => {
        await c.click('.modal button:text-is("Create")'); await c.page.waitForSelector('h1:has-text("BrightMart shop data")'); await c.sleep(400);
        await c.click('.tabs button:has-text("Add files")'); await c.sleep(400); await c.hover('.drop');
        await c.page.locator('.drop input[type=file]').first().setInputFiles(['customers.csv', 'orders.csv', 'order_lines.csv', 'products.csv', 'shop-glossary.md'].map(A));
        await c.page.waitForSelector('.tabs button:has-text("Tables 4")', { timeout: 40000 }); await c.click('.tabs button:has-text("Tables 4")'); await c.sleep(1200); } },
    { say: "Joins between files are found automatically, for example orders to customers. Columns that look like personal data are marked, and their values are never shared unless the owner allows it.",
      act: async c => {
        await c.hl('tr:has-text("order_lines") td >> nth=4', 2800, 'Joins found automatically'); await c.sleep(3000);
        await c.click('tr.click:has-text("customers")'); await c.page.waitForSelector('.modal h2:has-text("Table customers")'); await c.sleep(1000);
        await c.hl('.modal tr:has-text("email") .badge:has-text("personal")', 3200, 'Personal data: values withheld', 'above'); await c.sleep(3200); await c.page.keyboard.press('Escape'); await c.sleep(400); } },
    { say: "Add documentation, such as a glossary or a data dictionary. Everything written here is given to the AI as the authoritative meaning of the data.",
      act: async c => {
        await c.click('.tabs button:has-text("Documentation")'); await c.sleep(500);
        await c.type('.card:has-text("Notes") textarea', 'Order status moves Placed, Paid, Shipped, Delivered. A Cancelled order was stopped before shipment. Tier is the loyalty level.', { delay: 16 });
        await c.click('button:text-is("Save documentation")'); await c.page.waitForSelector('.toast:has-text("Documentation saved")'); await c.sleep(500); } },
    { say: "Then let AI draft business descriptions for every table and column, and list what it found unclear.",
      act: async c => {
        await c.click('button:has-text("Describe with AI")'); await c.page.waitForSelector('.modal button:text-is("Describe")'); await c.sleep(700); await c.click('.modal button:text-is("Describe")');
        await c.page.waitForSelector('.card:has-text("What the AI understood")', { timeout: 90000 }); await c.sleep(500); await c.hl('.card:has-text("What the AI understood")', 3200, 'What it understood, and what is unclear'); await c.sleep(2400); } },
    { say: "You review the drafts. They stay labelled until you confirm them.",
      act: async c => { await c.click('.tabs button:has-text("Tables")'); await c.sleep(700); await c.hl('.badge:has-text("AI draft") >> nth=0', 3000, 'Drafts stay labelled', 'above'); } },
    { say: "From here, you can build an ontology straight from this data source, or add it to one you already have.",
      act: async c => { await c.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' })); await c.sleep(700); await c.hl('button:has-text("Build an ontology from this")', 3200, 'Build an ontology from it'); await c.sleep(2600); } },
  ],
};
