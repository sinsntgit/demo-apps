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
      diagram(res.picture, { maxHeight: opts.height || 460, onNode: opts.onRecord ? nd => { if (!String(nd.id).startsWith('more:')) opts.onRecord(nd.id); } : null })) : null,
    evidenceView(res.evidence));
}

/** Where facts taken from documents come from: document, page, quote. */
export function evidenceView(ev) {
  if (!ev?.length) return null;
  return h('div', {}, h('h3', {}, 'Sources in the documents'), h('ul', { class: 'bul small' }, ev.map(e => h('li', {}, h('b', {}, e.entity), ` — ${e.document}` + (e.page ? `, page ${e.page}` : '') + ': ',
    h('span', { class: 'muted' }, `“${e.quote}”`)))));
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

  if (!g.sources.length && !g.documents.length && g.can_see_data) return fill(el, h('div', { class: 'stack' }, intro(),
    h('div', { class: 'card empty' }, 'This ontology uses no data source yet. Add one on the ', h('a', { href: `#/o/${ctx.id}/sources` }, 'Sources'),
      ' tab — a database or uploaded datasets to map onto, or documents (judgments, opinions, contracts…) for the AI to read — then build the graph here.')));

  // ---- status -------------------------------------------------------------------------------------
  const busyJob = g.job;
  const accepted = g.extracted?.accepted || 0;
  const live = g.storage === 'live';
  const buildBtn = g.can_edit && (maps.length || accepted) && !busyJob ? h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
    await api('POST', `/api/ontologies/${ctx.id}/graph/build`); toast('Building the knowledge graph…'); await ctx.reload();
  }) }, live ? (g.status === 'ready' ? '↻ Read the sources now' : '▶ Check the mapping and count') : g.status === 'ready' ? '↻ Build again from the data' : '▶ Build the knowledge graph') : null;
  const kpi = (l, v, s) => h('div', { class: 'kpi' }, h('div', { class: 'l' }, l), h('div', { class: 'v' }, v), s ? h('div', { class: 's' }, s) : null);
  const status = h('div', { class: 'card stack' },
    h('div', { class: 'row wrap' }, h('h2', { style: 'margin:0;flex:1' }, 'Knowledge graph'),
      g.status === 'ready' ? h('span', { class: 'badge good' }, live ? 'Live — nothing stored' : 'Built') : busyJob ? h('span', { class: 'badge info' }, 'Working…') : h('span', { class: 'badge' }, 'Not built yet'),
      buildBtn,
      g.can_edit && g.status === 'ready' && !busyJob ? h('button', { class: 'btn ghost', title: 'Delete the graph (its copy of the data). The mapping stays.', onclick: async () => {
        if (await confirmDialog('Delete the knowledge graph?', 'Its copy of the data is deleted. The mapping is kept, so you can build it again at any time.', 'Delete')) {
          await api('DELETE', `/api/ontologies/${ctx.id}/graph`).catch(fail); redraw();
        } } }, 'Delete graph') : null),
    busyJob ? h('div', { class: 'banner info' }, h('span', { class: 'spinner' }), ` ${{ map: 'The AI is proposing a mapping', extract: 'The AI is reading documents' }[busyJob.kind] || 'Building'}: ${busyJob.stage || 'starting'} — progress is shown above.`) : null,
    g.last_job?.status === 'error' ? h('div', { class: 'banner bad' }, h('b', {}, { map: 'The mapping proposal did not finish: ', extract: 'Reading the documents did not finish: ' }[g.last_job.kind] || 'The last build did not finish: '), g.last_job.error) : null,
    g.last_job?.status === 'cancelled' ? h('div', { class: 'banner info' }, `${g.last_job.error} `, g.last_job.kind === 'graph' ? (g.status === 'ready' ? 'The graph is as it was before that build.' : 'Nothing was built.') : '') : null,
    g.error && !g.last_job?.error ? h('div', { class: 'banner warn' }, g.error) : null,
    g.can_edit ? storageRow(ctx, g, redraw) : h('div', { class: 'small muted' }, live ? 'Live: the data is read from the sources whenever the graph is used; no copy is kept on this server.' : 'A copy of the data is kept on this server and refreshed when the graph is built again.'),
    g.status === 'ready' || g.can_edit ? h('div', { class: 'row wrap small' },
      g.can_edit && !live ? [h('span', { class: 'muted' }, 'Rebuild from the data automatically:'), select([['', 'never'], ['daily', 'every night (02:00)'], ['weekly', 'every week']], g.refresh, async v => {
        try { await api('PUT', `/api/ontologies/${ctx.id}/graph/refresh`, { refresh: v }); toast(v ? 'Scheduled. It runs with your access to the data sources.' : 'Schedule switched off.'); redraw(); } catch (e) { fail(e); }
      }, { class: 'inline' }), g.next_refresh_at ? h('span', { class: 'dim' }, `next: ${fmtTime(g.next_refresh_at)}`) : null] : g.refresh ? h('span', { class: 'muted' }, `Rebuilt automatically ${g.refresh === 'daily' ? 'every night' : 'every week'}.`) : null,
      h('span', { class: 'spacer' }),
      g.status === 'ready' && g.can_see_data ? h('a', { class: 'btn sm', href: `/api/ontologies/${ctx.id}/graph/export/ttl`, title: 'The ontology and all its records, for a triple store' }, '⬇ Graph (Turtle)') : null,
      maps.length ? h('a', { class: 'btn sm', href: `/api/ontologies/${ctx.id}/graph/export/r2rml`, title: 'The mapping in the W3C R2RML standard, for other tools' }, '⬇ Mapping (R2RML)') : null) : null,
    !g.can_see_data ? h('div', { class: 'banner warn' }, 'You see how the graph is made, not its records: it holds data from ', g.blocked.join(', '),
      ', which you have no access to. Ask the data source’s owner for access.') : null,
    g.status === 'ready' && st ? [
      h('div', { class: 'kpis' }, kpi('Records', n(st.records)), kpi('Facts', n(st.facts), 'statements in the graph'),
        kpi('Tables read', n(st.tables.length), st.tables.some(t => t.capped) ? 'some in part' : 'in full'),
        kpi('Classes with data', `${cov.classes_with_data ?? '–'} of ${cov.classes}`), live ? kpi('Last read from the sources', fmtTime(g.built_at), 'counts as of then; every question reads afresh') : kpi('Built', `version ${g.built_version}`, `${fmtTime(g.built_at)} · ${g.built_by}`)),
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
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, h('th', {}, 'Property'), h('th', { class: 'num' }, 'Values / links'), h('th', { class: 'num', title: 'Share of the records of its class that have it' }, 'Records with it'))),
        h('tbody', {}, ctx.c.properties.filter(p => st.properties[p.id]).sort((a, b) => st.properties[b.id] - st.properties[a.id]).map(p => {
          const have = (st.filled || {})[p.id], of = st.classes[p.domain];
          return h('tr', {}, h('td', {}, p.label, h('span', { class: 'small dim' }, ` (${clsLabel(ctx, p.domain)})`)), h('td', { class: 'num' }, n(st.properties[p.id])),
            h('td', { class: 'num' }, have != null && of ? `${Math.min(100, Math.round(100 * have / of))}%` : '—'));
        }))))),
    h('details', {}, h('summary', { style: 'cursor:pointer;color:var(--accent)' }, 'Tables read'), h('ul', { class: 'bul small' },
      st.tables.map(t => h('li', {}, `${t.source} / ${t.table}: ${n(t.read)} of ${n(t.total)} rows`, t.capped ? h('span', { style: 'color:var(--warn)' }, ` (limit ${n(st.rows_per_table)} per table)`) : null))))) : null;

  const explorer = g.status === 'ready' && g.can_see_data ? explorerCard(ctx, g) : null;
  fill(el, h('div', { class: 'stack' }, intro(), status, g.overview && g.overview.nodes.length ? overviewCard(ctx, g, explorer) : null,
    g.sources.length ? mapping : null, g.can_see_data && g.documents.length ? docsCard(ctx, g, redraw) : null, coverage,
    explorer, g.status === 'ready' && g.can_see_data ? consoleCard(ctx, g) : null));
}

