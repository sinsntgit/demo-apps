// One ontology: header, tabs, AI jobs, overview / explanation, standards, sources, versions.
// The editing tabs (diagram, classes & properties, use cases, test bed, quality) are in editor.js.
import { h, fill, api, busy, fail, toast, modal, field, check, select, confirmDialog, fmtTime, ago, state } from './core.js';
import { filePicker, uploadFiles, dbForm, failedList, fmtSize } from './sources.js';
import { LEVEL } from './library.js';
import { diagramTab, modelTab, useCasesTab, testTab, qualityTab } from './editor.js';

const TABS = [['overview', 'Overview'], ['standards', 'Standards'], ['diagram', 'Diagram'], ['model', 'Classes & properties'], ['usecases', 'Use cases'],
  ['test', 'Test bed'], ['quality', 'Quality & reasoning'], ['sources', 'Sources'], ['versions', 'Versions']];
const EXPORTS = [['pdf', '📕 Handbook (PDF)', 'Full explanation with diagrams'], ['pptx', '📊 Presentation (PowerPoint)', 'Slides for a walkthrough'],
  ['xlsx', '📗 Workbook (Excel)', 'Every element in readable sheets'], ['owl', '🦉 OWL (RDF/XML)', 'For Protégé and reasoners'], ['ttl', '🐢 Turtle (.ttl)', 'For triple stores'],
  ['jsonld', '{ } JSON-LD', 'Linked data as JSON'], ['json', '{ } JSON', 'This application’s own format']];
export const JOB = { build: 'Building the ontology', refine: 'Refining the ontology', explain: 'Rewriting the explanation', usecases: 'Writing use cases', gaps: 'Reviewing for gaps', test: 'Testing a use case' };

