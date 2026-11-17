// The library: folders on the left, ontologies as cards, the New ontology wizard, import, folder access.
import { h, fill, api, busy, fail, toast, modal, field, check, select, confirmDialog, ago, state } from './core.js';
import { filePicker, uploadFiles, dbForm, fmtSize } from './sources.js';
import { pickDataSources } from './datasources.js';

const STATUS = { ready: ['good', 'Ready'], building: ['info', 'Building…'], draft: ['', 'Draft'], failed: ['bad', 'Build failed'] };
export const LEVEL = { manage: 'Owner', edit: 'Can edit', view: 'Read only' };

export async function libraryView(root, arg) {
  const lib = await api('GET', '/api/library');
  const sel = arg === 'none' ? 'none' : arg && arg !== 'new' ? Number(arg) : null;      // null = everything
  const folders = lib.folders, byId = Object.fromEntries(folders.map(f => [f.id, f]));
  const cur = typeof sel === 'number' ? byId[sel] : null;
  if (typeof sel === 'number' && !cur) { location.hash = '#/library'; return; }
  const reload = () => libraryView(root, arg);
  const inside = id => { const out = [id]; folders.filter(f => f.parent_id === id).forEach(f => out.push(...inside(f.id))); return out; };
  const count = id => { const ids = inside(id); return lib.ontologies.filter(o => ids.includes(o.folder_id)).length; };
  const shown = lib.ontologies.filter(o => sel === null ? true : sel === 'none' ? !o.folder_id : inside(sel).includes(o.folder_id));

  // ---- folder tree
  const branch = (parent, depth) => folders.filter(f => f.parent_id === parent).flatMap(f => [
    h('a', { href: '#/library/' + f.id, class: sel === f.id ? 'on' : '', style: `padding-left:${8 + depth * 16}px`, title: `${f.owner} · ${LEVEL[f.level]}` },
      h('span', {}, f.everyone ? '📂' : '📁'), h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, f.name), h('span', { class: 'n' }, count(f.id))),
    ...branch(f.id, depth + 1)]);
  const tree = h('div', { class: 'tree' },
    h('a', { href: '#/library', class: sel === null ? 'on' : '' }, h('span', {}, '🗂'), 'All ontologies', h('span', { class: 'n' }, lib.ontologies.length)),
    branch(null, 0),
    h('a', { href: '#/library/none', class: sel === 'none' ? 'on' : '' }, h('span', {}, '▫'), 'Not in a folder', h('span', { class: 'n' }, lib.ontologies.filter(o => !o.folder_id).length)),
    lib.can_create ? h('div', { style: 'padding:8px 4px 2px' }, h('button', { class: 'btn sm', style: 'width:100%;justify-content:center', onclick: () => folderForm(null, cur?.level && cur.level !== 'view' ? cur.id : null, folders, reload) }, '＋ New folder')) : null);

  // ---- header for the current folder
  const canAdd = lib.can_create && (!cur || cur.level !== 'view');
  const head = h('div', { class: 'page-head' }, h('div', { style: 'flex:1;min-width:200px' }, h('h1', {}, cur ? cur.name : sel === 'none' ? 'Not in a folder' : 'Ontologies'),
    cur ? h('div', { class: 'small dim' }, `Folder · owner ${cur.owner} · `, h('span', { class: 'badge' }, LEVEL[cur.level]),
      cur.everyone ? h('span', { class: 'badge info', style: 'margin-left:6px' }, cur.everyone === 'edit' ? 'Everyone can edit' : 'Everyone can view') : null) : null),
    cur?.level === 'manage' ? [h('button', { class: 'btn', onclick: () => accessForm(cur, reload) }, '👥 Access'), h('button', { class: 'btn', onclick: () => folderForm(cur, cur.parent_id, folders, reload) }, 'Rename / move'),
      h('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog('Delete this folder?', `"${cur.name}" must be empty.`, 'Delete')) { try { await api('DELETE', `/api/folders/${cur.id}`); location.hash = '#/library'; } catch (e) { fail(e); } } } }, 'Delete')] : null,
    h('a', { class: 'btn', href: '#/templates' }, '📚 Pre-built library'),
    canAdd ? [h('button', { class: 'btn', onclick: () => importForm(cur, reload) }, '⬆ Import file'), h('button', { class: 'btn primary', onclick: () => wizard(cur, folders) }, '＋ New ontology')] : null);

  const card = o => {
    const [cls, label] = STATUS[o.status] || ['', o.status];
    return h('a', { class: 'ocard', href: `#/o/${o.id}` },
      h('div', { class: 'row top' }, h('h3', { style: 'flex:1' }, o.name), h('span', { class: 'badge ' + cls }, label)),
      h('div', { class: 'small muted' }, o.domain || 'No domain stated'),
      h('div', { class: 'row wrap' }, o.folder_id && sel !== o.folder_id ? h('span', { class: 'badge' }, '📁 ' + byId[o.folder_id].name) : null,
        h('span', { class: 'badge' }, LEVEL[o.level]), o.visibility === 'shared' ? h('span', { class: 'badge info' }, 'Shared with everyone') : null),
      h('div', { class: 'meta' }, h('span', {}, h('b', {}, o.classes), ' classes'), h('span', {}, h('b', {}, o.properties), ' properties'), h('span', {}, h('b', {}, o.use_cases), ' use cases'),
        h('span', { style: 'margin-left:auto' }, `v${o.version} · ${ago(o.updated_at)}`)));
  };
  fill(root, h('div', { class: 'page' }, head, h('div', { class: 'lib' }, tree,
    shown.length ? h('div', { class: 'cards' }, shown.map(card)) : h('div', { class: 'card empty' }, h('p', {}, 'No ontologies here yet.'),
      canAdd ? h('p', { class: 'small' }, 'Use ', h('b', {}, '＋ New ontology'), ' to build one from a domain, your use cases, a database or a folder of documents — or start from a ready-made one in the ', h('a', { href: '#/templates' }, 'pre-built library'), '.') : null))));
  if (arg === 'new') { history.replaceState(null, '', '#/library'); if (lib.can_create) wizard(null, folders); }
  if (lib.ontologies.some(o => o.status === 'building')) setTimeout(() => { if (location.hash.startsWith('#/library') && root.isConnected) reload(); }, 5000);
}

function folderForm(f, parentId, folders, done) {
  const name = h('input', { type: 'text', value: f?.name || '', maxlength: 120 });
  const below = id => [id, ...folders.filter(x => x.parent_id === id).flatMap(x => below(x.id))];
  const banned = f ? below(f.id) : [];
  const parent = select([['', '— top level —'], ...folders.filter(x => x.level !== 'view' && !banned.includes(x.id)).map(x => [x.id, x.name])], parentId || '');
  modal(f ? 'Rename or move folder' : 'New folder', h('div', { class: 'stack' }, field('Folder name', name), field('Inside', parent, 'access given on a folder also applies to the folders inside it')), {
    actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
      const body = { name: name.value, parent_id: parent.value ? Number(parent.value) : null };
      await (f ? api('PUT', `/api/folders/${f.id}`, body) : api('POST', '/api/folders', body)); close(); done();
    }) }, 'Save')] });
}

