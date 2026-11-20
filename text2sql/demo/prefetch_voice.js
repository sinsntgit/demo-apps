// node demo/prefetch_voice.js   - synthesises every narration sentence found in demo/chapters/*.js (r.say('...') and vo('...')),
// so that recording never waits for the narrator. Needs demo/tts_server.py running.
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, 'chapters');
const re = /\b(?:say|vo)\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
(async () => {
  let n = 0, secs = 0;
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8'); let m;
    while ((m = re.exec(src))) {
      const text = new Function('return ' + m[1] + m[2] + m[1])();
      const r = await fetch('http://127.0.0.1:8777/tts', { method: 'POST', body: JSON.stringify({ text }) });
      const j = await r.json(); n++; secs += j.dur;
    }
  }
  console.log(`narration: ${n} sentences, ${(secs / 60).toFixed(1)} minutes of speech`);
})();
