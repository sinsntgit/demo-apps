// The test bed: does the ontology address a use case? Gaps, proposed changes, test again.
module.exports = {
  n: 6, title: 'The test bed', ontology: 'BrightMart Retail', start: c => `/#/o/${c.oid}/test`, ready: 'textarea',
  beats: [
    { say: "The test bed answers the question every ontology owner asks: does this model really cover what we need? Type any use case in your own words.",
      act: async c => { await c.type('textarea >> nth=0', 'Track warranty claims for the products customers bought', { delay: 38 }); } },
    { say: "The use case is broken into the concepts, relationships and attributes it needs, and each one is checked against the ontology.",
      act: async c => { await c.click('button:text-is("🧪 Run test")'); await c.page.waitForSelector('.ring', { timeout: 60000 }); await c.sleep(600); } },
    { say: "You get a coverage score and a verdict, requirement by requirement. And the application checks the AI's claims itself: if the AI points at something that does not exist, that requirement is marked down.",
      act: async c => {
        await c.hl('.gauge', 3200, 'Coverage and verdict'); await c.sleep(3800); await c.scrollBy(300, 1200);
        await c.hl('text=Checked:', 3200, "The application's own check", 'above'); await c.sleep(2400); } },
    { say: "The gaps are drawn on the diagram, and the changes that would close them are listed, each with its reason. Related changes stay together.",
      act: async c => {
        await c.scrollTo('.dg-node.s-gap', 1300); await c.hl('.dg-node.s-gap', 3000, 'A proposed addition'); await c.sleep(3200);
        await c.scrollTo('table.changes', 1300); await c.hl('table.changes', 3000); } },
    { say: "Tick what you want, and apply it. Then test again: the same requirements are re-checked, so the scores can be compared fairly.",
      act: async c => {
        await c.click('button:has-text("Apply 2 selected changes")'); await c.page.waitForSelector('.toast:has-text("2 changes applied")'); await c.sleep(1200);
        await c.click('button:text-is("↻ Test again")'); await c.page.waitForSelector('.ring:has-text("100%")', { timeout: 60000 }); await c.sleep(800);
        await c.scrollTo('.banner:has-text("Re-test of the same")', 1200); await c.hl('.banner:has-text("Re-test of the same")', 3600, 'Same requirements, compared'); } },
  ],
};
