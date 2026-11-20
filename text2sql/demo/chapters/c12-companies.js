const { sleep, vo } = require('../lib');
const path = require('path');
const state = require('../out/state.json');
const FIX = path.join(__dirname, '..', '..', 'tests', 'e2e', 'fixtures');
exports.step = '12 · Separate companies';
exports.route = '/#/admin/companies';
exports.run = async r => {
  const signOut = async () => { await r.click('button:text-is("Sign out")'); await r.page.waitForSelector('input[type=email]'); await sleep(700); };
  await r.intro('One installation. Many companies.', 'Each with its own people, data, reports and logo.', 'Chapter 12', 3200, async () => { await r.page.waitForSelector('.tbl-wrap'); },
    vo('One installation can serve several companies. Each one is completely separate: its own people, data, reports, settings and logo.'));
  await r.say('The platform administrator sees every company, its size and its A I spend — but never its data.', async () => {
    await r.ring('.tbl-wrap'); await sleep(2600); await r.ring(null, false);
  }, 6200);
  r.mark('hl-start');
  await r.say('Add a company, with its first administrator.', async () => {
    await r.click('text=＋ Add company'); await r.page.waitForSelector('.modal');
    await r.type('.modal label.field:has-text("Company name") input', 'Globex Retail', 45);
    await r.type('.modal input[type=email]', 'chen.wei@globex.example', 35);
    await r.type('.modal label.field:has-text("Name") >> nth=1 >> input', 'Chen Wei', 45); await sleep(500);
    await r.click('.modal footer .primary'); await r.page.waitForSelector('text=Temporary password'); await sleep(2200);
    await r.page.keyboard.press('Escape'); await sleep(600);
  }, 8600);
  await r.say('Give it its own **logo** and its own **PowerPoint template**.', async () => {
    await r.click('tr:has-text("Globex Retail") >> button:text-is("Edit")'); await r.page.waitForSelector('.modal');
    await r.page.locator('.modal label.field:has-text("Logo") input[type=file]').setInputFiles(path.join(__dirname, '..', 'out', 'data_sets', 'globex-logo.png'));
    await r.page.locator('.modal label.field:has-text("PowerPoint template") input[type=file]').setInputFiles(path.join(FIX, 'corporate-template.potx'));
    await sleep(1600);
    await r.click('.modal footer .primary'); await r.page.waitForSelector('.toast:has-text("Saved")'); await sleep(1600);
  }, 7000);
  await r.say('Share an **AI model** with the companies you choose. They use it without ever seeing its key.', async () => {
    await r.nav('admin', 700); await r.tab('AI models', 1100);
    await r.reveal('h2:has-text("Platform models")', 'start', 1000);
    await r.click('.item:has-text("Group model") >> button:text-is("Companies…")'); await r.page.waitForSelector('.modal >> text=Which companies may use'); await sleep(900);
    await r.click('.modal .item:has-text("Globex Retail") input'); await sleep(900);
    await r.click('.modal footer .primary'); await r.page.waitForSelector('.toast'); await sleep(1400);
  }, 9000);
  await r.say('Add people straight into any company, with the role they need…', async () => {
    await r.tab('Companies', 1000);
    await r.click('tr:has-text("Northwind Traders") >> button:text-is("＋ User")'); await r.page.waitForSelector('.modal >> text=Add a user to Northwind Traders');
    await r.type('.modal input[type=email]', 'peter.franken@northwind.example', 30);
    await r.type('.modal label.field:has-text("Name") input', 'Peter Franken', 40);
    await r.select('.modal label.field:has-text("What answers show") select', 'results'); await sleep(600);
    await r.click('.modal footer .primary'); await r.page.waitForSelector('text=Temporary password'); await sleep(1600);
    await r.page.keyboard.press('Escape'); await sleep(500);
  }, 9000);
  await r.say('…and move a person to another company. Their old access is removed, their reports go to an administrator, and it is all audited.', async () => {
    await r.click('tr:has-text("Northwind Traders") >> button:text-is("People…")'); await r.page.waitForSelector('.modal td:has-text("peter.franken")'); await sleep(900);
    await r.click('.modal tr:has-text("peter.franken") >> button:text-is("Move…")'); await r.page.waitForSelector('.modal >> text=to another company'); await sleep(700);
    await r.select('.modal label.field:has-text("Move to") select', String(state.own_company)); await sleep(800);
    await r.ring('.modal .banner.info'); await sleep(2800); await r.ring(null, false);
    await r.click('.modal >> nth=-1 >> footer .primary'); await r.page.waitForSelector('.toast:has-text("moved")'); await sleep(1400);
  }, 12600);
  r.mark('hl-end');
  await r.say('Each company sees only its own name and logo. This is Maria, at Northwind Traders, using the shared AI model.', async () => {
    await r.page.keyboard.press('Escape'); await sleep(400);
    await signOut();
    await r.type('input[type=email]', state.northwind_admin, 26); await r.type('input[type=password]', state.user_password, 26);
    await r.click('button[type=submit]'); await r.page.waitForSelector('.nav'); await sleep(900);
    await r.ring('.nav .company'); await sleep(2200); await r.ring(null, false);
    await r.page.locator('.ask-bar select').first().selectOption({ label: 'Sample: Retail sales' }).catch(() => {});
    await r.type('.composer textarea', 'What is revenue by month?', 40); await r.page.keyboard.press('Enter');
    await r.page.waitForSelector('.run .chart-box canvas', { timeout: 60000 }); await sleep(2200);
  }, 9600);
};
