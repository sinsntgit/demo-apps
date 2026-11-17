// The data-source library: databases and uploaded datasets / documents, set up once and used by many ontologies.
import { h, fill, api, busy, fail, toast, modal, field, check, select, confirmDialog, fmtTime, ago, state } from './core.js';
import { filePicker, dbForm, failedList, fmtSize, DB_TYPES } from './sources.js';

const ROLE = { identifier: ['info', 'identifier'], reference: ['info', 'reference'], code: ['good', 'code list'], flag: ['good', 'yes / no'],
  date: ['', 'date'], measure: ['', 'measure'], text: ['', 'free text'], attribute: ['', 'attribute'] };

export async function dataSourcesView(root, arg) {
  if (arg) return detailView(root, Number(arg));
  const data = await api('GET', '/api/datasources');
  const card = d => h('a', { class: 'ocard', href: '#/datasources/' + d.id },
    h('div', { class: 'row top' }, h('h3', { style: 'flex:1' }, (d.kind === 'database' ? '🗄 ' : '📁 ') + d.name),
      h('span', { class: 'badge ' + (d.status === 'ready' ? 'good' : d.status === 'error' ? 'bad' : '') }, d.status === 'ready' ? 'Ready' : d.status === 'error' ? 'Needs attention' : 'Empty')),
    h('div', { class: 'small muted' }, d.kind === 'database' ? d.db_label : 'Uploaded datasets and documents'),
    d.description ? h('div', { class: 'small muted', style: 'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden' }, d.description) : null,
    h('div', { class: 'row wrap' }, h('span', { class: 'badge' }, d.level === 'manage' ? 'Owner' : 'Can use'), d.visibility === 'shared' ? h('span', { class: 'badge info' }, 'Shared with everyone') : null,
      d.sample_values ? null : h('span', { class: 'badge' }, 'statistics only')),
    h('div', { class: 'meta' }, h('span', {}, h('b', {}, d.tables), ' tables'), h('span', {}, h('b', {}, d.documents), ' documents'), h('span', {}, h('b', {}, d.used_by), ' ontologies'),
      h('span', { style: 'margin-left:auto' }, d.refreshed_at ? ago(d.refreshed_at) : '')));
  fill(root, h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', { style: 'flex:1;min-width:260px' }, h('h1', {}, 'Data sources'),
      h('div', { class: 'muted', style: 'margin-top:4px' }, 'Databases, datasets and documents that ontologies are built from. Set one up once — its tables are profiled and its documents read — then build as many ontologies from it as you need.')),
      data.can_create ? h('button', { class: 'btn primary', onclick: () => createForm(data.db_types) }, '＋ New data source') : null),
    data.items.length ? h('div', { class: 'cards' }, data.items.map(card)) : h('div', { class: 'card empty' }, h('p', {}, 'No data sources yet.'),
      data.can_create ? h('p', { class: 'small' }, 'Press ', h('b', {}, '＋ New data source'), ' to connect a database or upload datasets and documents.') : null)));
}

function createForm() {
  let kind = 'files';
  const name = h('input', { type: 'text', maxlength: 200, placeholder: 'e.g. Loan origination system' });
  const desc = h('textarea', { rows: 2, placeholder: 'What this data is about, in a sentence or two. Optional.' });
  const docs = h('textarea', { rows: 5, placeholder: 'Optional. Explain the data for the AI: what the system is for, what the main tables hold, what codes and statuses mean, business rules, abbreviations. You can paste a data dictionary. Documentation files can be uploaded on the next screen.' });
  const db = dbForm({ dataSource: true });
  const samples = check('Share sample values with the AI model', true, null, 'Besides statistics, a few example values per column and the full list of values of code columns (statuses, types). This gives a better ontology. Untick for statistics only.');
  const body = h('div', {});
  const seg = h('div', { class: 'seg' });
  const draw = () => {
    fill(seg, [['files', '📁 Upload datasets and documents'], ['database', '🗄 Connect a database']].map(([k, l]) => h('button', { class: kind === k ? 'on' : '', style: 'padding:6px 14px', onclick: () => { kind = k; draw(); } }, l)));
    fill(body, kind === 'database' ? db
      : h('p', { class: 'small muted' }, 'You add files on the next screen: datasets (CSV, Excel, SQLite, JSON record lists) are profiled; documents (PDF, Word, PowerPoint, Markdown, text, JSON, XML, HTML) are read. You can upload whole folders.'));
  };
  draw();
  modal('New data source', h('div', { class: 'stack' }, seg, field('Name', name), field('Description', desc), body, field('Documentation', docs, 'helps the AI understand the data before it builds'), samples), {
    wide: true, actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
      const payload = { name: name.value, description: desc.value, documentation: docs.value, kind, sample_values: samples.input.checked };
      if (kind === 'database') {
        const v = db.value(); if (!v || !v.host || !v.database) throw new Error('Enter at least the host and the database name.');
        Object.assign(payload, v);
        e.target.textContent = 'Reading the database…';
      }
      const r = await api('POST', '/api/datasources', payload);
      sessionStorage.setItem('onto-ds-tab', kind === 'files' ? 'files' : 'docs');      // next: add the files, or the documentation
      close(); location.hash = '#/datasources/' + r.id;
    }).finally(() => { e.target.textContent = 'Create'; }) }, 'Create')] });
}

