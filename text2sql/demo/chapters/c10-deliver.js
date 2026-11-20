const { sleep, vo, OUT } = require('../lib');
const { spawnSync } = require('child_process');
const fs = require('fs'), path = require('path');
exports.step = '10 · Email & PowerPoint';
exports.route = '/#/reports';
exports.run = async r => {
  const slides = [];
  await r.intro('Reports that arrive ready', 'Your own email message. PDF or PowerPoint, with your logo.', 'Chapter 10', 3200, async () => {
    // behind the card: export the seeded report as PowerPoint and turn two of its slides into pictures
    const id = (await r.page.evaluate(async () => (await (await fetch('/api/reports')).json()).find(x => x.title === 'Monthly sales review')?.id));
    const res = await r.ctx.request.get(`http://localhost:8010/api/reports/${id}/pptx`);
    const dir = path.join(OUT, 'pptx'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'report.pptx'), await res.body());
    spawnSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', dir, path.join(dir, 'report.pptx')], { stdio: 'ignore', timeout: 120000 });
    spawnSync('pdftoppm', ['-png', '-r', '96', path.join(dir, 'report.pdf'), path.join(dir, 'slide')], { stdio: 'ignore' });
    for (const f of fs.readdirSync(dir).filter(f => /^slide-\d+\.png$/.test(f)).sort()) slides.push(path.join(dir, f));
    await r.page.evaluate(i => { location.hash = '#/reports/' + i; }, id); await r.page.waitForSelector('.paper .rep-result canvas', { timeout: 30000 }); await sleep(600); },
    vo('Reports can arrive in your inbox, written the way you want, and as a PowerPoint deck that is ready to present.'));
  r.mark('hl-start');
  await r.say('When you schedule a report, you write the **email** too: a subject, and a message with placeholders.', async () => {
    await r.click('text=🕒 Schedule'); await r.page.waitForSelector('.modal .ticklist'); await sleep(700);
    await r.reveal('h3:has-text("Email message")', 'start', 1100);
    await r.ring('.modal label.field:has-text("Subject")'); await sleep(1200); await r.ring(null, false);
  }, 7600);
  await r.say('Click a placeholder to insert it: the recipient’s name, the date, the period just ended, the sender, the report link.', async () => {
    await r.click('.modal label.field:has-text("Message") textarea'); await r.page.keyboard.press('Control+A'); await r.page.keyboard.type('Hello ', { delay: 40 });
    await r.click('.modal .chip:text-is("{{recipient_name}}")'); await r.page.keyboard.type(',\n\nHere is ', { delay: 40 });
    await r.click('.modal .chip:text-is("{{report_title}}")'); await r.page.keyboard.type(' for ', { delay: 40 });
    await r.click('.modal .chip:text-is("{{period}}")'); await r.page.keyboard.type('.\n\nRegards,\n', { delay: 40 });
    await r.click('.modal .chip:text-is("{{sender_name}}")'); await sleep(900);
  }, 11000);
  await r.say('Preview it, and every recipient gets their own email with their own values filled in.', async () => {
    await r.click('.modal button:text-is("👁 Preview")'); await r.page.waitForSelector('.modal >> text=Preview — as you would receive it'); await sleep(500);
    await r.reveal('.modal >> text=Preview — as you would receive it', 'center', 900); await r.ring('.modal .card:has-text("as you would receive it")'); await sleep(2200); await r.ring(null, false);
  }, 8000);
  await r.click('.modal footer >> text=Close'); await sleep(700);
  r.mark('hl-end');
  await r.say('Besides PDF, export the same report as a **PowerPoint** deck.', async () => {
    await r.hover('button:has-text("⬇ PowerPoint")', 1500);
  }, 4000);
  if (slides.length) {
    await r.say('It carries your company logo, with the accent colour taken from it. A title slide, then each result with its chart and key points.', async () => {
      await r.showImage(slides[0], 'Exported PowerPoint — title slide'); await sleep(3600);
      await r.hideImage(); await r.showImage(slides[Math.min(1, slides.length - 1)], 'One slide per result: chart beside the key points'); await sleep(3600);
    }, 9600);
    await r.say('Upload your **corporate template** and the deck is built on it, with your own masters, fonts and colours.', async () => {
      await r.hideImage(); await sleep(400);
    }, 6000);
  }
};
