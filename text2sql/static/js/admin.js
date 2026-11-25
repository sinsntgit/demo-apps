// Admin: users, AI models, platform settings, audit log.
import { h, fill, api, busy, fail, toast, modal, field, check, select, tabs, confirmDialog, fmtTime, state } from './core.js';

export async function adminView(root, arg) {
  const t = tabs([...(state.me.is_platform_admin ? [['companies', 'Companies', companiesTab]] : []), ['users', 'Users', usersTab], ['groups', 'User groups', groupsTab], ['access', 'Data access', accessTab], ['models', 'AI models', modelsTab], ['senders', 'Email senders', sendersTab], ['settings', 'Settings', settingsTab], ['audit', 'Audit log', auditTab]], arg || 'users');
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
    const VIEW = [['all', 'Results, SQL and code'], ['results', 'Results only — no SQL or Python code']];
    const view = select(VIEW, u && u.show_sql === false ? 'results' : 'all');
    const viewNote = h('span', {});
    const role = select(ROLES, u?.role || 'analyst', () => syncView());
    const syncView = () => { const analyst = role.value === 'analyst'; view.disabled = !analyst; if (!analyst) view.value = 'all';
      fill(viewNote, analyst ? 'Results only: answers show the chart, table and summary; the user can still say whether they are correct.' : 'Data stewards and administrators always see SQL and code — they review and fix it.'); };
    syncView();
    const active = check('Account enabled', u ? u.is_active : true);
    const pa = check('Platform administrator — also manages companies and the AI models / email senders shared with them', !!u?.is_platform_admin);
    const own = u && u.id === state.me.id;
    if (own) pa.input.disabled = true;               // nobody removes their own platform rights (another platform admin can)
    const paWrap = h('div', {}, state.me.is_platform_admin ? [pa, own ? h('div', { class: 'small dim' }, `This is your own account (${state.me.email}). Another platform administrator can remove this right.`) : null] : null);
    const syncPa = () => paWrap.classList.toggle('hidden', role.value !== 'admin');
    role.addEventListener('change', syncPa); syncPa();
    modal(u ? `Edit ${u.email}` : 'Add user', h('div', { class: 'stack' }, field('Email', email), field('Name', name), field('Role', role), field('What answers show', view), h('div', { class: 'small dim', style: 'margin-top:-6px' }, viewNote), paWrap, active), {
      actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
        const payload = { email: email.value, name: name.value, role: role.value, is_active: active.input.checked, show_sql: view.value !== 'results',
          ...(state.me.is_platform_admin ? { is_platform_admin: role.value === 'admin' && pa.input.checked } : {}) };
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
        h('tbody', {}, users.map(u => h('tr', {}, h('td', {}, h('b', {}, u.name || u.email), h('div', { class: 'small dim' }, u.email)), h('td', {}, u.role, u.role === 'analyst' && u.show_sql === false ? h('div', {}, h('span', { class: 'badge' }, 'results only')) : null,
            u.is_platform_admin ? h('div', {}, h('span', { class: 'badge info' }, 'platform admin')) : null),
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
  const edit = (m, scope = 'company') => {
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
    modal(m ? `Edit ${m.name}` : (scope === 'platform' ? 'Add a shared AI model' : 'Add AI model'), h('div', { class: 'stack' },
      (m?.scope || scope) === 'platform' ? h('div', { class: 'banner info small' }, 'A shared (platform) model. After saving, use “Companies…” to choose which companies may use it. Its key is never shown to them.') : null,
      field('Provider', provider), h('div', { class: 'grid2' }, field('Model ID', modelId), field('Display name', name)), presets, urlField,
      field('API key', key, 'encrypted at rest; never shown again'), effortField,
      h('div', { class: 'grid2' }, field('Input price', pin, '$ per million tokens'), field('Output price', pout, '$ per million tokens')), enabled, def,
      h('p', { class: 'small dim' }, 'Whatever the provider, the model receives only the question, schema and training notes — never query results. Choose a self-hosted model if even schema names must stay on your network.')), {
      actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
        const payload = { name: name.value, provider: provider.value, model_id: modelId.value, base_url: provider.value === 'anthropic' ? '' : baseUrl.value, api_key: key.value, effort: provider.value === 'anthropic' ? effort.value : '',
          enabled: enabled.input.checked, is_default: def.input.checked, price_in: Number(pin.value) || 0, price_out: Number(pout.value) || 0, scope: m ? m.scope : scope };
        await (m ? api('PUT', `/api/admin/models/${m.id}`, payload) : api('POST', '/api/admin/models', payload)); close(); toast('Saved'); draw();
      }) }, 'Save')] });
  };
  const testBtn = m => { const status = h('span', { class: 'small' });
    const b = h('button', { class: 'btn sm', onclick: () => busy(b, async () => { status.textContent = 'Testing…'; const r = await api('POST', `/api/admin/models/${m.id}/test`); fill(status, h('span', { class: 'badge ' + (r.ok ? 'good' : 'bad') }, r.ok ? '✓ ' : '✗ ', r.message)); }) }, 'Test');
    return [status, b]; };
  const info = m => h('div', { style: 'flex:1;min-width:220px' }, h('div', { class: 'row wrap' }, h('b', {}, m.name), m.is_default ? h('span', { class: 'badge info' }, 'default') : null,
      m.enabled ? null : h('span', { class: 'badge bad' }, 'disabled'), m.has_key === false && m.provider !== 'openai_compatible' ? h('span', { class: 'badge warn' }, 'no API key') : null),
    h('div', { class: 'small dim' }, `${providers[m.provider]?.label || m.provider} · ${m.model_id}${m.base_url ? ' · ' + m.base_url : ''} · $${m.price_in}/$${m.price_out} per MTok`));
  const editable = m => [h('button', { class: 'btn sm', onclick: () => edit(m) }, 'Edit'),
    h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('Delete model?', `${m.name} will be removed. Past queries keep its name.`, 'Delete')) { await api('DELETE', `/api/admin/models/${m.id}`).catch(fail); draw(); } } }, 'Delete')];
  async function draw() {
    const data = await api('GET', '/api/admin/models'); providers = data.providers;
    const save = async patch => { await api('PUT', '/api/admin/company/models', { hidden: data.shared.filter(m => !m.on).map(m => m.id), default_id: data.default_id, ...patch }); toast('Saved'); draw(); };
    const usable = [...data.models, ...data.shared.filter(m => m.on)].filter(m => m.enabled);
    const def = select([['', 'Automatic (first default model)'], ...usable.map(m => [m.id, m.name + (m.scope === 'platform' ? ' — shared' : '')])], data.default_id || '', v => save({ default_id: v ? Number(v) : null }), { style: 'max-width:380px' });
    fill(el, h('div', { class: 'stack' },
      h('div', { class: 'card stack' }, field('Default AI model for your company', def, 'pre-selected for everyone on the Ask page')),
      h('h2', { style: 'margin:6px 0 0' }, 'Your company’s own models'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => edit(null, 'company') }, '＋ Add model'), h('span', { class: 'small dim' }, 'Only people in your company see these, with your own API keys.')),
      data.models.length ? h('div', { class: 'card flush' }, data.models.map(m => h('div', { class: 'item' }, h('div', { class: 'row wrap' }, info(m), ...testBtn(m), ...editable(m)))))
        : h('div', { class: 'empty small' }, 'No models of your own.' + (data.shared.length ? ' Your company uses the shared models below.' : '')),
      data.shared.length && !data.is_platform_admin ? [h('h2', { style: 'margin:6px 0 0' }, 'Shared with your company by the platform'),
        h('p', { class: 'small dim', style: 'margin:0' }, 'Set up and paid for by the platform administrator. Untick one to hide it from your users.'),
        h('div', { class: 'card flush' }, data.shared.map(m => h('div', { class: 'item' }, h('div', { class: 'row wrap' }, info(m), ...testBtn(m),
          check('Available to our users', m.on, v => { m.on = v; save({}); })))))] : null,
      data.is_platform_admin ? [h('h2', { style: 'margin:14px 0 0' }, 'Platform models — shared with companies'),
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => edit(null, 'platform') }, '＋ Add shared model'), h('span', { class: 'small dim' }, 'You decide, per model, which companies may use it.')),
        (data.platform || []).length ? h('div', { class: 'card flush' }, data.platform.map(m => h('div', { class: 'item' }, h('div', { class: 'row wrap' }, info(m),
          h('span', { class: 'badge' }, shareLabel(m, data.companies)), h('button', { class: 'btn sm', onclick: () => sharingDialog(m, data.companies, `/api/admin/models/${m.id}/sharing`, draw) }, 'Companies…'),
          (sh => sh ? check('Available in our company', sh.on, v => { sh.on = v; save({}); }) : null)(data.shared.find(x => x.id === m.id)),
          ...testBtn(m), ...editable(m))))) : h('div', { class: 'empty small' }, 'No shared models yet.')] : null));
  }
  draw().catch(fail);
}

