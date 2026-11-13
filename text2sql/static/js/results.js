// One answered question: SQL review + feedback, chart / table / summary views, exports.
import { h, fill, prettySQL, api, busy, toast, fail, select, check, fmtNum, fmtCompact, highlightSQL, download, theme, modal, state } from './core.js';

// Categorical palette (fixed order, colour-blind-safe adjacent pairs) for light / dark surfaces.
const PALETTE = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};
const INK = {
  light: { text: '#55544e', grid: '#e9e8e3', surface: '#ffffff' },
  dark: { text: '#c3c2b7', grid: '#2c2c29', surface: '#1c1c1a' },
};
const CHART_TYPES = [['bar', 'Bar'], ['hbar', 'Horizontal bar'], ['stacked', 'Stacked bar'], ['line', 'Line'], ['area', 'Area'],
  ['pie', 'Pie'], ['doughnut', 'Doughnut'], ['scatter', 'Scatter'], ['kpi', 'Big numbers']];
const MAX_SERIES = 8, MAX_POINTS = 300;

export const COUNT = '__count__';            // pseudo-measure: number of rows per category
const yName = y => y === COUNT ? 'Count of rows' : y;
const ID_NAME = /(?:^|[_\s.])(id|ids|key|code|no|nr|num|number|zip|zipcode|postcode|pincode|pin|sku|year|yr|month|mon|week|day|quarter|qtr|fy|period|rank|version)$/i;
/** A measure is a quantity that can be added up. IDs, codes, years etc. are labels (dimensions). */
export const isMeasure = c => c.type === 'number' && (c.role ? c.role === 'measure' : !(ID_NAME.test(c.name) || /[a-z0-9](Id|ID|Key|Code|No)$/.test(c.name)));

/** Two measures on very different scales get a panel each (never a second axis). */
export function chartPanels(run, cfg) {
  const idx = Object.fromEntries(run.columns.map((c, i) => [c.name, i]));
  const ys = (cfg.y || []).filter(y => y in idx);
  if (ys.length !== 2 || cfg.series || !['bar', 'hbar', 'stacked', 'line', 'area'].includes(cfg.type)) return [cfg];
  const peak = y => Math.max(0, ...run.rows.map(r => Math.abs(Number(r[idx[y]]) || 0)));
  const [a, b] = ys.map(peak);
  return a && b && Math.max(a, b) / Math.min(a, b) > 20 ? ys.map(y => ({ ...cfg, y: [y] })) : [cfg];
}

const label = v => v == null ? '(blank)' : String(v).replace(/ 00:00:00$/, '');

/** Build a Chart.js config from rows + the user's chart settings. */
export function chartConfig(run, cfg, mode) {
  const colors = PALETTE[mode], ink = INK[mode];
  const idx = Object.fromEntries(run.columns.map((c, i) => [c.name, i]));
  const rows = run.rows.slice(0, MAX_POINTS);
  const ys = (cfg.y || []).filter(y => y in idx || y === COUNT);
  const x = cfg.x in idx ? cfg.x : null;
  const type = cfg.type;
  const val = (r, y) => y === COUNT ? 1 : r[idx[y]];
  const byName = Object.fromEntries(run.columns.map(c => [c.name, c]));
  const averaged = y => y !== COUNT && byName[y]?.additive === false;     // rates, prices, averages
  let grouped = false;
  if (!ys.length || (!x && type !== 'kpi')) return null;
  let labels, datasets;

  if (type === 'scatter') {
    datasets = [{ label: `${ys[0]} vs ${x}`, data: rows.map(r => ({ x: r[idx[x]], y: r[idx[ys[0]]] })), backgroundColor: colors[0] + 'cc', pointRadius: 4, pointHoverRadius: 6 }];
  } else if (type === 'pie' || type === 'doughnut') {
    const sums = new Map(), seen = new Map();
    rows.forEach(r => { const k = label(r[idx[x]]); sums.set(k, (sums.get(k) || 0) + (Number(val(r, ys[0])) || 0)); seen.set(k, (seen.get(k) || 0) + 1); });
    if (averaged(ys[0])) sums.forEach((v, k) => sums.set(k, v / seen.get(k)));
    grouped = sums.size < rows.length;
    let pts = [...sums].sort((a, b) => b[1] - a[1]);
    if (pts.length > MAX_SERIES) {    // never invent a 9th colour: fold the tail into "Other"
      const rest = pts.slice(MAX_SERIES - 1).reduce((s, p) => s + p[1], 0);
      pts = [...pts.slice(0, MAX_SERIES - 1), ['Other', rest]];
    }
    labels = pts.map(p => p[0]);
    datasets = [{ label: yName(ys[0]), data: pts.map(p => p[1]), backgroundColor: pts.map((_, i) => colors[i]), borderColor: ink.surface, borderWidth: 2 }];
  } else if (cfg.series && cfg.series in idx && ys.length === 1) {    // pivot one measure by a second dimension
    labels = [...new Set(rows.map(r => label(r[idx[x]])))];
    const totals = new Map();
    rows.forEach(r => { const s = label(r[idx[cfg.series]]); totals.set(s, (totals.get(s) || 0) + Math.abs(Number(val(r, ys[0])) || 0)); });
    const keep = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, totals.size > MAX_SERIES ? MAX_SERIES - 1 : MAX_SERIES).map(e => e[0]);
    const names = totals.size > keep.length ? [...keep, 'Other'] : keep;
    const grid = new Map(names.map(n => [n, new Map()]));
    rows.forEach(r => {
      const s = label(r[idx[cfg.series]]), key = keep.includes(s) ? s : 'Other', xl = label(r[idx[x]]);
      const m = grid.get(key); m.set(xl, (m.get(xl) || 0) + (Number(val(r, ys[0])) || 0));
    });
    datasets = names.map((n, i) => ({ label: n, data: labels.map(l => grid.get(n).get(l) ?? null), color: colors[i] }));
  } else {
    // one mark per X value: rows sharing an X value are added together
    const groups = new Map(), counts = new Map();
    rows.forEach(r => {
      const k = label(r[idx[x]]);
      let g = groups.get(k), n = counts.get(k);
      if (!g) { groups.set(k, g = ys.map(() => null)); counts.set(k, n = ys.map(() => 0)); }
      ys.forEach((y, i) => { const v = val(r, y); if (v != null) { g[i] = (g[i] ?? 0) + Number(v); n[i]++; } });
    });
    groups.forEach((g, k) => ys.forEach((y, i) => { if (averaged(y) && g[i] != null) g[i] /= counts.get(k)[i]; }));
    grouped = groups.size < rows.length;
    labels = [...groups.keys()];
    datasets = ys.slice(0, MAX_SERIES).map((y, i) => ({ label: yName(y), data: labels.map(l => groups.get(l)[i]), color: colors[i] }));
  }

  const isLine = type === 'line' || type === 'area';
  const isBar = type === 'bar' || type === 'hbar' || type === 'stacked';
  if (isLine || isBar) {
    datasets = datasets.map(d => ({
      label: d.label, data: d.data, backgroundColor: isLine ? d.color + (type === 'area' ? '33' : '') : d.color,
      borderColor: isLine ? d.color : ink.surface, borderWidth: isLine ? 2 : (type === 'stacked' ? 1 : 0), fill: type === 'area',
      pointRadius: isLine ? (labels.length > 40 ? 0 : 3) : undefined, pointHoverRadius: 5, tension: 0.25, spanGaps: true,
      borderRadius: isBar ? 4 : undefined, maxBarThickness: 44,
    }));
  }
  const multi = datasets.length > 1 || type === 'pie' || type === 'doughnut';
  const axis = (title, numeric) => ({
    title: { display: !!title, text: title, color: ink.text, font: { size: 11 } },
    grid: { color: numeric ? ink.grid : 'transparent' }, border: { color: ink.grid },
    ticks: { color: ink.text, maxRotation: 45, autoSkip: true, precision: numeric && ys.every(y => y === COUNT) ? 0 : undefined,
      callback(v) { return numeric ? (Math.abs(v) >= 1e4 ? fmtCompact(v) : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })) : String(this.getLabelForValue(v)).slice(0, 22); } },
    stacked: type === 'stacked', beginAtZero: numeric && !isLine,
  });
  const horizontal = type === 'hbar';
  const scales = (type === 'pie' || type === 'doughnut') ? {} : type === 'scatter'
    ? { x: { ...axis(x, true), type: 'linear' }, y: axis(yName(ys[0]), true) }
    : { [horizontal ? 'y' : 'x']: axis(x, false), [horizontal ? 'x' : 'y']: axis(!multi ? yName(ys[0]) : '', true) };
  return {
    $grouped: grouped,
    type: isBar ? 'bar' : isLine ? 'line' : type,
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: horizontal ? 'y' : 'x', scales,
      interaction: { mode: isLine ? 'index' : 'nearest', intersect: !isLine },
      plugins: {
        legend: { display: multi, position: 'bottom', labels: { color: ink.text, boxWidth: 12, boxHeight: 12, usePointStyle: false } },
        tooltip: { callbacks: { label: c => ` ${c.dataset.label ?? ''}: ${type === 'scatter' ? `(${fmtNum(c.parsed.x)}, ${fmtNum(c.parsed.y)})` : fmtNum(horizontal ? c.parsed.x : (c.parsed.y ?? c.parsed))}` } },
      },
    },
  };
}

