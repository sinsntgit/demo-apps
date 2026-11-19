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

  const get = (path) => path.split('.').reduce((o, k) => o?.[k], cfg);
  const set = (path, v) => { const ks = path.split('.'); let o = cfg; for (const k of ks.slice(0, -1)) o = o[k] ??= {}; o[ks.at(-1)] = v; };
  const optVal = (o) => (typeof o === 'object' ? o.value ?? o.label : o), optLabel = (o) => (typeof o === 'object' ? o.label ?? o.value : o);

  /** The filters offered in the toolbar: each opens a pop-up, and shows as a pill once something is chosen. */
  const filterDefs = () => [
    { id: 'owners', label: 'Owner', path: 'filters.owner_ids', options: store.meta.users.map((u) => [String(u.id), u.name]) },
    { id: 'stages', label: 'Stage', path: 'filters.stages', options: store.meta.stages.map((x) => [x.key, x.label]) },
    { id: 'accounts', label: 'Account', path: 'filters.account_ids', options: accounts.map(([v, l]) => [String(v), l]) },
    { id: 'categories', label: 'Forecast category', path: 'filters.categories', options: [['won', 'Won'], ['commit', 'Commit'], ['best_case', 'Best case'], ['pipeline', 'Pipeline'], ['lost', 'Lost']] },
    ...(data?.custom_fields || []).filter((f) => ['select', 'list', 'radio', 'dropdown', 'multiselect'].includes(f.type) && (f.options || []).length)
      .map((f) => ({ id: `cf:${f.key}`, label: f.label, path: `filters.custom.${f.key}`, options: f.options.map((o) => [String(optVal(o)), String(optLabel(o))]) })),
    { id: 'amount', label: 'Amount', range: true },
  ];
  const chosen = (fd) => { if (fd.range) return cfg.filters.min_amount || cfg.filters.max_amount ? [1] : []; const v = get(fd.path); return (Array.isArray(v) ? v : v ? [v] : []).map(String); };
  const pillText = (fd) => {
    if (fd.range) { const a = cfg.filters.min_amount, b = cfg.filters.max_amount; return a && b ? `${money(a, true)} – ${money(b, true)}` : a ? `≥ ${money(a, true)}` : `≤ ${money(b, true)}`; }
    const names = chosen(fd).map((v) => fd.options.find(([k]) => k === v)?.[1] || v); return names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ');
  };
  const periodPicker = () => {
    const p = cfg.period; const now = new Date(); const fy = Number(p.fy_start || 1);
    const fyNow = fy > 1 && now.getMonth() + 1 >= fy ? now.getFullYear() + 1 : now.getFullYear();
    const qs = []; for (let y = fyNow - 1; y <= fyNow + 1; y++) for (let q = 1; q <= 4; q++) qs.push([`${y}-Q${q}`, `Q${q} ${fy > 1 ? 'FY' : ''}${y}`]);
    if (p.type === 'month') return html`<input type="month" class="rp-ctl" data-c="period.month" value="${p.month || (data?.period.from || '').slice(0, 7)}" aria-label="Month">`;
    if (p.type === 'quarter') return html`<select class="rp-ctl" data-c="period.quarter" aria-label="Quarter">${qs.map(([v, l]) => html`<option value="${v}" ${(p.quarter || data?.period.quarter) === v ? raw('selected') : ''}>${l}</option>`)}</select>`;
    if (p.type === 'year') return html`<select class="rp-ctl" data-c="period.year" aria-label="Year">${[fyNow - 2, fyNow - 1, fyNow, fyNow + 1].map((y) => html`<option value="${y}" ${Number(p.year || data?.period.year || fyNow) === y ? raw('selected') : ''}>${fy > 1 ? 'FY' : ''}${y}</option>`)}</select>`;
    return html`<input type="date" class="rp-ctl" data-c="period.from" value="${p.from || ''}" aria-label="From"><span class="muted">to</span><input type="date" class="rp-ctl" data-c="period.to" value="${p.to || ''}" aria-label="To">`;
  };
  const settingsSummary = () => [cfg.scope === 'all_open' ? 'All open deals' : 'Deals closing in the period', cfg.include_slipped !== false ? 'incl. slipped' : 'excl. slipped', `Worst case ≥ ${cfg.worst_threshold}%`, `Best case ≥ ${cfg.best_threshold}%`, cfg.target ? `Target ${money(cfg.target, true)}` : null, Number(cfg.period.fy_start || 1) > 1 ? `FY starts ${MONTHS[cfg.period.fy_start - 1]}` : null].filter(Boolean).join(' · ');

  const controls = () => {
    const defs = filterDefs(); const active = defs.filter((fd) => chosen(fd).length); const idle = defs.filter((fd) => !chosen(fd).length);
    return html`<div class="card rp-bar"><div class="bd">
      <div class="rp-row">
        <div class="rp-seg" role="tablist" aria-label="Review period">${[['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year'], ['custom', 'Custom']].map(([v, l]) => html`<button type="button" role="tab" class="${cfg.period.type === v ? 'on' : ''}" aria-selected="${cfg.period.type === v}" data-ptype="${v}">${l}</button>`)}</div>
        ${periodPicker()}
        <span class="grow"></span>
        <label class="rp-inline">Group by <select class="rp-ctl" data-c="group_by">${[['owner', 'Owner'], ['stage', 'Stage'], ['category', 'Forecast category'], ['account', 'Account'], ['month', 'Close month']].map(([v, l]) => html`<option value="${v}" ${cfg.group_by === v ? raw('selected') : ''}>${l}</option>`)}</select></label>
        <button type="button" class="btn sm" data-pop="settings">⚙ Forecast settings</button>
        <button type="button" class="btn sm" data-pop="columns">☰ Columns <span class="rp-count">${cfg.columns.length}</span></button>
      </div>
      <div class="rp-row rp-filters">
        <span class="rp-lbl">Filters</span>
        ${active.map((fd) => html`<span class="rp-pill" data-filter="${fd.id}" role="button" tabindex="0" title="Change ${fd.label.toLowerCase()} filter"><span class="k">${fd.label}</span><b>${pillText(fd)}</b><button type="button" class="x" data-clear="${fd.id}" aria-label="Remove ${fd.label} filter">✕</button></span>`)}
        ${idle.map((fd) => html`<button type="button" class="rp-add" data-filter="${fd.id}">+ ${fd.label}</button>`)}
        ${active.length || cfg.filters.q ? html`<button type="button" class="linkbtn small" data-ract="clearall">Clear all</button>` : ''}
        <span class="rp-search"><input data-c="filters.q" value="${cfg.filters.q ?? ''}" placeholder="Search deal or account" aria-label="Search deal or account"></span>
      </div>
      <div class="rp-sum">${settingsSummary()} · <button type="button" class="linkbtn" data-pop="how">ⓘ How the forecast is calculated</button></div>
    </div></div>`;
  };

  /** Pop-ups: pick values for a filter, the amount range, forecast settings, columns, and the explanation. */
  const pickList = (fd) => {
    const cur = new Set(chosen(fd));
    modal({ title: `Filter by ${fd.label.toLowerCase()}`, submitLabel: 'Apply', body: html`
      ${fd.options.length > 8 ? html`<input class="rp-find" placeholder="Search ${fd.label.toLowerCase()}…" aria-label="Search">` : ''}
      <div class="rp-pick-tools small"><button type="button" class="linkbtn" data-all>Select all</button><button type="button" class="linkbtn" data-none>Clear</button><span class="grow"></span><span class="muted" data-n></span></div>
      <div class="rp-pick-list">${fd.options.map(([v, l]) => html`<label data-l="${String(l).toLowerCase()}"><input type="checkbox" name="v" value="${v}" ${cur.has(v) ? raw('checked') : ''}> <span>${l}</span></label>`)}</div>`,
      onOpen: (f) => {
        const count = () => { const n = [...f.querySelectorAll('input[name=v]:checked')].length; f.querySelector('[data-n]').textContent = n ? `${n} selected` : 'None selected = all'; };
        f.addEventListener('change', count); count();
        f.querySelector('.rp-find')?.addEventListener('input', (e) => { const q = e.target.value.toLowerCase(); f.querySelectorAll('.rp-pick-list label').forEach((l) => { l.hidden = q && !l.dataset.l.includes(q); }); });
        f.querySelector('[data-all]').onclick = () => { f.querySelectorAll('.rp-pick-list label:not([hidden]) input').forEach((x) => { x.checked = true; }); count(); };
        f.querySelector('[data-none]').onclick = () => { f.querySelectorAll('input[name=v]').forEach((x) => { x.checked = false; }); count(); };
        setTimeout(() => f.querySelector('.rp-find')?.focus(), 30);
      },
      onSubmit: async (f) => { const v = [...f.querySelectorAll('input[name=v]:checked')].map((x) => x.value); set(fd.path, v); await refresh(); } });
  };
  const amountPop = () => modal({ title: 'Filter by amount', submitLabel: 'Apply', body: html`<div class="row"><label>Minimum<input type="number" name="min" min="0" value="${cfg.filters.min_amount ?? ''}" placeholder="any"></label><label>Maximum<input type="number" name="max" min="0" value="${cfg.filters.max_amount ?? ''}" placeholder="any"></label></div>`,
    onSubmit: async (f) => { cfg.filters.min_amount = f.min.value; cfg.filters.max_amount = f.max.value; await refresh(); } });
  const settingsPop = () => modal({ title: 'Forecast settings', submitLabel: 'Apply', body: html`
    <fieldset class="rp-fs"><legend>Deals included</legend>
      <label class="check"><input type="radio" name="scope" value="period" ${cfg.scope !== 'all_open' ? raw('checked') : ''}> Deals expected to close in the period <span class="muted">(plus deals won or lost in it)</span></label>
      <label class="check"><input type="radio" name="scope" value="all_open" ${cfg.scope === 'all_open' ? raw('checked') : ''}> All open deals <span class="muted">(plus deals won or lost in the period)</span></label>
      <label class="check"><input type="checkbox" name="slipped" ${cfg.include_slipped !== false ? raw('checked') : ''}> Include slipped deals <span class="muted">(expected close date already passed)</span></label></fieldset>
    <fieldset class="rp-fs"><legend>Scenarios</legend><div class="row">
      <label>Worst case counts deals at or above<span class="rp-suffix"><input type="number" name="worst" min="0" max="100" value="${cfg.worst_threshold}"><i>%</i></span></label>
      <label>Best case adds deals at or above<span class="rp-suffix"><input type="number" name="best" min="0" max="100" value="${cfg.best_threshold}"><i>%</i></span></label></div>
      <label>Target / quota for the period <span class="muted">(optional)</span><input type="number" name="target" min="0" step="1000" value="${cfg.target ?? ''}" placeholder="e.g. 5000000"></label></fieldset>
    <fieldset class="rp-fs"><legend>Calendar</legend><label>Fiscal year starts in<select name="fy">${MONTHS.map((m, i) => html`<option value="${i + 1}" ${Number(cfg.period.fy_start || 1) === i + 1 ? raw('selected') : ''}>${m}</option>`)}</select></label></fieldset>`,
    onSubmit: async (f) => {
      const w = Number(f.worst.value), b = Number(f.best.value); if (!(w >= 0 && w <= 100 && b >= 0 && b <= 100)) throw new Error('Thresholds must be between 0 and 100');
      if (b > w) throw new Error('The best-case threshold should not be higher than the worst-case one');
      Object.assign(cfg, { scope: f.scope.value, include_slipped: f.slipped.checked, worst_threshold: w, best_threshold: b, target: f.target.value });
      const fy = Number(f.fy.value); if (fy !== Number(cfg.period.fy_start || 1)) { cfg.period.fy_start = fy; delete cfg.period.quarter; delete cfg.period.year; }
      await refresh();
    } });
  const columnsPop = () => {
    const all = [...COLUMNS.filter((c) => c[0] !== 'amount2' || hasC2()), ...(data?.custom_fields || []).map((f) => [`cf:${f.key}`, f.label])];
    modal({ title: 'Columns in the deal list', submitLabel: 'Apply', body: html`<p class="small muted" style="margin-top:0">Click a column heading in the report to sort by it.</p>
      <div class="rp-pick-list rp-cols">${all.map(([k, l]) => html`<label><input type="checkbox" name="c" value="${k}" ${cfg.columns.includes(k) ? raw('checked') : ''}> <span>${colLabel(k) || l}</span></label>`)}</div>`,
      onSubmit: async (f) => { const pick = [...f.querySelectorAll('input[name=c]:checked')].map((x) => x.value); if (!pick.length) throw new Error('Choose at least one column'); cfg.columns = [...cfg.columns.filter((k) => pick.includes(k)), ...pick.filter((k) => !cfg.columns.includes(k))]; setHtml($('#rpb', root), body()); setHtml($('#rpc', root), controls()); store_.set('reviewCfg', cfg); } });
  };
  const howPop = () => modal({ title: 'How the forecast is calculated', hideFooter: true, body: html`<div class="rp-how">
    <p><b style="color:${CAT_STYLE.won}">Won</b> — deals closed won in the period.</p>
    <p><b style="color:${CAT_STYLE.commit}">Worst case</b> — won + <i>commit</i> deals (probability ≥ ${cfg.worst_threshold}%).</p>
    <p><b style="color:#1d4ed8">Projected</b> — worst case + <i>best-case</i> deals (≥ ${cfg.best_threshold}%) × their probability: the most likely outcome.</p>
    <p><b style="color:${CAT_STYLE.best_case}">Best case</b> — worst case + best-case deals in full.</p>
    <p class="muted">So worst ≤ projected ≤ best. Deals below ${cfg.best_threshold}% count in none of them; their weighted value is shown under the tiles. Open deals without an expected close date are estimated from your average sales cycle (${data?.summary.cycle_days ?? '…'} days${data && !data.summary.cycle_from_history ? ', a default until you have won deals' : ''}).</p>
    <div style="display:flex;justify-content:flex-end"><button type="button" class="btn primary" data-close>Got it</button></div></div>` });

  const tile = (label, v, v2, sub, color) => html`<div class="card kpi" style="border-top:3px solid ${color}"><div class="l">${label}</div><div class="v">${money(v, true)}</div>${v2 != null && hasC2() ? html`<div class="s"><b>${money2(v2, true)}</b></div>` : ''}<div class="s">${sub}</div></div>`;
  const bar = (s) => {
    const max = Math.max(s.best_case, s.target || 0, 1) * 1.04; const w = (v) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
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
    return html`<div class="rp-head"><div><h2>Pipeline &amp; forecast review <span class="rp-period">${p.label}</span></h2><div class="small muted">${fmtDate(p.from)} – ${fmtDate(p.to)} · generated ${new Date(data.generated_at).toLocaleString()}</div></div></div>
      <div class="rp-printonly small muted">${settingsSummary()}${filt.length ? ` · ${filt.join(' · ')}` : ' · all deals you can see'}</div>
      <div class="grid g4 mt rp-tiles">
        ${tile('Won', s.won, s.won2, `${s.won_count} deal${s.won_count === 1 ? '' : 's'}${s.target ? ` · ${pct(s.attainment, 0)} of target` : ''}`, CAT_STYLE.won)}
        ${tile('Worst case', s.worst_case, s.worst_case2, s.target ? (s.gap_worst > 0 ? `${money(s.gap_worst, true)} short of target` : `${money(-s.gap_worst, true)} above target`) : `won + commit (${money(s.commit, true)})`, CAT_STYLE.commit)}
        ${tile('Projected', s.projected, s.projected2, s.target ? (s.gap_projected > 0 ? `${money(s.gap_projected, true)} short of target` : `${money(-s.gap_projected, true)} above target`) : `worst case + best-case deals × probability`, '#1d4ed8')}
        ${tile('Best case', s.best_case, s.best_case2, s.target ? (s.gap_best > 0 ? `${money(s.gap_best, true)} short of target` : `${money(-s.gap_best, true)} above target`) : `worst case + best-case deals (${money(s.best_case_only, true)})`, CAT_STYLE.best_case)}
      </div>
      <div class="rp-stats">
        ${[['Open pipeline', money(s.pipeline, true), `${s.open_count} deal${s.open_count === 1 ? '' : 's'}`], ['Weighted pipeline', money(s.weighted_open, true), 'all open × probability'],
          ['Slipped', s.slipped_count ? money(s.slipped, true) : '—', s.slipped_count ? `${s.slipped_count} deal${s.slipped_count === 1 ? '' : 's'} past date` : 'none', s.slipped_count ? 'bad' : ''],
          ['Lost', money(s.lost, true), `${s.lost_count} deal${s.lost_count === 1 ? '' : 's'}`], ['Win rate', s.win_rate == null ? '—' : pct(s.win_rate, 0), 'won ÷ (won + lost)'],
          ['Average won deal', s.avg_won == null ? '—' : money(s.avg_won, true), ''], ['Sales cycle', `${s.cycle_days} days`, s.cycle_from_history ? 'average, created → won' : 'default'], ['New deals', String(s.new_deals), 'created in the period']]
          .map(([l, v, sub, cls]) => html`<div class="${cls || ''}"><span>${l}</span><b>${v}</b><small>${sub}</small></div>`)}
      </div>
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
    store_.set('reviewCfg', cfg); setHtml($('#rpb', root), body()); setHtml($('#rpc', root), controls());
  };
  const later = debounce(refresh, 300);
  // searching keeps the cursor in the box: only the report below is redrawn
  const laterSearch = debounce(async () => { try { data = await api('POST', '/reports/pipeline', cfg); store_.set('reviewCfg', cfg); setHtml($('#rpb', root), body()); } catch (e) { fail(e); } }, 350);

  root.onchange = (e) => {
    const t = e.target;
    if (t.id === 'rpview') { viewId = t.value ? Number(t.value) : null; store_.set('reviewView', viewId); const v = views.find((x) => x.id === viewId); if (v) cfg = { ...defaults(), ...v.config }; draw(); refresh(); return; }
    const path = t.dataset.c; if (!path || path === 'notes' || path === 'filters.q') return;
    set(path, t.value); later();
  };
  root.oninput = (e) => { if (e.target.dataset.c === 'notes') { cfg.notes = e.target.value; const pn = $('.rp-printnotes', root); if (pn) pn.textContent = cfg.notes; store_.set('reviewCfg', cfg); } else if (e.target.matches('input[data-c="filters.q"]')) { set('filters.q', e.target.value); laterSearch(); } };
  root.onclick = async (e) => {
    const s = e.target.closest('[data-sort]'); if (s) { e.preventDefault(); const k = s.dataset.sort; cfg.sort = { key: k, dir: cfg.sort?.key === k && cfg.sort.dir !== 'desc' ? 'desc' : 'asc' }; setHtml($('#rpb', root), body()); return; }
    const clr = e.target.closest('[data-clear]'); if (clr) { e.stopPropagation(); const fd = filterDefs().find((x) => x.id === clr.dataset.clear); if (fd.range) { cfg.filters.min_amount = ''; cfg.filters.max_amount = ''; } else set(fd.path, []); await refresh(); return; }
    const pt = e.target.closest('[data-ptype]'); if (pt) { if (cfg.period.type !== pt.dataset.ptype) { cfg.period = { type: pt.dataset.ptype, fy_start: cfg.period.fy_start || 1 }; if (pt.dataset.ptype === 'custom') { const d = data?.period; cfg.period.from = d?.from; cfg.period.to = d?.to; } await refresh(); } return; }
    const fl = e.target.closest('[data-filter]'); if (fl) { const fd = filterDefs().find((x) => x.id === fl.dataset.filter); if (fd) (fd.range ? amountPop() : pickList(fd)); return; }
    const pop = e.target.closest('[data-pop]'); if (pop) { ({ settings: settingsPop, columns: columnsPop, how: howPop })[pop.dataset.pop](); return; }
    const b = e.target.closest('[data-ract]'); if (!b) return;
    try {
      const act = b.dataset.ract;
      if (act === 'print') window.print();
      if (act === 'clearall') { cfg.filters = {}; await refresh(); }
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
