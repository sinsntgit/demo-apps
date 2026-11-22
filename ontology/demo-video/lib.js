// Recording helpers for the demo video: a headless browser at a moderate fixed zoom, a visible cursor, highlights,
// and frame capture with exact timestamps (Chrome's screencast), so the video can be built at full quality.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// The page lays out like a 1477 px wide desktop browser and is captured at 1.3x, which gives 1920x1080 frames:
// text is large enough to read comfortably, with no zooming or panning during the video.
const VIEW = { width: 1477, height: 831 }, DSF = 1.3;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => Date.now() / 1000;

const OVERLAY = `(() => {
  if (window.__demo) return; window.__demo = true;
  const css = \`
  #demo-cursor{position:fixed;left:0;top:0;width:30px;height:30px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))}
  .demo-ripple{position:fixed;z-index:2147483646;pointer-events:none;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;border:3px solid #ff8a1f;animation:demo-rip .55s ease-out forwards}
  @keyframes demo-rip{to{transform:scale(4.2);opacity:0}}
  .demo-hl{position:fixed;z-index:2147483645;pointer-events:none;border:3px solid #ff8a1f;border-radius:10px;box-shadow:0 0 0 4px rgba(255,138,31,.25),0 6px 24px rgba(255,138,31,.35);animation:demo-pulse 1.1s ease-in-out infinite;transition:opacity .25s}
  @keyframes demo-pulse{50%{box-shadow:0 0 0 9px rgba(255,138,31,.12),0 6px 24px rgba(255,138,31,.2)}}
  .demo-tag{position:fixed;z-index:2147483645;pointer-events:none;background:#ff8a1f;color:#1b1206;font:600 15px/1.2 Inter,system-ui,sans-serif;padding:6px 11px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.3);max-width:360px}
  #demo-chip{position:fixed;left:22px;bottom:22px;z-index:2147483644;pointer-events:none;background:rgba(14,28,46,.92);color:#fff;font:600 17px/1 Inter,system-ui,sans-serif;padding:11px 16px;border-radius:10px;display:flex;gap:10px;align-items:center;box-shadow:0 8px 28px rgba(0,0,0,.35);opacity:0;transform:translateY(8px);transition:opacity .35s,transform .35s}
  #demo-chip.on{opacity:1;transform:none} #demo-chip b{background:#14b8a6;color:#04201c;border-radius:6px;padding:4px 8px;font-size:15px}
  \`;
  const start = () => {
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const c = document.createElement('div'); c.id = 'demo-cursor';
    c.innerHTML = '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M3 2l7.5 19 2.6-7.9L21 10.5z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    const chip = document.createElement('div'); chip.id = 'demo-chip'; document.documentElement.appendChild(chip);
    addEventListener('mousemove', e => { c.style.transform = 'translate(' + (e.clientX - 3) + 'px,' + (e.clientY - 2) + 'px)'; }, true);
    addEventListener('mousedown', e => { const r = document.createElement('div'); r.className = 'demo-ripple'; r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px'; document.documentElement.appendChild(r); setTimeout(() => r.remove(), 700); }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.__hl = (rect, ms, label, side) => {
    const d = document.createElement('div'); d.className = 'demo-hl';
    const p = 6; d.style.left = rect.x - p + 'px'; d.style.top = rect.y - p + 'px'; d.style.width = rect.w + 2 * p + 'px'; d.style.height = rect.h + 2 * p + 'px';
    document.documentElement.appendChild(d); const kids = [d];
    if (label) { const t = document.createElement('div'); t.className = 'demo-tag'; t.textContent = label;
      const below = side !== 'above' && rect.y + rect.h + 60 < innerHeight; t.style.left = Math.max(10, Math.min(rect.x, innerWidth - 380)) + 'px';
      t.style.top = (below ? rect.y + rect.h + p + 10 : Math.max(8, rect.y - p - 40)) + 'px'; document.documentElement.appendChild(t); kids.push(t); }
    setTimeout(() => kids.forEach(k => { k.style.opacity = 0; setTimeout(() => k.remove(), 300); }), ms);
  };
  window.__chip = (n, text) => { const c = document.getElementById('demo-chip'); if (!c) return; c.innerHTML = '<b>' + n + '</b><span>' + text + '</span>'; c.classList.add('on'); setTimeout(() => c.classList.remove('on'), 4200); };
})();`;

