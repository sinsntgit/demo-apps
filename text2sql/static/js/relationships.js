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
  let view = (() => { try { return localStorage.getItem('askdata.relview') || 'diagram'; } catch { return 'diagram'; } })();
  let allTables = false, showSugg = false, selected = null, camera = null;
  const setView = v => { view = v; try { localStorage.setItem('askdata.relview', v); } catch { /* private window */ } draw(); };

  function foundPanel(conf) {
    const f = g.found || {};
    const li = (...kids) => h('li', {}, ...kids);
    return h('details', { class: 'card', style: 'padding:10px 14px', open: !conf.length }, h('summary', {}, h('b', {}, 'Where these joins come from')),
      h('ul', { class: 'small', style: 'margin:8px 0 0 18px;display:grid;gap:4px' },
        li(f.file_based ? 'Foreign keys: none - Excel and CSV files never carry them, so the joins come from your verified examples, from suggestions you confirm and from joins you add.'
          : `Foreign keys defined in the database: ${f.foreign_keys}` + (f.foreign_keys ? '' : ' - many warehouses and views define none; the joins then come from verified examples and from you.')),
        li(`Approved question → SQL examples: ${f.examples}, of which ${f.examples_with_joins} join tables. Every join in them is used automatically.`),
        f.joins_not_read_count ? li(`${f.joins_not_read_count} example${f.joins_not_read_count === 1 ? '' : 's'} use several tables but their join could not be read (for example inside a sub-query or EXISTS). Add those joins with ＋ Add join:`,
          h('ul', { style: 'margin:4px 0 0 18px' }, f.joins_not_read.map(q => h('li', { class: 'dim' }, q)))) : null,
        f.examples_waiting ? li(h('b', {}, `${f.examples_waiting} example${f.examples_waiting === 1 ? ' is' : 's are'} waiting for approval`), ' in the Review queue. Their joins are used as soon as they are approved.') : null,
        f.unparsed && f.unparsed.length ? li('SQL that could not be read: ', f.unparsed.join(' · ')) : null,
        !f.examples ? li(h('b', {}, 'No approved examples yet.'), ' Add a few Question → SQL examples that join your tables - their joins appear here automatically - or add joins by hand.') : null,
        li(`Suggestions from column names (same key-like name in two tables, ignoring spaces and case): ${g.edges.filter(e => e.origin === 'names').length}.`),
        li('This is worked out again automatically after a schema sync and whenever examples change - the next time this tab is opened or a question is asked. ⟳ Rebuild does it now.')));
  }

  function draw() {
    const by = s => g.edges.filter(e => e.status === s);
    const sugg = by('suggested'), conf = by('confirmed'), rej = by('rejected');
    const rebuild = h('button', { class: 'btn', title: 'Read the schema and the verified examples again', onclick: () => busy(rebuild, async () => {
      const r = await api('POST', `/api/graph/${connId}/rebuild`); g = r; toast(`Rebuilt: ${r.result.added} new, ${r.result.removed} removed`); draw(); }) }, '⟳ Rebuild');
    const tab = (v, label) => h('button', { class: 'btn sm' + (view === v ? ' primary' : ''), onclick: () => setView(v) }, label);
    fill(el, h('div', { class: 'stack' },
      h('div', { class: 'row wrap' }, h('button', { class: 'btn primary', onclick: () => editEdge(null) }, '＋ Add join'),
        h('button', { class: 'btn', onclick: () => editEntity(null) }, '＋ Add entity'), rebuild,
        h('span', { class: 'small dim', style: 'flex:1;min-width:260px' }, 'How the tables join, and the business words for them — names and keys only, never row data. Confirmed joins are given to the AI as join paths; suggestions are used only once you confirm them.')),
      !g.tables.length ? h('div', { class: 'banner warn' }, 'No schema yet. Sync the schema first (Schema tab).') : null,
      g.tables.length ? h('div', { class: 'row wrap' }, h('div', { class: 'small', style: 'flex:1' }, h('b', {}, `${conf.length} confirmed`), ` joins in use · ${sugg.length} suggestion${sugg.length === 1 ? '' : 's'} to check · ${rej.length} rejected · ${g.entities.length} business entit${g.entities.length === 1 ? 'y' : 'ies'}`),
        h('div', { class: 'row', style: 'gap:4px' }, tab('diagram', '◉ Diagram'), tab('list', '☰ List'))) : null,
      g.tables.length ? foundPanel(conf) : null,
      g.tables.length ? (view === 'diagram' ? diagramView(sugg, conf) : listView(sugg, conf, rej)) : null));
  }

  function listView(sugg, conf, rej) {
    return [sugg.length ? [h('h2', { style: 'margin:6px 0 0' }, `Suggestions to check (${sugg.length})`),
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
        : h('div', { class: 'empty' }, 'No entities yet. Add the business things people ask about — Customer, Invoice, Material — with the words they use for them.')];
  }

  // ---- the diagram: tables as boxes, joins as lines (solid = confirmed, dashed = suggestion), entities as green tags ----------------
  function diagramView(sugg, conf) {
    const NS = 'http://www.w3.org/2000/svg';
    const s = (tag, attrs = {}, ...kids) => { const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) n.setAttribute(k, v);
      kids.flat().forEach(k => { if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k))); }); return n; };
    const key = t => t.toLowerCase();
    const nodes = new Map(), links = [];
    const addNode = (id, label, kind) => { if (!nodes.has(id)) nodes.set(id, { id, label, kind, w: Math.max(56, label.length * 7.4 + 22), h: 26 }); return nodes.get(id); };
    [...conf, ...(showSugg ? sugg : [])].forEach(e => { addNode(key(e.left_table), e.left_table, 'table'); addNode(key(e.right_table), e.right_table, 'table');
      links.push({ a: key(e.left_table), b: key(e.right_table), e }); });
    g.entities.forEach(ent => { const id = 'ent:' + ent.id; addNode(id, ent.name, 'entity').ent = ent;
      ent.bindings.forEach(b => { addNode(key(b.table), b.table, 'table'); links.push({ a: id, b: key(b.table), ent }); }); });
    if (allTables) g.tables.forEach(t => addNode(key(t.name), t.name, 'table'));
    const list = [...nodes.values()];
    if (!list.length) return h('div', { class: 'stack' }, h('div', { class: 'empty' }, `Nothing to draw yet: no confirmed joins or entities.${sugg.length ? ` There ${sugg.length === 1 ? 'is 1 suggestion' : `are ${sugg.length} suggestions`} to check.` : ''} See “Where these joins come from” above.`),
      h('div', { class: 'row' }, sugg.length ? h('button', { class: 'btn sm', onclick: () => { showSugg = true; draw(); } }, `Show the ${sugg.length} suggestion${sugg.length === 1 ? '' : 's'}`) : null,
        h('button', { class: 'btn sm', onclick: () => { allTables = true; draw(); } }, 'Show every table')));

    // layout: each connected group is laid out on its own (force-directed, deterministic), the groups are then placed side by
    // side, largest first, and the whole picture is scaled evenly to the frame; overlapping boxes are nudged apart at the end
    const W = 1100, H = 640, k = 90;
    const adj = new Map(list.map(n => [n.id, []]));
    links.forEach(l => { adj.get(l.a).push(l.b); adj.get(l.b).push(l.a); });
    const groups = [], seenN = new Set();
    list.sort((p, q) => p.label.localeCompare(q.label)).forEach(n => {
      if (seenN.has(n.id)) return;
      const comp = [], todo = [n.id]; seenN.add(n.id);
      while (todo.length) { const id = todo.shift(); comp.push(nodes.get(id)); adj.get(id).forEach(m => { if (!seenN.has(m)) { seenN.add(m); todo.push(m); } }); }
      groups.push(comp);
    });
    groups.forEach(comp => {
      const ids = new Set(comp.map(n => n.id)), ls = links.filter(l => ids.has(l.a));
      comp.forEach((n, i) => { const a = (2 * Math.PI * i) / comp.length; const r = 40 * Math.sqrt(comp.length); n.x = Math.cos(a) * r; n.y = Math.sin(a) * r; });
      for (let it = 0, temp = 50; comp.length > 1 && it < 400; it++, temp = Math.max(0.5, temp * 0.985)) {
        comp.forEach(n => { n.dx = -n.x * 0.01; n.dy = -n.y * 0.01; });
        for (let i = 0; i < comp.length; i++) for (let j = i + 1; j < comp.length; j++) {
          const p = comp[i], q = comp[j]; let dx = p.x - q.x, dy = p.y - q.y; const d = Math.max(Math.hypot(dx, dy), 1);
          const f = (k * k) / d; dx /= d; dy /= d; p.dx += dx * f; p.dy += dy * f; q.dx -= dx * f; q.dy -= dy * f; }
        ls.forEach(l => { const p = nodes.get(l.a), q = nodes.get(l.b); let dx = p.x - q.x, dy = p.y - q.y; const d = Math.max(Math.hypot(dx, dy), 1);
          const f = (d * d) / k * (l.e && l.e.status === 'suggested' ? 0.4 : 1); dx /= d; dy /= d; p.dx -= dx * f; p.dy -= dy * f; q.dx += dx * f; q.dy += dy * f; });
        comp.forEach(n => { const d = Math.max(Math.hypot(n.dx, n.dy), 0.01); n.x += (n.dx / d) * Math.min(d, temp); n.y += (n.dy / d) * Math.min(d, temp); });
      }
      if (comp.length > 2) {                             // turn the group so its long side runs along the (wide) frame
        const mx = comp.reduce((t, n) => t + n.x, 0) / comp.length, my = comp.reduce((t, n) => t + n.y, 0) / comp.length;
        let sxx = 0, syy = 0, sxy = 0;
        comp.forEach(n => { const dx = n.x - mx, dy = n.y - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; });
        const a = -0.5 * Math.atan2(2 * sxy, sxx - syy), c = Math.cos(a), si = Math.sin(a);
        comp.forEach(n => { const dx = n.x - mx, dy = n.y - my; n.x = dx * c - dy * si; n.y = dx * si + dy * c; });
      }
      const x0 = Math.min(...comp.map(n => n.x - n.w / 2)), y0 = Math.min(...comp.map(n => n.y - n.h / 2));
      comp.forEach(n => { n.x -= x0; n.y -= y0; });
      comp.bw = Math.max(...comp.map(n => n.x + n.w / 2)); comp.bh = Math.max(...comp.map(n => n.y + n.h / 2));
    });
    groups.sort((p, q) => q.length - p.length);
    const rowW = Math.max(groups[0].bw, Math.sqrt(groups.reduce((t, c) => t + (c.bw + 40) * (c.bh + 40), 0) * (W / H)));
    let cx = 0, cy = 0, rowH = 0, totalW = 0;
    groups.forEach(comp => {                             // shelf packing: left to right, then a new row
      if (cx > 0 && cx + comp.bw > rowW) { cx = 0; cy += rowH + 40; rowH = 0; }
      comp.forEach(n => { n.x += cx; n.y += cy; });
      cx += comp.bw + 40; rowH = Math.max(rowH, comp.bh); totalW = Math.max(totalW, cx - 40);
    });
    const totalH = cy + rowH, pad = 16, sc = Math.min((W - 2 * pad) / Math.max(totalW, 1), (H - 2 * pad) / Math.max(totalH, 1), 1.6);
    const ox = (W - totalW * sc) / 2, oy = (H - totalH * sc) / 2;
    list.forEach(n => { n.x = ox + n.x * sc; n.y = oy + n.y * sc; });
    for (let pass = 0; pass < 60; pass++) {             // boxes must not overlap: push overlapping pairs apart
      let moved = false;
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const p = list[i], q = list[j], ox = (p.w + q.w) / 2 + 8 - Math.abs(p.x - q.x), oy = (p.h + q.h) / 2 + 8 - Math.abs(p.y - q.y);
        if (ox > 0 && oy > 0) { moved = true;
          if (ox < oy) { const m = (ox / 2) * Math.sign(p.x - q.x || 1); p.x += m; q.x -= m; } else { const m = (oy / 2) * Math.sign(p.y - q.y || 1); p.y += m; q.y -= m; } }
      }
      list.forEach(n => { n.x = Math.min(W - n.w / 2 - 4, Math.max(n.w / 2 + 4, n.x)); n.y = Math.min(H - n.h / 2 - 4, Math.max(n.h / 2 + 4, n.y)); });
      if (!moved) break;
    }
    if (!camera) camera = { x: 0, y: 0, w: W, h: H };
    const svg = s('svg', { class: 'kg', viewBox: `${camera.x} ${camera.y} ${camera.w} ${camera.h}`, role: 'img', 'aria-label': 'Diagram of tables and joins' });
    const gEdges = s('g'), gLabels = s('g'), gNodes = s('g');
    svg.append(gEdges, gNodes, gLabels);              // join labels on top, with a halo so they stay readable
    links.forEach(l => {
      const cls = l.ent ? 'e ent' : l.e.status === 'suggested' ? 'e sugg' : 'e';
      const tip = l.ent ? `${l.ent.name} is stored in ${nodes.get(l.b).label}` : `${l.e.status === 'suggested' ? 'Suggestion: ' : ''}${l.e.join}  (${l.e.origin_label})`;
      l.line = s('line', { class: cls }); l.hit = s('line', { class: 'hit' }, s('title', {}, tip));
      l.hit.addEventListener('click', ev => { ev.stopPropagation(); if (l.e) select(nodes.get(l.a).id); });
      gEdges.append(l.line, l.hit);
    });
    list.forEach(n => {
      n.el = s('g', { class: 'n' + (n.kind === 'entity' ? ' ent' : ''), tabindex: 0 },
        s('rect', { x: -n.w / 2, y: -n.h / 2, width: n.w, height: n.h, rx: n.kind === 'entity' ? 13 : 6 }),
        s('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central' }, n.label),
        s('title', {}, n.kind === 'entity' ? `${n.label}${n.ent.synonyms.length ? ' - also called ' + n.ent.synonyms.join(', ') : ''}` : `Table ${n.label} - click to see its joins`));
      gNodes.append(n.el);
      let drag = null;
      n.el.addEventListener('pointerdown', ev => { ev.stopPropagation(); n.el.setPointerCapture(ev.pointerId); drag = { moved: false }; });
      n.el.addEventListener('pointermove', ev => { if (!drag) return; const p = toSvg(ev); n.x = p.x; n.y = p.y; drag.moved = true; place(); });
      n.el.addEventListener('pointerup', ev => { if (drag && !drag.moved) select(n.id); drag = null; });
      n.el.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(n.id); } });
    });
    const toSvg = ev => { const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY; return pt.matrixTransform(svg.getScreenCTM().inverse()); };
    function place() {
      list.forEach(n => n.el.setAttribute('transform', `translate(${n.x},${n.y})`));
      links.forEach(l => { const p = nodes.get(l.a), q = nodes.get(l.b);
        for (const ln of [l.line, l.hit]) { ln.setAttribute('x1', p.x); ln.setAttribute('y1', p.y); ln.setAttribute('x2', q.x); ln.setAttribute('y2', q.y); } });
      fill(gLabels, links.filter(l => l.e && selected && (l.a === selected || l.b === selected)).map(l => {
        const p = nodes.get(l.a), q = nodes.get(l.b); const cols = l.e.left_columns.map((c, i) => c === l.e.right_columns[i] ? c : `${c} = ${l.e.right_columns[i]}`).join(', ');
        return s('text', { class: 'elabel', x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 - 6, 'text-anchor': 'middle' }, cols + (l.e.cardinality ? `  ${l.e.cardinality}` : ''));
      }));
    }
    // pan by dragging the background, zoom with the wheel
    let pan = null;
    svg.addEventListener('pointerdown', ev => { pan = { x: ev.clientX, y: ev.clientY, cx: camera.x, cy: camera.y }; svg.setPointerCapture(ev.pointerId); svg.classList.add('grabbing'); });
    svg.addEventListener('pointermove', ev => { if (!pan) return; const r = svg.getBoundingClientRect(); const sc = camera.w / r.width;
      camera.x = pan.cx - (ev.clientX - pan.x) * sc; camera.y = pan.cy - (ev.clientY - pan.y) * sc; svg.setAttribute('viewBox', `${camera.x} ${camera.y} ${camera.w} ${camera.h}`); });
    svg.addEventListener('pointerup', ev => { if (pan && Math.hypot(ev.clientX - pan.x, ev.clientY - pan.y) < 4) select(null); pan = null; svg.classList.remove('grabbing'); });
    svg.addEventListener('wheel', ev => { ev.preventDefault(); const p = toSvg(ev); const f = ev.deltaY > 0 ? 1.15 : 1 / 1.15;
      const w = Math.min(W * 3, Math.max(W / 5, camera.w * f)), hh = w * (H / W);
      camera = { x: p.x - (p.x - camera.x) * (w / camera.w), y: p.y - (p.y - camera.y) * (hh / camera.h), w, h: hh }; svg.setAttribute('viewBox', `${camera.x} ${camera.y} ${camera.w} ${camera.h}`); }, { passive: false });

    const info = h('div', {});
    function select(id) {
      selected = id;
      const near = new Set(id ? [id, ...links.filter(l => l.a === id || l.b === id).flatMap(l => [l.a, l.b])] : []);
      list.forEach(n => { n.el.classList.toggle('sel', n.id === id); n.el.classList.toggle('dim', !!id && !near.has(n.id)); });
      links.forEach(l => { const on = !id || l.a === id || l.b === id; l.line.classList.toggle('dim', !on); });
      place();
      const n = id && nodes.get(id);
      if (!n) return fill(info, h('div', { class: 'small dim' }, 'Click a table to see its joins and decide on its suggestions. Drag tables to tidy the picture; drag the background to move it; scroll to zoom.'));
      if (n.kind === 'entity') return fill(info, h('div', { class: 'card', style: 'padding:10px 14px' }, h('b', {}, n.label), n.ent.synonyms.length ? h('span', { class: 'small dim' }, '  also called ' + n.ent.synonyms.join(', ')) : null,
        h('div', { class: 'small' }, 'Stored in ', n.ent.bindings.map(b => b.table + (b.key_columns.length ? ` (${b.key_columns.join(', ')})` : '')).join(', ')),
        h('div', { class: 'row', style: 'margin-top:6px' }, h('button', { class: 'btn sm', onclick: () => editEntity(n.ent) }, 'Edit'))));
      const mine = links.filter(l => l.e && (l.a === id || l.b === id)).map(l => l.e);
      const t = g.tables.find(x => key(x.name) === id);
      fill(info, h('div', { class: 'card flush' }, h('div', { class: 'item' }, h('b', {}, n.label), h('span', { class: 'small dim' }, `  ${t ? t.columns.length + ' columns · ' : ''}${mine.length} join${mine.length === 1 ? '' : 's'}`)),
        mine.map(e => h('div', { class: 'item' }, h('div', { class: 'row top' }, h('div', { style: 'flex:1;min-width:0' }, joinCell(e), evidence(e)),
          e.status === 'suggested' ? h('div', { class: 'row' }, h('button', { class: 'btn sm primary', onclick: act(e, 'confirm', 'Confirmed') }, '✓ Confirm'),
            h('button', { class: 'btn sm', onclick: () => editEdge(e) }, 'Edit'), h('button', { class: 'btn sm danger', onclick: act(e, 'reject', 'Rejected — it will not be suggested again') }, '✗ Reject'))
            : h('div', { class: 'row' }, h('span', { class: 'badge good' }, 'confirmed'), h('button', { class: 'btn sm', onclick: () => editEdge(e) }, 'Edit')))))));
    }
    place();
    select(selected && nodes.has(selected) ? selected : null);
    return h('div', { class: 'stack' },
      h('div', { class: 'row wrap small' }, h('span', { class: 'kg-key' }, h('i', { class: 'k-conf' }), 'confirmed join'), h('span', { class: 'kg-key' }, h('i', { class: 'k-sugg' }), 'suggestion'),
        h('span', { class: 'kg-key' }, h('i', { class: 'k-ent' }), 'business entity'), h('span', { class: 'spacer' }),
        sugg.length ? check(`Show suggestions (${sugg.length})`, showSugg, v => { showSugg = v; camera = null; draw(); }) : null,
        check('Show every table', allTables, v => { allTables = v; camera = null; draw(); }),
        h('button', { class: 'btn sm', onclick: () => { camera = null; draw(); } }, 'Fit')),
      svg, info);
  }

  try { await reload(); } catch (ex) { fail(ex); fill(el, h('div', { class: 'empty' }, 'Could not load the relationships.')); }
}
