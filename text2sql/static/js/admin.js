// Admin: users, AI models, platform settings, audit log.
import { h, fill, api, busy, fail, toast, modal, field, check, select, tabs, confirmDialog, fmtTime, state } from './core.js';

export async function adminView(root, arg) {
  const t = tabs([['users', 'Users', usersTab], ['groups', 'User groups', groupsTab], ['access', 'Data access', accessTab], ['models', 'AI models', modelsTab], ['senders', 'Email senders', sendersTab], ['settings', 'Settings', settingsTab], ['audit', 'Audit log', auditTab]], arg || 'users');
  fill(root, h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h1', {}, 'Admin')), t));
}

const showPassword = (email, pw) => modal('Temporary password', h('div', { class: 'stack' },
  h('p', {}, 'Give this one-time password to ', h('b', {}, email), ' through a secure channel. They must choose their own at first sign-in. It will not be shown again.'),
  h('div', { class: 'codes', style: 'grid-template-columns:1fr;font-size:16px' }, pw),
  h('button', { class: 'btn', onclick: () => navigator.clipboard?.writeText(pw).then(() => toast('Copied')) }, 'Copy')));

function usersTab(el) {
  const ROLES = [['analyst', 'Analyst — asks questions'], ['steward', 'Data steward — also curates training, sees dashboard'], ['admin', 'Administrator — everything']];
  const edit = u => {
    const email = h('input', { type: 'email', value: u?.email || '', disabled: !!u });
    const name = h('input', { type: 'text', value: u?.name || '' });
    const role = select(ROLES, u?.role || 'analyst');
    const active = check('Account enabled', u ? u.is_active : true);
    modal(u ? `Edit ${u.email}` : 'Add user', h('div', { class: 'stack' }, field('Email', email), field('Name', name), field('Role', role), active), {
      actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
        const payload = { email: email.value, name: name.value, role: role.value, is_active: active.input.checked };
        const out = await (u ? api('PUT', `/api/admin/users/${u.id}`, payload) : api('POST', '/api/admin/users', payload));
        close(); draw(); if (out.temporary_password) showPassword(out.email, out.temporary_password);
      }) }, 'Save')] });
  };
  const act = (u, action, msg) => async () => {
    if (!await confirmDialog(msg, u.email, 'Continue', action !== 'unlock')) return;
    try { const out = await api('POST', `/api/admin/users/${u.id}/${action}`); draw(); if (out.temporary_password) showPassword(u.email, out.temporary_password); else toast('Done'); } catch (e) { fail(e); }
  };
  async function draw() {
    const users = await api('GET', '/api/admin/users');
    fill(el, h('div', { class: 'stack' }, h('div', {}, h('button', { class: 'btn primary', onclick: () => edit(null) }, '＋ Add user')),
      h('div', { class: 'tbl-wrap', style: 'max-height:none' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ['User', 'Role', 'Security', 'Last sign-in', ''].map(x => h('th', {}, x)))),
        h('tbody', {}, users.map(u => h('tr', {}, h('td', {}, h('b', {}, u.name || u.email), h('div', { class: 'small dim' }, u.email)), h('td', {}, u.role),
          h('td', {}, h('div', { class: 'row wrap' }, u.is_active ? null : h('span', { class: 'badge bad' }, 'disabled'), h('span', { class: 'badge ' + (u.totp_enabled ? 'good' : 'warn') }, u.totp_enabled ? '2FA on' : '2FA off'),
            u.locked ? h('span', { class: 'badge bad' }, 'locked') : null, u.must_change_password ? h('span', { class: 'badge' }, 'temporary password') : null)),
          h('td', { class: 'nowrap' }, fmtTime(u.last_login_at)),
          h('td', { class: 'right' }, h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'btn sm', onclick: () => edit(u) }, 'Edit'),
            h('button', { class: 'btn sm', onclick: act(u, 'reset-password', 'Reset password and sign this user out?') }, 'Reset password'),
            u.totp_enabled ? h('button', { class: 'btn sm', onclick: act(u, 'reset-2fa', 'Remove this user’s 2FA device? They will have to enrol again.') }, 'Reset 2FA') : null,
            u.locked ? h('button', { class: 'btn sm', onclick: act(u, 'unlock', 'Unlock this account?') }, 'Unlock') : null,
            u.id === state.me.id ? null : h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('Delete user?', `${u.email} and their chat history will be removed.`, 'Delete')) { await api('DELETE', `/api/admin/users/${u.id}`).catch(fail); draw(); } } }, 'Delete'))))))))));
  }
  draw().catch(fail);
}