function csvOf(run) {
  const q = v => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  return [run.columns.map(c => q(c.name)).join(','), ...run.rows.map(r => r.map(q).join(','))].join('\n');
}

/** Render a chart off-screen on a white background for PDF / PNG export. */
function chartImage(run, cfg, fmt = 'image/png') {
  const conf = chartConfig(run, cfg, 'light');
  if (!conf) return null;
  delete conf.$grouped;
  const canvas = h('canvas', { width: 1400, height: 640 });
  conf.options.responsive = false; conf.options.animation = false; conf.options.devicePixelRatio = 1;
  conf.plugins = [{ id: 'bg', beforeDraw(c) { c.ctx.save(); c.ctx.fillStyle = '#fff'; c.ctx.fillRect(0, 0, c.width, c.height); c.ctx.restore(); } }];
  conf.options.font = { size: 22 };
  for (const sc of Object.values(conf.options.scales || {})) { sc.ticks.font = { size: 20 }; sc.title.font = { size: 20 }; }
  conf.options.plugins.legend.labels.font = { size: 20 };
  const chart = new Chart(canvas, conf);
  const url = canvas.toDataURL(fmt, 0.92);
  chart.destroy();
  return url;
}

function exportPDF(run, cfg) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth(), M = 40;
  let y = 48;
  const para = (text, size, style = 'normal', color = 20, font = 'helvetica', gap = 6) => {
    doc.setFont(font, style); doc.setFontSize(size); doc.setTextColor(color);
    const safe = String(text).replace(/→/g, 'to').replace(/[–—]/g, '-').replace(/×/g, 'x').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/•/g, '-').replace(/[^\x00-\xff]/g, '?');
    for (const line of doc.splitTextToSize(safe, W - 2 * M)) {
      if (y > 780) { doc.addPage(); y = 48; }
      doc.text(line, M, y); y += size * 1.35;
    }
    y += gap;
  };
  para(run.question, 15, 'bold');
  para(`${state.me?.app_name || 'AskData'} · ${new Date(run.created_at + 'Z').toLocaleString()} · ${run.model_label} · ${run.row_count} rows${run.truncated ? ' (row limit reached)' : ''}`, 9, 'normal', 110, 'helvetica', 10);
  if (run.summary) {
    para('Summary', 11, 'bold');
    para(run.summary.headline, 10);
    (run.summary.bullets || []).forEach(b => para('-  ' + b, 10, 'normal', 40, 'helvetica', 2));
    y += 8;
  }
  const pa = run.analysis?.result, hide = new Set(cfg.hide || []);
  if (pa) {
    para(`${pa.title} — ${pa.method}`, 12, 'bold');
    if (!hide.has('explain')) { para(pa.metrics.map(m => `${m.label}: ${m.value}`).join('   |   '), 9.5, 'bold', 40); pa.narrative.forEach(b => para('-  ' + b, 9.5, 'normal', 40, 'helvetica', 2)); }
    (pa.warnings || []).forEach(w => para('Note: ' + w, 9, 'italic', 120, 'helvetica', 2));
    y += 6;
    if (!hide.has('chart')) for (const plot of pa.plots) {
      const hgt = (W - 2 * M) * 620 / 1400;
      if (y + hgt + 20 > 790) { doc.addPage(); y = 48; }
      para(plot.title, 10, 'bold', 40, 'helvetica', 2);
      doc.addImage(plotImage(plot), 'JPEG', M, y, W - 2 * M, hgt); y += hgt + 14;
    }
    const pdfTable = t => {
      if (y > 700) { doc.addPage(); y = 48; }
      para(t.title + (t.row_count > 60 ? ` (first 60 of ${t.row_count} rows)` : ''), 10, 'bold', 40, 'helvetica', 2);
      doc.autoTable({ startY: y, margin: { left: M, right: M }, styles: { fontSize: 7.5, cellPadding: 2.5, overflow: 'linebreak' }, headStyles: { fillColor: [42, 120, 214] },
        head: [t.columns.map(c => c.name)], body: t.rows.slice(0, 60).map(r => r.map(v => v == null ? '' : typeof v === 'number' ? fmtNum(v) : String(v).slice(0, 80))) });
      y = doc.lastAutoTable.finalY + 16;
    };
    if (!hide.has('table')) pa.tables.forEach(pdfTable);
    if (!hide.has('stats')) pa.stats.forEach(pdfTable);
    if (!hide.has('code')) { if (y > 640) { doc.addPage(); y = 48; } para('Code that produced this (Python)', 10, 'bold', 40, 'helvetica', 2); para(pa.code, 7, 'normal', 50, 'courier', 10); }
    if (y > 680) { doc.addPage(); y = 48; }
    para('Data used', 12, 'bold');
  }
  if (cfg.type !== 'kpi' && !pa) {
    const panels = chartPanels(run, cfg);
    for (const panel of panels) {
      const img = chartImage(run, panel, 'image/jpeg');
      if (!img) continue;
      const hgt = (W - 2 * M) * 640 / 1400 * (panels.length > 1 ? 0.7 : 1);
      if (panels.length > 1) para(yName(panel.y[0]), 10, 'bold', 40, 'helvetica', 0);
      if (y + hgt > 790) { doc.addPage(); y = 48; }
      doc.addImage(img, 'JPEG', M, y, W - 2 * M, hgt); y += hgt + 16;
    }
  }
  para('SQL', 11, 'bold');
  para(run.final_sql, 8.5, 'normal', 40, 'courier', 10);
  const cap = 1000;
  doc.autoTable({
    startY: Math.min(y, 760), margin: { left: M, right: M }, styles: { fontSize: 8, cellPadding: 3, overflow: 'linebreak' },
    headStyles: { fillColor: [42, 120, 214] },
    didParseCell: d => { if (d.section === 'head' && run.columns[d.column.index]?.type === 'number') d.cell.styles.halign = 'right'; },
    head: [run.columns.map(c => c.name)],
    body: run.rows.slice(0, cap).map(r => r.map(v => v == null ? '' : typeof v === 'number' ? fmtNum(v) : String(v).slice(0, 200))),
    columnStyles: Object.fromEntries(run.columns.map((c, i) => [i, { halign: c.type === 'number' ? 'right' : 'left' }])),
  });
  if (run.rows.length > cap) { doc.setFontSize(8); doc.text(`Showing first ${cap} of ${run.rows.length} rows.`, M, doc.lastAutoTable.finalY + 14); }
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) { doc.setPage(i); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(150); doc.text(`Page ${i} of ${pages}`, W - M, 822, { align: 'right' }); }
  doc.save(`query-${run.id}.pdf`);
}

