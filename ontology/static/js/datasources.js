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
  const desc = h('textarea', { rows: 2, placeholder: 'What this data is about — it helps the AI understand it. Optional.' });
  const db = dbForm();
  const samples = check('Share sample values with the AI model', true, null, 'Besides statistics, a few example values per column and the full list of values of code columns (statuses, types). This gives a better ontology. Untick for statistics only.');
  const body = h('div', {});
  const seg = h('div', { class: 'seg' });
  const draw = () => {
    fill(seg, [['files', '📁 Upload datasets and documents'], ['database', '🗄 Connect a database']].map(([k, l]) => h('button', { class: kind === k ? 'on' : '', style: 'padding:6px 14px', onclick: () => { kind = k; draw(); } }, l)));
    fill(body, kind === 'database' ? [db, h('p', { class: 'small dim' }, 'The password is stored encrypted so the database can be re-read later; it is never shown again. Use a read-only user. Each table is profiled from at most 2,000 rows; nothing is written to the database.')]
      : h('p', { class: 'small muted' }, 'You add files on the next screen: datasets (CSV, Excel, SQLite, JSON record lists) are profiled; documents (PDF, Word, PowerPoint, Markdown, text, JSON, XML, HTML) are read. You can upload whole folders.'));
  };
  draw();
  modal('New data source', h('div', { class: 'stack' }, seg, field('Name', name), field('Description', desc), body, samples), {
    wide: true, actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
      const payload = { name: name.value, description: desc.value, kind, sample_values: samples.input.checked };
      if (kind === 'database') {
        const v = db.value(); if (!v || !v.host || !v.database) throw new Error('Enter at least the host and the database name.');
        Object.assign(payload, v);
        e.target.textContent = 'Reading the database…';
      }
      const r = await api('POST', '/api/datasources', payload);
      close(); location.hash = '#/datasources/' + r.id;
    }).finally(() => { e.target.textContent = 'Create'; }) }, 'Create')] });
}

