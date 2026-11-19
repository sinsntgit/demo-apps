import { api, html, raw, setHtml, store, toast, fail, modal, confirmBox, money, pct, fmtDate, $, $$, debounce, hasC2, money2, curOf } from './core.js';

/*
 * Business review (MBR / QBR): pipeline & forecast for a month, quarter or year — won, worst case, projected and best case,
 * with closure estimates per deal. Everything on the "Customise" panel is part of a report view that can be saved
 * (just for you, or shared), exported to CSV and printed / saved as PDF.
 */
const COLUMNS = [
  ['name', 'Deal'], ['account', 'Account'], ['owner', 'Owner'], ['contact', 'Contact / lead'], ['stage', 'Stage'], ['category', 'Forecast category'],
  ['amount', 'Amount'], ['amount2', 'Amount (2nd currency)'], ['probability', 'Probability'], ['weighted', 'Weighted'], ['close_date', 'Expected close'],
  ['est_close', 'Close estimate'], ['days_in_stage', 'Days in stage'], ['age_days', 'Age (days)'], ['created_at', 'Created'],
];
const DEFAULT_COLS = ['name', 'account', 'owner', 'stage', 'category', 'amount', 'probability', 'weighted', 'est_close', 'days_in_stage'];
const CAT_STYLE = { won: '#15803d', commit: '#0d9488', best_case: '#2563eb', pipeline: '#94a3b8', lost: '#b91c1c' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const store_ = { get: (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } } };

const defaults = () => ({ period: { type: 'quarter', fy_start: 1 }, scope: 'period', include_slipped: true, worst_threshold: 75, best_threshold: 25, target: '', group_by: 'owner', filters: {}, columns: DEFAULT_COLS, sort: { key: 'est_close', dir: 'asc' }, notes: '' });

