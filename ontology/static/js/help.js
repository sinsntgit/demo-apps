// In-app help: static/help/help.html rendered with a contents list, search and zoomable screenshots.
import { h, fill, modal } from './core.js';

let cache = null;

export async function helpView(root, arg) {
  if (!cache) cache = await (await fetch('/static/help/help.html', { credentials: 'same-origin' })).text();
  const content = h('div', { class: 'help-body', html: cache });
  const sections = [...content.querySelectorAll('section')];
  sections.forEach(s => {
    if (s.dataset.role) s.querySelector('h2').after(h('div', {}, h('span', { class: 'badge info' }, 'For: ', h('span', { html: s.dataset.role }))));
    s.querySelectorAll('table').forEach(t => { t.classList.add('tbl'); const w = h('div', { class: 'tbl-wrap', style: 'max-height:none' }); t.replaceWith(w); w.append(t); });
    s.querySelectorAll('img').forEach(img => {
      img.loading = 'lazy'; img.title = 'Click to enlarge';
      img.addEventListener('click', () => modal(img.alt, h('img', { src: img.src, alt: img.alt, style: 'width:100%;border-radius:8px;border:1px solid var(--border)' }), { wide: true }));
      img.addEventListener('error', () => img.closest('figure')?.remove());
    });
  });
  const toc = h('nav', { class: 'help-toc', 'aria-label': 'Help contents' });
  const search = h('input', { type: 'search', placeholder: 'Search help…', 'aria-label': 'Search help' });
  const none = h('div', { class: 'empty hidden' }, 'Nothing in the help matches that. Try a different word.');
  const go = id => { const s = content.querySelector('#' + CSS.escape(id)); if (s) { s.scrollIntoView({ block: 'start' }); history.replaceState(null, '', '#/help/' + id); mark(id); } };
  const mark = id => toc.querySelectorAll('a').forEach(a => a.classList.toggle('on', a.dataset.id === id));
  const drawToc = () => fill(toc, sections.filter(s => !s.classList.contains('hidden')).map(s =>
    h('a', { href: '#/help/' + s.id, 'data-id': s.id, onclick: e => { e.preventDefault(); go(s.id); }, html: s.dataset.title })));
  search.addEventListener('input', () => {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    sections.forEach(s => { const hit = words.every(w => s.textContent.toLowerCase().includes(w)); s.classList.toggle('hidden', !hit); shown += hit; });
    none.classList.toggle('hidden', shown > 0);
    drawToc();
  });
  content.addEventListener('click', e => {      // links between help sections scroll instead of reloading
    const a = e.target.closest('a[href^="#/help/"]');
    if (a) { e.preventDefault(); go(a.getAttribute('href').slice(7)); }
  });
  drawToc();
  fill(root, h('div', { class: 'help' },
    h('aside', {}, h('h1', { style: 'margin-bottom:12px' }, 'Help'), search, toc,
      h('button', { class: 'btn sm', style: 'margin-top:12px', onclick: () => window.print() }, '🖨 Print / save as PDF')),
    h('div', { class: 'help-main' }, none, content)));
  if (arg) setTimeout(() => go(arg), 30); else mark(sections[0].id);
}
