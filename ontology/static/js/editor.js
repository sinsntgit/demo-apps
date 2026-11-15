// Editing screens of an ontology: the diagram (visual editor), classes & properties, use cases,
// the test bed, and quality / reasoner / AI gap review. All changes go through ctx.edit (a new version).
import { h, fill, api, busy, fail, toast, modal, field, check, select, confirmDialog, fmtTime, pct } from './core.js';
import { diagram } from './diagram.js';
import { ucForm } from './workspace.js';

const XSD = [['string', 'Text'], ['integer', 'Whole number'], ['decimal', 'Number / amount'], ['boolean', 'Yes / no'], ['date', 'Date'], ['dateTime', 'Date and time'],
  ['time', 'Time'], ['gYear', 'Year'], ['duration', 'Duration'], ['anyURI', 'Web address']];
const CARD = [['0..1', 'Optional, at most one'], ['1', 'Exactly one (mandatory)'], ['0..*', 'Optional, any number'], ['1..*', 'At least one (mandatory)']];
const cardText = c => (CARD.find(x => x[0] === c) || [c, c])[1].toLowerCase();
const VERDICT = { addressed: ['good', 'Addressed'], partly: ['warn', 'Partly addressed'], not_addressed: ['bad', 'Not addressed'] };
const byLabel = (a, b) => a.label.localeCompare(b.label);

const cls = (ctx, id) => ctx.c.classes.find(k => k.id === id);
const label = (ctx, id) => cls(ctx, id)?.label || id || '';
function ancestors(ctx, id) { const out = []; let cur = cls(ctx, id)?.parent; while (cur && !out.includes(cur)) { out.push(cur); cur = cls(ctx, cur)?.parent; } return out; }
function descendants(ctx, id) { const kids = ctx.c.classes.filter(k => k.parent === id).map(k => k.id); return kids.concat(...kids.map(k => descendants(ctx, k))); }
const classSelect = (ctx, value, none, skip = []) => select([...(none ? [['', none]] : []), ...ctx.c.classes.filter(k => !skip.includes(k.id)).slice().sort(byLabel).map(k => [k.id, k.label])], value || '');

// ---- forms -------------------------------------------------------------------------------------
/** Add or edit a class. defaults: {parent, module}. done(id) after saving. */
export function classForm(ctx, k, defaults = {}, done) {
  const c = ctx.c;
  const name = h('input', { type: 'text', value: k?.label || '', maxlength: 120, placeholder: 'A singular noun, e.g. Loan application' });
  const def = h('textarea', { rows: 3, placeholder: 'One or two sentences: what it is, and how it differs from similar classes.' }, k?.definition || '');
  const parent = classSelect(ctx, k ? k.parent : defaults.parent, '— none (top level) —', k ? [k.id, ...descendants(ctx, k.id)] : []);
  const module = select([...c.modules.map(m => [m.id, m.name]), ['__new', '＋ New module…']], k?.module || defaults.module || (defaults.parent && cls(ctx, defaults.parent)?.module) || c.modules[0]?.id || '__new',
    v => newMod.parentElement.classList.toggle('hidden', v !== '__new'));
  const newMod = h('input', { type: 'text', placeholder: 'Name of the new module' });
  const syn = h('input', { type: 'text', value: (k?.synonyms || []).join(', '), placeholder: 'other names the business uses, separated by commas' });
  const aligned = h('input', { type: 'text', value: k?.aligned_to || '', placeholder: 'e.g. schema:Order or fibo:Loan' });
  const how = select([['', '—'], ['equivalent', 'same meaning as'], ['subclass', 'a kind of'], ['related', 'related to']], k?.alignment || '');
  const src = h('input', { type: 'text', value: k?.derived_from || '', placeholder: 'table, document or system it comes from' });
  const abstract = check('Grouping class only (nothing is ever just this; it is always one of its subclasses)', k?.abstract);
  const newField = field('New module', newMod); newField.classList.toggle('hidden', module.value !== '__new');
  parent.addEventListener('change', () => { const p = cls(ctx, parent.value); if (p && !k) module.value = p.module; });
  modal(k ? `Edit class: ${k.label}` : 'Add a class', h('div', { class: 'stack' }, field('Name', name), field('Definition', def),
    h('div', { class: 'grid2' }, field('Is a kind of', parent, 'its parent class'), field('Module', module)), newField, field('Also called', syn),
    h('details', {}, h('summary', { style: 'cursor:pointer;color:var(--accent)' }, 'Metadata: standard alignment and origin'),
      h('div', { class: 'stack', style: 'margin-top:10px' }, h('div', { class: 'grid2' }, field('Aligned to a published term', aligned), field('This class is…', how, 'that term')), field('Derived from', src), abstract)),
    k ? h('p', { class: 'small dim' }, `Identifier: ${k.id} (does not change when you rename)`) : null), {
    wide: true, actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
      if (!name.value.trim()) throw new Error('Give the class a name.');
      if (module.value === '__new' && !newMod.value.trim()) throw new Error('Name the new module.');
      const patch = { classes: [{ id: k?.id || name.value, label: name.value.trim(), definition: def.value, parent: parent.value || null,
        module: module.value === '__new' ? newMod.value : module.value, synonyms: syn.value.split(',').map(x => x.trim()).filter(Boolean),
        aligned_to: aligned.value.trim(), alignment: aligned.value.trim() ? (how.value || 'related') : '', derived_from: src.value, abstract: abstract.input.checked }] };
      if (module.value === '__new') patch.modules = [{ name: newMod.value.trim() }];
      const before = new Set(ctx.c.classes.map(x => x.id));
      const r = await ctx.edit(patch, k ? `Class ${k.label} edited` : `Class ${name.value.trim()} added`);
      close();
      done?.(k?.id || r.content.classes.find(x => !before.has(x.id))?.id);
    }) }, 'Save')] });
}

