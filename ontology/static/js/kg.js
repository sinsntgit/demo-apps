// The knowledge graph of an ontology: how its classes and properties map onto the tables of its data sources,
// building the graph from their rows, data coverage, and a query console. The server checks every mapping entry
// and decides who sees records (app/routers/graph.py); this screen only shows what it is given.
import { h, fill, api, busy, fail, toast, modal, field, check, select, confirmDialog, fmtTime } from './core.js';
import { diagram } from './diagram.js';

const anc = (ctx, id) => { const out = []; let cur = ctx.c.classes.find(k => k.id === id)?.parent; while (cur && !out.includes(cur)) { out.push(cur); cur = ctx.c.classes.find(k => k.id === cur)?.parent; } return out; };
const isA = (ctx, a, b) => a === b || anc(ctx, a).includes(b);
const fits = (ctx, cls, p) => p.domain === cls || anc(ctx, cls).includes(p.domain);
const clsLabel = (ctx, id) => ctx.c.classes.find(k => k.id === id)?.label || id;
const propLabel = (ctx, id) => ctx.c.properties.find(p => p.id === id)?.label || id;
const n = v => (v ?? 0).toLocaleString();

/** A query result (from the console or the test bed): table, count, picture of the records. */
export function resultView(ctx, res, opts = {}) {
  if (!res) return null;
  const meaning = opts.meaning || {};
  const cell = c => c == null ? h('span', { class: 'dim' }, '—') : c.t === 'iri' ? h('span', { title: c.iri }, c.v) : h('span', { title: c.dt ? `${c.dt}` : null }, c.v);
  const more = res.more ? `more than ${n(res.count)}` : n(res.count);
  return h('div', { class: 'stack' },
    h('div', { class: 'small muted' }, res.kind === 'ask' ? `Answer: ${res.value ? 'yes' : 'no'}` :
      `${more} row${res.count === 1 ? '' : 's'}` + (res.shown < res.count ? ` — the first ${n(res.shown)} are shown` : '') + (res.seconds != null ? ` · ${res.seconds} s` : '')),
    res.rows.length ? h('div', { class: 'tbl-wrap', style: 'max-height:420px' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, res.columns.map(c => h('th', { title: meaning[c] || null }, c, meaning[c] ? h('div', { class: 'small dim', style: 'font-weight:400' }, meaning[c]) : null)))),
      h('tbody', {}, res.rows.map(r => h('tr', {}, r.map(c => h('td', {}, cell(c)))))))) : h('div', { class: 'banner warn' }, 'The query ran and found nothing.'),
    res.picture && res.picture.nodes.length ? h('div', {}, h('h3', {}, 'The records behind the answer'),
      h('p', { class: 'small dim', style: 'margin:0 0 6px' }, 'Highlighted: records in the answer. Plain: records they link to. One colour per class.'),
      diagram(res.picture, { maxHeight: opts.height || 460 })) : null);
}

/** Classes / properties a query or test needs that the graph holds nothing for. */
export function noDataView(ctx, list) {
  if (!list?.length) return null;
  return h('div', { class: 'banner warn' }, h('b', {}, 'No data in the knowledge graph for: '), list.map(x => x.label).join(', '),
    '. The ontology has them, but nothing is mapped to them (or the mapped columns are empty) — see the ', h('a', { href: `#/o/${ctx.id}/graph` }, 'Knowledge graph'), ' tab.');
}

