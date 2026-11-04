import { api, qs, html, raw, setHtml, esc, on, debounce, fail, $, $$ } from './core.js';

const states = new Map();

/**
 * Generic server-driven table: search, filters, sort, pagination, optional row selection.
 * cfg: { key, endpoint, columns:[{label, sort, render(row), cls}], filters:[{name,label,options}], pageSize, selectable, toolbar(), empty, onSelect(ids), rowClass(row) }
 */
export function mountList(root, cfg) {
  const st = states.get(cfg.key) || { q: '', page: 1, sort: '', dir: 'asc', f: {} };
  states.set(cfg.key, st);
  const selected = new Set();
  let data = { rows: [], total: 0 };

  setHtml(root, html`<div class="card">
    <div class="toolbar">
      <input class="search" type="search" placeholder="${cfg.searchPlaceholder || 'Search…'}" value="${st.q}" aria-label="Search">
      ${(cfg.filters || []).map((f) => html`<select data-filter="${f.name}" aria-label="${f.label}"><option value="">${f.label}: all</option>${f.options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return html`<option value="${v}" ${String(st.f[f.name]) === String(v) ? raw('selected') : ''}>${l}</option>`; })}</select>`)}
      <span class="grow"></span><span class="bulk"></span>${cfg.toolbar ? cfg.toolbar() : ''}
    </div>
    <div class="tablewrap"><table><thead></thead><tbody></tbody></table></div>
    <div class="pager"></div></div>`);

  const thead = $('thead', root), tbody = $('tbody', root), pager = $('.pager', root), bulk = $('.bulk', root);

  function drawHead() {
    setHtml(thead, html`<tr>${cfg.selectable ? html`<th style="width:34px"><input type="checkbox" data-act="selall" aria-label="Select all"></th>` : ''}${cfg.columns.map((c) =>
      html`<th class="${c.sort ? 'sortable' : ''} ${c.cls || ''}" ${c.sort ? raw(`data-act="sort" data-sort="${c.sort}"`) : ''}>${c.label}${st.sort === c.sort && c.sort ? (st.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`)}</tr>`);
  }
  function draw() {
    drawHead();
    if (!data.rows.length) setHtml(tbody, html`<tr><td colspan="${cfg.columns.length + (cfg.selectable ? 1 : 0)}" class="empty">${cfg.empty || 'Nothing here yet.'}</td></tr>`);
    else setHtml(tbody, html`${data.rows.map((r) => html`<tr class="${cfg.rowClass?.(r) || ''}">${cfg.selectable ? html`<td><input type="checkbox" data-id="${r.id}" data-act="sel" ${selected.has(r.id) ? raw('checked') : ''} aria-label="Select row"></td>` : ''}${cfg.columns.map((c) => html`<td class="${c.cls || ''}">${c.render(r)}</td>`)}</tr>`)}`);
    const pages = Math.max(1, Math.ceil(data.total / (cfg.pageSize || 25)));
    setHtml(pager, html`<span>${data.total} ${data.total === 1 ? 'record' : 'records'}</span><span class="grow"></span>
      <button class="btn sm" data-act="prev" ${st.page <= 1 ? raw('disabled') : ''}>‹ Prev</button><span>Page ${st.page} of ${pages}</span><button class="btn sm" data-act="next" ${st.page >= pages ? raw('disabled') : ''}>Next ›</button>`);
    drawBulk();
  }
  function drawBulk() {
    if (!cfg.bulk) return;
    setHtml(bulk, selected.size ? html`<span class="muted">${selected.size} selected</span> ${cfg.bulk.map((b) => html`<button class="btn sm ${b.danger ? 'danger' : ''}" data-act="bulk" data-bulk="${b.key}">${b.label}</button>`)}` : '');
    const all = $('[data-act=selall]', root); if (all) all.checked = data.rows.length > 0 && data.rows.every((r) => selected.has(r.id));
  }
  const load = async () => {
    try {
      data = await api('GET', `${cfg.endpoint}${qs({ q: st.q, page: st.page, limit: cfg.pageSize || 25, sort: st.sort, dir: st.dir, ...st.f, ...(cfg.extra?.() || {}) })}`);
      draw();
    } catch (e) { fail(e); }
  };
  const reload = () => load();

  $('.search', root).addEventListener('input', debounce((e) => { st.q = e.target.value.trim(); st.page = 1; load(); }));
  root.addEventListener('change', (e) => {
    if (e.target.dataset.filter) { st.f[e.target.dataset.filter] = e.target.value; st.page = 1; load(); }
  });
  on(root, {
    sort: (el) => { const s = el.dataset.sort; st.dir = st.sort === s && st.dir === 'asc' ? 'desc' : 'asc'; st.sort = s; load(); },
    prev: () => { st.page--; load(); }, next: () => { st.page++; load(); },
    bulk: (el) => cfg.onBulk?.(el.dataset.bulk, [...selected], () => { selected.clear(); load(); }),
  });
  root.addEventListener('change', (e) => {
    const id = Number(e.target.dataset.id);
    if (e.target.dataset.act === 'sel') { e.target.checked ? selected.add(id) : selected.delete(id); drawBulk(); }
    if (e.target.dataset.act === 'selall') { data.rows.forEach((r) => (e.target.checked ? selected.add(r.id) : selected.delete(r.id))); draw(); }
  });
  load();
  return { reload };
}