export function dataTable(run) {
  let sort = null, dir = 1, page = 0;
  const size = 50, wrap = h('div', {});
  const draw = () => {
    const rows = [...run.rows];
    if (sort != null) rows.sort((a, b) => (a[sort] == null) - (b[sort] == null) || (a[sort] > b[sort] ? dir : a[sort] < b[sort] ? -dir : 0));
    const pages = Math.max(1, Math.ceil(rows.length / size));
    page = Math.min(page, pages - 1);
    fill(wrap, 
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, run.columns.map((c, i) => h('th', {
          class: 'sortable' + (c.type === 'number' ? ' num' : ''), title: c.masked ? 'Masked by policy' : 'Sort',
          onclick: () => { dir = sort === i ? -dir : 1; sort = i; draw(); },
        }, c.name, c.masked ? ' 🔒' : '', sort === i ? (dir > 0 ? ' ▲' : ' ▼') : '')))),
        h('tbody', {}, rows.slice(page * size, (page + 1) * size).map(r => h('tr', {}, r.map((v, i) =>
          v == null ? h('td', { class: 'null' }, 'null')
            : h('td', { class: run.columns[i].type === 'number' ? 'num' : '' }, run.columns[i].type === 'number' ? fmtNum(v) : label(v)))))))),
      pages > 1 ? h('div', { class: 'row small muted', style: 'margin-top:8px' },
        h('button', { class: 'btn sm', disabled: page === 0, onclick: () => { page--; draw(); } }, '‹ Prev'),
        `Page ${page + 1} of ${pages}`,
        h('button', { class: 'btn sm', disabled: page >= pages - 1, onclick: () => { page++; draw(); } }, 'Next ›')) : null);
  };
  draw();
  return wrap;
}

function kpiTiles(run, cfg) {
  const idx = Object.fromEntries(run.columns.map((c, i) => [c.name, i]));
  const ys = (cfg.y || []).filter(y => y in idx || y === COUNT);
  const single = run.rows.length === 1;
  return h('div', { class: 'kpis' }, ys.map(y => {
    if (y === COUNT) return h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Count of rows'), h('div', { class: 'v' }, fmtNum(run.rows.length)));
    const vals = run.rows.map(r => r[idx[y]]).filter(v => typeof v === 'number');
    const total = vals.reduce((a, b) => a + b, 0), avg = total / (vals.length || 1);
    const additive = run.columns[idx[y]].additive !== false;
    return h('div', { class: 'kpi' }, h('div', { class: 'l' }, y.replace(/_/g, ' ') + (single ? '' : additive ? ' — total' : ' — average')),
      h('div', { class: 'v' }, fmtCompact(single ? vals[0] : additive ? total : avg)),
      single ? null : h('div', { class: 's' }, `across ${vals.length} rows · ${additive ? `average ${fmtCompact(avg)} · ` : ''}min ${fmtCompact(Math.min(...vals))} · max ${fmtCompact(Math.max(...vals))}`));
  }));
}

