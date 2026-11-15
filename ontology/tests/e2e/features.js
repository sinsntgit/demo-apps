// Browser walk-through of every screen against a fresh instance with the stand-in model.
// Usage: node tests/e2e/features.js <screenshot dir>     (started by tests/e2e/run.sh)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const OUT = process.argv[2] || '/tmp/onto-shots';
const BASE = 'http://localhost:8020';
const errors = [];
let page, n = 0;

const ok = (name, cond, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const shot = async name => { await page.waitForTimeout(350); await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: false }); };
const step = async (name, fn) => { n++; try { await fn(); } catch (e) { ok(name, false, String(e.message).split('\n')[0]); try { await page.screenshot({ path: path.join(OUT, `error-${n}.png`) }); } catch {} } };
/** Did the SVG diagram actually draw boxes with text (not just exist)? */
const drawn = async (sel = '.dg-svg') => page.evaluate(s => { const svg = document.querySelector(s); if (!svg) return 0;
  return [...svg.querySelectorAll('.dg-node')].filter(g => g.querySelector('rect').getBBox().width > 20 && g.querySelector('text').textContent.trim()).length; }, sel);
const waitJob = async () => { await page.waitForSelector('.joblog', { timeout: 8000 }).catch(() => {}); await page.waitForSelector('.joblog', { state: 'detached', timeout: 60000 }); };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true });
  page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error' && !/401|403|404|409|400/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  await step('sign in', async () => {
    await page.goto(BASE);
    await page.fill('input[type=email]', 'admin@example.com'); await page.fill('input[type=password]', 'Admin-Passw0rd!');
    await shot('signin');
    await page.click('button:text-is("Sign in")');
    await page.waitForSelector('.ocard');
    ok('sign in shows the library with the sample ontology', (await page.textContent('.ocard h3')).startsWith('Sample:'));
    ok('no literal "null" or "undefined" on screen', !/\bnull\b|\bundefined\b/.test(await page.innerText('body')));
  });

  await step('admin: AI model', async () => {
    await page.goto(BASE + '/#/admin/models'); await page.waitForSelector('button:text-is("＋ Add model")');
    await page.click('button:text-is("＋ Add model")');
    await page.selectOption('.modal select', 'openai_compatible');
    const inputs = page.locator('.modal input[type=text]');
    await inputs.nth(0).fill('standin-1'); await inputs.nth(1).fill('Stand-in model'); await inputs.nth(2).fill('http://127.0.0.1:8765/v1');
    await page.locator('.modal label.check', { hasText: 'Default model' }).locator('input').check();
    await page.click('.modal button:text-is("Save")');
    await page.waitForSelector('.item:has-text("Stand-in model")');
    await page.locator('.item:has-text("Stand-in model") button:text-is("Test")').click();
    await page.waitForSelector('.badge.good:has-text("responded")');
    ok('AI model added and connection test passes', true);
    await shot('models');
    await page.goto(BASE + '/#/admin/users'); await page.waitForSelector('button:text-is("＋ Add user")');
    await page.click('button:text-is("＋ Add user")');
    await page.fill('.modal input[type=email]', 'riya@example.com'); await page.locator('.modal input[type=text]').first().fill('Riya');
    await page.selectOption('.modal select', 'viewer'); await page.click('.modal button:text-is("Save")');
    await page.waitForSelector('.codes'); await shot('user-password');
    await page.keyboard.press('Escape');
    await page.waitForSelector('td:has-text("riya@example.com")'); await shot('users');
    ok('user created with a temporary password', true);
  });

  await step('sample ontology: overview', async () => {
    await page.goto(BASE + '/#/library'); await page.click('.ocard');
    await page.waitForSelector('.prose'); await shot('overview');
    ok('overview shows the explanation and KPIs', (await page.locator('.kpi').count()) === 6 && (await page.innerText('.prose')).includes('How to read the model'));
    await page.click('.tabs button:text-is("Standards")'); await page.waitForSelector('.std .card'); await shot('standards');
    ok('standards tab lists catalogue standards', (await page.locator('.std .card').count()) === 5 && (await page.innerText('.std')).includes('catalogue'));
  });

  await step('diagram: view and edit visually', async () => {
    await page.click('.tabs button:text-is("Diagram")'); await page.waitForSelector('.dg-svg .dg-node');
    ok('hierarchy diagram is drawn', (await drawn()) >= 24, `${await drawn()} boxes`);
    await page.locator('.dg-node[data-id="Order"]').click();
    await page.waitForSelector('.side h3:text-is("Order")'); await shot('diagram');
    ok('clicking a box shows the class panel', (await page.innerText('.side')).includes('placed by'));
    // add a subclass from the diagram
    await page.click('.side button:text-is("＋ Subclass")');
    await page.locator('.modal input[type=text]').first().fill('Gift order');
    await page.locator('.modal textarea').first().fill('An order placed as a gift for someone else.');
    await shot('class-form');
    await page.click('.modal button:text-is("Save")');
    await page.waitForSelector('.dg-node[data-id="GiftOrder"]');
    ok('a subclass added on the diagram appears in it', (await page.locator('.dg-node[data-id="GiftOrder"] text').first().textContent()) === 'Gift order');
    // add a relationship from the new class
    await page.click('.side button:text-is("＋ Relationship")');
    await page.locator('.modal select').nth(1).selectOption('Person');
    await page.locator('.modal input[type=text]').first().fill('gift for');
    await page.locator('.modal input[type=text]').nth(1).fill('receives gift');
    await shot('relationship-form');
    await page.click('.modal button:text-is("Save")');
    await page.waitForSelector('.side li:has-text("gift for")');
    await page.click('.side button:text-is("◎ Show everything around this class")');
    await page.waitForSelector('.dg-elabel:text-is("gift for")'); await shot('diagram-around');
    ok('a relationship added visually is drawn as a labelled line', true);
    await page.locator('.dg-elabel:text-is("gift for")').click();
    await page.waitForSelector('.modal h2:has-text("Edit relationship")');
    ok('clicking a line opens the relationship editor', (await page.inputValue('.modal input[type=text] >> nth=1')) === 'receives gift');
    await page.keyboard.press('Escape');
    await page.selectOption('.row.wrap select >> nth=0', 'module'); await page.waitForTimeout(500); await shot('diagram-module');
    ok('module relationship view is drawn', (await drawn()) >= 5);
    // expand / collapse and maximise
    await page.selectOption('.row.wrap select >> nth=0', 'hierarchy'); await page.waitForTimeout(400);
    await page.selectOption('.row.wrap select >> nth=1', ''); await page.waitForTimeout(500);
    const before = await drawn();
    await page.locator('.dg-toggle[data-id="Party"]').click(); await page.waitForTimeout(500);
    const folded = await drawn();
    ok('collapsing a branch hides its subclasses', folded === before - 5 && (await page.locator('.dg-node[data-id="Party"] text').allTextContents()).join(' ').includes('+5 more'), `${before} → ${folded}`);
    await page.click('button:has-text("Collapse all")'); await page.waitForTimeout(500);
    const top = await drawn();
    ok('collapse all shows only the top-level classes', top < folded && (await page.locator('.dg-node[data-id="Customer"]').count()) === 0, `${top} boxes`);
    await shot('diagram-collapsed');
    await page.locator('.dg-toggle[data-id="Party"]').click(); await page.waitForTimeout(500);
    ok('expanding one branch shows its subclasses again', (await page.locator('.dg-node[data-id="Customer"]').count()) === 1);
    await page.click('button:has-text("Expand all")'); await page.waitForTimeout(500);
    ok('expand all restores every class', (await drawn()) === before);
    await page.click('button:has-text("Maximise")');
    const box = await page.locator('.dg-wrap').boundingBox();
    ok('maximise fills the window, side panel included', box.width >= 1400 && box.height >= 880 && await page.locator('.dg-wrap .side').isVisible(), `${Math.round(box.width)}×${Math.round(box.height)}`);
    await page.locator('.dg-node[data-id="Shipment"]').click(); await page.waitForSelector('.side h3:text-is("Shipment")');
    await shot('diagram-maximised');
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    ok('Esc restores the normal size', (await page.locator('.dg-max').count()) === 0 && (await page.locator('button:has-text("Maximise")').count()) === 1);
  });

  await step('classes & properties', async () => {
    await page.click('.tabs button:text-is("Classes & properties")'); await page.waitForSelector('table.tbl tr.click');
    await shot('model');
    await page.fill('input[type=search]', 'gift'); await page.waitForTimeout(200);
    ok('filter finds the new class', (await page.locator('table.tbl tr.click').count()) === 1);
    await page.fill('input[type=search]', '');
    await page.click('.seg button:has-text("Rules")'); await page.waitForSelector('td:has-text("never overlap")');
    ok('rules are listed', true);
  });

  await step('use cases', async () => {
    await page.click('.tabs button:text-is("Use cases")'); await page.waitForSelector('details.uc');
    await page.locator('details.uc summary').first().click();
    await page.waitForSelector('details.uc[open] .dg-svg .dg-node');
    ok('a use case shows its diagram', (await drawn('details.uc[open] .dg-svg')) === 4);
    await shot('usecase');
  });

  await step('test bed', async () => {
    await page.click('.tabs button:text-is("Test bed")'); await page.waitForSelector('textarea');
    await page.fill('textarea', 'Track warranty claims for the products customers bought');
    await page.click('button:text-is("🧪 Run test")');
    await page.waitForSelector('.ring', { timeout: 30000 });
    const txt = await page.innerText('.card:has(.ring)');
    ok('test result shows coverage, verdict and the server-side check', txt.includes('25%') && txt.includes('Not addressed') && txt.includes('Checked:'), txt.slice(0, 60).replace(/\n/g, ' '));
    ok('test diagram shows the proposed class as a gap', (await page.locator('.dg-node.s-gap').count()) === 1);
    await shot('test-result');
    await page.evaluate(() => document.querySelector('.ring').scrollIntoView()); await shot('test-gauge');
    const changes = page.locator('table.changes tbody tr');
    ok('the test proposes itemised additions with checkboxes', (await changes.count()) === 2 && (await page.innerText('table.changes')).includes('Needs: Add class “Warranty”'));
    await changes.nth(0).locator('input').uncheck();                    // unticking the class unticks the relationship that needs it
    ok('unticking a class unticks what depends on it', !(await changes.nth(1).locator('input').isChecked()) && await page.locator('button:has-text("Apply 0 selected")').isDisabled());
    await changes.nth(1).locator('input').check();                      // ticking the relationship brings its class back
    ok('ticking a relationship ticks the class it needs', await changes.nth(0).locator('input').isChecked());
    await page.locator('table.changes').scrollIntoViewIfNeeded(); await shot('test-changes');
    await page.click('button:has-text("Apply 2 selected changes")');
    await page.waitForSelector('.toast:has-text("2 changes applied")');
    await page.click('button:text-is("↻ Test again")');
    await page.waitForSelector('.ring:has-text("100%")', { timeout: 30000 });
    const after = await page.innerText('.card:has(.ring)');
    ok('re-test checks the same requirements and shows the comparison', after.includes('Re-test of the same 4 requirements: 25%') && after.includes('3 improved, 0 got worse') && after.includes('Before'), after.slice(0, 80).replace(/\n/g, ' '));
    await page.locator('.banner:has-text("Re-test of the same")').scrollIntoViewIfNeeded(); await shot('test-compare');
    await page.evaluate(() => window.scrollTo(0, 0)); await shot('test-bed');
  });

  await step('quality & reasoner', async () => {
    await page.click('.tabs button:text-is("Quality & reasoning")'); await page.waitForSelector('button:has-text("built-in reasoner")');
    // plant two contradictions, as a person editing by hand might
    await page.evaluate(async () => { const id = location.hash.split('/')[2]; await fetch(`/api/ontologies/${id}/edit`, { method: 'POST', headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch: { rules: [{ id: 'R9', kind: 'disjoint', statement: 'A store is never a sales channel.', applies_to: ['Store', 'SalesChannel'] }],
        properties: [{ id: 'operates', kind: 'object', domain: 'Party', range: 'Store', inverse: 'operatedBy', definition: 'A store the party runs.' },
                     { id: 'operatedBy', kind: 'object', domain: 'Party', range: 'Party', inverse: 'operates', definition: 'Who runs it.' }] }, note: 'planted' }) }); });
    await page.click('button:has-text("built-in reasoner")');
    await page.waitForSelector('.banner.bad:has-text("logical problem")', { timeout: 30000 });
    const fixRows = page.locator('table.changes tbody tr');
    ok('the reasoner proposes changes with alternatives, recommended ones ticked', (await fixRows.count()) === 5 && (await page.locator('table.changes input:checked').count()) === 2 && (await page.innerText('table.changes')).includes('alternative'));
    await page.locator('table.changes').scrollIntoViewIfNeeded(); await shot('reasoner-fixes');
    await page.click('button:has-text("Apply 2 selected changes")');
    await page.waitForSelector('.banner.good:has-text("Logically consistent")', { timeout: 30000 });
    ok('after applying the reasoner\'s fixes the ontology is consistent', true);
    await page.click('button:has-text("Propose fixes with AI")'); await waitJob();
    await page.waitForSelector('text=Problems addressed (2)');
    const fx = await page.innerText('.card:has-text("3 · Fix proposals")');
    ok('AI fix proposals: add, change and delete items, each with a reason', fx.includes('Add') && fx.includes('Change class “Brand”') && fx.includes('Delete relationship') && fx.includes('Promotions are out of scope'));
    await page.locator('.card:has-text("3 · Fix proposals") table.changes').scrollIntoViewIfNeeded(); await shot('ai-fixes');
    await page.click('button:has-text("Run a gap review")'); await waitJob();
    await page.waitForSelector('text=Gaps found (1)');
    ok('AI gap review lists its proposed changes as items', (await page.innerText('.card:has-text("4 · Gap review")')).includes('Add class “Gift card”'));
    await page.evaluate(() => window.scrollTo(0, 0)); await shot('quality');
  });

  await step('downloads', async () => {
    for (const [label, ext] of [['Handbook (PDF)', 'pdf'], ['Presentation (PowerPoint)', 'pptx'], ['Workbook (Excel)', 'xlsx'], ['Turtle (.ttl)', 'ttl']]) {
      await page.click('button:text-is("⬇ Download")');
      const [d] = await Promise.all([page.waitForEvent('download', { timeout: 40000 }), page.locator('.pop button', { hasText: label }).click()]);
      const file = path.join(OUT, 'sample.' + ext); await d.saveAs(file);
      ok(`download ${ext}`, d.suggestedFilename().endsWith('.' + ext) && fs.statSync(file).size > 5000, `${fs.statSync(file).size} bytes`);
    }
    await page.click('button:text-is("⬇ Download")'); await shot('download-menu'); await page.click('h1');
  });

  await step('new ontology from use cases, documents and a database file', async () => {
    await page.goto(BASE + '/#/library'); await page.waitForSelector('button:text-is("＋ New folder")');
    await page.click('button:text-is("＋ New folder")'); await page.locator('.modal input[type=text]').fill('Lending'); await page.click('.modal button:text-is("Save")');
    await page.waitForSelector('.tree a:has-text("Lending")'); await page.click('.tree a:has-text("Lending")');
    await page.waitForSelector('h1:text-is("Lending")');
    await page.click('button:text-is("👥 Access")'); await page.waitForSelector('.modal td:has-text("riya@example.com")');
    await page.locator('.modal tr:has-text("riya@example.com") select').selectOption('view'); await shot('folder-access');
    await page.click('.modal button:text-is("Save access")'); await page.waitForSelector('.modal', { state: 'detached' });
    await page.click('button:text-is("＋ New ontology")');
    await page.locator('.modal input[type=text]').first().fill('Tractor loans'); await shot('wizard-basics');
    await page.click('.steps button:has-text("Use cases")');
    await page.locator('.modal textarea').first().fill('Which dealers have the most rejected applications?\nShow disbursements older than 90 days.');
    await shot('wizard-needs');
    await page.click('.steps button:has-text("Database")');
    fs.writeFileSync(path.join(OUT, 'schema.sql'), 'CREATE TABLE customers(id int primary key, name text);\nCREATE TABLE loans(id int primary key, customer_id int references customers(id), amount numeric);');
    fs.writeFileSync(path.join(OUT, 'policy.txt'), 'Gift vouchers expire after twelve months. A loan needs a sanction before disbursement.');
    await page.locator('.modal .drop input[type=file]').first().setInputFiles([path.join(OUT, 'schema.sql'), path.join(OUT, 'policy.txt')]);
    await page.waitForSelector('.modal .item:has-text("schema.sql")'); await shot('wizard-sources');
    await page.click('.steps button:has-text("Build")'); await shot('wizard-build');
    await page.click('button:has-text("Create and build with AI")');
    await page.waitForSelector('.joblog', { timeout: 15000 }); await shot('building');
    await page.waitForSelector('.prose', { timeout: 60000 });
    ok('ontology built from use cases + schema + documents', (await page.innerText('h1')) === 'Tractor loans' && (await page.locator('.kpi').count()) === 6);
    await page.click('.tabs button:text-is("Use cases")'); await page.waitForSelector('details.uc');
    ok('the owner\'s use cases come first, marked as required', (await page.locator('details.uc .badge.info:has-text("Required by the owner")').count()) === 2);
    await page.click('.tabs button:has-text("Sources")'); await page.waitForSelector('td:has-text("schema.sql")'); await shot('sources');
    ok('sources are listed with what was read', (await page.innerText('table.tbl')).includes('Database schema'));
    await page.click('.tabs button:text-is("Versions")'); await page.waitForSelector('.item:has-text("Version 1")'); await shot('versions');
    await page.goto(BASE + '/#/library'); await page.waitForSelector('.tree a:has-text("Lending")'); await shot('library');
    ok('library shows the folder with its ontology', (await page.innerText('.tree a:has-text("Lending")')).includes('1'));
  });

  await step('pre-built library: browse, preview, copy, duplicate', async () => {
    await page.goto(BASE + '/#/templates'); await page.waitForSelector('h1:text-is("Pre-built library")'); await page.waitForSelector('.ocard');
    const all = await page.locator('.ocard').count();
    ok('pre-built library lists ontologies across industries', all >= 22 && (await page.locator('.steps button').count()) >= 19, `${all} ontologies`);
    await shot('prebuilt');
    await page.fill('input[type=search]', 'tractor'); await page.waitForTimeout(200);
    ok('search narrows the library', (await page.locator('.ocard').count()) >= 1 && (await page.locator('.ocard').count()) < all);
    await page.fill('input[type=search]', '');
    await page.click('.steps button:text-is("Banking & financial services")'); await page.waitForTimeout(200);
    ok('industry filter', (await page.locator('.ocard').count()) === 2);
    await page.click('.ocard:has-text("Lending and loan origination")');
    await page.waitForSelector('.modal .dg-svg .dg-node');
    ok('preview shows the diagram, standards and use cases', (await drawn('.modal .dg-svg')) >= 40 && (await page.innerText('.modal')).includes('Dealer rejection rate'), `${await drawn('.modal .dg-svg')} boxes`);
    await shot('prebuilt-preview');
    await page.click('.modal button:text-is("＋ Use this ontology")');
    await page.waitForSelector('.modal h2:has-text("Use “Lending")');
    await page.locator('.modal input[type=text]').fill('Agri lending'); await shot('prebuilt-use');
    await page.click('.modal button:text-is("Create my copy")');
    await page.waitForSelector('h1:text-is("Agri lending")'); await page.waitForSelector('.prose');
    ok('the copy opens as my own ontology, marked with where it came from', (await page.innerText('.ws-head')).includes('Pre-built library: Lending and loan origination') && (await page.innerText('.ws-head')).includes('Owner'));
    await shot('prebuilt-copy');
    await page.click('button:text-is("⧉ Duplicate")'); await page.waitForSelector('.modal h2:text-is("Duplicate this ontology")');
    await page.locator('.modal input[type=text]').fill('Agri lending v2'); await shot('duplicate');
    await page.click('.modal button:text-is("Create copy")');
    await page.waitForSelector('h1:text-is("Agri lending v2")');
    ok('duplicate creates a separate copy', (await page.innerText('.ws-head')).includes('Copy of Agri lending'));
  });

  await step('usage dashboard and appearance', async () => {
    await page.goto(BASE + '/#/usage'); await page.waitForSelector('svg.chart .bar');
    const kp = await page.innerText('.kpis');
    ok('usage dashboard shows jobs, tokens, cost and a chart', /AI jobs\s*\n\s*5/.test(kp) && kp.includes('Estimated cost'), kp.replace(/\n/g, ' ').slice(0, 80));
    ok('admin can filter by person', (await page.locator('select:has(option:text-is("All users"))').count()) === 1);
    await shot('usage');
    await page.goto(BASE + '/#/admin/appearance'); await page.waitForSelector('.swatch');
    await page.locator('.card input[type=text]').first().fill('Acme Ontology Hub'); await page.click('.swatch[data-accent="teal"]');
    await page.click('button:text-is("Save appearance")'); await page.waitForSelector('.toast:has-text("Appearance saved")');
    const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
    ok('appearance: name and accent colour apply at once', (await page.innerText('.nav .brand')).includes('Acme Ontology Hub') && accent === '#0e7c86', accent);
    await shot('appearance');
    await page.click('button:has-text("Theme")'); await page.goto(BASE + '/#/library'); await page.waitForSelector('.ocard'); await shot('dark');
    ok('dark theme', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
    await page.click('button:has-text("Theme")');
    await page.goto(BASE + '/#/admin/settings'); await page.waitForSelector('button:text-is("Save settings")'); await shot('settings');
    await page.goto(BASE + '/#/admin/audit'); await page.waitForSelector('td.mono'); await shot('audit');
    await page.goto(BASE + '/#/help'); await page.waitForSelector('.help-body section'); await shot('help');
    ok('help opens with its sections', (await page.locator('.help-toc a').count()) >= 10, `${await page.locator('.help-toc a').count()} sections`);
    ok('no literal "null" or "undefined" in the help', !/\bundefined\b/.test(await page.innerText('.help-body')));
  });

  await step('viewer: read only, folder access', async () => {
    const pw = await (async () => {     // reset the viewer's password through the admin API to learn it
      const users = await page.evaluate(async () => (await fetch('/api/admin/users')).json());
      const id = users.find(u => u.email === 'riya@example.com').id;
      return page.evaluate(async id => (await (await fetch(`/api/admin/users/${id}/reset-password`, { method: 'POST', headers: { 'X-Requested-With': 'fetch' } })).json()).temporary_password, id);
    })();
    const c2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p2 = await c2.newPage();
    p2.on('pageerror', e => errors.push('viewer pageerror: ' + e.message));
    await p2.goto(BASE); await p2.fill('input[type=email]', 'riya@example.com'); await p2.fill('input[type=password]', pw); await p2.click('button:text-is("Sign in")');
    await p2.waitForSelector('h2:text-is("Choose a new password")');
    const f = p2.locator('input[type=password]'); await f.nth(0).fill(pw); await f.nth(1).fill('Viewer-Passw0rd!'); await f.nth(2).fill('Viewer-Passw0rd!');
    await p2.click('button:text-is("Change password")'); await p2.waitForSelector('.ocard');
    const names = await p2.locator('.ocard h3').allInnerTexts();
    ok('viewer sees the shared sample and the ontology in the folder she was given', names.length === 2 && names.includes('Tractor loans'), names.join(', '));
    await p2.goto(BASE + '/#/templates'); await p2.waitForSelector('h1:text-is("Pre-built library")'); await p2.waitForSelector('.ocard'); await p2.click('.ocard >> nth=0'); await p2.waitForSelector('.modal .dg-svg .dg-node');
    ok('viewer can preview the pre-built library but not copy from it', (await p2.locator('.modal button:text-is("＋ Use this ontology")').count()) === 0);
    await p2.keyboard.press('Escape'); await p2.goto(BASE + '/#/library'); await p2.waitForSelector('.ocard');
    ok('viewer has no create buttons and no Admin menu', (await p2.locator('button:text-is("＋ New ontology")').count()) === 0 && (await p2.locator('.nav a:has-text("Admin")').count()) === 0);
    await p2.click('.ocard:has-text("Tractor loans")'); await p2.waitForSelector('.prose');
    ok('viewer: no AI menu or settings, but can download', (await p2.locator('button:text-is("✨ AI")').count()) === 0 && (await p2.locator('button:text-is("⬇ Download")').count()) === 1);
    await p2.click('.tabs button:text-is("Diagram")'); await p2.waitForSelector('.dg-node[data-id="Order"]'); await p2.locator('.dg-node[data-id="Order"]').click();
    await p2.waitForSelector('.side h3:text-is("Order")');
    ok('viewer: diagram is read-only', (await p2.locator('.side button:text-is("✎ Edit")').count()) === 0 && (await p2.locator('button:text-is("＋ Class")').count()) === 0);
    await p2.goto(BASE + '/#/usage'); await p2.waitForSelector('h1:text-is("My AI usage")');
    ok('viewer sees only her own usage (none)', (await p2.innerText('.kpis')).match(/AI jobs\s*\n\s*0/) !== null);
    await c2.close();
  });

  console.log(errors.length ? 'console errors:\n' + [...new Set(errors)].join('\n') : 'console errors: none');
  await browser.close();
})();
