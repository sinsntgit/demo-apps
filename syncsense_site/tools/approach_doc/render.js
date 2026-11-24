// Renders approach.html to the assessment PDF.
// Usage: node tools/approach_doc/render.js assets/docs/syncsense-data-assessment-approach.pdf [png-dir]
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1123, height: 794 } });
  await p.goto('file://' + path.join(__dirname, 'approach.html'), { waitUntil: 'networkidle' });
  await p.evaluate(() => document.fonts.ready);
  await p.pdf({ path: process.argv[2], width: '297mm', height: '210mm', printBackground: true, preferCSSPageSize: true });
  if (process.argv[3]) {
    const els = await p.$$('.slide');
    for (let i = 0; i < els.length; i++) await els[i].screenshot({ path: `${process.argv[3]}/s${String(i + 1).padStart(2, '0')}.png` });
  }
  await b.close();
})();
