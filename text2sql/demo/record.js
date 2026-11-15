// node demo/record.js <chapter> [<chapter> ...]   - records chapters (files in demo/chapters) to demo/out/<chapter>.mp4
const { Rec, OUT } = require('./lib');
(async () => {
  for (const name of process.argv.slice(2)) {
    const ch = require('./chapters/' + name);
    console.log('recording', name);
    const r = new Rec({ name, storage: ch.storage === undefined ? 'admin' : ch.storage, step: ch.step });
    await r.start(ch.route || '/#/ask');
    try { await ch.run(r); } catch (e) {
      console.log('FAIL', name, '-', e.message.split('\n')[0]);
      await r.page.screenshot({ path: `${OUT}/FAIL-${name}.png` }).catch(() => {});
    }
    await r.finish();
  }
})();