export async function workspaceView(root, id, tab, arg) {
  const ctx = { id: Number(id), models: await api('GET', '/api/models').catch(() => []) };
  const body = h('div', {}), head = h('div', {}), bar = h('div', { class: 'tabs' }), jobBox = h('div', {});
  let current = null;

  ctx.load = async () => {
    ctx.o = await api('GET', `/api/ontologies/${ctx.id}`);
    ctx.c = ctx.o.content;
    ctx.canEdit = ctx.o.level !== 'view';
    ctx.canManage = ctx.o.level === 'manage';
    ctx.built = !!(ctx.c && ctx.c.classes.length);
  };
  ctx.reload = async () => { await ctx.load(); drawHead(); drawJob(); show(current, ctx.arg); };
  /** Save a manual change (new version) and refresh what is on screen. */
  ctx.edit = async (patch, note) => {
    const r = await api('POST', `/api/ontologies/${ctx.id}/edit`, { patch, note });
    ctx.c = ctx.o.content = r.content; ctx.o.version = r.version; ctx.o.stats = r.stats; ctx.o.quality = r.quality; ctx.built = !!r.content.classes.length;
    if (ctx.o.status !== 'ready') ctx.o.status = 'ready';
    drawHead();
    return r;
  };
  ctx.go = (t, a) => { location.hash = `#/o/${ctx.id}/${t}` + (a ? '/' + encodeURIComponent(a) : ''); };
  ctx.modelSelect = () => select(ctx.models.map(m => [m.id, m.name + (m.is_default ? ' (default)' : '')]), ctx.models[0]?.id, null, { class: 'inline' });
  ctx.noModel = () => ctx.models.length ? null : h('div', { class: 'banner warn' }, 'No AI model is enabled. An administrator must add one under Admin › AI models.');
  /** Start an AI job on this ontology and show its progress. */
  ctx.run = async (kind, payload) => {
    await api('POST', kind === 'build' ? `/api/ontologies/${ctx.id}/build` : `/api/ontologies/${ctx.id}/run/${kind}`, payload);
    await ctx.load(); drawHead(); drawJob();
  };

  function drawHead() {
    const o = ctx.o;
    const st = { ready: ['good', 'Ready'], building: ['info', 'AI is working…'], draft: ['', 'Draft — not built yet'], failed: ['bad', 'Build failed'] }[o.status] || ['', o.status];
    const pop = h('div', { class: 'pop hidden', style: 'min-width:290px' }, EXPORTS.map(([f, label, hint]) =>
      h('button', { onclick: () => { location.href = `/api/ontologies/${ctx.id}/export/${f}`; } }, h('b', {}, label), h('div', { class: 'small dim' }, hint))));
    const ai = h('div', { class: 'pop hidden', style: 'min-width:290px' },
      h('button', { onclick: () => refineForm(ctx) }, h('b', {}, '✏ Change it with an instruction'), h('div', { class: 'small dim' }, 'e.g. “add collateral and guarantors”')),
      h('button', { onclick: () => ctx.go('quality') }, h('b', {}, '🔍 Review for gaps'), h('div', { class: 'small dim' }, 'A critical read by a reasoning model')),
      h('button', { onclick: () => ucForm(ctx) }, h('b', {}, '💡 Write more use cases')),
      h('button', { onclick: () => simpleRun(ctx, 'explain', 'Rewrite the explanation', 'The explanation on the Overview tab is rewritten from the current classes and properties. Your edits to it are replaced.') }, h('b', {}, '📝 Rewrite the explanation')),
      h('button', { onclick: () => buildForm(ctx, true) }, h('b', {}, '♻ Rebuild from scratch'), h('div', { class: 'small dim' }, 'Runs the whole pipeline again; the current version stays in Versions')));
    const menu = (label, p, cls) => h('div', { class: 'menu' }, h('button', { class: 'btn ' + cls, onclick: e => { e.stopPropagation(); document.querySelectorAll('.menu .pop').forEach(x => x !== p && x.classList.add('hidden')); p.classList.toggle('hidden'); } }, label), p);
    fill(head, h('div', { class: 'ws-head' }, h('div', { style: 'flex:1;min-width:260px' },
      h('div', { class: 'crumb' }, h('a', { href: '#/library' }, 'Ontologies'), o.folder ? [' › ', h('a', { href: '#/library/' + o.folder_id }, o.folder)] : null),
      h('h1', {}, o.name),
      h('div', { class: 'row wrap', style: 'margin-top:6px' }, h('span', { class: 'badge ' + st[0] }, st[1]), o.version ? h('span', { class: 'badge' }, 'Version ' + o.version) : null,
        h('span', { class: 'badge' }, LEVEL[o.level]), o.visibility === 'shared' ? h('span', { class: 'badge info' }, 'Shared with everyone') : null,
        h('span', { class: 'small dim' }, o.domain))),
      ctx.built ? menu('⬇ Download', pop, '') : null,
      ctx.built && ctx.canEdit && o.status !== 'building' ? menu('✨ AI', ai, 'primary') : null,
      ctx.canEdit ? h('button', { class: 'btn', onclick: () => settingsForm(ctx) }, '⚙ Settings') : null));
    fill(bar, TABS.map(([k, l]) => h('button', { 'data-key': k, class: current === k ? 'on' : '', onclick: () => ctx.go(k) }, l,
      k === 'sources' && (o.sources.document || o.sources.schema) ? h('span', { class: 'small dim' }, ` ${(o.sources.document || 0) + (o.sources.schema || 0)}`) : null)));
  }

  function drawJob() {
    const j = ctx.o.job;
    if (!j) return fill(jobBox);
    const bar2 = h('div', {}), stage = h('b', {}), log = h('ol', { class: 'joblog' }), meta = h('span', { class: 'small dim' });
    const paint = job => {
      stage.textContent = job.stage || 'Starting…'; bar2.style.width = Math.max(job.progress, 3) + '%';
      fill(log, job.log.map(l => h('li', {}, l.text)));
      meta.textContent = `${job.model} · ${job.calls} model call${job.calls === 1 ? '' : 's'} · ~$${job.cost.toFixed(2)}`;
      log.scrollTop = log.scrollHeight;
    };
    fill(jobBox, h('div', { class: 'card stack', style: 'margin-bottom:14px;border-color:var(--accent)' },
      h('div', { class: 'row' }, h('span', { class: 'spinner' }), h('span', {}, (JOB[j.kind] || 'Working') + ': '), stage, h('span', { class: 'spacer' }), meta),
      h('div', { class: 'progress' }, bar2), log,
      h('div', { class: 'small dim' }, 'This runs on the server. You can keep browsing or close the page; it will carry on.')));
    paint(j);
    const tick = async () => {
      if (!jobBox.isConnected) return;
      let job;
      try { job = await api('GET', `/api/jobs/${j.id}`); } catch { return; }
      if (job.status === 'done' || job.status === 'error') {
        if (job.status === 'error') modal('The AI job did not finish', h('div', { class: 'stack' }, h('div', { class: 'banner bad' }, job.error),
          h('p', { class: 'small muted' }, 'Nothing was changed. You can try again, choose another model, or narrow the scope.')));
        else if (job.kind === 'gaps') toast('Gap review finished.'); else toast(doneText(job));
        return ctx.reload();
      }
      paint(job); setTimeout(tick, 1500);
    };
    setTimeout(tick, 1200);
  }
  const doneText = job => job.kind === 'build' ? `Built: ${job.result.stats.classes} classes, ${job.result.stats.object_properties + job.result.stats.data_properties} properties.`
    : job.kind === 'refine' ? `Done: ${job.result.added} added, ${job.result.updated} changed, ${job.result.removed} removed.` : 'Done.';

  function show(t, a) {
    current = TABS.some(x => x[0] === t) ? t : 'overview'; ctx.arg = a ? decodeURIComponent(a) : null;
    bar.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.key === current));
    const el = h('div', {});
    fill(body, el);
    const needs = ['standards', 'diagram', 'model', 'usecases', 'test', 'quality'];
    if (!ctx.built && needs.includes(current) && !(current === 'diagram' || current === 'model'))
      return fill(el, h('div', { class: 'card empty' }, 'This ontology has no classes yet. Build it from the Overview tab, or draw it on the Diagram tab.'));
    try {
      ({ overview: overviewTab, standards: standardsTab, diagram: diagramTab, model: modelTab, usecases: useCasesTab, test: testTab, quality: qualityTab,
        sources: sourcesTab, versions: versionsTab })[current](el, ctx);
    } catch (e) { fill(el, h('div', { class: 'banner bad' }, e.message)); }
  }

  await ctx.load();
  fill(root, h('div', { class: 'page', style: 'max-width:1440px' }, head, jobBox, bar, body));
  current = tab || 'overview';
  drawHead(); drawJob(); show(tab, arg);
  state.onTab = (t, a) => show(t, a);
}

