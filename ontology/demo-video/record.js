// Plays one chapter: for every beat, the narration (audio length from build/audio/durations.json) and the on-screen actions run
// together; the beat ends when both are done. Writes build/clips/<chapter>/timeline.json (frames + when each beat started).
//   node record.js <chapter id> [base url]
const { request } = require('playwright');
const fs = require('fs'), path = require('path');
const L = require('./lib');

const ROOT = __dirname, BUILD = path.join(ROOT, 'build');
const PAD = 0.45;                                             // seconds of silence after every sentence

async function main() {
  const id = process.argv[2], base = process.argv[3] || 'http://localhost:8030';
  const chapter = require(`./chapters/${id}.js`);
  const durations = JSON.parse(fs.readFileSync(path.join(BUILD, 'audio', 'durations.json'), 'utf8'));
  const clipDir = path.join(BUILD, 'clips', id), framesDir = path.join(clipDir, 'frames');
  fs.rmSync(clipDir, { recursive: true, force: true }); fs.mkdirSync(framesDir, { recursive: true });

  const api = await request.newContext({ baseURL: base, extraHTTPHeaders: { 'X-Requested-With': 'fetch' } });
  const login = await api.post('/api/auth/login', { data: { email: 'admin@example.com', password: 'Admin-Passw0rd!' } });
  if (login.status() !== 200) throw new Error('sign-in failed: ' + login.status());
  const statePath = path.join(clipDir, 'state.json'); await api.storageState({ path: statePath });
  const call = async (method, url, data) => { const r = await api.fetch(url, { method, data }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status(), json: j, text: t }; };

  const slides = !!chapter.slides;
  const rec = await L.open({ base, framesDir, storageState: statePath, size: slides ? { width: 1920, height: 1080 } : L.VIEW, dsf: slides ? 1 : L.DSF });
  const page = rec.page;
  const ctx = { rec, page, base, api: call, raw: api, oid: null, L, sleep: L.sleep, build: BUILD };
  const w = (fn) => (...a) => fn(rec, ...a);
  Object.assign(ctx, { click: w(L.click), type: w(L.type), hover: w(L.hover), select: w(L.select), scrollBy: w(L.scrollBy), scrollTo: w(L.scrollTo), hl: w(L.highlight), chip: w(L.chip), goto: (u) => L.goto(rec, base + u) });
  ctx.slide = n => page.evaluate(n => window.slide(n), n);
  ctx.reveal = (n, k) => page.evaluate(([n, k]) => window.reveal(n, k), [n, k]);

  if (chapter.ontology) {
    const lib = (await call('GET', '/api/library')).json;
    const o = lib.ontologies.find(x => x.name === chapter.ontology);
    if (!o) throw new Error(`ontology "${chapter.ontology}" not found`);
    ctx.oid = o.id;
  }
  if (chapter.setup) await chapter.setup(ctx);
  const startUrl = slides ? 'file://' + path.join(ROOT, 'slides', 'slides.html') : base + (typeof chapter.start === 'function' ? chapter.start(ctx) : chapter.start || '/#/library');
  await page.goto(startUrl);
  if (chapter.ready) await page.waitForSelector(chapter.ready, { timeout: 30000 });
  if (slides) await page.addStyleTag({ content: '#demo-cursor,#demo-chip{display:none!important}' });
  if (chapter.prepare) await chapter.prepare(ctx);
  await L.sleep(500);
  if (chapter.title && !slides) await ctx.chip(chapter.n, chapter.title);

  await rec.start();
  const beats = [];
  const t0 = L.now();
  for (let i = 0; i < chapter.beats.length; i++) {
    const key = `${id}.${String(i + 1).padStart(2, '0')}`;
    const dur = durations[key];
    if (dur == null) throw new Error(`no narration audio for ${key} - run tts first`);
    const start = L.now(), pending = [];
    ctx.dur = dur; ctx.start = start;
    ctx.at = (frac, fn) => { pending.push(L.sleep(Math.max(0, start * 1000 + frac * dur * 1000 - Date.now())).then(fn)); };
    ctx.until = frac => L.sleep(Math.max(0, start * 1000 + frac * dur * 1000 - Date.now()));
    let actDone = null;
    try {
      const act = chapter.beats[i].act ? chapter.beats[i].act(ctx) : Promise.resolve();
      await Promise.all([act.then(() => { actDone = L.now(); }), L.sleep(dur * 1000 + PAD * 1000)]);
      await Promise.all(pending);
    } catch (e) {
      await page.screenshot({ path: path.join(clipDir, `error-${key}.png`) }).catch(() => {});
      console.error(`FAIL ${key}: ${String(e.message).split('\n')[0]}`); await rec.stop().catch(() => {}); await rec.close(); process.exit(1);
    }
    const end = L.now();
    beats.push({ key, start: start - t0, audio: dur, act: actDone ? actDone - start : null, end: end - t0 });
    const over = actDone && actDone - start > dur + PAD + 0.3 ? `  (actions ran ${(actDone - start - dur).toFixed(1)}s past the narration)` : '';
    const idle = actDone && (actDone - start) < dur * 0.45 && dur > 6 ? `  (screen idle for ${(dur - (actDone - start)).toFixed(1)}s)` : '';
    console.log(`${key}  audio ${dur.toFixed(1)}s  actions ${actDone ? (actDone - start).toFixed(1) : '-'}s${over}${idle}`);
  }
  await L.sleep(chapter.tail ?? 600);
  const out = await rec.stop(); await rec.close();
  const tEnd = L.now();
  fs.writeFileSync(path.join(clipDir, 'timeline.json'), JSON.stringify({ id, title: chapter.title || '', n: chapter.n || 0, slides, t0, tEnd, beats: beats.map(b => ({ ...b, abs: t0 + b.start })), frames: out.frames }, null, 0));
  console.log(`${id}: ${(tEnd - t0).toFixed(1)}s, ${out.frames.length} frames`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