async function detailView(root, id) {
  const d = await api('GET', '/api/datasources/' + id);
  const manage = d.level === 'manage';
  const reload = () => detailView(root, id);
  const tables = d.items.filter(i => i.kind === 'table'), docs = d.items.filter(i => i.kind === 'document');
  const status = h('div', {});
  let tab = sessionStorage.getItem('onto-ds-tab') || (tables.length ? 'tables' : 'documents');
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
      h('td', {}, h('b', {}, i.name), i.description ? h('div', { class: 'small muted' }, i.description) : null, i.file_name && i.file_name !== i.name ? h('div', { class: 'small dim' }, 'from ' + i.file_name) : null),
      h('td', { class: 'num' }, p.row_count == null ? '—' : p.row_count.toLocaleString()), h('td', { class: 'num' }, p.columns.length),
      h('td', { class: 'small' }, refs.length ? refs.map(c => `${c.name} → ${c.ref}${c.ref_declared === false ? ' (inferred)' : ''}`).join('; ') : h('span', { class: 'dim' }, '—')),
      h('td', { class: 'small' }, p.columns.filter(c => c.role === 'code').map(c => c.name).join(', ') || h('span', { class: 'dim' }, '—')));
  };

  function tableDialog(i) {
    const p = i.profile, edits = {};
    const desc = h('textarea', { rows: 2, disabled: !manage, placeholder: 'What this table holds, in business terms' }, i.description || '');
    const rows = p.columns.map(c => {
      const [rc, rl] = ROLE[c.role] || ['', c.role];
      const cd = h('input', { type: 'text', value: c.description || '', disabled: !manage, placeholder: c.db_comment || 'business meaning…', style: 'min-width:180px', oninput: e => { edits[c.name] = e.target.value; } });
      const vals = c.top.length ? c.top.map(([v, n]) => `${v} (${n})`).join(', ') + (c.distinct > c.top.length ? ' …' : '') : c.examples.join(' | ');
      return h('tr', {}, h('td', {}, h('b', {}, c.name), c.pk ? h('span', { class: 'badge info', style: 'margin-left:4px' }, 'key') : null, h('div', { class: 'small dim' }, c.declared || c.type)),
        h('td', {}, h('span', { class: 'badge ' + rc }, rl), c.personal ? h('span', { class: 'badge warn', style: 'margin-left:4px' }, 'personal') : null,
          c.ref ? h('div', { class: 'small' }, '→ ' + c.ref + (c.ref_declared === false ? ' (inferred)' : '')) : null),
        h('td', { class: 'small num' }, c.nulls_pct ? c.nulls_pct + '%' : '0'), h('td', { class: 'small num' }, c.distinct.toLocaleString() + (c.unique ? ' · unique' : '')),
        h('td', { class: 'small' }, c.min != null ? `${c.min} … ${c.max}` : ''),
        h('td', { class: 'small', style: 'max-width:300px;overflow-wrap:anywhere' }, vals || (c.personal ? h('span', { class: 'dim' }, 'withheld (personal data)') : '')), h('td', {}, cd));
    });
    modal(`Table ${i.name}`, h('div', { class: 'stack' },
      h('div', { class: 'small muted' }, `${p.row_count == null ? '?' : p.row_count.toLocaleString()} rows · profiled from ${p.sampled_rows.toLocaleString()} rows · ${p.columns.length} columns`),
      field('Description', desc, 'used by the AI as the authoritative meaning'),
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
    documents: () => docs.length ? h('div', { class: 'tbl-wrap', style: 'max-height:none' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['Use', 'Document', 'What was read', 'Updated', ''].map(x => h('th', {}, x)))),
      h('tbody', {}, docs.map(i => h('tr', {}, h('td', { style: 'width:30px' }, h('input', { type: 'checkbox', checked: i.include, disabled: !manage, style: 'width:auto',
          onchange: e => api('PUT', `/api/datasources/${id}/items/${i.id}`, { include: e.target.checked }).catch(fail) })),
        h('td', {}, h('b', {}, '📄 ' + i.name)), h('td', { class: 'small' }, `${i.chars.toLocaleString()} characters` + (i.note ? ' · ' + i.note : '')), h('td', { class: 'small nowrap' }, fmtTime(i.updated_at)),
        h('td', { class: 'right nowrap' }, h('button', { class: 'btn sm', onclick: async () => { const t = await api('GET', `/api/datasources/${id}/items/${i.id}`).catch(fail); if (t) modal(i.name, h('pre', { class: 'code', style: 'max-height:60vh' }, t.text + (t.truncated ? '\n…' : '')), { wide: true }); } }, 'View text'), ' ',
          manage ? h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('Remove this document?', i.name, 'Remove')) { await api('DELETE', `/api/datasources/${id}/items/${i.id}`).catch(fail); reload(); } } }, 'Remove') : null))))))
      : h('div', { class: 'card empty' }, 'No documents.'),
    files: () => h('div', { class: 'stack' }, filePicker(upload),
      h('p', { class: 'small muted' }, h('b', {}, 'Datasets'), ' — CSV, TSV, Excel (each sheet), SQLite files and JSON lists of records — are profiled: rows, columns, types, keys, code lists, likely joins. The data itself is not kept. ',
        h('b', {}, 'Documents'), ' — PDF, Word, PowerPoint, Markdown, text, JSON, XML, HTML, SQL scripts — are read and their text kept. A file with the same name as one already here replaces it, keeping the descriptions you wrote.'),
      tables.filter(t => t.file_name).length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Dataset file', 'Tables', 'Size', ''].map(x => h('th', {}, x)))),
        h('tbody', {}, [...new Set(tables.map(t => t.file_name))].filter(Boolean).map(f => {
          const ts = tables.filter(t => t.file_name === f);
          return h('tr', {}, h('td', {}, f), h('td', {}, ts.map(t => t.name).join(', ')), h('td', { class: 'small' }, fmtSize(ts[0].size)),
            h('td', { class: 'right' }, h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('Remove this file?', `${f} and its ${ts.length} table(s)`, 'Remove')) { for (const t of ts) await api('DELETE', `/api/datasources/${id}/items/${t.id}`).catch(fail); reload(); } } }, 'Remove')));
        })))) : null),
    settings: () => settingsPane(d, reload),
  };
  const tabDefs = [['tables', `Tables ${tables.length}`], ['documents', `Documents ${docs.length}`], ...(manage && d.kind === 'files' ? [['files', '＋ Add files']] : []), ...(manage ? [['settings', 'Settings & access']] : [])];
  if (!tabDefs.some(t => t[0] === tab)) tab = tabDefs[0][0];
  const bar = h('div', { class: 'tabs' });
  const show = k => { tab = k; sessionStorage.setItem('onto-ds-tab', k); fill(bar, tabDefs.map(([key, l]) => h('button', { class: key === tab ? 'on' : '', onclick: () => show(key) }, l))); fill(body, tabs[k]()); };
  const refresh = d.kind === 'database' && manage ? h('button', { class: 'btn', title: 'Read the structure and profile again', onclick: e => busy(e.target, async () => {
    e.target.textContent = 'Reading…'; await api('POST', `/api/datasources/${id}/refresh`); toast('Re-read.'); reload(); }).finally(() => { e.target.textContent = '↻ Re-read database'; }) }, '↻ Re-read database') : null;
  fill(root, h('div', { class: 'page' },
    h('div', { class: 'ws-head' }, h('div', { style: 'flex:1;min-width:260px' }, h('div', { class: 'crumb' }, h('a', { href: '#/datasources' }, 'Data sources')),
      h('h1', {}, (d.kind === 'database' ? '🗄 ' : '📁 ') + d.name),
      h('div', { class: 'row wrap', style: 'margin-top:6px' }, h('span', { class: 'badge' }, manage ? 'Owner' : 'Can use'), d.visibility === 'shared' ? h('span', { class: 'badge info' }, 'Shared with everyone') : null,
        h('span', { class: 'badge ' + (d.sample_values ? 'good' : '') }, d.sample_values ? 'statistics + sample values' : 'statistics only'),
        h('span', { class: 'small dim' }, (d.db_label ? d.db_label + ' · ' : '') + `owner ${d.owner}` + (d.refreshed_at ? ` · read ${ago(d.refreshed_at)}` : ''))),
      d.description ? h('p', { class: 'muted', style: 'margin:8px 0 0' }, d.description) : null),
      refresh, state.me.role !== 'viewer' ? h('button', { class: 'btn primary', disabled: !tables.length && !docs.length, onclick: () => { sessionStorage.setItem('onto-wizard-ds', String(id)); location.hash = '#/library/new'; } }, '✨ Build an ontology from this') : null),
    d.status === 'error' ? h('div', { class: 'banner bad', style: 'margin-bottom:12px' }, d.error) : null,
    d.notes.length ? h('div', { class: 'banner warn', style: 'margin-bottom:12px' }, h('b', {}, 'Not everything could be read: '), h('ul', { class: 'bul' }, d.notes.slice(0, 10).map(n => h('li', {}, n)))) : null,
    d.used_by_list.length ? h('div', { class: 'small muted', style: 'margin-bottom:10px' }, 'Used by: ', d.used_by_list.map((o, n) => [n ? ', ' : '', h('a', { href: '#/o/' + o.id }, o.name)])) : null,
    status, bar, body));
  show(tab);
}