function modelsTab(el) {
  const PRESETS = { anthropic: [['claude-opus-5-5', 'Claude Opus 5.5', 4, 20], ['claude-sonnet-5-5', 'Claude Sonnet 5.5', 2, 10], ['claude-haiku-5-5', 'Claude Haiku 5.5', 0.1, 0.5], ['claude-fable-5-2', 'Claude Fable 5.2', 8, 40]], openai: [], openai_compatible: [] };
  let providers = {};
  const edit = m => {
    const name = h('input', { type: 'text', value: m?.name || '', placeholder: 'Shown to users in the model picker' });
    const modelId = h('input', { type: 'text', value: m?.model_id || '', placeholder: 'e.g. claude-opus-5-5, gpt-5, llama3.3:70b', list: 'model-presets' });
    const presets = h('datalist', { id: 'model-presets' });
    const baseUrl = h('input', { type: 'text', value: m?.base_url || '', placeholder: 'http://ollama.internal:11434/v1' });
    const key = h('input', { type: 'password', autocomplete: 'new-password', placeholder: m?.has_key ? '•••••••• (unchanged)' : 'API key' });
    const pin = h('input', { type: 'number', step: 'any', min: 0, value: m?.price_in ?? 0 }), pout = h('input', { type: 'number', step: 'any', min: 0, value: m?.price_out ?? 0 });
    const effort = select([['', 'Model default'], 'low', 'medium', 'high', 'xhigh', 'max'], m?.effort || '');
    const enabled = check('Enabled — users can pick this model', m ? m.enabled : true), def = check('Default model', m?.is_default);
    const urlField = field('Base URL', baseUrl, 'OpenAI-compatible endpoint'), effortField = field('Reasoning effort', effort, 'Claude models that support it');
    const provider = select(Object.entries(providers).map(([k, v]) => [k, v.label]), m?.provider || 'anthropic', sync);
    function sync() {
      const p = provider.value;
      urlField.classList.toggle('hidden', p === 'anthropic'); effortField.classList.toggle('hidden', p !== 'anthropic');
      fill(presets, ...PRESETS[p].map(x => h('option', { value: x[0] }, x[1])));
    }
    modelId.addEventListener('change', () => { const hit = PRESETS[provider.value].find(x => x[0] === modelId.value); if (hit) { if (!name.value) name.value = hit[1]; pin.value = hit[2]; pout.value = hit[3]; } });
    sync();
    modal(m ? `Edit ${m.name}` : 'Add AI model', h('div', { class: 'stack' }, field('Provider', provider), h('div', { class: 'grid2' }, field('Model ID', modelId), field('Display name', name)), presets, urlField,
      field('API key', key, 'encrypted at rest; never shown again'), effortField,
      h('div', { class: 'grid2' }, field('Input price', pin, '$ per million tokens'), field('Output price', pout, '$ per million tokens')), enabled, def,
      h('p', { class: 'small dim' }, 'Whatever the provider, the model receives only the question, schema and training notes — never query results. Choose a self-hosted model if even schema names must stay on your network.')), {
      actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
        const payload = { name: name.value, provider: provider.value, model_id: modelId.value, base_url: provider.value === 'anthropic' ? '' : baseUrl.value, api_key: key.value, effort: provider.value === 'anthropic' ? effort.value : '',
          enabled: enabled.input.checked, is_default: def.input.checked, price_in: Number(pin.value) || 0, price_out: Number(pout.value) || 0 };
        await (m ? api('PUT', `/api/admin/models/${m.id}`, payload) : api('POST', '/api/admin/models', payload)); close(); toast('Saved'); draw();
      }) }, 'Save')] });
  };
  async function draw() {
    const data = await api('GET', '/api/admin/models'); providers = data.providers;
    fill(el, h('div', { class: 'stack' }, h('div', {}, h('button', { class: 'btn primary', onclick: () => edit(null) }, '＋ Add model')),
      data.models.length ? h('div', { class: 'card flush' }, data.models.map(m => {
        const status = h('span', { class: 'small' });
        const test = h('button', { class: 'btn sm', onclick: () => busy(test, async () => { status.textContent = 'Testing…'; const r = await api('POST', `/api/admin/models/${m.id}/test`); fill(status, h('span', { class: 'badge ' + (r.ok ? 'good' : 'bad') }, r.ok ? '✓ ' : '✗ ', r.message)); }) }, 'Test');
        return h('div', { class: 'item' }, h('div', { class: 'row wrap' }, h('div', { style: 'flex:1;min-width:220px' }, h('div', { class: 'row wrap' }, h('b', {}, m.name), m.is_default ? h('span', { class: 'badge info' }, 'default') : null,
          m.enabled ? null : h('span', { class: 'badge bad' }, 'disabled'), !m.has_key && m.provider !== 'openai_compatible' ? h('span', { class: 'badge warn' }, 'no API key') : null),
        h('div', { class: 'small dim' }, `${providers[m.provider]?.label || m.provider} · ${m.model_id}${m.base_url ? ' · ' + m.base_url : ''} · $${m.price_in}/$${m.price_out} per MTok`)),
        status, test, h('button', { class: 'btn sm', onclick: () => edit(m) }, 'Edit'),
        h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('Delete model?', `${m.name} will be removed. Past queries keep its name.`, 'Delete')) { await api('DELETE', `/api/admin/models/${m.id}`).catch(fail); draw(); } } }, 'Delete')));
      })) : h('div', { class: 'empty' }, 'No models configured.')));
  }
  draw().catch(fail);
}

