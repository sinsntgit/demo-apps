// Training → Relationships: how the tables of a data model join, and the business words for them (the metadata graph).
import { h, fill, api, busy, fail, toast, modal, field, select, check, confirmDialog } from './core.js';

const CARD = [['', 'Not sure'], ['N:1', 'N:1 — many rows on the left, one on the right'], ['1:N', '1:N — one row on the left, many on the right'], ['1:1', '1:1 — one to one']];
const cardLabel = c => c ? h('span', { class: 'badge', title: CARD.find(x => x[0] === c)?.[1] || c }, c) : null;

export async function relationshipsTab(el, connId) {
  el.append(h('span', { class: 'spinner' }));
  let g;
  const reload = async () => { g = await api('GET', `/api/graph/${connId}`); draw(); };
  const tableOpts = () => g.tables.map(t => [t.name, t.name]);
  const colsOf = name => (g.tables.find(t => t.name.toLowerCase() === (name || '').toLowerCase())?.columns || []).map(c => [c.name, c.name + (c.pk ? ' 🔑' : '')]);

  function editEdge(e) {
    const auto = e && (e.origin === 'schema' || e.origin === 'verified_sql');
    const lt = select(tableOpts(), e?.left_table || g.tables[0]?.name, () => resetCols(), { disabled: !!e });
    const rt = select(tableOpts(), e?.right_table || g.tables[1]?.name || g.tables[0]?.name, () => resetCols(), { disabled: !!e });
    const card = select(CARD, e?.cardinality || '');
    const pairsBox = h('div', { class: 'stack', style: 'gap:6px' });
    let pairs = e ? e.left_columns.map((c, i) => [c, e.right_columns[i]]) : [['', '']];
    const drawPairs = () => fill(pairsBox, pairs.map((p, i) => h('div', { class: 'row' },
      select([['', 'column…'], ...colsOf(lt.value)], p[0], v => { p[0] = v; }, { disabled: auto, 'aria-label': 'Left column' }), h('b', {}, '='),
      select([['', 'column…'], ...colsOf(rt.value)], p[1], v => { p[1] = v; }, { disabled: auto, 'aria-label': 'Right column' }),
      !auto && pairs.length > 1 ? h('button', { class: 'btn sm ghost', type: 'button', title: 'Remove this pair', onclick: () => { pairs.splice(i, 1); drawPairs(); } }, '✕') : null)),
      auto ? null : h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { pairs.push(['', '']); drawPairs(); } }, '＋ Another column pair (composite key)'));
    const resetCols = () => { pairs = [['', '']]; drawPairs(); };
    drawPairs();
    modal(e ? 'Edit join' : 'Add a join', h('div', { class: 'stack' },
      h('div', { class: 'grid2' }, field('Left table', lt), field('Right table', rt)), field('Joined on', pairsBox, 'columns are matched in order'),
      field('Rows on each side', card, 'helps the AI total before joining, to avoid double counting'),
      auto ? h('div', { class: 'small dim' }, 'This join comes from the database or a verified example, so its columns are fixed. If it is wrong, reject it and add the right one.') : null), {
      actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: ev => busy(ev.target, async () => {
        const ok = pairs.filter(p => p[0] && p[1]);
        if (!auto && !ok.length) return toast('Choose at least one pair of columns.', true);
        if (e) await api('PUT', `/api/graph/edges/${e.id}`, { cardinality: card.value, ...(auto ? {} : { left_columns: ok.map(p => p[0]), right_columns: ok.map(p => p[1]) }), action: e.status === 'suggested' ? 'confirm' : '' });
        else await api('POST', `/api/graph/${connId}/edges`, { left_table: lt.value, right_table: rt.value, left_columns: ok.map(p => p[0]), right_columns: ok.map(p => p[1]), cardinality: card.value });
        close(); toast('Saved — confirmed joins are used from the next question'); reload();
      }) }, e?.status === 'suggested' ? 'Confirm with these settings' : 'Save')] });
  }

  function editEntity(ent) {
    const name = h('input', { type: 'text', value: ent?.name || '', placeholder: 'e.g. Customer' });
    const syn = h('input', { type: 'text', value: (ent?.synonyms || []).join(', '), placeholder: 'e.g. client, sold-to party, account' });
    const desc = h('input', { type: 'text', value: ent?.description || '', placeholder: 'Optional — one line on what it is' });
    let binds = ent ? ent.bindings.map(b => ({ ...b })) : [{ table: g.tables[0]?.name || '', key_columns: [], source_of_truth: true }];
    const box = h('div', { class: 'stack', style: 'gap:6px' });
    const drawBinds = () => fill(box, binds.map((b, i) => h('div', { class: 'row wrap' },
      select(tableOpts(), b.table, v => { b.table = v; b.key_columns = []; drawBinds(); }, { 'aria-label': 'Table', class: 'inline', style: 'min-width:160px' }),
      select([['', 'key column (optional)'], ...colsOf(b.table)], b.key_columns[0] || '', v => { b.key_columns = v ? [v] : []; }, { 'aria-label': 'Key column', class: 'inline', style: 'min-width:170px' }),
      check('main source', b.source_of_truth, v => { b.source_of_truth = v; }),
      binds.length > 1 ? h('button', { class: 'btn sm ghost', type: 'button', title: 'Remove', onclick: () => { binds.splice(i, 1); drawBinds(); } }, '✕') : null)),
      h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { binds.push({ table: g.tables[0]?.name || '', key_columns: [], source_of_truth: false }); drawBinds(); } }, '＋ Another table'));
    drawBinds();
    modal(ent ? `Edit ${ent.name}` : 'Add a business entity', h('div', { class: 'stack' },
      field('Name', name, 'the business thing: Customer, Invoice, Material…'), field('Also called', syn, 'words people use for it, separated by commas'),
      field('Description', desc), field('Stored in', box, 'the table(s) that hold it in this data model'),
      h('div', { class: 'small dim' }, 'When a question uses one of these words, the AI is told which table holds it and how to join to it.')), {
      actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: ev => busy(ev.target, async () => {
        const payload = { name: name.value, synonyms: syn.value.split(',').map(s => s.trim()).filter(Boolean), description: desc.value, bindings: binds };
        await (ent ? api('PUT', `/api/graph/${connId}/entities/${ent.id}`, payload) : api('POST', `/api/graph/${connId}/entities`, payload));
        close(); toast('Saved'); reload();
      }) }, 'Save')] });
  }

  const act = (e, action, msg) => async () => {
    try { await api('PUT', `/api/graph/edges/${e.id}`, { action }); toast(msg); reload(); } catch (ex) { fail(ex); }
  };
  const evidence = e => h('div', { class: 'small dim' }, e.origin_label + (e.evidence.length ? ' · ' + e.evidence.slice(0, 2).join(' · ') : '') + (e.evidence.length > 2 ? ` · +${e.evidence.length - 2} more` : ''));
  const joinCell = e => h('div', {}, h('code', { class: 'mono' }, e.left_columns.map((c, i) => `${e.left_table}.${c} = ${e.right_table}.${e.right_columns[i]}`).join('  AND  ')), ' ', cardLabel(e.cardinality));

  let showAll = false;
  const SHOW = 10;
  function draw() {
    const by = s => g.edges.filter(e => e.status === s);
    const sugg = by('suggested'), conf = by('confirmed'), rej = by('rejected');
    const rebuild = h('button', { class: 'btn', title: 'Read the schema and the verified examples again', onclick: () => busy(rebuild, async () => {
      const r = await api('POST', `/api/graph/${connId}/rebuild`); g = r; toast(`Rebuilt: ${r.result.added} new, ${r.result.removed} removed`); draw(); }) }, '⟳ Rebuild');
    fill(el, h('div', { class: 'stack' },
      h('div', { class: 'row wrap' }, h('button', { class: 'btn primary', onclick: () => editEdge(null) }, '＋ Add join'),
        h('button', { class: 'btn', onclick: () => editEntity(null) }, '＋ Add entity'), rebuild,
        h('span', { class: 'small dim', style: 'flex:1;min-width:260px' }, 'How the tables join, and the business words for them — names and keys only, never row data. Confirmed joins are given to the AI as join paths; suggestions are used only once you confirm them.')),
      !g.tables.length ? h('div', { class: 'banner warn' }, 'No schema yet. Sync the schema first (Schema tab).') : null,
      g.tables.length ? h('div', { class: 'small' }, h('b', {}, `${conf.length} confirmed`), ` joins in use · ${sugg.length} suggestion${sugg.length === 1 ? '' : 's'} to check · ${rej.length} rejected · ${g.entities.length} business entit${g.entities.length === 1 ? 'y' : 'ies'}`) : null,
      sugg.length ? [h('h2', { style: 'margin:6px 0 0' }, `Suggestions to check (${sugg.length})`),
        h('div', { class: 'card flush' }, (showAll ? sugg : sugg.slice(0, SHOW)).map(e => h('div', { class: 'item' }, h('div', { class: 'row top' },
          h('div', { style: 'flex:1;min-width:0' }, joinCell(e), evidence(e)),
          h('span', { class: 'badge', title: 'How sure the suggestion is, from names and keys' }, Math.round(e.confidence * 100) + '%'),
          h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'btn sm primary', onclick: act(e, 'confirm', 'Confirmed') }, '✓ Confirm'),
            h('button', { class: 'btn sm', onclick: () => editEdge(e) }, 'Edit'), h('button', { class: 'btn sm danger', onclick: act(e, 'reject', 'Rejected — it will not be suggested again') }, '✗ Reject')))))),
        sugg.length > SHOW ? h('div', {}, h('button', { class: 'btn sm ghost', onclick: () => { showAll = !showAll; draw(); } }, showAll ? 'Show fewer' : `Show all ${sugg.length} suggestions`)) : null] : null,
      h('h2', { style: 'margin:6px 0 0' }, `Confirmed joins (${conf.length})`),
      conf.length ? h('div', { class: 'card flush' }, conf.map(e => h('div', { class: 'item' }, h('div', { class: 'row top' },
        h('div', { style: 'flex:1;min-width:0' }, joinCell(e), evidence(e)),
        h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'btn sm', onclick: () => editEdge(e) }, 'Edit'),
          e.origin === 'steward' ? h('button', { class: 'btn sm danger', onclick: async () => { if (!await confirmDialog('Delete this join?', 'The AI will no longer be told about it.', 'Delete')) return;
            await api('DELETE', `/api/graph/edges/${e.id}`).catch(fail); reload(); } }, 'Delete')
            : h('button', { class: 'btn sm danger', onclick: act(e, 'reject', 'Rejected — the AI will no longer be told about it') }, '✗ Reject'))))))
        : h('div', { class: 'empty' }, 'No confirmed joins yet. They come from foreign keys in the database, from the joins in verified examples, and from suggestions you confirm.'),
      rej.length ? h('details', { class: 'card', style: 'padding:10px 14px' }, h('summary', {}, `Rejected (${rej.length}) — not used and not suggested again`),
        rej.map(e => h('div', { class: 'row', style: 'margin-top:8px' }, h('div', { style: 'flex:1;min-width:0' }, joinCell(e), evidence(e)),
          h('button', { class: 'btn sm', onclick: act(e, 'restore', 'Restored') }, 'Restore')))) : null,
      h('h2', { style: 'margin:6px 0 0' }, `Business entities (${g.entities.length})`),
      g.entities.length ? h('div', { class: 'card flush' }, g.entities.map(ent => h('div', { class: 'item' }, h('div', { class: 'row top' },
        h('div', { style: 'flex:1;min-width:0' }, h('b', {}, ent.name), ent.synonyms.length ? h('span', { class: 'small dim' }, '  also called ' + ent.synonyms.join(', ')) : null,
          h('div', { class: 'small' }, 'Stored in ', ent.bindings.map((b, i) => [i ? ', ' : '', h('code', { class: 'mono' }, b.table + (b.key_columns.length ? ` (${b.key_columns.join(', ')})` : '')), b.source_of_truth ? h('span', { class: 'badge good', style: 'margin-left:4px' }, 'main') : null])),
          ent.description ? h('div', { class: 'small dim' }, ent.description) : null),
        h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'btn sm', onclick: () => editEntity(ent) }, 'Edit'),
          h('button', { class: 'btn sm danger', onclick: async () => { if (!await confirmDialog(`Remove ${ent.name}?`, 'It is removed from this data model.', 'Remove')) return;
            await api('DELETE', `/api/graph/${connId}/entities/${ent.id}`).catch(fail); reload(); } }, 'Remove'))))))
        : h('div', { class: 'empty' }, 'No entities yet. Add the business things people ask about — Customer, Invoice, Material — with the words they use for them.')));
  }
  try { await reload(); } catch (ex) { fail(ex); fill(el, h('div', { class: 'empty' }, 'Could not load the relationships.')); }
}
