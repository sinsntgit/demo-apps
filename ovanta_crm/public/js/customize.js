import { api, html, raw, setHtml, esc, on, store, toast, fail, modal, confirmBox, badge, $, $$ } from './core.js';
import { loadCustomization, renderFields, activeFields } from './forms.js';

const ENTITIES = [['deals', 'Deals'], ['accounts', 'Accounts'], ['contacts', 'Contacts']];
const clone = (x) => JSON.parse(JSON.stringify(x));
const NUMERIC = ['number', 'percent', 'currency'];
const typeLabel = (t) => store.custom.types[t] || t;
const bundle = (e) => store.custom.entities[e];

// ------------------------------------------------------------------ field editor dialog
function fieldModal(entity, field, done) {
  const editing = !!field; const f = field || { type: 'text', options: [], config: {}, required: false, show_in_list: false, filterable: false, searchable: false, visible_when: null, default_value: null };
  let type = f.type; let opts = (f.options || []).map((o) => ({ orig: o, text: o }));
  const candidates = () => {
    const out = [];
    for (const b of bundle(entity).builtin) if (b.type === 'select' && !['users', 'accounts', 'contacts'].includes(b.source)) out.push({ key: b.key, label: b.label, values: b.source === 'stages' ? store.meta.stages.map((s) => [s.key, s.label]) : b.options.map((o) => [o, o]) });
    for (const c of activeFields(entity)) if (c.key !== f.key) { if (['dropdown', 'multiselect'].includes(c.type)) out.push({ key: c.key, label: c.label, values: c.options.map((o) => [o, o]) }); if (c.type === 'checkbox') out.push({ key: c.key, label: c.label, values: [['true', 'Yes'], ['false', 'No']] }); }
    return out;
  };
  modal({ title: editing ? `Edit field · ${f.label}` : 'New field', wide: true, submitLabel: editing ? 'Save field' : 'Add field',
    body: html`<div class="row"><label>Field name (label)<span class="req">*</span><input name="label" value="${f.label || ''}" maxlength="60" required placeholder="e.g. Partner margin"></label>
      <label>Field type<select name="type" ${editing ? raw('disabled') : ''}>${Object.entries(store.custom.types).map(([k, v]) => html`<option value="${k}" ${k === type ? raw('selected') : ''}>${v}</option>`)}</select>${editing ? html`<span class="small muted">The type cannot change after the field is created (it would corrupt saved values).</span>` : ''}</label></div>
      <div id="typecfg"></div>
      <div class="row"><label>Help text (shown under the field)<input name="help_text" value="${f.help_text || ''}" maxlength="200"></label><label id="phbox">Placeholder<input name="placeholder" value="${f.placeholder || ''}" maxlength="100"></label></div>
      <div id="defbox"></div>
      <div class="card kpi" style="margin-bottom:12px"><b class="small">Behaviour</b><div class="pill-row mt">
        <label class="check" style="margin:0"><input type="checkbox" name="required" ${f.required ? raw('checked') : ''}> Required</label>
        <label class="check" style="margin:0"><input type="checkbox" name="show_in_list" ${f.show_in_list ? raw('checked') : ''}> Show as a column in lists</label>
        <label class="check" style="margin:0" id="filtbox"><input type="checkbox" name="filterable" ${f.filterable ? raw('checked') : ''}> Allow filtering in lists</label>
        <label class="check" style="margin:0" id="srchbox"><input type="checkbox" name="searchable" ${f.searchable ? raw('checked') : ''}> Include in search</label></div></div>
      <div class="card kpi"><b class="small">Show this field only when…</b><div class="row mt"><label>Field<select name="vw_field"><option value="">Always show</option>${candidates().map((c) => html`<option value="${c.key}" ${f.visible_when?.field === c.key ? raw('selected') : ''}>${c.label}</option>`)}</select></label><div id="vwvals"></div></div>
        <p class="small muted">Example: show “Partner” and “Partner margin” only when Deal type is Partner. Hidden fields are not required and keep any saved value.</p></div>`,
    onOpen: (form) => {
      const drawCfg = () => {
        const c = f.config || {}; const box = $('#typecfg', form);
        if (['dropdown', 'multiselect'].includes(type)) {
          setHtml(box, html`<div class="card kpi" style="margin-bottom:12px"><b class="small">List of options</b><p class="small muted" style="margin:4px 0 8px">Editing the text of an existing option renames it everywhere it is used. Removing an option keeps old values on records but stops new picks.</p>
            ${opts.map((o, i) => html`<div class="optrow"><input data-opt="${i}" value="${o.text}" maxlength="100" placeholder="Option ${i + 1}"><button type="button" class="btn sm" data-act="oup" data-i="${i}" aria-label="Move up">↑</button><button type="button" class="btn sm" data-act="odown" data-i="${i}" aria-label="Move down">↓</button><button type="button" class="btn sm danger" data-act="orm" data-i="${i}" aria-label="Remove">✕</button></div>`)}
            <button type="button" class="btn sm" data-act="oadd">+ Add option</button> <button type="button" class="btn sm" data-act="obulk">Paste a list…</button></div>`);
        } else if (NUMERIC.includes(type)) {
          setHtml(box, html`<div class="row"><label>Decimal places<input type="number" name="cfg_decimals" min="0" max="6" value="${c.decimals ?? 2}"></label>${type === 'currency' ? html`<label>Currency code (optional)<input name="cfg_code" maxlength="3" value="${c.code || ''}" placeholder="SAR"></label>` : html`<span></span>`}</div>
            <div class="row"><label>Minimum (optional)<input type="number" step="any" name="cfg_min" value="${c.min ?? ''}"></label><label>Maximum (optional)<input type="number" step="any" name="cfg_max" value="${c.max ?? ''}"></label></div>`);
        } else if (['text', 'textarea'].includes(type)) setHtml(box, html`<label style="max-width:240px">Maximum length<input type="number" name="cfg_maxLength" min="1" max="${type === 'text' ? 1000 : 5000}" value="${c.maxLength ?? (type === 'text' ? 255 : 2000)}"></label>`);
        else if (type === 'lookup') setHtml(box, html`<label style="max-width:320px">Links to<select name="cfg_target" ${editing ? raw('disabled') : ''}><option value="accounts" ${c.target === 'accounts' ? raw('selected') : ''}>An account (company, e.g. a partner)</option><option value="contacts" ${c.target === 'contacts' ? raw('selected') : ''}>A contact (person)</option></select></label>`);
        else setHtml(box, '');
        $('#filtbox', form).hidden = !['dropdown', 'multiselect', 'checkbox', 'text', 'number', 'percent', 'currency', 'date', 'email', 'phone', 'lookup'].includes(type);
        $('#srchbox', form).hidden = !['text', 'textarea', 'email', 'phone', 'url', 'dropdown'].includes(type);
        $('#phbox', form).hidden = ['checkbox', 'dropdown', 'multiselect', 'lookup', 'date'].includes(type);
        drawDefault();
      };
      const drawDefault = () => {
        const box = $('#defbox', form); const cur = f.default_value;
        if (['dropdown'].includes(type)) setHtml(box, html`<label style="max-width:320px">Default value<select name="default_value"><option value="">— none —</option>${opts.filter((o) => o.text.trim()).map((o) => html`<option ${cur === o.text ? raw('selected') : ''}>${o.text}</option>`)}</select></label>`);
        else if (type === 'checkbox') setHtml(box, html`<label style="max-width:240px">Default<select name="default_value"><option value="">— none —</option><option value="true" ${cur === true ? raw('selected') : ''}>Ticked</option><option value="false" ${cur === false ? raw('selected') : ''}>Not ticked</option></select></label>`);
        else if (NUMERIC.includes(type)) setHtml(box, html`<label style="max-width:240px">Default value<input type="number" step="any" name="default_value" value="${cur ?? ''}"></label>`);
        else if (type === 'date') setHtml(box, html`<label style="max-width:240px">Default value<input type="date" name="default_value" value="${cur ?? ''}"></label>`);
        else if (['text', 'textarea'].includes(type)) setHtml(box, html`<label>Default value<input name="default_value" value="${cur ?? ''}" maxlength="255"></label>`);
        else setHtml(box, '');
      };
      const drawVw = () => {
        const sel = form.vw_field.value; const c = candidates().find((x) => x.key === sel); const box = $('#vwvals', form);
        if (!c) { setHtml(box, html`<span class="muted small" style="line-height:38px">Shown on every record</span>`); return; }
        const cur = f.visible_when?.field === sel ? f.visible_when.values : [];
        setHtml(box, html`<div><div class="small" style="font-weight:600;margin-bottom:4px">…equals any of</div><div class="pill-row">${c.values.map(([v, l]) => html`<label class="check small" style="margin:0"><input type="checkbox" name="vw_val" value="${v}" ${cur.includes(String(v)) ? raw('checked') : ''}> ${l}</label>`)}</div></div>`);
      };
      drawCfg(); drawVw();
      form.type.addEventListener('change', () => { type = form.type.value; if (!['dropdown', 'multiselect'].includes(type)) opts = []; else if (!opts.length) opts = [{ orig: null, text: '' }, { orig: null, text: '' }]; drawCfg(); });
      form.vw_field.addEventListener('change', drawVw);
      form.addEventListener('input', (e) => { if (e.target.dataset.opt !== undefined) { opts[+e.target.dataset.opt].text = e.target.value; } });
      form.addEventListener('focusout', (e) => { if (e.target.dataset.opt !== undefined) drawDefault(); });
      on(form, {
        oadd: () => { opts.push({ orig: null, text: '' }); drawCfg(); $$('[data-opt]', form).at(-1)?.focus(); },
        orm: (el) => { opts.splice(+el.dataset.i, 1); drawCfg(); },
        oup: (el) => { const i = +el.dataset.i; if (i > 0) { [opts[i - 1], opts[i]] = [opts[i], opts[i - 1]]; drawCfg(); } },
        odown: (el) => { const i = +el.dataset.i; if (i < opts.length - 1) { [opts[i + 1], opts[i]] = [opts[i], opts[i + 1]]; drawCfg(); } },
        obulk: () => modal({ title: 'Paste a list of options', submitLabel: 'Add to list', body: html`<label>One option per line<textarea name="list" rows="8" placeholder="Direct&#10;Partner&#10;Reseller"></textarea></label>`,
          onSubmit: async (g) => { for (const line of g.list.value.split('\n').map((x) => x.trim()).filter(Boolean)) if (!opts.some((o) => o.text.toLowerCase() === line.toLowerCase())) opts.push({ orig: null, text: line }); drawCfg(); } }),
      });
    },
    onSubmit: async (form) => {
      const g = (n) => form.elements[n]; const num = (n) => (g(n) && g(n).value !== '' ? g(n).value : undefined);
      const config = {};
      if (NUMERIC.includes(type)) Object.assign(config, { decimals: num('cfg_decimals'), min: num('cfg_min'), max: num('cfg_max'), ...(type === 'currency' ? { code: g('cfg_code')?.value } : {}) });
      if (['text', 'textarea'].includes(type)) config.maxLength = num('cfg_maxLength');
      if (type === 'lookup') config.target = g('cfg_target').value;
      const vals = $$('input[name=vw_val]:checked', form).map((e) => e.value);
      const dv = g('default_value')?.value; const defaultValue = dv === undefined || dv === '' ? null : type === 'checkbox' ? dv === 'true' : dv;
      const options = opts.map((o) => o.text.trim()).filter(Boolean); const renames = {};
      for (const o of opts) if (o.orig && o.text.trim() && o.orig !== o.text.trim()) renames[o.orig] = o.text.trim();
      const body = { entity, label: g('label').value, type, config, options, required: g('required').checked, help_text: g('help_text').value, placeholder: g('placeholder').value, show_in_list: g('show_in_list').checked, filterable: g('filterable').checked, searchable: g('searchable').checked,
        default_value: defaultValue, visible_when: g('vw_field').value && vals.length ? { field: g('vw_field').value, values: vals } : null, option_renames: renames };
      if (g('vw_field').value && !vals.length) throw new Error('Choose at least one value for "Show this field only when…", or pick "Always show".');
      editing ? await api('PUT', `/customization/fields/${field.id}`, body) : await api('POST', '/customization/fields', body);
      toast('Field saved', 'ok'); done();
    } });
}