// ---- AI forms ----------------------------------------------------------------------------------
function buildForm(ctx, rebuild) {
  const model = ctx.modelSelect(), n = h('input', { type: 'number', min: 0, max: 15, value: 8, style: 'max-width:110px' });
  modal(rebuild ? 'Rebuild from scratch' : 'Build with AI', h('div', { class: 'stack' }, ctx.noModel(),
    rebuild ? h('div', { class: 'banner warn' }, 'The ontology is built again from the domain, scope, use cases, requirements and sources. Manual changes are not carried over — the current version stays available under Versions.') : null,
    h('div', { class: 'grid2' }, field('AI model', model), field('Extra use cases to write', n, 'on top of the required ones')),
    h('p', { class: 'small dim' }, 'Research of standards → class hierarchy → relationships and attributes → completeness review → explanation → use cases. A few minutes.')), {
    actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', disabled: !ctx.models.length, onclick: e => busy(e.target, async () => {
      await ctx.run('build', { model_id: Number(model.value), use_cases: Number(n.value) || 0 }); close();
    }) }, rebuild ? 'Rebuild' : '✨ Build')] });
}

function refineForm(ctx) {
  const model = ctx.modelSelect();
  const text = h('textarea', { rows: 6, placeholder: 'Describe the change in plain words.\ne.g. Add co-applicants and guarantors to a loan application, with their relationship to the applicant.\ne.g. Split Vehicle into Tractor and Implement, and record the dealer invoice for each.' });
  modal('Change the ontology with an instruction', h('div', { class: 'stack' }, ctx.noModel(), field('What should change?', text), field('AI model', model),
    h('p', { class: 'small dim' }, 'The AI adds, corrects or removes classes and properties accordingly and saves the result as a new version. Everything else is left untouched; you can restore the previous version at any time.')), {
    wide: true, actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', disabled: !ctx.models.length, onclick: e => busy(e.target, async () => {
      await ctx.run('refine', { model_id: Number(model.value), instruction: text.value }); close();
    }) }, 'Apply')] });
}

