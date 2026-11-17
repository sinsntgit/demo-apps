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
    ok('a self-hosted model without prices is not flagged (it may be free)', !(await page.innerText('.item:has-text("Stand-in model")')).includes('no prices — cost not counted'));
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
    await page.click('.steps button:has-text("More documents")');
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

  await step('database data source form: SingleStore and Snowflake', async () => {
    await page.goto(BASE + '/#/datasources'); await page.waitForSelector('h1:text-is("Data sources")');
    await page.click('button:text-is("＋ New data source")'); await page.click('.modal .seg button:has-text("Connect a database")');
    const opts = await page.locator('.modal select option').allTextContents();
    ok('database types include SingleStore and Snowflake', opts.includes('SingleStore') && opts.includes('Snowflake') && opts.includes('Microsoft SQL Server'));
    await page.selectOption('.modal select', 'snowflake');
    ok('Snowflake asks for account, warehouse and role, not a port', await page.locator('.modal label.field:has-text("Account identifier")').isVisible()
      && await page.locator('.modal label.field:has-text("Warehouse")').isVisible() && !(await page.locator('.modal label.field:has-text("Port")').isVisible()));
    await shot('datasource-snowflake');
    await page.keyboard.press('Escape');
  });

  await step('data sources: set up once, profile, describe, build from it', async () => {
    fs.writeFileSync(path.join(OUT, 'dealers.csv'), 'id,name,region\n' + Array.from({ length: 40 }, (_, i) => `${i + 1},Dealer ${i + 1},${i % 2 ? 'North' : 'South'}`).join('\n'));
    fs.writeFileSync(path.join(OUT, 'applications.csv'), 'app_no;dealer_id;amount;stage\n' + Array.from({ length: 200 }, (_, i) => `A${i + 1};${(i % 40) + 1};${1000 * (i + 1)};${['Submitted', 'Sanctioned', 'Rejected'][i % 3]}`).join('\n'));
    fs.writeFileSync(path.join(OUT, 'credit-policy.md'), '# Credit policy\nEvery application is sanctioned or rejected by the credit desk. A dealer sources applications.');
    await page.goto(BASE + '/#/datasources'); await page.waitForSelector('h1:text-is("Data sources")');
    await page.click('button:text-is("＋ New data source")');
    await page.locator('.modal input[type=text]').first().fill('Dealer lending files');
    await page.locator('.modal textarea').first().fill('Applications sourced by tractor dealers.');
    await shot('datasource-new');
    await page.click('.modal button:text-is("Create")');
    await page.waitForSelector('h1:has-text("Dealer lending files")');
    await page.click('.tabs button:has-text("Add files")');
    await page.locator('.drop input[type=file]').first().setInputFiles([path.join(OUT, 'dealers.csv'), path.join(OUT, 'applications.csv'), path.join(OUT, 'credit-policy.md')]);
    await page.waitForSelector('.tabs button:has-text("Tables 2")', { timeout: 20000 });
    await page.click('.tabs button:has-text("Tables 2")');
    const tbl = await page.innerText('table.tbl');
    ok('datasets are profiled, with a join inferred across two files and code lists found', tbl.includes('dealer_id → dealers.id (inferred)') && tbl.includes('stage'), tbl.replace(/\n/g, ' ').slice(0, 120));
    await shot('datasource-tables');
    await page.click('tr.click:has-text("applications")'); await page.waitForSelector('.modal h2:text-is("Table applications")');
    const prof = await page.innerText('.modal');
    ok('the table profile shows roles and values', prof.includes('code list') && prof.includes('Sanctioned') && prof.includes('reference'));
    await page.locator('.modal textarea').fill('Loan applications sourced by dealers');
    await page.locator('.modal tr:has-text("stage") input[type=text]').fill('Where the application is in the credit process');
    await shot('datasource-profile');
    await page.click('.modal button:text-is("Save descriptions")'); await page.waitForSelector('.modal', { state: 'detached' });
    ok('the business description is saved', (await page.innerText('table.tbl')).includes('Loan applications sourced by dealers'));
    await page.click('.tabs button:has-text("Documentation")');
    await page.locator('.card:has-text("Notes") textarea').fill('Stage: Submitted = received from the dealer; Sanctioned = approved by the credit desk.');
    await page.click('button:text-is("Save documentation")'); await page.waitForSelector('.toast:has-text("Documentation saved")');
    await page.click('button:has-text("Describe with AI")'); await page.click('.modal button:text-is("Describe")');
    await page.waitForSelector('.card:has-text("What the AI understood")', { timeout: 30000 });
    const understood = await page.innerText('.card:has-text("What the AI understood")');
    ok('Describe with AI: summary, terms and open questions', understood.includes('Drafted summary') && understood.includes('Sanction') && understood.includes('Not clear from the documentation'));
    await shot('datasource-understood');
    await page.click('.tabs button:has-text("Tables")');
    const tb = await page.innerText('table.tbl');
    ok('AI drafts are marked, and the description a person wrote is kept', tb.includes('AI draft') && tb.includes('Loan applications sourced by dealers'));
    await page.click('.tabs button:has-text("Documentation")'); await shot('datasource-docs');
    await page.click('button:has-text("Build an ontology from this")');
    await page.waitForSelector('.modal .banner:has-text("Building from the data source")');
    ok('the wizard opens with the data source chosen', (await page.inputValue('.modal input[type=text] >> nth=0')) === 'Dealer lending files');
    await page.waitForSelector('.modal .card:has-text("Build from your data") input[type=checkbox]:checked');
    ok('the data source is offered and ticked on the first step of the wizard', true);
    await shot('datasource-wizard');
    await page.click('.steps button:has-text("Build")'); await page.click('button:has-text("Create and build with AI")');
    await page.waitForSelector('.joblog', { timeout: 15000 });
    await page.waitForSelector('.prose', { timeout: 60000 });
    ok('an ontology is built from scratch from the data source alone', (await page.innerText('h1')) === 'Dealer lending files');
    await page.click('.tabs button:has-text("Sources")'); await page.waitForSelector('.card:has-text("Data sources from the library") a:has-text("Dealer lending files")');
    await shot('ontology-datasources');
    ok('the ontology lists the data source it uses', true);
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
    ok('usage dashboard shows jobs, tokens, cost and a chart', /AI jobs\s*\n\s*7/.test(kp) && kp.includes('Estimated cost'), kp.replace(/\n/g, ' ').slice(0, 80));
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

  await step('knowledge graph: mapping, build, query, answer from the data', async () => {
    const oid = await page.evaluate(async () => {
      const H = { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' };
      const lib = await (await fetch('/api/library')).json();
      const o = lib.ontologies.find(x => x.name.startsWith('Sample:'));
      const ds = await (await fetch('/api/datasources', { method: 'POST', headers: H, body: JSON.stringify({ name: 'Shop data', kind: 'files', description: 'Web shop exports' }) })).json();
      const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n');
      const files = {
        'customers.csv': 'customer_id,full_name,email,since,tier\n' + rows(30, i => `${i},Customer ${i},c${i}@mail.example,2023-0${i % 9 + 1}-1${i % 9},${['Gold', 'Silver'][i % 2]}`),
        'orders.csv': 'order_id,order_no,customer_id,order_date,total,status\n' + rows(80, i => `${i},O-${String(i).padStart(4, '0')},${i % 30 + 1},2025-03-${String(i % 28 + 1).padStart(2, '0')} 10:30,${(i * 12.5).toFixed(2)},${['Placed', 'Paid', 'Shipped', 'Delivered'][i % 4]}`),
        'order_lines.csv': 'line_id,order_id,product_id,qty,price\n' + rows(200, i => `${i},${i % 80 + 1},${i % 12 + 1},${i % 4 + 1},${(9.99 + i).toFixed(2)}`),
        'products.csv': 'product_id,sku,product_name\n' + rows(12, i => `${i},SKU${String(i).padStart(3, '0')},${['Tea', 'Coffee', 'Mug', 'Kettle', 'Grinder', 'Filter'][i % 6]} ${i}`) };
      const fd = new FormData();
      for (const [n, t] of Object.entries(files)) fd.append('files', new Blob([t], { type: 'text/csv' }), n);
      await fetch(`/api/datasources/${ds.id}/files`, { method: 'POST', headers: { 'X-Requested-With': 'fetch' }, body: fd });
      await fetch(`/api/ontologies/${o.id}/datasources`, { method: 'POST', headers: H, body: JSON.stringify({ data_source_id: ds.id }) });
      return o.id;
    });
    await page.goto(`${BASE}/#/o/${oid}/graph`); await page.waitForSelector('h2:text-is("Mapping")');
    ok('the Knowledge graph tab offers to map the data', (await page.locator('button:text-is("✨ Propose with AI")').count()) === 1);
    await page.click('button:text-is("✨ Propose with AI")'); await page.click('.modal button:text-is("Propose")');
    await waitJob(); await page.waitForSelector('td:has-text("order_lines")', { timeout: 20000 });
    const mapTxt = await page.innerText('.card:has(h2:text-is("Mapping"))');
    ok('the AI mapping is checked and shown as drafts', mapTxt.includes('draft') && mapTxt.includes('placed by → Customer') && mapTxt.includes('left out of the mapping'), mapTxt.replace(/\n/g, ' ').slice(0, 160));
    await shot('graph-mapping');
    await page.click('tr:has-text("order_lines") button:text-is("Edit")'); await page.waitForSelector('.modal h3:text-is("Relationships")');
    ok('the mapping form shows columns and joins', (await page.innerText('.modal')).includes('quantity') && (await page.locator('.modal select').count()) > 6);
    await shot('graph-map-form');
    await page.click('.modal button:text-is("Cancel")');
    await page.click('button:text-is("▶ Build the knowledge graph")'); await waitJob();
    await page.waitForSelector('.kpi:has-text("Records")', { timeout: 30000 });
    const kp = await page.innerText('.kpis');
    ok('the graph is built from the uploaded files', /Records\s*\n\s*322/.test(kp), kp.replace(/\n/g, ' '));
    ok('personal columns are left out and said so', (await page.innerText('.card:has(h2:text-is("What is in the graph"))')).includes('look like personal data'));
    await shot('graph-built');
    await page.selectOption('.card:has(h2:has-text("Ask the graph")) select', { label: 'Records of Order' });
    await page.click('button:text-is("▶ Run query")'); await page.waitForSelector('.card:has(h2:has-text("Ask the graph")) .dg-svg .dg-node');
    const res = await page.innerText('.card:has(h2:has-text("Ask the graph"))');
    ok('a console query returns rows and a picture of the records', res.includes('O-0001') && (await drawn('.dg-svg')) > 5);
    await page.locator('.card:has(h2:has-text("Ask the graph")) .dg-svg').scrollIntoViewIfNeeded(); await shot('graph-console');
    await page.click('.tabs button:text-is("Test bed")'); await page.waitForSelector('label:has-text("Also answer it from the knowledge graph") input:checked');
    await page.fill('textarea', 'Show orders by customer with their totals and status');
    await page.click('button:text-is("🧪 Run test")'); await page.waitForSelector('h3:text-is("Answer from your data")', { timeout: 30000 });
    const ans = await page.locator('.card:has(h3:text-is("Answer from your data"))').last().innerText();
    ok('the test bed answers the use case from the data', ans.includes('Answered from the data') && ans.includes('O-0001') && ans.includes('Customer'), ans.replace(/\n/g, ' ').slice(0, 160));
    ok('the records behind the answer are drawn', (await drawn('.dg-svg')) > 5);
    await page.locator('.card:has(h3:text-is("Answer from your data"))').last().evaluate(e => e.scrollIntoView()); await shot('test-data-answer');
    ok('the history shows the answer from the data', (await page.innerText('table:has(th:text-is("From the data"))')).includes('Answered from the data'));
  });

  await step('knowledge graph from documents: extract, review, merge, build, explore', async () => {
    const LEGAL = {"format": "ontostudio-ontology", "meta": {"name": "Tax cases", "namespace": "https://example.org/ontology/tax-cases#", "prefix": "tax"}, "modules": [{"id": "Law", "name": "Law"}], "classes": [{"id": "Party", "label": "Party", "parent": null, "module": "Law", "definition": "A Party."}, {"id": "Organization", "label": "Organization", "parent": "Party", "module": "Law", "definition": "A Organization."}, {"id": "Taxpayer", "label": "Taxpayer", "parent": "Organization", "module": "Law", "definition": "A Taxpayer."}, {"id": "Court", "label": "Court", "parent": "Organization", "module": "Law", "definition": "A Court."}, {"id": "LegalResource", "label": "LegalResource", "parent": null, "module": "Law", "definition": "A LegalResource."}, {"id": "Act", "label": "Act", "parent": "LegalResource", "module": "Law", "definition": "A Act."}, {"id": "Provision", "label": "Provision", "parent": "LegalResource", "module": "Law", "definition": "A Provision."}, {"id": "JudicialDecision", "label": "JudicialDecision", "parent": "LegalResource", "module": "Law", "definition": "A JudicialDecision."}, {"id": "OpinionOutcome", "label": "OpinionOutcome", "parent": null, "module": "Law", "definition": "A OpinionOutcome."}], "properties": [{"id": "decidedByCourt", "kind": "object", "domain": "JudicialDecision", "range": "Court", "cardinality": "0..1"}, {"id": "interpretsResource", "kind": "object", "domain": "LegalResource", "range": "LegalResource", "inverse": "interpretedByResource"}, {"id": "interpretedByResource", "kind": "object", "domain": "LegalResource", "range": "LegalResource", "inverse": "interpretsResource"}, {"id": "involvesParty", "kind": "object", "domain": "JudicialDecision", "range": "Party"}, {"id": "hasDecisionOutcome", "kind": "object", "domain": "JudicialDecision", "range": "OpinionOutcome", "cardinality": "0..1"}, {"id": "hasCaseName", "kind": "data", "domain": "JudicialDecision", "range": "string"}, {"id": "hasDecisionDate", "kind": "data", "domain": "JudicialDecision", "range": "date"}, {"id": "amountInDispute", "kind": "data", "domain": "JudicialDecision", "range": "decimal"}], "individuals": [{"id": "AssesseeFavoured", "type": "OpinionOutcome", "label": "Assessee favoured"}, {"id": "RevenueFavoured", "type": "OpinionOutcome", "label": "Revenue favoured"}], "rules": [{"id": "R1", "kind": "constraint", "statement": "Every decision names its court."}]};
    const JUDGMENT = "IN THE HIGH COURT AT CALCUTTA\nSpecial Jurisdiction (Income Tax)\nC.I.T., KOLKATA-IV Versus M/S. COATS OF INDIA LTD.\nDate: 8th September, 2008.\nThe only question which is tried to be pressed before us is as per provision of Section 47(iv) of Income Tax Act whether the transfer of capital asset by a company to its wholly subsidiary company could be regarded as transfer.\n\f\nIn the process of such transfer a surplus amount of Rs. 19,14,55,804/- was credited to the accounts of the assessee.\nHence the appeal is not admitted.\n";
    const oid = await page.evaluate(async ([legal, judgment]) => {
      const H = { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' };
      const fd = new FormData(); fd.append('file', new Blob([JSON.stringify(legal)], { type: 'application/json' }), 'tax-cases.json');
      const o = await (await fetch('/api/ontologies/import', { method: 'POST', headers: { 'X-Requested-With': 'fetch' }, body: fd })).json();
      const ds = await (await fetch('/api/datasources', { method: 'POST', headers: H, body: JSON.stringify({ name: 'Case files', kind: 'files', description: 'Judgments and notes' }) })).json();
      const f2 = new FormData();
      f2.append('files', new Blob([judgment], { type: 'text/plain' }), 'coats-judgment.txt');
      f2.append('files', new Blob(['# Note\nCoats of India Limited won in the Calcutta High Court on section 47(iv).'], { type: 'text/markdown' }), 'coats-note.md');
      await fetch(`/api/datasources/${ds.id}/files`, { method: 'POST', headers: { 'X-Requested-With': 'fetch' }, body: f2 });
      await fetch(`/api/ontologies/${o.id}/datasources`, { method: 'POST', headers: H, body: JSON.stringify({ data_source_id: ds.id }) });
      return o.id;
    }, [LEGAL, JUDGMENT]);
    await page.goto(`${BASE}/#/o/${oid}/graph`); await page.waitForSelector('h2:text-is("From documents")');
    await page.locator('.card:has(h2:text-is("From documents")) thead input[type=checkbox]').check();
    await page.click('button:text-is("✨ Extract with AI")'); await page.click('.modal button:text-is("Extract")');
    await waitJob(); await page.waitForSelector('h3:has-text("Entities (")', { timeout: 20000 });
    const rev = await page.innerText('.card:has(h2:text-is("From documents"))');
    ok('extracted entities are listed with their quotes and pages, to review', rev.includes('Coats of India Ltd') && rev.includes('p. 2') && rev.includes('to review'), rev.replace(/\n/g, ' ').slice(0, 160));
    ok('a possible duplicate is offered for merging', rev.includes('Possibly the same') && rev.includes('Calcutta High Court'));
    await page.locator('summary:has-text("rejected by the application")').click();
    ok('what the checks rejected is listed with the reason', (await page.innerText('.card:has(h2:text-is("From documents"))')).includes('not in the document'));
    await shot('graph-documents');
    await page.click('button:has-text("Merge into")'); await page.waitForSelector('.toast:has-text("Merged.")');
    await page.waitForSelector('h3:has-text("Entities (4)")');
    await page.click('button:text-is("Tick all shown")'); await page.click('button:text-is("✓ Accept ticked")');
    await page.waitForSelector('.toast:has-text("accepted")');
    await page.waitForSelector('button:text-is("▶ Build the knowledge graph")'); await page.click('button:text-is("▶ Build the knowledge graph")'); await waitJob();
    await page.waitForSelector('h2:text-is("Explore records")', { timeout: 20000 });
    await page.fill('input[placeholder="Find a record by name…"]', 'coats'); await page.click('button:text-is("Find")');
    await page.click('button:has-text("C.I.T., Kolkata-IV v. Coats")'); await page.waitForSelector('h3:text-is("Linked records")');
    const rec = await page.innerText('.card:has(h2:text-is("Explore records"))');
    ok('the explorer shows a record, its links and the words of the document it comes from', rec.includes('High Court at Calcutta') && rec.includes('Sources in the documents') && rec.includes('COATS OF INDIA'), rec.replace(/\n/g, ' ').slice(0, 160));
    await page.click('.card:has(h2:text-is("Explore records")) button:text-is("High Court at Calcutta")'); await page.waitForSelector('button:text-is("← Back")');
    ok('following a link opens the linked record', (await page.innerText('.card:has(h2:text-is("Explore records")) h3')).includes('High Court at Calcutta'));
    await page.click('button:text-is("← Back")'); await page.waitForSelector('h3:has-text("C.I.T., Kolkata-IV")');
    await page.locator('.card:has(h2:text-is("Explore records"))').evaluate(e => e.scrollIntoView()); await shot('graph-explorer');
    ok('the graph can be downloaded and rebuilt on a schedule', (await page.locator('a:text-is("⬇ Graph (Turtle)")').count()) === 1 && (await page.locator('select:has(option:text-is("every night (02:00)"))').count()) === 1);
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