/** Add or edit a property. defaults: {kind, domain, range}. */
export function propForm(ctx, p, defaults = {}, done) {
  const kind = p?.kind || defaults.kind || 'object';
  const isObj = kind === 'object';
  const name = h('input', { type: 'text', value: p?.label || '', maxlength: 120, placeholder: isObj ? 'A verb phrase, e.g. applied by, secured against' : 'e.g. sanctioned amount, date of birth' });
  const domain = classSelect(ctx, p?.domain || defaults.domain);
  const range = isObj ? classSelect(ctx, p?.range || defaults.range) : select(XSD, p?.range || 'string');
  const card = select(CARD, p?.cardinality || (isObj ? '0..*' : '0..1'));
  const def = h('textarea', { rows: 2, placeholder: 'What it means and when it is filled in.' }, p?.definition || '');
  const inverse = h('input', { type: 'text', value: p?.inverse ? (ctx.c.properties.find(x => x.id === p.inverse)?.label || '') : '', placeholder: 'optional — the same link read the other way, e.g. places ↔ placed by' });
  const src = h('input', { type: 'text', value: p?.derived_from || '', placeholder: 'table.column or document term' });
  const sentence = h('div', { class: 'banner info' });
  const say = () => { sentence.textContent = isObj ? `Reads as: “${label(ctx, domain.value)} — ${name.value || '…'} → ${label(ctx, range.value)}”  (${cardText(card.value)})`
    : `Reads as: “${label(ctx, domain.value)} has ${name.value || '…'}” (${(XSD.find(x => x[0] === range.value) || [])[1] || range.value}, ${cardText(card.value)})`; };
  [name, domain, range, card].forEach(x => x.addEventListener('input', say)); say();
  modal(p ? `Edit ${isObj ? 'relationship' : 'attribute'}: ${p.label}` : isObj ? 'Add a relationship' : 'Add an attribute', h('div', { class: 'stack' },
    isObj ? h('div', { class: 'grid2' }, field('From class', domain), field('To class', range)) : h('div', { class: 'grid2' }, field('On class', domain, 'subclasses inherit it'), field('Type of value', range)),
    field(isObj ? 'Relationship name' : 'Attribute name', name), sentence, field('How many', card), field('Meaning', def),
    isObj ? field('Inverse', inverse, 'creates or links the reverse relationship') : null,
    h('details', {}, h('summary', { style: 'cursor:pointer;color:var(--accent)' }, 'Metadata: origin'), h('div', { style: 'margin-top:10px' }, field('Derived from', src))),
    p ? h('p', { class: 'small dim' }, `Identifier: ${p.id}`) : null), {
    wide: true, actions: close => [
      p ? h('button', { class: 'btn danger', style: 'margin-right:auto', onclick: async () => {
        if (!await confirmDialog(`Delete “${p.label}”?`, 'It is removed from the ontology and from the use cases that use it.', 'Delete')) return;
        try { await ctx.edit({ remove_properties: [p.id] }, `${isObj ? 'Relationship' : 'Attribute'} ${p.label} deleted`); close(); done?.(); } catch (e) { fail(e); }
      } }, 'Delete') : null,
      h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
        if (!name.value.trim()) throw new Error('Give it a name.');
        if (!domain.value || (isObj && !range.value)) throw new Error('Choose the classes it connects.');
        const item = { id: p?.id || name.value, label: name.value.trim(), kind, domain: domain.value, range: range.value, cardinality: card.value, definition: def.value, derived_from: src.value };
        const props = [item];
        if (isObj) {
          const inv = inverse.value.trim();
          if (inv) {
            const hit = ctx.c.properties.find(x => x.kind === 'object' && (x.label.toLowerCase() === inv.toLowerCase() || x.id.toLowerCase() === inv.toLowerCase()));
            const invId = hit ? hit.id : inv;
            item.inverse = invId;
            props.push(hit ? { id: hit.id, inverse: item.id } : { id: inv, label: inv, kind: 'object', domain: range.value, range: domain.value, cardinality: '0..*', definition: `Inverse of “${item.label}”.`, inverse: item.id });
          } else item.inverse = '';
        }
        await ctx.edit({ properties: props }, p ? `${isObj ? 'Relationship' : 'Attribute'} ${item.label} edited` : `${isObj ? 'Relationship' : 'Attribute'} ${item.label} added`);
        close(); done?.();
      }) }, 'Save')] });
}

/** What is known about one class, with the actions to change it. Used in the diagram side panel and in a dialog. */
function classPanel(ctx, id, { refresh, close, onShow }) {
  const k = cls(ctx, id);
  if (!k) return h('p', { class: 'dim' }, 'This class no longer exists.');
  const line = [id, ...ancestors(ctx, id)];
  const mod = ctx.c.modules.find(m => m.id === k.module), gi = ctx.c.modules.indexOf(mod);
  const attrs = ctx.c.properties.filter(p => p.kind === 'data' && line.includes(p.domain));
  const out = ctx.c.properties.filter(p => p.kind === 'object' && line.includes(p.domain));
  const inn = ctx.c.properties.filter(p => p.kind === 'object' && line.includes(p.range));
  const kids = ctx.c.classes.filter(x => x.parent === id), values = ctx.c.individuals.filter(i => i.type === id);
  const inh = p => p.domain !== id && !(p.kind === 'object' && p.range === id && p.domain === id) && line.includes(p.domain) && p.domain !== id ? h('span', { class: 'small dim' }, ` (from ${label(ctx, p.domain)})`) : null;
  const link = cid => h('a', { onclick: () => onShow?.(cid) }, label(ctx, cid));
  const pencil = p => ctx.canEdit ? h('button', { class: 'btn sm ghost', title: 'Edit', onclick: () => propForm(ctx, p, {}, refresh) }, '✎') : null;
  const act = (text, fn, c2 = '') => h('button', { class: 'btn sm ' + c2, onclick: fn }, text);
  return h('div', { class: 'stack' },
    h('div', {}, h('div', { class: 'row top' }, h('h3', { style: 'flex:1;margin:0' }, k.label), close ? null : null),
      h('div', { class: 'row wrap', style: 'margin-top:4px' }, mod ? h('span', { class: 'badge' }, h('i', { class: 'g' + (gi % 9), style: 'width:9px;height:9px;border-radius:3px;border:1.5px solid;display:inline-block' }), mod.name) : null,
        k.abstract ? h('span', { class: 'badge' }, 'grouping class') : null, k.aligned_to ? h('span', { class: 'badge info', title: 'Aligned to a published term' }, k.aligned_to) : null)),
    h('p', { style: 'margin:0' }, k.definition || h('span', { class: 'dim' }, 'No definition yet.')),
    h('dl', { class: 'kv' }, h('dt', {}, 'Is a kind of'), h('dd', {}, k.parent ? line.slice(1).map((a, i) => [i ? ' › ' : '', link(a)]) : '— (top level)'),
      kids.length ? [h('dt', {}, 'Subclasses'), h('dd', {}, kids.map((x, i) => [i ? ', ' : '', link(x.id)]))] : null,
      k.synonyms.length ? [h('dt', {}, 'Also called'), h('dd', {}, k.synonyms.join(', '))] : null,
      k.derived_from ? [h('dt', {}, 'Derived from'), h('dd', {}, k.derived_from)] : null,
      values.length ? [h('dt', {}, 'Values'), h('dd', {}, values.map(v => v.label).join(', '))] : null,
      h('dt', {}, 'Identifier'), h('dd', { class: 'mono' }, k.id)),
    ctx.canEdit ? h('div', { class: 'row wrap' }, act('✎ Edit', () => classForm(ctx, k, {}, refresh), 'primary'), act('＋ Subclass', () => classForm(ctx, null, { parent: id }, refresh)),
      act('＋ Attribute', () => propForm(ctx, null, { kind: 'data', domain: id }, refresh)), act('＋ Relationship', () => propForm(ctx, null, { kind: 'object', domain: id }, refresh)),
      act('Delete', async () => {
        const n = ctx.c.properties.filter(p => p.domain === id || p.range === id).length;
        if (!await confirmDialog(`Delete the class “${k.label}”?`, `${n} relationship(s) and attribute(s) defined on it are deleted with it.` + (kids.length ? ` Its ${kids.length} subclass(es) move up to ${k.parent ? label(ctx, k.parent) : 'the top level'}.` : ''), 'Delete')) return;
        try { await ctx.edit({ remove_classes: [id] }, `Class ${k.label} deleted`); refresh(null); } catch (e) { fail(e); }
      }, 'danger')) : null,
    h('div', {}, h('b', {}, `Attributes (${attrs.length})`), attrs.length ? h('ul', { class: 'plist' }, attrs.map(p => h('li', {}, h('span', { class: 'p' }, h('b', {}, p.label), h('span', { class: 'dim' }, ` · ${(XSD.find(x => x[0] === p.range) || [0, p.range])[1].toLowerCase()}`), inh(p),
      p.definition ? h('div', { class: 'small dim' }, p.definition) : null), pencil(p)))) : h('div', { class: 'small dim' }, 'None yet.')),
    h('div', {}, h('b', {}, `Relationships (${out.length + inn.length})`), out.length + inn.length ? h('ul', { class: 'plist' },
      out.map(p => h('li', {}, h('span', { class: 'p' }, h('b', {}, p.label), ' → ', link(p.range), inh(p), h('div', { class: 'small dim' }, cardText(p.cardinality) + (p.definition ? ' · ' + p.definition : ''))), pencil(p))),
      inn.filter(p => !out.includes(p)).map(p => h('li', {}, h('span', { class: 'p' }, link(p.domain), ' — ', h('b', {}, p.label), ' → this', p.range !== id ? h('span', { class: 'small dim' }, ` (as ${label(ctx, p.range)})`) : null), pencil(p))))
      : h('div', { class: 'small dim' }, 'None yet.')));
}

