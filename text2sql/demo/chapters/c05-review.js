const { sleep, vo } = require('../lib');
const state = require('../out/state.json');
exports.step = '05 · Results-only users & review';
exports.route = '/#/admin';
exports.run = async r => {
  const lastQ = () => r.page.locator('.q').last();
  const signOut = async () => { await r.click('button:text-is("Sign out")'); await r.page.waitForSelector('input[type=email]'); await sleep(700); };
  const signIn = async (email, pw) => {
    await r.type('input[type=email]', email, 26); await r.type('input[type=password]', pw, 26);
    await r.click('button[type=submit]'); await r.page.waitForSelector('.nav'); await sleep(900);
  };
  await r.intro('Right level of detail for each person', 'Results only — or SQL and code. And a way to say “this is wrong”.', 'Chapter 5', 3200, undefined,
    vo('Not everyone wants to see S Q L. Choose, person by person, who sees the results only, and who sees the S Q L and code as well. And whoever asks can say when an answer is wrong.'));

  r.mark('hl-start');
  await r.say('In **Users**, an analyst can be set to **results only**: charts, tables and summaries, but never the SQL or the code.', async () => {
    await r.click('text=＋ Add user'); await r.page.waitForSelector('.modal');
    await r.type('.modal input[type=text]', 'Maya Brooks', 40); await sleep(300);
    await r.select('.modal label.field:has-text("What answers show") select', 'results'); await sleep(600);
    await r.ring('.modal label.field:has-text("What answers show")'); await sleep(2400); await r.ring(null, false);
    await r.click('.modal footer >> text=Cancel'); await sleep(500);
  }, 8200);
  await signOut();
  await r.say('Now Maya, who is set to results only, signs in.', async () => {
    await signIn('maya.brooks@acme.example', state.user_password);
    await r.page.locator('.ask-bar select').first().selectOption(String(state.retail)); await sleep(500);
  }, 4200);
  await r.say('She asks a question like anyone else.', async () => {
    await r.type('.composer textarea', 'What is revenue by category?', 45); await r.page.keyboard.press('Enter');
    await r.page.waitForSelector('.run .chart-box canvas', { timeout: 60000 }); await sleep(600); await r.reveal(lastQ(), 'start', 900);
  }, 3600);
  await r.say('She gets the chart, the table and the summary — and no SQL, no code, no way to edit it.', async () => {
    await r.ring('text=How this was answered'); await sleep(2600); await r.ring(null, false);
  }, 6000);
  await r.say('But she can still say whether the answer is right.', async () => {
    await r.reveal('text=Are these results correct?', 'center', 900); await r.ring('text=Are these results correct?'); await sleep(1200); await r.ring(null, false);
  }, 3600);
  await r.say('If it is wrong she must say what is wrong, and why. The report goes to a data steward.', async () => {
    await r.click('button:text-is("✗ No, something is wrong")'); await r.page.waitForSelector('.modal >> text=Report an incorrect answer');
    await r.select('.modal select', 'wrong_numbers');
    await r.click('.modal textarea');
    await r.page.keyboard.type('Accessories look far too high — I think returns are counted as sales.', { delay: 28 }); await sleep(700);
    await r.click('.modal footer .danger'); await r.page.waitForSelector('text=waiting for a data steward'); await sleep(1600);
  }, 9800);
  r.mark('hl-end');
  await signOut();
  await r.say('Now the data steward signs in, and opens the review queue.', async () => {
    await signIn('priya.nair@acme.example', state.user_password);
    await r.nav('training', 1200);
    await r.page.locator('.page-head select').first().selectOption(String(state.retail)); await sleep(900);
    await r.tab('Review queue', 1200);
  }, 5600);
  await r.say('Every reported problem is listed, in the user’s own words.', async () => {
    await r.reveal('.issue:has-text("Accessories look far too high")', 'center', 900);
    await r.ring('text=Accessories look far too high'); await sleep(1600); await r.ring(null, false);
  }, 4200);
  await r.say('The steward fixes the SQL, tests it, and saves it — it becomes training for everyone.', async () => {
    await r.click('.issue:has-text("Accessories look far too high") button:text-is("✎ Fix the SQL")'); await r.page.waitForSelector('.modal >> text=Corrected SQL');
    await r.click('.modal button:text-is("▶ Test")'); await r.page.waitForSelector('.modal >> text=row(s)', { timeout: 40000 }); await sleep(900);
    await r.type('.modal input[placeholder^="Optional"]', 'Fixed: returns are now excluded from revenue.', 30); await sleep(500);
    await r.click('.modal footer .primary'); await r.page.waitForSelector('text=Saved to training'); await sleep(1800);
  }, 9000);
  await signOut();
  await r.say('When Maya signs in again, she sees the outcome, with the steward’s note.', async () => {
    await signIn('maya.brooks@acme.example', state.user_password);
    await r.click('.conv >> nth=0'); await r.page.waitForSelector('text=Corrected by a data steward', { timeout: 30000 }); await sleep(600);
    await r.reveal('text=Corrected by a data steward', 'center', 900); await r.ring('text=Corrected by a data steward'); await sleep(2800); await r.ring(null, false);
  }, 8000);
};
