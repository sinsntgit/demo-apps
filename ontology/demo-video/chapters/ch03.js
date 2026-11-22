// Reading the result: overview, explanation, standards.
module.exports = {
  n: 3, title: 'Understand the result', ontology: 'BrightMart Retail', start: c => `/#/o/${c.oid}`, ready: '.prose',
  beats: [
    { say: "Here is the result. The overview shows the size of the model, a quality score, and a plain-language explanation of what it is for, what is in scope, and how to read it.",
      act: async c => { await c.hl('.kpis', 3400, 'Size of the model, and a quality score'); await c.sleep(3800); await c.scrollBy(380, 1400); await c.hl('.prose h2 >> nth=0', 2200); } },
    { say: "Every module gets its own paragraph, and the design decisions are written down, so people who are not ontologists can review the model.",
      act: async c => { await c.scrollBy(620, 1600); await c.sleep(1500); await c.scrollBy(620, 1600); await c.sleep(1200); } },
    { say: "The Standards tab shows which published standards it builds on, why, and which classes align to which terms. The standards come from a built-in catalogue of sixty-five, and anything the AI proposes outside it is flagged.",
      act: async c => {
        await c.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' })); await c.sleep(900);
        await c.click('.tabs button:text-is("Standards")'); await c.page.waitForSelector('.std .card'); await c.sleep(900);
        await c.hl('.std .card >> nth=0', 3200, 'Why it is used, and which terms it supplies'); await c.sleep(3600);
        await c.scrollBy(420, 1400); } },
  ],
};
