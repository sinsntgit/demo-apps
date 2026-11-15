// The pre-built library: starter ontologies by industry. Preview one, then copy it into your own
// library to extend it (by hand, on the diagram, or with AI).
import { h, fill, api, busy, fail, modal, field, select, state } from './core.js';
import { diagram } from './diagram.js';

export async function templatesView(root, arg) {
  const data = await api('GET', '/api/templates');
  const canUse = state.me.role !== 'viewer';
  let industry = '', q = '';
  const grid = h('div', {});
  const chips = h('div', { class: 'steps', style: 'margin-bottom:14px' });
  const drawChips = () => fill(chips, [['', `All industries · ${data.items.length}`], ...data.industries.map(i => [i, i])].map(([k, l]) =>
    h('button', { class: industry === k ? 'on' : '', onclick: () => { industry = k; drawChips(); draw(); } }, l)));
  const draw = () => {
    const items = data.items.filter(t => (!industry || t.industry === industry) &&
      (!q || [t.name, t.industry, t.domain, t.summary, t.modules.join(' '), t.standards.join(' ')].join(' ').toLowerCase().includes(q)));
    fill(grid, items.length ? h('div', { class: 'cards' }, items.map(t => h('a', { class: 'ocard', href: '#/templates/' + t.id, onclick: e => { e.preventDefault(); preview(t.id); } },
      h('div', { class: 'small', style: 'color:var(--accent);font-weight:650;text-transform:uppercase;letter-spacing:.04em;font-size:11px' }, t.industry),
      h('h3', {}, t.name), h('div', { class: 'small muted', style: 'display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden' }, t.summary),
      h('div', { class: 'terms' }, t.standards.slice(0, 4).map(s => h('code', {}, s))),
      h('div', { class: 'meta' }, h('span', {}, h('b', {}, t.classes), ' classes'), h('span', {}, h('b', {}, t.properties), ' properties'), h('span', {}, h('b', {}, t.use_cases), ' use cases')))))
      : h('div', { class: 'card empty' }, 'Nothing in the library matches. Try another word or industry.'));
  };

  async function preview(id) {
    let t;
    try { t = await api('GET', '/api/templates/' + id); } catch (e) { return fail(e); }
    const c = t.content, pic = h('div', {}, h('span', { class: 'spinner' }));
    const mod = select([['', 'Whole hierarchy'], ...c.modules.map(m => ['h:' + m.id, `Hierarchy · ${m.name}`]), ...c.modules.map(m => ['m:' + m.id, `Relationships · ${m.name}`])], '', v => show(v), { class: 'inline' });
    const folded = new Set();
    let current = '', keep = {};
    const show = async v => {
      if (v !== current) { current = v; folded.clear(); keep = {}; }
      const [kind, m] = v ? v.split(':') : ['h', ''];
      const tree = kind !== 'm';
      try {
        const spec = await api('GET', `/api/templates/${id}/diagram?view=${tree ? 'hierarchy' : 'module'}&module=${m || ''}&collapsed=${[...folded].join(',')}`);
        fill(pic, diagram(spec, { maxHeight: 440, keep, maxTarget: pic,
          onToggle: tree ? n => { folded.has(n.id) ? folded.delete(n.id) : folded.add(n.id); show(current); } : null,
          onExpandAll: tree ? () => { folded.clear(); show(current); } : null,
          onCollapseAll: tree ? () => { folded.clear(); spec.nodes.filter(n => n.kids && n.id !== '__root').forEach(n => folded.add(n.id)); show(current); } : null }));
      } catch (e) { fill(pic, h('div', { class: 'banner bad' }, e.message)); }
    };
    const label = cid => c.classes.find(k => k.id === cid)?.label || cid;
    modal(t.name, h('div', { class: 'stack' },
      h('div', { class: 'row wrap' }, h('span', { class: 'badge info' }, t.industry), h('span', { class: 'small muted' }, `${t.stats.classes} classes · ${t.stats.object_properties} relationships · ${t.stats.data_properties} attributes · ${t.stats.individuals} controlled values · ${t.stats.rules} rules · ${t.stats.use_cases} use cases · quality ${t.quality}/100`)),
      h('p', { style: 'margin:0' }, t.summary), c.meta.scope ? h('p', { class: 'small muted', style: 'margin:0' }, h('b', {}, 'Scope: '), c.meta.scope) : null,
      h('div', { class: 'banner info' }, 'A starter model written for this application and aligned to the published standards below. It condenses their core concepts — it is not the official standard itself. Copy it, then extend it for your organisation.'),
      h('div', {}, h('b', {}, 'Aligned to'), h('ul', { class: 'bul' }, c.standards.map(s => h('li', {}, h('b', {}, s.name), ' — ', s.how_used)))),
      h('div', {}, h('div', { class: 'row', style: 'margin-bottom:8px' }, h('b', { style: 'flex:1' }, 'Diagram'), mod), pic),
      h('div', {}, h('b', {}, 'Modules and classes'), c.modules.map((m, i) => h('p', { style: 'margin:6px 0 0' },
        h('i', { class: 'g' + (i % 9), style: 'width:11px;height:11px;border-radius:3px;border:1.5px solid;display:inline-block;margin-right:6px' }), h('b', {}, m.name + ': '),
        h('span', { class: 'muted' }, c.classes.filter(k => k.module === m.id).map(k => k.label).join(', '))))),
      h('div', {}, h('b', {}, 'Questions it answers'), h('ul', { class: 'bul' }, c.use_cases.map(u => h('li', {}, h('b', {}, u.title + ': '), u.question,
        h('div', { class: 'small dim' }, 'uses ' + u.classes.map(label).join(', ')))))),
      c.explanation.how_to_read ? h('div', {}, h('b', {}, 'How to read it'), h('p', { style: 'margin:4px 0 0' }, c.explanation.how_to_read)) : null), {
      wide: true, actions: close => [h('button', { class: 'btn', onclick: close }, 'Close'),
        canUse ? h('button', { class: 'btn primary', onclick: () => { close(); useForm(t); } }, '＋ Use this ontology') : h('span', { class: 'small dim' }, 'Your role is read-only; ask an ontologist to copy it into the library.')] });
    show('');
  }

  async function useForm(t) {
    const [lib, models] = await Promise.all([api('GET', '/api/library').catch(() => ({ folders: [] })), api('GET', '/api/models').catch(() => [])]);
    const name = h('input', { type: 'text', value: t.name, maxlength: 200 });
    const folder = select([['', '— no folder —'], ...lib.folders.filter(f => f.level !== 'view').map(f => [f.id, f.name])], '');
    const instr = h('textarea', { rows: 4, placeholder: 'Optional. Tell the AI how to tailor it for you, e.g.\nWe only finance tractors and implements through dealers in three states; add subsidy schemes, crop-linked repayment and village-level collection agents.' });
    const model = select(models.map(m => [m.id, m.name + (m.is_default ? ' (default)' : '')]), models[0]?.id);
    modal(`Use “${t.name}”`, h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'A copy is created in your library. It is yours to change — the pre-built original is never modified. Afterwards you can extend it on the diagram, with ✨ AI, and test it in the test bed.'),
      field('Name of your ontology', name), field('Folder', folder),
      field('Tailor it with AI straight away', instr, models.length ? 'leave empty to copy it as it is' : 'needs an AI model — an administrator must enable one'),
      models.length ? field('AI model', model) : null), {
      wide: true, actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
        if (instr.value.trim() && !models.length) throw new Error('No AI model is enabled. Clear the instruction to copy the ontology as it is.');
        const r = await api('POST', `/api/templates/${t.id}/use`, { name: name.value, folder_id: folder.value ? Number(folder.value) : null,
          instruction: instr.value, model_id: models.length ? Number(model.value) : null });
        close(); location.hash = `#/o/${r.id}`;
      }) }, 'Create my copy')] });
  }

  fill(root, h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', { style: 'flex:1;min-width:260px' }, h('h1', {}, 'Pre-built library'),
      h('div', { class: 'muted', style: 'margin-top:4px' }, `${data.items.length} ready-made ontologies across ${data.industries.length} industries. Open one to look at it, then copy it into your library and build on it.`)),
      h('input', { type: 'search', placeholder: 'Search by name, concept or standard…', style: 'max-width:300px', oninput: e => { q = e.target.value.trim().toLowerCase(); draw(); } }),
      h('a', { class: 'btn', href: '#/library' }, '← My ontologies')),
    chips, grid));
  drawChips(); draw();
  if (arg && data.items.some(t => t.id === arg)) preview(arg);
}