/** The Summary view: what the result says, in words, plus per-column figures. */
export function summaryBlock(run, { table = true } = {}) {
  const s = run.summary || {};
  return h('div', {}, h('p', { style: 'margin-bottom:6px' }, h('b', {}, s.headline || '')), h('ul', { class: 'bul' }, (s.bullets || []).map(b => h('li', {}, b))),
    !table ? null : h('div', { class: 'tbl-wrap', style: 'margin-top:12px' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['Column', 'Kind', 'Distinct', 'Nulls', 'Min', 'Max', 'Average', 'Total'].map((t, i) => h('th', { class: i > 1 ? 'num' : '' }, t)))),
      h('tbody', {}, (s.stats || []).map(c => h('tr', {}, h('td', {}, c.column),
        h('td', {}, c.role === 'measure' ? (c.additive === false ? 'measure (averaged)' : 'measure') : c.type === 'number' ? 'category (number)' : c.type === 'date' ? 'date' : 'category'),
        ...[c.distinct, c.nulls, c.min, c.max, c.mean, c.sum].map(v => h('td', { class: 'num' }, v == null ? '–' : typeof v === 'number' ? fmtNum(v) : String(v)))))))),
    !table ? null : h('p', { class: 'small dim', style: 'margin-top:8px' }, 'Totals are shown for quantities that can be added up. Averages, rates and prices are averaged instead; identifiers, codes and years are treated as categories. Computed on the server — result data is never sent to the AI model.'));
}

/**
 * A chart with its controls. `run` needs {columns, rows}; `cfg` is edited in place.
 * Returns { el, destroy(), repaint() }.
 */
export function chartBlock(run, cfg, { controls = true, onChange } = {}) {
  const el = h('div', {});
  let charts = [];
  const destroy = () => { charts.forEach(c => c.destroy()); charts = []; };
  const nums = run.columns.filter(isMeasure).map(c => c.name);
  const all = [...run.columns.filter(c => !isMeasure(c)), ...run.columns.filter(isMeasure)].map(c => c.name);   // categories first
  const measureOpts = [...nums, [COUNT, 'Count of rows']];
  function paint() {
    destroy(); fill(el);
    if (!cfg.type || cfg.type === 'table') cfg.type = 'bar';
    if (!all.includes(cfg.x)) cfg.x = all[0];
    cfg.y = (cfg.y || []).filter(y => nums.includes(y) || y === COUNT);
    if (!cfg.y.length) cfg.y = [nums.find(n => n !== cfg.x) ?? COUNT];
    if (cfg.type === 'scatter' && (cfg.y[0] === COUNT || nums.length < 2)) cfg.type = 'bar';
    if (cfg.type === 'scatter' && !nums.includes(cfg.x)) cfg.x = nums.find(n => n !== cfg.y[0]) || nums[0];
    const change = (k, v) => { cfg[k] = v; onChange?.(cfg); paint(); };
    const dims = all.filter(c => c !== cfg.x && !nums.includes(c));
    const multiOK = ['bar', 'hbar', 'stacked', 'line', 'area'].includes(cfg.type);
    if (!multiOK || cfg.y[0] === COUNT) cfg.y = cfg.y.slice(0, 1);
    if (controls) el.append(h('div', { class: 'chart-controls' },
      h('label', {}, 'Chart type', select(CHART_TYPES.filter(t => t[0] !== 'scatter' || nums.length > 1), cfg.type, v => change('type', v))),
      cfg.type === 'kpi' ? null : h('label', { title: 'The category, date or label each bar / point / slice stands for' }, cfg.type === 'pie' || cfg.type === 'doughnut' ? 'Slices (category)' : cfg.type === 'scatter' ? 'X axis (measure)' : 'X axis (category)',
        select(cfg.type === 'scatter' ? nums : all, cfg.x, v => change('x', v))),
      h('label', { title: 'The number being plotted. Only measures are listed; IDs, codes and years are categories.' }, cfg.type === 'kpi' ? 'Measure' : 'Y axis (measure)',
        select(cfg.type === 'scatter' ? nums : measureOpts, cfg.y[0], v => change('y', [v, ...cfg.y.slice(1).filter(y => y !== v)]))),
      multiOK && cfg.y[0] !== COUNT && nums.length > 1 && !cfg.series
        ? h('label', { title: 'Plot a second number alongside the first' }, 'Add measure', select([['', '—'], ...nums.filter(n => n !== cfg.y[0])], cfg.y[1] || '', v => change('y', v ? [cfg.y[0], v] : [cfg.y[0]]))) : null,
      multiOK && dims.length
        ? h('label', { title: 'Break each X value into one coloured series per value of this column' }, 'Split by', select([['', '—'], ...dims], cfg.series || '', v => { cfg.series = v || null; if (v) cfg.y = cfg.y.slice(0, 1); onChange?.(cfg); paint(); })) : null,
      h('a', { class: 'small', href: '#/help/charts', target: '_blank', rel: 'noopener', title: 'How to read and change charts', style: 'margin-bottom:5px' }, '? Chart help')));
    if (cfg.type === 'kpi') return el.append(kpiTiles(run, cfg));
    const panels = chartPanels(run, cfg);
    const notes = [];
    for (const panel of panels) {
      const conf = chartConfig(run, panel, theme());
      if (!conf) { el.append(h('div', { class: 'empty' }, 'Pick the columns to plot.')); break; }
      const canvas = h('canvas', { role: 'img', 'aria-label': `${cfg.type} chart of ${panel.y.map(yName).join(', ')} by ${cfg.x}` });
      if (panels.length > 1) el.append(h('h3', { style: 'margin:10px 0 2px' }, yName(panel.y[0])));
      el.append(h('div', { class: 'chart-box', style: panels.length > 1 ? 'height:230px' : '' }, canvas));
      if (conf.$grouped && !notes.length) notes.push(panel.y[0] === COUNT ? `Counting result rows for each ${cfg.x}.` : `Several rows share the same ${cfg.x}; their values are combined (added, or averaged for rates and prices).`);
      delete conf.$grouped;
      charts.push(new Chart(canvas, conf));
    }
    if (panels.length > 1) notes.push('These two measures are on very different scales, so each gets its own panel rather than sharing one axis.');
    if (run.rows.length > MAX_POINTS) notes.push(`Chart uses the first ${MAX_POINTS} rows; the table has all ${run.rows.length}.`);
    if (notes.length) el.append(h('p', { class: 'small dim', style: 'margin:8px 0 0' }, notes.join(' ')));
  }
  paint();
  return { el, destroy, repaint: paint };
}