function settingsTab(el) {
  api('GET', '/api/admin/settings').then(s => {
    const num = k => h('input', { type: 'number', value: s[k], style: 'max-width:140px', oninput: e => { s[k] = e.target.value; } });
    const bool = (k, label, hint) => check(label, s[k], v => { s[k] = v; }, hint);
    const text = (k, ph) => h('input', { type: 'text', value: s[k] || '', placeholder: ph, oninput: e => { s[k] = e.target.value; } });
    const fb = select([['approval', 'Send to a steward for approval first'], ['instant', 'Use immediately for training']], s.feedback_mode, v => { s.feedback_mode = v; }, { style: 'max-width:340px' });
    const save = h('button', { class: 'btn primary', onclick: () => busy(save, async () => { await api('PUT', '/api/admin/settings', s); toast('Settings saved'); }) }, 'Save settings');
    fill(el, h('div', { class: 'stack', style: 'max-width:680px' },
      h('div', { class: 'card stack' }, h('h2', {}, 'Security'), bool('enforce_2fa', 'Require two-factor authentication for everyone', 'Users without 2FA are sent to enrolment on their next request — including you.'),
        h('div', { class: 'grid2' }, field('Session length (hours)', num('session_hours')), field('Questions per user per minute', num('rate_limit_per_min')),
          field('Failed sign-ins before lockout', num('lockout_attempts')), field('Lockout duration (minutes)', num('lockout_minutes')))),
      h('div', { class: 'card stack' }, h('h2', {}, 'Query execution'), h('div', { class: 'grid2' }, field('Maximum rows returned', num('max_rows')), field('Query timeout (seconds)', num('query_timeout_s')),
        field('Automatic SQL repair attempts', num('max_repair_attempts'), 'after a database error')),
        bool('store_results', 'Keep result snapshots in chat history', 'Turn off if query results must never be stored outside the source database. Users can still re-run saved SQL.')),
      h('div', { class: 'card stack' }, h('h2', {}, 'Training from user feedback'), field('When an analyst confirms or corrects SQL', fb, 'admins and data stewards are always trusted')),
      h('div', { class: 'card stack' }, h('h2', {}, 'Email'),
        field('Web address of this app', text('public_url', 'https://askdata.yourcompany.com'), 'used for the “open the live report” link in report emails'),
        h('p', { class: 'small', style: 'margin:0' }, 'Mailboxes used to send scheduled reports are set up under ', h('a', { href: '#/admin/senders' }, 'Admin → Email senders'), '.')),
      h('div', {}, save)));
  }).catch(fail);
}

function auditTab(el) {
  const f = { q: '', action: '', page: 1 };
  const body = h('div', {});
  const search = h('input', { type: 'search', placeholder: 'Search user, target, detail…', style: 'max-width:300px' });
  let timer; search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { f.q = search.value; f.page = 1; draw(); }, 300); });
  const qs = () => new URLSearchParams({ q: f.q, action: f.action, page: f.page }).toString();
  const prev = h('button', { class: 'btn sm', onclick: () => { f.page--; draw(); } }, '‹ Newer'), next = h('button', { class: 'btn sm', onclick: () => { f.page++; draw(); } }, 'Older ›');
  fill(el, h('div', { class: 'stack' }, h('div', { class: 'row wrap' }, search,
    select([['', 'All events'], ['login', 'Sign-ins'], ['query', 'Queries'], ['training', 'Training'], ['report', 'Reports'], ['connection', 'Data models'], ['filter', 'Data filters'], ['group', 'User groups'], ['sender', 'Email senders'], ['user', 'Users'], ['model', 'AI models'], ['settings', 'Settings'], ['2fa', '2FA'], ['password', 'Passwords']], '', v => { f.action = v; f.page = 1; draw(); }, { class: 'inline' }),
    h('span', { class: 'spacer' }), prev, next, h('a', { class: 'btn sm', href: '#', onclick: e => { e.preventDefault(); location.href = '/api/admin/audit.csv?' + qs(); } }, '⬇ CSV')), body));
  async function draw() {
    const r = await api('GET', '/api/admin/audit?' + qs()).catch(fail);
    if (!r) return;
    prev.disabled = f.page <= 1; next.disabled = !r.more;
    fill(body, h('div', { class: 'tbl-wrap', style: 'max-height:none' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Time', 'User', 'Event', 'Target', 'Detail', 'IP'].map(x => h('th', {}, x)))),
      h('tbody', {}, r.items.map(a => h('tr', {}, h('td', { class: 'nowrap' }, fmtTime(a.at)), h('td', {}, a.user), h('td', { class: 'mono' }, a.action), h('td', {}, a.target), h('td', { class: 'small' }, a.detail), h('td', { class: 'mono' }, a.ip)))))));
  }
  draw();
}