export function ucForm(ctx) {
  const model = ctx.modelSelect(), n = h('input', { type: 'number', min: 1, max: 15, value: 5, style: 'max-width:110px' });
  const focus = h('input', { type: 'text', placeholder: 'optional — e.g. risk and compliance questions' });
  modal('Write more use cases', h('div', { class: 'stack' }, ctx.noModel(), h('div', { class: 'grid2' }, field('How many', n), field('AI model', model)), field('Focus', focus)), {
    actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', disabled: !ctx.models.length, onclick: e => busy(e.target, async () => {
      await ctx.run('usecases', { model_id: Number(model.value), count: Number(n.value) || 5, focus: focus.value }); close(); ctx.go('usecases');
    }) }, 'Write')] });
}

function simpleRun(ctx, kind, title, text) {
  const model = ctx.modelSelect();
  modal(title, h('div', { class: 'stack' }, ctx.noModel(), h('p', {}, text), field('AI model', model)), {
    actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', disabled: !ctx.models.length, onclick: e => busy(e.target, async () => {
      await ctx.run(kind, { model_id: Number(model.value) }); close();
    }) }, 'Run')] });
}

async function settingsForm(ctx) {
  const o = ctx.o, lib = await api('GET', '/api/library').catch(() => ({ folders: [] }));
  const name = h('input', { type: 'text', value: o.name }), domain = h('input', { type: 'text', value: o.domain });
  const scope = h('textarea', { rows: 4 }, o.scope), reqs = h('textarea', { rows: 3 }, o.requirements), notes = h('textarea', { rows: 3 }, o.notes);
  const ucs = h('textarea', { rows: 4, placeholder: 'One per line' }, (o.seed_use_cases || []).join('\n'));
  const depth = select([['compact', 'Compact'], ['standard', 'Standard'], ['comprehensive', 'Comprehensive']], o.depth);
  const folder = select([['', '— no folder —'], ...lib.folders.filter(f => f.level !== 'view' || f.id === o.folder_id).map(f => [f.id, f.name])], o.folder_id || '', null, { disabled: !ctx.canManage });
  const vis = select([['private', 'Private — only me, administrators and people with access to its folder'], ['shared', 'Shared — everyone signed in can view it']], o.visibility, null, { disabled: !ctx.canManage });
  modal('Ontology settings', h('div', { class: 'stack' }, h('div', { class: 'grid2' }, field('Name', name), field('Domain', domain)), field('Scope', scope),
    field('Use cases it must answer', ucs, 'used when it is built or rebuilt'), field('Requirements', reqs), field('Reference notes', notes),
    h('div', { class: 'grid2' }, field('Size when built', depth), field('Folder', folder, ctx.canManage ? null : 'only the owner can move it')), field('Who can see it', vis),
    h('p', { class: 'small dim' }, `Owner: ${o.owner}. Access for specific people is given on the folder (Ontologies › folder › Access).`)), {
    wide: true, actions: close => [
      ctx.canManage ? h('button', { class: 'btn danger', style: 'margin-right:auto', onclick: async () => {
        if (!await confirmDialog('Delete this ontology?', `“${o.name}”, all its versions, sources and test results will be removed. This cannot be undone.`, 'Delete')) return;
        try { await api('DELETE', `/api/ontologies/${ctx.id}`); close(); location.hash = '#/library'; } catch (e) { fail(e); }
      } }, 'Delete ontology') : null,
      h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
        await api('PUT', `/api/ontologies/${ctx.id}`, { name: name.value, domain: domain.value, scope: scope.value, requirements: reqs.value, notes: notes.value,
          use_cases: ucs.value.split('\n').map(x => x.trim()).filter(Boolean), depth: depth.value, folder_id: folder.value ? Number(folder.value) : null, visibility: vis.value });
        close(); toast('Saved'); ctx.reload();
      }) }, 'Save')] });
}