export async function graphTab(el, ctx) {
  let g;
  try { g = await api('GET', `/api/ontologies/${ctx.id}/graph`); } catch (e) { return fill(el, h('div', { class: 'banner bad' }, e.message)); }
  const redraw = () => graphTab(el, ctx);
  const maps = g.mapping.maps, st = g.stats, cov = g.coverage;
  const byId = Object.fromEntries(maps.map(m => [m.id, m]));
  const save = async (mapping, msg) => {
    const r = await api('PUT', `/api/ontologies/${ctx.id}/graph/mapping`, { mapping });
    if (r.saved_problems?.length) modal('Saved, with entries left out', h('ul', { class: 'bul' }, r.saved_problems.map(p => h('li', {}, p))));
    else if (msg) toast(msg);
    redraw();
  };

  if (!g.sources.length) return fill(el, h('div', { class: 'stack' }, intro(),
    h('div', { class: 'card empty' }, 'This ontology uses no data source yet. Add one on the ', h('a', { href: `#/o/${ctx.id}/sources` }, 'Sources'),
      ' tab (a database, or uploaded datasets), then map the classes onto its tables here.')));

  // ---- status -------------------------------------------------------------------------------------
  const busyJob = g.job;
  const buildBtn = g.can_edit && maps.length && !busyJob ? h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
    await api('POST', `/api/ontologies/${ctx.id}/graph/build`); toast('Building the knowledge graph…'); await ctx.reload();
  }) }, g.status === 'ready' ? '↻ Build again from the data' : '▶ Build the knowledge graph') : null;
  const kpi = (l, v, s) => h('div', { class: 'kpi' }, h('div', { class: 'l' }, l), h('div', { class: 'v' }, v), s ? h('div', { class: 's' }, s) : null);
  const status = h('div', { class: 'card stack' },
    h('div', { class: 'row wrap' }, h('h2', { style: 'margin:0;flex:1' }, 'Knowledge graph'),
      g.status === 'ready' ? h('span', { class: 'badge good' }, 'Built') : busyJob ? h('span', { class: 'badge info' }, 'Working…') : h('span', { class: 'badge' }, 'Not built yet'),
      buildBtn,
      g.can_edit && g.status === 'ready' && !busyJob ? h('button', { class: 'btn ghost', title: 'Delete the graph (its copy of the data). The mapping stays.', onclick: async () => {
        if (await confirmDialog('Delete the knowledge graph?', 'Its copy of the data is deleted. The mapping is kept, so you can build it again at any time.', 'Delete')) {
          await api('DELETE', `/api/ontologies/${ctx.id}/graph`).catch(fail); redraw();
        } } }, 'Delete graph') : null),
    busyJob ? h('div', { class: 'banner info' }, h('span', { class: 'spinner' }), ` ${busyJob.kind === 'map' ? 'The AI is proposing a mapping' : 'Building'}: ${busyJob.stage || 'starting'} — progress is shown above.`) : null,
    g.last_job?.status === 'error' ? h('div', { class: 'banner bad' }, h('b', {}, g.last_job.kind === 'map' ? 'The mapping proposal did not finish: ' : 'The last build did not finish: '), g.last_job.error) : null,
    !g.can_see_data ? h('div', { class: 'banner warn' }, 'You see how the graph is made, not its records: it holds data from ', g.blocked.join(', '),
      ', which you have no access to. Ask the data source’s owner for access.') : null,
    g.status === 'ready' && st ? [
      h('div', { class: 'kpis' }, kpi('Records', n(st.records)), kpi('Facts', n(st.facts), 'statements in the graph'),
        kpi('Tables read', n(st.tables.length), st.tables.some(t => t.capped) ? 'some in part' : 'in full'),
        kpi('Classes with data', `${cov.classes_with_data ?? '–'} of ${cov.classes}`), kpi('Built', `version ${g.built_version}`, `${fmtTime(g.built_at)} · ${g.built_by}`)),
      g.stale.map(s => h('div', { class: 'banner warn' }, s, ' Build again to bring the graph up to date.')),
      st.notes.length ? h('div', { class: 'banner info' }, h('ul', { class: 'bul', style: 'margin:0' }, st.notes.map(x => h('li', {}, x)))) : null]
      : h('p', { class: 'muted', style: 'margin:0' }, maps.length ? 'The mapping is ready to use: build the graph to load the records.' : 'Start by mapping classes onto tables below.'));

  // ---- mapping ------------------------------------------------------------------------------------
  const propose = () => {
    const model = ctx.modelSelect(), replace = check('Replace earlier AI drafts', false, null, 'Mappings you confirmed are always kept.');
    modal('Propose a mapping with AI', h('div', { class: 'stack' },
      h('p', {}, 'The AI reads the ontology and the profiles of the tables (structure, statistics and — where the data source allows — a few sample values, the same as for a build) and proposes which table holds each class and which columns hold its properties. Every entry is checked against the ontology and the tables; you then review it.'),
      ctx.noModel(), field('AI model', model), replace), { actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'),
      h('button', { class: 'btn primary', disabled: !ctx.models.length, onclick: e => busy(e.target, async () => {
        await api('POST', `/api/ontologies/${ctx.id}/graph/propose`, { model_id: Number(model.value), replace_drafts: replace.input.checked });
        close(); toast('The AI is proposing a mapping…'); await ctx.reload();
      }) }, 'Propose')] });
  };
  const match = e => busy(e.target, async () => {
    const r = await api('POST', `/api/ontologies/${ctx.id}/graph/match`, {});
    toast(r.added ? `${r.added} class mapping(s) added from matching names — check them.` : 'Nothing new matched by name.'); redraw();
  });
  const summary = m => {
    const bits = [];
    if (m.attributes.length) bits.push(`${m.attributes.length} attribute${m.attributes.length === 1 ? '' : 's'}`);
    if (m.values.length) bits.push(`${m.values.length} controlled value${m.values.length === 1 ? '' : 's'}`);
    if (m.links.length) bits.push(m.links.map(l => `${propLabel(ctx, l.property)} → ${clsLabel(ctx, byId[l.to]?.class)}`).join(', '));
    return bits.join(' · ') || h('span', { class: 'dim' }, 'records only');
  };
  const mapRow = m => {
    const s = st?.maps?.find(x => x.id === m.id);
    return h('tr', {},
      h('td', {}, h('b', {}, clsLabel(ctx, m.class)), m.ai ? h('span', { class: 'badge warn', style: 'margin-left:6px', title: 'Proposed automatically: check it, then confirm' }, 'draft') : null),
      h('td', { class: 'small' }, m.table, h('div', { class: 'dim' }, g.sources.find(d => d.id === m.source)?.name || ''),
        m.where.column ? h('div', { class: 'dim' }, `only rows where ${m.where.column} = “${m.where.value}”`) : null),
      h('td', { class: 'small' }, m.key || h('span', { class: 'dim' }, 'row number'), m.label ? h('div', { class: 'dim' }, `named by ${m.label}`) : null),
      h('td', { class: 'small' }, summary(m)),
      h('td', { class: 'num' }, s ? n(s.records) : '—'),
      g.can_edit ? h('td', { class: 'right nowrap' },
        m.ai ? h('button', { class: 'btn sm', title: 'Mark as checked', onclick: e => busy(e.target, () => save({ maps: maps.map(x => x.id === m.id ? { ...x, ai: false } : x) }, 'Confirmed.')) }, '✓ Confirm') : null, ' ',
        h('button', { class: 'btn sm', onclick: () => mapForm(ctx, g, m, save) }, 'Edit'), ' ',
        h('button', { class: 'btn sm ghost', title: 'Remove', onclick: async () => {
          if (await confirmDialog('Remove this mapping?', `${clsLabel(ctx, m.class)} ← ${m.table}. Relationships to it from other mappings go too.`, 'Remove'))
            save({ maps: maps.filter(x => x.id !== m.id).map(x => ({ ...x, links: x.links.filter(l => l.to !== m.id) })) }, 'Removed.');
        } }, '✕')) : null);
  };
  const mapping = h('div', { class: 'card stack' },
    h('div', { class: 'row wrap' }, h('div', { style: 'flex:1;min-width:240px' }, h('h2', { style: 'margin:0' }, 'Mapping'),
      h('div', { class: 'small muted' }, cov ? `${cov.classes_mapped} of ${cov.classes} classes and ${cov.properties_mapped} of ${cov.properties} properties have a source (classes with controlled values count as covered).` : '')),
      g.can_edit ? [h('button', { class: 'btn', onclick: () => mapForm(ctx, g, null, save) }, '＋ Map a class'),
        h('button', { class: 'btn', title: 'Match tables and columns to classes and properties by their names (no AI)', onclick: match }, 'Match by names'),
        h('button', { class: 'btn primary', disabled: !!busyJob, onclick: propose }, '✨ Propose with AI')] : null),
    maps.length ? h('div', { class: 'tbl-wrap', style: 'max-height:none' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['Class', 'Table', 'Identified by', 'What it provides', 'Records', g.can_edit ? '' : null].filter(x => x != null).map(x => h('th', {}, x)))),
      h('tbody', {}, maps.map(mapRow)))) : h('div', { class: 'empty', style: 'padding:14px' }, 'Nothing is mapped yet. “Match by names” and “Propose with AI” make a first draft for you to check.'),
    maps.some(m => m.ai) ? h('div', { class: 'small dim' }, 'Drafts were proposed automatically. Check that each table really holds that class and that the columns mean what the properties say, then confirm.') : null,
    g.last_job?.kind === 'map' && g.last_job.status === 'done' && (g.last_job.result.problems.length || g.last_job.result.notes.length) ? h('details', {},
      h('summary', { style: 'cursor:pointer;color:var(--warn)' }, `From the AI proposal: ${g.last_job.result.problems.length} entr${g.last_job.result.problems.length === 1 ? 'y was' : 'ies were'} left out of the mapping` + (g.last_job.result.notes.length ? ', and notes from the AI' : '')),
      h('ul', { class: 'bul small' }, g.last_job.result.problems.map(p => h('li', {}, p)), g.last_job.result.notes.map(p => h('li', { class: 'muted' }, 'AI: ' + p)))) : null,
    g.problems.length ? h('details', {},h('summary', { style: 'cursor:pointer;color:var(--warn)' }, `${g.problems.length} entr${g.problems.length === 1 ? 'y was' : 'ies were'} left out of the mapping`),
      h('ul', { class: 'bul small' }, g.problems.map(p => h('li', {}, p)))) : null,
    cov?.unmapped_classes.length ? h('details', {}, h('summary', { style: 'cursor:pointer;color:var(--accent)' }, `${cov.unmapped_classes.length} classes have no source`),
      h('p', { class: 'small muted' }, cov.unmapped_classes.map(x => clsLabel(ctx, x)).join(', '))) : null);

  // ---- data coverage --------------------------------------------------------------------------------
  const issues = st?.maps?.flatMap(s => {
    const out = [];
    const m = byId[s.id], who = `${clsLabel(ctx, s.class)} (${s.table})`;
    if (s.error) out.push(`${who}: the table could not be read.`);
    if (s.no_key) out.push(`${who}: ${n(s.no_key)} row(s) without a value in the identifying column were left out.`);
    if (s.duplicates) out.push(`${who}: ${n(s.duplicates)} row(s) repeat an identifier that was already loaded; the first was kept.`);
    if (s.masked?.length) out.push(`${who}: ${[...new Set(s.masked)].join(', ')} look like personal data and were not loaded (the data source’s owner can allow it).`);
    for (const [p, v] of Object.entries(s.values || {})) if (v.unmatched) out.push(`${who}: ${n(v.unmatched)} value(s) of ${propLabel(ctx, p)} match no controlled value of the ontology` + (v.examples.length ? ` (e.g. ${v.examples.map(x => `“${x}”`).join(', ')})` : '') + '.');
    for (const [p, v] of Object.entries(s.links || {})) if (v.dangling) out.push(`${who}: ${n(v.dangling)} ${propLabel(ctx, p)} link(s) point to ${clsLabel(ctx, v.to)} records that are not in the graph.`);
    for (const [p, v] of Object.entries(s.bad_values || {})) out.push(`${who}: ${n(v)} value(s) of ${propLabel(ctx, p)} do not fit its type and were kept as text.`);
    return m ? out : [];
  }) || [];
  const coverage = g.status === 'ready' && st ? h('div', { class: 'card stack' }, h('h2', { style: 'margin:0' }, 'What is in the graph'),
    issues.length ? h('div', { class: 'banner warn' }, h('b', {}, 'Worth checking'), h('ul', { class: 'bul', style: 'margin:4px 0 0' }, issues.map(x => h('li', {}, x)))) : h('div', { class: 'banner good' }, 'Every mapped row and link was loaded.'),
    h('div', { class: 'grid2', style: 'align-items:start' },
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, h('th', {}, 'Class'), h('th', { class: 'num' }, 'Records'))),
        h('tbody', {}, ctx.c.classes.filter(k => st.classes[k.id]).sort((a, b) => st.classes[b.id] - st.classes[a.id]).map(k => h('tr', {}, h('td', {}, k.label), h('td', { class: 'num' }, n(st.classes[k.id]))))))),
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, h('th', {}, 'Property'), h('th', { class: 'num' }, 'Values / links'))),
        h('tbody', {}, ctx.c.properties.filter(p => st.properties[p.id]).sort((a, b) => st.properties[b.id] - st.properties[a.id]).map(p => h('tr', {}, h('td', {}, p.label, h('span', { class: 'small dim' }, ` (${clsLabel(ctx, p.domain)})`)), h('td', { class: 'num' }, n(st.properties[p.id])))))))),
    h('details', {}, h('summary', { style: 'cursor:pointer;color:var(--accent)' }, 'Tables read'), h('ul', { class: 'bul small' },
      st.tables.map(t => h('li', {}, `${t.source} / ${t.table}: ${n(t.read)} of ${n(t.total)} rows`, t.capped ? h('span', { style: 'color:var(--warn)' }, ` (limit ${n(st.rows_per_table)} per table)`) : null))))) : null;

  fill(el, h('div', { class: 'stack' }, intro(), status, mapping, coverage, g.status === 'ready' && g.can_see_data ? consoleCard(ctx, g) : null));
}