function intro() {
  return h('p', { class: 'muted', style: 'margin:0' }, 'The knowledge graph is this ontology filled with your actual records — from tables (each class mapped to the table that holds it, each attribute to a column, each relationship to a join) and from documents (entities and relationships the AI finds in them, with the words that state them). Build it, then explore it, ask questions of it here, or test use cases against it in the Test bed. Query results are never sent to an AI model.');
}

// ---- facts from documents ---------------------------------------------------------------------------------
const STATUS = { proposed: ['warn', 'to review'], accepted: ['good', 'accepted'], rejected: ['', 'rejected'] };
function docsCard(ctx, g, redraw) {
  const chosen = new Set();
  const x = g.extracted;
  const box = h('div', {});
  const extract = () => {
    const model = ctx.modelSelect();
    if (!chosen.size) return toast('Tick the documents to read first.', true);
    modal('Extract facts with AI', h('div', { class: 'stack' },
      h('p', {}, `The AI reads ${chosen.size} document(s) and lists the entities and relationships they state, using only this ontology’s classes and properties, each with the exact words of the document as evidence. The application then checks every item — that the class and property exist and fit, and that the quoted words really are in the document — merges the same thing mentioned in different places, and shows you the result to accept or reject. Nothing goes into the graph until you accept it.`),
      h('p', { class: 'small muted' }, 'The text of the documents is sent to the AI model. Choose a model your organisation allows for this material.'),
      ctx.noModel(), field('AI model', model)), { actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'),
      h('button', { class: 'btn primary', disabled: !ctx.models.length, onclick: e => busy(e.target, async () => {
        await api('POST', `/api/ontologies/${ctx.id}/graph/extract`, { documents: [...chosen], model_id: Number(model.value) });
        close(); toast('The AI is reading the documents…'); await ctx.reload();
      }) }, 'Extract')] });
  };
  const card = h('div', { class: 'card stack' },
    h('div', { class: 'row wrap' }, h('div', { style: 'flex:1;min-width:240px' }, h('h2', { style: 'margin:0' }, 'From documents'),
      h('div', { class: 'small muted' }, x ? `${x.entities} entities and ${x.relations} relationships extracted from ${x.documents} document(s) · ${x.accepted} accepted · ${x.to_review} to review` + (x.suggestions ? ` · ${x.suggestions} possible duplicates` : '')
        : 'Judgments, opinions, contracts, policies… The AI finds the entities and relationships they state and maps them to this ontology.')),
      g.can_edit ? h('button', { class: 'btn primary', disabled: !!g.job, onclick: extract }, '✨ Extract with AI') : null),
    h('div', { class: 'tbl-wrap', style: 'max-height:240px' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, g.can_edit ? h('th', { style: 'width:30px' }, h('input', { type: 'checkbox', style: 'width:auto', title: 'All', onchange: e => {
        card.querySelectorAll('input[data-doc]').forEach(cb => { cb.checked = e.target.checked; cb.dispatchEvent(new Event('change')); }); } })) : null,
        h('th', {}, 'Document'), h('th', {}, 'From'), h('th', { class: 'num' }, 'Pages'), h('th', {}, 'Read'))),
      h('tbody', {}, g.documents.map(d => h('tr', {}, g.can_edit ? h('td', {}, h('input', { type: 'checkbox', style: 'width:auto', 'data-doc': d.key, onchange: e => { e.target.checked ? chosen.add(d.key) : chosen.delete(d.key); } })) : null,
        h('td', {}, h('b', {}, d.name)), h('td', { class: 'small' }, d.origin), h('td', { class: 'num' }, d.pages), h('td', { class: 'small', 'data-read': d.key }, '—')))))),
    box);
  if (x) reviewPanel(ctx, g, box, card, redraw);
  return card;
}