// Who can use each data model, and which rows they are allowed to see.
function accessTab(el) {
  const ROLE = [['analyst', 'analysts'], ['steward', 'data stewards']];
  async function draw() {
    const data = await api('GET', '/api/admin/access');
    const people = data.users.filter(u => u.role !== 'admin');
    fill(el, h('div', { class: 'stack' },
      h('p', { class: 'muted', style: 'max-width:820px' }, 'Control who can query each data model, and limit the rows they see. Administrators always have full access. Filters are added to every query by the server — in chats, in edited SQL and in reports — so they cannot be bypassed.'),
      data.connections.length ? data.connections.map(c => card(c, people, data)) : h('div', { class: 'empty' }, 'No data models yet.')));
  }
  function card(c, people, data) {
    const st = { is_active: c.is_active, restricted: c.restricted, users: new Set(c.user_ids) };
    const userBox = h('div', { class: 'access-users' });
    const drawUsers = () => fill(userBox, !st.restricted ? h('div', { class: 'small dim' }, 'Every signed-in user can query this data model.')
      : people.length ? people.map(u => check(`${u.name}  ·  ${u.role}`, st.users.has(u.id), v => v ? st.users.add(u.id) : st.users.delete(u.id), u.email))
        : h('div', { class: 'small dim' }, 'There are no non-admin users yet.'));
    drawUsers();
    const saveBtn = h('button', { class: 'btn primary sm', onclick: () => busy(saveBtn, async () => {
      await api('PUT', `/api/admin/access/${c.id}`, { is_active: st.is_active, restricted: st.restricted, user_ids: [...st.users] }); toast(`Access to “${c.name}” saved`); draw();
    }) }, 'Save access');
    return h('div', { class: 'card stack' },
      h('div', { class: 'row wrap' }, h('h2', { style: 'margin:0' }, c.name), c.is_active ? h('span', { class: 'badge good' }, 'enabled') : h('span', { class: 'badge bad' }, 'disabled'),
        c.restricted ? h('span', { class: 'badge warn' }, `🔒 ${c.user_ids.length} user(s)`) : h('span', { class: 'badge' }, 'open to all users'),
        c.filters.length ? h('span', { class: 'badge info' }, `${c.filters.filter(f => f.enabled).length} data filter(s)`) : null),
      h('div', { class: 'grid2' },
        h('div', { class: 'stack' }, h('h3', {}, 'Access'),
          check('Enabled', st.is_active, v => { st.is_active = v; }, 'Turn off to hide this data model from everyone except administrators.'),
          check('Only selected users may use it', st.restricted, v => { st.restricted = v; drawUsers(); }, 'Otherwise it is open to every signed-in user.'), h('div', {}, saveBtn)),
        h('div', { class: 'stack' }, h('h3', {}, 'Users with access'), userBox)),
      h('div', {}, h('div', { class: 'row' }, h('h3', { style: 'margin:0' }, 'Data filters'), h('span', { class: 'spacer' }), h('button', { class: 'btn sm', onclick: () => editFilter(c, null, data) }, '＋ Add filter')),
        c.filters.length ? h('div', { class: 'tbl-wrap', style: 'margin-top:8px;max-height:none' }, h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, ['Table', 'Only rows where', 'Applies to', 'Note', ''].map(t => h('th', {}, t)))),
          h('tbody', {}, c.filters.map(f => h('tr', {}, h('td', { class: 'mono' }, f.table_name), h('td', { class: 'mono' }, f.condition), h('td', {}, f.applies_to, f.enabled ? null : h('span', { class: 'badge bad', style: 'margin-left:6px' }, 'off')),
            h('td', { class: 'small' }, f.description), h('td', { class: 'right nowrap' }, h('button', { class: 'btn sm', onclick: () => editFilter(c, f, data) }, 'Edit'), ' ',
              h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('Delete data filter?', `${f.table_name}: ${f.condition} — the people it applied to will see all rows again.`, 'Delete')) { await api('DELETE', `/api/admin/filters/${f.id}`).catch(fail); draw(); } } }, 'Delete')))))))
          : h('p', { class: 'small dim', style: 'margin:6px 0 0' }, 'No filters: everyone with access sees all rows.')));
  }
  function editFilter(c, f, data) {
    const table = h('input', { type: 'text', value: f?.table_name || '', list: 'filter-tables', placeholder: 'e.g. customers' });
    const cond = h('textarea', { class: 'mono', style: 'min-height:70px', placeholder: "region = 'North'" }, f?.condition || '');
    const note = h('input', { type: 'text', value: f?.description || '', placeholder: 'Optional: why this filter exists' });
    const st = { scope: f?.scope || 'role', role: f?.role || 'analyst', user_id: f?.user_id || '' };
    const who = h('div', { class: 'row wrap' });
    const drawWho = () => fill(who, select([['all', 'Everyone (except administrators)'], ['role', 'Everyone with the role…'], ['user', 'One person…']], st.scope, v => { st.scope = v; drawWho(); }, { class: 'inline' }),
      st.scope === 'role' ? select(ROLE, st.role, v => { st.role = v; }, { class: 'inline' }) : null,
      st.scope === 'user' ? select([['', 'choose…'], ...data.users.filter(u => u.role !== 'admin').map(u => [u.id, `${u.name} (${u.email})`])], st.user_id, v => { st.user_id = v; }, { class: 'inline' }) : null);
    drawWho();
    const on = check('Filter is active', f ? f.enabled : true);
    modal(f ? 'Edit data filter' : `Add data filter — ${c.name}`, h('div', { class: 'stack' },
      h('datalist', { id: 'filter-tables' }, c.tables.map(t => h('option', { value: t }))),
      field('Table', table, 'the filter applies wherever this table is used'), field('Only show rows where', cond, 'a condition on that table’s columns — what you would write after WHERE'),
      h('div', { class: 'small dim' }, 'Examples: ', h('span', { class: 'mono' }, "region = 'North'"), ' · ', h('span', { class: 'mono' }, "country IN ('IN', 'AE')"), ' · ', h('span', { class: 'mono' }, 'sales_rep_email = {user_email}'),
        h('br'), 'Placeholders filled in with the signed-in person’s details: ', h('span', { class: 'mono' }, data.placeholders.join('  ')), '.'),
      field('Applies to', who), field('Note', note), on,
      h('div', { class: 'banner info small' }, 'If several filters on the same table apply to someone (for example one for their role and one for them personally) they must satisfy all of them. To filter a table that links to this one (for example orders of North-region customers), add a filter on that table too, or rely on the join: rows are only removed from the table named here.')), {
      wide: true, actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
        const body = { connection_id: c.id, table_name: table.value, condition: cond.value, scope: st.scope, role: st.role, user_id: st.user_id ? Number(st.user_id) : null, description: note.value, enabled: on.input.checked };
        await (f ? api('PUT', `/api/admin/filters/${f.id}`, body) : api('POST', '/api/admin/filters', body)); close(); toast('Data filter saved'); draw();
      }) }, 'Save filter')] });
  }
  draw().catch(fail);
}

