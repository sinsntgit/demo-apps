// Training data per data model: schema, documentation, question/SQL pairs, documents, review queue.
import { h, fill, prettySQL, api, busy, fail, toast, modal, field, select, tabs, confirmDialog, highlightSQL, fmtTime, download } from './core.js';
import { runCard } from './results.js';

const SOURCE = { manual: 'added manually', upload: 'uploaded', import: 'imported', confirmed: 'confirmed by a user', correction: 'user correction' };

export async function trainingView(root, arg) {
  const conns = await api('GET', '/api/connections');
  if (!conns.length) return fill(root, h('div', { class: 'page' }, h('div', { class: 'empty' }, 'Connect a data model first (Data models).')));
  let connId = Number(arg) || conns[0].id;
  if (!conns.some(c => c.id === connId)) connId = conns[0].id;
  const body = h('div', {});
  const page = h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h1', {}, 'Training'),
    select(conns.map(c => [c.id, c.name]), connId, v => { connId = Number(v); history.replaceState(null, '', `#/training/${v}`); draw(); }, { class: 'inline', style: 'min-width:240px' }),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn', onclick: async () => download(`training-${connId}.json`, JSON.stringify(await api('GET', `/api/training/${connId}/export`), null, 2), 'application/json') }, '⬇ Export')),
  h('p', { class: 'muted', style: 'max-width:760px' }, 'Each data model learns separately. The model is given the schema plus the most relevant notes and verified examples below when it writes SQL — the more of your business language you capture here, the more accurate it gets.'), body);
  fill(root, page);

  async function draw(tab) {
    const [data, issues] = await Promise.all([api('GET', `/api/training/${connId}`).catch(e => { fail(e); return { items: [], counts: {}, pending: 0, issues_open: 0 }; }),
      api('GET', `/api/training/${connId}/issues`).catch(() => [])]);
    const waiting = (data.pending || 0) + issues.length;
    const of = kind => data.items.filter(i => i.kind === kind && i.status !== 'pending');
    const n = k => data.counts[k] || 0;
    const t = tabs([
      ['pairs', `Question → SQL (${n('sql_pair')})`, () => pairsTab(of('sql_pair'))],
      ['docs', `Documentation (${n('documentation')})`, () => docsTab(of('documentation'), 'documentation')],
      ['files', `Documents (${new Set(of('document').map(d => d.document_name)).size})`, () => filesTab(of('document'))],
      ['ddl', `Extra DDL (${n('ddl')})`, () => docsTab(of('ddl'), 'ddl')],
      ['schema', 'Schema', el => { schemaTab(el); }],
      ['review', `Review queue${waiting ? ` (${waiting})` : ''}`, () => reviewTab(data.items.filter(i => i.status === 'pending'), issues)],
    ], tab || (waiting ? 'review' : 'pairs'));
    fill(body, t);
  }

  function editItem(kind, item, tab) {
    const isPair = kind === 'sql_pair';
    const title = h('input', { type: 'text', value: item?.title || '', placeholder: kind === 'ddl' ? 'e.g. View: monthly_sales' : 'e.g. How we define an active customer' });
    const content = h('textarea', { style: 'min-height:180px', class: kind === 'ddl' ? 'mono' : '' }, item?.content || '');
    const question = h('input', { type: 'text', value: item?.question || '', placeholder: 'e.g. What was revenue last quarter by region?' });
    const sql = h('textarea', { class: 'sql-edit', spellcheck: 'false' }, item?.sql || '');
    modal(`${item ? 'Edit' : 'Add'} ${isPair ? 'question → SQL example' : kind === 'ddl' ? 'DDL' : 'documentation'}`,
      h('div', { class: 'stack' }, isPair ? [field('Question', question), field('SQL', sql, 'a verified, read-only query that answers it')]
        : [field('Title', title), field(kind === 'ddl' ? 'DDL' : 'Text', content, kind === 'ddl' ? 'CREATE TABLE / VIEW statements not picked up by schema sync' : 'business rules, metric definitions, jargon, join logic…')]),
      { wide: true, maximizable: true, actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
          const payload = { kind, title: title.value, content: content.value, question: question.value, sql: sql.value };
          await (item ? api('PUT', `/api/training/item/${item.id}`, payload) : api('POST', `/api/training/${connId}`, payload));
          close(); toast('Saved'); draw(tab);
        }) }, 'Save')] });
  }
  const del = (item, tab) => async () => {
    if (!await confirmDialog('Delete this training item?', 'The model will stop using it immediately.', 'Delete')) return;
    await api('DELETE', `/api/training/item/${item.id}`).catch(fail); draw(tab);
  };
  const expand = (title, text, code) => modal(title, code ? h('pre', { class: 'sql', style: 'max-height:none', html: highlightSQL(prettySQL(text)) }) : h('div', { style: 'white-space:pre-wrap' }, text), { wide: true, maximizable: true });
  const actions = (item, tab) => h('div', { class: 'row' }, h('button', { class: 'btn sm ghost', title: 'Open in a large window', 'aria-label': 'Open in a large window', onclick: () => expand(item.question || item.title || 'Training item', item.kind === 'sql_pair' ? item.sql : item.content, item.kind === 'sql_pair' || item.kind === 'ddl') }, '⤢'),
    h('button', { class: 'btn sm', onclick: () => editItem(item.kind, item, tab) }, 'Edit'), h('button', { class: 'btn sm danger', onclick: del(item, tab) }, 'Delete'));

  function pairsTab(items) {
    const file = h('input', { type: 'file', accept: '.csv,.json', class: 'hidden', onchange: async e => {
      const fd = new FormData(); fd.append('upload', e.target.files[0]);
      try { const r = await api('POST', `/api/training/${connId}/import-pairs`, fd); toast(`Imported ${r.added} example(s)` + (r.errors.length ? `; ${r.errors.length} skipped: ${r.errors[0]}` : ''), r.errors.length > 0 && !r.added); draw('pairs'); } catch (ex) { fail(ex); }
    } });
    return h('div', { class: 'stack' }, h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => editItem('sql_pair', null, 'pairs') }, '＋ Add example'),
      h('button', { class: 'btn', onclick: () => file.click(), title: 'CSV with columns question, sql — or JSON [{question, sql}]' }, 'Import CSV / JSON'), file,
      h('span', { class: 'small dim' }, 'Verified examples are the strongest training signal. Users add to these by confirming or correcting answers in chat.')),
    items.length ? h('div', { class: 'card flush' }, items.map(i => h('div', { class: 'item' },
      h('div', { class: 'row top' }, h('div', { style: 'flex:1;min-width:0' }, h('b', {}, i.question), h('div', { class: 'small dim' }, `${SOURCE[i.source] || i.source} · ${fmtTime(i.updated_at)}`)), actions(i, 'pairs')),
      h('pre', { class: 'sql', style: 'margin-top:8px', html: highlightSQL(prettySQL(i.sql)) })))) : h('div', { class: 'empty' }, 'No examples yet.'));
  }

  function docsTab(items, kind) {
    return h('div', { class: 'stack' }, h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => editItem(kind, null, kind === 'ddl' ? 'ddl' : 'docs') }, kind === 'ddl' ? '＋ Add DDL' : '＋ Add note')),
      items.length ? h('div', { class: 'card flush' }, items.map(i => h('div', { class: 'item' },
        h('div', { class: 'row top' }, h('div', { style: 'flex:1' }, h('b', {}, i.title || '(untitled)'), h('div', { class: 'small dim' }, fmtTime(i.updated_at))), actions(i, kind === 'ddl' ? 'ddl' : 'docs')),
        h('div', { class: kind === 'ddl' ? 'mono' : '', style: 'white-space:pre-wrap;margin-top:6px' }, i.content))))
        : h('div', { class: 'empty' }, kind === 'ddl' ? 'Schema sync covers tables and views automatically. Add DDL here only for objects it cannot see.' : 'No documentation yet. Add metric definitions, business rules and vocabulary.'));
  }

  function filesTab(chunks) {
    const byDoc = new Map();
    chunks.forEach(c => byDoc.set(c.document_name, [...(byDoc.get(c.document_name) || []), c]));
    const file = h('input', { type: 'file', accept: '.pdf,.docx,.txt,.md,.sql,.csv,.json,.yaml,.yml,.rst,.html,.xlsx', class: 'hidden', onchange: async e => {
      const fd = new FormData(); fd.append('upload', e.target.files[0]);
      toast('Reading document…');
      try { const r = await api('POST', `/api/training/${connId}/upload`, fd); toast(`${r.document}: split into ${r.chunks} passage(s)`); draw('files'); } catch (ex) { fail(ex); }
    } });
    return h('div', { class: 'stack' }, h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => file.click() }, '⬆ Upload document'), file,
      h('span', { class: 'small dim' }, 'PDF, Word, Excel data dictionaries, Markdown, text, SQL. Documents are split into passages; the relevant ones are retrieved per question.')),
    byDoc.size ? h('div', { class: 'card flush' }, [...byDoc].map(([name, parts]) => h('details', { class: 'schema-table' },
      h('summary', {}, name, h('span', { class: 'dim small' }, `  ${parts.length} passage(s)  `),
        h('button', { class: 'btn sm ghost', style: 'float:right;margin-left:6px', title: 'Open in a large window', onclick: e => { e.preventDefault(); expand(name, parts.map(p => p.content).join('\n\n— — —\n\n')); } }, '⤢'),
        h('button', { class: 'btn sm danger', style: 'float:right', onclick: async e => { e.preventDefault();
          if (!await confirmDialog('Remove document?', `${name} will no longer be used for training.`, 'Remove')) return;
          await api('DELETE', `/api/training/${connId}/document?name=${encodeURIComponent(name)}`).catch(fail); draw('files'); } }, 'Remove')),
      h('div', { class: 'cols small', style: 'white-space:pre-wrap' }, parts.map(p => p.content).join('\n\n— — —\n\n')))))
      : h('div', { class: 'empty' }, 'No documents uploaded.'));
  }

  async function schemaTab(el) {
    el.append(h('span', { class: 'spinner' }));
    const s = await api('GET', `/api/connections/${connId}/schema`).catch(e => { fail(e); return { tables: [] }; });
    const syncBtn = h('button', { class: 'btn', onclick: () => busy(syncBtn, async () => { const r = await api('POST', `/api/connections/${connId}/sync`); toast(`Schema synced: ${r.tables} tables, ${r.columns} columns`); draw('schema'); }) }, '⟳ Sync schema from source');
    fill(el, h('div', { class: 'stack' }, h('div', { class: 'row' }, syncBtn, h('span', { class: 'small dim' }, s.synced_at ? `Last synced ${fmtTime(s.synced_at)} · ${s.tables.length} tables. Only names and types are read — never row data.` : 'Not synced yet.')),
      s.tables.length ? h('div', { class: 'card flush' }, s.tables.map(t => h('details', { class: 'schema-table' },
        h('summary', {}, t.fqn, h('span', { class: 'dim small' }, `  ${t.type} · ${t.columns.length} columns${t.comment ? ' · ' + t.comment : ''}`),
          h('button', { class: 'btn sm ghost', style: 'float:right', title: 'Open in a large window', onclick: e => { e.preventDefault(); expand(t.fqn, t.ddl, true); } }, '⤢')),
        h('div', { class: 'cols' }, h('pre', { class: 'sql', html: highlightSQL(t.ddl) })))))
        : h('div', { class: 'empty' }, 'No tables found. Press “Sync schema”.')));
  }

  // ---- a reported problem -> training -----------------------------------------------------------
  const resolve = async (issue, payload, close) => {
    await api('POST', `/api/training/issues/${issue.run_id}/resolve`, payload);
    close(); toast(payload.action === 'dismiss' ? 'Dismissed — the user sees your note' : 'Saved to training — the user sees that it was corrected'); draw('review');
  };
  const commentField = (issue, value = '') => { const c = h('input', { type: 'text', value, placeholder: 'Optional — shown under the answer' }); return [c, field(`Message to ${issue.user}`, c)]; };

  function fixSql(issue) {
    const question = h('input', { type: 'text', value: issue.question });
    const sql = h('textarea', { class: 'sql-edit', spellcheck: 'false', style: 'min-height:200px' }, prettySQL(issue.sql));
    const out = h('div', {});
    const [comment, cf] = commentField(issue);
    const test = h('button', { class: 'btn', onclick: () => busy(test, async () => {
      try {
        const r = await api('POST', `/api/training/${connId}/test-sql`, { sql: sql.value });
        fill(out, h('div', { class: 'small dim', style: 'margin-bottom:4px' }, `${r.row_count} row(s)${r.row_count > 20 ? ' — first 20 shown' : ''}`),
          h('div', { class: 'tbl-wrap', style: 'max-height:240px' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, r.columns.map(c => h('th', {}, c.name)))),
            h('tbody', {}, r.rows.map(row => h('tr', {}, row.map(v => h('td', {}, v == null ? '' : String(v)))))))));
      } catch (e) { fill(out, h('div', { class: 'banner bad' }, e.message)); }
    }) }, '▶ Test');
    modal('Fix the SQL', h('div', { class: 'stack' },
      h('div', { class: 'banner warn' }, h('b', {}, issue.issue_label + ': '), issue.reason),
      field('Question', question, 'saved as a verified example with the corrected SQL'), field('Corrected SQL', sql), h('div', { class: 'row' }, test, h('span', { class: 'small dim' }, 'Run it before saving: read-only, with your own data access.')), out, cf),
    { wide: true, maximizable: true, actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: e => busy(e.target, () => resolve(issue, { action: 'example', question: question.value, sql: sql.value, comment: comment.value }, close)) }, 'Save as verified example')] });
  }

  function addRule(issue) {
    const title = h('input', { type: 'text', value: '', placeholder: 'e.g. Returns are not revenue' });
    const content = h('textarea', { style: 'min-height:140px', placeholder: 'The business rule the model got wrong, written so it applies to similar questions — e.g. “Revenue excludes returned orders (status = \'returned\').”' });
    const [comment, cf] = commentField(issue);
    modal('Add a business rule', h('div', { class: 'stack' },
      h('div', { class: 'banner warn' }, h('b', {}, issue.issue_label + ': '), issue.reason),
      h('p', { class: 'small muted', style: 'margin:0' }, 'Use this when the mistake comes from a definition or rule the model did not know. It becomes a documentation note and is used for every similar question.'),
      field('Title', title), field('Rule', content), cf),
    { wide: true, actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: e => busy(e.target, () => resolve(issue, { action: 'note', title: title.value, content: content.value, comment: comment.value }, close)) }, 'Add to training')] });
  }

  function dismiss(issue) {
    const [comment, cf] = commentField(issue, 'The answer is correct: ');
    modal('Dismiss this report', h('div', { class: 'stack' }, h('p', { class: 'small muted', style: 'margin:0' }, 'Nothing is added to training. Tell the user why the answer is right.'), cf),
      { actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn danger', onclick: e => busy(e.target, () => resolve(issue, { action: 'dismiss', comment: comment.value }, close)) }, 'Dismiss')] });
  }

  async function viewAnswer(issue) {
    const r = await api('GET', `/api/analytics/queries/${issue.run_id}`).catch(fail);
    if (r) modal(issue.question, runCard(r, { readonly: true }), { wide: true, maximizable: true });
  }

  function reviewTab(items, issues = []) {
    const decide = (i, d) => e => busy(e.target, async () => { await api('POST', `/api/training/item/${i.id}/${d}`); toast(d === 'approve' ? 'Approved — now used for training' : 'Rejected'); draw('review'); });
    if (!items.length && !issues.length) return h('div', { class: 'empty' }, 'Nothing waiting for review.');
    return h('div', { class: 'stack' },
      issues.length ? [h('h2', {}, `Reported problems (${issues.length})`),
        h('p', { class: 'muted', style: 'margin-top:0' }, 'Answers users said are incorrect, with what is wrong and why. Fix the SQL (it becomes a verified example), add the business rule the model missed, or dismiss the report — the user sees the outcome under their answer.'),
        h('div', { class: 'card flush' }, issues.map(i => h('div', { class: 'item issue' },
          h('div', { class: 'row top' }, h('div', { style: 'flex:1;min-width:0' }, h('b', {}, i.question), h('div', { class: 'small dim' }, `reported by ${i.user} · ${fmtTime(i.created_at)} · ${i.row_count} row(s)`)),
            h('button', { class: 'btn sm primary', onclick: () => fixSql(i) }, '✎ Fix the SQL'), h('button', { class: 'btn sm', onclick: () => addRule(i) }, '📝 Add a business rule'),
            h('button', { class: 'btn sm ghost', onclick: () => viewAnswer(i) }, 'View answer'), h('button', { class: 'btn sm danger', onclick: () => dismiss(i) }, 'Dismiss')),
          h('div', { class: 'banner warn', style: 'margin-top:8px' }, h('b', {}, i.issue_label + ': '), i.reason),
          h('pre', { class: 'sql', style: 'margin-top:8px', html: highlightSQL(prettySQL(i.sql)) }))))] : null,
      items.length ? [h('h2', {}, `Confirmed answers waiting for approval (${items.length})`),
        h('p', { class: 'muted', style: 'margin-top:0' }, 'Answers that users confirmed or corrected. Approve the ones that are right; they become verified examples.'),
        h('div', { class: 'card flush' }, items.map(i => h('div', { class: 'item' },
          h('div', { class: 'row top' }, h('div', { style: 'flex:1' }, h('b', {}, i.question), h('div', { class: 'small dim' }, `${SOURCE[i.source] || i.source} · ${fmtTime(i.updated_at)}`)),
            h('button', { class: 'btn sm good', onclick: decide(i, 'approve') }, '✓ Approve'), h('button', { class: 'btn sm', onclick: () => editItem('sql_pair', i, 'review') }, 'Edit'), h('button', { class: 'btn sm danger', onclick: decide(i, 'reject') }, '✗ Reject')),
          h('pre', { class: 'sql', style: 'margin-top:8px', html: highlightSQL(prettySQL(i.sql)) }))))] : null);
  }
  await draw();
}
