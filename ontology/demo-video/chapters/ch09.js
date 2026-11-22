// The knowledge graph from the data source: mapping, build, overview, explorer, query, test bed, storage, downloads.
module.exports = {
  n: 9, title: 'The knowledge graph', ontology: 'BrightMart Retail', start: c => `/#/o/${c.oid}/sources`, ready: 'h2:text-is("Data sources from the library")',
  beats: [
    { say: "A knowledge graph is your ontology filled with your actual records. First, add the data source to the ontology, then open the Knowledge graph tab.",
      act: async c => {
        await c.click('button:has-text("＋ Add from the library")'); await c.page.waitForSelector('.modal input[type=checkbox]'); await c.sleep(700);
        await c.click('.modal input[type=checkbox] >> nth=0'); await c.sleep(500); await c.click('.modal button:text-is("Add")'); await c.page.waitForSelector('.toast:has-text("added")'); await c.sleep(900);
        await c.click('.tabs button:text-is("Knowledge graph")'); await c.page.waitForSelector('h2:text-is("Mapping")'); await c.sleep(800); } },
    { say: "The mapping says which table holds each class, and which column holds each attribute. Match by names, or ask AI to propose it. Every proposal is checked against the ontology and the tables, and anything that does not exist is left out.",
      act: async c => {
        await c.hl('button:has-text("Match by names")', 2200); await c.sleep(2300);
        await c.click('button:has-text("✨ Propose with AI")'); await c.page.waitForSelector('.modal button:text-is("Propose")'); await c.sleep(900); await c.click('.modal button:text-is("Propose")');
        await c.page.waitForSelector('tr:has-text("Order line")', { timeout: 90000 }); await c.sleep(900);
        await c.click('details:has-text("From the AI proposal") summary'); await c.sleep(800); await c.hl('details:has-text("From the AI proposal")', 3200, 'Anything that does not exist is left out'); } },
    { say: "Proposals are drafts for you to review. Open any mapping to see, and change, its columns and joins.",
      act: async c => {
        await c.click('tr:has-text("Order line") button:text-is("Edit")'); await c.page.waitForSelector('.modal h3:text-is("Relationships")'); await c.sleep(1000);
        await c.hl('.modal h3:text-is("Relationships")', 3000, 'How records are joined'); await c.sleep(3200); await c.click('.modal button:text-is("Cancel")'); await c.sleep(400); } },
    { say: "When you are happy with a mapping, confirm it, and it stops being a draft.",
      act: async c => { for (const cls of ['Customer', 'Order', 'Order line', 'Product']) { await c.click(`tr:has-text("${cls}") button:has-text("Confirm")`, { ms: 420 }); await c.sleep(420); } } },
    { say: "Build the graph. The data is only read, never written, and personal columns stay out unless the owner allows them. You can pause or cancel a build.",
      act: async c => { await c.click('button:text-is("▶ Build the knowledge graph")'); await c.page.waitForSelector('.joblog', { timeout: 20000 }); await c.sleep(1500); await c.hl('button:text-is("⏸ Pause")', 2000); await c.page.waitForSelector('.kpi:has-text("Records")', { timeout: 90000 }); await c.sleep(800); } },
    { say: "The graph at a glance shows every class with its number of records, and the links between them.",
      act: async c => { await c.scrollTo('.card:has(h2:text-is("The graph at a glance"))', 1300); await c.hl('.card:has(h2:text-is("The graph at a glance")) .dg', 3400, 'Records per class, links between them'); } },
    { say: "What is in the graph points out data problems, such as codes that match no controlled value, or links to missing records. Personal columns are left out, and it says so.",
      act: async c => { await c.scrollTo('.card:has(h2:text-is("What is in the graph"))', 1300); await c.hl('.banner.warn:has-text("Worth checking")', 3400, 'Things worth checking'); await c.sleep(3600); await c.scrollBy(420, 1300); await c.hl('.card:has(h2:text-is("What is in the graph")) .grid2', 3600, 'Records per class and per property'); await c.sleep(2400); } },
    { say: "Explore any record: its values, the records it is linked to, and click through from one to the next. It is the quickest way to check that the data landed where you expect.",
      act: async c => {
        await c.scrollTo('.card:has(h2:text-is("Explore records"))', 1200);
        await c.type('input[placeholder="Find a record by name…"]', 'BM-100', { delay: 80 }); await c.click('.card:has(h2:text-is("Explore records")) button:text-is("Find")'); await c.sleep(900);
        await c.click('.kg-found button >> nth=0'); await c.page.waitForSelector('h3:text-is("Linked records")'); await c.sleep(1500);
        await c.click('.card:has(h2:text-is("Explore records")) h3:text-is("Linked records") ~ div button >> nth=0'); await c.sleep(1500); } },
    { say: "Or ask the graph a question in SPARQL. Queries can only read, and they have a time limit.",
      act: async c => {
        await c.scrollTo('#graph-console', 1200); await c.select('#graph-console select', await c.page.locator('#graph-console select option', { hasText: 'Records of Order' }).first().getAttribute('value'));
        await c.sleep(900); await c.click('button:text-is("▶ Run query")'); await c.page.waitForSelector('#graph-console td', { timeout: 30000 }); await c.sleep(900); await c.scrollBy(300, 1200); } },
    { say: "In the test bed, the same use case can now be answered from your data. The AI writes the query, the application runs it, and you see the records behind the answer. Results are never sent to the AI.",
      act: async c => {
        await c.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' })); await c.sleep(800); await c.click('.tabs button:text-is("Test bed")'); await c.page.waitForSelector('textarea');
        await c.hl('label:has-text("Also answer it from the knowledge graph")', 2600, 'Answer it from your data');
        await c.type('textarea >> nth=0', 'Show orders by customer with their totals and status', { delay: 28 }); await c.click('button:text-is("🧪 Run test")');
        await c.page.waitForSelector('h3:text-is("Answer from your data")', { timeout: 90000 }); await c.scrollTo('.card:has(h3:text-is("Answer from your data")) >> nth=-1', 1300); await c.hl('.badge:has-text("Answered from the data")', 3000); } },
    { say: "You choose where the data lives: a copy on the server, refreshed every night or every week, or live from the sources, with nothing stored.",
      act: async c => {
        await c.click('.tabs button:text-is("Knowledge graph")'); await c.page.waitForSelector('text=Where the data lives'); await c.page.evaluate(() => window.scrollTo({ top: 0 })); await c.sleep(700);
        await c.hl('label:has-text("A copy on this server")', 2800); await c.sleep(2900); await c.hl('label:has-text("Live from the sources")', 3000); } },
    { say: "The graph can be downloaded as Turtle, and the mapping as standard R2RML, for other tools.",
      act: async c => { await c.hl('a:text-is("⬇ Graph (Turtle)")', 2400); await c.sleep(2500); await c.hl('a:text-is("⬇ Mapping (R2RML)")', 2400); await c.hover('a:text-is("⬇ Mapping (R2RML)")'); } },
  ],
};