async function reviewPanel(ctx, g, box, card, redraw) {
  let x;
  try { x = await api('GET', `/api/ontologies/${ctx.id}/graph/extracted`); } catch (e) { return fill(box, h('div', { class: 'banner bad' }, e.message)); }
  for (const [k, d] of Object.entries(x.documents)) {
    const cell = card.querySelector(`[data-read="${k}"]`);
    if (cell) fill(cell, `${fmtTime(d.at)} · ${d.entities} new, ${d.merged} matched, ${d.relations} links, ${d.rejected} rejected`);
  }
  const docName = k => x.documents[k]?.name || g.documents.find(d => d.key === k)?.name || k;
  const byId = Object.fromEntries(x.entities.map(e => [e.id, e]));
  const ind = id => ctx.c.individuals.find(i => i.id === id)?.label || id;
  const objLabel = o => o.startsWith('ind:') ? ind(o.slice(4)) : (byId[o]?.label || o);
  const f = { doc: '', status: 'proposed' };
  const picked = new Set();
  const list = h('div', {});
  const where = m => `${docName(m.doc)}${m.page ? ', p. ' + m.page : ''}`;
  const quote = m => h('div', { class: 'small muted', style: 'max-width:520px' }, `“${m.quote}” — ${where(m)}`);
  const act = status => async e => {
    if (!picked.size) return toast('Tick some items first.', true);
    await busy(e.target, async () => { const r = await api('POST', `/api/ontologies/${ctx.id}/graph/extracted/status`, { ids: [...picked], status }); toast(`${r.changed} item(s) ${status}.`); redraw(); });
  };
  function draw() {
    picked.clear();
    const keep = it => (!f.status || it.status === f.status) && (!f.doc || it.mentions.some(m => m.doc === f.doc));
    const ents = x.entities.filter(keep), rels = x.relations.filter(keep);
    const tick = it => g.can_edit ? h('td', {}, h('input', { type: 'checkbox', style: 'width:auto', 'data-item': it.id, onchange: e => { e.target.checked ? picked.add(it.id) : picked.delete(it.id); } })) : null;
    const badge = it => h('span', { class: 'badge ' + STATUS[it.status][0] }, STATUS[it.status][1]);
    fill(list, h('div', { class: 'stack' },
      h('div', { class: 'row wrap' }, select([['', 'All documents'], ...Object.keys(x.documents).map(k => [k, docName(k)])], f.doc, v => { f.doc = v; draw(); }, { class: 'inline' }),
        select([['proposed', 'To review'], ['accepted', 'Accepted'], ['rejected', 'Rejected'], ['', 'All']], f.status, v => { f.status = v; draw(); }, { class: 'inline' }),
        h('span', { class: 'spacer' }),
        g.can_edit ? [h('button', { class: 'btn sm', onclick: () => list.querySelectorAll('input[data-item]').forEach(cb => { cb.checked = true; picked.add(cb.dataset.item); }) }, 'Tick all shown'),
          h('button', { class: 'btn sm primary', onclick: act('accepted') }, '✓ Accept ticked'), h('button', { class: 'btn sm', onclick: act('rejected') }, '✕ Reject ticked')] : null),
      h('h3', { style: 'margin:4px 0 0' }, `Entities (${ents.length})`),
      ents.length ? h('div', { class: 'tbl-wrap', style: 'max-height:420px' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, [g.can_edit ? '' : null, 'Entity', 'Class', 'Attributes', 'Evidence', ''].filter(v => v != null).map(v => h('th', {}, v)))),
        h('tbody', {}, ents.map(e => h('tr', {}, tick(e),
          h('td', {}, h('b', {}, e.label), e.aliases.length ? h('div', { class: 'small dim' }, 'also: ' + e.aliases.join(', ')) : null),
          h('td', { class: 'small' }, clsLabel(ctx, e.class)),
          h('td', { class: 'small' }, Object.entries(e.attrs).map(([p, vs]) => h('div', {}, `${propLabel(ctx, p)}: `, vs.map(v => v.value).join('; '),
            vs.some(v => !v.fits) ? h('span', { style: 'color:var(--warn)', title: 'Does not fit the attribute’s type; kept as text' }, ' ⚠') : null))),
          h('td', {}, e.mentions.slice(0, 2).map(quote), e.mentions.length > 2 ? h('div', { class: 'small dim' }, `+${e.mentions.length - 2} more mention(s)`) : null),
          h('td', {}, badge(e))))))) : h('p', { class: 'small dim' }, 'None.'),
      h('h3', { style: 'margin:4px 0 0' }, `Relationships (${rels.length})`),
      rels.length ? h('div', { class: 'tbl-wrap', style: 'max-height:360px' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, [g.can_edit ? '' : null, 'Relationship', 'Evidence', ''].filter(v => v != null).map(v => h('th', {}, v)))),
        h('tbody', {}, rels.map(r => h('tr', {}, tick(r), h('td', {}, h('b', {}, byId[r.s]?.label || r.s), h('span', { class: 'muted' }, ` — ${propLabel(ctx, r.p)} → `), h('b', {}, objLabel(r.o))),
          h('td', {}, r.mentions.slice(0, 1).map(quote)), h('td', {}, badge(r))))))) : h('p', { class: 'small dim' }, 'None.'),
      g.can_edit ? h('p', { class: 'small dim', style: 'margin:0' }, 'Accepting a relationship also accepts the two entities it links. Rejecting an entity rejects its relationships. Build the graph again for accepted items to appear in it.') : null));
  }
  const sugg = x.suggestions.filter(s => byId[s.a] && byId[s.b]);
  const notes = Object.entries(x.documents).flatMap(([k, d]) => (d.notes || []).map(n => [docName(k), n]));
  fill(box, h('div', { class: 'stack' },
    sugg.length ? h('div', { class: 'banner info stack' }, h('b', {}, `Possibly the same (${sugg.length}) — merge them if they are one thing`),
      sugg.map(s => h('div', { class: 'row wrap' }, h('span', { style: 'flex:1' }, h('b', {}, byId[s.a].label), ` (${clsLabel(ctx, byId[s.a].class)})  ·  `, h('b', {}, byId[s.b].label), ` (${clsLabel(ctx, byId[s.b].class)})`),
        g.can_edit ? [h('button', { class: 'btn sm', onclick: e => busy(e.target, async () => { await api('POST', `/api/ontologies/${ctx.id}/graph/extracted/merge`, { keep: s.a, drop: s.b }); toast('Merged.'); redraw(); }) }, `Merge into “${byId[s.a].label}”`),
          h('button', { class: 'btn sm ghost', onclick: e => busy(e.target, async () => { await api('POST', `/api/ontologies/${ctx.id}/graph/extracted/dismiss`, { a: s.a, b: s.b }); redraw(); }) }, 'Not the same')] : null))) : null,
    list,
    x.rejected.length ? h('details', {}, h('summary', { style: 'cursor:pointer;color:var(--warn)' }, `${x.rejected.length} item(s) the AI proposed were rejected by the application’s checks`),
      h('div', { class: 'tbl-wrap', style: 'max-height:300px' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Document', 'Proposed', 'Why it was rejected'].map(v => h('th', {}, v)))),
        h('tbody', {}, x.rejected.map(r => h('tr', {}, h('td', { class: 'small' }, docName(r.doc)), h('td', { class: 'small' }, r.what), h('td', { class: 'small' }, r.reason))))))) : null,
    notes.length ? h('details', {}, h('summary', { style: 'cursor:pointer;color:var(--accent)' }, `${notes.length} thing(s) the documents state that the ontology has no place for`),
      h('p', { class: 'small muted' }, 'As noted by the AI. Each may be a gap in the ontology worth closing.'),
      h('ul', { class: 'bul small' }, notes.map(([d, n]) => h('li', {}, h('b', {}, d + ': '), n)))) : null));
  draw();
}