// Groups of users: share a report with a group, or email a scheduled report to everyone in it.
function groupsTab(el) {
  async function draw() {
    const [groups, users] = await Promise.all([api('GET', '/api/admin/groups'), api('GET', '/api/admin/users')]);
    const name = id => { const u = users.find(x => x.id === id); return u ? (u.name || u.email) : null; };
    const edit = g => {
      const title = h('input', { type: 'text', value: g?.name || '', placeholder: 'e.g. Finance team' });
      const desc = h('input', { type: 'text', value: g?.description || '', placeholder: 'Optional' });
      const picked = new Set(g?.user_ids || []);
      const find = h('input', { type: 'search', placeholder: 'Find a user…' });
      const list = h('div', { class: 'access-users', style: 'max-height:260px' });
      const count = h('span', { class: 'small dim' });
      const paint = () => { const q = find.value.toLowerCase(); count.textContent = `${picked.size} selected`;
        fill(list, users.filter(u => u.is_active && (u.name + ' ' + u.email).toLowerCase().includes(q)).map(u => check(`${u.name || u.email}  ·  ${u.role}`, picked.has(u.id), v => { v ? picked.add(u.id) : picked.delete(u.id); count.textContent = `${picked.size} selected`; }, u.email))); };
      find.addEventListener('input', paint); paint();
      modal(g ? `Edit group · ${g.name}` : 'New user group', h('div', { class: 'stack' }, h('div', { class: 'grid2' }, field('Group name', title), field('Description', desc)),
        h('div', { class: 'row' }, h('h3', { style: 'margin:0' }, 'Members'), count, h('span', { class: 'spacer' }), h('div', { style: 'width:220px' }, find)), list), {
        wide: true, actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
          const body = { name: title.value, description: desc.value, user_ids: [...picked] };
          await (g ? api('PUT', `/api/admin/groups/${g.id}`, body) : api('POST', '/api/admin/groups', body)); close(); toast('Group saved'); draw();
        }) }, 'Save group')] });
    };
    fill(el, h('div', { class: 'stack' }, h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => edit(null) }, '＋ New group'),
      h('span', { class: 'small dim' }, 'Use groups to share a report with a team, or to email a scheduled report to everyone in it. A user can be in several groups.')),
      groups.length ? h('div', { class: 'card flush' }, groups.map(g => h('div', { class: 'item row top' },
        h('div', { style: 'flex:1' }, h('div', { class: 'row wrap' }, h('b', {}, g.name), h('span', { class: 'badge' }, `${g.user_ids.length} member${g.user_ids.length === 1 ? '' : 's'}`)),
          g.description ? h('div', { class: 'muted small' }, g.description) : null,
          h('div', { class: 'small dim', style: 'margin-top:4px' }, g.user_ids.map(name).filter(Boolean).join(', ') || 'No members yet')),
        h('button', { class: 'btn sm', onclick: () => edit(g) }, 'Edit'),
        h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('Delete group?', `“${g.name}” will be removed. Reports shared with it stop being shared with its members; schedules stop emailing it. The users themselves are not affected.`, 'Delete')) { await api('DELETE', `/api/admin/groups/${g.id}`).catch(fail); draw(); } } }, 'Delete'))))
        : h('div', { class: 'empty' }, 'No groups yet.')));
  }
  draw().catch(fail);
}

