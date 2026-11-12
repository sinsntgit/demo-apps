// Custom reports: build from results of several chats, refresh live on open, schedule, share.
import { h, fill, api, busy, fail, toast, modal, field, check, select, confirmDialog, fmtTime, fmtNum, ago, state } from './core.js';
import { chartBlock, summaryBlock } from './results.js';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const uid = () => Math.random().toString(36).slice(2, 12);
const TOKENS = '{{date}}  {{datetime}}  {{viewer}}  {{title}}  {{summary:1}}  {{rows:1}}';

export async function reportsView(root, arg) {
  if (arg) return openReport(root, Number(arg));
  const body = h('div', { class: 'stack' });
  const create = h('button', { class: 'btn primary', onclick: () => busy(create, async () => {
    const r = await api('POST', '/api/reports', { title: 'Untitled report', components: [] });
    sessionStorage.setItem('t2s-edit-report', r.id); location.hash = `#/reports/${r.id}`;
  }) }, '＋ New report');
  fill(root, h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h1', {}, 'Reports'), h('span', { class: 'spacer' }), create),
    h('p', { class: 'muted', style: 'max-width:760px' }, 'A report combines results from any of your chats with your own headings and text. It stores the queries, not the numbers — every time it is opened it is refreshed with the latest data, for the person looking at it.'), body));
  const list = await api('GET', '/api/reports');
  fill(body, list.length ? list.map(r => h('a', { class: 'card report-card', href: `#/reports/${r.id}` },
    h('div', { class: 'row wrap' }, h('h2', { style: 'margin:0' }, r.title), r.mine ? null : h('span', { class: 'badge info' }, `shared by ${r.owner}`),
      r.scheduled ? h('span', { class: 'badge good' }, '🕒 scheduled') : null, r.can_edit && !r.mine ? h('span', { class: 'badge' }, 'can edit') : null),
    r.description ? h('div', { class: 'muted', style: 'margin-top:4px' }, r.description) : null,
    h('div', { class: 'small dim', style: 'margin-top:4px' }, `${r.results} result${r.results === 1 ? '' : 's'} · updated ${ago(r.updated_at)}` + (r.next_run_at ? ` · next run ${fmtTime(r.next_run_at)}` : ''))))
    : h('div', { class: 'empty' }, 'No reports yet. Create one here, or use Export → “Add to a report” on any result in a chat.'));
}

