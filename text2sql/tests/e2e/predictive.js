// Predictive questions end to end: opt-in tick box, each method, show/hide, re-run, code, exports.
const { chromium } = require('playwright');
const OUT = process.argv[2], B = 'http://localhost:8010/';
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1320, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage(); page.setDefaultTimeout(15000);
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('401')) errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
  const step = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { console.log('FAIL', name, '-', e.message.split('\n')[0]); await page.screenshot({ path: `${OUT}/FAIL-${name.replace(/\W+/g, '_')}.png` }).catch(() => {}); } };
  const ask = async q => { const n = await page.locator('.run').count(); await page.fill('.composer textarea', q); await page.keyboard.press('Enter'); await page.waitForFunction(k => document.querySelectorAll('.run').length > k, n, { timeout: 60000 }); await page.waitForTimeout(700); return page.locator('.run').last(); };
  const post = (path, body) => page.evaluate(async ([p, b]) => (await fetch(p, { method: 'POST', headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json(), [path, body]);
  // answers are taller than the window: grow the window so the whole answer is captured, then restore it
  // a canvas existing is not enough: every predictive chart must actually have something drawn on it
  const drawn = run => run.locator('.sec').nth(1).locator('canvas').evaluateAll(cs => cs.map(c => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0;
    for (let i = 3; i < d.length; i += 4 * 97) if (d[i]) n++;
    return !!Chart.getChart(c) && n > 20; }));
  const shotRun = async (run, name) => {
    const ok = await drawn(run); if (!ok.length || ok.includes(false)) throw new Error('blank chart: ' + JSON.stringify(ok));
    await page.setViewportSize({ width: 1320, height: 4200 }); await page.waitForTimeout(700);
    await run.evaluate(e => e.scrollIntoView({ block: 'start' })); await page.waitForTimeout(400);
    await run.screenshot({ path: `${OUT}/${name}.png` });
    await page.setViewportSize({ width: 1320, height: 900 }); await page.waitForTimeout(300);
  };

  await page.goto(B);
  await page.fill('input[type=email]', 'admin@example.com'); await page.fill('input[type=password]', 'Admin-Passw0rd!');
  await page.click('button[type=submit]'); await page.waitForSelector('.nav');
  await post('/api/admin/models', { name: 'Demo model', provider: 'openai_compatible', model_id: 'fake-1', base_url: 'http://127.0.0.1:8765/v1', is_default: true });
  await page.goto(B + '#/ask'); await page.waitForSelector('.composer textarea');

  await step('off by default: no predictive output', async () => {
    if (await page.locator('.ask-bar label:has-text("Use predictive capability") input').isChecked()) throw new Error('should start unticked');
    const run = await ask('Forecast revenue for the next 6 months');
    if (await run.locator('text=rows analysed on the server').count()) throw new Error('analysis ran without opt-in');
  });
  await step('forecast', async () => {
    await page.locator('.ask-bar label:has-text("Use predictive capability")').click();
    await page.locator('.ask-bar').screenshot({ path: `${OUT}/predictive-toggle.png` });
    const run = await ask('Forecast revenue for the next 6 months');
    await run.locator('text=rows analysed on the server').waitFor();
    if (await run.locator('.chart-box canvas').count() !== 1) throw new Error('forecast chart');
    const code = await run.locator('pre.code-py').innerText();
    if (!code.includes("DATE, TARGET, HORIZON = 'month', 'revenue', 6") || !code.includes('ExponentialSmoothing')) throw new Error('code not shown');
    if (!(await run.locator('h3:has-text("Data used")').count())) throw new Error('data section');
    await shotRun(run, 'predictive-forecast');
  });
  await step('show / hide components (remembered)', async () => {
    const run = page.locator('.run').last();
    for (const part of ['Statistics', 'Code']) await run.locator(`label.check:has-text("${part}")`).click();
    if (await run.locator('pre.code-py').count() || await run.locator('h3:has-text("Methods compared")').count()) throw new Error('not hidden');
    if (!(await run.locator('h3:has-text("Forecast values")').count())) throw new Error('results hidden too');
    await run.locator('label.check:has-text("Charts")').click(); if (await run.locator('.sec').nth(1).locator('canvas').count()) throw new Error('chart not hidden');
    await run.locator('label.check:has-text("Charts")').click(); await page.waitForTimeout(400);
    await page.reload(); await page.waitForSelector('.run'); await page.waitForTimeout(800);
    const again = page.locator('.run').last();
    if (await again.locator('pre.code-py').count()) throw new Error('hide choice not remembered');
    await again.locator('label.check:has-text("Code")').click(); await again.locator('pre.code-py').waitFor();
  });
  await step('change the horizon', async () => {
    const run = page.locator('.run').last();
    await run.locator('input[aria-label="Periods ahead"]').fill('3'); await run.locator('button:text-is("Update")').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.run:last-of-type .kpi .l')].some(e => e.textContent.includes('Next 3 months')));
  });
  await step('pdf + csv export', async () => {
    const run = page.locator('.run').last();
    const [pdf] = await Promise.all([page.waitForEvent('download'), (async () => { await run.locator('text=⬇ Export').click(); await page.click('.pop:not(.hidden) >> text=PDF report'); })()]);
    await pdf.saveAs(`${OUT}/predictive.pdf`);
    const [csv] = await Promise.all([page.waitForEvent('download'), (async () => { await run.locator('text=⬇ Export').click(); await page.click('.pop:not(.hidden) >> text=Forecast values (CSV)'); })()]);
    await csv.saveAs(`${OUT}/forecast.csv`);
  });
  for (const [q, name, expect, charts] of [
    ['Segment our customers', 'predictive-segments', 'Segment profiles', 2],
    ['Which orders are likely to be returned?', 'predictive-classification', 'Confusion matrix', 2],
    ['What drives order value?', 'predictive-drivers', 'What drives order value', 1],
    ['Predict order value', 'predictive-regression', 'Predicted vs actual', 2],
    ['Any unusual days in revenue?', 'predictive-anomaly', 'Unusual days', 1],
    ['Show unusual orders', 'predictive-anomaly-rows', 'Most unusual rows', 2]]) {
    await step(name, async () => {
      await page.click('text=＋ New chat');
      const run = await ask(q);
      await run.locator('text=rows analysed on the server').waitFor();
      await run.locator(`h3:has-text("${expect}")`).first().waitFor();
      const n = await run.locator('.sec').nth(1).locator('canvas').count(); if (n !== charts) throw new Error(`charts ${n} != ${charts}`);
      if (!(await run.locator('pre.code-py').innerText()).includes('# 1. ')) throw new Error('no code');
      await shotRun(run, name);
    });
  }
  await step('segments: set the number', async () => {
    await page.click('text=＋ New chat'); const run = await ask('Segment our customers');
    await run.locator('select[aria-label="Number of segments"]').selectOption('4'); await run.locator('button:text-is("Update")').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.run:last-of-type .kpi')].some(e => e.textContent.includes('set by you')));
  });
  await step('unsuitable data: clear message, data still shown', async () => {
    const run = await ask('run the bad analysis');
    await run.locator('text=The predictive analysis could not be run').waitFor();
    if (!(await run.locator('table.tbl').count())) throw new Error('data missing');
  });
  await step('predictive answer in a report', async () => {
    await page.click('text=＋ New chat'); const run = await ask('Forecast revenue for the next 6 months');
    await run.locator('text=⬇ Export').click(); await page.click('.pop:not(.hidden) >> text=＋ Add to a report…');
    await page.fill('.modal input', 'Revenue outlook'); await page.click('text=Create new report'); await page.waitForSelector('.toast:has-text("Added to")');
    await page.goto(B + '#/reports'); await page.click('.report-card'); await page.waitForSelector('.paper .rep-analysis canvas'); await page.waitForTimeout(900);
    const ok = await page.locator('.rep-analysis canvas').evaluateAll(cs => cs.map(c => !!Chart.getChart(c)));
    if (!ok.length || ok.includes(false)) throw new Error('report chart missing');
    if (!(await page.locator('.rep-analysis pre.code-py').count())) throw new Error('code missing in report');
    const [pdf] = await Promise.all([page.waitForEvent('download'), page.click('text=⬇ PDF')]); await pdf.saveAs(`${OUT}/predictive-report.pdf`);
    await page.click('text=✎ Edit'); await page.waitForSelector('text=Predictive output (forecast)');
  });
  await step('dark theme + settings', async () => {
    await page.click('text=◐ Theme'); await page.waitForTimeout(600); await page.click('text=◐ Theme');
    await page.goto(B + '#/admin/settings'); await page.waitForSelector('text=Allow predictive questions');
    await page.locator('.card:has-text("Predictive analysis")').first().screenshot({ path: `${OUT}/predictive-settings.png` });
  });
  console.log('console errors:', errors.length ? errors : 'none');
  await browser.close();
})();
