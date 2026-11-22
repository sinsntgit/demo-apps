// Teams and administration: folders and access, roles, AI usage, models, settings, audit, appearance, help.
module.exports = {
  n: 12, title: 'Teams, usage and administration', start: '/#/library', ready: '.ocard',
  setup: async c => {                       // two colleagues to share with
    await c.api('POST', '/api/admin/users', { email: 'maya@brightmart.example', name: 'Maya Rao', role: 'ontologist' });
    await c.api('POST', '/api/admin/users', { email: 'riya@brightmart.example', name: 'Riya Shah', role: 'viewer' });
  },
  beats: [
    { say: "Folders organise ontologies, and access levels are set for every folder. Let us create one for the retail work.",
      act: async c => {
        await c.click('button:text-is("＋ New folder")'); await c.page.waitForSelector('.modal'); await c.type('.modal input[type=text]', 'Retail', { delay: 60 }); await c.click('.modal button:text-is("Save")');
        await c.page.waitForSelector('.tree a:has-text("Retail")'); await c.click('.tree a:has-text("Retail")'); await c.page.waitForSelector('h1:text-is("Retail")'); await c.sleep(700); } },
    { say: "Access is granted per folder: view, edit or owner, to named people or to everyone.",
      act: async c => {
        await c.click('button:text-is("👥 Access")'); await c.page.waitForSelector('.modal td:has-text("riya@brightmart.example")'); await c.sleep(700);
        await c.page.locator('.modal tr:has-text("maya@brightmart.example") select').selectOption('edit'); await c.sleep(600);
        await c.page.locator('.modal tr:has-text("riya@brightmart.example") select').selectOption('view'); await c.sleep(600);
        await c.hl('.modal table', 2600, 'Per person: view, edit or owner'); await c.sleep(2400); await c.click('.modal button:text-is("Save access")'); await c.page.waitForSelector('.modal', { state: 'detached' }); } },
    { say: "Roles keep things safe. Viewers can read, test and export. Ontologists create and edit. Administrators manage everything. And all of it is enforced on the server.",
      act: async c => {
        await c.click('.nav a[data-path="admin"]'); await c.page.waitForSelector('td:has-text("riya@brightmart.example")'); await c.sleep(700);
        await c.click('button:text-is("＋ Add user")'); await c.page.waitForSelector('.modal select'); await c.sleep(500);
        for (const v of ['viewer', 'ontologist', 'admin']) { await c.page.selectOption('.modal select', v); await c.sleep(1500); }
        await c.page.keyboard.press('Escape'); await c.sleep(400); await c.hl('table.tbl', 2400, 'Administrator · Ontologist · Viewer'); } },
    { say: "The AI usage dashboard tracks jobs, model calls, tokens and cost, by day, by kind of work, by model and by ontology. Each person sees their own usage. Administrators see everyone, and can filter.",
      act: async c => {
        await c.click('.nav a[data-path="usage"]'); await c.page.waitForSelector('.kpis'); await c.sleep(900); await c.hl('.kpis', 3000, 'Jobs, model calls, tokens, cost'); await c.sleep(3200);
        await c.scrollBy(520, 1300); await c.sleep(2000); await c.scrollBy(520, 1300); } },
    { say: "Administrators configure the AI models: Anthropic Claude, OpenAI, or a self-hosted model, so that sensitive material need not leave your network.",
      act: async c => {
        await c.goto('/#/admin/models'); await c.page.waitForSelector('button:text-is("＋ Add model")'); await c.sleep(800); await c.hl('.item:has-text("Demo model")', 2800);
        await c.click('button:text-is("＋ Add model")'); await c.page.waitForSelector('.modal select'); await c.sleep(700);
        for (const v of ['anthropic', 'openai', 'openai_compatible']) { await c.page.selectOption('.modal select', v); await c.sleep(1100); }
        await c.page.keyboard.press('Escape'); } },
    { say: "There are also security settings, with two factor authentication, and an audit log of every change.",
      act: async c => {
        await c.goto('/#/admin/settings'); await c.page.waitForSelector('button:text-is("Save settings")'); await c.hl('.card:has(h2:text-is("Security"))', 2600, 'Two factor authentication, lockout, sessions'); await c.sleep(2800);
        await c.goto('/#/admin/audit'); await c.page.waitForSelector('td.mono'); await c.hl('table.tbl', 2600, 'Every change, by whom, and when'); await c.sleep(2000); } },
    { say: "And appearance: your own name, an accent colour to match your brand, and a light or dark theme, which each person can switch for themselves.",
      act: async c => {
        await c.goto('/#/admin/appearance'); await c.page.waitForSelector('.swatch'); await c.click('.swatch[data-accent="teal"]'); await c.sleep(500); await c.click('button:text-is("Save appearance")'); await c.sleep(800);
        await c.click('button:has-text("Theme")'); await c.sleep(1600); await c.click('button:has-text("Theme")'); await c.sleep(500); } },
    { say: "And a complete help manual is built in.",
      act: async c => { await c.click('.nav a[data-path="help"]'); await c.page.waitForSelector('.help-body section'); await c.sleep(900); await c.scrollBy(500, 1400); } },
  ],
};
