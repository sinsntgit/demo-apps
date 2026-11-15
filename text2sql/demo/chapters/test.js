exports.step = '01 · Test';
exports.run = async r => {
  await r.intro('AskData', 'Ask your data anything', 'text-to-SQL platform', 2200);
  await r.say('Pick a **data model** and an **AI model**, then just ask.', async () => {
    await r.select('.ask-bar select >> nth=0', '1');
    await r.hover('.ask-bar select >> nth=1', 500);
  });
  await r.say('Type a question in plain English.', async () => {
    await r.type('.composer textarea', 'What is revenue by month?');
    await r.page.keyboard.press('Enter');
    await r.page.waitForSelector('.run .chart-box canvas', { timeout: 30000 });
    await r.cursorTo(300, 200); await r.cursorTo(1100, 450); await r.cursorTo(500, 600);
    await r.quiet(1500);
  });
  await r.say('The SQL, the chart and a plain-language summary.', async () => { await r.ring('.run .chart-box'); await r.quiet(1500); await r.ring(null, false); });
};
