// Model performance + usage monitoring, with a drill-down log of every query.
import { h, fill, prettySQL, api, fail, select, modal, fmtNum, fmtCompact, pct, fmtTime, theme } from './core.js';
import { runCard } from './results.js';

const C = { light: { a: '#2a78d6', b: '#eb6834', text: '#55544e', grid: '#e9e8e3' }, dark: { a: '#3987e5', b: '#d95926', text: '#c3c2b7', grid: '#2c2c29' } };
const STATUS = { success: 'good', error: 'bad', blocked: 'bad', clarification: 'warn', pending_review: 'info' };

export async function dashboardView(root) {
  const f = { days: 30, connection_id: '', model_id: '', user_id: '' };
  const lf = { status: '', feedback: '', q: '', page: 1 };
  const models = (await api('GET', '/api/models'));
  const filters = h('div', { class: 'row wrap' });
  const body = h('div', { class: 'stack' });
  const logBody = h('div', {});
  let charts = [];
  fill(root, h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h1', {}, 'Dashboard'), h('span', { class: 'spacer' }), filters), body,
    h('h2', { style: 'margin-top:26px' }, 'Query log'), logBody));
  const qs = extra => new URLSearchParams(Object.entries({ ...f, ...extra }).filter(([, v]) => v !== '' && v != null)).toString();

  const tile = (label, value, sub) => h('div', { class: 'kpi' }, h('div', { class: 'l' }, label), h('div', { class: 'v' }, value), sub ? h('div', { class: 's' }, sub) : null);
  const breakdown = (title, rows, first) => h('div', { class: 'card' }, h('h2', {}, title), rows.length ? h('div', { class: 'tbl-wrap', style: 'max-height:300px' }, h('table', { class: 'tbl' },
    h('thead', {}, h('tr', {}, [first, 'Queries', 'Success', 'Accuracy', 'Avg write', 'Tokens', 'Cost'].map((t, i) => h('th', { class: i ? 'num' : '' }, t)))),
    h('tbody', {}, rows.map(r => h('tr', {}, h('td', {}, r.label), h('td', { class: 'num' }, fmtNum(r.queries)), h('td', { class: 'num' }, pct(r.success_rate)),
      h('td', { class: 'num', title: `${r.correct} correct of ${r.rated} rated` }, r.rated ? `${pct(r.accuracy)} (${r.rated})` : '–'), h('td', { class: 'num' }, (r.avg_llm_ms / 1000).toFixed(1) + 's'),
      h('td', { class: 'num' }, fmtCompact(r.input_tokens + r.output_tokens)), h('td', { class: 'num' }, '$' + r.cost.toFixed(2))))))) : h('div', { class: 'empty small' }, 'No activity in this period.'));

  async function draw() {
    charts.forEach(c => c.destroy()); charts = [];
    const s = await api('GET', '/api/analytics/summary?' + qs());
    const t = s.totals, ink = C[theme()];
    fill(filters, 
      select([[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [365, 'Last year']], f.days, v => { f.days = v; reload(); }, { class: 'inline' }),
      select([['', 'All data models'], ...s.filters.connections.map(c => [c.id, c.label])], f.connection_id, v => { f.connection_id = v; reload(); }, { class: 'inline' }),
      select([['', 'All AI models'], ...models.map(m => [m.id, m.name])], f.model_id, v => { f.model_id = v; reload(); }, { class: 'inline' }),
      select([['', 'All users'], ...s.filters.users.map(u => [u.id, u.label])], f.user_id, v => { f.user_id = v; reload(); }, { class: 'inline' }));
    const c1 = h('canvas', { role: 'img', 'aria-label': 'Queries per day' }), c2 = h('canvas', { role: 'img', 'aria-label': 'Feedback by AI model' });
    fill(body, 
      s.has_pending_training ? h('div', { class: 'banner info' }, 'User feedback is waiting for review. ', h('a', { href: '#/training' }, 'Open the review queue →')) : null,
      h('div', { class: 'kpis' },
        tile('Questions asked', fmtNum(t.queries), `${t.active_users} active user${t.active_users === 1 ? '' : 's'}`),
        tile('Ran successfully', pct(t.success_rate), `${t.errors} failed · ${t.clarifications} needed clarification`),
        tile('SQL accuracy', pct(t.accuracy), t.rated ? `${t.correct} correct, ${t.corrected} corrected, ${t.incorrect} wrong of ${t.rated} rated` : 'no user ratings yet'),
        tile('Auto-corrected', fmtNum(t.self_repaired), 'fixed by the model after a database error'),
        tile('Avg time to write SQL', (t.avg_llm_ms / 1000).toFixed(1) + 's', `+ ${t.avg_db_ms} ms to run`),
        tile('Model spend', '$' + t.cost.toFixed(2), `${fmtCompact(t.input_tokens)} in · ${fmtCompact(t.output_tokens)} out tokens`)),
      h('div', { class: 'dash-grid' },
        h('div', { class: 'card' }, h('h2', {}, 'Questions per day'), h('div', { class: 'chart-box', style: 'height:260px' }, c1)),
        h('div', { class: 'card' }, h('h2', {}, 'User verdicts by AI model'), s.by_model.some(m => m.rated) ? h('div', { class: 'chart-box', style: 'height:260px' }, c2)
          : h('div', { class: 'empty small' }, 'Accuracy appears here once users confirm or correct answers.'))),
      h('div', { class: 'dash-grid' }, breakdown('By AI model', s.by_model, 'Model'), breakdown('By data model', s.by_connection, 'Data model')),
      h('div', { class: 'dash-grid' }, breakdown('By user', s.by_user, 'User'),
        h('div', { class: 'card' }, h('h2', {}, 'Most common failures'), s.top_errors.length ? h('table', { class: 'tbl' }, h('tbody', {}, s.top_errors.map(e => h('tr', {}, h('td', { class: 'num', style: 'width:50px' }, e.count + '×'), h('td', { class: 'small' }, e.error)))))
          : h('div', { class: 'empty small' }, 'No failures in this period. 🎉'))));
    const base = { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: ink.text, boxWidth: 12, boxHeight: 12 } } } };
    const ax = (stacked, grid) => ({ stacked, grid: { color: grid ? ink.grid : 'transparent' }, border: { color: ink.grid }, ticks: { color: ink.text, precision: 0, maxRotation: 0, autoSkipPadding: 12 }, beginAtZero: true });
    charts.push(new Chart(c1, { type: 'bar', data: { labels: s.series.map(d => d.day.slice(5)), datasets: [
      { label: 'Succeeded', data: s.series.map(d => d.success), backgroundColor: ink.a, borderRadius: 3, maxBarThickness: 28 },
      { label: 'Failed / unanswered', data: s.series.map(d => d.queries - d.success), backgroundColor: ink.b, borderRadius: 3, maxBarThickness: 28 }] },
      options: { ...base, scales: { x: ax(true, false), y: ax(true, true) } } }));
    if (c2.isConnected) {
      const ms = s.by_model.filter(m => m.rated);
      charts.push(new Chart(c2, { type: 'bar', data: { labels: ms.map(m => m.label), datasets: [
        { label: 'Correct as written', data: ms.map(m => m.correct), backgroundColor: ink.a, borderRadius: 3, maxBarThickness: 28 },
        { label: 'Needed correction / wrong', data: ms.map(m => m.corrected + m.incorrect), backgroundColor: ink.b, borderRadius: 3, maxBarThickness: 28 }] },
        options: { ...base, indexAxis: 'y', scales: { x: ax(true, true), y: ax(true, false) } } }));
    }
  }

  async function drawLog() {
    const r = await api('GET', '/api/analytics/queries?' + qs(lf));
    const search = h('input', { type: 'search', placeholder: 'Search question or SQL…', value: lf.q, style: 'max-width:280px' });
    let timer; search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { lf.q = search.value; lf.page = 1; drawLog().then(() => logBody.querySelector('input[type=search]')?.focus()); }, 300); });
    fill(logBody, h('div', { class: 'row wrap', style: 'margin-bottom:10px' }, search,
      select([['', 'Any status'], ['success', 'Success'], ['error', 'Error'], ['blocked', 'Blocked'], ['clarification', 'Clarification'], ['pending_review', 'Awaiting review']], lf.status, v => { lf.status = v; lf.page = 1; drawLog(); }, { class: 'inline' }),
      select([['', 'Any feedback'], ['correct', 'Correct'], ['corrected', 'Corrected'], ['incorrect', 'Incorrect'], ['none', 'Not rated']], lf.feedback, v => { lf.feedback = v; lf.page = 1; drawLog(); }, { class: 'inline' }),
      h('span', { class: 'spacer' }), h('button', { class: 'btn sm', disabled: lf.page <= 1, onclick: () => { lf.page--; drawLog(); } }, '‹ Newer'), h('span', { class: 'small dim' }, `Page ${lf.page}`),
      h('button', { class: 'btn sm', disabled: !r.more, onclick: () => { lf.page++; drawLog(); } }, 'Older ›')),
    r.items.length ? h('div', { class: 'tbl-wrap', style: 'max-height:none' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['When', 'User', 'Question', 'Data model', 'AI model', 'Status', 'Feedback', 'Rows', 'Write', 'Run', 'Tokens', 'Cost'].map((t, i) => h('th', { class: i > 6 ? 'num' : '' }, t)))),
      h('tbody', {}, r.items.map(q => h('tr', { class: 'click', onclick: () => detail(q.id) },
        h('td', { class: 'nowrap' }, fmtTime(q.at)), h('td', {}, q.user), h('td', { class: 'clip' }, q.question), h('td', { class: 'nowrap' }, q.connection), h('td', { class: 'nowrap' }, q.model),
        h('td', {}, h('span', { class: 'badge ' + (STATUS[q.status] || '') }, q.status.replace('_', ' ')), q.attempts > 1 ? h('span', { class: 'badge', title: 'Model calls incl. automatic repairs' }, `×${q.attempts}`) : null),
        h('td', {}, q.feedback ? h('span', { class: 'badge ' + (q.feedback === 'correct' ? 'good' : q.feedback === 'corrected' ? 'warn' : 'bad') }, q.feedback) : ''),
        h('td', { class: 'num' }, fmtNum(q.rows)), h('td', { class: 'num' }, (q.llm_ms / 1000).toFixed(1) + 's'), h('td', { class: 'num' }, q.db_ms + ' ms'),
        h('td', { class: 'num' }, fmtCompact(q.tokens)), h('td', { class: 'num' }, '$' + q.cost.toFixed(4))))))) : h('div', { class: 'empty' }, 'No queries match.'));
  }

  async function detail(id) {
    const r = await api('GET', `/api/analytics/queries/${id}`).catch(fail);
    if (!r) return;
    const ctx = r.context || {};
    modal(`Query #${r.id}`, h('div', { class: 'stack' },
      h('div', { class: 'row wrap small muted' }, h('span', {}, '👤 ', r.user), h('span', {}, '🗄 ', r.connection), h('span', {}, '🤖 ', r.model_label), h('span', {}, fmtTime(r.created_at)),
        h('span', {}, `${fmtNum(r.input_tokens)} in / ${fmtNum(r.output_tokens)} out tokens · $${r.cost.toFixed(4)}`)),
      h('div', { class: 'small dim' }, `Sent to the model: ${ctx.tables?.length ?? 0} table definitions, ${ctx.examples?.length ?? 0} verified examples, ${ctx.docs?.length ?? 0} documentation passages, ${ctx.history_turns ?? 0} earlier turn(s). No result data.`),
      r.edited && r.generated_sql !== r.final_sql ? h('details', {}, h('summary', { class: 'small' }, 'SQL originally written by the model (before the user edited it)'), h('pre', { class: 'sql', style: 'margin-top:6px' }, r.generated_sql)) : null,
      r.feedback_note ? h('div', { class: 'banner warn' }, 'User note: ', r.feedback_note) : null,
      runCard(r, { readonly: true })), { wide: true });
  }
  const reload = () => { lf.page = 1; draw().catch(fail); drawLog().catch(fail); };
  const onTheme = () => { if (!root.isConnected) return window.removeEventListener('themechange', onTheme); draw().catch(fail); };
  window.addEventListener('themechange', onTheme);
  await Promise.all([draw(), drawLog()]);
}