// ---- Overview ----------------------------------------------------------------------------------
function overviewTab(el, ctx) {
  const o = ctx.o, c = ctx.c;
  if (!ctx.built) {
    const lb = o.last_build;
    const given = [o.domain && 'a domain', o.scope && 'a scope', (o.seed_use_cases || []).length && `${o.seed_use_cases.length} required use case(s)`, o.requirements && 'requirements',
      o.sources.schema && `${o.sources.schema} database schema(s)`, o.sources.document && `${o.sources.document} document(s)`].filter(Boolean);
    return fill(el, h('div', { class: 'card stack', style: 'max-width:820px' }, h('h2', {}, 'This ontology has not been built yet'),
      lb?.status === 'error' ? h('div', { class: 'banner bad' }, h('b', {}, 'The last build did not finish: '), lb.error) : null,
      h('p', {}, given.length ? `It will be built from: ${given.join(', ')}.` : 'Nothing has been said about it yet. Add a domain, use cases or requirements under Settings, or documents / a database under Sources.'),
      o.job ? h('p', { class: 'muted' }, 'A build is running — see the progress above.') : ctx.canEdit ? h('div', { class: 'row wrap' },
        h('button', { class: 'btn primary', onclick: () => buildForm(ctx, false) }, '✨ Build with AI'), h('button', { class: 'btn', onclick: () => ctx.go('sources') }, 'Add documents or a database'),
        h('button', { class: 'btn', onclick: () => ctx.go('diagram') }, 'Draw it by hand')) : null));
  }
  const ex = c.explanation, s = o.stats, q = o.quality;
  const kpi = (l, v, sub, tab) => h('div', { class: 'kpi', style: tab ? 'cursor:pointer' : null, onclick: tab ? () => ctx.go(tab) : null }, h('div', { class: 'l' }, l), h('div', { class: 'v' }, v), sub ? h('div', { class: 's' }, sub) : null);
  const list = xs => xs?.length ? h('ul', { class: 'bul' }, xs.map(x => h('li', {}, x))) : null;
  const editBtn = ctx.canEdit ? h('button', { class: 'btn sm', onclick: () => {
    const f = { summary: h('textarea', { rows: 5 }, ex.summary || ''), purpose: h('textarea', { rows: 4 }, ex.purpose || ''), how_to_read: h('textarea', { rows: 7 }, ex.how_to_read || ''),
      scope_in: h('textarea', { rows: 4 }, (ex.scope_in || []).join('\n')), scope_out: h('textarea', { rows: 3 }, (ex.scope_out || []).join('\n')) };
    modal('Edit the explanation', h('div', { class: 'stack' }, field('What it is', f.summary), field('Purpose', f.purpose), field('Covered', f.scope_in, 'one per line'),
      field('Not covered', f.scope_out, 'one per line'), field('How to read the model', f.how_to_read)), { wide: true, actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
        await ctx.edit({ explanation: { summary: f.summary.value, purpose: f.purpose.value, how_to_read: f.how_to_read.value,
          scope_in: f.scope_in.value.split('\n').filter(x => x.trim()), scope_out: f.scope_out.value.split('\n').filter(x => x.trim()) } }, 'Explanation edited');
        close(); overviewTab(el, ctx);
      }) }, 'Save')] });
  } }, '✎ Edit') : null;
  fill(el, h('div', { class: 'stack' },
    h('div', { class: 'kpis' }, kpi('Classes', s.classes, `${s.modules} modules · ${s.max_depth} levels deep`, 'model'), kpi('Relationships', s.object_properties, 'links between classes', 'diagram'),
      kpi('Attributes', s.data_properties, `${s.individuals} controlled values`, 'model'), kpi('Standards', s.standards, `${s.aligned_classes} classes aligned`, 'standards'),
      kpi('Use cases', s.use_cases, `${s.rules} rules`, 'usecases'), kpi('Quality', q.score + ' / 100', q.findings.length ? `${q.findings.length} findings` : 'no findings', 'quality')),
    h('div', { class: 'card prose' }, h('div', { class: 'row' }, h('h2', { style: 'margin:0;flex:1' }, 'What this ontology is'), editBtn),
      ex.summary ? h('p', {}, ex.summary) : h('p', { class: 'dim' }, 'No explanation has been written yet. Use ✨ AI › Rewrite the explanation, or ✎ Edit.'),
      ex.purpose ? [h('h3', {}, 'Purpose'), h('p', {}, ex.purpose)] : null,
      h('h3', {}, 'Scope'), h('p', {}, c.meta.scope || '—'),
      ex.scope_in?.length || ex.scope_out?.length ? h('div', { class: 'grid2' }, h('div', {}, h('b', {}, 'Covered'), list(ex.scope_in)), h('div', {}, h('b', {}, 'Not covered'), list(ex.scope_out))) : null,
      ex.how_to_read ? [h('h2', {}, 'How to read the model'), h('p', {}, ex.how_to_read)] : null,
      h('h2', {}, 'Modules'),
      c.modules.map((m, i) => h('div', { style: 'margin-bottom:12px' }, h('h3', { style: 'display:flex;gap:8px;align-items:center' }, h('i', { class: 'g' + (i % 9), style: 'width:13px;height:13px;border-radius:4px;border:1.5px solid;display:inline-block' }),
        m.name, h('span', { class: 'small dim', style: 'font-weight:400' }, `${c.classes.filter(k => k.module === m.id).length} classes`),
        h('a', { class: 'small', style: 'font-weight:400', href: `#/o/${ctx.id}/diagram/${m.id}` }, 'show diagram')),
        h('p', { style: 'margin:0' }, ex.module_notes?.[m.id] || m.description || ''))),
      ex.design_decisions?.length ? [h('h2', {}, 'Design decisions'), ex.design_decisions.map(d => [h('h3', {}, d.title), h('p', {}, d.text)])] : null,
      h('p', { class: 'small dim', style: 'margin-top:18px' }, `Identifiers start with ${c.meta.namespace} · built with ${o.model || 'manual editing'} · updated ${ago(o.updated_at)}`))));
}

