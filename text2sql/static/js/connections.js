// Data models: database / file-folder connections with their privacy and access settings.
import { h, fill, api, busy, fail, toast, modal, field, check, select, confirmDialog, fmtTime, state } from './core.js';

export async function connectionsView(root) {
  const types = await api('GET', '/api/connections/types');
  const isAdmin = state.me.role === 'admin';
  const body = h('div', { class: 'stack' });
  fill(root, h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h1', {}, 'Data models'), h('span', { class: 'spacer' }),
    isAdmin ? h('button', { class: 'btn primary', onclick: () => edit(null) }, '＋ Connect a data source') : null),
  h('p', { class: 'muted', style: 'max-width:760px' }, 'A data model is one database (or a folder of Excel / CSV files) together with its own training data. Queries run directly against the source with a read-only guard; use a read-only database account as well.'), body));

  async function draw() {
    const conns = await api('GET', '/api/connections');
    fill(body, ...(conns.length ? conns.map(card) : [h('div', { class: 'empty' }, 'No data sources connected yet.')]));
  }

  function card(c) {
    const status = h('span', { class: 'small' });
    const testBtn = h('button', { class: 'btn sm', onclick: () => busy(testBtn, async () => {
      status.textContent = 'Testing…'; const r = await api('POST', `/api/connections/${c.id}/test`);
      fill(status, h('span', { class: 'badge ' + (r.ok ? 'good' : 'bad') }, r.ok ? '✓ ' : '✗ ', r.message));
    }) }, 'Test connection');
    const syncBtn = h('button', { class: 'btn sm', onclick: () => busy(syncBtn, async () => { const r = await api('POST', `/api/connections/${c.id}/sync`); toast(`Schema synced: ${r.tables} tables, ${r.columns} columns`); draw(); }) }, '⟳ Sync schema');
    return h('div', { class: 'card' }, h('div', { class: 'row top wrap' },
      h('div', { style: 'flex:1;min-width:240px' }, h('div', { class: 'row wrap' }, h('h2', { style: 'margin:0' }, c.name), h('span', { class: 'badge info' }, c.db_label),
        c.is_active ? null : h('span', { class: 'badge bad' }, 'disabled'), c.restricted ? h('span', { class: 'badge warn' }, '🔒 restricted access') : null,
        c.allow_samples ? h('span', { class: 'badge warn' }, 'sample values shared with model') : null, c.masked_columns?.length ? h('span', { class: 'badge' }, `${c.masked_columns.length} masked column pattern(s)`) : null),
      h('div', { class: 'muted', style: 'margin-top:4px' }, c.description),
      h('div', { class: 'small dim', style: 'margin-top:4px' }, `${c.table_count} tables · ${c.training_count ?? 0} training items · ` + (c.schema_synced_at ? `schema synced ${fmtTime(c.schema_synced_at)}` : 'schema not synced yet'))),
      h('div', { class: 'row wrap' }, testBtn, syncBtn, c.db_type === 'files' ? h('button', { class: 'btn sm', onclick: () => files(c) }, '📁 Files') : null,
        h('a', { class: 'btn sm', href: `#/training/${c.id}` }, '🎓 Training'),
        isAdmin ? [c.restricted ? h('button', { class: 'btn sm', onclick: () => access(c) }, 'Access') : null, h('button', { class: 'btn sm', onclick: () => edit(c) }, 'Edit'),
          h('button', { class: 'btn sm danger', onclick: async () => {
            if (!await confirmDialog(`Delete “${c.name}”?`, 'Its training data and all chat history for this data model will be deleted. The source database is not touched.', 'Delete')) return;
            await api('DELETE', `/api/connections/${c.id}`).catch(fail); draw();
          } }, 'Delete')] : null)),
    h('div', { style: 'margin-top:6px' }, status));
  }

  function edit(c) {
    let type = c?.db_type || 'postgres';
    const cfg = { ...(c?.config || {}) };
    const name = h('input', { type: 'text', value: c?.name || '' });
    const desc = h('input', { type: 'text', value: c?.description || '', placeholder: 'What is in this data? Shown to users when they pick it.' });
    const fieldsEl = h('div', { class: 'grid2' });
    const drawFields = () => fill(fieldsEl, ...types[type].fields.map(f => {
      if (f.type === 'checkbox') return check(f.label, !!cfg[f.key], v => { cfg[f.key] = v; });
      const input = h('input', { type: f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text', value: cfg[f.key] ?? '', autocomplete: 'off',
        placeholder: f.secret && c?.has_password ? '•••••••• (unchanged)' : (f.placeholder || ''), oninput: e => { cfg[f.key] = e.target.value; } });
      return field(f.label + (f.required ? ' *' : ''), input);
    }));
    drawFields();
    const active = check('Enabled', c ? c.is_active : true);
    const restricted = check('Restrict to selected users', c?.restricted, null, 'Otherwise every signed-in user can query this data model. Choose users with “Access” after saving.');
    const samples = check('Share sample values of chosen columns with the AI model', c?.allow_samples, null,
      'Off by default: the model sees table and column names only. When on, up to 20 distinct values of the columns listed below (e.g. status codes, region names) are added to the schema notes to help the model write correct filters. Never list columns holding personal or confidential values.');
    const sampleCols = h('textarea', { placeholder: 'orders.status\ncustomers.region', style: 'min-height:60px', class: 'mono' }, (c?.sample_columns || []).join('\n'));
    const masked = h('textarea', { placeholder: 'email\n*phone*\nssn', style: 'min-height:60px', class: 'mono' }, (c?.masked_columns || []).join('\n'));
    const lines = el => el.value.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
    modal(c ? `Edit ${c.name}` : 'Connect a data source', h('div', { class: 'stack' },
      h('div', { class: 'grid2' }, field('Name *', name), field('Type', select(Object.entries(types).map(([k, v]) => [k, v.label]), type, v => { type = v; drawFields(); }, { disabled: !!c }))),
      field('Description', desc), h('h3', { style: 'margin-top:16px' }, 'Connection'), fieldsEl,
      type === 'files' ? h('p', { class: 'small dim' }, 'Leave the folder blank to upload files through the browser (“Files” button). Each CSV file and Excel sheet becomes a table.') : h('p', { class: 'small dim' }, 'Credentials are encrypted at rest. Use a database account that only has SELECT permission.'),
      h('h3', { style: 'margin-top:16px' }, 'Access & privacy'), active, restricted,
      field('Masked columns', masked, 'one name or pattern per line; values are hidden in results'), samples, field('Sample-value columns', sampleCols, 'table.column, one per line; applied at the next schema sync')),
    { wide: true, actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
      const payload = { name: name.value, description: desc.value, db_type: type, config: cfg, is_active: active.input.checked, restricted: restricted.input.checked,
        allow_samples: samples.input.checked, sample_columns: lines(sampleCols), masked_columns: lines(masked) };
      const saved = await (c ? api('PUT', `/api/connections/${c.id}`, payload) : api('POST', '/api/connections', payload));
      close(); toast('Saved');
      if (!c && type !== 'files') { try { const r = await api('POST', `/api/connections/${saved.id}/sync`); toast(`Schema synced: ${r.tables} tables`); } catch (ex) { toast('Saved, but the schema could not be read: ' + ex.message, true); } }
      draw();
    }) }, 'Save')] });
  }

  async function access(c) {
    const [users, cur] = await Promise.all([api('GET', '/api/admin/users'), api('GET', `/api/connections/${c.id}/access`)]);
    const picked = new Set(cur.user_ids);
    modal(`Who can query ${c.name}?`, h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Administrators always have access.'),
      users.filter(u => u.role !== 'admin').map(u => check(`${u.name || u.email} (${u.email}) · ${u.role}`, picked.has(u.id), v => v ? picked.add(u.id) : picked.delete(u.id)))),
    { actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => { await api('PUT', `/api/connections/${c.id}/access`, { user_ids: [...picked] }); close(); toast('Access updated'); }) }, 'Save')] });
  }

  async function files(c) {
    const list = h('div', {});
    const load = async () => {
      const r = await api('GET', `/api/connections/${c.id}/files`);
      fill(list, h('p', { class: 'small dim' }, 'Folder on server: ', h('span', { class: 'mono' }, r.folder)), r.files.length ? h('table', { class: 'tbl' }, h('tbody', {}, r.files.map(f => h('tr', {},
        h('td', {}, f.name), h('td', { class: 'num' }, (f.size / 1024).toFixed(0) + ' KB'), h('td', {}, f.modified),
        h('td', { class: 'right' }, h('button', { class: 'btn sm danger', onclick: async () => { await api('DELETE', `/api/connections/${c.id}/files/${encodeURIComponent(f.name)}`).catch(fail); await api('POST', `/api/connections/${c.id}/sync`).catch(() => {}); load(); draw(); } }, 'Remove')))))) : h('div', { class: 'empty' }, 'No files yet.'));
    };
    const input = h('input', { type: 'file', multiple: true, accept: '.csv,.tsv,.txt,.xlsx,.xlsm,.xls,.parquet', class: 'hidden', onchange: async e => {
      const fd = new FormData(); [...e.target.files].forEach(f => fd.append('uploads', f));
      try { await api('POST', `/api/connections/${c.id}/files`, fd); await api('POST', `/api/connections/${c.id}/sync`); toast('Files uploaded and schema refreshed'); load(); draw(); } catch (ex) { fail(ex); }
    } });
    modal(`Files in ${c.name}`, h('div', { class: 'stack' }, h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => input.click() }, '⬆ Upload CSV / Excel'), input), list), { wide: true });
    load().catch(fail);
  }
  await draw();
}