// Mailboxes the platform sends scheduled reports from.
const MAIL_PRESETS = {
  titan: { label: 'Titan Mail / GoDaddy Professional Email', host: 'smtpout.secureserver.net', port: 465, secure: true,
    help: 'Server smtpout.secureserver.net, port 465 with SSL/TLS on (or port 587 with SSL/TLS off). Username is the full email address and the password is your normal mailbox password.' },
  titan_direct: { label: 'Titan Mail (Hostinger / BigRock / other hosts)', host: 'smtp.titan.email', port: 465, secure: true,
    help: 'For Titan mailboxes not bought through GoDaddy. Username is the full email address and the password is your normal mailbox password. EU-region accounts use smtp0101.titan.email. If 465 fails, try port 587 with SSL/TLS off.' },
  google: { label: 'Google (Gmail / Workspace)', host: 'smtp.gmail.com', port: 587, secure: false,
    help: 'Use the full email address as username and a 16-character App Password (Google Account → Security → 2-Step Verification → App passwords). Regular passwords are rejected.' },
  microsoft: { label: 'Microsoft 365 / Outlook', host: 'smtp.office365.com', port: 587, secure: false,
    help: 'SMTP AUTH must be enabled for the mailbox by your Microsoft 365 admin. Microsoft is phasing out basic-auth SMTP, so for Microsoft mailboxes a transactional relay is the safer long-term choice.' },
  zoho_in: { label: 'Zoho Mail (India data centre)', host: 'smtp.zoho.in', port: 465, secure: true,
    help: 'Use the full address as username. With two-factor auth on, create an application-specific password in Zoho Accounts → Security. Other regions use smtp.zoho.com / .eu / .com.au.' },
  zoho: { label: 'Zoho Mail (global)', host: 'smtp.zoho.com', port: 465, secure: true, help: 'Use the full address as username; use an app-specific password if two-factor auth is on.' },
  custom: { label: 'Other SMTP server', host: '', port: 587, secure: false,
    help: 'Port 587 uses STARTTLS (leave SSL/TLS off); port 465 uses SSL/TLS from the start (turn it on). Amazon SES, SendGrid, Postmark, Brevo and internal relays all work this way.' },
};