// ---- Standards ---------------------------------------------------------------------------------
function standardsTab(el, ctx) {
  const c = ctx.c, REL = { high: 'good', medium: 'info', low: '' };
  const aligned = c.classes.filter(k => k.aligned_to);
  const HOW = { equivalent: 'same meaning as', subclass: 'a kind of', related: 'related to' };
  fill(el, h('div', { class: 'stack' },
    c.explanation.standards_approach ? h('div', { class: 'card prose' }, h('h2', { style: 'margin-top:0' }, 'How this ontology builds on published standards'), h('p', {}, c.explanation.standards_approach)) : null,
    h('div', { class: 'banner info' }, 'Standards marked ', h('b', {}, 'catalogue'), ' come from the application’s built-in list of published ontologies and standards; their links and namespaces are fixed. Standards marked ',
      h('b', {}, 'proposed by AI'), ' were added by the model. In both cases, confirm the reused terms against the publisher’s documentation before you publish.'),
    c.standards.length ? h('div', { class: 'std' }, c.standards.map(s => h('div', { class: 'card stack' },
      h('div', { class: 'row top' }, h('h2', { style: 'margin:0;flex:1' }, s.name), h('span', { class: 'badge ' + REL[s.relevance] }, s.relevance + ' relevance')),
      h('div', { class: 'small dim' }, [s.publisher, s.kind].filter(Boolean).join(' · '), ' · ', h('span', { class: 'badge ' + (s.in_catalogue ? '' : 'warn') }, s.in_catalogue ? 'catalogue' : 'proposed by AI — verify')),
      h('p', { style: 'margin:0' }, s.how_used),
      s.reused_terms.length ? h('div', {}, h('div', { class: 'small dim', style: 'margin-bottom:4px' }, 'Terms reused or aligned'), h('div', { class: 'terms' }, s.reused_terms.map(t => h('code', {}, t)))) : null,
      s.url ? h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', class: 'small' }, s.url) : null)))
      : h('div', { class: 'card empty' }, 'No standard is recorded for this ontology. Rebuild it with AI, or note the standards in the explanation.'),
    aligned.length ? h('div', {}, h('h2', {}, `Class alignment (${aligned.length} of ${c.classes.length} classes)`), h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['Class', 'is', 'Published term'].map(x => h('th', {}, x)))),
      h('tbody', {}, aligned.map(k => h('tr', {}, h('td', {}, h('b', {}, k.label)), h('td', { class: 'dim' }, HOW[k.alignment] || 'related to'), h('td', { class: 'mono' }, k.aligned_to))))))) : null));
}

