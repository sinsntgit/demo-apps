const { sleep, totp } = require('../lib');
const state = require('../out/state.json');
exports.storage = null;          // a brand-new browser: the sign-in happens on camera
exports.route = '/';
exports.step = '01 · Secure sign-in';
exports.run = async r => {
  await r.intro('Secure by design', 'Two-factor authentication, roles and a full audit trail.', 'Chapter 1', 3000);
  await r.say('Every account can be protected with **two-factor authentication**.', async () => {
    await r.type('input[type=email]', state.admin, 55);
    await r.type('input[type=password]', state.admin_password, 55);
  });
  await r.say('Sign in with your password…', async () => { await r.click('button[type=submit]'); await r.page.waitForSelector('input[autocomplete=one-time-code]'); await sleep(500); }, 2200);
  await r.say('…then a time-based code from your authenticator app. Recovery codes cover a lost phone.', async () => {
    await r.type('input[autocomplete=one-time-code]', totp(state.totp_secret), 120);
    await r.mark('hl-start');
    await r.click('button[type=submit]');
    await r.page.waitForSelector('.nav');
    await sleep(800);
  });
  await r.say('**Role-based access**: analysts never see these — stewards and admins get curation and control.', async () => {
    await r.ringAll(['.nav a[data-path="training"]', '.nav a[data-path="admin"]']); await sleep(3200); await r.ring(null, false);
  }, 5600);
};