function sendersTab(el) {
  function edit(s, done) {
    const v = s || { mode: 'smtp', port: 587, active: true };
    const input = (k, type, ph) => h('input', { type: type || 'text', value: v[k] ?? '', placeholder: ph || '', autocomplete: 'off' });
    const f = { label: input('label', 'text', 'e.g. Reports mailbox'), from_name: input('from_name', 'text', 'e.g. AskData Reports'), from_email: input('from_email', 'email', 'reports@yourcompany.com'),
      reply_to: input('reply_to', 'email'), host: input('host', 'text', 'smtp.gmail.com'), port: h('input', { type: 'number', min: 1, max: 65535, value: v.port || 587 }), username: input('username', 'text', 'usually the full email address') };
    const password = h('input', { type: 'password', autocomplete: 'new-password', placeholder: s?.has_password ? '•••••••• (unchanged)' : '' });
    const showPw = check('Show password', false, on => { password.type = on ? 'text' : 'password'; });
    const mode = select([['smtp', 'Real email via SMTP'], ['simulate', 'Simulation (nothing is sent — for demos / testing)']], v.mode, () => sync());
    const guess = s ? (Object.entries(MAIL_PRESETS).find(([, p]) => p.host === s.host)?.[0] || 'custom') : 'titan';
    const preset = select(Object.entries(MAIL_PRESETS).map(([k, p]) => [k, p.label]), guess, () => applyPreset(true));
    const help = h('div', { class: 'banner info small' });
    const secure = check('Use SSL/TLS from the start (port 465). Leave off for port 587 (STARTTLS).', !!v.secure);
    const active = check('Active', v.active !== false), def = check('Use as the default sender', !!v.is_default);
    const smtp = h('div', { class: 'stack' }, h('div', { class: 'grid2' }, field('Provider preset', preset), h('span', {})), help,
      h('div', { class: 'grid2' }, field('SMTP host', f.host), field('Port', f.port)), secure,
      h('div', { class: 'grid2' }, field('SMTP username', f.username), h('div', {}, field('Password / app password', password), showPw)));
    function applyPreset(fillIn) { const p = MAIL_PRESETS[preset.value]; help.textContent = p.help; if (fillIn) { f.host.value = p.host; f.port.value = p.port; secure.input.checked = p.secure; } }
    function sync() { smtp.classList.toggle('hidden', mode.value !== 'smtp'); }
    f.from_email.addEventListener('blur', () => { if (!f.username.value) f.username.value = f.from_email.value; });
    applyPreset(!s); sync();
    modal(s ? `Edit sender · ${s.label}` : 'Add email sender', h('div', { class: 'stack' },
      h('div', { class: 'grid2' }, field('Label (shown in the app)', f.label), field('From name', f.from_name)),
      h('div', { class: 'grid2' }, field('From email address', f.from_email), field('Reply-to', f.reply_to, 'optional')),
      field('Delivery mode', mode), smtp, h('div', { class: 'row wrap' }, active, def),
      h('p', { class: 'small dim', style: 'margin:0' }, 'Passwords are encrypted at rest and never shown again. After saving, use Verify to check the connection and Send test to send yourself a message.')), {
      wide: true, actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
        const body = { ...Object.fromEntries(Object.entries(f).map(([k, i]) => [k, i.value])), port: Number(f.port.value) || 587, mode: mode.value, password: password.value,
          secure: secure.input.checked, active: active.input.checked, is_default: def.input.checked };
        await (s ? api('PUT', `/api/admin/senders/${s.id}`, body) : api('POST', '/api/admin/senders', body)); close(); toast('Sender saved'); done();
      }) }, 'Save sender')] });
  }
  function sendTest(s, done) {
    const to = h('input', { type: 'text', value: state.me.email, placeholder: 'one or more addresses, separated by commas' });
    const out = h('div', {});
    modal(`Send a test email from “${s.label}”`, h('div', { class: 'stack' }, field('Send a test to', to, 'several addresses can be separated with commas'), out), {
      actions: close => [h('button', { class: 'btn', onclick: () => { close(); done(); } }, 'Close'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
        fill(out, h('span', { class: 'spinner' }), ' Sending…');
        const r = await api('POST', `/api/admin/senders/${s.id}/test`, { to: to.value });
        fill(out, h('div', { class: 'banner ' + (!r.ok ? 'bad' : r.simulated ? 'warn' : 'good') }, r.message));
      }) }, 'Send test')] });
  }
  async function draw() {
    const [list, log] = await Promise.all([api('GET', '/api/admin/senders'), api('GET', '/api/admin/email-log')]);
    const STATUS = { sent: 'good', failed: 'bad', simulated: 'warn' };
    fill(el, h('div', { class: 'stack' },
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => edit(null, draw) }, '＋ Add sender'),
        h('span', { class: 'small dim' }, 'Scheduled reports are emailed from these mailboxes. Add one sender per mailbox you send from.')),
      !list.some(s => s.mode === 'smtp' && s.active) ? h('div', { class: 'banner warn' }, h('b', {}, 'No real sending is configured yet. '),
        list.length ? 'Your senders are disabled or in simulation mode — ' : 'Add a sender, pick a provider preset, enter the username and password, then click Verify and Send test — until then ',
        'scheduled reports are saved in the app but no email leaves the server.') : null,
      list.length ? h('div', { class: 'tbl-wrap', style: 'max-height:none' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ['Sender', 'Server', 'Status', ''].map(t => h('th', {}, t)))),
        h('tbody', {}, list.map(s => h('tr', {},
          h('td', {}, h('b', {}, s.label), ' ', s.is_default ? h('span', { class: 'badge info' }, 'default') : null, h('div', { class: 'small dim' }, `${s.from_name ? s.from_name + ' ' : ''}<${s.from_email}>`)),
          h('td', { class: 'small' }, s.mode === 'smtp' ? [`${s.host}:${s.port} ${s.secure ? 'SSL/TLS' : 'STARTTLS'}`, h('div', { class: 'dim' }, s.username)] : h('span', { class: 'badge warn' }, 'simulation')),
          h('td', {}, !s.active ? h('span', { class: 'badge bad' }, 'disabled') : s.mode === 'simulate' ? h('span', { class: 'dim small' }, '—')
            : s.last_error ? [h('span', { class: 'badge bad' }, 'error'), h('div', { class: 'small', style: 'color:var(--bad);max-width:300px' }, s.last_error)]
            : s.verified_at ? h('span', { class: 'badge good' }, `✓ verified ${fmtTime(s.verified_at)}`) : h('span', { class: 'badge' }, 'not verified yet')),
          h('td', { class: 'right nowrap' }, h('button', { class: 'btn sm', onclick: e => busy(e.target, async () => { e.target.textContent = 'Checking…'; const r = await api('POST', `/api/admin/senders/${s.id}/verify`); toast(r.message, !r.ok); draw(); }) }, 'Verify'), ' ',
            h('button', { class: 'btn sm', onclick: () => sendTest(s, draw) }, 'Send test'), ' ', h('button', { class: 'btn sm', onclick: () => edit(s, draw) }, 'Edit'), ' ',
            h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('Delete sender?', `“${s.label}” — schedules that use it fall back to the default sender.`, 'Delete')) { await api('DELETE', `/api/admin/senders/${s.id}`).catch(fail); draw(); } } }, 'Delete'))))))) : null,
      h('div', { class: 'dash-grid' },
        h('div', { class: 'card' }, h('h2', {}, 'How sending works'), h('div', { class: 'small stack' },
          h('div', {}, 'When a report’s schedule fires, the report is refreshed and emailed as a PDF through the sender chosen on the schedule (or the default sender). Each person with an account receives the report with ', h('b', {}, 'their own data access'), '; other addresses receive the owner’s view.'),
          h('div', {}, h('b', {}, 'Verify'), ' connects and signs in without sending. ', h('b', {}, 'Send test'), ' sends a real message to the addresses you enter.'),
          h('div', {}, h('b', {}, 'Statuses: '), h('i', {}, 'sent'), ' = accepted by the mail server (SMTP cannot confirm inbox delivery) · ', h('i', {}, 'failed'), ' = refused, with the server’s reason · ', h('i', {}, 'simulated'), ' = recorded only.'))),
        h('div', { class: 'card' }, h('h2', {}, 'If emails do not arrive'), h('div', { class: 'small stack' },
          h('div', {}, '☐ Check the recipient’s spam folder, and the Email log below for the server’s reason.'),
          h('div', {}, '☐ Most providers need an ', h('b', {}, 'app password'), ' when two-factor sign-in is on for the mailbox.'),
          h('div', {}, '☐ The From address should be the mailbox you sign in with (or an alias it is allowed to send as).'),
          h('div', {}, '☐ Publish SPF and DKIM for your sending domain so messages are not treated as spam.')))),
      h('h2', { style: 'margin:8px 0 0' }, 'Email log'),
      log.length ? h('div', { class: 'tbl-wrap', style: 'max-height:360px' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ['When', 'To', 'Subject', 'For', 'Sender', 'Status'].map(t => h('th', {}, t)))),
        h('tbody', {}, log.map(m => h('tr', {}, h('td', { class: 'nowrap' }, fmtTime(m.at)), h('td', {}, m.to), h('td', { class: 'clip' }, m.subject), h('td', { class: 'small' }, m.context), h('td', { class: 'small' }, m.sender),
          h('td', {}, h('span', { class: 'badge ' + STATUS[m.status] }, m.status), m.error ? h('div', { class: 'small', style: 'color:var(--bad);max-width:280px' }, m.error) : null))))))
        : h('div', { class: 'empty small' }, 'No emails have been sent yet.')));
  }
  draw().catch(fail);
}