// ---- Sources -----------------------------------------------------------------------------------
async function sourcesTab(el, ctx) {
  const data = await api('GET', `/api/ontologies/${ctx.id}/sources`);
  const status = h('div', {});
  const redraw = async () => { await ctx.load(); sourcesTab(el, ctx); };
  const add = async files => {
    files = files.filter(f => !f.name.startsWith('.') && !f.name.startsWith('~$'));
    fill(status, h('div', { class: 'banner info' }, h('span', { class: 'spinner' }), ' Uploading…'));
    const r = await uploadFiles(ctx.id, files, (n, t) => fill(status, h('div', { class: 'banner info' }, h('span', { class: 'spinner' }), ` Reading ${n} of ${t}…`)));
    await redraw();
    if (r.failed.length) modal('Some files were not added', failedList(r.failed)); else toast(`${r.added.length} source${r.added.length === 1 ? '' : 's'} added.`);
  };
  const db = dbForm();
  const connect = h('button', { class: 'btn primary', onclick: () => busy(connect, async () => {
    const v = db.value(); if (!v) throw new Error('Enter the host and the database name.');
    const s = await api('POST', `/api/ontologies/${ctx.id}/sources/database`, v); toast(`Read: ${s.note}`); redraw();
  }) }, 'Read the database structure');
  const view = async s => { const d = await api('GET', `/api/ontologies/${ctx.id}/sources/${s.id}`).catch(fail); if (d) modal(s.name, h('div', { class: 'stack' },
    h('div', { class: 'small dim' }, d.note), h('pre', { class: 'code', style: 'max-height:60vh' }, d.text + (d.truncated ? '\n…' : ''))), { wide: true }); };
  fill(el, h('div', { class: 'stack' },
    h('div', { class: 'banner info' }, 'Source material grounds the ontology in what you already have. It is read when the ontology is built — after adding or removing sources, use ',
      h('b', {}, '✨ AI › Rebuild from scratch'), ' (or Build, if it has not been built) for the change to take effect.',
      ctx.built && data.items.length ? ' To pull in something specific without rebuilding, use ✨ AI › Change it with an instruction.' : ''),
    status,
    data.items.length ? h('div', { class: 'tbl-wrap', style: 'max-height:none' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['Source', 'Kind', 'What was read', 'Added', ''].map(x => h('th', {}, x)))),
      h('tbody', {}, data.items.map(s => h('tr', {}, h('td', {}, h('b', {}, (s.kind === 'schema' ? '🗄 ' : '📄 ') + s.name)), h('td', {}, s.kind === 'schema' ? 'Database schema' : 'Document'),
        h('td', { class: 'small' }, `${s.chars.toLocaleString()} characters` + (s.note ? ` · ${s.note}` : '')), h('td', { class: 'small nowrap' }, `${fmtTime(s.at)} · ${s.added_by}`),
        h('td', { class: 'right nowrap' }, h('button', { class: 'btn sm', onclick: () => view(s) }, 'View text'), ' ',
          ctx.canEdit ? h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('Remove this source?', s.name, 'Remove')) { await api('DELETE', `/api/ontologies/${ctx.id}/sources/${s.id}`).catch(fail); redraw(); } } }, 'Remove') : null))))))
      : h('div', { class: 'card empty' }, 'No source material yet.'),
    ctx.canEdit ? h('div', { class: 'grid2', style: 'align-items:start' },
      h('div', { class: 'card stack' }, h('h2', {}, 'Add documents or a folder'), filePicker(add),
        h('p', { class: 'small dim' }, 'Policies, process descriptions, data dictionaries, report specifications, schema scripts, spreadsheets (headings and first rows are read).')),
      h('div', { class: 'card stack' }, h('h2', {}, 'Read a database'), db, h('div', {}, connect))) : null));
}