const shareLabel = (x, companies) => x.share_all ? 'All companies'
  : !(x.shared_companies || []).length ? 'Not shared'
  : (x.shared_companies.length <= 2 ? x.shared_companies.map(id => companies.find(c => c.id === id)?.name || '#' + id).join(', ') : `${x.shared_companies.length} companies`);

function sharingDialog(item, companies, url, done) {
  const picked = new Set(item.shared_companies || []);
  const all = check('All companies — including companies added later', !!item.share_all, () => sync());
  const boxes = h('div', { class: 'card flush', style: 'max-height:40vh;overflow:auto' }, companies.map(c => h('div', { class: 'item' },
    check(c.name, picked.has(c.id), v => { v ? picked.add(c.id) : picked.delete(c.id); }))));
  const sync = () => boxes.classList.toggle('hidden', all.input.checked);
  sync();
  modal(`Which companies may use “${item.name || item.label}”?`, h('div', { class: 'stack' }, all, boxes,
    h('p', { class: 'small dim', style: 'margin:0' }, 'Each company’s administrator can still switch it off for their company. A company never sees the API key, password or server details.')), {
    actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
      await api('PUT', url, { share_all: all.input.checked, company_ids: [...picked] }); close(); toast('Sharing saved'); done();
    }) }, 'Save')] });
}