async function detailView(root, id) {
  const d = await api('GET', '/api/datasources/' + id);
  const manage = d.level === 'manage';
  const reload = () => detailView(root, id);
  const tables = d.items.filter(i => i.kind === 'table'), docs = d.items.filter(i => i.kind === 'document');
  const status = h('div', {});
  let tab = sessionStorage.getItem('onto-ds-tab') || (tables.length ? 'tables' : 'docs');
  const body = h('div', {});

  const upload = async files => {
    files = files.filter(f => !f.name.startsWith('.') && !f.name.startsWith('~$'));
    const out = { added: [], failed: [] };
    for (let i = 0; i < files.length; i += 8) {
      const part = files.slice(i, i + 8);
      fill(status, h('div', { class: 'banner info' }, h('span', { class: 'spinner' }), ` Reading ${Math.min(i + part.length, files.length)} of ${files.length}… (datasets are profiled, documents read)`));
      const fd = new FormData();
      part.forEach(f => fd.append('files', f, f.name));
      fd.append('paths', JSON.stringify(part.map(f => f._path || f.name)));
      try { const r = await api('POST', `/api/datasources/${id}/files`, fd); out.added.push(...r.added); out.failed.push(...r.failed); }
      catch (e) { part.forEach(f => out.failed.push({ name: f._path || f.name, reason: e.message })); }
    }
    fill(status);
    if (out.failed.length) modal('Some files were not added', failedList(out.failed)); else toast(`${out.added.length} file(s) added.`);
    reload();
  };

  const tableRow = i => {
    const p = i.profile, include = h('input', { type: 'checkbox', checked: i.include, disabled: !manage, style: 'width:auto', title: 'Use this table when an ontology is built',
      onchange: e => api('PUT', `/api/datasources/${id}/items/${i.id}`, { include: e.target.checked }).then(() => toast(e.target.checked ? 'Included' : 'Left out')).catch(fail) });
    const refs = p.columns.filter(c => c.ref);
    return h('tr', { class: 'click', onclick: e => { if (e.target.tagName !== 'INPUT') tableDialog(i); } }, h('td', { style: 'width:30px' }, include),
      h('td', {}, h('b', {}, i.name), i.description ? h('div', { class: 'small muted' }, i.ai ? [h('span', { class: 'badge warn', title: 'Drafted by AI — check it; editing it makes it yours' }, 'AI draft'), ' '] : null, i.description) : null, i.file_name && i.file_name !== i.name ? h('div', { class: 'small dim' }, 'from ' + i.file_name) : null,
        i.kept === false ? h('div', { class: 'small', style: 'color:var(--warn)' }, d.keep_files === false ? 'Not kept on this server (Settings): its rows cannot be loaded into knowledge graphs' : 'Uploaded before version 1.7: upload this file again (the same folder) to use its rows in knowledge graphs') : null),
      h('td', { class: 'num' }, p.row_count == null ? '—' : p.row_count.toLocaleString()), h('td', { class: 'num' }, p.columns.length),
      h('td', { class: 'small' }, refs.length ? refs.map(c => `${c.name} → ${c.ref}${c.ref_declared === false ? ' (inferred)' : ''}`).join('; ') : h('span', { class: 'dim' }, '—')),
      h('td', { class: 'small' }, p.columns.filter(c => c.role === 'code').map(c => c.name).join(', ') || h('span', { class: 'dim' }, '—')));
  };

  function tableDialog(i) {
    const p = i.profile, edits = {};
    const desc = h('textarea', { rows: 2, disabled: !manage, placeholder: 'What this table holds, in business terms' }, i.description || '');
    const descNote = i.ai && i.description ? h('div', { class: 'small', style: 'margin-top:-6px' }, h('span', { class: 'badge warn', title: 'Drafted by AI — check it; editing it makes it yours' }, 'AI draft'), ' Check the drafts; saving confirms them as yours.') : null;
    const rows = p.columns.map(c => {
      const [rc, rl] = ROLE[c.role] || ['', c.role];
      const cd = h('input', { type: 'text', value: c.description || '', disabled: !manage, placeholder: c.db_comment || 'business meaning…', style: 'min-width:180px', oninput: e => { edits[c.name] = e.target.value; } });
      const cdBox = h('div', {}, cd, c.ai && c.description ? h('div', { style: 'margin-top:3px' }, h('span', { class: 'badge warn', title: 'Drafted by AI — check it; editing it makes it yours' }, 'AI draft')) : null);
      const vals = c.top.length ? c.top.map(([v, n]) => `${v} (${n})`).join(', ') + (c.distinct > c.top.length ? ' …' : '') : c.examples.join(' | ');
      return h('tr', {}, h('td', {}, h('b', {}, c.name), c.pk ? h('span', { class: 'badge info', style: 'margin-left:4px' }, 'key') : null, h('div', { class: 'small dim' }, c.declared || c.type)),
        h('td', {}, h('span', { class: 'badge ' + rc }, rl), c.personal ? h('span', { class: 'badge warn', style: 'margin-left:4px' }, 'personal') : null,
          c.ref ? h('div', { class: 'small' }, '→ ' + c.ref + (c.ref_declared === false ? ' (inferred)' : '')) : null),
        h('td', { class: 'small num' }, c.nulls_pct ? c.nulls_pct + '%' : '0'), h('td', { class: 'small num' }, c.distinct.toLocaleString() + (c.unique ? ' · unique' : '')),
        h('td', { class: 'small' }, c.min != null ? `${c.min} … ${c.max}` : ''),
        h('td', { class: 'small', style: 'max-width:300px;overflow-wrap:anywhere' }, vals || (c.personal ? h('span', { class: 'dim' }, 'withheld (personal data)') : '')), h('td', {}, cdBox));
    });
    modal(`Table ${i.name}`, h('div', { class: 'stack' },
      h('div', { class: 'small muted' }, `${p.row_count == null ? '?' : p.row_count.toLocaleString()} rows · profiled from ${p.sampled_rows.toLocaleString()} rows · ${p.columns.length} columns`),
      field('Description', desc, 'used by the AI as the authoritative meaning'), descNote,
      h('div', { class: 'tbl-wrap', style: 'max-height:56vh' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Column', 'Role', 'Empty', 'Distinct', 'Range', 'Values', 'Business description'].map(x => h('th', {}, x)))), h('tbody', {}, rows))),
      h('p', { class: 'small dim' }, 'Statistics are computed on this server. Values are shown to the AI model only if the data source allows sample values; columns marked personal never show values unless the owner allows it in Settings.')), {
      wide: true, maximizable: true, actions: close => manage ? [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
        await api('PUT', `/api/datasources/${id}/items/${i.id}`, { description: desc.value, columns: edits }); close(); toast('Saved'); reload();
      }) }, 'Save descriptions')] : [h('button', { class: 'btn', onclick: close }, 'Close')] });
  }

  const tabs = {
    tables: () => tables.length ? h('div', { class: 'stack' },
      h('p', { class: 'small muted', style: 'margin:0' }, 'Click a table to see its profile and to describe it and its columns. Untick a table to leave it out of ontologies (logs, staging and audit tables are left out automatically).'),
      h('div', { class: 'tbl-wrap', style: 'max-height:none' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Use', 'Table', 'Rows', 'Columns', 'References', 'Code lists'].map(x => h('th', {}, x)))), h('tbody', {}, tables.map(tableRow)))))
      : h('div', { class: 'card empty' }, d.kind === 'database' ? 'No tables were read.' : 'No datasets yet. Add CSV, Excel, SQLite or JSON files under Add files.'),
    docList: () => docs.length ? h('div', { class: 'tbl-wrap', style: 'max-height:none' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['Use', 'Document', 'What was read', 'Updated', ''].map(x => h('th', {}, x)))),
      h('tbody', {}, docs.map(i => h('tr', {}, h('td', { style: 'width:30px' }, h('input', { type: 'checkbox', checked: i.include, disabled: !manage, style: 'width:auto',
          onchange: e => api('PUT', `/api/datasources/${id}/items/${i.id}`, { include: e.target.checked }).catch(fail) })),
        h('td', {}, h('b', {}, '📄 ' + i.name)), h('td', { class: 'small' }, `${i.chars.toLocaleString()} characters` + (i.note ? ' · ' + i.note : '')), h('td', { class: 'small nowrap' }, fmtTime(i.updated_at)),
        h('td', { class: 'right nowrap' }, h('button', { class: 'btn sm', onclick: async () => { const t = await api('GET', `/api/datasources/${id}/items/${i.id}`).catch(fail); if (t) modal(i.name, h('pre', { class: 'code', style: 'max-height:60vh' }, t.text + (t.truncated ? '\n…' : '')), { wide: true }); } }, 'View text'), ' ',
          manage ? h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('Remove this document?', i.name, 'Remove')) { await api('DELETE', `/api/datasources/${id}/items/${i.id}`).catch(fail); reload(); } } }, 'Remove') : null))))))
      : h('div', { class: 'card empty' }, 'No documents.'),
    docs: () => {
      const notes = h('textarea', { rows: 10, disabled: !manage, placeholder: 'What the data means, in your words: what the system is for, what the main tables hold, what codes and statuses mean, business rules, known quirks, abbreviations. You can paste a data dictionary or glossary here.' }, d.documentation || '');
      const save = manage ? h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
        await api('PUT', `/api/datasources/${id}/documentation`, { documentation: notes.value });
        toast('Documentation saved'); reload(); }) }, 'Save documentation') : null;
      return h('div', { class: 'stack' },
        h('p', { class: 'muted', style: 'margin:0' }, 'Help the AI understand this data before it builds an ontology. Everything here is given to it with the table profiles, as the authoritative explanation. Then use ', h('b', {}, '✨ Describe with AI'), ' to see what it understood: it drafts a description of every table and column for you to check.'),
        h('div', { class: 'card stack' }, h('h3', { style: 'margin:0' }, 'Notes'), notes, save ? h('div', {}, save) : null),
        h('div', { class: 'card stack' }, h('h3', { style: 'margin:0' }, `Documentation files (${docs.length})`),
          manage ? [filePicker(upload), h('p', { class: 'small dim', style: 'margin:0' }, 'Data dictionaries, system manuals, process descriptions, report specifications, glossaries — PDF, Word, PowerPoint, Markdown, text, HTML, JSON, XML. Their text is read and kept; the files are not.' +
            (d.kind === 'files' ? ' Datasets dropped here are added as tables, as under Add files.' : ''))] : null,
          tabs.docList()));
    },
    files: () => h('div', { class: 'stack' }, filePicker(upload),
      h('p', { class: 'small muted' }, h('b', {}, 'Datasets'), ' — CSV, TSV, Excel (each sheet), SQLite files and JSON lists of records — are profiled: rows, columns, types, keys, code lists, likely joins. A copy of the file is kept on this server so that knowledge graphs can be built from its rows; it is deleted with the file or the data source. ',
        h('b', {}, 'Documents'), ' — PDF, Word, PowerPoint, Markdown, text, JSON, XML, HTML, SQL scripts — are read and their text kept. A file with the same name as one already here replaces it, keeping the descriptions you wrote.'),
      tables.filter(t => t.file_name).length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Dataset file', 'Tables', 'Size', ''].map(x => h('th', {}, x)))),
        h('tbody', {}, [...new Set(tables.map(t => t.file_name))].filter(Boolean).map(f => {
          const ts = tables.filter(t => t.file_name === f);
          return h('tr', {}, h('td', {}, f), h('td', {}, ts.map(t => t.name).join(', ')), h('td', { class: 'small' }, fmtSize(ts[0].size)),
            h('td', { class: 'right' }, h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('Remove this file?', `${f} and its ${ts.length} table(s)`, 'Remove')) { for (const t of ts) await api('DELETE', `/api/datasources/${id}/items/${t.id}`).catch(fail); reload(); } } }, 'Remove')));
        })))) : null),
    settings: () => settingsPane(d, reload),
  };
  const tabDefs = [['tables', `Tables ${tables.length}`], ['docs', `Documentation ${docs.length + (d.documentation ? 1 : 0)}`], ...(manage && d.kind === 'files' ? [['files', '＋ Add files']] : []), ...(manage ? [['settings', 'Settings & access']] : [])];
  if (!tabDefs.some(t => t[0] === tab)) tab = tabDefs[0][0];
  const bar = h('div', { class: 'tabs' });
  const show = k => { tab = k; sessionStorage.setItem('onto-ds-tab', k); fill(bar, tabDefs.map(([key, l]) => h('button', { class: key === tab ? 'on' : '', onclick: () => show(key) }, l))); fill(body, tabs[k]()); };
  const job = d.job;
  const describeBtn = manage && tables.length ? h('button', { class: 'btn', disabled: job && ['queued', 'running'].includes(job.status), title: 'Draft a business description of every table and column from the documentation and the profiles',
    onclick: async () => {
      const models = await api('GET', '/api/models').catch(() => []);
      if (!models.length) return toast('No AI model is enabled. An administrator must add one under Admin › AI models.', true);
      const model = select(models.map(m => [m.id, m.name + (m.is_default ? ' (default)' : '')]), models[0].id);
      const over = check('Also replace earlier AI drafts', false, null, 'Descriptions written or confirmed by people are never replaced.');
      modal('Describe this data with AI', h('div', { class: 'stack' },
        h('p', {}, 'The AI reads the documentation and the table profiles and drafts a business description of every table and column that has none yet. The drafts are marked “AI draft” until you check them. It also lists the terms it found and what the documentation leaves unclear.'),
        field('AI model', model), over), { actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
          await api('POST', `/api/datasources/${id}/describe`, { model_id: Number(model.value), overwrite: over.input.checked }); close(); reload(); }) }, 'Describe')] });
    } }, '✨ Describe with AI') : null;
  const jobBox = !job ? null : ['queued', 'running'].includes(job.status)
    ? h('div', { class: 'banner info', style: 'margin-bottom:12px' }, h('span', { class: 'spinner' }), ` The AI is describing this data: ${job.stage || 'starting'}…`)
    : job.status === 'error' ? h('div', { class: 'banner bad', style: 'margin-bottom:12px' }, 'Describing with AI did not finish: ', job.error)
    : sessionStorage.getItem('onto-ds-seen-' + job.id) ? null
    : h('div', { class: 'card stack', style: 'margin-bottom:12px;border-color:var(--accent)' }, h('div', { class: 'row' }, h('b', { style: 'flex:1' }, `What the AI understood (${job.model}, ${fmtTime(job.at)})`),
        h('button', { class: 'btn sm ghost', onclick: e => { sessionStorage.setItem('onto-ds-seen-' + job.id, '1'); e.target.closest('.card').remove(); } }, 'Hide')),
      job.result.summary ? h('p', { style: 'margin:0' }, job.result.summary) : null,
      h('div', { class: 'small muted' }, `Drafted ${job.result.tables} table and ${job.result.columns} column description(s) — marked “AI draft” on the Tables tab.`),
      job.result.glossary?.length ? h('div', { class: 'small' }, h('b', {}, 'Terms: '), job.result.glossary.map((g, n) => [n ? '; ' : '', h('b', {}, g.term), ' — ', g.meaning])) : null,
      job.result.questions?.length ? h('div', { class: 'small' }, h('b', {}, 'Not clear from the documentation — worth adding to the notes:'), h('ul', { class: 'bul' }, job.result.questions.map(q => h('li', {}, q)))) : null);
  if (job && ['queued', 'running'].includes(job.status)) setTimeout(() => { if (root.isConnected && location.hash === '#/datasources/' + id) reload(); }, 1500);
  const refresh = d.kind === 'database' && manage ? h('button', { class: 'btn', title: 'Read the structure and profile again', onclick: e => busy(e.target, async () => {
    e.target.textContent = 'Reading…'; await api('POST', `/api/datasources/${id}/refresh`); toast('Re-read.'); reload(); }).finally(() => { e.target.textContent = '↻ Re-read database'; }) }, '↻ Re-read database') : null;
  fill(root, h('div', { class: 'page' },
    h('div', { class: 'ws-head' }, h('div', { style: 'flex:1;min-width:260px' }, h('div', { class: 'crumb' }, h('a', { href: '#/datasources' }, 'Data sources')),
      h('h1', {}, (d.kind === 'database' ? '🗄 ' : '📁 ') + d.name),
      h('div', { class: 'row wrap', style: 'margin-top:6px' }, h('span', { class: 'badge' }, manage ? 'Owner' : 'Can use'), d.visibility === 'shared' ? h('span', { class: 'badge info' }, 'Shared with everyone') : null,
        h('span', { class: 'badge ' + (d.sample_values ? 'good' : '') }, d.sample_values ? 'statistics + sample values' : 'statistics only'),
        h('span', { class: 'small dim' }, (d.db_label ? d.db_label + ' · ' : '') + `owner ${d.owner}` + (d.refreshed_at ? ` · read ${ago(d.refreshed_at)}` : ''))),
      d.description ? h('p', { class: 'muted', style: 'margin:8px 0 0' }, d.description) : null),
      refresh, describeBtn, state.me.role !== 'viewer' ? h('button', { class: 'btn primary', disabled: !tables.length && !docs.length, onclick: () => { sessionStorage.setItem('onto-wizard-ds', String(id)); location.hash = '#/library/new'; } }, '✨ Build an ontology from this') : null),
    d.status === 'error' ? h('div', { class: 'banner bad', style: 'margin-bottom:12px' }, d.error) : null,
    d.notes.length ? h('div', { class: 'banner warn', style: 'margin-bottom:12px' }, h('b', {}, 'Not everything could be read: '), h('ul', { class: 'bul' }, d.notes.slice(0, 10).map(n => h('li', {}, n)))) : null,
    d.used_by_list.length ? h('div', { class: 'small muted', style: 'margin-bottom:10px' }, 'Used by: ', d.used_by_list.map((o, n) => [n ? ', ' : '', h('a', { href: '#/o/' + o.id }, o.name)])) : null,
    jobBox, status, bar, body));
  show(tab);
}

