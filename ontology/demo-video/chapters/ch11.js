// Downloads in standard formats, and versions.
const fs = require('fs'), path = require('path'), cp = require('child_process');
let pages = [];
module.exports = {
  n: 11, title: 'Downloads and versions', ontology: 'BrightMart Retail', start: c => `/#/o/${c.oid}`, ready: '.prose',
  setup: async c => {                               // the real handbook, exported now, so that its pages can be shown
    const dir = path.join(c.build, 'dl'); fs.mkdirSync(dir, { recursive: true });
    const r = await c.raw.get(`/api/ontologies/${c.oid}/export/pdf`); if (r.status() !== 200) throw new Error('PDF export failed');
    fs.writeFileSync(path.join(dir, 'handbook.pdf'), await r.body());
    cp.execFileSync('pdftoppm', ['-r', '62', '-png', '-f', '1', '-l', '12', path.join(dir, 'handbook.pdf'), path.join(dir, 'p')]);
    const files = fs.readdirSync(dir).filter(f => /^p-\d+\.png$/.test(f)).sort();
    const pick = [files[0], files[Math.min(files.length - 1, 4)]];
    pages = pick.map(f => 'data:image/png;base64,' + fs.readFileSync(path.join(dir, f)).toString('base64'));
  },
  beats: [
    { say: "Everything can be taken out in standard formats. A PDF handbook with the explanation and diagrams. A PowerPoint deck. An Excel workbook with every element. And OWL, Turtle, JSON-LD and JSON, for tools such as Protégé and triple stores.",
      act: async c => {
        await c.click('button:text-is("⬇ Download")'); await c.page.waitForSelector('.pop:not(.hidden)'); await c.sleep(600);
        const n = await c.page.locator('.pop:not(.hidden) button').count();
        for (let i = 0; i < n; i++) { await c.hover(`.pop:not(.hidden) button >> nth=${i}`, { ms: 420 }); await c.sleep(1100); } } },
    { say: "Here is the handbook: the explanation, the diagrams and the use cases, ready to share.",
      act: async c => {
        await c.page.mouse.click(1100, 80); await c.sleep(300);
        await c.page.evaluate(srcs => {
          const o = document.createElement('div'); o.id = 'pdfview';
          o.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(7,19,33,.94);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;opacity:0;transition:opacity .5s';
          o.innerHTML = '<div style="color:#fff;font:700 30px Inter,sans-serif">PDF handbook</div><div style="display:flex;gap:34px">' + srcs.map(s => '<img src="' + s + '" style="height:760px;box-shadow:0 12px 50px rgba(0,0,0,.55);border-radius:6px;background:#fff">').join('') + '</div>';
          document.documentElement.appendChild(o); requestAnimationFrame(() => o.style.opacity = 1);
        }, pages);
        await c.sleep(5200); await c.page.evaluate(() => { const o = document.getElementById('pdfview'); o.style.opacity = 0; setTimeout(() => o.remove(), 500); }); await c.sleep(600); } },
    { say: "Every change, whether by AI, on the diagram or from the test bed, is a version. You can compare versions, download any of them, or restore one.",
      act: async c => {
        await c.click('.tabs button:text-is("Versions")'); await c.page.waitForSelector('.item:has-text("Version 1")'); await c.sleep(1000);
        await c.hl('.item:has-text("current")', 2800, 'What changed in each version'); await c.sleep(3200);
        await c.hl('button:text-is("Restore") >> nth=0', 3000, 'Go back to any version', 'above'); } },
  ],
};