export async function review(root) {
  let cfg = { ...defaults(), ...(store_.get('reviewCfg') || {}) }; let viewId = store_.get('reviewView'); let data = null; let views = [];
  const [acc] = await Promise.all([api('GET', '/accounts?limit=1000&sort=name')]);
  const accounts = acc.rows.map((a) => [a.id, a.name]);
  const loadViews = async () => { views = await api('GET', '/reports/views'); if (viewId && !views.some((v) => v.id === viewId)) viewId = null; };
  await loadViews();

  const colLabel = (k) => (k.startsWith('cf:') ? (data?.custom_fields.find((f) => `cf:${f.key}` === k)?.label || k) : k === 'amount2' ? `Amount (${curOf().c2 || '2nd'})` : (COLUMNS.find((c) => c[0] === k) || [k, k])[1]);
  const cell = (d, k, forCsv = false) => {
    if (k.startsWith('cf:')) { const v = d.custom?.[k.slice(3)]; return Array.isArray(v) ? v.join(', ') : v ?? ''; }
    switch (k) {
      case 'name': return forCsv ? d.name : html`<a href="#/deals/${d.id}">${d.name}</a>`;
      case 'account': return d.account_name || ''; case 'owner': return d.owner_name || ''; case 'contact': return d.contact_name || '';
      case 'stage': return d.stage_label; case 'category': return forCsv ? data.categories[d.category] : html`<span class="badge plain" style="background:${CAT_STYLE[d.category]}1a;color:${CAT_STYLE[d.category]}">${data.categories[d.category]}</span>`;
      case 'amount': return forCsv ? d.amount : money(d.amount); case 'amount2': return forCsv ? (d.amount2 ?? '') : d.amount2 == null ? '—' : money2(d.amount2);
      case 'probability': return forCsv ? d.probability : `${d.probability}%`; case 'weighted': return forCsv ? Math.round(d.weighted) : money(d.weighted);
      case 'close_date': return forCsv ? (d.close_date || '') : d.close_date ? fmtDate(d.close_date) : '—';
      case 'est_close': if (forCsv) return d.est_close; return d.closed_on ? html`${fmtDate(d.closed_on)} <span class="small muted">closed</span>` : html`${fmtDate(d.est_close)}${d.estimated ? html` <span class="small muted" title="No expected close date — estimated from your average sales cycle">est.</span>` : ''}${d.slipped ? html` <span class="badge lost plain" title="Expected close date has passed">slipped</span>` : ''}`;
      case 'days_in_stage': return d.days_in_stage; case 'age_days': return d.age_days; case 'created_at': return forCsv ? d.created_at : fmtDate(d.created_at);
      default: return '';
    }
  };
  const sortVal = (d, k) => (k.startsWith('cf:') ? String(d.custom?.[k.slice(3)] ?? '') : k === 'account' ? d.account_name || '' : k === 'owner' ? d.owner_name || '' : k === 'stage' ? store.meta.stages.findIndex((s) => s.key === d.stage) : k === 'category' ? ['won', 'commit', 'best_case', 'pipeline', 'lost'].indexOf(d.category) : d[k] ?? '');
  const sorted = () => { const { key, dir } = cfg.sort || {}; const m = dir === 'desc' ? -1 : 1; return [...data.deals].sort((a, b) => { const x = sortVal(a, key), y = sortVal(b, key); return (x > y ? 1 : x < y ? -1 : 0) * m; }); };

  const periodControls = () => {
    const p = cfg.period; const now = new Date();
    const fyNow = p.fy_start > 1 && now.getMonth() + 1 >= p.fy_start ? now.getFullYear() + 1 : now.getFullYear();
    const qs = []; for (let y = fyNow - 1; y <= fyNow + 1; y++) for (let q = 1; q <= 4; q++) qs.push([`${y}-Q${q}`, `Q${q} ${p.fy_start > 1 ? 'FY' : ''}${y}`]);
    const curQ = data?.period.quarter;
    return html`<label>Review period<select data-c="period.type">${[['month', 'Month (MBR)'], ['quarter', 'Quarter (QBR)'], ['year', 'Year'], ['custom', 'Custom dates']].map(([v, l]) => html`<option value="${v}" ${p.type === v ? raw('selected') : ''}>${l}</option>`)}</select></label>
      ${p.type === 'month' ? html`<label>Month<input type="month" data-c="period.month" value="${p.month || (data?.period.from || '').slice(0, 7)}"></label>` : ''}
      ${p.type === 'quarter' ? html`<label>Quarter<select data-c="period.quarter">${qs.map(([v, l]) => html`<option value="${v}" ${(p.quarter || curQ) === v ? raw('selected') : ''}>${l}</option>`)}</select></label>` : ''}
      ${p.type === 'year' ? html`<label>${p.fy_start > 1 ? 'Fiscal year' : 'Year'}<input type="number" data-c="period.year" value="${p.year || data?.period.year || fyNow}" min="2000" max="2100"></label>` : ''}
      ${p.type === 'custom' ? html`<label>From<input type="date" data-c="period.from" value="${p.from || ''}"></label><label>To<input type="date" data-c="period.to" value="${p.to || ''}"></label>` : ''}
      ${p.type === 'quarter' || p.type === 'year' ? html`<label>Fiscal year starts<select data-c="period.fy_start">${MONTHS.map((m, i) => html`<option value="${i + 1}" ${Number(p.fy_start || 1) === i + 1 ? raw('selected') : ''}>${m}</option>`)}</select></label>` : ''}`;
  };
  const multi = (path, label, options, size = 4) => { const cur = (get(path) || []).map(String); return html`<label>${label} <span class="small muted">(Ctrl/⌘-click for several)</span><select multiple size="${size}" data-c="${path}" data-multi>${options.map(([v, l]) => html`<option value="${v}" ${cur.includes(String(v)) ? raw('selected') : ''}>${l}</option>`)}</select></label>`; };
  const get = (path) => path.split('.').reduce((o, k) => o?.[k], cfg);
  const set = (path, v) => { const ks = path.split('.'); let o = cfg; for (const k of ks.slice(0, -1)) o = o[k] ??= {}; o[ks.at(-1)] = v; };

  const controls = () => html`<details class="card rp-controls" ${store_.get('reviewOpen') === false ? '' : raw('open')}><summary class="hd" style="cursor:pointer"><h2>Customise report</h2><span class="grow"></span><span class="small muted">period · deals included · scenarios · filters · columns</span></summary><div class="bd" style="display:grid;gap:14px">
      <div class="rp-grid">${periodControls()}</div>
      <div class="rp-grid">
        <label>Deals included<select data-c="scope"><option value="period" ${cfg.scope !== 'all_open' ? raw('selected') : ''}>Closing in the period (plus won / lost in it)</option><option value="all_open" ${cfg.scope === 'all_open' ? raw('selected') : ''}>All open deals (plus won / lost in the period)</option></select></label>
        <label class="check" style="align-self:end"><input type="checkbox" data-c="include_slipped" ${cfg.include_slipped !== false ? raw('checked') : ''}> Include slipped deals (expected date already passed)</label>
        <label>Worst case = deals at ≥ %<input type="number" min="0" max="100" data-c="worst_threshold" value="${cfg.worst_threshold}"></label>
        <label>Best case adds deals at ≥ %<input type="number" min="0" max="100" data-c="best_threshold" value="${cfg.best_threshold}"></label>
        <label>Target / quota for the period<input type="number" min="0" step="1000" data-c="target" value="${cfg.target ?? ''}" placeholder="optional"></label>
      </div>
      <div class="rp-grid">
        ${multi('filters.owner_ids', 'Owners', store.meta.users.map((u) => [u.id, u.name]))}
        ${multi('filters.stages', 'Stages', store.meta.stages.map((s) => [s.key, s.label]))}
        ${multi('filters.account_ids', 'Accounts', accounts)}
        ${multi('filters.categories', 'Forecast categories', [['won', 'Won'], ['commit', 'Commit'], ['best_case', 'Best case'], ['pipeline', 'Pipeline'], ['lost', 'Lost']], 5)}
      </div>
      <div class="rp-grid">
        <label>Min amount<input type="number" data-c="filters.min_amount" value="${cfg.filters.min_amount ?? ''}"></label><label>Max amount<input type="number" data-c="filters.max_amount" value="${cfg.filters.max_amount ?? ''}"></label>
        <label>Deal or account contains<input data-c="filters.q" value="${cfg.filters.q ?? ''}"></label>
        ${(data?.custom_fields || []).filter((f) => ['select', 'list', 'radio', 'multiselect', 'checkbox'].includes(f.type) && (f.options || []).length).map((f) => html`<label>${f.label}<select data-c="filters.custom.${f.key}"><option value="">Any</option>${f.options.map((o) => { const v = typeof o === 'object' ? o.value ?? o.label : o; const l = typeof o === 'object' ? o.label ?? o.value : o; return html`<option value="${v}" ${String(cfg.filters.custom?.[f.key] ?? '') === String(v) ? raw('selected') : ''}>${l}</option>`; })}</select></label>`)}
      </div>
      <div class="rp-grid">
        <label>Group summary by<select data-c="group_by">${[['owner', 'Owner'], ['stage', 'Stage'], ['category', 'Forecast category'], ['account', 'Account'], ['month', 'Close month']].map(([v, l]) => html`<option value="${v}" ${cfg.group_by === v ? raw('selected') : ''}>${l}</option>`)}</select></label>
        <label>Sort deals by<select data-c="sort.key">${[...COLUMNS.filter((c) => c[0] !== 'amount2' || hasC2()), ...(data?.custom_fields || []).map((f) => [`cf:${f.key}`, f.label])].map(([v, l]) => html`<option value="${v}" ${cfg.sort?.key === v ? raw('selected') : ''}>${l}</option>`)}</select></label>
        <label>Order<select data-c="sort.dir"><option value="asc" ${cfg.sort?.dir !== 'desc' ? raw('selected') : ''}>Ascending</option><option value="desc" ${cfg.sort?.dir === 'desc' ? raw('selected') : ''}>Descending</option></select></label>
      </div>
      <div><div class="small" style="font-weight:600;margin-bottom:6px">Columns in the deal list</div><div class="pill-row">${[...COLUMNS.filter((c) => c[0] !== 'amount2' || hasC2()), ...(data?.custom_fields || []).map((f) => [`cf:${f.key}`, f.label])].map(([k, l]) => html`<label class="chip" style="cursor:pointer"><input type="checkbox" data-col="${k}" ${cfg.columns.includes(k) ? raw('checked') : ''} style="vertical-align:middle"> ${l}</label>`)}</div></div>
      <div class="small muted">Worst case = won + deals at or above the worst-case probability (“commit”). Projected = worst case + best-case deals × their probability (the most likely outcome). Best case = worst case + best-case deals in full. So worst ≤ projected ≤ best; pipeline deals below the best-case probability count in none of them (their weighted value is shown under the tiles). Open deals without an expected close date are estimated from your average sales cycle (${data?.summary.cycle_days ?? '…'} days${data && !data.summary.cycle_from_history ? ', a default until you have won deals' : ''}).</div>
    </div></details>`;

  const tile = (label, v, v2, sub, color) => html`<div class="card kpi" style="border-top:3px solid ${color}"><div class="l">${label}</div><div class="v">${money(v, true)}</div>${v2 != null && hasC2() ? html`<div class="s"><b>${money2(v2, true)}</b></div>` : ''}<div class="s">${sub}</div></div>`;
  const bar = (s) => {
    const max = Math.max(s.best_case, s.target || 0, 1); const w = (v) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
    return html`<div class="card mt"><div class="bd"><div class="small" style="font-weight:600;margin-bottom:8px">Scenarios${s.target ? ' against target' : ''}</div>
      <div style="position:relative;height:30px;background:#f1f5f9;border-radius:8px;overflow:hidden">
        <div title="Best case ${money(s.best_case)}" style="position:absolute;inset:0 auto 0 0;width:${w(s.best_case)};background:${CAT_STYLE.best_case}40"></div>
        <div title="Projected ${money(s.projected)}" style="position:absolute;inset:0 auto 0 0;width:${w(s.projected)};background:${CAT_STYLE.best_case}90"></div>
        <div title="Worst case ${money(s.worst_case)}" style="position:absolute;inset:0 auto 0 0;width:${w(s.worst_case)};background:${CAT_STYLE.commit}"></div>
        <div title="Won ${money(s.won)}" style="position:absolute;inset:0 auto 0 0;width:${w(s.won)};background:${CAT_STYLE.won}"></div>
        ${s.target ? html`<div title="Target ${money(s.target)}" style="position:absolute;top:0;bottom:0;left:${w(s.target)};border-left:3px dashed #111"></div>` : ''}
      </div>
      <div class="pill-row small" style="margin-top:8px"><span><span style="color:${CAT_STYLE.won}">■</span> Won</span><span><span style="color:${CAT_STYLE.commit}">■</span> Worst case</span><span><span style="color:${CAT_STYLE.best_case}90">■</span> Projected</span><span><span style="color:${CAT_STYLE.best_case}40">■</span> Best case</span>${s.target ? html`<span>┆ Target ${money(s.target, true)}</span>` : ''}</div></div></div>`;
  };
  const totalsRow = (r, label, link) => html`<tr style="${r.count ? '' : 'opacity:.45'}"><td class="nowrap">${link || label}</td><td class="num">${r.count}</td><td class="num">${money(r.won)}</td><td class="num">${money(r.worst_case)}</td><td class="num"><b>${money(r.projected)}</b></td><td class="num">${money(r.best_case)}</td><td class="num">${money(r.pipeline)}</td><td class="num">${r.slipped_count || ''}</td></tr>`;
  const totalsHead = (first) => html`<thead><tr><th>${first}</th><th class="num">Deals</th><th class="num">Won</th><th class="num">Worst case</th><th class="num">Projected</th><th class="num">Best case</th><th class="num">Open pipeline</th><th class="num">Slipped</th></tr></thead>`;

  const body = () => {
    const s = data.summary; const p = data.period;
    const filt = [cfg.filters.owner_ids?.length && `Owners: ${cfg.filters.owner_ids.map((id) => store.meta.users.find((u) => String(u.id) === String(id))?.name).join(', ')}`, cfg.filters.stages?.length && `Stages: ${cfg.filters.stages.map((k) => store.meta.stages.find((x) => x.key === k)?.label || k).join(', ')}`, cfg.filters.account_ids?.length && `${cfg.filters.account_ids.length} account(s)`, cfg.filters.categories?.length && `Categories: ${cfg.filters.categories.map((k) => data.categories[k]).join(', ')}`, cfg.filters.q && `“${cfg.filters.q}”`, (cfg.filters.min_amount || cfg.filters.max_amount) && `Amount ${cfg.filters.min_amount || 0}–${cfg.filters.max_amount || '∞'}`].filter(Boolean);
    return html`<div class="rp-head"><h2 style="margin:0">Pipeline &amp; forecast review — ${p.label}</h2><div class="small muted">${fmtDate(p.from)} – ${fmtDate(p.to)} · ${cfg.scope === 'all_open' ? 'all open deals' : 'deals closing in the period'}${cfg.include_slipped !== false ? ', incl. slipped' : ''} · worst case ≥ ${data.settings.worst_threshold}%, best case ≥ ${data.settings.best_threshold}% · ${filt.length ? filt.join(' · ') : 'all deals you can see'} · generated ${new Date(data.generated_at).toLocaleString()}</div></div>
      <div class="grid g4 mt rp-tiles">
        ${tile('Won', s.won, s.won2, `${s.won_count} deal${s.won_count === 1 ? '' : 's'}${s.target ? ` · ${pct(s.attainment, 0)} of target` : ''}`, CAT_STYLE.won)}
        ${tile('Worst case', s.worst_case, s.worst_case2, s.target ? (s.gap_worst > 0 ? `${money(s.gap_worst, true)} short of target` : `${money(-s.gap_worst, true)} above target`) : `won + commit (${money(s.commit, true)})`, CAT_STYLE.commit)}
        ${tile('Projected', s.projected, s.projected2, s.target ? (s.gap_projected > 0 ? `${money(s.gap_projected, true)} short of target` : `${money(-s.gap_projected, true)} above target`) : `worst case + best-case deals × probability`, '#1d4ed8')}
        ${tile('Best case', s.best_case, s.best_case2, s.target ? (s.gap_best > 0 ? `${money(s.gap_best, true)} short of target` : `${money(-s.gap_best, true)} above target`) : `worst case + best-case deals (${money(s.best_case_only, true)})`, CAT_STYLE.best_case)}
      </div>
      <div class="small muted" style="margin-top:8px">${s.open_count} open deal${s.open_count === 1 ? '' : 's'} worth ${money(s.pipeline)} (weighted ${money(s.weighted_open)})${s.slipped_count ? html` · <b style="color:var(--bad)">${s.slipped_count} slipped (${money(s.slipped, true)})</b>` : ''} · lost ${s.lost_count} (${money(s.lost, true)}) · win rate ${s.win_rate == null ? '—' : pct(s.win_rate, 0)} · average won deal ${s.avg_won == null ? '—' : money(s.avg_won)} · average sales cycle ${s.cycle_days} days · ${s.new_deals} new deal${s.new_deals === 1 ? '' : 's'} created in the period</div>
      ${bar(s)}
      <div class="rp-two">
        <div class="card mt"><div class="hd"><h2>By close month</h2></div><div class="tablewrap"><table>${totalsHead('Month')}<tbody>${data.by_month.map((m) => totalsRow(m, m.label))}</tbody></table></div></div>
        <div class="card mt"><div class="hd"><h2>By ${({ owner: 'owner', stage: 'stage', category: 'forecast category', account: 'account', month: 'close month' })[cfg.group_by]}</h2></div><div class="tablewrap"><table>${totalsHead(({ owner: 'Owner', stage: 'Stage', category: 'Category', account: 'Account', month: 'Month' })[cfg.group_by])}<tbody>${data.groups.length ? data.groups.map((g) => totalsRow(g, g.label)) : html`<tr><td colspan="8" class="empty">No deals</td></tr>`}</tbody><tfoot>${totalsRow(s, html`<b>Total</b>`)}</tfoot></table></div></div>
      </div>
      <div class="card mt"><div class="hd"><h2>Deals (${data.deals.length})</h2><span class="grow"></span><span class="small muted">Close estimate = expected close date, or an estimate (“est.”) from the average sales cycle</span></div>
        <div class="tablewrap"><table class="rp-deals"><thead><tr>${cfg.columns.map((k) => html`<th class="${['amount', 'amount2', 'weighted', 'probability', 'days_in_stage', 'age_days'].includes(k) ? 'num' : ''}"><a href="#" data-sort="${k}" style="color:inherit">${colLabel(k)}${cfg.sort?.key === k ? (cfg.sort.dir === 'desc' ? ' ↓' : ' ↑') : ''}</a></th>`)}</tr></thead>
        <tbody>${data.deals.length ? sorted().map((d) => html`<tr>${cfg.columns.map((k) => html`<td class="${['amount', 'amount2', 'weighted', 'probability', 'days_in_stage', 'age_days'].includes(k) ? 'num' : ''}">${cell(d, k)}</td>`)}</tr>`) : html`<tr><td colspan="${cfg.columns.length}" class="empty">No deals match. Widen the period or filters.</td></tr>`}</tbody></table></div></div>
      <div class="card mt"><div class="hd"><h2>Review notes</h2><span class="grow"></span><span class="small muted rp-noprint">printed with the report; saved with the report view</span></div><div class="bd"><textarea data-c="notes" rows="4" placeholder="Key wins, risks, deals to escalate, asks for leadership…" style="width:100%">${cfg.notes || ''}</textarea><div class="rp-printnotes" style="white-space:pre-wrap">${cfg.notes || ''}</div></div></div>`;
  };

  const draw = () => {
    const v = views.find((x) => x.id === viewId);
    setHtml(root, html`<div class="topbar"><h1>Business review</h1><span class="grow"></span>
        <select id="rpview" aria-label="Saved report" style="width:auto"><option value="">Unsaved report</option>${views.map((x) => html`<option value="${x.id}" ${x.id === viewId ? raw('selected') : ''}>${x.name}${x.shared ? ' (shared)' : ''}${x.owner_id !== store.user.id ? ` — ${x.owner_name}` : ''}</option>`)}</select>
        ${v && (v.owner_id === store.user.id || store.user.role === 'admin') ? html`<button class="btn" data-ract="save">Save</button><button class="btn danger" data-ract="del" aria-label="Delete saved report">✕</button>` : ''}
        <button class="btn" data-ract="saveas">Save as…</button><button class="btn" data-ract="csv">Export CSV</button><button class="btn primary" data-ract="print">Print / PDF</button></div>
      <div id="rpc"></div><div id="rpb" class="mt">${data ? body() : html`<div class="empty">Loading…</div>`}</div>`);
    setHtml($('#rpc', root), controls());
  };
  const refresh = async () => {
    try { data = await api('POST', '/reports/pipeline', cfg); } catch (e) { fail(e); return; }
    store_.set('reviewCfg', cfg); setHtml($('#rpb', root), body());
    const open = $('#rpc details', root)?.open; setHtml($('#rpc', root), controls()); if (open === false) $('#rpc details', root).open = false;
  };
  const later = debounce(refresh, 300);

  root.onchange = (e) => {
    const t = e.target;
    if (t.id === 'rpview') { viewId = t.value ? Number(t.value) : null; store_.set('reviewView', viewId); const v = views.find((x) => x.id === viewId); if (v) cfg = { ...defaults(), ...v.config }; draw(); refresh(); return; }
    if (t.dataset.col) { const k = t.dataset.col; cfg.columns = t.checked ? [...cfg.columns, k] : cfg.columns.filter((x) => x !== k); setHtml($('#rpb', root), body()); store_.set('reviewCfg', cfg); return; }
    const path = t.dataset.c; if (!path || path === 'notes') return;
    let v = t.type === 'checkbox' ? t.checked : t.dataset.multi !== undefined ? [...t.selectedOptions].map((o) => o.value) : t.value;
    if (['worst_threshold', 'best_threshold', 'period.fy_start'].includes(path)) v = Number(v);
    set(path, v);
    if (path === 'period.type' || path === 'period.fy_start') { delete cfg.period.month; delete cfg.period.quarter; delete cfg.period.year; }
    if (path.startsWith('sort.')) { setHtml($('#rpb', root), body()); store_.set('reviewCfg', cfg); return; }
    later();
  };
  root.oninput = (e) => { if (e.target.dataset.c === 'notes') { cfg.notes = e.target.value; const pn = $('.rp-printnotes', root); if (pn) pn.textContent = cfg.notes; store_.set('reviewCfg', cfg); } else if (e.target.matches('input[type=number][data-c], input[data-c="filters.q"]')) { set(e.target.dataset.c, e.target.value); later(); } };
  root.onclick = async (e) => {
    const s = e.target.closest('[data-sort]'); if (s) { e.preventDefault(); const k = s.dataset.sort; cfg.sort = { key: k, dir: cfg.sort?.key === k && cfg.sort.dir !== 'desc' ? 'desc' : 'asc' }; setHtml($('#rpb', root), body()); return; }
    if (e.target.closest('summary')) setTimeout(() => store_.set('reviewOpen', $('#rpc details', root)?.open), 0);
    const b = e.target.closest('[data-ract]'); if (!b) return;
    try {
      const act = b.dataset.ract;
      if (act === 'print') window.print();
      if (act === 'csv') {
        const cols = cfg.columns; const q = (x) => { const s = String(x ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
        const lines = [cols.map((k) => q(colLabel(k))).join(','), ...sorted().map((d) => cols.map((k) => q(cell(d, k, true))).join(','))];
        const s = data.summary; lines.push('', q(`Review period ${data.period.label} (${data.period.from} – ${data.period.to})`), `Won,${s.won}`, `Worst case,${s.worst_case}`, `Projected,${Math.round(s.projected)}`, `Best case,${s.best_case}`, ...(s.target ? [`Target,${s.target}`] : []));
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' })); a.download = `business-review-${data.period.label.replace(/\s+/g, '-')}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      }
      if (act === 'saveas') modal({ title: 'Save report', submitLabel: 'Save', body: html`<label>Name<input name="name" required maxlength="80" placeholder="e.g. QBR — EMEA team"></label><label class="check"><input type="checkbox" name="shared"> Share with everyone (they see only the deals they are allowed to see)</label><p class="small muted">Saves the period type, filters, thresholds, target, grouping, columns and notes. A quarter or month you picked stays fixed; leave it on the current one to always open the current period.</p>`,
        onSubmit: async (f) => { const v = await api('POST', '/reports/views', { name: f.name.value, shared: f.shared.checked, config: cfg }); viewId = v.id; store_.set('reviewView', viewId); await loadViews(); toast('Report saved', 'ok'); draw(); setHtml($('#rpb', root), body()); } });
      if (act === 'save') { const v = views.find((x) => x.id === viewId); await api('PUT', `/reports/views/${v.id}`, { name: v.name, shared: v.shared, config: cfg }); await loadViews(); toast('Report saved', 'ok'); }
      if (act === 'del') { const v = views.find((x) => x.id === viewId); if (await confirmBox(`Delete the saved report “${v.name}”?`, 'Delete')) { await api('DELETE', `/reports/views/${v.id}`); viewId = null; store_.set('reviewView', null); await loadViews(); draw(); setHtml($('#rpb', root), body()); } }
    } catch (x) { fail(x); }
  };
  if (viewId) { const v = views.find((x) => x.id === viewId); if (v) cfg = { ...defaults(), ...v.config }; }
  draw(); await refresh();
}