// ------------------------------------------------------------------ page
export async function customize(root) {
  let entity = sessionStorage.getItem('custEntity') || 'deals'; let L = null; let dirty = false; let dragKey = null; let showArchived = false;
  const lookups = async () => ({ accounts: (await api('GET', '/accounts?limit=300&sort=name')).rows.map((x) => [x.id, x.name]), contacts: (await api('GET', '/contacts?limit=300&sort=name')).rows.map((x) => [x.id, `${x.first_name} ${x.last_name || ''}`.trim()]) });
  const descr = () => { const b = bundle(entity); const m = {}; for (const x of b.builtin) m[x.key] = { key: x.key, label: x.label, type: x.type === 'select' ? 'list' : x.type, required: !!x.required, builtin: true }; for (const f of b.fields.filter((x) => !x.archived)) m[f.key] = { key: f.key, label: f.label, type: f.type, required: f.required, builtin: false }; return m; };
  const resetLayout = () => { L = clone(bundle(entity).layout); dirty = false; };

  const draw = async () => {
    await loadCustomization(); if (!L || L._entity !== entity) { resetLayout(); L._entity = entity; }
    const b = bundle(entity); const active = b.fields.filter((f) => !f.archived), archived = b.fields.filter((f) => f.archived);
    setHtml(root, html`<div class="topbar"><h1>Customisation</h1><span class="grow"></span></div>
      <p class="muted" style="margin-top:-8px">Add your own fields to deals, accounts and contacts (for example <i>Partner</i>, <i>Partner margin</i>, <i>Deal type</i>, <i>Deal details</i>), then arrange them into sections and save the form layout everyone sees.</p>
      <div class="tabs">${ENTITIES.map(([k, l]) => html`<button class="${entity === k ? 'on' : ''}" data-act="tab" data-e="${k}">${l}</button>`)}</div>
      <div class="card"><div class="hd"><h2>Custom fields</h2><span class="muted small">${active.length} active</span><span class="grow"></span><button class="btn primary sm" data-act="fnew">+ Add field</button></div>
        ${active.length ? html`<div class="tablewrap"><table><thead><tr><th>Field</th><th>Type</th><th>Settings</th><th></th></tr></thead><tbody>${active.map((f) => html`<tr><td><b>${f.label}</b><div class="small muted mono">${f.key}</div></td><td class="small">${typeLabel(f.type)}${f.type === 'lookup' ? ` → ${f.config.target}` : ''}${['dropdown', 'multiselect'].includes(f.type) ? html`<div class="muted">${f.options.slice(0, 4).join(', ')}${f.options.length > 4 ? ` +${f.options.length - 4}` : ''}</div>` : ''}</td>
          <td class="small">${[f.required ? 'Required' : '', f.show_in_list ? 'In lists' : '', f.filterable ? 'Filter' : '', f.searchable ? 'Search' : '', f.visible_when ? `Only when ${f.visible_when.field === 'stage' ? 'Stage' : (active.find((x) => x.key === f.visible_when.field)?.label || f.visible_when.field)} = ${f.visible_when.values.join(' / ')}` : ''].filter(Boolean).map((t) => html`<span class="badge b-grey">${t}</span> `)}</td>
          <td class="nowrap"><button class="btn sm" data-act="fedit" data-id="${f.id}">Edit</button> <button class="btn sm danger" data-act="farch" data-id="${f.id}">Archive</button></td></tr>`)}</tbody></table></div>` : html`<div class="empty">No custom fields yet. Click “Add field” to create the first one.</div>`}
        ${archived.length ? html`<div class="bd small"><a href="#" data-act="toggle-arch">${showArchived ? 'Hide' : 'Show'} ${archived.length} archived field${archived.length === 1 ? '' : 's'}</a>${showArchived ? html`<table style="margin-top:8px"><tbody>${archived.map((f) => html`<tr><td>${f.label} <span class="muted mono">${f.key}</span></td><td class="right"><button class="btn sm" data-act="frestore" data-id="${f.id}">Restore</button> <button class="btn sm danger" data-act="fpurge" data-id="${f.id}">Delete permanently…</button></td></tr>`)}</tbody></table><p class="muted">Archived fields keep their saved values and can be restored. Permanent deletion removes the values from every record.</p>` : ''}</div>` : ''}</div>
      <div class="card mt"><div class="hd"><h2>Form layout</h2>${b.layout.saved ? html`<span class="muted small">saved ${b.layout.updated_at || ''}</span>` : html`<span class="muted small">default layout (not saved yet)</span>`}${dirty ? html`<span class="badge b-warn">unsaved changes</span>` : ''}<span class="grow"></span>
        <button class="btn sm" data-act="sadd">+ Add section</button><button class="btn sm" data-act="preview">Preview form</button><button class="btn sm danger" data-act="lreset">Reset to default</button><button class="btn sm primary" data-act="lsave">Save layout</button></div>
        <div class="bd"><p class="small muted" style="margin-top:0">This is the form used when creating or editing ${ENTITIES.find((e) => e[0] === entity)[1].toLowerCase()}. <b>Drag</b> fields between sections (or use ↑ ↓), choose one or two columns per section, and drag optional standard fields to “Not on the form” to hide them. Required fields and custom fields cannot be hidden — archive a custom field to remove it.</p><div id="layoutarea"></div></div></div>`);
    drawLayout();
  };

  const drawLayout = () => {
    const d = descr(); const placed = new Set(L.sections.flatMap((s) => s.fields));
    const chip = (k, si, fi, last) => { const x = d[k]; if (!x) return ''; const removable = x.builtin && !x.required;
      return html`<div class="lchip" draggable="true" data-key="${k}"><span class="grow" title="${x.label}">${x.label}${x.required ? html` <span style="color:var(--bad)">*</span>` : ''}</span><span class="t">${x.builtin ? x.type : x.type}</span>${x.builtin ? '' : html`<span class="badge b-info">custom</span>`}<button class="x" data-act="lup" data-key="${k}" aria-label="Move up">↑</button><button class="x" data-act="ldown" data-key="${k}" aria-label="Move down">↓</button>${removable ? html`<button class="x" data-act="lhide" data-key="${k}" aria-label="Hide from form" title="Hide from form">✕</button>` : ''}</div>`; };
    const hidden = Object.values(d).filter((x) => x.builtin && !placed.has(x.key));
    setHtml($('#layoutarea', root), html`${L.sections.map((s, si) => html`<div class="lsec" data-sec="${s.id}"><div class="lh"><input data-sectitle="${si}" value="${s.title}" maxlength="60" aria-label="Section title"><select data-seccols="${si}" aria-label="Columns"><option value="2" ${s.columns !== 1 ? raw('selected') : ''}>2 columns</option><option value="1" ${s.columns === 1 ? raw('selected') : ''}>1 column</option></select><span class="grow"></span>
        <button class="btn sm" data-act="secup" data-si="${si}" ${si === 0 ? raw('disabled') : ''} aria-label="Move section up">↑</button><button class="btn sm" data-act="secdown" data-si="${si}" ${si === L.sections.length - 1 ? raw('disabled') : ''} aria-label="Move section down">↓</button><button class="btn sm danger" data-act="secdel" data-si="${si}" ${L.sections.length === 1 ? raw('disabled') : ''} aria-label="Delete section">Delete</button></div>
        <div class="lfields ${s.columns === 1 ? 'one' : ''}" data-zone="${s.id}">${s.fields.map((k, fi) => chip(k, si, fi))}${s.fields.length ? '' : html`<div class="muted small" style="grid-column:1/-1">Drop fields here</div>`}</div></div>`)}
      <div class="small" style="font-weight:600;margin:12px 0 6px">Not on the form</div><div class="lpalette" data-zone="__palette">${hidden.length ? hidden.map((x) => html`<div class="lchip" draggable="true" data-key="${x.key}"><span class="grow">${x.label}</span><span class="t">${x.type}</span><button class="x" data-act="lshow" data-key="${x.key}" title="Add to the form" aria-label="Add to the form">+</button></div>`) : html`<span class="muted small">Standard fields you hide appear here. Drag them back onto the form to show them again.</span>`}</div>`);
    for (const ch of $$('.lchip', root)) {
      ch.addEventListener('dragstart', (e) => { dragKey = ch.dataset.key; ch.classList.add('drag'); e.dataTransfer.setData('text/plain', dragKey); e.dataTransfer.effectAllowed = 'move'; });
      ch.addEventListener('dragend', () => ch.classList.remove('drag'));
    }
    for (const z of $$('[data-zone]', root)) {
      z.addEventListener('dragover', (e) => { e.preventDefault(); z.classList.add('over'); }); z.addEventListener('dragleave', (e) => { if (!z.contains(e.relatedTarget)) z.classList.remove('over'); });
      z.addEventListener('drop', (e) => { e.preventDefault(); z.classList.remove('over'); const key = dragKey || e.dataTransfer.getData('text/plain'); dragKey = null; if (key) place(key, z.dataset.zone, e.target.closest('.lchip')?.dataset.key); });
    }
  };

  const place = (key, zone, beforeKey) => {
    const x = descr()[key]; if (!x) return;
    if (zone === '__palette') { if (!x.builtin || x.required) { toast(x.required ? `"${x.label}" is required, so it must stay on the form.` : 'Custom fields cannot be hidden from the form — archive the field instead.', 'bad'); return; } }
    for (const s of L.sections) s.fields = s.fields.filter((k) => k !== key);
    if (zone !== '__palette') { const s = L.sections.find((q) => q.id === zone); if (!s) return; const i = beforeKey && beforeKey !== key ? s.fields.indexOf(beforeKey) : -1; if (i >= 0) s.fields.splice(i, 0, key); else s.fields.push(key); }
    dirty = true; drawLayout(); markDirty();
  };
  const markDirty = () => { const hd = $('.card.mt .hd', root); if (hd && !$('.b-warn', hd)) hd.insertBefore(Object.assign(document.createElement('span'), { className: 'badge b-warn', textContent: 'unsaved changes' }), hd.querySelector('.grow')); };
  const find = (k) => { for (const s of L.sections) { const i = s.fields.indexOf(k); if (i >= 0) return [s, i]; } return [null, -1]; };
  const swapIn = (k, d) => { const [s, i] = find(k); if (!s) return; const j = i + d; if (j < 0 || j >= s.fields.length) return; [s.fields[i], s.fields[j]] = [s.fields[j], s.fields[i]]; dirty = true; drawLayout(); markDirty(); };

  root.addEventListener('input', (e) => { if (e.target.dataset.sectitle !== undefined) { L.sections[+e.target.dataset.sectitle].title = e.target.value; dirty = true; markDirty(); } });
  root.addEventListener('change', (e) => { if (e.target.dataset.seccols !== undefined) { L.sections[+e.target.dataset.seccols].columns = Number(e.target.value); dirty = true; drawLayout(); markDirty(); } });
  const fieldById = (el) => bundle(entity).fields.find((f) => String(f.id) === el.dataset.id);
  const guard = async () => !dirty || await confirmBox('You have unsaved layout changes. Discard them?', 'Discard', true);
  on(root, {
    tab: async (el) => { if (!(await guard())) return; entity = el.dataset.e; sessionStorage.setItem('custEntity', entity); L = null; dirty = false; draw(); },
    'toggle-arch': () => { showArchived = !showArchived; draw(); },
    fnew: () => fieldModal(entity, null, async () => { L = null; dirty = false; draw(); }),
    fedit: (el) => fieldModal(entity, fieldById(el), async () => { draw(); }),
    farch: async (el) => { const f = fieldById(el); if (await confirmBox(`Archive "${f.label}"? It disappears from forms and lists, but saved values are kept and you can restore it later.`, 'Archive')) { await api('POST', `/customization/fields/${f.id}/archive`); toast('Field archived', 'ok'); L = null; draw(); } },
    frestore: async (el) => { await api('POST', `/customization/fields/${el.dataset.id}/restore`); toast('Field restored', 'ok'); L = null; draw(); },
    fpurge: async (el) => { const f = fieldById(el); if (await confirmBox(`Permanently delete "${f.label}" and remove its values from every record? This cannot be undone.`, 'Delete permanently')) { const r = await api('DELETE', `/customization/fields/${f.id}`); toast(`Deleted. Values removed from ${r.records_updated} record(s).`, 'ok'); draw(); } },
    lup: (el) => swapIn(el.dataset.key, -1), ldown: (el) => swapIn(el.dataset.key, 1),
    lhide: (el) => place(el.dataset.key, '__palette'), lshow: (el) => place(el.dataset.key, L.sections[0].id),
    sadd: () => { L.sections.push({ id: `s${Date.now()}`, title: 'New section', columns: 2, fields: [] }); dirty = true; drawLayout(); markDirty(); },
    secup: (el) => { const i = +el.dataset.si; [L.sections[i - 1], L.sections[i]] = [L.sections[i], L.sections[i - 1]]; dirty = true; drawLayout(); markDirty(); },
    secdown: (el) => { const i = +el.dataset.si; [L.sections[i + 1], L.sections[i]] = [L.sections[i], L.sections[i + 1]]; dirty = true; drawLayout(); markDirty(); },
    secdel: async (el) => { const i = +el.dataset.si; const s = L.sections[i]; if (s.fields.length && !(await confirmBox(`Delete the section "${s.title}"? Its fields move to the previous section.`, 'Delete', true))) return; const into = L.sections[i ? i - 1 : 1]; into.fields.push(...s.fields); L.sections.splice(i, 1); dirty = true; drawLayout(); markDirty(); },
    preview: async () => modal({ title: `Preview · new ${entity.slice(0, -1)} form`, wide: true, hideFooter: true, body: html`<p class="small muted">This is how the form will look with your current arrangement (nothing is saved).</p>${renderFields(entity, {}, await lookups(), { layout: L })}` }),
    lsave: async () => { const body = { sections: L.sections.map((s) => ({ id: s.id, title: s.title, columns: s.columns, fields: s.fields })) }; await api('PUT', `/customization/layout/${entity}`, body); toast('Layout saved — everyone sees it now', 'ok'); L = null; dirty = false; draw(); },
    lreset: async () => { if (await confirmBox('Reset this form to the default layout? Custom fields stay, but go back to the end of the form.', 'Reset')) { await api('DELETE', `/customization/layout/${entity}`); toast('Layout reset', 'ok'); L = null; dirty = false; draw(); } },
  });
  await draw();
}
