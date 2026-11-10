import { api, html, raw, setHtml, store, fail, on, $ } from './core.js';
import { viewFile, fileIcon } from './viewer.js';

const EXAMPLES = [
  'Open deals over 50,000 closing this quarter',
  'Proposal PDFs uploaded in the last 30 days',
  'My deals stuck in negotiation',
  'Customers in Riyadh with no phone number',
  'Accounts with more than 3 open deals',
  'Campaigns sent last month with more than 20 opens',
  'Everything about Acme',
];
const OPS = { eq: 'is', neq: 'is not', contains: 'contains', starts_with: 'starts with', gt: '>', gte: '≥', lt: '<', lte: '≤', between: 'between', in: 'is one of', empty: 'is empty', not_empty: 'is not empty' };
const ICON = { deals: '💼', contacts: '👤', accounts: '🏢', files: '📁', campaigns: '✉️', segments: '🎯' };
let last = null; // keep the last result while navigating away and back

export async function aiSearch(root) {
  const params = new URLSearchParams(location.hash.split('?')[1] || ''); const q0 = params.get('q') || last?.q || '';
  let mode = sessionStorage.getItem('searchMode') || 'ai';
  const fields = await api('GET', '/search/fields').catch(() => ({ ai: false, entities: [] }));
  if (!fields.ai) mode = 'keyword';
  setHtml(root, html`<div class="topbar"><h1>✨ AI search</h1><span class="grow"></span><span class="small muted">Ctrl + K opens this page from anywhere</span></div>
    <div class="card"><div class="bd">
      <form id="sq" style="display:flex;gap:8px;flex-wrap:wrap" role="search">
        <input name="q" value="${q0}" placeholder="Ask in plain words — e.g. “open partner deals over 100k with a signed PO”" style="flex:1;min-width:240px;font-size:16px" autocomplete="off" aria-label="Search">
        <select name="mode" style="width:auto" aria-label="Search mode">${fields.ai ? html`<option value="ai" ${mode === 'ai' ? raw('selected') : ''}>✨ AI</option>` : ''}<option value="keyword" ${mode === 'keyword' ? raw('selected') : ''}>Keyword</option></select>
        <button class="btn primary">Search</button></form>
      <div class="pill-row" style="margin-top:10px;display:flex;flex-wrap:wrap;gap:6px">${EXAMPLES.map((e) => html`<button type="button" class="btn sm" data-act="ex" data-q="${e}">${e}</button>`)}</div>
      <p class="small muted" style="margin-bottom:0">${fields.ai ? 'Searches deals, contacts, accounts, files, campaigns and segments — including your custom fields. Only your question and the names of the fields are sent to Claude, never your records; results respect your role.' : 'AI is not configured, so searches match words. An admin can add an Anthropic API key in Settings → AI assistant to search in plain language.'}</p>
    </div></div>
    <div id="sres" class="mt"></div>`);
  const out = $('#sres', root); const form = $('#sq', root);
  const run = async (q) => {
    q = String(q || '').trim(); if (!q) return;
    mode = form.mode.value; sessionStorage.setItem('searchMode', mode);
    history.replaceState(null, '', `#/search?q=${encodeURIComponent(q)}`);
    setHtml(out, html`<div class="card empty">${mode === 'ai' ? 'Thinking about your question…' : 'Searching…'}</div>`);
    try { last = await api('POST', '/search/ai', { q, mode }); draw(last); } catch (e) { setHtml(out, html`<div class="card empty"><p>${e.message}</p></div>`); }
  };
  const draw = (r) => {
    const total = r.groups.reduce((a, g) => a + g.rows.length, 0);
    setHtml(out, html`${r.notice ? html`<div class="card" style="border-color:var(--warn,#d97706)"><div class="bd small">${r.notice}</div></div>` : ''}
      <div class="small muted" style="margin:6px 2px 10px">${r.mode === 'ai' ? html`✨ <b>${r.explanation || 'Results'}</b>` : html`Keyword search for “${r.q}”`} · ${total} result${total === 1 ? '' : 's'}${r.warnings.length ? html` · <span title="${r.warnings.join('\n')}">${r.warnings.length} part${r.warnings.length > 1 ? 's' : ''} of the question could not be used ⓘ</span>` : ''}</div>
      ${r.groups.length ? r.groups.map((g, gi) => html`<div class="card mt"><div class="hd"><h2>${ICON[g.entity] || ''} ${g.label}</h2><span class="muted small">${g.rows.length}${g.more ? '+' : ''}</span><span class="grow"></span>
          ${g.filters.length || g.text ? html`<span class="small muted" style="display:flex;flex-wrap:wrap;gap:4px">${g.text ? html`<span class="badge plain">“${g.text}”</span>` : ''}${g.filters.map((f) => html`<span class="badge plain">${f.field} ${OPS[f.op] || f.op}${['empty', 'not_empty'].includes(f.op) ? '' : ` ${f.value}`}</span>`)}</span>` : ''}</div>
        ${g.rows.length ? html`<div class="tablewrap"><table><tbody>${g.rows.map((x, i) => html`<tr><td style="width:28px">${g.entity === 'files' ? fileIcon(x.file) : ''}</td>
            <td>${g.entity === 'files' ? html`<a href="#" data-act="file" data-g="${gi}" data-i="${i}"><b>${x.title}</b></a>` : html`<a href="${x.link}"><b>${x.title}</b></a>`}<div class="small muted">${x.subtitle}</div></td>
            <td style="text-align:right">${g.entity === 'files' ? html`<a class="btn sm" href="${x.link}">Open record</a>` : ''}</td></tr>`)}</tbody></table></div>
          ${g.more ? html`<div class="bd small muted">More results exist — narrow the question to see them.</div>` : ''}` : html`<div class="bd small muted">Nothing matched.</div>`}</div>`)
      : html`<div class="card empty"><h2>Nothing found</h2><p class="muted">Try other words, or switch between AI and keyword search.</p></div>`}`);
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); run(form.q.value); });
  on(root, {
    ex: (el) => { form.q.value = el.dataset.q; run(el.dataset.q); },
    file: (el) => { const g = last.groups[el.dataset.g]; const files = g.rows.map((x) => x.file); viewFile(files[el.dataset.i], files); },
  });
  if (params.get('q') && params.get('q') !== last?.q) run(params.get('q'));
  else if (last && q0 === last.q) draw(last);
  form.q.focus();
}