async function accessForm(f, done) {
  const a = await api('GET', `/api/folders/${f.id}/access`).catch(fail);
  if (!a) return;
  const everyone = select([['', 'Only the people listed below'], ['view', 'Everyone signed in can view'], ['edit', 'Everyone signed in can edit']], a.everyone);
  const rows = a.users.map(u => {
    const lvl = select([['', 'No access'], ['view', 'Can view'], ['edit', 'Can edit']], u.level, null, { class: 'inline' });
    return { u, lvl, el: h('tr', {}, h('td', {}, h('b', {}, u.name || u.email), h('div', { class: 'small dim' }, u.email)), h('td', {}, u.role),
      h('td', {}, u.role === 'admin' ? h('span', { class: 'small dim' }, 'Administrators can always manage') : lvl,
        u.role === 'viewer' ? h('div', { class: 'small dim' }, 'Viewer role: read only, whatever is chosen') : null)) };
  });
  modal(`Who can use “${f.name}”`, h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'Access to a folder covers every ontology in it and in the folders inside it. ',
      a.inherits_from ? `People who have access to the parent folder “${a.inherits_from}” already have it here.` : ''),
    field('Everyone', everyone), h('div', { class: 'tbl-wrap', style: 'max-height:340px' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['Person', 'Role', 'Access to this folder'].map(x => h('th', {}, x)))), h('tbody', {}, rows.map(r => r.el)))),
    h('p', { class: 'small dim' }, `Owner: ${a.owner}. “Can view” = read, export, run tests. “Can edit” = also change the ontologies and add new ones. Only the owner or an administrator can delete, move or change access.`)), {
    wide: true, actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
      await api('PUT', `/api/folders/${f.id}/access`, { everyone: everyone.value, grants: rows.filter(r => r.lvl.value && r.u.role !== 'admin').map(r => ({ user_id: r.u.id, level: r.lvl.value })) });
      close(); toast('Access saved'); done();
    }) }, 'Save access')] });
}