async function open({ base, framesDir, storageState, size = VIEW, dsf = DSF, slides = false }) {
  fs.mkdirSync(framesDir, { recursive: true });
  const browser = await chromium.launch({ args: ['--hide-scrollbars', '--font-render-hinting=none'] });
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1, storageState, acceptDownloads: true });
  await context.addInitScript(OVERLAY);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const frames = [];
  let n = 0, running = false, loop = null, last = '';
  // Chrome's screencast cannot render above 1x; a clipped screenshot at 1.3x renders crisp 1920x1080 frames (about 20 per second).
  // Frames identical to the one before are skipped: the earlier frame simply lasts longer.
  const shot = { format: 'jpeg', quality: 88, optimizeForSpeed: true, clip: { x: 0, y: 0, width: size.width, height: size.height, scale: dsf } };
  const capture = async () => {
    while (running) {
      const t1 = now();
      try {
        const r = await cdp.send('Page.captureScreenshot', shot);
        const t = (t1 + now()) / 2;
        if (r.data !== last) {
          const file = path.join(framesDir, String(n++).padStart(6, '0') + '.jpg');
          fs.writeFileSync(file, Buffer.from(r.data, 'base64')); frames.push([t, file]); last = r.data;
        }
      } catch (e) { await sleep(40); }                         // a page that is navigating cannot be captured for a moment
    }
  };
  const rec = { browser, context, page, cdp, frames, mouse: { x: 740, y: 420 }, base };
  rec.start = async () => {
    running = true; loop = capture();
    await page.mouse.move(rec.mouse.x, rec.mouse.y);
    for (let i = 0; i < 60 && !frames.length; i++) await sleep(50);
  };
  rec.stop = async () => {
    await sleep(300); running = false; await loop;
    return { frames: frames.map(([t, f]) => [t, f]) };
  };
  rec.close = () => browser.close();
  return rec;
}

// --- human-like interaction ---------------------------------------------------------------------------------------
async function moveTo(rec, x, y, ms = 650) {
  const { page, mouse } = rec, steps = Math.max(6, Math.round(ms / 16));
  const x0 = mouse.x, y0 = mouse.y, ease = t => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  for (let i = 1; i <= steps; i++) {
    const t = ease(i / steps);
    await page.mouse.move(x0 + (x - x0) * t, y0 + (y - y0) * t);
    await sleep(ms / steps);
  }
  mouse.x = x; mouse.y = y;
}
async function box(rec, target, opts = {}) {
  const loc = typeof target === 'string' ? rec.page.locator(target).first() : target;
  await loc.waitFor({ state: 'visible', timeout: opts.timeout || 15000 });
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(120);
  const b = await loc.boundingBox();
  if (!b) throw new Error('no box for ' + target);
  return b;
}
const at = (b, fx = .5, fy = .5) => [b.x + b.width * fx, b.y + b.height * fy];
async function click(rec, target, opts = {}) {
  const b = await box(rec, target, opts); const [x, y] = at(b, opts.fx ?? .5, opts.fy ?? .5);
  await moveTo(rec, x, y, opts.ms || 650); await sleep(opts.beforeClick ?? 160);
  await rec.page.mouse.down(); await sleep(60); await rec.page.mouse.up(); await sleep(opts.after ?? 250);
}
async function hover(rec, target, opts = {}) { const b = await box(rec, target, opts); const [x, y] = at(b); await moveTo(rec, x, y, opts.ms || 600); }
async function type(rec, target, text, opts = {}) {
  await click(rec, target, opts);
  if (opts.clear) { await rec.page.keyboard.press('Control+A'); await rec.page.keyboard.press('Backspace'); }
  await rec.page.keyboard.type(text, { delay: opts.delay ?? 38 }); await sleep(200);
}
async function select(rec, target, value, opts = {}) { await hover(rec, target, opts); await sleep(200); await rec.page.locator(target).first().selectOption(value); await sleep(350); }
async function scrollBy(rec, dy, ms = 900, within) {
  await rec.page.evaluate(([dy, within]) => { const el = within ? document.querySelector(within) : null; (el || window).scrollBy({ top: dy, behavior: 'smooth' }); }, [dy, within || null]); await sleep(ms);
}
async function scrollTo(rec, target, ms = 900) {
  await rec.page.locator(target).first().evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' })); await sleep(ms);
}
async function highlight(rec, target, ms = 2600, label, side) {
  const b = await box(rec, target, { timeout: 4000 }).catch(() => null); if (!b) return;
  await rec.page.evaluate(([r, ms, label, side]) => window.__hl(r, ms, label, side), [{ x: b.x, y: b.y, w: b.width, h: b.height }, ms, label || '', side || '']);
}
const chip = (rec, n, text) => rec.page.evaluate(([n, t]) => window.__chip && window.__chip(n, t), [n, text]);
async function goto(rec, url) { await rec.page.goto(url); await sleep(500); await rec.page.mouse.move(rec.mouse.x, rec.mouse.y); }

module.exports = { open, VIEW, DSF, sleep, now, moveTo, box, click, hover, type, select, scrollBy, scrollTo, highlight, chip, goto };
