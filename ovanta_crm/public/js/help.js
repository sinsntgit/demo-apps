// In-app help: public/help/help.html shown with a contents list, search, zoomable screenshots and print.
import { html, setHtml, modal, $, $$ } from './core.js';

let cache = null;
/** Which help section belongs to which page (used by the "?" button). */
export const HELP_FOR = {
  dashboard: 'dashboard', search: 'search', contacts: 'contacts', accounts: 'accounts', deals: 'deals', tasks: 'tasks', duplicates: 'duplicates',
  invoices: 'invoices', receivables: 'receivables', readiness: 'receivables', 'billing-settings': 'invoicing',
  campaigns: 'campaigns', segments: 'campaigns', templates: 'campaigns', senders: 'senders', notifications: 'notifications',
  customize: 'customize', team: 'team', settings: 'settings',
};
export const helpLink = (path) => `#/help/${HELP_FOR[String(path || '').split('/')[0]] || 'start'}`;

export async function helpView(root, arg) {
  if (!cache) cache = await (await fetch('/help/help.html', { cache: 'no-cache' })).text();
  setHtml(root, html`<div class="help"><aside>
      <h1 style="margin:0 0 12px">Help</h1>
      <input type="search" id="help-q" placeholder="Search help…" aria-label="Search help">
      <nav class="help-toc" aria-label="Help contents"></nav>
      <button class="btn sm" id="help-print" style="margin-top:12px">🖨 Print / save as PDF</button></aside>
    <div class="help-main"><div class="empty" id="help-none" hidden>Nothing in the help matches that. Try a different word.</div><div class="help-body"></div></div></div>`);
  const body = $('.help-body', root); body.innerHTML = cache; // trusted static file shipped with the app
  const sections = $$('section', body); const toc = $('.help-toc', root);
  for (const s of sections) {
    if (s.dataset.role) { const b = document.createElement('div'); b.innerHTML = `<span class="badge plain">For: ${s.dataset.role}</span>`; s.querySelector('h2').after(b); }
    s.querySelectorAll('table').forEach((t) => { const w = document.createElement('div'); w.className = 'tablewrap'; t.replaceWith(w); w.append(t); });
    s.querySelectorAll('img').forEach((img) => {
      img.loading = 'lazy'; img.title = 'Click to enlarge';
      img.addEventListener('click', () => modal({ title: img.alt, wide: true, hideFooter: true, body: html`<img src="${img.src}" alt="${img.alt}" style="width:100%;border-radius:8px;border:1px solid var(--line)">` }));
      img.addEventListener('error', () => img.closest('figure')?.remove());
    });
  }
  const mark = (id) => $$('a', toc).forEach((a) => a.classList.toggle('on', a.dataset.id === id));
  const go = (id) => { const s = body.querySelector(`#${CSS.escape(id)}`); if (!s) return; s.scrollIntoView({ block: 'start' }); history.replaceState(null, '', `#/help/${id}`); mark(id); };
  const drawToc = () => {
    toc.innerHTML = '';
    for (const s of sections.filter((x) => !x.hidden)) { const a = document.createElement('a'); a.href = `#/help/${s.id}`; a.dataset.id = s.id; a.innerHTML = s.dataset.title; a.addEventListener('click', (e) => { e.preventDefault(); go(s.id); }); toc.append(a); }
  };
  $('#help-q', root).addEventListener('input', (e) => {
    const words = e.target.value.toLowerCase().split(/\s+/).filter(Boolean); let shown = 0;
    for (const s of sections) { const hit = words.every((w) => s.textContent.toLowerCase().includes(w)); s.hidden = !hit; shown += hit; }
    $('#help-none', root).hidden = shown > 0; drawToc();
  });
  body.addEventListener('click', (e) => { const a = e.target.closest('a[href^="#/help/"]'); if (a) { e.preventDefault(); go(a.getAttribute('href').slice(7)); } }); // links between sections scroll instead of re-rendering
  $('#help-print', root).addEventListener('click', () => window.print());
  drawToc();
  if (arg && body.querySelector(`#${CSS.escape(arg)}`)) setTimeout(() => go(arg), 30); else { root.scrollIntoView({ block: 'start' }); window.scrollTo(0, 0); mark(sections[0]?.id); }
  // the contents list follows what you are reading
  if ('IntersectionObserver' in window) {
    const seen = new IntersectionObserver((entries) => { const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]; if (top) mark(top.target.id); }, { rootMargin: '0px 0px -70% 0px' });
    sections.forEach((s) => seen.observe(s));
  }
}