/** Chart.js config for a plot produced by the predictive engine (line / bar / hbar / scatter). */
export function plotConfig(plot, mode) {
  const colors = PALETTE[mode], ink = INK[mode];
  const FLAG = colors[7], FORE = colors[1];
  const kind = plot.kind;
  const axis = (title, numeric) => ({
    title: { display: !!title, text: title, color: ink.text, font: { size: 11 } }, grid: { color: numeric ? ink.grid : 'transparent' }, border: { color: ink.grid },
    ticks: { color: ink.text, maxRotation: 45, autoSkip: true, callback(v) { return numeric ? (Math.abs(v) >= 1e4 ? fmtCompact(v) : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })) : String(this.getLabelForValue(v)).slice(0, 44); } },
  });
  let datasets, scales, type = 'line', legendFilter = () => true;
  if (kind === 'line') {
    datasets = plot.datasets.map(d => d.role === 'actual' ? { label: d.label, data: d.data, borderColor: colors[0], backgroundColor: colors[0], borderWidth: 2, pointRadius: plot.labels.length > 60 ? 0 : 2.5, tension: 0.2, spanGaps: true }
      : d.role === 'forecast' ? { label: d.label, data: d.data, borderColor: FORE, backgroundColor: FORE, borderWidth: 2, borderDash: [6, 4], pointRadius: plot.labels.length > 60 ? 0 : 2.5, tension: 0.2, spanGaps: true }
      : d.role === 'flag' ? { label: d.label, data: d.data, showLine: false, borderColor: FLAG, backgroundColor: FLAG, pointRadius: 6, pointStyle: 'circle', pointHoverRadius: 8 }
      : { label: d.label, data: d.data, borderColor: 'transparent', backgroundColor: FORE + '2e', pointRadius: 0, tension: 0.2, fill: d.role === 'upper' ? '+1' : false, spanGaps: true });
    legendFilter = item => plot.datasets[item.datasetIndex].role !== 'lower';
    scales = { x: axis(plot.x_title, false), y: axis(plot.y_title, true) };
  } else if (kind === 'scatter') {
    type = 'scatter'; let n = 0;
    datasets = plot.datasets.map(d => d.role === 'forecast' ? { label: d.label, data: d.points.map(p => ({ x: p[0], y: p[1] })), showLine: true, borderColor: ink.text, borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0 }
      : { label: d.label, data: d.points.map(p => ({ x: p[0], y: p[1] })), backgroundColor: (d.role === 'flag' ? FLAG : colors[n++ % 8]) + 'cc', pointRadius: d.role === 'flag' ? 6 : 3.5, pointHoverRadius: 7 });
    scales = { x: { ...axis(plot.x_title, true), type: 'linear' }, y: axis(plot.y_title, true) };
  } else {
    type = 'bar'; const horizontal = kind === 'hbar';
    datasets = plot.datasets.map((d, i) => ({ label: d.label, data: d.data, backgroundColor: d.role === 'flag' ? FLAG : colors[i], borderRadius: 4, maxBarThickness: 40 }));
    scales = { [horizontal ? 'y' : 'x']: axis(horizontal ? plot.y_title : plot.x_title, false), [horizontal ? 'x' : 'y']: { ...axis(horizontal ? plot.x_title : plot.y_title, true), beginAtZero: true } };
  }
  return { type, data: { labels: plot.labels, datasets }, options: {
    responsive: true, maintainAspectRatio: false, indexAxis: kind === 'hbar' ? 'y' : 'x', scales, interaction: { mode: kind === 'line' ? 'index' : 'nearest', intersect: kind !== 'line' },
    plugins: { legend: { display: plot.datasets.length > 1, position: 'bottom', labels: { color: ink.text, boxWidth: 12, boxHeight: 12, filter: legendFilter } },
      tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${kind === 'scatter' ? `(${fmtNum(c.parsed.x)}, ${fmtNum(c.parsed.y)})` : fmtNum(kind === 'hbar' ? c.parsed.x : c.parsed.y)}` } } } } };
}

/** A predictive plot as an image on a white background (for PDF export). */
function plotImage(plot) {
  const conf = plotConfig(plot, 'light');
  const canvas = h('canvas', { width: 1400, height: 620 });
  conf.options.responsive = false; conf.options.animation = false; conf.options.devicePixelRatio = 1;
  conf.plugins = [{ id: 'bg', beforeDraw(c) { c.ctx.save(); c.ctx.fillStyle = '#fff'; c.ctx.fillRect(0, 0, c.width, c.height); c.ctx.restore(); } }];
  for (const sc of Object.values(conf.options.scales || {})) { sc.ticks.font = { size: 20 }; sc.title.font = { size: 20 }; }
  conf.options.plugins.legend.labels.font = { size: 20 };
  const chart = new Chart(canvas, conf);
  const url = canvas.toDataURL('image/jpeg', 0.92);
  chart.destroy();
  return url;
}

const PARTS = [['explain', 'Explanation'], ['chart', 'Charts'], ['table', 'Results'], ['stats', 'Statistics'], ['code', 'Code']];
const ICON = { forecast: '📈', classification: '🎯', regression: '🎯', drivers: '🧭', clustering: '🧩', anomaly: '🚩' };

/**
 * The predictive output of an answer: explanation, charts, result tables, statistical output and the code
 * that ran - each of which the user can show or hide.
 * opts: { hidden: Set, onHide(set), controls: {rerun(body)} | null }.  Returns { el, destroy() }.
 */
export function analysisBlock(analysis, opts = {}) {
  const el = h('div', {});
  let charts = [];
  const destroy = () => { charts.forEach(c => c.destroy()); charts = []; };
  const hidden = opts.hidden || new Set();
  const r = analysis.result;
  function paint() {
    destroy(); fill(el);
    if (analysis.error) return el.append(h('div', { class: 'banner warn' }, h('b', {}, 'The predictive analysis could not be run. '), analysis.error, ' The data returned by the query is shown below.'));
    if (!r) return el.append(h('div', { class: 'banner info' }, 'The predictive output of this answer was not kept in history. ', opts.controls ? h('button', { class: 'btn sm', onclick: e => busy(e.target, () => opts.controls.rerun({})) }, 'Run again') : ''));
    const show = k => !hidden.has(k);
    const toggles = h('div', { class: 'row wrap small', style: 'margin:0 0 10px;gap:12px' }, h('span', { class: 'dim' }, 'Show:'), PARTS.map(([k, l]) =>
      check(l, show(k), v => { v ? hidden.delete(k) : hidden.add(k); opts.onHide?.(hidden); paint(); })));
    const head = h('div', { class: 'sec-head' }, h('h3', {}, `${ICON[r.type] || '🔮'} ${r.title}`), h('span', { class: 'badge info' }, r.method),
      h('span', { class: 'small dim' }, `${fmtNum(r.rows_used)} rows analysed on the server`), h('span', { class: 'spacer' }));
    if (opts.controls) {
      if (r.type === 'forecast') {
        const n = h('input', { type: 'number', min: 1, max: 120, value: r.params.horizon, class: 'inline', style: 'width:70px', 'aria-label': 'Periods ahead' });
        head.append(h('label', { class: 'row small' }, 'Periods ahead', n), h('button', { class: 'btn sm', onclick: e => busy(e.target, () => opts.controls.rerun({ horizon: Number(n.value) || r.params.horizon })) }, 'Update'));
      } else if (r.type === 'clustering') {
        const k = select([['', 'Automatic'], ...[2, 3, 4, 5, 6, 7, 8].map(v => [v, `${v} segments`])], analysis.spec?.k || '', null, { class: 'inline', 'aria-label': 'Number of segments' });
        head.append(h('label', { class: 'row small' }, 'Segments', k), h('button', { class: 'btn sm', onclick: e => busy(e.target, () => opts.controls.rerun({ k: k.value ? Number(k.value) : null })) }, 'Update'));
      }
    }
    el.append(head, toggles);
    (r.warnings || []).forEach(w => el.append(h('div', { class: 'banner warn', style: 'margin-bottom:8px' }, '⚠ ', w)));
    if (show('explain')) el.append(h('div', { class: 'kpis', style: 'margin-bottom:10px' }, r.metrics.map(m => h('div', { class: 'kpi' }, h('div', { class: 'l' }, m.label), h('div', { class: 'v' }, m.value), h('div', { class: 's' }, m.hint || '')))),
      h('ul', { class: 'bul', style: 'margin-bottom:12px' }, r.narrative.map(t => h('li', {}, t))));
    if (show('chart')) for (const plot of r.plots) {
      const canvas = h('canvas', { role: 'img', 'aria-label': plot.title });
      el.append(h('h3', { style: 'margin:14px 0 4px' }, plot.title), h('div', { class: 'chart-box', style: plot.kind === 'hbar' ? `height:${Math.max(180, 60 + 26 * plot.labels.length)}px` : '' }, canvas));
      charts.push(new Chart(canvas, plotConfig(plot, theme())));
    }
    const tables = (list, key) => { if (show(key)) for (const t of list) el.append(h('h3', { style: 'margin:16px 0 6px' }, t.title, t.row_count > t.rows.length ? h('span', { class: 'small dim' }, `  first ${fmtNum(t.rows.length)} of ${fmtNum(t.row_count)} rows`) : null), dataTable(t)); };
    tables(r.tables, 'table'); tables(r.stats, 'stats');
    if (show('code')) el.append(h('div', { class: 'sec-head', style: 'margin:16px 0 6px' }, h('h3', {}, 'Code that produced this'), h('span', { class: 'small dim' }, 'Python — run on the AskData server on the rows returned by the SQL above; includes the feature engineering'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm ghost', onclick: () => navigator.clipboard?.writeText(r.code).then(() => toast('Code copied')) }, 'Copy')), h('pre', { class: 'sql code-py', html: highlightPy(r.code) }));
  }
  paint();
  return { el, destroy, repaint: paint };
}

const PY_KW = /\b(import|from|as|def|return|for|in|if|elif|else|lambda|and|or|not|None|True|False|is)\b/g;
function highlightPy(code) {
  return String(code).split(/(#[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g).map((part, i) => {
    if (i % 2) return `<span class="${part.startsWith('#') ? 'cmt' : 'str'}">${part.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</span>`;
    return part.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(PY_KW, m => `<span class="kw">${m}</span>`);
  }).join('');
}

/** Pick one of the user's reports (or start a new one) and append this result to it. */
async function addToReport(run) {
  const reports = (await api('GET', '/api/reports').catch(() => [])).filter(r => r.can_edit);
  const name = h('input', { type: 'text', placeholder: 'Name of the new report' });
  const add = async (id, close) => { try { const r = await api('POST', `/api/reports/${id}/components`, { run_id: run.id }); close(); toast(`Added to “${r.title}”. Open Reports to arrange it.`); } catch (e) { fail(e); } };
  const close = modal('Add this result to a report', h('div', { class: 'stack' },
    h('p', { class: 'muted small' }, 'The report keeps the query, not the numbers: it re-runs for whoever opens it, so it always shows the latest data.'),
    reports.length ? h('div', { class: 'card flush' }, reports.map(r => h('div', { class: 'item row' }, h('div', { style: 'flex:1' }, h('b', {}, r.title), h('div', { class: 'small dim' }, `${r.results} result(s)`)),
      h('button', { class: 'btn sm primary', onclick: () => add(r.id, close) }, 'Add here')))) : null,
    h('div', { class: 'row' }, name, h('button', { class: 'btn', onclick: async () => {
      try { const r = await api('POST', '/api/reports', { title: name.value.trim() || 'Untitled report', components: [] }); await add(r.id, close); } catch (e) { fail(e); }
    } }, 'Create new report'))));
}

/**
 * ctx: { readonly, onFollowup(question), onChange(run) }
 */
export function runCard(run, ctx = {}) {
  const root = h('div', {});
  let block = null, ablock = null, editing = false;
  const cleanup = () => { block?.destroy(); block = null; ablock?.destroy(); ablock = null; };
  const refresh = updated => { Object.assign(run, updated); ctx.onChange?.(run); draw(); };

  function sqlSection() {
    const sec = h('div', { class: 'sec' });
    const meta = h('span', { class: 'small dim' }, [run.model_label, run.llm_ms ? `${(run.llm_ms / 1000).toFixed(1)}s to write` : null,
      run.status === 'success' ? `${run.db_ms} ms to run` : null, run.attempts > 1 ? (run.status === 'success' ? `auto-corrected ×${run.attempts - 1}` : `${run.attempts - 1} repair attempt(s) failed`) : null,
      run.edited ? 'edited by you' : null].filter(Boolean).join(' · '));
    sec.append(h('div', { class: 'sec-head' }, h('h3', {}, 'SQL'), meta, h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm ghost', onclick: () => navigator.clipboard?.writeText(run.final_sql).then(() => toast('SQL copied')) }, 'Copy'),
      ctx.readonly ? null : h('button', { class: 'btn sm' + (editing ? ' active' : ''), onclick: () => { editing = !editing; draw(); } }, editing ? 'Cancel edit' : '✎ Edit SQL')));
    if (editing) {
      const ta = h('textarea', { class: 'sql-edit', spellcheck: 'false' }, prettySQL(run.final_sql));
      const runBtn = h('button', { class: 'btn primary', onclick: () => busy(runBtn, async () => {
        const updated = await api('POST', `/api/chat/runs/${run.id}/execute`, { sql: ta.value });
        editing = updated.status !== 'success';
        refresh(updated);
      }) }, '▶ Run edited SQL');
      sec.append(ta, h('div', { class: 'row', style: 'margin-top:8px' }, runBtn,
        h('span', { class: 'small dim' }, 'Read-only: only a single SELECT is allowed. Confirm it afterwards to teach the model.')));
    } else {
      sec.append(h('pre', { class: 'sql', html: highlightSQL(prettySQL(run.final_sql)) }));
      if (run.explanation) sec.append(h('p', { class: 'muted small', style: 'margin:8px 0 0' }, run.explanation));
    }
    if (run.status === 'pending_review' && !editing && !ctx.readonly) {
      const go = h('button', { class: 'btn primary', onclick: () => busy(go, async () => refresh(await api('POST', `/api/chat/runs/${run.id}/execute`, {}))) }, '▶ Run this SQL');
      sec.append(h('div', { class: 'feedback' }, go, h('span', { class: 'small muted' }, 'Review the SQL, edit it if needed, then run it.')));
    }
    if (run.status === 'error' || run.status === 'blocked') {
      sec.append(h('div', { class: 'banner bad', style: 'margin-top:10px' },
        h('b', {}, run.status === 'blocked' ? 'Blocked by the read-only guard: ' : 'The database returned an error: '), run.error));
    }
    if (run.status === 'success' && !ctx.readonly) sec.append(feedbackBar());
    else if (run.feedback) sec.append(h('div', { class: 'feedback' }, feedbackBadge()));
    return sec;
  }

  function feedbackBadge() {
    return run.feedback === 'incorrect' ? h('span', { class: 'badge bad' }, '✗ Marked incorrect')
      : run.feedback === 'corrected' ? h('span', { class: 'badge good' }, '✓ Corrected SQL saved for training')
      : h('span', { class: 'badge good' }, '✓ Confirmed correct');
  }

  function feedbackBar() {
    const bar = h('div', { class: 'feedback' });
    const send = (btn, verdict, note = '') => busy(btn, async () => {
      const res = await api('POST', `/api/chat/runs/${run.id}/feedback`, { verdict, note });
      if (res.training === 'approved') toast('Saved as a verified example — the model will use it from now on.');
      else if (res.training === 'pending') toast('Thanks — sent to a data steward for approval before it is used for training.');
      refresh(res.run.rows == null ? { ...res.run, rows: run.rows } : res.run);
    });
    if (run.feedback) {
      bar.append(feedbackBadge(), h('button', { class: 'btn sm ghost', onclick: () => { run.feedback = ''; draw(); } }, 'Change'));
      return bar;
    }
    const yes = h('button', { class: 'btn sm good', onclick: () => send(yes, 'correct') }, run.edited ? '✓ Yes — save my correction for training' : '✓ Correct');
    const no = h('button', { class: 'btn sm danger', onclick: () => {
      const note = h('textarea', { placeholder: 'Optional: what is wrong with it?' });
      modal('Mark this SQL as incorrect', h('div', { class: 'stack' }, note,
        h('p', { class: 'small muted' }, 'Tip: use “Edit SQL” to fix the query yourself — a confirmed correction teaches the model the right answer.')), {
        actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'),
          h('button', { class: 'btn danger', onclick: () => { close(); send(no, 'incorrect', note.value); } }, 'Mark incorrect')],
      });
    } }, '✗ Incorrect');
    bar.append(h('span', { class: 'small muted' }, run.edited ? 'Does your edited SQL give the right answer?' : 'Is this SQL correct?'), yes,
      ...(run.edited ? [] : [h('button', { class: 'btn sm', onclick: () => { editing = true; draw(); } }, '✎ Fix it')]), no);
    return bar;
  }

  function resultSection() {
    const sec = h('div', { class: 'sec' });
    if (!run.rows) {
      sec.append(h('div', { class: 'banner info' }, 'Result rows are not kept in history. ',
        ctx.readonly ? '' : h('button', { class: 'btn sm', onclick: e => busy(e.target, async () => refresh(await api('POST', `/api/chat/runs/${run.id}/execute`, {}))) }, 'Run again')));
      return sec;
    }
    const cfg = run.chart = { type: 'table', ...(run.chart || {}) };
    if (cfg.type === 'table') { cfg.view = cfg.view || 'table'; }
    const nums = run.columns.filter(isMeasure).map(c => c.name);                 // measures: can be summed
    const all = [...run.columns.filter(c => !isMeasure(c)), ...run.columns.filter(isMeasure)].map(c => c.name);   // dimensions first
    const measureOpts = [...nums, [COUNT, 'Count of rows']];
    const canChart = run.rows.length > 0 && run.columns.length > 0;
    let view = cfg.view || (run.analysis ? 'table' : canChart && cfg.type !== 'table' ? 'chart' : 'table');
    if (view === 'chart' && !canChart) view = 'table';
    const body = h('div', {});
    const save = () => { if (!ctx.readonly) api('PUT', `/api/chat/runs/${run.id}/chart`, cfg).catch(() => {}); };
    const setView = v => { view = cfg.view = v; save(); paint(); };

    const exportMenu = h('div', { class: 'menu' });
    const pop = h('div', { class: 'pop hidden' },
      h('button', { onclick: () => { exportPDF(run, cfg.type === 'table' ? { ...cfg, type: 'kpi' } : cfg); } }, 'PDF report'),
      h('button', { onclick: () => download(`query-${run.id}.csv`, csvOf(run), 'text/csv') }, run.analysis ? 'Data used (CSV)' : 'CSV'),
      ...(run.analysis?.result?.tables || []).map(t => h('button', { onclick: () => download(`query-${run.id}-${t.key}.csv`, csvOf(t), 'text/csv') }, `${t.title} (CSV)`)),
      h('button', { onclick: () => { location.href = `/api/chat/runs/${run.id}/export.xlsx`; } }, 'Excel (.xlsx)'),
      ctx.readonly ? null : h('button', { onclick: () => addToReport(run) }, '＋ Add to a report…'),
      canChart ? h('button', { onclick: () => { const imgs = cfg.type === 'table' || cfg.type === 'kpi' ? [] : chartPanels(run, cfg).map(p => chartImage(run, p)).filter(Boolean); if (!imgs.length) return toast('Open the Chart view and choose a chart first', true); imgs.forEach((img, i) => fetch(img).then(r => r.blob()).then(b => download(`query-${run.id}${imgs.length > 1 ? '-' + (i + 1) : ''}.png`, b))); } }, 'Chart image (PNG)') : null);
    pop.addEventListener('click', () => pop.classList.add('hidden'));
    exportMenu.append(h('button', { class: 'btn sm', onclick: e => { e.stopPropagation(); pop.classList.toggle('hidden'); } }, '⬇ Export'), pop);

    const viewBtns = h('div', { class: 'row' });
    sec.append(h('div', { class: 'sec-head' }, h('h3', {}, run.analysis ? 'Data used' : 'Result'),
      h('span', { class: 'small dim' }, `${run.row_count.toLocaleString()} row${run.row_count === 1 ? '' : 's'}${run.truncated ? ' (row limit reached)' : ''}${run.rows.length < run.row_count ? ` · first ${run.rows.length.toLocaleString()} shown here` : ''}`),
      h('span', { class: 'spacer' }), viewBtns, exportMenu), body);

    function paint() {
      block?.destroy(); block = null;          // only the data chart: the predictive panel above keeps its charts
      fill(viewBtns, ...[['chart', 'Chart'], ['table', 'Table'], ['summary', 'Summary']].filter(v => v[0] !== 'chart' || canChart)
        .map(([v, l]) => h('button', { class: 'btn sm' + (view === v ? ' active' : ''), onclick: () => setView(v) }, l)));
      fill(body);
      if (run.context?.filters?.length) body.append(h('p', { class: 'small', style: 'margin:0 0 8px' }, h('span', { class: 'badge warn', title: 'An administrator has limited which rows this person can see in this data model' }, ctx.readonly ? '🔒 Data filters were applied to this query' : '🔒 Your data filters are applied')));
      if (view === 'table') return body.append(dataTable(run));
      if (view === 'summary') return body.append(summaryBlock(run));
      block = chartBlock(run, cfg, { onChange: save });
      body.append(block.el);
    }
    paint();
    sec._repaint = paint;
    return sec;
  }

  let resultSec = null;
  function draw() {
    cleanup();
    const card = h('div', { class: 'card flush run' });
    if (run.status === 'clarification') {
      card.append(h('div', { class: 'sec' }, h('div', { class: 'sec-head' }, h('h3', {}, 'I need a bit more detail'), h('span', { class: 'small dim' }, run.model_label)), h('p', { style: 'margin:0' }, run.explanation)));
    } else if (!run.final_sql) {
      card.append(h('div', { class: 'sec' }, h('div', { class: 'banner bad' }, run.error || 'Something went wrong.')));
    } else {
      card.append(sqlSection());
      if (run.status === 'success' && run.analysis) {
        const cfg = run.chart = run.chart || {};
        ablock = analysisBlock(run.analysis, { hidden: new Set(cfg.hide || []),
          onHide: set => { cfg.hide = [...set]; if (!ctx.readonly) api('PUT', `/api/chat/runs/${run.id}/chart`, cfg).catch(() => {}); },
          controls: ctx.readonly ? null : { rerun: async body => refresh(await api('POST', `/api/chat/runs/${run.id}/analysis`, body)) } });
        card.append(h('div', { class: 'sec' }, ablock.el));
      }
      resultSec = run.status === 'success' ? resultSection() : null;
      if (resultSec) card.append(resultSec);
    }
    if (run.followups?.length && ctx.onFollowup && (run.status === 'success' || run.status === 'clarification')) {
      card.append(h('div', { class: 'sec' }, h('div', { class: 'sec-head' }, h('h3', {}, 'Follow-up questions')),
        h('div', { class: 'chips' }, run.followups.map(f => h('button', { class: 'chip', onclick: () => ctx.onFollowup(f) }, f)))));
    }
    fill(root, h('div', { class: 'q' }, h('div', {}, run.question)), card);
  }
  const onTheme = () => { if (!root.isConnected) return window.removeEventListener('themechange', onTheme); resultSec?._repaint?.(); ablock?.repaint(); };
  window.addEventListener('themechange', onTheme);
  draw();
  return root;
}