function settingsPane(d, reload) {
  const name = h('input', { type: 'text', value: d.name }), desc = h('textarea', { rows: 3 }, d.description || '');
  const samples = check('Share sample values with the AI model', d.sample_values, null, 'Example values per column and the full list of values of code columns. Untick to send statistics only.');
  const personal = check('Also for columns that look like personal data', d.personal_samples, null, 'Names, emails, phone numbers, ID numbers, addresses, dates of birth. Off by default. Takes effect for values read from now on — re-read or re-upload.');
  const keepFiles = d.kind === 'files' ? check('Keep a copy of uploaded datasets on this server', d.keep_files, null, 'Needed to build knowledge graphs from their rows. When off, datasets are profiled when uploaded and then deleted; their tables can still be mapped, but their rows cannot be loaded. Switching it off deletes the copies kept so far.') : null;
  const graphPersonal = check('Load personal data into knowledge graphs', d.graph_personal, null, 'Columns that look like personal data are left out of knowledge graphs built from this data source unless this is ticked. Only people who may use this data source see a graph’s records. Takes effect at the next build.');
  const db = d.kind === 'database' ? dbForm({ dataSource: true }) : null;
  if (db && d.connection) db.set(d.connection);
  const save = h('button', { class: 'btn primary', onclick: () => busy(save, async () => {
    const payload = { name: name.value, description: desc.value, kind: d.kind, visibility: d.visibility, sample_values: samples.input.checked, personal_samples: personal.input.checked, graph_personal: graphPersonal.input.checked, ...(keepFiles ? { keep_files: keepFiles.input.checked } : {}) };
    if (db) { const v = db.value(); Object.assign(payload, v || {}); }
    const r = await api('PUT', `/api/datasources/${d.id}`, payload);
    toast(r.reread_needed ? 'Saved. Re-read the data source (or re-upload the files) to collect values of personal columns.' : 'Saved'); reload();
  }) }, 'Save');
  const accessBox = h('div', {});
  api('GET', `/api/datasources/${d.id}/access`).then(a => {
    const vis = select([['private', 'Only the people ticked below (and administrators)'], ['shared', 'Everyone who builds ontologies']], a.visibility);
    const boxes = a.users.filter(u => u.role !== 'viewer' && u.role !== 'admin').map(u => ({ u, cb: check(`${u.name || u.email} (${u.email})`, u.granted) }));
    fill(accessBox, h('div', { class: 'stack' }, field('Who can use it', vis), boxes.length ? h('div', { class: 'access-users' }, boxes.map(b => b.cb)) : h('p', { class: 'small dim' }, 'No other ontologists yet.'),
      h('p', { class: 'small dim' }, `Owner: ${a.owner}. “Use” means building ontologies from it and reading its profiles; only the owner and administrators can change, re-read or delete it. Viewers cannot use data sources.`),
      h('div', {}, h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
        await api('PUT', `/api/datasources/${d.id}/access`, { visibility: vis.value, users: boxes.filter(b => b.cb.input.checked).map(b => b.u.id) }); toast('Access saved'); reload();
      }) }, 'Save access'))));
  }).catch(fail);
  return h('div', { class: 'grid2', style: 'align-items:start' },
    h('div', { class: 'card stack' }, h('h2', {}, 'Settings'), field('Name', name), field('Description', desc, 'tells the AI what this data is about'), samples, personal, graphPersonal, keepFiles,
      db ? [h('h3', {}, 'Connection'), db] : null, h('div', { class: 'row' }, save, h('span', { class: 'spacer' }),
        h('button', { class: 'btn danger', onclick: async () => { if (!await confirmDialog('Delete this data source?', `${d.name} will be removed${d.used_by ? ` and unlinked from ${d.used_by} ontolog${d.used_by === 1 ? 'y' : 'ies'} (they keep what was built)` : ''}.`, 'Delete')) return;
          try { await api('DELETE', '/api/datasources/' + d.id); location.hash = '#/datasources'; } catch (e) { fail(e); } } }, 'Delete data source'))),
    h('div', { class: 'card stack' }, h('h2', {}, 'Access'), accessBox));
}