function settingsPane(d, reload) {
  const name = h('input', { type: 'text', value: d.name }), desc = h('textarea', { rows: 3 }, d.description || '');
  const samples = check('Share sample values with the AI model', d.sample_values, null, 'Example values per column and the full list of values of code columns. Untick to send statistics only.');
  const personal = check('Also for columns that look like personal data', d.personal_samples, null, 'Names, emails, phone numbers, ID numbers, addresses, dates of birth. Off by default. Takes effect for values read from now on — re-read or re-upload.');
  const db = d.kind === 'database' ? dbForm() : null;
  if (db && d.connection) {
    const c = d.connection, inputs = db.querySelectorAll('input, select');
    db.querySelector('select').value = c.db_type; inputs[1].value = c.host; inputs[2].value = c.port || ''; inputs[3].value = c.database; inputs[4].value = c.user;
    inputs[5].placeholder = c.has_password ? '•••••••• (unchanged)' : ''; inputs[6].value = c.schema || '';
  }
  const save = h('button', { class: 'btn primary', onclick: () => busy(save, async () => {
    const payload = { name: name.value, description: desc.value, kind: d.kind, visibility: d.visibility, sample_values: samples.input.checked, personal_samples: personal.input.checked };
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
    h('div', { class: 'card stack' }, h('h2', {}, 'Settings'), field('Name', name), field('Description', desc, 'tells the AI what this data is about'), samples, personal,
      db ? [h('h3', {}, 'Connection'), db] : null, h('div', { class: 'row' }, save, h('span', { class: 'spacer' }),
        h('button', { class: 'btn danger', onclick: async () => { if (!await confirmDialog('Delete this data source?', `${d.name} will be removed${d.used_by ? ` and unlinked from ${d.used_by} ontolog${d.used_by === 1 ? 'y' : 'ies'} (they keep what was built)` : ''}.`, 'Delete')) return;
          try { await api('DELETE', '/api/datasources/' + d.id); location.hash = '#/datasources'; } catch (e) { fail(e); } } }, 'Delete data source'))),
    h('div', { class: 'card stack' }, h('h2', {}, 'Access'), accessBox));
}

/** A checklist of the data sources a person can use (for the New ontology wizard and the Sources tab). */
export async function pickDataSources(chosen = new Set(), exclude = new Set()) {
  const data = await api('GET', '/api/datasources').catch(() => ({ items: [] }));
  const items = data.items.filter(d => !exclude.has(d.id) && (d.tables || d.documents));
  const el = h('div', { class: 'stack' }, items.length ? h('div', { class: 'card flush' }, items.map(d => {
    const cb = h('input', { type: 'checkbox', checked: chosen.has(d.id), style: 'width:auto', onchange: e => { e.target.checked ? chosen.add(d.id) : chosen.delete(d.id); } });
    return h('label', { class: 'item row', style: 'cursor:pointer' }, cb, h('span', { style: 'flex:1' }, h('b', {}, (d.kind === 'database' ? '🗄 ' : '📁 ') + d.name),
      h('div', { class: 'small muted' }, `${d.tables} tables · ${d.documents} documents` + (d.description ? ' · ' + d.description.slice(0, 120) : ''))),
      h('span', { class: 'badge' }, d.sample_values ? 'statistics + samples' : 'statistics only'));
  })) : h('p', { class: 'small dim' }, 'No data sources with content yet. ', h('a', { href: '#/datasources' }, 'Set one up'), ' on the Data sources page.'));
  el.chosen = chosen;
  return el;
}