function companiesTab(el) {
  const showPw = (email, pw) => showPassword(email, pw);
  const add = () => {
    const name = h('input', { type: 'text', placeholder: 'e.g. Acme Retail Ltd' });
    const email = h('input', { type: 'email', placeholder: 'their administrator’s email' }), person = h('input', { type: 'text', placeholder: 'their name' });
    const samples = check('Add the sample data models (Retail sales and SAP Sales & Finance) so they can try it at once', true);
    modal('Add a company', h('div', { class: 'stack' }, field('Company name', name), h('div', { class: 'grid2' }, field('First administrator — email', email), field('Name', person)), samples,
      h('p', { class: 'small dim', style: 'margin:0' }, 'The company’s data, users, chats, reports, training and audit log are separate from every other company’s. Its administrator manages everything inside it. To give it AI models or email senders, share them under AI models / Email senders — or its administrator adds their own.')), {
      actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
        const r = await api('POST', '/api/admin/companies', { name: name.value, admin_email: email.value, admin_name: person.value, samples: samples.input.checked });
        close(); draw(); if (r.temporary_password) showPw(r.admin_email, r.temporary_password); else toast('Company added');
      }) }, 'Add company')] });
  };
  const editCo = c => {
    const name = h('input', { type: 'text', value: c.name });
    const active = check('Active — its people can sign in', c.is_active);
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
    const tpl = h('input', { type: 'file', accept: '.pptx,.potx' });
    let dropTpl = false;
    const tplNow = h('div', { class: 'small dim' }, c.pptx_template ? ['Current template: ', h('b', {}, c.pptx_template), ' ',
      h('button', { class: 'btn ghost sm', type: 'button', onclick: e => { dropTpl = true; e.target.parentNode.textContent = 'The template will be removed when you save.'; } }, 'Remove')] : 'No template: PowerPoint exports use the built-in design with the logo.');
    modal(`Edit ${c.name}`, h('div', { class: 'stack' }, field('Company name', name), c.is_mine ? null : active,
      field('Logo', file, 'PNG, JPEG or WebP, at most 512 KB — leave empty to keep the current one'),
      field('PowerPoint template', tpl, 'the company’s corporate .pptx or .potx — report exports are built on it'), tplNow,
      c.is_mine ? null : h('p', { class: 'small dim', style: 'margin:0' }, 'Making a company inactive signs all its people out at once; nothing is deleted.')), {
      actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
        await api('PUT', `/api/admin/companies/${c.id}`, { name: name.value, is_active: c.is_mine ? true : active.input.checked });
        if (file.files[0]) { const fd = new FormData(); fd.append('upload', file.files[0]); await api('POST', `/api/admin/companies/${c.id}/logo`, fd); if (c.is_mine) state.logoChanged = true; }
        if (tpl.files[0]) { const fd = new FormData(); fd.append('upload', tpl.files[0]); await api('POST', `/api/admin/companies/${c.id}/template`, fd); }
        else if (dropTpl) await api('DELETE', `/api/admin/companies/${c.id}/template`);
        close(); toast('Saved'); draw();
      }) }, 'Save')] });
  };
  const ROLE_OPTS = [['analyst', 'Analyst — asks questions'], ['steward', 'Data steward — also curates training, sees dashboard'], ['admin', 'Administrator — manages the company']];
  const roleAndView = (role0 = 'analyst', showSql = true) => {
    const role = select(ROLE_OPTS, role0), view = select([['all', 'Results, SQL and code'], ['results', 'Results only — no SQL or Python code']], showSql ? 'all' : 'results');
    const sync = () => { view.disabled = role.value !== 'analyst'; if (view.disabled) view.value = 'all'; };
    role.addEventListener('change', sync); sync();
    return { role, view, fields: [field('Role', role), field('What answers show', view, 'analysts only')] };
  };
  const addUser = (c, done = draw) => {
    const email = h('input', { type: 'email' }), person = h('input', { type: 'text' }), rv = roleAndView();
    modal(`Add a user to ${c.name}`, h('div', { class: 'stack' }, h('div', { class: 'grid2' }, field('Email', email), field('Name', person)), ...rv.fields,
      h('p', { class: 'small dim', style: 'margin:0' }, `They belong to ${c.name} only and see only its data models, chats and reports. They get a one-time password and choose their own at first sign-in.`)), {
      actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
        const r = await api('POST', `/api/admin/companies/${c.id}/users`, { email: email.value, name: person.value, role: rv.role.value, show_sql: rv.view.value !== 'results' });
        close(); done(); showPw(r.email, r.temporary_password);
      }) }, 'Add user')] });
  };
  const move = (u, from, all, done) => {
    const others = all.filter(x => x.id !== from.id);
    const to = select(others.map(x => [x.id, x.name + (x.is_active ? '' : ' (inactive)')]), others[0]?.id);
    const rv = roleAndView(u.role, u.show_sql);
    const heirs = from.admins.filter(a => a.id !== u.id && a.is_active);
    const heir = u.reports ? select(heirs.map(a => [a.id, `${a.name || a.email} · ${a.email}`]), heirs[0]?.id) : null;
    modal(`Move ${u.name || u.email} to another company`, h('div', { class: 'stack' }, field('Move to', to), ...rv.fields,
      u.reports ? (heirs.length ? field(`Who takes over their ${u.reports} report${u.reports > 1 ? 's' : ''} in ${from.name}`, heir, 'an administrator of the company they leave')
        : h('div', { class: 'banner warn small' }, `They own ${u.reports} report${u.reports > 1 ? 's' : ''}, and ${from.name} has no other active administrator to take ${u.reports > 1 ? 'them' : 'it'} over. Add one with ＋ User first.`)) : null,
      h('div', { class: 'banner info small' }, h('b', {}, 'What happens: '), `they are signed out, and next time they sign in to the new company. In ${from.name} they leave their user groups, their personal data access, row filters and shares, and any report schedules that email them. `,
        u.reports ? `Their reports stay in ${from.name} with the person chosen above; any schedule on them is paused until that person checks and restarts it. ` : '',
        `Their chats stay with ${from.name} and are no longer visible to them. Nothing is deleted.`)), {
      actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', disabled: !others.length || (u.reports && !heirs.length), onclick: e => busy(e.target, async () => {
        const r = await api('POST', `/api/admin/companies/${to.value}/users/${u.id}/move`, { role: rv.role.value, show_sql: rv.view.value !== 'results', reports_to: heir ? Number(heir.value) : null });
        close(); done();
        toast(`${r.email} moved` + (r.reports_handed_over ? ` — ${r.reports_handed_over} report(s) now with ${r.reports_to}` + (r.schedules_paused ? `, ${r.schedules_paused} schedule(s) paused` : '') : ''));
      }) }, 'Move')] });
  };
  const people = (c, all) => {
    const box = h('div', { class: 'stack' });
    const load = async () => {
      const list = await api('GET', `/api/admin/companies/${c.id}/users`);
      const fresh = (await api('GET', '/api/admin/companies')).find(x => x.id === c.id) || c;
      fill(box, h('div', { class: 'row' }, h('button', { class: 'btn primary sm', onclick: () => addUser(c, () => { load(); draw(); }) }, '＋ User'),
          h('span', { class: 'small dim' }, `${list.length} ${list.length === 1 ? 'person' : 'people'}`)),
        list.length ? h('div', { class: 'tbl-wrap', style: 'max-height:55vh' }, h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, ['Person', 'Role', 'Reports', 'Last sign-in', ''].map(t => h('th', {}, t)))),
          h('tbody', {}, list.map(u => h('tr', {},
            h('td', {}, h('b', {}, u.name || u.email), h('div', { class: 'small dim' }, u.email)),
            h('td', {}, u.role, u.role === 'analyst' && !u.show_sql ? h('div', {}, h('span', { class: 'badge' }, 'results only')) : null,
              u.is_platform_admin ? h('div', {}, h('span', { class: 'badge info' }, 'platform admin')) : null, u.is_active ? null : h('div', {}, h('span', { class: 'badge bad' }, 'disabled'))),
            h('td', { class: 'num' }, u.reports), h('td', { class: 'nowrap small' }, fmtTime(u.last_login_at)),
            h('td', { class: 'right' }, u.id === state.me.id ? h('span', { class: 'small dim' }, 'you')
              : h('button', { class: 'btn sm', onclick: () => move(u, fresh, all, () => { load(); draw(); }) }, 'Move…'))))))) : h('div', { class: 'empty small' }, 'Nobody yet.'));
    };
    modal(`People in ${c.name}`, box, { wide: true });
    load().catch(fail);
  };
  const reset = (c, a) => async () => {
    if (!await confirmDialog('Reset this administrator’s password?', `${a.email} (${c.name}) gets a new temporary password and is signed out.`, 'Reset', false)) return;
    try { const r = await api('POST', `/api/admin/companies/${c.id}/admins/${a.id}/reset-password`); showPw(r.email, r.temporary_password); } catch (e) { fail(e); }
  };
  async function draw() {
    const list = await api('GET', '/api/admin/companies');
    fill(el, h('div', { class: 'stack' },
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: add }, '＋ Add company'),
        h('span', { class: 'small dim' }, 'Each company is a separate tenant: its own users, data models, training, chats, reports, settings and audit log. You see only these totals, not their data.')),
      h('div', { class: 'tbl-wrap', style: 'max-height:none' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ['Company', 'Administrators', 'Users', 'Data models', 'Reports', 'Questions (30 days)', 'AI spend (30 days)', ''].map(t => h('th', {}, t)))),
        h('tbody', {}, list.map(c => h('tr', {},
          h('td', {}, h('b', {}, c.name), ' ', c.is_mine ? h('span', { class: 'badge info' }, 'yours') : null, ' ', c.is_active ? null : h('span', { class: 'badge bad' }, 'inactive'),
            c.has_logo || c.pptx_template ? h('div', { class: 'small dim' }, [c.has_logo ? 'logo' : null, c.pptx_template ? 'PowerPoint template' : null].filter(Boolean).join(' · ')) : null),
          h('td', { class: 'small' }, c.admins.length ? c.admins.map(a => h('div', { class: 'row', style: 'gap:6px' }, h('span', {}, a.name || a.email, h('span', { class: 'dim' }, ' · ' + a.email)),
            c.is_mine ? null : h('button', { class: 'btn ghost sm', title: 'Reset this administrator’s password', onclick: reset(c, a) }, '↺'))) : h('span', { class: 'badge warn' }, 'none')),
          h('td', { class: 'num' }, c.users), h('td', { class: 'num' }, c.data_models), h('td', { class: 'num' }, c.reports), h('td', { class: 'num' }, c.questions_30d),
          h('td', { class: 'num' }, '$' + c.spend_30d.toFixed(2)),
          h('td', { class: 'right nowrap' }, h('button', { class: 'btn sm', onclick: () => editCo(c) }, 'Edit'), ' ', h('button', { class: 'btn sm', onclick: () => addUser(c) }, '＋ User'), ' ', h('button', { class: 'btn sm', onclick: () => people(c, list) }, 'People…'))))))),
      h('p', { class: 'small dim' }, 'AI spend is tokens × the prices set on each model, for questions and rephrasing. Shared models and email senders are offered to companies under AI models and Email senders.')));
  }
  draw().catch(fail);
}

