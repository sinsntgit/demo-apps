// Admin: users, AI models, platform settings, audit log.
import { h, fill, api, busy, fail, toast, modal, field, check, select, tabs, confirmDialog, fmtTime, state } from './core.js';

export async function adminView(root, arg) {
  const t = tabs([['users', 'Users', usersTab], ['access', 'Data access', accessTab], ['models', 'AI models', modelsTab], ['settings', 'Settings', settingsTab], ['audit', 'Audit log', auditTab]], arg || 'users');
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
    const testTo = h('input', { type: 'email', placeholder: 'send a test to…', value: state.me.email, style: 'max-width:260px' });
    const testOut = h('span', { class: 'small' });
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
      h('div', { class: 'card stack' }, h('h2', {}, 'Email for scheduled reports'),
        h('p', { class: 'small dim', style: 'margin:0' }, 'Your organisation’s outgoing mail server (SMTP). Leave the server blank to switch email off; scheduled reports are then only saved in the app.'),
        h('div', { class: 'grid2' }, field('Mail server (host)', text('smtp_host', 'smtp.yourcompany.com')), field('Port', num('smtp_port')),
          field('Security', select([['starttls', 'STARTTLS (usually port 587)'], ['ssl', 'SSL / TLS (usually port 465)'], ['none', 'None (internal relay only)']], s.smtp_security, v => { s.smtp_security = v; })),
          field('From address', text('smtp_from', 'reports@yourcompany.com')), field('Username', text('smtp_user', 'leave blank if not required')),
          field('Password', h('input', { type: 'password', autocomplete: 'new-password', placeholder: s.smtp_password_set ? '•••••••• (unchanged)' : '', oninput: e => { s.smtp_password = e.target.value; } }), 'stored encrypted')),
        field('Web address of this app', text('public_url', 'https://askdata.yourcompany.com'), 'used for the “open the live report” link in emails'),
        h('div', { class: 'row wrap' }, testTo, h('button', { class: 'btn', onclick: e => busy(e.target, async () => {
          await api('PUT', '/api/admin/settings', s);
          const r = await api('POST', '/api/admin/settings/test-email', { to: testTo.value });
          testOut.replaceChildren(h('span', { class: 'badge ' + (r.ok ? 'good' : 'bad') }, r.ok ? '✓ ' : '✗ ', r.message));
        }) }, 'Save & send test email'), testOut)),
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
    select([['', 'All events'], ['login', 'Sign-ins'], ['query', 'Queries'], ['training', 'Training'], ['report', 'Reports'], ['connection', 'Data models'], ['filter', 'Data filters'], ['user', 'Users'], ['model', 'AI models'], ['settings', 'Settings'], ['2fa', '2FA'], ['password', 'Passwords']], '', v => { f.action = v; f.page = 1; draw(); }, { class: 'inline' }),
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