async function openReport(root, id) {
  let def, rendered = null, blocks = [];
  const editFirst = sessionStorage.getItem('t2s-edit-report') === String(id);
  sessionStorage.removeItem('t2s-edit-report');
  const page = h('div', { class: 'page' });
  fill(root, page);
  const cleanup = () => { blocks.forEach(b => b.destroy()); blocks = []; };
  try { def = await api('GET', `/api/reports/${id}`); } catch (e) { return fill(page, h('div', { class: 'banner bad' }, e.message), h('p', {}, h('a', { href: '#/reports' }, '← All reports'))); }

  // ---------------------------------------------------------------- view
  function resultView(c, editable) {
    const box = h('div', { class: 'rep-result' }, h('h3', { class: 'rep-h3' }, c.title || c.question));
    if (c.status !== 'ok') { box.append(h('div', { class: 'banner ' + (c.status === 'no_access' ? 'warn' : 'bad') }, c.message || 'This result could not be refreshed.')); return box; }
    box.append(h('div', { class: 'row wrap small dim', style: 'margin-bottom:8px' }, h('span', {}, `🗄 ${c.data_model}`), h('span', {}, `${fmtNum(c.row_count)} rows${c.truncated ? ' (row limit reached)' : ''}`),
      c.filtered ? h('span', { class: 'badge warn', title: 'An administrator has limited which rows you can see' }, '🔒 your data filters applied') : null));
    if (c.show_summary) box.append(summaryBlock(c, { table: false }));
    if (c.show_chart && c.rows.length) {
      const cfg = c.chart = { ...(c.chart || {}) };
      if (cfg.type !== 'table') { const b = chartBlock(c, cfg, { controls: !!editable, onChange: editable }); blocks.push(b); box.append(h('div', { style: 'margin-top:10px' }, b.el)); }
    }
    if (c.show_table && c.rows.length) {
      const limit = c.table_rows || 25;
      box.append(h('div', { class: 'tbl-wrap', style: 'margin-top:12px;max-height:none' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, c.columns.map(col => h('th', { class: col.type === 'number' ? 'num' : '' }, col.name)))),
        h('tbody', {}, c.rows.slice(0, limit).map(r => h('tr', {}, r.map((v, i) => v == null ? h('td', { class: 'null' }, '') : h('td', { class: c.columns[i].type === 'number' ? 'num' : '' }, c.columns[i].type === 'number' ? fmtNum(v) : String(v).replace(/ 00:00:00$/, '')))))))));
      if (c.rows.length > limit) box.append(h('p', { class: 'small dim' }, `First ${limit} of ${fmtNum(c.row_count)} rows shown.`));
    }
    return box;
  }

  async function view(refresh = true) {
    cleanup();
    const paper = h('div', { class: 'paper' }, h('div', { class: 'empty' }, h('span', { class: 'spinner' }), '  Refreshing with the latest data…'));
    const refreshBtn = h('button', { class: 'btn', onclick: () => view() }, '⟳ Refresh');
    fill(page, h('div', { class: 'page-head' }, h('a', { class: 'btn ghost', href: '#/reports' }, '← Reports'), h('span', { class: 'spacer' }), refreshBtn,
      h('button', { class: 'btn', onclick: e => { toast('Preparing PDF…'); location.href = `/api/reports/${id}/pdf`; } }, '⬇ PDF'),
      def.can_edit ? h('button', { class: 'btn primary', onclick: edit }, '✎ Edit') : null,
      def.is_owner ? [h('button', { class: 'btn', onclick: schedule }, def.scheduled ? '🕒 Scheduled' : '🕒 Schedule'), h('button', { class: 'btn', onclick: share }, '👥 Share'),
        h('button', { class: 'btn', onclick: snapshots }, '🗂 Saved copies'),
        h('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog('Delete report?', `“${def.title}”, its schedule and its saved copies will be removed. The chats it was built from are not affected.`, 'Delete')) { await api('DELETE', `/api/reports/${id}`).catch(fail); location.hash = '#/reports'; } } }, 'Delete')] : null), paper);
    if (refresh || !rendered) { try { rendered = await api('GET', `/api/reports/${id}/render`); } catch (e) { return fill(paper, h('div', { class: 'banner bad' }, e.message)); } }
    const out = [];
    if (rendered.header_text) out.push(h('div', { class: 'rep-running' }, rendered.header_text));
    out.push(h('h1', { class: 'rep-title' }, rendered.title));
    if (rendered.description) out.push(h('p', { class: 'muted' }, rendered.description));
    out.push(h('p', { class: 'small dim' }, `Data refreshed ${fmtTime(rendered.refreshed_at)} for ${rendered.viewer}`));
    if (!rendered.components.length) out.push(h('div', { class: 'empty' }, 'This report is empty. ', def.can_edit ? 'Press Edit to add headings, text and results from your chats.' : ''));
    for (const c of rendered.components) {
      if (c.type === 'heading') out.push(h(c.level === 2 ? 'h3' : 'h2', { class: c.level === 2 ? 'rep-h3' : 'rep-h2' }, c.text));
      else if (c.type === 'text') out.push(...c.text.split(/\n\s*\n/).filter(t => t.trim()).map(t => h('p', { style: 'white-space:pre-wrap' }, t.trim())));
      else if (c.type === 'divider') out.push(h('hr', { class: 'rep-hr' }));
      else if (c.type === 'pagebreak') out.push(h('div', { class: 'rep-break' }, 'page break'));
      else out.push(resultView(c, false));
    }
    out.push(h('div', { class: 'rep-running foot' }, h('span', {}, rendered.footer_text || ''), rendered.page_numbers ? h('span', {}, 'Page numbers are added in the PDF') : null));
    fill(paper, out);
  }

  // ---------------------------------------------------------------- edit
  function edit() {
    cleanup();
    const comps = def.components.map(c => ({ ...c, chart: { ...(c.chart || {}) } }));
    const data = Object.fromEntries((rendered?.components || []).filter(c => c.type === 'result').map(c => [c.id, c]));
    const title = h('input', { type: 'text', value: def.title, maxlength: 300 });
    const desc = h('input', { type: 'text', value: def.description || '', placeholder: 'Optional: one line on what this report is for' });
    const header = h('input', { type: 'text', value: def.header_text || '', placeholder: 'e.g. Confidential · {{title}}', maxlength: 300 });
    const footer = h('input', { type: 'text', value: def.footer_text || '', placeholder: 'e.g. Finance team · generated {{date}}', maxlength: 300 });
    const pages = check('Show page numbers (“Page 1 of 3”) in the PDF', def.page_numbers);
    const list = h('div', { class: 'stack' });
    const move = (i, d) => { const j = i + d; if (j < 0 || j >= comps.length) return; [comps[i], comps[j]] = [comps[j], comps[i]]; draw(); };
    const LABEL = { heading: 'Heading', text: 'Text', result: 'Result from a chat', divider: 'Divider line', pagebreak: 'Page break' };

    function editor(c) {
      if (c.type === 'heading') return h('div', { class: 'row' }, h('input', { type: 'text', value: c.text, placeholder: 'Heading text', oninput: e => { c.text = e.target.value; } }),
        select([[1, 'Large'], [2, 'Small']], c.level || 1, v => { c.level = Number(v); }, { class: 'inline' }));
      if (c.type === 'text') return h('textarea', { placeholder: 'Write commentary here. Leave a blank line between paragraphs.', style: 'min-height:90px', oninput: e => { c.text = e.target.value; } }, c.text);
      if (c.type !== 'result') return h('div', { class: 'small dim' }, c.type === 'divider' ? 'A thin horizontal line.' : 'Following content starts on a new page in the PDF.');
      const rows = h('input', { type: 'number', min: 1, max: 500, value: c.table_rows || 25, class: 'inline', style: 'width:80px', oninput: e => { c.table_rows = Number(e.target.value) || 25; } });
      const out = h('div', { class: 'stack' }, field('Title shown in the report', h('input', { type: 'text', value: c.title || '', oninput: e => { c.title = e.target.value; } })),
        h('div', { class: 'small dim' }, 'Question asked: ', c.question || ''),
        h('div', { class: 'row wrap' }, check('Summary', c.show_summary !== false, v => { c.show_summary = v; }), check('Chart', c.show_chart !== false, v => { c.show_chart = v; draw(); }),
          check('Table', c.show_table !== false, v => { c.show_table = v; }), h('label', { class: 'row small' }, 'rows in table', rows)));
      const d = data[c.id];
      if (c.show_chart !== false) {
        if (d?.status === 'ok' && d.rows.length) { const b = chartBlock(d, c.chart, { controls: true }); blocks.push(b); out.append(h('div', { class: 'rep-preview' }, b.el)); }
        else out.append(h('div', { class: 'small dim' }, d ? (d.message || 'No rows to chart.') : 'Save the report to load this result, then you can change its chart here.'));
      }
      return out;
    }
    function draw() {
      cleanup();
      fill(list, comps.length ? comps.map((c, i) => h('div', { class: 'card rep-comp' },
        h('div', { class: 'row', style: 'margin-bottom:8px' }, h('span', { class: 'badge' + (c.type === 'result' ? ' info' : '') }, LABEL[c.type]), h('span', { class: 'spacer' }),
          h('button', { class: 'btn sm ghost', disabled: i === 0, title: 'Move up', onclick: () => move(i, -1) }, '↑'), h('button', { class: 'btn sm ghost', disabled: i === comps.length - 1, title: 'Move down', onclick: () => move(i, 1) }, '↓'),
          h('button', { class: 'btn sm ghost danger', title: 'Remove from report', onclick: () => { comps.splice(i, 1); draw(); } }, '✕')), editor(c)))
        : h('div', { class: 'empty' }, 'Nothing in the report yet. Add components with the buttons below.'));
    }
    const add = c => { comps.push({ id: uid(), ...c }); draw(); list.lastChild?.scrollIntoView({ block: 'center' }); list.lastChild?.querySelector('input,textarea')?.focus(); };
    const save = h('button', { class: 'btn primary', onclick: () => busy(save, async () => {
      def = await api('PUT', `/api/reports/${id}`, { title: title.value, description: desc.value, header_text: header.value, footer_text: footer.value, page_numbers: pages.input.checked, components: comps });
      toast('Report saved'); view();
    }) }, 'Save report');
    fill(page, h('div', { class: 'page-head' }, h('h1', {}, 'Edit report'), h('span', { class: 'spacer' }), h('button', { class: 'btn', onclick: () => view(false) }, 'Cancel'), save),
      h('div', { class: 'card stack' }, h('div', { class: 'grid2' }, field('Title', title), field('Description', desc)),
        h('div', { class: 'grid2' }, field('Header', header, 'top of every PDF page'), field('Footer', footer, 'bottom of every PDF page')), pages,
        h('p', { class: 'small dim', style: 'margin:0' }, 'Live placeholders you can type in headings, text, header and footer — filled in each time the report is opened: ', h('span', { class: 'mono' }, TOKENS),
          '. {{summary:1}} is the one-line summary of the 1st result; {{rows:2}} is the row count of the 2nd.')),
      h('h2', { style: 'margin:18px 0 8px' }, 'Components'), list,
      h('div', { class: 'row wrap', style: 'margin-top:14px' }, h('button', { class: 'btn primary', onclick: () => pickResults(add) }, '＋ Result from a chat'),
        h('button', { class: 'btn', onclick: () => add({ type: 'heading', text: '', level: 1 }) }, '＋ Heading'), h('button', { class: 'btn', onclick: () => add({ type: 'text', text: '' }) }, '＋ Text'),
        h('button', { class: 'btn', onclick: () => add({ type: 'divider' }) }, '＋ Divider'), h('button', { class: 'btn', onclick: () => add({ type: 'pagebreak' }) }, '＋ Page break')));
    draw();
  }

  function pickResults(add) {
    const picked = new Map();
    const list = h('div', { class: 'card flush', style: 'max-height:50vh;overflow:auto' });
    const search = h('input', { type: 'search', placeholder: 'Search your questions…' });
    const load = async () => {
      const rows = (await api('GET', '/api/chat/history?q=' + encodeURIComponent(search.value))).filter(r => r.status === 'success');
      fill(list, rows.length ? rows.map(r => h('label', { class: 'item check' }, h('input', { type: 'checkbox', checked: picked.has(r.id), onchange: e => e.target.checked ? picked.set(r.id, r) : picked.delete(r.id) }),
        h('span', {}, h('b', {}, r.question), h('div', { class: 'small dim' }, `${r.connection_name} · ${fmtNum(r.row_count)} rows · ${fmtTime(r.created_at)}`))))
        : h('div', { class: 'empty small' }, 'No answered questions found. Ask something on the Ask page first.'));
    };
    let t; search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => load().catch(fail), 250); });
    modal('Add results from your chats', h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Tick as many as you like, from any chat and any data model. Each keeps its chart, table and summary.'), search, list), {
      wide: true, actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => {
        if (!picked.size) return toast('Tick at least one result.', true);
        picked.forEach(r => add({ type: 'result', run_id: r.id, title: r.question, question: r.question, show_chart: true, show_table: true, show_summary: true, table_rows: 25, chart: {} }));
        close();
      } }, 'Add selected')] });
    load().catch(fail);
  }

  // ---------------------------------------------------------------- schedule / share / snapshots
  function schedule() {
    const s = { ...def.schedule };
    if (!s.tz || s.tz === 'UTC') s.tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const enabled = check('Run this report automatically', s.enabled);
    const when = h('div', { class: 'row wrap' });
    const time = h('input', { type: 'time', value: s.time || '08:00', class: 'inline', oninput: e => { s.time = e.target.value; } });
    const drawWhen = () => fill(when, select([['daily', 'Every day'], ['weekdays', 'Every weekday (Mon–Fri)'], ['weekly', 'Every week'], ['monthly', 'Every month']], s.frequency, v => { s.frequency = v; drawWhen(); }, { class: 'inline' }),
      s.frequency === 'weekly' ? ['on', select(DAYS.map((d, i) => [i, d]), s.weekday, v => { s.weekday = Number(v); }, { class: 'inline' })] : null,
      s.frequency === 'monthly' ? ['on day', h('input', { type: 'number', min: 1, max: 28, value: s.monthday || 1, class: 'inline', style: 'width:70px', oninput: e => { s.monthday = Number(e.target.value); } })] : null,
      'at', time, h('span', { class: 'small dim' }, `(${s.tz} time)`));
    drawWhen();
    const rcpt = h('textarea', { placeholder: 'one email address per line', style: 'min-height:70px' }, (s.recipients || []).join('\n'));
    const send = check('Also email it to the recipients above', false);
    const payload = () => ({ ...s, enabled: enabled.input.checked, recipients: rcpt.value.split(/[\n,;]/).map(x => x.trim()).filter(Boolean) });
    modal('Schedule “' + def.title + '”', h('div', { class: 'stack' }, enabled, field('When', when), field('Email the PDF to', rcpt, 'optional'),
      def.email_ready ? null : h('div', { class: 'banner warn' }, 'Email is not set up yet, so scheduled runs will be saved in the app but not emailed. An administrator can enter the mail server under Admin → Settings.'),
      h('p', { class: 'small dim' }, 'Each run refreshes the report using your own data access and saves a dated PDF under “Saved copies” (the latest 30 are kept). Recipients receive what you would see — only add people who are allowed to see it.'),
      def.next_run_at ? h('p', { class: 'small' }, 'Next run: ', h('b', {}, fmtTime(def.next_run_at))) : null,
      h('hr', { class: 'rep-hr' }), h('div', { class: 'row wrap' }, h('button', { class: 'btn', onclick: e => busy(e.target, async () => {
        await api('PUT', `/api/reports/${id}/schedule`, payload());
        const r = await api('POST', `/api/reports/${id}/snapshots`, { send: send.input.checked });
        toast(r.status === 'ok' ? ('Saved copy created' + (r.emailed_to.length ? ` and emailed to ${r.emailed_to.length} recipient(s)` : '') + (r.note ? ` — ${r.note}` : '')) : `Failed: ${r.note}`, r.status !== 'ok');
      }) }, '▶ Run now'), send)), {
      actions: close => [h('button', { class: 'btn', onclick: close }, 'Close'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
        const r = await api('PUT', `/api/reports/${id}/schedule`, payload());
        def.schedule = r.schedule; def.next_run_at = r.next_run_at; def.scheduled = r.schedule.enabled;
        close(); toast(r.schedule.enabled ? `Scheduled. Next run ${fmtTime(r.next_run_at)}.` : 'Schedule turned off.'); view(false);
      }) }, 'Save schedule')] });
  }

  async function share() {
    const people = await api('GET', '/api/reports/people').catch(fail);
    if (!people) return;
    const cur = new Map((def.shares || []).map(s => [s.scope === 'role' ? 'role:' + s.role : 'user:' + s.user_id, s.can_edit ? 'edit' : 'view']));
    const OPT = [['', 'No access'], ['view', 'Can view'], ['edit', 'Can view and edit']];
    const row = (key, label, sub) => h('div', { class: 'item row' }, h('div', { style: 'flex:1' }, h('b', {}, label), sub ? h('div', { class: 'small dim' }, sub) : null),
      select(OPT, cur.get(key) || '', v => v ? cur.set(key, v) : cur.delete(key), { class: 'inline' }));
    modal('Share “' + def.title + '”', h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, 'Reports are private until shared. People you share with see the report refreshed with their own data access: results from data models they cannot use are hidden, and their data filters apply.'),
      h('h3', {}, 'By role'), h('div', { class: 'card flush' }, row('role:analyst', 'All analysts'), row('role:steward', 'All data stewards')),
      h('h3', {}, 'Individual people'), h('div', { class: 'card flush', style: 'max-height:40vh;overflow:auto' }, people.users.filter(u => u.role !== 'admin').map(u => row('user:' + u.id, u.name, `${u.email} · ${u.role}`))),
      h('p', { class: 'small dim' }, 'Administrators can always open every report.')), {
      wide: true, actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
        const shares = [...cur].map(([k, v]) => { const [scope, val] = k.split(':'); return scope === 'role' ? { scope, role: val, can_edit: v === 'edit' } : { scope, user_id: Number(val), can_edit: v === 'edit' }; });
        await api('PUT', `/api/reports/${id}/shares`, { shares }); def.shares = shares; close(); toast('Sharing updated');
      }) }, 'Save')] });
  }

  async function snapshots() {
    const list = await api('GET', `/api/reports/${id}/snapshots`).catch(fail);
    if (!list) return;
    modal('Saved copies of “' + def.title + '”', list.length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['Created', 'How', 'Emailed to', 'Notes', ''].map(t => h('th', {}, t)))),
      h('tbody', {}, list.map(s => h('tr', {}, h('td', { class: 'nowrap' }, fmtTime(s.at)), h('td', {}, s.trigger === 'schedule' ? 'Schedule' : 'Run now'),
        h('td', { class: 'small' }, s.emailed_to.join(', ') || '–'), h('td', { class: 'small' }, s.status === 'ok' ? s.note : h('span', { class: 'badge bad' }, s.note || 'failed')),
        h('td', { class: 'right' }, s.status === 'ok' ? h('a', { class: 'btn sm', href: `/api/reports/${id}/snapshots/${s.id}/pdf` }, '⬇ PDF') : null))))))
      : h('div', { class: 'empty' }, 'No saved copies yet. They are created by the schedule, or with “Run now” in the Schedule window.'), { wide: true });
  }

  if (editFirst && def.can_edit) edit(); else await view();
}
