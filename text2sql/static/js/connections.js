// Data models: database / file-folder connections with their privacy and access settings.
import { h, fill, api, busy, fail, toast, modal, field, check, select, confirmDialog, fmtTime, state } from './core.js';
import { graphDiagram } from './relationships.js';

export async function connectionsView(root) {
  const types = await api('GET', '/api/connections/types');
  const isAdmin = state.me.role === 'admin';
  const body = h('div', { class: 'stack' });
  fill(root, h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h1', {}, 'Data models'), h('span', { class: 'spacer' }),
    isAdmin || state.me.role === 'steward' ? h('button', { class: 'btn', onclick: () => editCombined(null) }, '＋ Combined data model') : null,
    isAdmin ? h('button', { class: 'btn primary', onclick: () => edit(null) }, '＋ Connect a data source') : null),
  h('p', { class: 'muted', style: 'max-width:760px' }, 'A data model is one database (or a folder of Excel / CSV files) together with its own training data. Queries run directly against the source with a read-only guard; use a read-only database account as well.'), body));

  async function draw() {
    const conns = await api('GET', '/api/connections');
    fill(body, ...(conns.length ? conns.map(card) : [h('div', { class: 'empty' }, 'No data sources connected yet.')]));
  }

  function card(c) {
    if (c.db_type === 'combined') return combinedCard(c);
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
  // ---- combined data models: two or more data models answered together, linked by matching fields ----
  const CARD = [['', 'Not sure'], ['N:1', 'N:1 — many on the left, one on the right'], ['1:N', '1:N — one on the left, many on the right'], ['1:1', '1:1 — one to one']];
  const pct = n => `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;

  function combinedCard(c) {
    const canEdit = isAdmin || state.me.role === 'steward';
    return h('div', { class: 'card combined' }, h('div', { class: 'row top wrap' },
      h('div', { style: 'flex:1;min-width:240px' }, h('div', { class: 'row wrap' }, h('h2', { style: 'margin:0' }, c.name), h('span', { class: 'badge info' }, '🔗 ' + c.db_label),
        c.is_active ? null : h('span', { class: 'badge bad' }, 'disabled'),
        c.ready ? h('span', { class: 'badge good', title: 'Every data model is linked to the others by a confirmed match' }, '✓ linked')
          : h('span', { class: 'badge warn', title: 'Confirm at least one match that links each data model to the others' }, 'needs a confirmed match'),
        c.overlap_check ? h('span', { class: 'badge', title: 'Matches may be checked against the data, on this server; only percentages are kept' }, 'value check on') : null),
      h('div', { class: 'muted', style: 'margin-top:4px' }, c.description),
      c.notice ? h('div', { class: 'small', style: 'margin-top:4px;color:var(--bad)' }, '⚠ ' + c.notice) : null,
      h('div', { class: 'small dim', style: 'margin-top:4px' }, 'Combines ', c.members.map((m, i) => [i ? ' + ' : '', h('b', {}, m.name), ` (${m.alias})`]),
        ` · ${c.matches.confirmed} confirmed match${c.matches.confirmed === 1 ? '' : 'es'}` + (c.matches.suggested ? ` · ${c.matches.suggested} suggested` : '')),
      h('div', { class: 'small dim', style: 'margin-top:2px' }, c.ready ? 'Ask questions across these data models on the Ask page.' : 'Listed on the Ask page as “not ready” until confirmed matches link every data model.')),
      canEdit ? h('div', { class: 'row wrap' }, h('button', { class: 'btn sm primary', onclick: () => matches(c.id) }, '🔗 Matches'),
        h('button', { class: 'btn sm', onclick: () => editCombined(c) }, 'Edit'),
        h('button', { class: 'btn sm danger', onclick: async () => {
          if (!await confirmDialog(`Delete “${c.name}”?`, 'Only the combined data model is deleted. Its data models, their training and the matches between them stay.', 'Delete')) return;
          await api('DELETE', `/api/combined/${c.id}`).catch(fail); draw();
        } }, 'Delete')) : null));
  }

  async function editCombined(c) {
    const all = (await api('GET', '/api/connections')).filter(x => x.db_type !== 'combined' && x.id !== c?.id);
    if (all.length < 2) return toast('A combined data model needs at least two data models. Connect another data source first.', true);
    const full = c ? await api('GET', `/api/combined/${c.id}`) : null;
    const name = h('input', { type: 'text', value: full?.name || '', placeholder: 'e.g. SAP + CRM' });
    const desc = h('input', { type: 'text', value: full?.description || '', placeholder: 'What can be answered with the data models together?' });
    const guess = n => (n.replace(/^sample:\s*/i, '').toLowerCase().match(/[a-z][a-z0-9]*/)?.[0] || 'src').slice(0, 20);
    let rows = full ? full.members.map(m => ({ id: m.id, alias: m.alias })) : [{ id: all[0].id, alias: guess(all[0].name) }, { id: all[1].id, alias: guess(all[1].name) }];
    const box = h('div', { class: 'stack', style: 'gap:6px' });
    const drawRows = () => fill(box, rows.map((r, i) => h('div', { class: 'row wrap' },
      select(all.map(x => [String(x.id), x.name + (x.is_active ? '' : ' (disabled)')]), String(r.id), v => { r.id = +v; r.alias = guess(all.find(x => x.id === +v).name); drawRows(); },
        { 'aria-label': `Data model ${i + 1}`, class: 'inline', style: 'min-width:220px' }),
      h('input', { type: 'text', value: r.alias, class: 'mono', style: 'width:130px', 'aria-label': `Short name ${i + 1}`, oninput: e => { r.alias = e.target.value; } }),
      rows.length > 2 ? h('button', { class: 'btn sm ghost', type: 'button', title: 'Remove', onclick: () => { rows.splice(i, 1); drawRows(); } }, '✕') : null)),
      rows.length < Math.min(6, all.length) ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => {
        const free = all.find(x => !rows.some(r => r.id === x.id)) || all[0]; rows.push({ id: free.id, alias: guess(free.name) }); drawRows(); } }, '＋ Another data model') : null);
    drawRows();
    const overlap = check('Check values to confirm matches', full?.overlap_check, null,
      'Off by default. When on, “Find matches” also compares the values of likely key columns — on this server, never sent to the AI model. Only percentages and counts are kept, for example “96% of CRM account numbers exist in SAP”. It reads up to 10,000 distinct values per column with each person’s row filters applied.');
    const active = check('Enabled', full ? full.is_active : true);
    modal(c ? `Edit ${c.name}` : 'Combined data model', h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, 'Answer questions that need two or more data models together — for example SAP invoices with CRM support tickets. Each data model keeps its own training; you confirm which fields match between them.'),
      field('Name *', name), field('Description', desc),
      field('Data models', box, 'the short name prefixes table names, e.g. sap.kna1 and crm.accounts; lower-case letters, digits and _'),
      overlap, active,
      h('div', { class: 'small dim' }, 'People can use a combined data model only when they have access to every data model in it. Combined data models cannot contain other combined models.')), {
      wide: true, actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
        const payload = { name: name.value, description: desc.value, members: rows.map(r => ({ id: r.id, alias: r.alias.trim().toLowerCase() })), overlap_check: overlap.input.checked, is_active: active.input.checked };
        const saved = await (c ? api('PUT', `/api/combined/${c.id}`, payload) : api('POST', '/api/combined', payload));
        close(); draw();
        if (!c) { toast(`Created — ${saved.counts.suggested} suggested match${saved.counts.suggested === 1 ? '' : 'es'} to check`); matches(saved.id); } else toast('Saved');
      }) }, c ? 'Save' : 'Create and find matches')] });
  }

  async function matches(cid) {
    let v = await api('GET', `/api/combined/${cid}`);
    const dstate = { allTables: false, showSugg: true, selected: null, camera: null };
    let mode = 'list';
    const body = h('div', { class: 'stack' });
    const reload = async (nv) => { v = nv || await api('GET', `/api/combined/${cid}`); paint(); draw(); };
    const memberName = id => v.members.find(m => m.id === id)?.name || '?';
    const statsLine = e => {
      const s = e.stats; if (!s) return null;
      const lm = memberName(e.left_member), rm = memberName(e.right_member);
      const left = `${pct(s.left_pct)} of ${e.left_table} values exist in ${rm}`, right = `${pct(s.right_pct)} of ${e.right_table} values exist in ${lm}`;
      const counts = s.masked ? '' : ` (${s.matched.toLocaleString()} shared of ${s.left_distinct.toLocaleString()} / ${s.right_distinct.toLocaleString()} distinct)`;
      const ok = Math.max(s.left_pct, s.right_pct);
      return h('div', { class: 'small', style: 'margin-top:2px' }, h('span', { class: 'badge ' + (ok >= 80 ? 'good' : ok >= 30 ? 'warn' : 'bad') }, 'values ' + pct(ok)), ' ', left, ' · ', right, counts,
        s.rule !== (e.normalisation || '') ? h('span', { class: 'dim' }, ` · best with “${v.normalisations[s.rule]}”`) : null,
        s.left_truncated || s.right_truncated ? h('span', { class: 'dim' }, ' · first 10,000 distinct values') : null);
    };
    const joinCell = e => h('div', {}, h('code', { class: 'mono' }, e.left_columns.map((c, i) => `${e.left_table}.${c} = ${e.right_table}.${e.right_columns[i]}`).join('  AND  ')), ' ',
      e.cardinality ? h('span', { class: 'badge' }, e.cardinality) : null, e.kind === 'match' ? [' ', h('span', { class: 'badge info', title: 'Key rule applied to both sides before comparing' }, e.normalisation_label || 'As is')] : null,
      e.kind === 'match' ? null : h('span', { class: 'small dim' }, '  join inside one data model'));
    const evidence = e => h('div', {}, h('div', { class: 'small dim' }, e.origin_label + (e.kind === 'match' && e.status === 'suggested' ? ` · confidence ${Math.round(e.confidence * 100)}%` : '') + (e.evidence.length ? ' · ' + e.evidence.slice(0, 3).join(' · ') : '')), e.kind === 'match' ? statsLine(e) : null);
    const act = (e, action, msg) => async () => { try { await api('PUT', `/api/graph/edges/${e.id}`, { action }); toast(msg); reload(); } catch (ex) { fail(ex); } };
    const checkBtn = e => v.overlap_check && e.left_columns.length === 1 ? h('button', { class: 'btn sm', title: 'Compare the values on this server (percentages only are kept)', onclick: ev => busy(ev.target, async () => { await reload(await api('POST', `/api/combined/${cid}/matches/${e.id}/check`)); toast('Values checked'); }) }, 'Check values') : null;

    function editMatch(e) {
      const rule = select(Object.entries(v.normalisations), e.normalisation || '');
      const card = select(CARD, e.cardinality || '');
      modal('Match', h('div', { class: 'stack' }, joinCell(e),
        field('Key rule', rule, 'applied to both sides before the values are compared, e.g. “Strip leading zeros” for 0000100001 = 100001'),
        field('Rows on each side', card)), {
        actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: ev => busy(ev.target, async () => {
          await api('PUT', `/api/graph/edges/${e.id}`, { normalisation: rule.value, cardinality: card.value, action: e.status === 'suggested' ? 'confirm' : '' });
          close(); toast('Saved'); reload();
        }) }, e.status === 'suggested' ? 'Confirm with these settings' : 'Save')] });
    }

    function addMatch() {
      const raw = alias => v.tables.filter(t => t.name.startsWith(alias + '.'));
      const mopts = v.members.map(m => [String(m.id), `${m.name} (${m.alias})`]);
      const side = (mid) => {
        const o = { mid, table: '', col: '' };
        const m = () => v.members.find(x => x.id === o.mid);
        const tSel = h('span', {}), cSel = h('span', {});
        const drawCols = () => { const t = v.tables.find(x => x.name === o.table); o.col = '';
          fill(cSel, select([['', 'column…'], ...(t?.columns || []).map(c => [c.name, c.name + (c.pk ? ' 🔑' : '')])], '', val => { o.col = val; }, { 'aria-label': 'Column', class: 'inline' })); };
        const drawTables = () => { const ts = raw(m().alias); o.table = ts[0]?.name || '';
          fill(tSel, select(ts.map(t => [t.name, t.name]), o.table, val => { o.table = val; drawCols(); }, { 'aria-label': 'Table', class: 'inline', style: 'min-width:170px' })); drawCols(); };
        const mSel = select(mopts, String(mid), val => { o.mid = +val; drawTables(); }, { 'aria-label': 'Data model', class: 'inline' });
        drawTables();
        o.el = h('div', { class: 'row wrap' }, mSel, tSel, cSel);
        return o;
      };
      const L = side(v.members[0].id), R = side(v.members[1].id);
      const rule = select(Object.entries(v.normalisations), '');
      const card = select(CARD, '');
      modal('Add a match', h('div', { class: 'stack' }, h('p', { class: 'small muted' }, 'A field in one data model that identifies the same thing in another, such as the customer number.'),
        field('Field in the first data model', L.el), field('Same thing in', R.el), field('Key rule', rule, 'applied to both sides before comparing'), field('Rows on each side', card)), {
        actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: ev => busy(ev.target, async () => {
          if (!L.col || !R.col) return toast('Choose a column on both sides.', true);
          const strip = (o) => o.table.slice(v.members.find(x => x.id === o.mid).alias.length + 1);
          const nv = await api('POST', `/api/combined/${cid}/matches`, { left_member: L.mid, left_table: strip(L), left_columns: [L.col], right_member: R.mid, right_table: strip(R), right_columns: [R.col], normalisation: rule.value, cardinality: card.value });
          close(); toast('Match added and confirmed'); reload(nv);
        }) }, 'Add match')] });
    }

    function paint() {
      const sugg = v.matches.filter(e => e.status === 'suggested'), conf = v.matches.filter(e => e.status === 'confirmed'), rej = v.matches.filter(e => e.status === 'rejected');
      const find = h('button', { class: 'btn', onclick: ev => busy(ev.target, async () => {
        const nv = await api('POST', `/api/combined/${cid}/find-matches`);
        toast(`${nv.result.added} new suggestion${nv.result.added === 1 ? '' : 's'}` + (v.overlap_check ? `; values checked for ${nv.result.checked} pair${nv.result.checked === 1 ? '' : 's'}` : ''));
        reload(nv);
      }) }, '⟳ Find matches');
      const head = h('div', { class: 'stack' },
        h('div', { class: 'row wrap small' }, v.members.map(m => h('span', { class: 'badge' + (m.is_active ? '' : ' bad') }, `${m.alias} = ${m.name} · ${m.table_count} tables`)),
          v.ready ? h('span', { class: 'badge good' }, '✓ every data model is linked') : h('span', { class: 'badge warn' }, 'confirm a match that links every data model')),
        v.notice ? h('div', { class: 'small', style: 'color:var(--bad)' }, '⚠ ' + v.notice) : null,
        h('p', { class: 'small muted', style: 'margin:0' }, 'Matches are suggested from column names, descriptions, keys and types' + (v.overlap_check ? ', then checked against the values on this server (only percentages are kept).' : '. Switch on “Check values” (Edit) to compare the values as well — on this server, never sent to the AI model.')),
        h('div', { class: 'row wrap' }, find, h('button', { class: 'btn primary', onclick: addMatch }, '＋ Add match'), h('span', { class: 'spacer' }),
          h('div', { class: 'row', style: 'gap:4px' }, [['list', '☰ List'], ['diagram', '◉ Diagram']].map(([k, l]) => h('button', { class: 'btn sm' + (mode === k ? ' primary' : ''), onclick: () => { mode = k; paint(); } }, l)))));
      if (mode === 'diagram') {
        const inside = v.edges.filter(e => e.inside);
        return fill(body, head, h('p', { class: 'small dim', style: 'margin:0' }, 'Orange lines are matches between data models; blue lines are each data model’s own confirmed joins.'),
          graphDiagram({ tables: v.tables, conf: [...inside, ...conf], sugg, entities: [], st: dstate, redraw: paint, joinCell, evidence, act,
            editEdge: e => e.kind === 'match' ? editMatch(e) : toast('Edit joins inside a data model on its Training → Relationships tab.'), editEntity: () => {}, matchLabel: e => 'key rule: ' + (e.normalisation_label || 'As is') }));
      }
      const row = (e, buttons) => h('div', { class: 'item' }, h('div', { class: 'row top wrap' }, h('div', { style: 'flex:1;min-width:260px' }, joinCell(e), evidence(e)), h('div', { class: 'row wrap', style: 'justify-content:flex-end' }, buttons)));
      fill(body, head,
        h('h3', {}, `Suggestions to check (${sugg.length})`),
        sugg.length ? h('div', { class: 'card flush' }, sugg.map(e => row(e, [h('button', { class: 'btn sm primary', onclick: act(e, 'confirm', 'Confirmed') }, '✓ Confirm'),
          h('button', { class: 'btn sm', onclick: () => editMatch(e) }, 'Edit'), checkBtn(e), h('button', { class: 'btn sm danger', onclick: act(e, 'reject', 'Rejected — it will not be suggested again') }, '✗ Reject')])))
          : h('div', { class: 'empty' }, 'No suggestions waiting. Use “Find matches” after the data models change, or “＋ Add match”.'),
        h('h3', {}, `Confirmed matches (${conf.length})`),
        conf.length ? h('div', { class: 'card flush' }, conf.map(e => row(e, [h('button', { class: 'btn sm', onclick: () => editMatch(e) }, 'Edit'), checkBtn(e),
          h('button', { class: 'btn sm danger', onclick: act(e, 'reject', 'Rejected') }, 'Reject')]))) : h('div', { class: 'empty' }, 'None yet — confirm a suggestion or add a match.'),
        rej.length ? h('details', {}, h('summary', {}, `Rejected (${rej.length})`), h('div', { class: 'card flush' }, rej.map(e => row(e, [h('button', { class: 'btn sm', onclick: act(e, 'restore', 'Restored') }, 'Restore')])))) : null);
    }
    paint();
    modal(`Matches · ${v.name}`, body, { wide: true });
  }
  await draw();
}