// ---- Diagram tab: the visual editor ------------------------------------------------------------
export function diagramTab(el, ctx) {
  const c = ctx.c || { modules: [], classes: [], properties: [] };
  let view = 'hierarchy', module = '', focus = null, selected = null, showAttrs = true;
  const collapsed = new Set();          // hierarchy branches folded by the user
  let keep = {};                        // zoom and scroll, kept across redraws of the same view
  const fresh = () => { keep = {}; };
  if (ctx.arg && c.modules.some(m => m.id === ctx.arg)) { view = 'module'; module = ctx.arg; }
  else if (ctx.arg && cls(ctx, ctx.arg)) { view = 'class'; focus = selected = ctx.arg; }
  const canvas = h('div', {}), side = h('div', { class: 'side' }), tools = h('div', { class: 'row wrap', style: 'margin-bottom:10px' });
  const refresh = async sel => { if (sel !== undefined) selected = sel; if (selected) reveal(selected); if (view === 'class' && !cls(ctx, focus)) { view = 'hierarchy'; focus = null; } drawTools(); await draw(); drawSide(); };
  const reveal = id => { let cur = cls(ctx, id)?.parent; while (cur) { collapsed.delete(cur); cur = cls(ctx, cur)?.parent; } };
  const showClass = id => { selected = id; if (view === 'class') focus = id; draw(); drawSide(); };

  function drawTools() {
    const cc = ctx.c || c;
    const viewSel = select([['hierarchy', 'Class hierarchy'], ['module', 'Relationships of a module'], ['class', 'Around one class']], view, v => {
      view = v; fresh(); if (v === 'module' && !module) module = cc.modules[0]?.id || ''; if (v === 'class' && !focus) focus = selected || cc.classes[0]?.id; draw(); drawTools(); }, { class: 'inline' });
    const modSel = view === 'class' ? classSelect(ctx, focus) : select([...(view === 'hierarchy' ? [['', 'All modules']] : []), ...cc.modules.map(m => [m.id, m.name])], module, null, { class: 'inline' });
    modSel.classList.add('inline');
    modSel.addEventListener('change', () => { fresh(); if (view === 'class') { focus = selected = modSel.value; drawSide(); } else module = modSel.value; draw(); });
    const attrBox = view === 'class' ? h('label', { class: 'small dim row', style: 'gap:4px' }, h('input', { type: 'checkbox', checked: showAttrs, style: 'width:auto',
      onchange: e => { showAttrs = e.target.checked; draw(); } }), 'Show attributes') : null;
    fill(tools, h('label', { class: 'small dim' }, 'View '), viewSel, cc.classes.length ? modSel : null, attrBox, h('span', { class: 'spacer' }),
      ctx.canEdit ? [h('button', { class: 'btn primary', onclick: () => classForm(ctx, null, { module: module || undefined, parent: undefined }, id => refresh(id)) }, '＋ Class'),
        h('button', { class: 'btn', disabled: (ctx.c?.classes.length || 0) < 1, onclick: () => propForm(ctx, null, { kind: 'object', domain: selected }, () => refresh()) }, '＋ Relationship'),
        h('button', { class: 'btn', disabled: (ctx.c?.classes.length || 0) < 1, onclick: () => propForm(ctx, null, { kind: 'data', domain: selected }, () => refresh()) }, '＋ Attribute')] : null);
  }
  async function draw() {
    if (!ctx.c || !ctx.c.classes.length) return fill(canvas, h('div', { class: 'card empty' }, h('p', {}, 'Nothing to draw yet.'), ctx.canEdit ? h('p', { class: 'small' }, 'Press ', h('b', {}, '＋ Class'), ' to add the first class, or build the ontology with AI from the Overview tab.') : null));
    const q = new URLSearchParams({ view });
    if (view === 'class') { q.set('cls', focus); q.set('attrs', showAttrs ? 1 : 0); } else if (module) q.set('module', module);
    if (view === 'hierarchy' && collapsed.size) q.set('collapsed', [...collapsed].join(','));
    let spec;
    try { spec = await api('GET', `/api/ontologies/${ctx.id}/diagram?${q}`); } catch (e) { return fill(canvas, h('div', { class: 'banner bad' }, e.message)); }
    const tree = view === 'hierarchy';
    const d = diagram(spec, { selected, hitLabel: 'The class in focus', onNode: n => showClass(n.id), onEdge: e => edgeMenu(e), keep, maxTarget: wrap,
      onToggle: tree ? n => { collapsed.has(n.id) ? collapsed.delete(n.id) : collapsed.add(n.id); draw(); } : null,
      onExpandAll: tree ? () => { collapsed.clear(); draw(); } : null,
      onCollapseAll: tree ? () => { collapsed.clear(); spec.nodes.filter(n => n.kids && n.id !== '__root').forEach(n => collapsed.add(n.id)); draw(); } : null });
    fill(canvas, d);
    if (view !== 'hierarchy' && !spec.edges.length) canvas.append(h('p', { class: 'small dim', style: 'margin-top:8px' }, 'No relationships to show here yet.'));
  }
  function edgeMenu(e) {
    const ps = ctx.c.properties.filter(p => p.kind === 'object' && ((p.domain === e.a && p.range === e.b) || (p.domain === e.b && p.range === e.a)));
    const fwd = ps.filter(p => p.domain === e.a && p.range === e.b);      // the line is drawn for this direction; an inverse is edited with it
    if (fwd.length === 1 && ctx.canEdit) return propForm(ctx, fwd[0], {}, () => refresh());
    modal(`${label(ctx, e.a)} ↔ ${label(ctx, e.b)}`, h('ul', { class: 'plist' }, ps.map(p => h('li', {}, h('span', { class: 'p' }, label(ctx, p.domain), ' — ', h('b', {}, p.label), ' → ', label(ctx, p.range),
      h('div', { class: 'small dim' }, cardText(p.cardinality) + (p.definition ? ' · ' + p.definition : ''))),
      ctx.canEdit ? h('button', { class: 'btn sm', onclick: ev => { ev.target.closest('.overlay').remove(); propForm(ctx, p, {}, () => refresh()); } }, 'Edit') : null))));
  }
  function drawSide() {
    if (selected && cls(ctx, selected)) return fill(side, classPanel(ctx, selected, { refresh: keep => refresh(keep === undefined ? selected : keep), onShow: showClass }),
      view !== 'class' ? h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn sm', onclick: () => { view = 'class'; focus = selected; drawTools(); draw(); drawSide(); } }, '◎ Show everything around this class')) : null);
    fill(side, h('div', { class: 'stack' }, h('h3', {}, 'How to use the diagram'), h('ul', { class: 'bul' },
      ['Click a box to see the class: its definition, attributes and relationships.', ctx.canEdit ? 'From there: edit it, add a subclass, an attribute or a relationship, or delete it.' : null,
        ctx.canEdit ? 'Click a line (or its label) in a relationship view to edit that relationship.' : 'Click a line in a relationship view to read what it means.',
        'Switch the view to see the hierarchy, one module’s relationships, or everything around one class.', 'Drag the background to move; use the buttons or Ctrl + scroll to zoom.',
        ctx.canEdit ? 'Every change is saved at once as a new version — see Versions to go back.' : null].filter(Boolean).map(x => h('li', {}, x))),
      h('p', { class: 'small dim' }, 'The layout is drawn automatically; boxes cannot be dragged to a new position.')));
  }
  const wrap = h('div', { class: 'dg-wrap' }, tools, h('div', { class: 'split' }, canvas, side));     // what Maximise fills the window with
  fill(el, wrap);
  drawTools(); draw(); drawSide();
}

// ---- Classes & properties tab ------------------------------------------------------------------
export function modelTab(el, ctx) {
  const c = ctx.c || { modules: [], classes: [], properties: [], individuals: [], rules: [] };
  let sub = 'classes', q = '';
  const body = h('div', {});
  const redraw = () => { modelTab(el, ctx); };
  const search = h('input', { type: 'search', placeholder: 'Filter by name or definition…', style: 'max-width:300px', oninput: e => { q = e.target.value.toLowerCase(); paint(); } });
  const hit = (...xs) => !q || xs.some(x => String(x || '').toLowerCase().includes(q));
  const mods = Object.fromEntries(c.modules.map(m => [m.id, m.name]));
  const tbl = (head, rows) => rows.length ? h('div', { class: 'tbl-wrap', style: 'max-height:none' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, head.map(x => h('th', {}, x)))), h('tbody', {}, rows)))
    : h('div', { class: 'card empty' }, q ? 'Nothing matches the filter.' : 'Nothing here yet.');
  const openClass = id => { const box = h('div', {}); const close = modal('Class', box, { wide: true });
    const draw = keep => { if (keep === null) { close(); return redraw(); } fill(box, classPanel(ctx, id, { refresh: k => { draw(k); paint(); }, onShow: nid => { close(); openClass(nid); } })); }; draw(); };
  const valueForm = v => {
    const name = h('input', { type: 'text', value: v?.label || '' }), type = classSelect(ctx, v?.type), def = h('input', { type: 'text', value: v?.definition || '' });
    modal(v ? 'Edit value' : 'Add a controlled value', h('div', { class: 'stack' }, field('List (class)', type, 'e.g. Order status'), field('Value', name), field('Meaning', def)), { actions: close => [
      v ? h('button', { class: 'btn danger', style: 'margin-right:auto', onclick: () => busy(null, async () => { await ctx.edit({ remove_individuals: [v.id] }, `Value ${v.label} deleted`); close(); redraw(); }) }, 'Delete') : null,
      h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
        if (!name.value.trim() || !type.value) throw new Error('Choose the list and give the value a name.');
        await ctx.edit({ individuals: [{ id: v?.id || name.value, label: name.value.trim(), type: type.value, definition: def.value }] }, `Value ${name.value.trim()} saved`); close(); redraw();
      }) }, 'Save')] });
  };
  const ruleForm = r => {
    const title = h('input', { type: 'text', value: r?.label || '' }), text = h('textarea', { rows: 3 }, r?.statement || '');
    const kind = select([['constraint', 'Constraint — something that must hold'], ['derivation', 'Derivation — how a value is calculated'], ['disjoint', 'Never overlap — the classes below can share no member (checked by the reasoner)'], ['definition', 'Definition']], r?.kind || 'constraint');
    const picks = c.classes.slice().sort(byLabel).map(k => { const cb = h('input', { type: 'checkbox', checked: r?.applies_to.includes(k.id) }); return { k, cb, el: h('label', {}, cb, k.label) }; });
    modal(r ? `Edit rule ${r.id}` : 'Add a rule', h('div', { class: 'stack' }, field('Short name', title), field('Rule, in a plain sentence', text), field('Kind', kind),
      h('div', {}, h('div', { class: 'small', style: 'font-weight:600;margin-bottom:4px' }, 'Applies to'), h('div', { class: 'pick' }, picks.map(p => p.el)))), { wide: true, actions: close => [
      r ? h('button', { class: 'btn danger', style: 'margin-right:auto', onclick: () => busy(null, async () => { await ctx.edit({ remove_rules: [r.id] }, `Rule ${r.id} deleted`); close(); redraw(); }) }, 'Delete') : null,
      h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
        if (!text.value.trim()) throw new Error('Write the rule.');
        let id = r?.id; if (!id) { let n = 1; while (c.rules.some(x => x.id === 'R' + n)) n++; id = 'R' + n; }
        await ctx.edit({ rules: [{ id, label: title.value, statement: text.value, kind: kind.value, applies_to: picks.filter(p => p.cb.checked).map(p => p.k.id) }] }, `Rule ${id} saved`); close(); redraw();
      }) }, 'Save')] });
  };
  const moduleForm = m => {
    const name = h('input', { type: 'text', value: m.name }), desc = h('textarea', { rows: 3 }, m.description || '');
    modal(`Edit module: ${m.name}`, h('div', { class: 'stack' }, field('Name', name), field('What it holds', desc)), { actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => { await ctx.edit({ modules: [{ id: m.id, name: name.value, description: desc.value }] }, `Module ${name.value} edited`); close(); redraw(); }) }, 'Save')] });
  };
  function paint() {
    const add = (text, fn) => ctx.canEdit ? h('button', { class: 'btn primary', onclick: fn }, text) : null;
    const edit = fn => ctx.canEdit ? h('button', { class: 'btn sm', onclick: e => { e.stopPropagation(); fn(); } }, 'Edit') : null;
    if (sub === 'classes') {
      const rows = [];
      c.modules.forEach((m, gi) => {
        const own = c.classes.filter(k => k.module === m.id && hit(k.label, k.definition, k.id, k.synonyms.join(' '), k.aligned_to));
        if (!own.length) return;
        rows.push(h('tr', { class: 'group' }, h('td', { colspan: 5 }, h('i', { class: 'g' + (gi % 9), style: 'width:10px;height:10px;border-radius:3px;border:1.5px solid;display:inline-block;margin-right:6px' }), `${m.name} · ${own.length}`)));
        own.forEach(k => rows.push(h('tr', { class: 'click', onclick: () => openClass(k.id) }, h('td', {}, h('b', {}, k.label), k.synonyms.length ? h('div', { class: 'small dim' }, 'also: ' + k.synonyms.join(', ')) : null),
          h('td', {}, k.parent ? label(ctx, k.parent) : h('span', { class: 'dim' }, '—')), h('td', {}, k.definition), h('td', { class: 'mono' }, k.aligned_to),
          h('td', { class: 'num' }, c.properties.filter(p => p.domain === k.id).length))));
      });
      fill(body, h('div', { class: 'stack' }, h('div', { class: 'row' }, add('＋ Class', () => classForm(ctx, null, {}, redraw)), h('span', { class: 'small dim' }, 'Click a row to open the class.')),
        tbl(['Class', 'Kind of', 'Definition', 'Aligned to', 'Own properties'], rows)));
    } else if (sub === 'rel' || sub === 'attr') {
      const obj = sub === 'rel';
      const ps = c.properties.filter(p => (p.kind === 'object') === obj && hit(p.label, p.definition, p.id, label(ctx, p.domain), obj ? label(ctx, p.range) : p.range)).sort((a, b) => label(ctx, a.domain).localeCompare(label(ctx, b.domain)));
      fill(body, h('div', { class: 'stack' }, h('div', {}, add(obj ? '＋ Relationship' : '＋ Attribute', () => propForm(ctx, null, { kind: obj ? 'object' : 'data' }, redraw))),
        tbl(obj ? ['From class', 'Relationship', 'To class', 'How many', 'Meaning', ''] : ['Class', 'Attribute', 'Type', 'How many', 'Meaning', ''],
          ps.map(p => h('tr', {}, h('td', {}, label(ctx, p.domain)), h('td', {}, h('b', {}, p.label), p.inverse ? h('div', { class: 'small dim' }, '↔ ' + (c.properties.find(x => x.id === p.inverse)?.label || p.inverse)) : null),
            h('td', {}, obj ? label(ctx, p.range) : (XSD.find(x => x[0] === p.range) || [0, p.range])[1]), h('td', { class: 'small' }, cardText(p.cardinality)), h('td', {}, p.definition),
            h('td', { class: 'right' }, edit(() => propForm(ctx, p, {}, redraw))))))));
    } else if (sub === 'values') {
      const vs = c.individuals.filter(v => hit(v.label, v.definition, label(ctx, v.type))).sort((a, b) => label(ctx, a.type).localeCompare(label(ctx, b.type)));
      fill(body, h('div', { class: 'stack' }, h('div', {}, add('＋ Value', () => valueForm(null))),
        tbl(['List', 'Value', 'Meaning', ''], vs.map(v => h('tr', {}, h('td', {}, label(ctx, v.type)), h('td', {}, h('b', {}, v.label)), h('td', {}, v.definition), h('td', { class: 'right' }, edit(() => valueForm(v))))))));
    } else if (sub === 'rules') {
      fill(body, h('div', { class: 'stack' }, h('div', {}, add('＋ Rule', () => ruleForm(null))),
        tbl(['#', 'Rule', 'Kind', 'Applies to', ''], c.rules.filter(r => hit(r.statement, r.label)).map(r => h('tr', {}, h('td', {}, r.id), h('td', {}, r.label ? h('b', {}, r.label + ' — ') : null, r.statement),
          h('td', {}, r.kind === 'disjoint' ? 'never overlap' : r.kind), h('td', { class: 'small' }, r.applies_to.map(x => label(ctx, x)).join(', ')), h('td', { class: 'right' }, edit(() => ruleForm(r))))))));
    } else {
      fill(body, tbl(['Module', 'Classes', 'What it holds', ''], c.modules.map(m => h('tr', {}, h('td', {}, h('b', {}, m.name)), h('td', { class: 'num' }, c.classes.filter(k => k.module === m.id).length),
        h('td', {}, m.description), h('td', { class: 'right' }, edit(() => moduleForm(m)))))));
    }
  }
  const n = { classes: c.classes.length, rel: c.properties.filter(p => p.kind === 'object').length, attr: c.properties.filter(p => p.kind === 'data').length, values: c.individuals.length, rules: c.rules.length, modules: c.modules.length };
  const seg = h('div', { class: 'seg' }, [['classes', 'Classes'], ['rel', 'Relationships'], ['attr', 'Attributes'], ['values', 'Controlled values'], ['rules', 'Rules'], ['modules', 'Modules']]
    .map(([k, l]) => h('button', { class: sub === k ? 'on' : '', style: 'padding:5px 12px;font-size:13px', onclick: e => { sub = k; [...seg.children].forEach(b => b.classList.toggle('on', b === e.target)); paint(); } }, `${l} ${n[k]}`)));
  fill(el, h('div', { class: 'row wrap', style: 'margin-bottom:12px' }, seg, h('span', { class: 'spacer' }), search), body);
  paint();
}