function intro() {
  return h('p', { class: 'muted', style: 'margin:0' }, 'The knowledge graph is this ontology filled with your actual records: each class is mapped to the table that holds it, each attribute to a column, each relationship to a join. Build it, then ask questions of it here or in the Test bed — the answers come from your data. Query results are never sent to an AI model.');
}

// ---- the query console ---------------------------------------------------------------------------------
function consoleCard(ctx, g) {
  const first = g.mapping.maps[0];
  const example = first ? `SELECT ?record ?name WHERE {\n  ?record a :${first.class} ;\n          rdfs:label ?name .\n}\nLIMIT 50` : 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 50';
  const preset = sessionStorage.getItem('onto-graph-query');
  if (preset) sessionStorage.removeItem('onto-graph-query');
  const text = h('textarea', { rows: 8, class: 'mono', spellcheck: 'false', style: 'font-family:var(--mono, monospace);font-size:13px' }, preset || example);
  const out = h('div', {});
  const run = h('button', { class: 'btn primary', onclick: () => busy(run, async () => {
    fill(out, h('div', { class: 'row' }, h('span', { class: 'spinner' }), ' Running…'));
    try {
      const r = await api('POST', `/api/ontologies/${ctx.id}/graph/query`, { sparql: text.value });
      fill(out, h('div', { class: 'stack' }, noDataView(ctx, r.no_data), resultView(ctx, r)));
    } catch (e) { fill(out, h('div', { class: 'banner bad' }, e.message)); }
  }) }, '▶ Run query');
  const pre = Object.entries(g.prefixes).map(([k, v]) => `${k}: <${v}>`).join('   ');
  const examples = [['', '— an example —'], ...g.mapping.maps.slice(0, 8).map(m => [m.id, `Records of ${clsLabel(ctx, m.class)}`])];
  const pick = select(examples, '', v => {
    const m = g.mapping.maps.find(x => x.id === v); if (!m) return;
    const attrs = m.attributes.slice(0, 3), links = m.links.slice(0, 1);
    text.value = `SELECT ?record ?name${attrs.map((a, i) => ` ?v${i + 1}`).join('')}${links.length ? ' ?linked' : ''} WHERE {\n  ?record a :${m.class} ;\n          rdfs:label ?name .\n` +
      attrs.map((a, i) => `  OPTIONAL { ?record :${a.property} ?v${i + 1} }   # ${propLabel(ctx, a.property)}\n`).join('') +
      links.map(l => `  OPTIONAL { ?record :${l.property} ?l . ?l rdfs:label ?linked }   # ${propLabel(ctx, l.property)}\n`).join('') + '}\nLIMIT 50';
  }, { class: 'inline', style: 'max-width:280px' });
  return h('div', { class: 'card stack' }, h('div', { class: 'row wrap' }, h('h2', { style: 'margin:0;flex:1' }, 'Ask the graph (SPARQL)'), pick),
    h('p', { class: 'small muted', style: 'margin:0' }, 'Questions only (SELECT, ASK, CONSTRUCT, DESCRIBE): the graph cannot be changed by a query, and it never calls other servers. Every record has the type of its class and of all its parent classes, and a name (rdfs:label). Predefined prefixes: ', h('span', { class: 'mono small' }, pre)),
    text, h('div', { class: 'row' }, run), out);
}

