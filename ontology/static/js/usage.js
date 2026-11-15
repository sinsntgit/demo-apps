// AI usage dashboard: jobs, model calls, tokens and estimated cost. Everyone sees their own usage;
// an administrator sees all users and can filter by person. (The server applies that rule.)
import { h, fill, api, fail, select, fmtNum, fmtCompact, fmtTime, state } from './core.js';
import { JOB } from './workspace.js';

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs, ...kids) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v); el.append(...kids.flat().filter(x => x != null)); return el; };
const KIND = { build: 'Build', refine: 'Refine', explain: 'Explanation', usecases: 'Use cases', test: 'Test bed', gaps: 'Gap review', fix: 'Fix proposals' };
const money = v => '$' + (v >= 100 ? v.toFixed(0) : v.toFixed(2));

/** Bars per day. series: [{key, label, cls}] - stacked when more than one. */
function bars(days, series, fmt) {
  const W = 900, H = 230, L = 52, B = 26, T = 10, R = 8;
  const totals = days.map(d => series.reduce((a, x) => a + d[x.key], 0));
  const top = Math.max(...totals, 0);
  if (!top) return h('div', { class: 'empty', style: 'padding:50px' }, series[0].key === 'cost' && days.some(d => d.jobs) ? 'No cost recorded: no prices are entered for the AI models used (Admin › AI models). Switch to Tokens or Jobs.' : 'No AI activity in this period.');
  const pow = 10 ** Math.floor(Math.log10(top)), max = Math.ceil(top / pow * 2) / 2 * pow;
  const bw = (W - L - R) / days.length, y = v => T + (H - T - B) * (1 - v / max);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img' });
  for (let i = 0; i <= 4; i++) {
    const v = max * i / 4;
    svg.append(s('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid' }), s('text', { x: L - 6, y: y(v) + 3.5, 'text-anchor': 'end', class: 'tick' }, fmt(v)));
  }
  const step = Math.ceil(days.length / 10);
  days.forEach((d, i) => {
    let base = 0;
    const date = new Date(d.key + 'T00:00:00');
    const tip = `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}\n` + series.map(x => `${x.label}: ${fmt(d[x.key])}`).join('\n') + `\n${d.jobs} job(s)`;
    series.forEach(x => {
      const v = d[x.key]; if (!v) return;
      const hgt = y(base) - y(base + v);
      svg.append(s('rect', { x: L + i * bw + bw * 0.14, y: y(base + v), width: Math.max(bw * 0.72, 1), height: Math.max(hgt, 0.8), rx: Math.min(2.5, bw / 4), class: 'bar ' + x.cls }, s('title', {}, tip)));
      base += v;
    });
    if (i % step === 0) svg.append(s('text', { x: L + i * bw + bw / 2, y: H - 8, 'text-anchor': 'middle', class: 'tick' }, date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })));
  });
  return h('div', {}, svg, series.length > 1 ? h('div', { class: 'dg-legend', style: 'border:0;padding:4px 0 0' }, series.map(x => h('span', {}, h('i', { class: 'sw ' + x.cls }), x.label))) : null);
}

