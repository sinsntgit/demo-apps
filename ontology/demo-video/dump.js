// Writes build/narration.json from the chapter files (the single source of the spoken text).
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, 'chapters'), out = [];
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()) {
  const ch = require(path.join(dir, f)); const id = f.replace(/\.js$/, '');
  ch.beats.forEach((b, i) => out.push({ key: `${id}.${String(i + 1).padStart(2, '0')}`, chapter: id, title: ch.title || '', say: b.say }));
}
fs.mkdirSync(path.join(__dirname, 'build'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'build', 'narration.json'), JSON.stringify(out, null, 1));
console.log(out.length + ' beats, ' + out.reduce((n, b) => n + b.say.split(/\s+/).length, 0) + ' words');
