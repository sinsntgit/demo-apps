const { sleep, vo } = require('../lib');
const state = require('../out/state.json');
exports.step = '11 · Share chats';
exports.run = async r => {
  const lastQ = () => r.page.locator('.q').last();
  const signOut = async () => { await r.click('button:text-is("Sign out")'); await r.page.waitForSelector('input[type=email]'); await sleep(700); };
  const signIn = async (email, pw) => {
    await r.type('input[type=email]', email, 26); await r.type('input[type=password]', pw, 26);
    await r.click('button[type=submit]'); await r.page.waitForSelector('.nav'); await sleep(900);
  };
  await r.intro('Good answers deserve an audience', 'Share a chat — to read, or to add questions.', 'Chapter 11', 3200, async () => {
    await r.page.locator('.ask-bar select').first().selectOption(String(state.retail)); },
    vo('Share a chat with colleagues, a group, or a whole role, to read, or to add their own questions. Everyone still sees only the data they are allowed to see.'));
  await r.say('Ask a question as usual…', async () => {
    await r.type('.composer textarea', 'How does revenue split by region?', 42); await r.page.keyboard.press('Enter');
    await r.page.waitForSelector('.run .chart-box canvas', { timeout: 60000 }); await sleep(700); await r.reveal(lastQ(), 'start', 900);
  }, 3200);
  r.mark('hl-start');
  await r.say('…then share the chat with a group, a role, or individual people: view only, or allowed to ask follow-ups.', async () => {
    await r.click('text=👥 Share chat'); await r.page.waitForSelector('.modal >> text=User groups'); await sleep(700);
    await r.select('.modal .item:has-text("North sales team") select', 'view'); await sleep(500);
    await r.select('.modal .item:has-text("Lena Okafor") select', 'edit'); await sleep(1200);
    await r.click('.modal footer .primary'); await r.page.waitForSelector('.toast'); await sleep(1600);
  }, 9000);
  await signOut();
  await r.say('Tom is on the North sales team. The chat appears under **Shared with me**, read-only.', async () => {
    await signIn('tom.becker@acme.example', state.user_password);
    await r.page.waitForSelector('.conv-group:has-text("Shared with me")'); await r.ring('.conv-group:has-text("Shared with me")'); await sleep(1400); await r.ring(null, false);
    await r.click('.conv:has-text("How does revenue split by region?")'); await r.page.waitForSelector('text=view only'); await sleep(800);
  }, 7000);
  await r.say('And he sees his own numbers: only the North region, because **his** data filters apply — not the owner’s.', async () => {
    await r.page.waitForSelector('.run .chart-box canvas'); await sleep(400);
    await r.click('.run .btn.sm:text-is("Table")'); await sleep(800); await r.reveal('.run .tbl', 'center', 900); await r.ring('.run .tbl'); await sleep(2000); await r.ring(null, false);
  }, 7600);
  r.mark('hl-end');
  await signOut();
  await r.say('Lena was given edit rights, so she can add her own question to the same chat.', async () => {
    await signIn('lena.okafor@acme.example', state.user_password);
    await r.click('.conv:has-text("How does revenue split by region?")'); await r.page.waitForSelector('text=you can view it and add questions'); await sleep(900);
    await r.type('.composer textarea', 'What is revenue by category?', 42); await r.page.keyboard.press('Enter');
    await r.page.waitForFunction(() => document.querySelectorAll('.q').length === 2 && !document.querySelector('.spinner'), null, { timeout: 60000 });
    await sleep(600); await r.reveal(lastQ(), 'start', 900); await sleep(900);
  }, 8800);
  await r.say('Only the owner can share or delete the chat. Everyone else sees what they were given, and no more.', async () => { await sleep(500); }, 5200);
};