// ---- the form for one class mapping -------------------------------------------------------------------
function mapForm(ctx, g, m0, save) {
  const maps = g.mapping.maps;
  const m = m0 ? JSON.parse(JSON.stringify(m0)) : { id: '', class: '', item: null, source: null, table: '', key: '', label: '', where: { column: '', value: '' }, attributes: [], values: [], links: [] };
  const box = h('div', { class: 'stack' });
  const tableOf = item => g.tables.find(t => t.item === Number(item));
  const coded = new Set(ctx.c.individuals.map(i => i.type));
  const hasValues = rng => ctx.c.individuals.some(i => isA(ctx, i.type, rng));
  function draw() {
    const t = tableOf(m.item);
    const cols = t ? t.columns : [];
    const colSel = (value, on, none = '— none —') => select([['', none], ...cols.map(c => [c.name, c.name + (c.personal ? ' (personal)' : '') + (c.pk ? ' (key)' : '')])], value, on, { class: 'inline' });
    const props = m.class ? ctx.c.properties.filter(p => fits(ctx, m.class, p)) : [];
    const data = props.filter(p => p.kind === 'data');
    const vals = props.filter(p => p.kind === 'object' && hasValues(p.range));
    const rels = props.filter(p => p.kind === 'object' && maps.some(x => x.id !== m.id && isA(ctx, x.class, p.range)));
    const get = (list, pid) => list.find(x => x.property === pid);
    const setPair = (list, pid, col) => { const i = list.findIndex(x => x.property === pid); if (i >= 0) list.splice(i, 1); if (col) list.push({ property: pid, column: col }); };
    fill(box,
      h('div', { class: 'grid2' },
        field('Class', select([['', '— choose —'], ...ctx.c.classes.slice().sort((a, b) => a.label.localeCompare(b.label)).map(k => [k.id, k.label + (coded.has(k.id) ? ' (has controlled values)' : '')])], m.class, v => { m.class = v; m.attributes = []; m.values = []; m.links = []; draw(); })),
        field('Table that holds its records', select([['', '— choose —'], ...g.tables.map(t => [t.item, `${t.source_name} / ${t.table}` + (t.rows != null ? ` (${t.rows.toLocaleString()} rows)` : '') + (t.readable ? '' : ' — upload again')])], m.item || '', v => {
          const tt = tableOf(v); m.item = tt?.item || null; m.source = tt?.source || null; m.table = tt?.table || '';
          m.key = tt?.columns.find(c => c.pk)?.name || tt?.columns.find(c => c.role === 'identifier')?.name || ''; m.label = ''; m.attributes = []; m.values = []; m.where = { column: '', value: '' }; draw();
        }))),
      t && !t.readable ? h('div', { class: 'banner warn' }, 'This file was uploaded before files were kept. Upload it again on its data source (same name) before building.') : null,
      t ? h('div', { class: 'grid2' },
        field('Column that identifies a record', colSel(m.key, v => { m.key = v; }, '— none: number the rows —'), 'unique; other tables refer to it'),
        field('Column that names a record', colSel(m.label, v => { m.label = v; }, '— use the identifier —'), 'shown in answers and pictures')) : null,
      t ? h('details', { open: !!m.where.column }, h('summary', { style: 'cursor:pointer;color:var(--accent)' }, 'Only some rows of the table are this class'),
        h('div', { class: 'row wrap', style: 'margin-top:8px' }, h('span', { class: 'small' }, 'Rows where'), colSel(m.where.column, v => { m.where.column = v; }, '— all rows —'),
          h('span', { class: 'small' }, 'is'), h('input', { type: 'text', value: m.where.value, style: 'max-width:200px', oninput: e => { m.where.value = e.target.value; } }))) : null,
      t && data.length ? h('div', {}, h('h3', {}, 'Attributes'), h('div', { class: 'tbl-wrap', style: 'max-height:300px' }, h('table', { class: 'tbl' },
        h('tbody', {}, data.map(p => h('tr', {}, h('td', {}, p.label, h('div', { class: 'small dim' }, `${p.range}${p.domain !== m.class ? ' · from ' + clsLabel(ctx, p.domain) : ''}`)),
          h('td', {}, colSel(get(m.attributes, p.id)?.column || '', v => setPair(m.attributes, p.id, v))))))))) : null,
      t && vals.length ? h('div', {}, h('h3', {}, 'Controlled values'), h('p', { class: 'small dim', style: 'margin:0 0 6px' }, 'A code column whose values are matched to the ontology’s controlled values (by name or id).'),
        h('table', { class: 'tbl' }, h('tbody', {}, vals.map(p => h('tr', {}, h('td', {}, p.label, h('div', { class: 'small dim' }, ctx.c.individuals.filter(i => isA(ctx, i.type, p.range)).map(i => i.label).slice(0, 8).join(', '))),
          h('td', {}, colSel(get(m.values, p.id)?.column || '', v => setPair(m.values, p.id, v)))))))) : null,
      t && rels.length ? h('div', {}, h('h3', {}, 'Relationships'), h('p', { class: 'small dim', style: 'margin:0 0 6px' }, 'How a record finds the records it is linked to: a column here holding their identifier, a column in their table holding this record’s identifier, or a separate link table.'),
        h('table', { class: 'tbl' }, h('tbody', {}, rels.map(p => linkRow(ctx, g, m, p))))) : null,
      m.class && t && !data.length && !rels.length && !vals.length ? h('p', { class: 'small dim' }, 'This class has no properties to map; its records are still loaded.') : null);
  }
  draw();
  modal(m0 ? `Mapping of ${clsLabel(ctx, m0.class)}` : 'Map a class to a table', box, { wide: true, actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
      if (!m.class || !m.item) throw new Error('Choose the class and the table.');
      const out = { ...m, ai: false, links: m.links.filter(l => l.to && l.column && (l.side !== 'link' || (l.link_item && l.to_column))) };
      const list = m0 ? maps.map(x => x.id === m0.id ? out : x) : [...maps, { ...out, id: '' }];
      await save({ maps: list }, 'Mapping saved.'); close();
    }) }, 'Save')] });
}

