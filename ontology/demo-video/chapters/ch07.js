// Quality checks, the reasoner, proposed fixes, the AI gap review.
module.exports = {
  n: 7, title: 'Quality and reasoning', ontology: 'BrightMart Retail', start: c => `/#/o/${c.oid}/quality`, ready: 'button:has-text("built-in reasoner")',
  setup: async c => {         // a modelling mistake, as a person editing by hand might make (made before recording starts)
    const r = await c.api('POST', `/api/ontologies/${c.oid}/edit`, { patch: { rules: [{ id: 'R9', kind: 'disjoint', statement: 'A store is never a sales channel.', applies_to: ['Store', 'SalesChannel'] }],
      properties: [{ id: 'operates', kind: 'object', domain: 'Party', range: 'Store', inverse: 'operatedBy', definition: 'A store the party runs.' },
                   { id: 'operatedBy', kind: 'object', domain: 'Party', range: 'Party', inverse: 'operates', definition: 'Who runs it.' }] }, note: 'Manual edit' });
    if (r.status !== 200) throw new Error('could not prepare the ontology: ' + r.text.slice(0, 200));
  },
  beats: [
    { say: "Quality and reasoning checks the model itself. Automatic modelling checks give a score out of one hundred, and list what deserves a look.",
      act: async c => { await c.hl('.card >> nth=0', 3400, 'Modelling checks'); await c.sleep(3800); await c.scrollBy(300, 1200); } },
    { say: "Logical mistakes are caught by a reasoner. Here, someone has edited the model by hand, and declared that a store is never a sales channel, although a store is a kind of sales channel.",
      act: async c => { await c.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' })); await c.sleep(700); await c.click('button:has-text("built-in reasoner")'); await c.page.waitForSelector('.banner.bad:has-text("logical problem")', { timeout: 60000 }); await c.hl('.banner.bad:has-text("logical problem")', 3200, '5 logical problems found'); await c.sleep(3400); await c.hl('.banner.bad + ul', 3200, 'Each one explained in plain words'); await c.sleep(1500); } },
    { say: "The reasoner does not just complain. It proposes the exact changes that remove each contradiction, with alternatives where it is a business choice, and the recommended ones are already ticked.",
      act: async c => { await c.scrollTo('table.changes', 1300); await c.hl('table.changes', 3600, 'Recommended changes are ticked'); await c.sleep(3400); } },
    { say: "Apply them, and the model is logically consistent again.",
      act: async c => { await c.click('button:has-text("Apply 2 selected changes")'); await c.page.waitForSelector('.banner.good:has-text("Logically consistent")', { timeout: 60000 }); await c.hl('.banner.good:has-text("Logically consistent")', 2600); } },
    { say: "With Java installed, the HermiT reasoner can be run as well, for a deeper check.",
      act: async c => { await c.hl('button:has-text("HermiT")', 3000, 'A second, stricter reasoner'); await c.hover('button:has-text("HermiT")'); } },
    { say: "AI can propose fixes for the findings, as additions, changes and deletions, each with its reason, and run a gap review that reads the model critically. Nothing is applied until you choose.",
      act: async c => {
        await c.click('button:has-text("Propose fixes with AI")'); await c.page.waitForSelector('text=Problems addressed', { timeout: 90000 });
        await c.scrollTo('.card:has-text("3 · Fix proposals") table.changes', 1300); await c.hl('.card:has-text("3 · Fix proposals") table.changes', 3000, 'Add, change or delete, each with a reason');
        await c.sleep(2500); await c.click('button:has-text("Run a gap review")'); await c.page.waitForSelector('text=Gaps found', { timeout: 90000 }); await c.scrollTo('.card:has-text("4 · Gap review")', 1200); } },
  ],
};