// ---- Use cases tab -----------------------------------------------------------------------------
const ORIGIN = { required: ['info', 'Required by the owner'], generated: ['', 'Written by AI'], manual: ['', 'Added by hand'], testbed: ['good', 'From the test bed'] };
export function useCasesTab(el, ctx) {
  const c = ctx.c, redraw = () => useCasesTab(el, ctx);
  const form = u => {
    const title = h('input', { type: 'text', value: u?.title || '' }), actor = h('input', { type: 'text', value: u?.actor || '', placeholder: 'e.g. Credit manager' });
    const q = h('textarea', { rows: 2 }, u?.question || ''), desc = h('textarea', { rows: 3 }, u?.description || '');
    const pc = c.classes.slice().sort(byLabel).map(k => { const cb = h('input', { type: 'checkbox', checked: u?.classes.includes(k.id) }); return { id: k.id, cb, el: h('label', {}, cb, k.label) }; });
    const pp = c.properties.slice().sort(byLabel).map(p => { const cb = h('input', { type: 'checkbox', checked: u?.properties.includes(p.id) }); return { id: p.id, cb, el: h('label', { title: `${label(ctx, p.domain)} → ${p.kind === 'object' ? label(ctx, p.range) : p.range}` }, cb, p.label) }; });
    modal(u ? `Edit ${u.id}` : 'Add a use case', h('div', { class: 'stack' }, h('div', { class: 'grid2' }, field('Title', title), field('Who asks', actor)), field('Question or task', q), field('Why it matters', desc),
      h('div', {}, h('div', { class: 'small', style: 'font-weight:600;margin-bottom:4px' }, 'Classes it uses'), h('div', { class: 'pick' }, pc.map(p => p.el))),
      h('div', {}, h('div', { class: 'small', style: 'font-weight:600;margin-bottom:4px' }, 'Relationships and attributes it uses'), h('div', { class: 'pick' }, pp.map(p => p.el))),
      u ? null : h('p', { class: 'small dim' }, 'Not sure which classes it needs? Save it without ticking any and press “Test this use case” — the test bed works it out and shows what is missing.')), {
      wide: true, actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
        if (!q.value.trim() && !title.value.trim()) throw new Error('Write the question.');
        await ctx.edit({ use_cases: [{ ...(u || {}), title: title.value || q.value.slice(0, 80), actor: actor.value, question: q.value, description: desc.value,
          classes: pc.filter(p => p.cb.checked).map(p => p.id), properties: pp.filter(p => p.cb.checked).map(p => p.id) }] }, u ? `Use case ${u.id} edited` : 'Use case added');
        close(); redraw();
      }) }, 'Save')] });
  };
  const item = u => {
    const pic = h('div', {});
    const det = h('details', { class: 'uc', open: ctx.arg === u.id }, h('summary', {}, h('span', { class: 'badge' }, u.id), h('span', { class: 'q' }, h('b', {}, u.title), h('span', { class: 'small muted' }, u.question)),
      h('span', { class: 'badge ' + (ORIGIN[u.source] || ['', ''])[0] }, (ORIGIN[u.source] || ['', u.source])[1])),
      h('div', { class: 'in stack' },
        h('p', { style: 'margin:0' }, u.actor ? h('b', {}, u.actor + ' asks: ') : null, '“' + u.question + '”'), u.description ? h('p', { style: 'margin:0' }, u.description) : null,
        pic,
        u.answer_path.length ? h('div', {}, h('b', {}, 'How the ontology answers it'), h('ol', { class: 'bul' }, u.answer_path.map(s => h('li', {}, s)))) : null,
        u.sparql ? h('details', {}, h('summary', { style: 'cursor:pointer;color:var(--accent)' }, 'Query (SPARQL)'), h('pre', { class: 'code', style: 'margin-top:8px' }, u.sparql)) : null,
        u.sample_answer ? h('div', { class: 'small muted' }, h('b', {}, 'Example answer: '), u.sample_answer) : null,
        h('div', { class: 'row wrap' }, h('button', { class: 'btn primary', onclick: () => { sessionStorage.setItem('onto-test-text', u.question || u.title); ctx.go('test', 'new'); } }, '🧪 Test this use case'),
          ctx.canEdit ? [h('button', { class: 'btn', onclick: () => form(u) }, 'Edit'), h('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog(`Delete use case ${u.id}?`, u.title, 'Delete')) { await ctx.edit({ remove_use_cases: [u.id] }, `Use case ${u.id} deleted`).catch(fail); redraw(); } } }, 'Delete')] : null)));
    const load = async () => { if (pic.dataset.done || !u.classes.length) return; pic.dataset.done = 1;
      try { fill(pic, diagram(await api('GET', `/api/ontologies/${ctx.id}/diagram?view=usecase&uc=${u.id}`), { maxHeight: 420 })); } catch (e) { fill(pic, h('div', { class: 'small dim' }, e.message)); } };
    det.addEventListener('toggle', () => { if (det.open) load(); });
    if (det.open) load();
    if (!u.classes.length) fill(pic, h('div', { class: 'banner warn' }, 'This use case does not name any class of the ontology. Test it to see whether the ontology can answer it.'));
    return det;
  };
  fill(el, h('div', { class: 'stack' }, h('div', { class: 'row wrap' }, h('p', { class: 'muted', style: 'margin:0;flex:1;min-width:260px' },
    'The questions this ontology is meant to answer. Open one to see which part of the model answers it, and test it in the test bed.'),
    ctx.canEdit ? [h('button', { class: 'btn', onclick: () => form(null) }, '＋ Add use case'), h('button', { class: 'btn primary', onclick: () => ucForm(ctx) }, '✨ Write more with AI')] : null),
    c.use_cases.length ? h('div', {}, c.use_cases.map(item)) : h('div', { class: 'card empty' }, 'No use cases yet.')));
}

// ---- Test bed ----------------------------------------------------------------------------------
export async function testTab(el, ctx) {
  const data = await api('GET', `/api/ontologies/${ctx.id}/tests`);
  const detail = h('div', {});
  const text = h('textarea', { rows: 4, placeholder: 'Describe a use case, question or report in your own words.\ne.g. For every dealer, show the loans disbursed last quarter, the tractor model financed and whether the first instalment was paid on time.' });
  const model = ctx.modelSelect();
  const preset = sessionStorage.getItem('onto-test-text');
  if (ctx.arg === 'new' && preset) { text.value = preset; sessionStorage.removeItem('onto-test-text'); }
  const run = h('button', { class: 'btn primary', disabled: !ctx.models.length, onclick: () => start(text.value) }, '🧪 Run test');
  async function start(t) {
    await busy(run, async () => {
      const r = await api('POST', `/api/ontologies/${ctx.id}/tests`, { text: t, model_id: Number(model.value) });
      fill(detail, h('div', { class: 'card row' }, h('span', { class: 'spinner' }), h('span', {}, 'Breaking the use case into requirements and checking each one against the ontology… (usually under a minute)')));
      detail.scrollIntoView({ block: 'nearest' });
      for (;;) {
        await new Promise(res => setTimeout(res, 1300));
        if (!detail.isConnected) return;
        const j = await api('GET', `/api/jobs/${r.job.id}`);
        if (j.status === 'error') { fill(detail, h('div', { class: 'banner bad' }, j.error)); break; }
        if (j.status === 'done') { ctx.arg = String(r.test.id); await testTab(el, ctx); return; }
      }
    });
  }
  const s = data.summary;
  const kpi = (l, v, sub) => h('div', { class: 'kpi' }, h('div', { class: 'l' }, l), h('div', { class: 'v' }, v), sub ? h('div', { class: 's' }, sub) : null);
  const open = async id => {
    fill(detail, h('div', { class: 'card' }, h('span', { class: 'spinner' })));
    try { fill(detail, result(await api('GET', `/api/ontologies/${ctx.id}/tests/${id}`))); } catch (e) { fill(detail, h('div', { class: 'banner bad' }, e.message)); }
    el.querySelectorAll('tr[data-id]').forEach(tr => tr.style.background = tr.dataset.id === String(id) ? 'var(--accent-soft)' : '');
  };
  function result(t) {
    if (t.status === 'running') return h('div', { class: 'card row' }, h('span', { class: 'spinner' }), 'This test is still running.');
    if (t.status === 'error') return h('div', { class: 'card stack' }, h('b', {}, t.text), h('div', { class: 'banner bad' }, t.error));
    const r = t.result, n = r.counts, tot = n.covered + n.partial + n.missing, [vc, vl] = VERDICT[t.verdict];
    const color = t.verdict === 'addressed' ? 'var(--good)' : t.verdict === 'partly' ? '#d99a1c' : 'var(--bad)';
    const stale = t.version !== t.current_version;
    const sug = r.suggestions, hasSug = sug.classes.length + sug.properties.length > 0;
    const w = k => `flex:${n[k]}`;
    return h('div', { class: 'card stack' },
      h('div', { class: 'row wrap top' }, h('div', { style: 'flex:1;min-width:260px' }, h('h2', { style: 'margin:0 0 4px' }, r.title || 'Test result'), h('div', { class: 'muted' }, '“' + t.text + '”'),
        h('div', { class: 'small dim', style: 'margin-top:4px' }, `Tested on version ${t.version} with ${t.model} · ${fmtTime(t.at)} · ${t.user}`)),
        h('button', { class: 'btn', onclick: () => start(t.text) }, '↻ Test again'),
        ctx.canEdit ? h('button', { class: 'btn', onclick: e => busy(e.target, async () => { const x = await api('POST', `/api/ontologies/${ctx.id}/tests/${t.id}/save-use-case`); toast(`Saved as use case ${x.id}.`); await ctx.load(); }) }, '＋ Save as use case') : null),
      stale ? h('div', { class: 'banner warn' }, `The ontology has changed since this test (it is now version ${t.current_version}). Press “Test again” for an up-to-date result.`) : null,
      h('div', { class: 'gauge' }, h('div', { class: 'ring', style: `--p:${Math.round(t.score * 100)};--c:${color}` }, h('div', {}, pct(t.score))),
        h('div', { style: 'flex:1;min-width:260px' }, h('div', { class: 'row', style: 'margin-bottom:8px' }, h('span', { class: 'badge ' + vc, style: 'font-size:13px;padding:3px 12px' }, vl),
          h('span', { class: 'small muted' }, `${tot} requirements checked`)),
          h('div', { class: 'bar3' }, n.covered ? h('div', { class: 'c', style: w('covered') }, `${n.covered} covered`) : null, n.partial ? h('div', { class: 'p', style: w('partial') }, `${n.partial} partial`) : null,
            n.missing ? h('div', { class: 'm', style: w('missing') }, `${n.missing} missing`) : null),
          h('p', { style: 'margin:10px 0 0' }, r.summary))),
      r.downgraded ? h('div', { class: 'banner info' }, `${r.downgraded} requirement(s) were marked down by the application’s own check: the AI model said they were covered, but the elements it pointed to do not exist or are of the wrong kind. See “Checked” below.`) : null,
      h('div', {}, h('h3', {}, 'Requirement by requirement'), h('div', { class: 'tbl-wrap', style: 'max-height:none' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ['What the use case needs', 'Type', 'Status', 'Evidence in the ontology', 'Why'].map(x => h('th', {}, x)))),
        h('tbody', {}, r.requirements.map(x => h('tr', {}, h('td', {}, x.text), h('td', { class: 'small' }, x.kind), h('td', { class: 'nowrap' }, h('span', { class: 'st ' + x.status }), x.status),
          h('td', {}, x.mapped.length ? x.mapped.map((m, i) => [i ? ', ' : '', m.type === 'class' ? h('a', { href: `#/o/${ctx.id}/diagram/${m.id}` }, label(ctx, m.id)) : h('span', { title: m.type }, ctx.c.properties.find(p => p.id === m.id)?.label || m.id)]) : h('span', { class: 'dim' }, '—')),
          h('td', { class: 'small' }, x.note, x.check ? h('div', { style: 'color:var(--warn);margin-top:3px' }, 'Checked: ' + x.check) : null))))))),
      t.diagram && t.diagram.nodes.length ? h('div', {}, h('h3', {}, 'What it touches in the ontology'), diagram(t.diagram, { maxHeight: 460 })) : null,
      r.disconnected.length ? h('div', { class: 'banner warn' }, h('b', {}, 'Not joined up: '), 'the use case needs these groups of classes together, but no relationship links them to the rest — ',
        r.disconnected.map(g => g.map(x => label(ctx, x)).join(', ')).join('; '), '.') : null,
      r.gaps.length ? h('div', {}, h('h3', {}, 'Gaps'), h('ul', { class: 'bul' }, r.gaps.map(g => h('li', {}, h('b', {}, g.text), g.impact ? h('span', { class: 'muted' }, ' — ' + g.impact) : null)))) : null,
      hasSug ? h('div', { class: 'card', style: 'background:var(--surface-2)' }, h('div', { class: 'row wrap' }, h('h3', { style: 'margin:0;flex:1' }, `Proposed additions to close the gaps (${sug.classes.length + sug.properties.length})`),
        t.fixes_applied ? h('span', { class: 'badge good' }, '✓ Added to the ontology') : ctx.canEdit ? h('button', { class: 'btn primary', disabled: stale, title: stale ? 'Test again first — the ontology has changed' : '', onclick: e => busy(e.target, async () => {
          const x = await api('POST', `/api/ontologies/${ctx.id}/tests/${t.id}/apply`); toast(`${x.added} element(s) added — now version ${x.version}. Test again to confirm.`); await ctx.load(); open(t.id);
        }) }, '＋ Add these to the ontology') : h('span', { class: 'small dim' }, 'Ask someone with edit access to add them.')),
        h('ul', { class: 'bul' }, sug.classes.map(k => h('li', {}, h('b', {}, 'Class ' + k.label), k.parent ? ` (a kind of ${label(ctx, k.parent)})` : '', k.definition ? ' — ' + k.definition : '')),
          sug.properties.map(p => h('li', {}, h('b', {}, (p.kind === 'object' ? 'Relationship ' : 'Attribute ') + p.label), ` — ${label(ctx, p.domain) || p.domain} → ${p.kind === 'object' ? (label(ctx, p.range) || p.range) : p.range}`, p.definition ? '. ' + p.definition : '')))) : null,
      r.answer_path.length ? h('div', {}, h('h3', {}, 'How it would be answered'), h('ol', { class: 'bul' }, r.answer_path.map(x => h('li', {}, x)))) : null,
      r.sparql ? h('details', {}, h('summary', { style: 'cursor:pointer;color:var(--accent)' }, 'Query (SPARQL)'), h('pre', { class: 'code', style: 'margin-top:8px' }, r.sparql)) : null);
  }
  fill(el, h('div', { class: 'stack' },
    h('div', { class: 'card stack' }, h('h2', { style: 'margin:0' }, 'Does the ontology address this use case?'),
      h('p', { class: 'muted', style: 'margin:0' }, 'Enter any use case. It is broken into the concepts, relationships, attributes and rules it needs; each is checked against the ontology; and you get the coverage, the gaps, a picture, and the additions that would close the gaps.'),
      ctx.noModel(), text, h('div', { class: 'row wrap' }, run, h('label', { class: 'small dim' }, 'AI model '), model,
        ctx.c.use_cases.length ? h('span', { class: 'small dim' }, 'or pick one: ') : null,
        ctx.c.use_cases.length ? select([['', '— a use case of this ontology —'], ...ctx.c.use_cases.map(u => [u.id, `${u.id} ${u.title}`])], '', v => { const u = ctx.c.use_cases.find(x => x.id === v); if (u) text.value = u.question || u.title; }, { class: 'inline', style: 'max-width:300px' }) : null)),
    s.tested ? h('div', { class: 'kpis' }, kpi('Use cases tested', s.tested, 'latest result of each'), kpi('Average coverage', pct(s.average)), kpi('Addressed', s.addressed), kpi('Partly addressed', s.partly), kpi('Not addressed', s.not_addressed)) : null,
    detail,
    data.items.length ? h('div', {}, h('h2', {}, 'Test history'), h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['Use case', 'Coverage', 'Verdict', 'Version', 'When', ''].map(x => h('th', {}, x)))),
      h('tbody', {}, data.items.map(t => h('tr', { class: 'click', 'data-id': t.id, onclick: () => open(t.id) }, h('td', {}, h('b', {}, t.title || t.text.slice(0, 70)), t.title ? h('div', { class: 'small dim clip', style: 'max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, t.text) : null),
        h('td', { class: 'num' }, t.status === 'done' ? pct(t.score) : '—'), h('td', {}, t.status === 'done' ? h('span', { class: 'badge ' + VERDICT[t.verdict][0] }, VERDICT[t.verdict][1]) : h('span', { class: 'badge ' + (t.status === 'error' ? 'bad' : 'info') }, t.status)),
        h('td', { class: 'num' }, t.version + (t.version !== data.version ? ' (older)' : '')), h('td', { class: 'small nowrap' }, `${fmtTime(t.at)} · ${t.user}`),
        h('td', { class: 'right' }, h('button', { class: 'btn sm ghost', title: 'Delete', onclick: async e => { e.stopPropagation(); if (await confirmDialog('Delete this test result?', t.title || t.text.slice(0, 80), 'Delete')) { await api('DELETE', `/api/ontologies/${ctx.id}/tests/${t.id}`).catch(fail); ctx.arg = null; testTab(el, ctx); } } }, '✕')))))))) : null));
  if (ctx.arg && /^\d+$/.test(ctx.arg)) open(Number(ctx.arg));
}

// ---- Quality & reasoning -----------------------------------------------------------------------
export async function qualityTab(el, ctx) {
  const q = ctx.o.quality, eng = ctx.o.reasoners;
  const rOut = h('div', {}), gOut = h('div', {});
  const names = items => items.map((x, i) => [i ? ', ' : '', cls(ctx, x) ? h('a', { href: `#/o/${ctx.id}/diagram/${x}` }, label(ctx, x)) : x]);
  const reason = engine => async e => busy(e.target, async () => {
    fill(rOut, h('div', { class: 'row' }, h('span', { class: 'spinner' }), 'Reasoning…'));
    const r = await api('POST', `/api/ontologies/${ctx.id}/reason/${engine}`);
    const L = r.logic;
    fill(rOut, h('div', { class: 'stack' },
      r.error ? h('div', { class: 'banner bad' }, r.error) : h('div', { class: 'banner ' + (r.problems.length || !r.consistent ? 'bad' : 'good') },
        h('b', {}, !r.consistent ? 'Inconsistent: the statements contradict each other.' : r.problems.length ? `${r.problems.length} logical problem(s) found.` : 'Logically consistent: no contradiction found.'),
        ` ${eng[engine].label}, version ${r.version}, ${r.seconds}s.`),
      r.problems.length ? h('ul', { class: 'bul' }, r.problems.map(p => h('li', {}, h('span', { class: 'sev ' + p.severity }, p.severity + ': '), p.text))) : null,
      r.unsatisfiable.length ? h('div', {}, h('b', {}, 'Classes that can never have a member: '), names(r.unsatisfiable)) : null,
      h('div', { class: 'small muted' }, h('b', {}, 'What there was to test: '), `${L.subclass} “is a kind of” statements, ${L.domain_range} properties with a domain and range, ${L.inverse} inverse pairs, ${L.mandatory} mandatory properties, ${L.disjoint} “never overlap” pairs, ${L.typed_values} typed values.`,
        r.inferred?.statements ? ` The reasoner derived ${r.inferred.statements.toLocaleString()} further statements` + (r.inferred.examples.length ? ` (for example: ${r.inferred.examples.slice(0, 3).join('; ')}).` : '.') : ''),
      r.notes.map(n => h('div', { class: 'banner info' }, n))));
  });
  const gaps = await api('GET', `/api/ontologies/${ctx.id}/gaps`).catch(() => ({ job: null }));
  const drawGaps = () => {
    const j = gaps.job;
    if (!j) return fill(gOut, h('p', { class: 'small dim' }, 'No review has been run yet.'));
    if (j.status === 'running' || j.status === 'queued') return fill(gOut, h('div', { class: 'row' }, h('span', { class: 'spinner' }), 'A review is running — see the progress at the top of the page.'));
    if (j.status === 'error') return fill(gOut, h('div', { class: 'banner bad' }, j.error));
    const r = j.result, add = r.added, nAdd = add.classes.length + add.properties.length + add.individuals.length + add.rules.length;
    fill(gOut, h('div', { class: 'stack' }, h('div', { class: 'small dim' }, `Reviewed by ${j.model} on version ${r.on_version} · ${fmtTime(j.at)} · ~$${j.cost.toFixed(2)}`),
      gaps.stale && !r.applied ? h('div', { class: 'banner warn' }, 'The ontology has changed since this review. Run it again before applying.') : null,
      h('div', {}, h('b', {}, `Gaps found (${r.findings.length})`), r.findings.length ? h('ul', { class: 'bul' }, r.findings.map(f => h('li', {}, f))) : h('p', { class: 'small dim' }, 'The model found no gaps.')),
      nAdd + r.changed.length + r.removed.length ? h('div', { class: 'card', style: 'background:var(--surface-2)' }, h('div', { class: 'row wrap' }, h('b', { style: 'flex:1' }, `Proposed changes: ${nAdd} to add, ${r.changed.length} to correct, ${r.removed.length} to remove`),
        r.applied ? h('span', { class: 'badge good' }, '✓ Applied') : ctx.canEdit ? h('button', { class: 'btn primary', disabled: gaps.stale, onclick: e => busy(e.target, async () => {
          const x = await api('POST', `/api/ontologies/${ctx.id}/gaps/${j.id}/apply`); toast(`Applied — now version ${x.version}.`); await ctx.reload();
        }) }, 'Apply these changes') : null),
        h('ul', { class: 'bul' }, add.classes.map(k => h('li', {}, h('b', {}, 'Class ' + k.label), k.definition ? ' — ' + k.definition : '')),
          add.properties.map(p => h('li', {}, h('b', {}, (p.kind === 'object' ? 'Relationship ' : 'Attribute ') + p.label), ` — ${label(ctx, p.domain) || p.domain} → ${p.kind === 'object' ? (label(ctx, p.range) || p.range) : p.range}`)),
          add.individuals.length ? h('li', {}, h('b', {}, 'Values: '), add.individuals.map(i => i.label).join(', ')) : null, add.rules.map(x => h('li', {}, h('b', {}, 'Rule: '), x.statement)),
          r.changed.length ? h('li', {}, h('b', {}, 'Corrected: '), r.changed.join(', ')) : null, r.removed.length ? h('li', {}, h('b', {}, 'Removed: '), r.removed.join(', ')) : null)) : null));
  };
  const model = ctx.modelSelect();
  fill(el, h('div', { class: 'stack' },
    h('div', { class: 'card stack' }, h('div', { class: 'row wrap' }, h('h2', { style: 'margin:0;flex:1' }, '1 · Modelling checks'), h('span', { class: 'badge ' + (q.score >= 85 ? 'good' : q.score >= 60 ? 'warn' : 'bad'), style: 'font-size:14px;padding:4px 14px' }, `Quality ${q.score} / 100`)),
      h('p', { class: 'muted', style: 'margin:0' }, 'Automatic checks for the common modelling pitfalls, run on every change. They need no AI.'),
      q.findings.length ? h('div', { class: 'tbl-wrap', style: 'max-height:none' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Severity', 'Finding', 'Where', 'What to do'].map(x => h('th', {}, x)))),
        h('tbody', {}, q.findings.map(f => h('tr', {}, h('td', {}, h('span', { class: 'sev ' + f.severity }, f.severity)), h('td', {}, h('b', {}, f.title), h('div', { class: 'small dim' }, `${f.count} found`)),
          h('td', { class: 'small' }, names(f.items.slice(0, 18)), f.count > 18 ? ' …' : ''), h('td', { class: 'small' }, f.advice)))))) : h('div', { class: 'banner good' }, 'No findings.')),
    h('div', { class: 'card stack' }, h('h2', { style: 'margin:0' }, '2 · Logical test with a reasoner'),
      h('p', { class: 'muted', style: 'margin:0' }, 'An OWL reasoner works out everything that follows from the ontology’s statements and reports contradictions: classes that can never have a member, relationships that cannot hold, inverses that do not mirror each other. It tests the logic — whether a concept is missing is the job of the test bed and the gap review below.'),
      h('div', { class: 'row wrap' }, h('button', { class: 'btn primary', onclick: reason('owlrl') }, '▶ Run the built-in reasoner (OWL 2 RL)'),
        h('button', { class: 'btn', disabled: !eng.hermit.available, title: eng.hermit.why_not || '', onclick: reason('hermit') }, '▶ Run HermiT (OWL 2 DL)'),
        eng.hermit.available ? null : h('span', { class: 'small dim' }, `HermiT is not available on this server: ${eng.hermit.why_not} The built-in reasoner needs nothing extra.`)),
      rOut),
    h('div', { class: 'card stack' }, h('h2', { style: 'margin:0' }, '3 · Gap review by a reasoning model'),
      h('p', { class: 'muted', style: 'margin:0' }, 'An AI model reads the whole ontology as a critical domain reviewer, lists what is missing or wrong for the stated scope and the required use cases, and proposes the additions. Nothing changes until you apply them. Any configured model can be used — Claude, or a self-hosted model such as Hermes through an OpenAI-compatible endpoint.'),
      ctx.noModel(), ctx.canEdit ? h('div', { class: 'row wrap' }, h('button', { class: 'btn primary', disabled: !ctx.models.length || !!ctx.o.job, onclick: e => busy(e.target, () => ctx.run('gaps', { model_id: Number(model.value) })) }, '🔍 Run a gap review'),
        h('label', { class: 'small dim' }, 'AI model '), model) : null,
      gOut)));
  drawGaps();
}