// ---- Versions ----------------------------------------------------------------------------------
async function versionsTab(el, ctx) {
  const vs = await api('GET', `/api/ontologies/${ctx.id}/versions`);
  if (!vs.length) return fill(el, h('div', { class: 'card empty' }, 'No version has been saved yet.'));
  const chips = (label, xs, cls) => xs?.length ? h('div', { class: 'small', style: 'margin-top:4px' }, h('span', { class: 'badge ' + cls }, `${label} ${xs.length}`), ' ',
    h('span', { class: 'dim' }, xs.slice(0, 14).join(', ') + (xs.length > 14 ? ' …' : ''))) : null;
  fill(el, h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Every change — by AI, on the diagram, or from the test bed — is saved as a new version. Restoring an older version creates a new one; nothing is lost.'),
    h('div', { class: 'card flush' }, vs.map((v, i) => h('div', { class: 'item' }, h('div', { class: 'row wrap top' },
      h('div', { style: 'flex:1;min-width:260px' }, h('div', { class: 'row wrap' }, h('b', {}, `Version ${v.number}`), i === 0 ? h('span', { class: 'badge good' }, 'current') : null,
        h('span', { class: 'small dim' }, `${fmtTime(v.at)} · ${v.author}`)), h('div', {}, v.note),
        h('div', { class: 'small dim' }, `${v.stats.classes} classes · ${(v.stats.object_properties || 0) + (v.stats.data_properties || 0)} properties · ${v.stats.use_cases} use cases`),
        v.diff ? [chips('added', [...v.diff.classes_added, ...v.diff.properties_added], 'good'), chips('removed', [...v.diff.classes_removed, ...v.diff.properties_removed], 'bad'), chips('changed', v.diff.changed, 'info')] : null),
      h('div', { class: 'row' }, ['ttl', 'owl', 'json'].map(f => h('a', { class: 'btn sm', href: `/api/ontologies/${ctx.id}/export/${f}?version=${v.number}` }, f.toUpperCase())),
        i > 0 && ctx.canEdit ? h('button', { class: 'btn sm', onclick: async () => {
          if (!await confirmDialog(`Restore version ${v.number}?`, 'The ontology goes back to this state, saved as a new version.', 'Restore', false)) return;
          try { await api('POST', `/api/ontologies/${ctx.id}/versions/${v.number}/restore`); toast('Restored.'); ctx.reload(); } catch (e) { fail(e); }
        } }, 'Restore') : null)))))));
}
