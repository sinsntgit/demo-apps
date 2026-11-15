// Recording toolkit for the demo video: drives the real app in a headless browser and captures it at 1080p.
//
//  - The page is 1280x720 CSS px at 1.5x -> 1920x1080 frames, grabbed from Chromium's screencast (crisp text; the
//    default Playwright video recorder is far too soft for this).
//  - A caption band is added at the bottom of the page itself, an animated cursor, click ripples, spotlight
//    rings and full-screen chapter cards - the app's own code is never modified.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BASE = 'http://localhost:8010';
const OUT = path.join(__dirname, 'out');
const BAND = 86;                 // height of the caption band, CSS px
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Runs in the page, before the app: styles + the overlay objects. */
function overlay(band) {
  const css = `
    :root { --band: ${band}px; }
    .shell, .ask, .thread-col { height: calc(100vh - var(--band)) !important; }
    .auth { min-height: calc(100vh - var(--band)) !important; }
    .overlay { bottom: var(--band) !important; }
    #toasts { bottom: calc(var(--band) + 14px) !important; }
    html, body { overflow: hidden !important; }
    #dm-band { position: fixed; left: 0; right: 0; bottom: 0; height: var(--band); z-index: 2147483000; display: flex; align-items: center; gap: 22px;
      padding: 0 30px; background: linear-gradient(180deg, #0e1a2b, #08111d); color: #fff; font: 500 25px/1.25 Inter, system-ui, sans-serif; border-top: 1px solid #22364f; }
    #dm-band .brand { display: flex; align-items: center; gap: 9px; font-weight: 700; font-size: 17px; color: #9fc2ee; white-space: nowrap; letter-spacing: .01em; }
    #dm-band .brand i { width: 22px; height: 22px; border-radius: 6px; background: #2a78d6; display: grid; place-items: center; font-style: normal; color: #fff; font-size: 11px; }
    #dm-cap { flex: 1; transition: opacity .25s ease; opacity: 0; text-align: left; }
    #dm-cap b { color: #7db7ff; font-weight: 700; }
    #dm-step { font-size: 15px; color: #7e97b8; white-space: nowrap; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
    #dm-cursor { position: fixed; left: 0; top: 0; width: 30px; height: 30px; z-index: 2147483500; pointer-events: none; transform: translate(640px, 360px); will-change: transform;
      filter: drop-shadow(0 2px 3px rgba(0,0,0,.45)); }
    .dm-ripple { position: fixed; z-index: 2147483400; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; border: 3px solid #2a78d6; background: rgba(42,120,214,.25);
      pointer-events: none; animation: dm-rip .6s ease-out forwards; }
    @keyframes dm-rip { to { transform: scale(4.2); opacity: 0; } }
    #dm-ring { position: fixed; z-index: 2147482000; pointer-events: none; border: 3px solid #ffb020; border-radius: 12px; box-shadow: 0 0 0 4px rgba(255,176,32,.22), 0 0 28px rgba(255,176,32,.35);
      opacity: 0; transition: opacity .3s ease; animation: dm-pulse 1.4s ease-in-out infinite; }
    @keyframes dm-pulse { 50% { box-shadow: 0 0 0 9px rgba(255,176,32,.12), 0 0 34px rgba(255,176,32,.45); } }
    #dm-card { position: fixed; inset: 0; z-index: 2147483600; display: grid; place-items: center; text-align: center; color: #fff; opacity: 0; pointer-events: none;
      transition: opacity .7s ease; font-family: Inter, system-ui, sans-serif;
      background: radial-gradient(1100px 600px at 20% 0%, #1d4f8f 0%, transparent 60%), radial-gradient(900px 600px at 100% 100%, #0f6b63 0%, transparent 55%), #08111d; }
    #dm-card.on { opacity: 1; }
    #dm-card .in { transform: translateY(18px); transition: transform .9s ease; max-width: 1000px; padding: 0 40px; }
    #dm-card.on .in { transform: none; }
    #dm-card .mark { width: 84px; height: 84px; border-radius: 22px; background: #2a78d6; display: grid; place-items: center; margin: 0 auto 28px; font-size: 38px; box-shadow: 0 16px 50px rgba(42,120,214,.5); }
    #dm-card h1 { font-size: 66px; line-height: 1.08; margin: 0 0 18px; font-weight: 750; letter-spacing: -.02em; }
    #dm-card p { font-size: 28px; line-height: 1.35; margin: 0; color: #b9d0ee; font-weight: 450; }
    #dm-card small { display: block; margin-top: 30px; font-size: 19px; color: #7e97b8; letter-spacing: .06em; text-transform: uppercase; font-weight: 600; }
    #dm-card ul { list-style: none; padding: 0; margin: 34px 0 0; display: grid; grid-template-columns: 1fr 1fr; gap: 14px 34px; text-align: left; font-size: 25px; color: #e6f0ff; }
    #dm-card li::before { content: '✓'; color: #5fd6a0; font-weight: 800; margin-right: 12px; }
  `;
  const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
  const build = () => {
    if (document.getElementById('dm-band')) return;
    const style = document.createElement('style'); style.textContent = css; document.head.append(style);
    const el = html => { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; };
    const band = el('<div id="dm-band"><div class="brand"><i>▮▮</i>AskData</div><div id="dm-cap"></div><div id="dm-step"></div></div>');
    const cursor = el('<div id="dm-cursor"><svg width="30" height="30" viewBox="0 0 24 24"><path d="M4 2 L4 19 L8.6 14.8 L11.8 21.6 L14.6 20.3 L11.5 13.6 L17.8 13.6 Z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg></div>');
    const ring = el('<div id="dm-ring"></div>');
    const card = el('<div id="dm-card"><div class="in"><div class="mark">▮▮</div><h1></h1><p></p><div class="extra"></div><small></small></div></div>');
    document.body.append(band, ring, cursor, card);
    let cx = 640, cy = 360, capTimer = 0;
    window.__demo = {
      caption(text, step) {
        const cap = document.getElementById('dm-cap'); clearTimeout(capTimer);
        cap.style.opacity = 0;
        capTimer = setTimeout(() => { cap.innerHTML = text ? esc(text) : ''; cap.style.opacity = text ? 1 : 0; }, text ? 220 : 0);
        if (step !== undefined) document.getElementById('dm-step').textContent = step;
      },
      card(title, sub, small, items, instant) {
        const c = document.getElementById('dm-card');
        c.querySelector('h1').innerHTML = esc(title || ''); c.querySelector('p').innerHTML = esc(sub || ''); c.querySelector('small').textContent = small || '';
        c.querySelector('.extra').innerHTML = items ? '<ul>' + items.map(i => `<li>${esc(i)}</li>`).join('') + '</ul>' : '';
        if (instant) { c.style.transition = 'none'; c.querySelector('.in').style.transition = 'none'; }
        c.classList.add('on');
        if (instant) requestAnimationFrame(() => requestAnimationFrame(() => { c.style.transition = ''; c.querySelector('.in').style.transition = ''; }));
      },
      hideCard() { document.getElementById('dm-card').classList.remove('on'); },
      ring(r) { const g = document.getElementById('dm-ring'); if (!r) { g.style.opacity = 0; return; }
        const pad = 6; Object.assign(g.style, { left: r.x - pad + 'px', top: r.y - pad + 'px', width: r.w + pad * 2 + 'px', height: r.h + pad * 2 + 'px', opacity: 1 }); },
      setCursor(x, y) { cx = x; cy = y; cursor.style.transform = `translate(${x - 4}px, ${y - 3}px)`; },
      moveCursor(x, y, ms) {
        return new Promise(res => { const x0 = cx, y0 = cy, t0 = performance.now();
          const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
          const step = now => { const t = Math.min(1, (now - t0) / ms); window.__demo.setCursor(x0 + (x - x0) * ease(t), y0 + (y - y0) * ease(t)); t < 1 ? requestAnimationFrame(step) : res(); };
          requestAnimationFrame(step); });
      },
      ripple() { const r = document.createElement('div'); r.className = 'dm-ripple'; r.style.left = cx + 'px'; r.style.top = cy + 'px'; document.body.append(r); setTimeout(() => r.remove(), 700); },
    };
    window.__demo.setCursor(cx, cy);
  };
  if (document.body) build(); else document.addEventListener('DOMContentLoaded', build);
}

