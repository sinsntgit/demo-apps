// Documents into the knowledge graph: extraction with evidence, checks, merging, accepting.
const path = require('path');
const A = f => path.join(__dirname, '..', 'assets', f);
module.exports = {
  n: 10, title: 'Documents into the graph', ontology: 'BrightMart Retail', start: '/#/datasources', ready: 'h1:text-is("Data sources")',
  beats: [
    { say: "Not all knowledge is in tables. Contracts, policies, emails and judgments hold facts too. Add the documents to a data source, and they appear on the Knowledge graph tab.",
      act: async c => {
        await c.click('.ocard:has-text("BrightMart shop data"), tr:has-text("BrightMart shop data"), a:has-text("BrightMart shop data")'); await c.page.waitForSelector('h1:has-text("BrightMart shop data")'); await c.sleep(600);
        await c.click('.tabs button:has-text("Add files")'); await c.sleep(500); await c.hover('.drop');
        await c.page.locator('.drop input[type=file]').first().setInputFiles(['customer-email.txt', 'support-notes.md'].map(A)); await c.page.waitForSelector('.tabs button:has-text("Documentation 2")', { timeout: 30000 }); await c.sleep(900); } },
    { say: "Pick the documents, and ask AI to extract the entities and relationships they state, using only the classes and properties of your ontology. Short documents are read in one pass; long ones, such as a fifty page judgment, are read in parts.",
      act: async c => {
        await c.goto(`/#/o/${c.oid}/graph`); await c.page.waitForSelector('h2:text-is("From documents")'); await c.scrollTo('.card:has(h2:text-is("From documents"))', 1100);
        await c.click('.card:has(h2:text-is("From documents")) thead input[type=checkbox]'); await c.sleep(600);
        await c.click('button:has-text("✨ Extract with AI")'); await c.page.waitForSelector('.modal button:text-is("Extract")'); await c.sleep(1200); await c.click('.modal button:text-is("Extract")');
        await c.page.waitForSelector('h3:has-text("Entities (")', { timeout: 120000 }); await c.sleep(600); } },
    { say: "Every fact must come with the exact words of the document, and the application checks that those words are really there. A claim it cannot find is rejected, with the reason.",
      act: async c => {
        await c.scrollTo('h3:has-text("Entities (")', 1200); await c.hl('h3:has-text("Entities (") + div', 3600, 'The words that state each fact, and the page'); await c.sleep(3600);
        await c.click('summary:has-text("rejected by the application")'); await c.sleep(900); await c.scrollTo('summary:has-text("rejected by the application") + div', 1100); await c.hl('summary:has-text("rejected by the application") + div', 3600, 'Rejected, with the reason', 'above'); } },
    { say: "The same customer or order mentioned in different documents becomes one entity, and close matches are offered to you as possible duplicates to merge.",
      act: async c => {
        await c.scrollTo('.banner:has-text("Possibly the same")', 1200); await c.hl('.banner:has-text("Possibly the same")', 3200); await c.sleep(3000);
        await c.click('button:has-text("Merge into")'); await c.page.waitForSelector('.toast:has-text("Merged")'); await c.sleep(900); } },
    { say: "Nothing enters the graph until you accept it. Tick what is right, accept it, and build again.",
      act: async c => {
        await c.click('button:text-is("Tick all shown")'); await c.click('button:text-is("✓ Accept ticked")'); await c.page.waitForSelector('.toast:has-text("accepted")'); await c.sleep(1000);
        await c.scrollBy(-3000, 800); await c.click('button:text-is("↻ Build again from the data")'); await c.page.waitForSelector('.toast:has-text("Knowledge graph built")', { timeout: 90000 }); await c.sleep(900); } },
    { say: "Now the records are in the graph, each with its sources: the document, the page, and the very words it came from.",
      act: async c => {
        await c.scrollTo('.card:has(h2:text-is("Explore records"))', 1100); await c.type('input[placeholder="Find a record by name…"]', 'Nair', { delay: 80 });
        await c.click('.card:has(h2:text-is("Explore records")) button:text-is("Find")'); await c.sleep(800);
        await c.click('.kg-found button >> nth=0'); await c.page.waitForSelector('h3:text-is("Sources in the documents")', { timeout: 20000 }); await c.scrollTo('h3:text-is("Sources in the documents")', 1000);
        await c.hl('h3:text-is("Sources in the documents") + ul', 3600, 'Back to the document, page and words'); } },
  ],
};