function settingsTab(el) {
  Promise.all([api('GET', '/api/admin/settings'), api('GET', '/api/models')]).then(([s, models]) => {
    const num = k => h('input', { type: 'number', value: s[k], style: 'max-width:140px', oninput: e => { s[k] = e.target.value; } });
    const bool = (k, label, hint) => check(label, s[k], v => { s[k] = v; }, hint);
    const text = (k, ph) => h('input', { type: 'text', value: s[k] || '', placeholder: ph, oninput: e => { s[k] = e.target.value; } });
    const fb = select([['approval', 'Send to a steward for approval first'], ['instant', 'Use immediately for training']], s.feedback_mode, v => { s.feedback_mode = v; }, { style: 'max-width:340px' });
    const save = h('button', { class: 'btn primary', onclick: () => busy(save, async () => { await api('PUT', '/api/admin/settings', s); toast('Settings saved'); }) }, 'Save settings');
    const co = state.me.company;
    const logoBox = h('div', { class: 'logo-box' }, co?.has_logo ? h('img', { src: `/api/company/logo?v=${Date.now()}`, alt: 'Current logo' }) : h('span', { class: 'small dim' }, 'No logo'));
    const logoFile = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'hidden', onchange: async e => {
      const fd = new FormData(); fd.append('upload', e.target.files[0]);
      try { await api('POST', '/api/company/logo', fd); state.logoChanged = true; state.logoVersion = Date.now(); toast('Logo saved'); location.reload(); } catch (ex) { fail(ex); }
    } });
    const tplFile = h('input', { type: 'file', accept: '.pptx,.potx', class: 'hidden', onchange: async e => {
      const fd = new FormData(); fd.append('upload', e.target.files[0]);
      try { await api('POST', '/api/company/template', fd); toast('Template saved'); location.reload(); } catch (ex) { fail(ex); }
    } });
    fill(el, h('div', { class: 'stack', style: 'max-width:680px' },
      co ? h('div', { class: 'card stack' }, h('h2', {}, 'Company'), h('div', {}, h('b', {}, co.name), h('span', { class: 'small dim' }, state.me.is_platform_admin ? ' — rename it under Companies' : ' — the platform administrator can rename it')),
        h('div', { class: 'row wrap', style: 'align-items:center' }, logoBox, h('div', { class: 'stack', style: 'gap:6px' },
          h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => logoFile.click() }, '⬆ Upload logo'),
            co.has_logo ? h('button', { class: 'btn ghost', onclick: async () => { await api('DELETE', '/api/company/logo').catch(fail); state.logoChanged = true; location.reload(); } }, 'Remove') : null),
          h('span', { class: 'small dim' }, 'PNG, JPEG or WebP, at most 512 KB. Shown in the menu for everyone in your company and at the top of report PDFs.')), logoFile),
        h('div', { class: 'row wrap', style: 'align-items:center;margin-top:6px' }, h('b', { class: 'small' }, 'PowerPoint template: '),
          h('span', { class: 'small' }, co.pptx_template || 'none — exports use the built-in design with your logo'),
          h('button', { class: 'btn sm', onclick: () => tplFile.click() }, co.pptx_template ? 'Replace' : '⬆ Upload template'),
          co.pptx_template ? h('button', { class: 'btn sm ghost', onclick: async () => { await api('DELETE', '/api/company/template').catch(fail); location.reload(); } }, 'Remove') : null, tplFile),
        h('span', { class: 'small dim' }, 'Your corporate .pptx or .potx: report PowerPoint exports are built on its masters, layouts, colours and fonts.')) : null,
      h('div', { class: 'card stack' }, h('h2', {}, 'Security'), bool('enforce_2fa', 'Require two-factor authentication for everyone', 'Users without 2FA are sent to enrolment on their next request — including you.'),
        h('div', { class: 'grid2' }, field('Questions per user per minute', num('rate_limit_per_min')),
          ...(s.platform_keys.length ? [field('Session length (hours)', num('session_hours'), 'all companies'), field('Failed sign-ins before lockout', num('lockout_attempts'), 'all companies'), field('Lockout duration (minutes)', num('lockout_minutes'), 'all companies')] : [])),
        s.platform_keys.length ? null : h('p', { class: 'small dim', style: 'margin:0' }, 'Session length and account lockout are set by the platform administrator for all companies.')),
      h('div', { class: 'card stack' }, h('h2', {}, 'Query execution'), h('div', { class: 'grid2' }, field('Maximum rows returned', num('max_rows')), field('Query timeout (seconds)', num('query_timeout_s')),
        field('Automatic SQL repair attempts', num('max_repair_attempts'), 'after a database error')),
        bool('store_results', 'Keep result snapshots in chat history', 'Turn off if query results must never be stored outside the source database. Users can still re-run saved SQL.')),
      h('div', { class: 'card stack' }, h('h2', {}, 'Predictive analysis'),
        bool('predictive_enabled', 'Allow predictive questions (forecast, prediction, segmentation, key drivers, anomalies)', 'Users still choose it per question with “Use predictive capability” on the Ask page. The statistics run on this server; the AI model only names the method and never sees the data.'),
        h('div', { class: 'grid2' }, field('Rows a predictive question may read', num('analysis_max_rows'), 'models need history; normal answers keep the smaller limit above'))),
      h('div', { class: 'card stack' }, h('h2', {}, 'Combined data models'),
        h('p', { class: 'small dim', style: 'margin:0' }, 'Data models answered together (Data models → ＋ Combined data model). The row limits apply when questions across data models arrive.'),
        h('div', { class: 'grid2' }, field('Data models in one combined model', num('combined_max_sources'), '2 to 6'),
          field('Rows read from one data model per step', num('combined_step_max_rows')), field('Rows in one combined answer before joining', num('combined_total_max_rows')),
          field('Keys one step may pass to the next', num('combined_max_keys'), 'e.g. customer numbers found in the CRM, used to filter SAP'))),
      h('div', { class: 'card stack' }, h('h2', {}, 'Rephrasing questions'),
        bool('rephrase_enabled', 'Show “✨ Rephrase” on the Ask page', 'Users can let the AI model tidy a question before asking it. The rephrasing prompt is small (table and column names, business-term titles, similar verified questions) and every use is logged with its cost on the Dashboard.'),
        field('AI model that rephrases', select([[0, 'The model the user picked for the question'], ...models.map(m => [m.id, m.name])], s.rephrase_model_id || 0, v => { s.rephrase_model_id = Number(v); }, { style: 'max-width:340px' }),
          'a smaller, cheaper model is usually enough for rewording')),
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
    const st = { is_active: c.is_active, restricted: c.restricted, users: new Set(c.user_ids), groups: new Set(c.group_ids) };
    const userBox = h('div', { class: 'stack' });
    const viaGroup = u => data.groups.filter(g => st.groups.has(g.id) && g.user_ids.includes(u.id)).map(g => g.name);
    const drawUsers = () => fill(userBox, !st.restricted ? h('div', { class: 'small dim' }, 'Every signed-in user can query this data model.') : [
      h('div', {}, h('div', { class: 'small', style: 'font-weight:600;margin-bottom:6px' }, 'User groups'),
        data.groups.length ? h('div', { class: 'access-users' }, data.groups.map(g => check(g.name, st.groups.has(g.id), v => { v ? st.groups.add(g.id) : st.groups.delete(g.id); drawUsers(); }, `${g.user_ids.length} member${g.user_ids.length === 1 ? '' : 's'}`)))
          : h('div', { class: 'small dim' }, 'No groups yet — create them on the User groups tab.')),
      h('div', {}, h('div', { class: 'small', style: 'font-weight:600;margin-bottom:6px' }, 'Individual users'),
        people.length ? h('div', { class: 'access-users' }, people.map(u => { const via = viaGroup(u);
          return check(`${u.name}  ·  ${u.role}`, st.users.has(u.id), v => v ? st.users.add(u.id) : st.users.delete(u.id), via.length ? `${u.email} — already has access via ${via.join(', ')}` : u.email); }))
          : h('div', { class: 'small dim' }, 'There are no non-admin users yet.'))]);
    drawUsers();
    const saveBtn = h('button', { class: 'btn primary sm', onclick: () => busy(saveBtn, async () => {
      await api('PUT', `/api/admin/access/${c.id}`, { is_active: st.is_active, restricted: st.restricted, user_ids: [...st.users], group_ids: [...st.groups] }); toast(`Access to “${c.name}” saved`); draw();
    }) }, 'Save access');
    return h('div', { class: 'card stack' },
      h('div', { class: 'row wrap' }, h('h2', { style: 'margin:0' }, c.name), c.is_active ? h('span', { class: 'badge good' }, 'enabled') : h('span', { class: 'badge bad' }, 'disabled'),
        c.restricted ? h('span', { class: 'badge warn' }, `🔒 ${c.group_ids.length} group(s) + ${c.user_ids.length} user(s)`) : h('span', { class: 'badge' }, 'open to all users'),
        c.filters.length ? h('span', { class: 'badge info' }, `${c.filters.filter(f => f.enabled).length} data filter(s)`) : null),
      h('div', { class: 'grid2' },
        h('div', { class: 'stack' }, h('h3', {}, 'Access'),
          check('Enabled', st.is_active, v => { st.is_active = v; }, 'Turn off to hide this data model from everyone except administrators.'),
          check('Only selected groups and users may use it', st.restricted, v => { st.restricted = v; drawUsers(); }, 'Otherwise it is open to every signed-in user.'), h('div', {}, saveBtn)),
        h('div', { class: 'stack' }, h('h3', {}, 'Who has access'), userBox)),
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
    const st = { scope: f?.scope || 'role', role: f?.role || 'analyst', user_id: f?.user_id || '', group_id: f?.group_id || '' };
    const who = h('div', { class: 'row wrap' });
    const drawWho = () => fill(who, select([['all', 'Everyone (except administrators)'], ['role', 'Everyone with the role…'], ['group', 'Everyone in the user group…'], ['user', 'One person…']], st.scope, v => { st.scope = v; drawWho(); }, { class: 'inline' }),
      st.scope === 'role' ? select(ROLE, st.role, v => { st.role = v; }, { class: 'inline' }) : null,
      st.scope === 'group' ? select([['', 'choose…'], ...data.groups.map(g => [g.id, `${g.name} (${g.user_ids.length})`])], st.group_id, v => { st.group_id = v; }, { class: 'inline' }) : null,
      st.scope === 'user' ? select([['', 'choose…'], ...data.users.filter(u => u.role !== 'admin').map(u => [u.id, `${u.name} (${u.email})`])], st.user_id, v => { st.user_id = v; }, { class: 'inline' }) : null);
    drawWho();
    const on = check('Filter is active', f ? f.enabled : true);
    modal(f ? 'Edit data filter' : `Add data filter — ${c.name}`, h('div', { class: 'stack' },
      h('datalist', { id: 'filter-tables' }, c.tables.map(t => h('option', { value: t }))),
      field('Table', table, 'the filter applies wherever this table is used'), field('Only show rows where', cond, 'a condition on that table’s columns — what you would write after WHERE'),
      h('div', { class: 'small dim' }, 'Examples: ', h('span', { class: 'mono' }, "region = 'North'"), ' · ', h('span', { class: 'mono' }, "country IN ('IN', 'AE')"), ' · ', h('span', { class: 'mono' }, 'sales_rep_email = {user_email}'),
        h('br'), 'Placeholders filled in with the signed-in person’s details: ', h('span', { class: 'mono' }, data.placeholders.join('  ')), '.'),
      field('Applies to', who), field('Note', note), on,
      h('div', { class: 'banner info small' }, 'If several filters on the same table apply to someone (for example one for their role, one for a group they are in and one for them personally) they must satisfy all of them. To filter a table that links to this one (for example orders of North-region customers), add a filter on that table too, or rely on the join: rows are only removed from the table named here.')), {
      wide: true, actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
        const body = { connection_id: c.id, table_name: table.value, condition: cond.value, scope: st.scope, role: st.role, user_id: st.user_id ? Number(st.user_id) : null, group_id: st.group_id ? Number(st.group_id) : null, description: note.value, enabled: on.input.checked };
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
        h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('Delete group?', `“${g.name}” will be removed. Reports shared with it stop being shared with its members, schedules stop emailing it, and data-model access and data filters given to the group are removed. Check Data access afterwards: a member who still has access another way will no longer be limited by the group’s filters. The users themselves are not deleted.`, 'Delete')) { await api('DELETE', `/api/admin/groups/${g.id}`).catch(fail); draw(); } } }, 'Delete'))))
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
  function edit(s, done, scope = 'company') {
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
          secure: secure.input.checked, active: active.input.checked, is_default: def.input.checked, scope: s ? s.scope : scope };
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
    const [data, log] = await Promise.all([api('GET', '/api/admin/senders'), api('GET', '/api/admin/email-log')]);
    const list = data.senders;
    const STATUS = { sent: 'good', failed: 'bad', simulated: 'warn' };
    const saveChoice = async patch => { await api('PUT', '/api/admin/company/senders', { hidden: data.shared.filter(x => !x.on).map(x => x.id), default_id: data.default_id, ...patch }); toast('Saved'); draw(); };
    const usable = [...list, ...data.shared.filter(x => x.on)].filter(x => x.active);
    const senderRows = (rows, platform) => h('div', { class: 'tbl-wrap', style: 'max-height:none' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['Sender', 'Server', 'Status', ''].map(t => h('th', {}, t)))),
      h('tbody', {}, rows.map(s => h('tr', {},
        h('td', {}, h('b', {}, s.label), ' ', s.is_default ? h('span', { class: 'badge info' }, 'default') : null, h('div', { class: 'small dim' }, `${s.from_name ? s.from_name + ' ' : ''}<${s.from_email}>`),
          platform ? h('div', {}, h('span', { class: 'badge' }, shareLabel(s, data.companies))) : null,
          platform ? (sh => sh ? check('Available in our company', sh.on, v => { sh.on = v; saveChoice({}); }) : null)(data.shared.find(x => x.id === s.id)) : null),
        h('td', { class: 'small' }, s.mode === 'smtp' ? [`${s.host}:${s.port} ${s.secure ? 'SSL/TLS' : 'STARTTLS'}`, h('div', { class: 'dim' }, s.username)] : h('span', { class: 'badge warn' }, 'simulation')),
        h('td', {}, !s.active ? h('span', { class: 'badge bad' }, 'disabled') : s.mode === 'simulate' ? h('span', { class: 'dim small' }, '—')
          : s.last_error ? [h('span', { class: 'badge bad' }, 'error'), h('div', { class: 'small', style: 'color:var(--bad);max-width:300px' }, s.last_error)]
          : s.verified_at ? h('span', { class: 'badge good' }, `✓ verified ${fmtTime(s.verified_at)}`) : h('span', { class: 'badge' }, 'not verified yet')),
        h('td', { class: 'right nowrap' }, platform ? [h('button', { class: 'btn sm', onclick: () => sharingDialog(s, data.companies, `/api/admin/senders/${s.id}/sharing`, draw) }, 'Companies…'), ' '] : null,
          h('button', { class: 'btn sm', onclick: e => busy(e.target, async () => { e.target.textContent = 'Checking…'; const r = await api('POST', `/api/admin/senders/${s.id}/verify`); toast(r.message, !r.ok); draw(); }) }, 'Verify'), ' ',
          h('button', { class: 'btn sm', onclick: () => sendTest(s, draw) }, 'Send test'), ' ', h('button', { class: 'btn sm', onclick: () => edit(s, draw) }, 'Edit'), ' ',
          h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('Delete sender?', `“${s.label}” — schedules that use it fall back to the default sender.`, 'Delete')) { await api('DELETE', `/api/admin/senders/${s.id}`).catch(fail); draw(); } } }, 'Delete')))))));
    fill(el, h('div', { class: 'stack' },
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => edit(null, draw) }, '＋ Add sender'),
        h('span', { class: 'small dim' }, 'Scheduled reports are emailed from these mailboxes. Add one sender per mailbox you send from.')),
      usable.length ? h('div', { class: 'card stack' }, field('Default sender for your company', select([['', 'Automatic'], ...usable.map(x => [x.id, x.label + (x.scope === 'platform' ? ' — shared' : '')])], data.default_id || '',
        v => saveChoice({ default_id: v ? Number(v) : null }), { style: 'max-width:380px' }), 'used when a schedule says “Default sender”')) : null,
      !usable.some(s => s.mode === 'smtp') ? h('div', { class: 'banner warn' }, h('b', {}, 'No real sending is configured yet. '),
        list.length ? 'Your senders are disabled or in simulation mode — ' : 'Add a sender, pick a provider preset, enter the username and password, then click Verify and Send test — until then ',
        'scheduled reports are saved in the app but no email leaves the server.') : null,
      list.length ? senderRows(list, false) : null,
      data.shared.length && !data.is_platform_admin ? [h('h2', { style: 'margin:6px 0 0' }, 'Shared with your company by the platform'),
        h('div', { class: 'card flush' }, data.shared.map(x => h('div', { class: 'item' }, h('div', { class: 'row wrap' },
          h('div', { style: 'flex:1' }, h('b', {}, x.label), h('div', { class: 'small dim' }, `${x.from_name ? x.from_name + ' ' : ''}<${x.from_email}>${x.mode === 'simulate' ? ' · simulation' : ''}`)),
          check('Available to our reports', x.on, v => { x.on = v; saveChoice({}); })))))] : null,
      data.is_platform_admin ? [h('h2', { style: 'margin:14px 0 0' }, 'Platform senders — shared with companies'),
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => edit(null, draw, 'platform') }, '＋ Add shared sender'), h('span', { class: 'small dim' }, 'You decide, per mailbox, which companies may send from it.')),
        (data.platform || []).length ? senderRows(data.platform, true) : h('div', { class: 'empty small' }, 'No shared senders yet.')] : null,
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