/** A checklist of the data sources a person can use (for the New ontology wizard and the Sources tab).
 *  Data sources without tables or documents yet are listed but cannot be ticked. */
export async function pickDataSources(chosen = new Set(), exclude = new Set(), onLeave) {
  const data = await api('GET', '/api/datasources').catch(() => ({ items: [], can_create: false }));
  const items = data.items.filter(d => !exclude.has(d.id));
  const link = (label, href) => h('a', { href, onclick: () => onLeave?.() }, label);
  const el = h('div', { class: 'stack' }, items.length ? h('div', { class: 'card flush' }, items.map(d => {
    const empty = !(d.tables || d.documents || d.documentation);
    const cb = h('input', { type: 'checkbox', checked: chosen.has(d.id), disabled: empty, style: 'width:auto', onchange: e => { e.target.checked ? chosen.add(d.id) : chosen.delete(d.id); } });
    return h('label', { class: 'item row', style: empty ? 'opacity:.6' : 'cursor:pointer' }, cb, h('span', { style: 'flex:1' }, h('b', {}, (d.kind === 'database' ? '🗄 ' : '📁 ') + d.name),
      h('div', { class: 'small muted' }, empty ? 'Empty — add tables or documents to it first' : `${d.tables} tables · ${d.documents} documents` + (d.documentation ? ' · documented' : '') + (d.description ? ' · ' + d.description.slice(0, 110) : ''))),
      h('span', { class: 'badge' }, d.sample_values ? 'statistics + samples' : 'statistics only'));
  })) : h('p', { class: 'small dim', style: 'margin:0' }, 'You have no data sources yet. ', data.can_create ? [link('Set one up', '#/datasources'), ' on the Data sources page: connect a database or upload datasets and documents once, then build ontologies from it.'] : 'Ask an ontologist to share one with you.'),
    items.length && data.can_create ? h('div', { class: 'small dim' }, 'Need another? ', link('Set up a data source', '#/datasources'), '.') : null);
  el.chosen = chosen;
  return el;
}
