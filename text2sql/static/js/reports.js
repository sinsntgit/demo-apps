// Custom reports: build from results of several chats, refresh live on open, schedule, share.
import { h, fill, api, busy, fail, toast, modal, field, check, select, confirmDialog, fmtTime, fmtNum, ago, state } from './core.js';
import { chartBlock, summaryBlock, analysisBlock } from './results.js';

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
    if (c.analysis) { const a = analysisBlock(c.analysis, { hidden: new Set(c.hide || []) }); blocks.push(a); box.append(h('div', { class: 'rep-analysis' }, a.el), h('h3', { class: 'rep-h3' }, 'Data used')); }
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
    const grid = h('div', { class: 'rep-grid' });
    for (const c of rendered.components) {
      const cell = kids => grid.append(h('div', { class: 'rep-cell', style: `grid-column: span ${['divider', 'pagebreak'].includes(c.type) ? 6 : (c.width || 6)}` }, kids));
      if (c.type === 'heading') cell(h(c.level === 2 ? 'h3' : 'h2', { class: c.level === 2 ? 'rep-h3' : 'rep-h2' }, c.text));
      else if (c.type === 'text') cell(c.text.split(/\n\s*\n/).filter(t => t.trim()).map(t => h('p', { style: 'white-space:pre-wrap' }, t.trim())));
      else if (c.type === 'divider') cell(h('hr', { class: 'rep-hr' }));
      else if (c.type === 'pagebreak') cell(h('div', { class: 'rep-break' }, 'page break'));
      else cell(resultView(c, false));
    }
    out.push(grid);
    out.push(h('div', { class: 'rep-running foot' }, h('span', {}, rendered.footer_text || ''), rendered.page_numbers ? h('span', {}, 'Page numbers are added in the PDF') : null));
    fill(paper, out);
  }

  // ---------------------------------------------------------------- edit (drag & drop designer)
  function edit() {
    cleanup();
    const comps = def.components.map(c => ({ ...c, chart: { ...(c.chart || {}) } }));
    const data = Object.fromEntries((rendered?.components || []).filter(c => c.type === 'result').map(c => [c.id, c]));
    const title = h('input', { type: 'text', value: def.title, maxlength: 300 });
    const desc = h('input', { type: 'text', value: def.description || '', placeholder: 'Optional: one line on what this report is for' });
    const header = h('input', { type: 'text', value: def.header_text || '', placeholder: 'e.g. Confidential · {{title}}', maxlength: 300 });
    const footer = h('input', { type: 'text', value: def.footer_text || '', placeholder: 'e.g. Finance team · generated {{date}}', maxlength: 300 });
    const pages = check('Show page numbers (“Page 1 of 3”) in the PDF', def.page_numbers);
    const canvas = h('div', { class: 'rep-grid design' });
    const LABEL = { heading: 'Heading', text: 'Text', result: 'Result from a chat', divider: 'Divider line', pagebreak: 'Page break' };
    const ICON = { result: '📊', heading: '🔠', text: '📝', divider: '➖', pagebreak: '📄' };
    const WIDTHS = [[6, 'Full'], [4, '⅔'], [3, '½'], [2, '⅓']];
    const blank = type => ({ id: uid(), type, width: 6, ...(type === 'heading' ? { text: '', level: 1 } : type === 'text' ? { text: '' } : {}) });
    let drag = null;                                  // { from: index } when moving, { type } when dragging from the palette
    const move = (i, j) => { if (j < 0 || j >= comps.length) return; comps.splice(j, 0, comps.splice(i, 1)[0]); draw(); };

    /** Put the dragged thing at position `at` (an index into the list as it is now). */
    function dropAt(at) {
      const d = drag; drag = null;
      if (!d) return;
      if (d.from != null) {
        const [item] = comps.splice(d.from, 1);
        comps.splice(d.from < at ? at - 1 : at, 0, item); draw();
      } else if (d.type === 'result') pickResults(list => { comps.splice(at, 0, ...list); draw(); });
      else { comps.splice(at, 0, blank(d.type)); draw(); canvas.children[at]?.querySelector('input[type=text],textarea')?.focus(); }
    }
    const clearMarks = () => canvas.querySelectorAll('.drop-before,.drop-after').forEach(n => n.classList.remove('drop-before', 'drop-after'));

    function editor(c) {
      if (c.type === 'heading') return h('div', { class: 'row' }, h('input', { type: 'text', value: c.text, placeholder: 'Heading text', oninput: e => { c.text = e.target.value; } }),
        select([[1, 'Large'], [2, 'Small']], c.level || 1, v => { c.level = Number(v); }, { class: 'inline' }));
      if (c.type === 'text') return h('textarea', { placeholder: 'Write commentary here. Leave a blank line between paragraphs.', style: 'min-height:90px', oninput: e => { c.text = e.target.value; } }, c.text);
      if (c.type !== 'result') return h('div', { class: 'small dim' }, c.type === 'divider' ? 'A thin horizontal line across the page.' : 'Everything after this starts on a new page in the PDF.');
      const rows = h('input', { type: 'number', min: 1, max: 500, value: c.table_rows || 25, class: 'inline', style: 'width:72px', oninput: e => { c.table_rows = Number(e.target.value) || 25; } });
      const out = h('div', { class: 'stack' }, h('input', { type: 'text', value: c.title || '', placeholder: 'Title shown in the report', 'aria-label': 'Title shown in the report', oninput: e => { c.title = e.target.value; } }),
        h('div', { class: 'row wrap' }, check('Summary', c.show_summary !== false, v => { c.show_summary = v; }), check('Chart', c.show_chart !== false, v => { c.show_chart = v; draw(); }),
          check('Table', c.show_table !== false, v => { c.show_table = v; }), h('label', { class: 'row small' }, 'rows', rows)),
        !c.analysis ? null : h('div', { class: 'row wrap small' }, check(`🔮 Predictive output (${c.analysis.type || c.analysis.spec?.type})`, c.show_analysis !== false, v => { c.show_analysis = v; }),
          h('span', { class: 'dim' }, 'show:'), [['explain', 'Explanation'], ['chart', 'Charts'], ['table', 'Results'], ['stats', 'Statistics'], ['code', 'Code']].map(([k, l]) =>
            check(l, !(c.hide || []).includes(k), v => { c.hide = v ? (c.hide || []).filter(x => x !== k) : [...(c.hide || []), k]; }))));
      const d = data[c.id];
      if (c.show_chart !== false) {
        if (d?.status === 'ok' && d.rows.length) {
          // collapsed by default so cards stay short and easy to drag; the chart is built when first opened
          const holder = h('div', { class: 'rep-preview' });
          const det = h('details', { class: 'rep-chartset', open: !!c._open }, h('summary', {}, 'Chart settings and preview'), holder);
          const build = () => { if (holder.firstChild) return; const b = chartBlock(d, c.chart, { controls: true }); blocks.push(b); holder.append(b.el); };
          det.addEventListener('toggle', () => { c._open = det.open; if (det.open) build(); });
          if (c._open) setTimeout(build, 0);
          out.append(det);
        }
        else out.append(h('div', { class: 'small dim' }, d ? (d.message || 'No rows to chart.') : 'Save the report to load this result; you can then set up its chart here.'));
      }
      return out;
    }

    function draw() {
      cleanup();
      fill(canvas, comps.map((c, i) => {
        const fullOnly = c.type === 'divider' || c.type === 'pagebreak';
        const card = h('div', { class: 'card rep-comp', 'data-i': i, style: `grid-column: span ${fullOnly ? 6 : (c.width || 6)}` },
          h('div', { class: 'row', style: 'margin-bottom:8px;gap:4px' },
            h('span', { class: 'grip', title: 'Drag to move', 'aria-hidden': 'true', onmousedown: () => { card.draggable = true; }, onmouseup: () => { card.draggable = false; } }, '⠿'),
            h('span', { class: 'badge' + (c.type === 'result' ? ' info' : '') }, LABEL[c.type]), h('span', { class: 'spacer' }),
            fullOnly ? null : h('div', { class: 'seg', role: 'group', 'aria-label': 'Width on the page' }, WIDTHS.map(([w, l]) =>
              h('button', { class: (c.width || 6) === w ? 'on' : '', title: w === 6 ? 'Full width' : `${l} of the page width — sits beside its neighbours`, onclick: () => { c.width = w; draw(); } }, l))),
            h('button', { class: 'btn sm ghost', disabled: i === 0, title: 'Move earlier', 'aria-label': 'Move earlier', onclick: () => move(i, i - 1) }, '↑'),
            h('button', { class: 'btn sm ghost', disabled: i === comps.length - 1, title: 'Move later', 'aria-label': 'Move later', onclick: () => move(i, i + 1) }, '↓'),
            h('button', { class: 'btn sm ghost danger', title: 'Remove from report', 'aria-label': 'Remove from report', onclick: () => { comps.splice(i, 1); draw(); } }, '✕')), editor(c));
        card.addEventListener('dragstart', e => { drag = { from: i }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'move'); setTimeout(() => card.classList.add('dragging'), 0); });
        card.addEventListener('dragend', () => { card.draggable = false; card.classList.remove('dragging'); clearMarks(); drag = null; });
        const side = e => { const r = card.getBoundingClientRect(); const narrow = r.width < canvas.getBoundingClientRect().width * 0.8;
          return (narrow ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2) ? 'after' : 'before'; };
        card.addEventListener('dragover', e => { if (!drag) return; e.preventDefault(); e.stopPropagation(); clearMarks(); card.classList.add('drop-' + side(e)); });
        card.addEventListener('drop', e => { if (!drag) return; e.preventDefault(); e.stopPropagation(); const at = side(e) === 'after' ? i + 1 : i; clearMarks(); dropAt(at); });
        return card;
      }), h('div', { class: 'rep-dropzone', style: 'grid-column: span 6' }, comps.length ? 'Drop here to add at the end' : 'Drag objects from the left and drop them here — or click one to add it.'));
    }
    canvas.addEventListener('dragover', e => { if (drag) e.preventDefault(); });
    canvas.addEventListener('drop', e => { if (!drag) return; e.preventDefault(); clearMarks(); dropAt(comps.length); });

    const palette = h('div', { class: 'rep-palette' }, h('h3', {}, 'Objects'), ['result', 'heading', 'text', 'divider', 'pagebreak'].map(type => {
      // a div, not a <button>: buttons cannot be dragged in every browser
      const addNow = () => { drag = { type }; dropAt(comps.length); };
      const chip = h('div', { class: 'pal', draggable: 'true', role: 'button', tabindex: '0', title: 'Drag onto the page, or click to add at the end', onclick: addNow,
        onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addNow(); } } }, h('span', {}, ICON[type]), LABEL[type]);
      chip.addEventListener('dragstart', e => { drag = { type }; e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('text/plain', 'new'); });
      chip.addEventListener('dragend', () => { clearMarks(); });
      return chip;
    }), h('p', { class: 'small dim', style: 'margin:10px 0 0' }, 'Drag an object onto the page. Drag ⠿ to rearrange. Use Full · ⅔ · ½ · ⅓ to place objects side by side.'));

    const save = h('button', { class: 'btn primary', onclick: () => busy(save, async () => {
      def = await api('PUT', `/api/reports/${id}`, { title: title.value, description: desc.value, header_text: header.value, footer_text: footer.value, page_numbers: pages.input.checked, components: comps });
      toast('Report saved'); view();
    }) }, 'Save report');
    fill(page, h('div', { class: 'page-head' }, h('h1', {}, 'Design report'), h('span', { class: 'spacer' }), h('button', { class: 'btn', onclick: () => view(false) }, 'Cancel'), save),
      h('div', { class: 'card stack' }, h('div', { class: 'grid2' }, field('Title', title), field('Description', desc)),
        h('div', { class: 'grid2' }, field('Header', header, 'top of every PDF page'), field('Footer', footer, 'bottom of every PDF page')), pages,
        h('p', { class: 'small dim', style: 'margin:0' }, 'Live placeholders for headings, text, header and footer — filled in each time the report is opened: ', h('span', { class: 'mono' }, TOKENS),
          '. {{summary:1}} is the one-line summary of the 1st result; {{rows:2}} is the row count of the 2nd.')),
      h('div', { class: 'rep-designer' }, palette, h('div', { class: 'rep-page' }, canvas)));
    draw();
  }

  function pickResults(done) {
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
        done([...picked.values()].map(r => ({ id: uid(), type: 'result', width: 6, run_id: r.id, title: r.question, question: r.question, show_chart: true, show_table: true, show_summary: true, table_rows: 25, chart: {} })));
        close();
      } }, 'Add selected')] });
    load().catch(fail);
  }

  // ---------------------------------------------------------------- schedule / share / snapshots
  /** A searchable tick-list. items: [{key, label, sub}]; picked: Set of keys. */
  function tickList(items, picked, onChange, empty) {
    const box = h('div', { class: 'card flush ticklist' });
    const find = h('input', { type: 'search', placeholder: 'Find…', class: items.length > 8 ? '' : 'hidden' });
    const paint = () => { const q = find.value.toLowerCase(); const shown = items.filter(i => (i.label + ' ' + (i.sub || '')).toLowerCase().includes(q));
      fill(box, shown.length ? shown.map(i => h('label', { class: 'item check' }, h('input', { type: 'checkbox', checked: picked.has(i.key), onchange: e => { e.target.checked ? picked.add(i.key) : picked.delete(i.key); onChange?.(); } }),
        h('span', {}, i.label, i.sub ? h('span', { class: 'small dim' }, '  ' + i.sub) : null))) : h('div', { class: 'empty small' }, empty)); };
    find.addEventListener('input', paint); paint();
    return h('div', { class: 'stack', style: 'gap:6px' }, find, box);
  }

  async function schedule() {
    const people = await api('GET', '/api/reports/people').catch(fail);
    if (!people) return;
    const s = { ...def.schedule };
    if (!s.tz || s.tz === 'UTC') s.tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const groups = new Set(s.group_ids || []), users = new Set(s.user_ids || []);
    const enabled = check('Run this report automatically', s.enabled);
    const when = h('div', { class: 'row wrap' });
    const time = h('input', { type: 'time', value: s.time || '08:00', class: 'inline', oninput: e => { s.time = e.target.value; } });
    const drawWhen = () => fill(when, select([['daily', 'Every day'], ['weekdays', 'Every weekday (Mon–Fri)'], ['weekly', 'Every week'], ['monthly', 'Every month']], s.frequency, v => { s.frequency = v; drawWhen(); }, { class: 'inline' }),
      s.frequency === 'weekly' ? ['on', select(DAYS.map((d, i) => [i, d]), s.weekday, v => { s.weekday = Number(v); }, { class: 'inline' })] : null,
      s.frequency === 'monthly' ? ['on day', h('input', { type: 'number', min: 1, max: 28, value: s.monthday || 1, class: 'inline', style: 'width:70px', oninput: e => { s.monthday = Number(e.target.value); } })] : null,
      'at', time, h('span', { class: 'small dim' }, `(${s.tz} time)`));
    drawWhen();
    const rcpt = h('textarea', { placeholder: 'one address per line, or separated by commas', style: 'min-height:56px' }, (s.recipients || []).join('\n'));
    const extra = () => rcpt.value.split(/[\n,;]/).map(x => x.trim()).filter(Boolean);
    const total = h('b', {});
    const count = () => { const ids = new Set(users); people.groups.filter(g => groups.has(g.id)).forEach(g => { ids.add('g' + g.id); });
      const inGroups = people.groups.filter(g => groups.has(g.id)).reduce((n, g) => n + g.members, 0);
      total.textContent = `${users.size} people + ${groups.size} group(s) (${inGroups} member${inGroups === 1 ? '' : 's'}) + ${extra().length} other address(es)`; };
    rcpt.addEventListener('input', count);
    const sender = select([['', 'Default sender'], ...people.senders.map(x => [x.id, x.label + (x.simulated ? ' — simulation' : '')])], s.sender_id || '', v => { s.sender_id = v ? Number(v) : null; });
    const send = check('Also email it now to everyone selected above', false);
    const payload = () => ({ ...s, enabled: enabled.input.checked, recipients: extra(), group_ids: [...groups], user_ids: [...users] });
    count();
    modal('Schedule “' + def.title + '”', h('div', { class: 'stack' }, enabled, field('When', when),
      h('h3', { style: 'margin-bottom:0' }, 'Email the PDF to'),
      h('div', { class: 'grid2' },
        h('div', {}, h('div', { class: 'small', style: 'font-weight:600;margin-bottom:4px' }, 'User groups'), tickList(people.groups.map(g => ({ key: g.id, label: g.name, sub: `${g.members} member${g.members === 1 ? '' : 's'}` })), groups, count, 'No groups yet. An administrator creates them under Admin → User groups.')),
        h('div', {}, h('div', { class: 'small', style: 'font-weight:600;margin-bottom:4px' }, 'People'), tickList(people.users.map(u => ({ key: u.id, label: u.name + (u.me ? ' (you)' : ''), sub: u.email })), users, count, 'No users.'))),
      field('Other email addresses', rcpt, 'people without an account'),
      h('div', { class: 'small' }, 'Recipients: ', total),
      field('Send from', sender),
      people.senders.length ? null : h('div', { class: 'banner warn' }, 'No email sender is set up yet, so scheduled runs will be saved in the app but not emailed. An administrator can add one under Admin → Email senders.'),
      h('p', { class: 'small dim', style: 'margin:0' }, 'Each run refreshes the report and saves a dated PDF under “Saved copies” (the latest 30 are kept). Everyone who has an account receives the report with their own data access and data filters; other addresses receive it as you see it — only add people who are allowed to see that.'),
      def.next_run_at ? h('p', { class: 'small', style: 'margin:0' }, 'Next run: ', h('b', {}, fmtTime(def.next_run_at))) : null,
      h('hr', { class: 'rep-hr', style: 'margin:4px 0' }), h('div', { class: 'row wrap' }, h('button', { class: 'btn', onclick: e => busy(e.target, async () => {
        await api('PUT', `/api/reports/${id}/schedule`, payload());
        const r = await api('POST', `/api/reports/${id}/snapshots`, { send: send.input.checked });
        toast(r.status === 'ok' ? ('Saved copy created' + (r.emailed_to.length ? ` and emailed to ${r.emailed_to.length} recipient(s)` : '') + (r.note ? ` — ${r.note}` : '')) : `Failed: ${r.note}`, r.status !== 'ok');
      }) }, '▶ Run now'), send)), {
      wide: true, actions: close => [h('button', { class: 'btn', onclick: close }, 'Close'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
        const r = await api('PUT', `/api/reports/${id}/schedule`, payload());
        def.schedule = r.schedule; def.next_run_at = r.next_run_at; def.scheduled = r.schedule.enabled;
        close(); toast(r.schedule.enabled ? `Scheduled for ${r.recipient_count} recipient(s). Next run ${fmtTime(r.next_run_at)}.` : 'Schedule turned off.'); view(false);
      }) }, 'Save schedule')] });
  }

  async function share() {
    const people = await api('GET', '/api/reports/people').catch(fail);
    if (!people) return;
    const key = s => s.scope === 'role' ? 'role:' + s.role : s.scope === 'group' ? 'group:' + s.group_id : 'user:' + s.user_id;
    const cur = new Map((def.shares || []).map(s => [key(s), s.can_edit ? 'edit' : 'view']));
    const OPT = [['', 'No access'], ['view', 'Can view'], ['edit', 'Can view and edit']];
    const row = (k, label, sub) => h('div', { class: 'item row' }, h('div', { style: 'flex:1' }, h('b', {}, label), sub ? h('div', { class: 'small dim' }, sub) : null),
      select(OPT, cur.get(k) || '', v => v ? cur.set(k, v) : cur.delete(k), { class: 'inline' }));
    const others = people.users.filter(u => !u.me && u.role !== 'admin');
    modal('Share “' + def.title + '”', h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, 'Reports are private until shared. People you share with see the report refreshed with their own data access: results from data models they cannot use are hidden, and their data filters apply.'),
      h('h3', {}, 'User groups'), people.groups.length ? h('div', { class: 'card flush' }, people.groups.map(g => row('group:' + g.id, g.name, `${g.members} member${g.members === 1 ? '' : 's'}${g.description ? ' · ' + g.description : ''}`)))
        : h('div', { class: 'small dim' }, 'No groups yet. An administrator creates them under Admin → User groups.'),
      h('h3', {}, 'By role'), h('div', { class: 'card flush' }, row('role:analyst', 'All analysts'), row('role:steward', 'All data stewards')),
      h('h3', {}, 'Individual people'), others.length ? h('div', { class: 'card flush', style: 'max-height:34vh;overflow:auto' }, others.map(u => row('user:' + u.id, u.name, `${u.email} · ${u.role}`))) : h('div', { class: 'small dim' }, 'No other users yet.'),
      h('p', { class: 'small dim' }, 'Administrators can always open every report. To email the report to these people, use Schedule.')), {
      wide: true, actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
        const shares = [...cur].map(([k, v]) => { const [scope, val] = k.split(':'); const can_edit = v === 'edit';
          return scope === 'role' ? { scope, role: val, can_edit } : scope === 'group' ? { scope, group_id: Number(val), can_edit } : { scope, user_id: Number(val), can_edit }; });
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