function importForm(cur, done) {
  const file = h('input', { type: 'file', accept: '.json,.ttl,.owl,.rdf,.jsonld,.nt,.xml' });
  modal('Import an ontology file', h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'Bring in an existing ontology — a published standard, one from Protégé or another tool, or a JSON file exported from this application. It becomes a normal ontology here: you can extend it with AI, edit it on the diagram, test it and export it.'),
    field('File', file, 'OWL (RDF/XML), Turtle, JSON-LD, N-Triples or JSON'),
    h('p', { class: 'small dim' }, cur ? `It will be placed in the folder “${cur.name}”.` : 'It will not be placed in a folder; you can move it afterwards.')), {
    actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
      if (!file.files[0]) throw new Error('Choose a file first.');
      const fd = new FormData(); fd.append('file', file.files[0]); fd.append('folder_id', cur ? String(cur.id) : '');
      const r = await api('POST', '/api/ontologies/import', fd);
      close(); toast(`Imported ${r.classes} classes and ${r.properties} properties.` + (r.note ? ' ' + r.note : ''));
      location.hash = `#/o/${r.id}`;
    }) }, 'Import')] });
}

// ---- New ontology wizard ---------------------------------------------------------------------
async function wizard(cur, folders) {
  const models = await api('GET', '/api/models').catch(() => []);
  const name = h('input', { type: 'text', maxlength: 200, placeholder: 'e.g. Tractor loan origination' });
  const domain = h('input', { type: 'text', maxlength: 400, placeholder: 'e.g. Retail lending for farm equipment — leave blank to let the AI infer it from your material' });
  const scope = h('textarea', { rows: 4, placeholder: 'What should be covered, and what should be left out? e.g. From enquiry to disbursement: applicants, dealers, assets, underwriting, sanction, disbursement. Not collections.' });
  const depth = select([['compact', 'Compact — about 15–25 classes (a first cut)'], ['standard', 'Standard — about 35–55 classes'], ['comprehensive', 'Comprehensive — about 70–100 classes (slower, costs more)']], 'standard');
  const folder = select([['', '— no folder —'], ...folders.filter(f => f.level !== 'view').map(f => [f.id, f.name])], cur?.id || '');
  const ucs = h('textarea', { rows: 6, placeholder: 'One per line — the questions or tasks the ontology must support, in your own words.\ne.g.\nWhich dealers have the highest share of loans rejected at underwriting?\nShow every disbursement made against a sanction older than 90 days.' });
  const reqs = h('textarea', { rows: 4, placeholder: 'Anything it must satisfy: regulations, systems it must map to, naming rules, levels of detail…' });
  const notes = h('textarea', { rows: 4, placeholder: 'Your own terms, glossary, abbreviations, examples. Optional.' });
  const model = select(models.map(m => [m.id, m.name + (m.is_default ? ' (default)' : '')]), models[0]?.id);
  const nUc = h('input', { type: 'number', min: 0, max: 15, value: 8, style: 'max-width:110px' });
  let files = [], dbs = [];
  const dsChosen = new Set(), pre = Number(sessionStorage.getItem('onto-wizard-ds')) || null;
  sessionStorage.removeItem('onto-wizard-ds');
  if (pre) dsChosen.add(pre);
  const dsBox = h('div', {}, h('span', { class: 'spinner' }));
  const dsSummary = h('div', { class: 'small muted' });
  const drawSummary = () => fill(dsSummary, dsChosen.size ? [`Data sources chosen in step 1: ${dsChosen.size}. `] : ['No data source chosen. '],
    h('a', { href: '#', onclick: e => { e.preventDefault(); show('basics'); } }, dsChosen.size ? 'Change' : 'Choose data sources'), ' — or add documents and databases for this ontology only below.');
  pickDataSources(dsChosen, new Set(), () => close()).then(el => { fill(dsBox, el); dsBox.addEventListener('change', () => { sync(); drawSummary(); }); drawSummary(); }).catch(() => fill(dsBox));
  const fileList = h('div', {});
  const drawFiles = () => fill(fileList, files.length || dbs.length ? h('div', { class: 'card flush' },
    dbs.map((d, i) => h('div', { class: 'item row' }, '🗄', h('span', { style: 'flex:1' }, h('b', {}, d.label), h('span', { class: 'small dim' }, ' — structure will be read when you create the ontology')),
      h('button', { class: 'btn sm ghost', onclick: () => { dbs.splice(i, 1); drawFiles(); } }, '✕'))),
    files.slice(0, 60).map((f, i) => h('div', { class: 'item row' }, '📄', h('span', { style: 'flex:1;overflow-wrap:anywhere' }, f._path), h('span', { class: 'small dim' }, fmtSize(f.size)),
      h('button', { class: 'btn sm ghost', onclick: () => { files.splice(i, 1); drawFiles(); sync(); } }, '✕'))),
    files.length > 60 ? h('div', { class: 'item small dim' }, `…and ${files.length - 60} more files`) : null) : null);
  const db = dbForm();
  const addDb = h('button', { class: 'btn', onclick: () => { const v = db.value(); if (!v || !v.host || !v.database) return toast('Enter at least the host and the database name.', true); dbs.push({ payload: v, label: db.label() }); drawFiles(); sync(); toast('Database added to the list.'); } }, '＋ Add this database');

  const panes = {
    basics: h('div', { class: 'stack' }, field('Name', name),
      h('div', { class: 'card stack', style: 'background:var(--surface-2)' }, h('div', {}, h('b', {}, 'Build from your data'), h('span', { class: 'small dim' }, ' — optional: tick the data sources (data models) this ontology should be built from. With a data source, the domain and scope can be left blank.')), dsBox),
      field('Domain', domain), field('Scope', scope, 'optional, but the more precise the better'),
      h('div', { class: 'small muted' }, 'Prefer not to start from scratch? The ', h('a', { href: '#/templates', onclick: () => close() }, 'pre-built library'), ' has ready-made ontologies by industry to copy and extend.'),
      h('div', { class: 'grid2' }, field('Size', depth), field('Folder', folder))),
    needs: h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Tell the builder what the ontology is for. Every use case you list becomes a required use case: the ontology is designed so it can answer it, and it appears first under Use cases, ready to be tested.'),
      field('Use cases it must answer', ucs), field('Requirements', reqs), field('Reference notes', notes)),
    sources: h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Optional. Ground the ontology in what you already have — or build it from this material alone. The AI reads it, uses your terms, and records which table or document each class came from.'),
      dsSummary,
      h('h3', { style: 'margin-top:16px' }, 'Documents for this ontology only'), filePicker(fs => { files.push(...fs.filter(f => !f.name.startsWith('.') && !f.name.startsWith('~$'))); drawFiles(); sync(); }),
      h('h3', { style: 'margin-top:16px' }, 'A database'), h('p', { class: 'small dim' }, 'Either add a schema script (.sql / .ddl) or a SQLite file above, or let the application read the structure of a live database:'),
      h('details', {}, h('summary', { style: 'cursor:pointer;color:var(--accent)' }, 'Read the structure of a live database'), h('div', { style: 'margin-top:10px' }, db, h('div', { style: 'margin-top:10px' }, addDb))),
      fileList),
    build: h('div', { class: 'stack' },
      models.length ? null : h('div', { class: 'banner warn' }, 'No AI model is enabled yet. An administrator must add one under Admin › AI models before an ontology can be built. You can still create it now and build it by hand on the diagram.'),
      h('div', { class: 'grid2' }, field('AI model', model), field('Extra use cases to write', nUc, 'on top of the ones you listed')),
      h('div', { class: 'banner info' }, h('b', {}, 'What happens when you build'), h('ol', { class: 'bul', style: 'margin-bottom:0' },
        ['Your documents and database structure are read.', 'Published industry ontologies and standards for the domain are researched and chosen.',
          'The class hierarchy is designed on top of them.', 'Relationships, attributes, controlled values and rules are added.',
          'The draft is reviewed for completeness and gaps are closed.', 'The explanation and the use cases are written.'].map(x => h('li', {}, x))),
        h('div', { class: 'small', style: 'margin-top:6px' }, 'This takes a few minutes. You can leave the page; progress is shown when you come back.'))),
  };
  const body = h('div', { style: 'min-height:330px' });
  const steps = h('div', { class: 'steps' });
  const order = [['basics', '1 · Basics'], ['needs', '2 · Use cases & requirements'], ['sources', '3 · More documents'], ['build', '4 · Build']];
  let at = 'basics';
  const sync = () => {
    const has = { basics: name.value.trim(), needs: ucs.value.trim() || reqs.value.trim() || notes.value.trim(), sources: files.length || dbs.length || dsChosen.size };
    fill(steps, order.map(([k, l]) => h('button', { class: (at === k ? 'on ' : '') + (has[k] ? 'has' : ''), onclick: () => show(k) }, l)));
  };
  const show = k => { at = k; fill(body, panes[k]); sync(); back.classList.toggle('hidden', k === 'basics'); next.classList.toggle('hidden', k === 'build'); go.classList.toggle('hidden', k !== 'build'); manual.classList.toggle('hidden', k !== 'build'); };
  const idx = () => order.findIndex(o => o[0] === at);
  const back = h('button', { class: 'btn', onclick: () => show(order[idx() - 1][0]) }, '‹ Back');
  const next = h('button', { class: 'btn primary', onclick: () => show(order[idx() + 1][0]) }, 'Next ›');
  const status = h('span', { class: 'small muted', style: 'margin-right:auto' });
  let close;
  const create = async (build) => {
    if (!name.value.trim()) { show('basics'); name.focus(); throw new Error('Give the ontology a name.'); }
    const seeds = ucs.value.split('\n').map(x => x.trim().replace(/^[-•*\d.)\s]+/, '')).filter(Boolean);
    if (build && !(domain.value.trim() || scope.value.trim() || seeds.length || reqs.value.trim() || files.length || dbs.length || dsChosen.size)) { show('basics'); throw new Error('Say what the ontology is about: a domain, use cases, requirements, or source material.'); }
    status.textContent = 'Creating…';
    const { id } = await api('POST', '/api/ontologies', { name: name.value, domain: domain.value, scope: scope.value, notes: notes.value, requirements: reqs.value,
      use_cases: seeds, depth: depth.value, folder_id: folder.value ? Number(folder.value) : null });
    const problems = [];
    for (const dsid of dsChosen) {
      try { await api('POST', `/api/ontologies/${id}/datasources`, { data_source_id: dsid }); } catch (e) { problems.push(`Data source ${dsid}: ${e.message}`); }
    }
    for (const d of dbs) {
      status.textContent = `Reading ${d.label}…`;
      try { await api('POST', `/api/ontologies/${id}/sources/database`, d.payload); } catch (e) { problems.push(`${d.label}: ${e.message}`); }
    }
    if (files.length) {
      const r = await uploadFiles(id, files, (n, t) => { status.textContent = `Uploading documents ${n} of ${t}…`; });
      r.failed.forEach(f => problems.push(`${f.name}: ${f.reason}`));
    }
    if (build && !problems.length) await api('POST', `/api/ontologies/${id}/build`, { model_id: Number(model.value), use_cases: Number(nUc.value) || 0 });
    close();
    if (problems.length) modal('Created — but some source material could not be read', h('div', { class: 'stack' }, h('p', {}, 'The ontology was created and has not been built yet. Fix or remove these on its Sources tab, then press Build there.'),
      h('ul', { class: 'bul' }, problems.slice(0, 15).map(p => h('li', {}, p)))));
    location.hash = `#/o/${id}` + (problems.length ? '/sources' : '');
  };
  const go = h('button', { class: 'btn primary', disabled: !models.length, onclick: e => busy(e.target, () => create(true)).finally(() => { status.textContent = ''; }) }, '✨ Create and build with AI');
  const manual = h('button', { class: 'btn', title: 'Create an empty ontology and draw it yourself', onclick: e => busy(e.target, () => create(false)).finally(() => { status.textContent = ''; }) }, 'Create empty');
  close = modal('New ontology', h('div', {}, steps, body), { wide: true, actions: () => [status, back, manual, next, go] });
  name.addEventListener('input', sync); ucs.addEventListener('input', sync);
  show('basics');
  name.focus();
  if (pre) api('GET', '/api/datasources/' + pre).then(d => {      // started from "Build an ontology from this"
    if (!name.value) name.value = d.name;
    body.prepend(h('div', { class: 'banner info', style: 'margin-bottom:12px' }, `Building from the data source “${d.name}”. Everything else is optional: press Next to add use cases or more material, or go to `, h('b', {}, '4 · Build'), '.'));
    sync();
  }).catch(() => {});
}