// ---- the explorer ----------------------------------------------------------------------------------------
function explorerCard(ctx, g) {
  const input = h('input', { type: 'text', placeholder: 'Find a record by name…', style: 'max-width:320px' });
  const cls = select([['', 'Any class'], ...ctx.c.classes.filter(k => (g.stats?.classes || {})[k.id]).sort((a, b) => a.label.localeCompare(b.label)).map(k => [k.id, `${k.label} (${n(g.stats.classes[k.id])})`])], '', null, { class: 'inline' });
  const results = h('div', {}), panel = h('div', {});
  const trail = [];
  const find = async () => {
    fill(results, h('span', { class: 'spinner' }));
    try {
      const r = await api('GET', `/api/ontologies/${ctx.id}/graph/records?q=${encodeURIComponent(input.value)}&cls=${encodeURIComponent(cls.value)}`);
      fill(results, r.items.length ? h('div', { class: 'row wrap', style: 'gap:6px' }, r.items.map(it => h('button', { class: 'btn sm', onclick: () => open(it.iri) }, it.name)),
        r.items.length === 100 ? h('span', { class: 'small dim' }, 'the first 100 — narrow the search') : null) : h('span', { class: 'small dim' }, 'No record found.'));
    } catch (e) { fill(results, h('div', { class: 'banner bad' }, e.message)); }
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') find(); });
  async function open(iri, back) {
    fill(panel, h('div', { class: 'row' }, h('span', { class: 'spinner' }), ' Opening…'));
    let r;
    try { r = await api('GET', `/api/ontologies/${ctx.id}/graph/record?iri=${encodeURIComponent(iri)}`); } catch (e) { return fill(panel, h('div', { class: 'banner bad' }, e.message)); }
    if (!back) trail.push(iri);
    const groups = {};
    for (const l of r.links) (groups[l.label] = groups[l.label] || []).push(l);
    fill(panel, h('div', { class: 'card stack', style: 'background:var(--surface-2)' },
      h('div', { class: 'row wrap' }, trail.length > 1 ? h('button', { class: 'btn sm', onclick: () => { trail.pop(); open(trail[trail.length - 1], true); } }, '← Back') : null,
        h('h3', { style: 'margin:0;flex:1' }, r.name || iri), r.classes.map(k => h('span', { class: 'badge info' }, clsLabel(ctx, k))),
        r.from_documents ? h('span', { class: 'badge' }, 'from documents') : h('span', { class: 'badge' }, 'from tables')),
      h('div', { class: 'grid2', style: 'align-items:start' },
        h('div', {}, h('h3', {}, 'Values'), r.values.length ? h('table', { class: 'tbl' }, h('tbody', {}, r.values.map(v => h('tr', {}, h('td', { class: 'small' }, v.label), h('td', {}, v.value))))) : h('p', { class: 'small dim' }, 'None.')),
        h('div', {}, h('h3', {}, 'Linked records'), Object.keys(groups).length ? Object.entries(groups).map(([lab, ls]) => h('div', { style: 'margin-bottom:6px' }, h('div', { class: 'small muted' }, lab),
          h('div', { class: 'row wrap', style: 'gap:6px' }, ls.slice(0, 40).map(l => h('button', { class: 'btn sm', onclick: () => open(l.iri) }, l.name)), ls.length > 40 ? h('span', { class: 'small dim' }, `+${ls.length - 40} more`) : null))) : h('p', { class: 'small dim' }, 'None.'))),
      r.picture?.nodes.length ? h('div', {}, h('p', { class: 'small dim', style: 'margin:0 0 6px' }, 'Click a box to open that record.'), diagram(r.picture, { maxHeight: 420, onNode: nd => { if (!String(nd.id).startsWith('more:')) open(nd.id); } })) : null,
      evidenceView(r.evidence)));
  }
  const card = h('div', { class: 'card stack' }, h('h2', { style: 'margin:0' }, 'Explore records'),
    h('p', { class: 'small muted', style: 'margin:0' }, 'Find a record, see its values and the records it is linked to, and follow the links.'),
    h('div', { class: 'row wrap' }, input, cls, h('button', { class: 'btn', onclick: find }, 'Find')), results, panel);
  card.showClass = k => { cls.value = k; input.value = ''; find(); card.scrollIntoView({ block: 'start', behavior: 'smooth' }); };
  return card;
}

// ---- where the data lives (stored copy or live) -----------------------------------------------------------
function storageRow(ctx, g, redraw) {
  const minutes = h('input', { type: 'number', min: 0, max: 120, value: g.live_minutes, style: 'max-width:80px' });
  const save = async (storage) => {
    try {
      if (storage === 'live' && g.storage !== 'live' && g.status === 'ready' &&
          !await confirmDialog('Keep no copy of the data?', 'The copy of the data kept on this server is deleted. From now on every question, test and look in the explorer reads the data sources at that moment (a fetched graph can be kept in memory for a few minutes). Scheduled rebuilds are switched off.', 'Switch to live', false)) return redraw();
      await api('PUT', `/api/ontologies/${ctx.id}/graph/storage`, { storage, live_minutes: Number(minutes.value) || 0 });
      toast(storage === 'live' ? 'Live: nothing is kept on this server.' : 'A copy will be kept on this server. Build the graph to make it.'); redraw();
    } catch (e) { fail(e); }
  };
  const live = g.storage === 'live';
  return h('div', { class: 'stack', style: 'gap:6px;padding:10px 12px;border:1px solid var(--line);border-radius:8px' },
    h('div', { class: 'small', style: 'font-weight:600' }, 'Where the data lives'),
    h('label', { class: 'check' }, h('input', { type: 'radio', name: 'kg-storage', checked: !live, onchange: () => save('stored') }),
      h('span', {}, 'A copy on this server', h('div', { class: 'small dim' }, 'Fast. The data is as it was at the last build — build again, or schedule nightly or weekly rebuilds.'))),
    h('label', { class: 'check' }, h('input', { type: 'radio', name: 'kg-storage', checked: live, onchange: () => save('live') }),
      h('span', {}, 'Live from the sources — nothing kept on this server', h('div', { class: 'small dim' }, 'Every question reads the databases at that moment, so answers are always current; slower, and it puts load on the databases. Uploaded files are read from where they were uploaded to; facts accepted from documents are part of the graph’s definition and stay.'))),
    live ? h('div', { class: 'row small' }, h('span', { class: 'muted' }, 'Reuse what was read for'), minutes, h('span', { class: 'muted' }, 'minutes (in memory only; 0 = read for every question)'),
      h('button', { class: 'btn sm', onclick: () => save('live') }, 'Save')) : null);
}

// ---- overview -----------------------------------------------------------------------------------------
function overviewCard(ctx, g, explorer) {
  return h('div', { class: 'card stack' }, h('h2', { style: 'margin:0' }, 'The graph at a glance'),
    h('p', { class: 'small muted', style: 'margin:0' }, 'Each box is a class with how many records it holds; each line a relationship with how many links.' + (explorer ? ' Click a box to list its records below.' : '')),
    diagram(g.overview, { maxHeight: 460, onNode: explorer ? nd => explorer.showClass(nd.id) : null }));
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
  return h('div', { class: 'card stack', id: 'graph-console' }, h('div', { class: 'row wrap' }, h('h2', { style: 'margin:0;flex:1' }, 'Ask the graph (SPARQL)'), pick),
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