class Rec {
  /** opts: { name, storage: 'admin' | null } */
  constructor(opts) { this.o = opts; this.cx = 640; this.cy = 360; this.marks = []; this.pending = []; this.n = 0; this.stamps = []; this.t0 = null; }

  async start(route = '/') {
    this.dir = path.join(OUT, 'frames', this.o.name);
    fs.rmSync(this.dir, { recursive: true, force: true }); fs.mkdirSync(this.dir, { recursive: true });
    this.browser = await chromium.launch({ args: ['--hide-scrollbars', '--font-render-hinting=none'] });
    const storage = this.o.storage === 'admin' ? path.join(OUT, 'admin.storage.json') : undefined;
    this.ctx = await this.browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5, storageState: storage, locale: 'en-GB', timezoneId: 'Asia/Kolkata' });
    await this.ctx.addInitScript(overlay, BAND);
    this.page = await this.ctx.newPage(); this.page.setDefaultTimeout(20000);
    this.page.on('pageerror', e => console.log('  [pageerror]', e.message));
    await this.page.goto(BASE + route);
    await this.page.waitForSelector('#dm-band');
    await this.page.waitForSelector('.nav, .auth', { timeout: 20000 });
    await this.page.evaluate(() => window.__demo.card('', '', '', null, true));
    await sleep(400);
    await this.capture();
    return this;
  }

  async capture() {
    this.cdp = await this.ctx.newCDPSession(this.page);
    this.cdp.on('Page.screencastFrame', ev => {
      const i = this.n++; this.stamps.push(ev.metadata.timestamp);
      if (this.t0 === null) this.t0 = ev.metadata.timestamp;
      const job = fs.promises.writeFile(path.join(this.dir, String(i).padStart(6, '0') + '.jpg'), Buffer.from(ev.data, 'base64'))
        .then(() => this.cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {}));
      this.pending.push(job);
    });
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 93, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  }

  now() { return this.t0 === null ? 0 : Date.now() / 1000 - this.t0; }
  mark(name) { this.marks.push({ name, t: +this.now().toFixed(2) }); }

  // ---------- on-screen helpers
  async card(title, sub, small, items) { await this.page.evaluate(a => window.__demo.card(...a), [title, sub, small, items]); }
  async hideCard() { await this.page.evaluate(() => window.__demo.hideCard()); }
  /** A chapter card; `during` runs behind it (set-up the viewer should not watch), then the card fades away. */
  async intro(title, sub, small, ms = 3400, during) {
    const t = Date.now(); await this.card(title, sub, small);
    if (during) await during();
    const left = ms - (Date.now() - t); if (left > 0) await sleep(left);
    await this.hideCard(); await sleep(900);
  }

  /** Show a caption, run `act`, and keep the caption up long enough to read. */
  async say(text, act, minMs) {
    const words = text.replace(/\*\*/g, '').split(/\s+/).length;
    const need = minMs ?? Math.max(2400, 900 + words * 330);
    const t = Date.now();
    await this.page.evaluate(([x, s]) => window.__demo.caption(x, s), [text, this.o.step || '']);
    await sleep(350);
    if (act) await act();
    const left = need - (Date.now() - t);
    if (left > 0) await sleep(left);
  }
  async quiet(ms = 600) { await sleep(ms); }
  async clearCaption() { await this.page.evaluate(() => window.__demo.caption('')); }

  async ring(target, on = true) {
    if (!on) return this.page.evaluate(() => window.__demo.ring(null));
    const loc = typeof target === 'string' ? this.page.locator(target).first() : target;
    await loc.scrollIntoViewIfNeeded();
    const b = await loc.boundingBox();
    await this.page.evaluate(r => window.__demo.ring(r), { x: b.x, y: b.y, w: b.width, h: b.height });
  }

  /** One ring around the union of several elements. */
  async ringAll(targets) {
    let x0 = 1e9, y0 = 1e9, x1 = 0, y1 = 0;
    for (const t of targets) { const b = await this.loc(t).boundingBox(); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height); }
    await this.page.evaluate(r => window.__demo.ring(r), { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  async cursorTo(x, y) {
    const d = Math.hypot(x - this.cx, y - this.cy);
    await this.page.evaluate(([a, b, ms]) => window.__demo.moveCursor(a, b, ms), [x, y, Math.min(950, 240 + d * 0.8)]);
    this.cx = x; this.cy = y;
    await this.page.mouse.move(x, y);
  }
  loc(t) { return typeof t === 'string' ? this.page.locator(t).first() : t; }
  async point(t, o = {}) {
    const loc = this.loc(t);
    await loc.scrollIntoViewIfNeeded();
    const b = await loc.boundingBox();
    if (!b) throw new Error('not visible: ' + t);
    const x = b.x + (o.fx ?? 0.5) * b.width, y = b.y + (o.fy ?? 0.5) * b.height;
    await this.cursorTo(x, y);
    return { x, y, b };
  }
  async click(t, o = {}) {
    await this.point(t, o);
    await sleep(o.pause ?? 140);
    await this.page.evaluate(() => window.__demo.ripple());
    await this.page.mouse.click(this.cx, this.cy);
    await sleep(o.after ?? 260);
  }
  async hover(t, ms = 700, o = {}) { await this.point(t, o); await sleep(ms); }
  async type(t, text, per = 42) {
    await this.click(t);
    await this.page.keyboard.type(text, { delay: per });
    await sleep(250);
  }
  async select(t, value) { await this.point(t); await sleep(250); await this.page.evaluate(() => window.__demo.ripple()); await this.loc(t).selectOption(value); await sleep(500); }
  /** Smoothly scroll an element into view (inside whatever scrolls: the chat thread, a page, a modal). */
  async reveal(t, block = 'start', ms = 1000) { await this.loc(t).evaluate((el, b) => el.scrollIntoView({ behavior: 'smooth', block: b }), block); await sleep(ms); }
  async nav(p, ms = 900) { await this.click(`.nav a[data-path="${p}"]`); await sleep(ms); }
  async tab(label, ms = 700) { await this.click(`.tabs button:has-text("${label}")`); await sleep(ms); }
  async scroll(t, to, ms = 900) {
    await this.page.evaluate(([sel, y]) => { const el = typeof sel === 'string' ? document.querySelector(sel) : null; (el || window).scrollTo({ top: y, behavior: 'smooth' }); }, [t, to]);
    await sleep(ms);
  }
  async drag(from, to, o = {}) {
    const a = await this.point(from, { fx: o.fromFx, fy: o.fromFy });
    await sleep(150);
    const dt = await this.page.evaluateHandle(() => new DataTransfer());
    const src = this.loc(from), dst = this.loc(to);
    await src.dispatchEvent('dragstart', { dataTransfer: dt });
    const b = await dst.boundingBox();
    const x = b.x + (o.toFx ?? 0.5) * b.width, y = b.y + (o.toFy ?? 0.5) * b.height;
    await this.cursorTo(x, y);
    await dst.dispatchEvent('dragover', { dataTransfer: dt, clientX: x, clientY: y });
    await sleep(350);
    await dst.dispatchEvent('drop', { dataTransfer: dt, clientX: x, clientY: y });
    await src.dispatchEvent('dragend', { dataTransfer: dt });
    await sleep(500);
  }

  // ---------- finish: stop capture, build the video segment
  async finish() {
    await this.clearCaption(); await sleep(400);
    // fade to the branded background so chapters join smoothly (unless a card is already showing)
    await this.page.evaluate(() => { const c = document.getElementById('dm-card'); if (!c.classList.contains('on')) window.__demo.card('', '', ''); });
    await sleep(1000);
    await this.cdp.send('Page.stopScreencast').catch(() => {});
    await Promise.all(this.pending);
    await this.browser.close();
    const list = path.join(this.dir, 'list.txt');
    const lines = ['ffconcat version 1.0'];
    for (let i = 0; i < this.n; i++) {
      const d = i + 1 < this.n ? Math.max(0.001, this.stamps[i + 1] - this.stamps[i]) : 0.6;
      lines.push(`file ${String(i).padStart(6, '0')}.jpg`, `duration ${d.toFixed(5)}`);
    }
    lines.push(`file ${String(this.n - 1).padStart(6, '0')}.jpg`);
    fs.writeFileSync(list, lines.join('\n'));
    const mp4 = path.join(OUT, `${this.o.name}.mp4`);
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vf', 'fps=30,scale=1920:1080:flags=lanczos,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-r', '30', '-g', '60', '-movflags', '+faststart', mp4], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('ffmpeg: ' + r.stderr);
    fs.writeFileSync(path.join(OUT, `${this.o.name}.json`), JSON.stringify({ frames: this.n, marks: this.marks }, null, 1));
    fs.rmSync(this.dir, { recursive: true, force: true });
    const dur = this.stamps[this.stamps.length - 1] - this.stamps[0] + 0.6;
    const perSec = {}; for (const t of this.stamps) { const k = Math.floor(t - this.stamps[0]); perSec[k] = (perSec[k] || 0) + 1; }
    const busy = Object.values(perSec).filter(v => v >= 5).sort((a, b) => a - b);          // seconds with real motion
    console.log(`  motion seconds: ${busy.length}, frames/s while moving: median ${busy[busy.length >> 1] || 0}, 10th percentile ${busy[Math.floor(busy.length * .1)] || 0}`);
    console.log(`  ${this.o.name}: ${this.n} frames, ${dur.toFixed(1)} s, ${(fs.statSync(mp4).size / 1e6).toFixed(1)} MB, ${(this.n / dur).toFixed(1)} fps captured`);
  }
}

/** Time-based one-time password (RFC 6238) so the on-camera 2FA sign-in uses a genuinely valid code. */
function totp(secret, offset = 0) {
  const crypto = require('crypto');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = ''; for (const ch of secret.replace(/=+$/, '')) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map(b => parseInt(b, 2)));
  const counter = Math.floor(Date.now() / 30000) + offset;
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const o = h[19] & 15;
  return String(((h[o] & 127) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1e6).padStart(6, '0');
}

module.exports = { Rec, sleep, totp, BASE, OUT };