export async function usageView(root) {
  const f = { days: 30, user_id: 0, model: '', kind: '' };
  let metric = 'cost', chosen = false;
  const body = h('div', {});
  const admin = state.me.role === 'admin';
  async function draw() {
    const q = new URLSearchParams(f).toString();
    let d;
    try { d = await api('GET', '/api/usage?' + q); } catch (e) { return fail(e); }
    const t = d.totals;
    if (!chosen && t.jobs && !t.cost) metric = 'tokens';      // no prices entered for the models: show tokens rather than an empty cost chart
    const kpi = (l, v, sub) => h('div', { class: 'kpi' }, h('div', { class: 'l' }, l), h('div', { class: 'v' }, v), sub ? h('div', { class: 's' }, sub) : null);
    const filters = h('div', { class: 'row wrap' },
      select([[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [365, 'Last 12 months']], f.days, v => { f.days = Number(v); draw(); }, { class: 'inline' }),
      admin ? select([[0, 'All users'], ...d.users.map(u => [u.id, u.email])], f.user_id, v => { f.user_id = Number(v); draw(); }, { class: 'inline' }) : null,
      select([['', 'All AI models'], ...d.models], f.model, v => { f.model = v; draw(); }, { class: 'inline' }),
      select([['', 'All kinds of work'], ...d.kinds.map(k => [k, KIND[k] || k])], f.kind, v => { f.kind = v; draw(); }, { class: 'inline' }),
      h('span', { class: 'spacer' }), h('a', { class: 'btn', href: `/api/usage.csv?days=${f.days}&user_id=${f.user_id}` }, '⬇ CSV'));
    const chart = metric === 'cost' ? bars(d.by_day, [{ key: 'cost', label: 'Estimated cost', cls: 'b0' }], money)
      : metric === 'tokens' ? bars(d.by_day, [{ key: 'input_tokens', label: 'Input tokens', cls: 'b0' }, { key: 'output_tokens', label: 'Output tokens', cls: 'b1' }], fmtCompact)
        : bars(d.by_day, [{ key: metric, label: metric === 'jobs' ? 'AI jobs' : 'Model calls', cls: 'b0' }], v => fmtNum(Math.round(v)));
    const seg = h('div', { class: 'seg' }, [['cost', 'Cost'], ['tokens', 'Tokens'], ['jobs', 'Jobs'], ['calls', 'Model calls']].map(([k, l]) =>
      h('button', { class: metric === k ? 'on' : '', style: 'padding:4px 11px', onclick: () => { metric = k; chosen = true; draw(); } }, l)));
    const share = (rows, label, name = x => x) => {
      const max = Math.max(...rows.map(r => r.cost), 0.0001);
      return h('div', { class: 'card' }, h('h2', {}, label), rows.length ? h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['', 'Jobs', 'Calls', 'Tokens in / out', 'Cost', ''].map(x => h('th', { class: x && x !== '' ? 'num' : '' }, x)))),
        h('tbody', {}, rows.map(r => h('tr', {}, h('td', {}, h('b', {}, name(r.key)), r.failed ? h('span', { class: 'badge bad', style: 'margin-left:6px' }, `${r.failed} failed`) : null), h('td', { class: 'num' }, r.jobs), h('td', { class: 'num' }, r.calls),
          h('td', { class: 'num' }, `${fmtCompact(r.input_tokens)} / ${fmtCompact(r.output_tokens)}`), h('td', { class: 'num' }, money(r.cost)),
          h('td', { style: 'width:28%' }, h('div', { class: 'progress', title: `${Math.round(r.cost / Math.max(t.cost, 0.0001) * 100)}% of the cost` }, h('div', { style: `width:${r.cost / max * 100}%` }))))))) : h('div', { class: 'small dim' }, 'Nothing in this period.'));
    };
    fill(body, h('div', { class: 'stack' }, filters,
      h('div', { class: 'kpis' }, kpi('AI jobs', fmtNum(t.jobs), t.failed ? `${t.failed} did not finish` : 'all finished'), kpi('Model calls', fmtNum(t.calls), 'requests sent to AI models'),
        kpi('Input tokens', fmtCompact(t.input_tokens), 'sent to the models'), kpi('Output tokens', fmtCompact(t.output_tokens), 'written by the models'),
        kpi('Estimated cost', money(t.cost), t.jobs ? `${money(t.cost / t.jobs)} per job` : ''), kpi('Average time', !t.jobs ? '—' : t.avg_seconds < 1 ? '<1s' : t.avg_seconds >= 90 ? `${(t.avg_seconds / 60).toFixed(1)} min` : `${Math.round(t.avg_seconds)}s`, 'per job'),
        kpi('Ontologies', t.ontologies, 'worked on'), admin ? kpi('People', t.users, 'used AI') : null),
      h('div', { class: 'card' }, h('div', { class: 'row', style: 'margin-bottom:8px' }, h('h2', { style: 'margin:0;flex:1' }, 'Per day'), seg), chart),
      h('div', { class: 'dash-grid' }, share(d.by_kind, 'By kind of work', k => KIND[k] || k), share(d.by_model, 'By AI model')),
      h('div', { class: 'dash-grid' }, admin ? share(d.by_user, 'By person') : null, share(d.by_ontology, 'By ontology')),
      h('div', {}, h('h2', {}, `Recent AI jobs${d.recent.length === 100 ? ' (latest 100)' : ''}`), d.recent.length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ['When', admin ? 'Person' : null, 'Work', 'Ontology', 'AI model', 'Result', 'Calls', 'Tokens in / out', 'Cost', 'Time'].filter(Boolean).map(x => h('th', {}, x)))),
        h('tbody', {}, d.recent.map(j => h('tr', {}, h('td', { class: 'nowrap' }, fmtTime(j.at)), admin ? h('td', {}, j.user) : null, h('td', {}, KIND[j.kind] || j.kind),
          h('td', {}, j.ontology_id ? h('a', { href: `#/o/${j.ontology_id}` }, j.ontology) : j.ontology), h('td', {}, j.model),
          h('td', {}, h('span', { class: 'badge ' + ({ done: 'good', error: 'bad' }[j.status] || 'info'), title: j.error || '' }, j.status === 'done' ? 'finished' : j.status === 'error' ? 'failed' : j.status)),
          h('td', { class: 'num' }, j.calls), h('td', { class: 'num' }, `${fmtNum(j.input_tokens)} / ${fmtNum(j.output_tokens)}`), h('td', { class: 'num' }, '$' + j.cost.toFixed(3)),
          h('td', { class: 'num' }, j.seconds == null ? '…' : j.seconds + 's')))))) : h('div', { class: 'card empty' }, 'No AI jobs in this period.')),
      h('p', { class: 'small dim' }, 'Cost is an estimate: tokens reported by the model provider multiplied by the prices entered for each model under Admin › AI models. ',
        admin ? 'As an administrator you see everyone’s usage; other people see only their own.' : 'You see your own usage. Administrators see everyone’s.')));
  }
  fill(root, h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h1', {}, admin ? 'AI usage' : 'My AI usage')), body));
  await draw();
}
export { JOB };