function linkRow(ctx, g, m, p) {
  const targets = g.mapping.maps.filter(x => x.id !== m.id && isA(ctx, x.class, p.range));
  const cur = () => m.links.find(l => l.property === p.id);
  const cell = h('td', {});
  const set = patch => {
    const i = m.links.findIndex(l => l.property === p.id);
    const base = i >= 0 ? m.links[i] : { property: p.id, to: targets[0]?.id, side: 'from', column: '', link_item: null, link_table: '', to_column: '' };
    const next = { ...base, ...patch };
    if (i >= 0) m.links.splice(i, 1);
    m.links.push(next);                                   // incomplete ones are dropped when the form is saved
    paint();
  };
  const colsOf = item => g.tables.find(t => t.item === Number(item))?.columns || [];
  function paint() {
    const l = cur() || { to: targets[0]?.id, side: 'from', column: '', link_item: null, to_column: '' };
    const target = g.mapping.maps.find(x => x.id === l.to);
    const here = colsOf(m.item), there = target ? colsOf(target.item) : [];
    const cols = l.side === 'to' ? there : l.side === 'link' ? colsOf(l.link_item) : here;
    const colSel = (v, on) => select([['', '— not linked —'], ...cols.map(c => [c.name, c.name + (c.ref ? ` → ${c.ref}` : '')])], v, on, { class: 'inline' });
    fill(cell, h('div', { class: 'row wrap' },
      targets.length > 1 ? select(targets.map(x => [x.id, `${clsLabel(ctx, x.class)} (${x.table})`]), l.to, v => set({ to: v }), { class: 'inline' }) : h('span', { class: 'small' }, `${clsLabel(ctx, target?.class)} (${target?.table})`),
      select([['from', 'column in this table'], ['to', `column in ${target?.table || 'their table'}`], ['link', 'a link table']], l.side, v => set({ side: v, column: '', to_column: '' }), { class: 'inline' }),
      l.side === 'link' ? select([['', '— link table —'], ...g.tables.map(t => [t.item, `${t.source_name} / ${t.table}`])], l.link_item || '', v => set({ link_item: Number(v) || null, link_table: g.tables.find(t => t.item === Number(v))?.table || '', column: '', to_column: '' }), { class: 'inline' }) : null,
      colSel(l.column, v => set({ column: v })),
      l.side === 'link' ? [h('span', { class: 'small dim' }, 'and'), select([['', '— their identifier —'], ...cols.map(c => [c.name, c.name])], l.to_column, v => set({ to_column: v }), { class: 'inline' })] : null));
  }
  paint();
  return h('tr', {}, h('td', {}, p.label, h('div', { class: 'small dim' }, `→ ${clsLabel(ctx, p.range)}`)), cell);
}
