import {
  api, html, raw, setHtml, on, store, toast, fail, modal, confirmBox, field, formValues, badge, fmtDate, fmtDateTime, ago, applyTheme, purgeModal, allow, THEME_PRESETS, DEFAULT_THEME, $,
} from './core.js';
import { securityCard } from './security.js';

const page = (title, actions = '') => html`<div class="topbar"><h1>${title}</h1><span class="grow"></span>${actions}</div>`;

const PERM_VALUES = { none: 0, own: 1, all: 2 };
const permSummary = (p) => {
  const parts = [];
  for (const r of ['contacts', 'accounts', 'deals', 'tasks', 'invoices']) { const v = p[r]?.view; if (v && v !== 'none') parts.push(`${r}: ${v === 'own' ? 'own' : 'all'}`); }
  const special = [['invoices.issue', 'issue invoices'], ['campaigns.send', 'send campaigns'], ['users.manage', 'manage users'], ['data.purge', 'delete all data'], ['billing_settings.edit', 'billing settings']].filter(([k]) => { const [r, a] = k.split('.'); return p[r]?.[a]; }).map(([, l]) => l);
  return [...parts.slice(0, 3), ...special].join(' · ') || 'no access';
};

function roleModal(role, cat, roles, done) {
  const base = role || { permissions: {}, name: '', description: '' }; const locked = false;
  const own = (res, act) => { const v = store.user.perms?.[res]?.[act]; return v === true ? 2 : v === 'all' ? 2 : v === 'own' ? 1 : 0; };
  const ctl = (c, a) => {
    const cur = base.permissions?.[c.key]?.[a.key]; const name = `p__${c.key}__${a.key}`; const ceiling = own(c.key, a.key);
    if (a.kind === 'scope') return html`<label class="small">${a.label} <select name="${name}" ${ceiling === 0 ? raw('disabled') : ''}>${[['none', 'None'], ['own', 'Own'], ['all', 'All']].filter(([v]) => PERM_VALUES[v] <= ceiling).map(([v, t]) => html`<option value="${v}" ${(cur || 'none') === v ? raw('selected') : ''}>${t}</option>`)}</select></label>`;
    return html`<label class="check small" style="margin:0"><input type="checkbox" name="${name}" ${cur ? raw('checked') : ''} ${ceiling === 0 ? raw('disabled') : ''}> ${a.label}</label>`;
  };
  modal({ title: role ? `Edit role · ${role.label}` : 'New role', wide: true, submitLabel: 'Save role',
    body: html`<div class="row">${field({ name: 'name', label: 'Role name', required: true, placeholder: 'e.g. Sales assistant' }, { name: role?.is_system ? role.name : role?.name })}${field({ name: 'description', label: 'Description (optional)' }, base)}</div>
      ${!role ? html`<label>Start from<select id="seed"><option value="">— nothing (no access) —</option>${roles.map((r) => html`<option value="${r.id}">${r.label}</option>`)}</select></label>` : ''}
      <p class="small muted">Scope: <b>Own</b> = only records the person owns (records owned by others stay invisible). <b>All</b> = every record. You can only grant permissions you hold yourself.</p>
      <div class="tablewrap" style="max-height:52vh;overflow:auto"><table><tbody>${cat.map((c) => html`<tr><td style="width:210px"><b>${c.label}</b></td><td><div style="display:flex;gap:6px 16px;flex-wrap:wrap;align-items:center">${c.actions.map((a) => ctl(c, a))}</div></td></tr>`)}</tbody></table></div>`,
    onOpen: (form) => {
      if (role?.is_system && role.name !== 'admin') form.name.readOnly = true;
      const fill = (perms) => { for (const c of cat) for (const a of c.actions) { const el = form.elements[`p__${c.key}__${a.key}`]; if (!el || el.disabled) continue; const v = perms?.[c.key]?.[a.key]; if (a.kind === 'scope') { const want = v || 'none'; el.value = [...el.options].some((o) => o.value === want) ? want : el.options[el.options.length - 1].value; } else el.checked = !!v; } };
      $('#seed', form)?.addEventListener('change', (e) => { const r = roles.find((x) => String(x.id) === e.target.value); fill(r?.permissions || {}); });
    },
    onSubmit: async (f) => {
      const permissions = {};
      for (const c of cat) { permissions[c.key] = {}; for (const a of c.actions) { const el = f.elements[`p__${c.key}__${a.key}`]; permissions[c.key][a.key] = a.kind === 'scope' ? (el?.value || 'none') : !!el?.checked; } }
      const body = { name: f.name.value, description: f.description.value, permissions };
      role ? await api('PUT', `/roles/${role.id}`, body) : await api('POST', '/roles', body); toast('Role saved', 'ok'); done();
    } });
}

export async function team(root) {
  let tab = sessionStorage.getItem('teamTab') || 'users';
  const canManage = allow('users.manage'), canAudit = allow('audit.view');
  if (tab === 'audit' && !canAudit) tab = 'users';
  const draw = async () => {
    const [users, roleData, log] = await Promise.all([api('GET', '/users'), api('GET', '/roles'), tab === 'audit' && canAudit ? api('GET', '/audit') : []]);
    const roles = roleData.roles; const cat = roleData.catalogue;
    const usersView = html`<div class="card"><div class="tablewrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>2FA</th><th>Joined</th><th></th></tr></thead><tbody>
      ${users.map((u) => html`<tr><td><b>${u.name}</b></td><td>${u.email}</td><td><span class="badge">${u.role_label}</span></td><td>${u.active ? badge('active') : badge('disabled')}</td><td>${u.twofa ? badge('on') : html`<span class="muted small">off</span>`}</td><td>${fmtDate(u.created_at)}</td><td>${canManage ? html`<button class="btn sm" data-act="edit" data-id="${u.id}">Edit</button>${u.twofa ? html` <button class="btn sm" data-act="reset2fa" data-id="${u.id}" title="Lost phone? Switch off their two-factor so they can set it up again">Reset 2FA</button>` : ''}` : ''}</td></tr>`)}</tbody></table></div></div>`;
    const rolesView = html`<p class="muted">A role decides what a person can see and do. Built-in roles are a starting point; create your own for assistants, accountants, read-only auditors and so on. Changes apply immediately, even to people who are logged in.</p>
      <div class="card"><div class="tablewrap"><table><thead><tr><th>Role</th><th>What it allows</th><th>People</th><th></th></tr></thead><tbody>
      ${roles.map((r) => html`<tr><td><b>${r.label}</b> ${r.is_system ? html`<span class="badge b-grey">built-in</span>` : ''}<div class="small muted">${r.description || ''}</div></td><td class="small">${permSummary(r.permissions)}</td><td>${r.user_count}</td>
        <td class="nowrap">${canManage ? html`${r.name === 'admin' ? html`<span class="muted small">full access · locked</span>` : html`<button class="btn sm" data-act="redit" data-id="${r.id}">Edit</button>`} <button class="btn sm" data-act="rdup" data-id="${r.id}">Duplicate</button>${r.is_system ? '' : html` <button class="btn sm danger" data-act="rdel" data-id="${r.id}" aria-label="Delete">✕</button>`}` : ''}</td></tr>`)}</tbody></table></div></div>`;
    const auditView = html`<div class="card"><div class="hd"><h2>Audit log</h2><span class="muted small">Last 200 events</span></div><div class="tablewrap" style="max-height:520px;overflow:auto"><table><tbody>
      ${log.map((l) => html`<tr><td class="small muted nowrap">${fmtDateTime(l.created_at)}</td><td>${l.user_name || 'system'}</td><td>${l.action} <b>${l.entity}</b> ${l.entity_id ? '#' + l.entity_id : ''}</td><td class="small muted">${l.detail || ''}</td></tr>`)}</tbody></table></div></div>`;
    setHtml(root, html`${page('Team & roles', canManage ? (tab === 'roles' ? html`<button class="btn primary" data-act="rnew">+ New role</button>` : html`<button class="btn primary" data-act="new">+ Invite user</button>`) : '')}
      <div class="tabs"><button class="${tab === 'users' ? 'on' : ''}" data-act="tab" data-t="users">Users</button><button class="${tab === 'roles' ? 'on' : ''}" data-act="tab" data-t="roles">Roles & permissions</button>${canAudit ? html`<button class="${tab === 'audit' ? 'on' : ''}" data-act="tab" data-t="audit">Audit log</button>` : ''}</div>
      ${tab === 'users' ? usersView : tab === 'roles' ? rolesView : auditView}`);
    const open = (u) => modal({ title: u ? `Edit ${u.name}` : 'Invite user',
      body: html`${field({ name: 'name', label: 'Full name', required: true }, u || {})}${u ? '' : field({ name: 'email', label: 'Email', type: 'email', required: true })}${field({ name: 'role_id', label: 'Role', type: 'select', options: roles.map((r) => [r.id, `${r.label}${r.is_system ? '' : ' (custom)'}`]), blank: false }, u || { role_id: roles.find((r) => r.name === 'rep')?.id })}
        ${u ? field({ name: 'active', label: 'Account active', type: 'checkbox' }, u) : ''}${field({ name: 'password', label: u ? 'Reset password (leave blank to keep)' : 'Initial password', type: 'password', required: !u, placeholder: 'min 8 chars, letters & numbers' })}`,
      onSubmit: async (f) => {
        const v = { name: f.name.value, role_id: f.role_id.value, password: f.password.value || undefined };
        if (u) { v.active = f.active.checked; await api('PUT', `/users/${u.id}`, v); } else await api('POST', '/users', { ...v, email: f.email.value });
        store.meta = await api('GET', '/meta'); toast('User saved', 'ok'); draw();
      } });
    const byId = (el, list) => list.find((x) => String(x.id) === el.dataset.id);
    on(root, {
      tab: (el) => { tab = el.dataset.t; sessionStorage.setItem('teamTab', tab); draw(); },
      new: () => open(null), edit: (el) => open(byId(el, users)),
      reset2fa: async (el) => { const u = byId(el, users); if (await confirmBox(`Reset two-factor for ${u.name}? They will be signed out everywhere and can set it up again at their next sign-in.`, 'Reset')) { await api('POST', `/users/${u.id}/reset-2fa`); toast('Two-factor reset', 'ok'); draw(); } },
      rnew: () => roleModal(null, cat, roles, draw), redit: (el) => roleModal(byId(el, roles), cat, roles, draw),
      rdup: async (el) => { await api('POST', `/roles/${el.dataset.id}/duplicate`); toast('Role duplicated', 'ok'); draw(); },
      rdel: async (el) => { const r = byId(el, roles); if (await confirmBox(`Delete the role "${r.label}"?`, 'Delete')) { await api('DELETE', `/roles/${r.id}`); toast('Role deleted', 'ok'); draw(); } },
    });
  };
  await draw();
}

export async function settings(root) {
  const admin = allow('settings.manage'); const canPurge = allow('data.purge'), canBackup = allow('data.backup');
  const dataCounts = canPurge ? await api('GET', '/admin/data-counts') : null;
  const backups = canBackup ? await api('GET', '/admin/backups') : [];
  const [outbox, ai] = await Promise.all([allow('campaigns.send') ? api('GET', '/campaigns/outbox') : [], api('GET', '/ai/status')]);
  let draft = { ...store.theme };
  let mine = 'org'; try { mine = localStorage.getItem('ovantaa_mode') || 'org'; } catch {}
  setHtml(root, html`${page('Settings')}
    <div class="grid g2"><div class="card"><div class="hd"><h2>My account</h2></div><div class="bd"><p><b>${store.user.name}</b><br><span class="muted">${store.user.email} · ${store.user.role}</span></p>
      <form id="pw"><label>Current password<input type="password" name="current" required autocomplete="current-password"></label><label>New password<input type="password" name="next" required minlength="8" autocomplete="new-password"></label><button class="btn primary">Change password</button></form></div></div>

      <div class="card"><div class="hd"><h2>Appearance</h2></div><div class="bd">
        <label style="max-width:320px">My display mode (this browser only)<select id="mymode">${[['org', 'Follow company default'], ['auto', 'Match my device'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => html`<option value="${v}" ${v === mine ? raw('selected') : ''}>${l}</option>`)}</select></label>
        ${admin ? html`<hr style="border:0;border-top:1px solid var(--line);margin:14px 0"><h3>Company theme <span class="muted small">(everyone sees this)</span></h3>
          <div class="swatches">${THEME_PRESETS.map(([n, p, sd]) => html`<button type="button" class="swatch" title="${n}" data-act="preset" data-p="${p}" data-s="${sd}" style="background:${p};box-shadow:inset -14px 0 0 ${sd}" aria-label="${n} theme"></button>`)}</div>
          <div class="row"><label>Accent colour<input type="color" id="c_primary" value="${draft.primary}"></label><label>Sidebar colour<input type="color" id="c_side" value="${draft.sidebar}"></label></div>
          <label style="max-width:320px">Default mode<select id="c_mode">${['auto', 'light', 'dark'].map((m) => html`<option value="${m}" ${m === draft.mode ? raw('selected') : ''}>${m === 'auto' ? 'Match each user’s device' : m[0].toUpperCase() + m.slice(1)}</option>`)}</select></label>
          <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" data-act="savetheme">Save company theme</button><button class="btn" data-act="resettheme">Reset to default</button></div>
          <p class="small muted">Changes preview instantly; they are only saved for everyone when you click Save.</p>` : html`<p class="small muted mt">Colours are set by your administrator.</p>`}</div></div></div>

    <div class="grid g2 mt"><div class="card"><div class="hd"><h2>✨ AI assistant (Claude)</h2></div><div class="bd">
      <p>Status: ${ai.configured ? html`<span class="badge sent">connected</span> <span class="muted small">model ${ai.model}${ai.from_env ? ' · key from server environment' : ''}</span>` : html`<span class="badge draft">not configured</span>`}</p>
      <p class="small muted">Powers “Write with Claude” in the campaign editor. Only the text typed into the AI box (and the content being rewritten) is sent to Anthropic — never contact records. Get a key at console.anthropic.com.</p>
      ${admin ? html`<form id="aiform"><label>Anthropic API key<input type="password" name="api_key" autocomplete="off" placeholder="${ai.configured && !ai.from_env ? '•••••••• saved (enter a new one to replace)' : 'sk-ant-…'}"></label>
        <label>Model<input name="model" value="${ai.model}"></label>
        <div style="display:flex;gap:8px"><button class="btn primary">Save</button>${ai.configured && !ai.from_env ? html`<button type="button" class="btn danger" data-act="aiclear">Remove key</button>` : ''}</div></form>
        <p class="small muted">Alternatively set the <span class="mono">ANTHROPIC_API_KEY</span> environment variable before starting the server.</p>` : ''}</div></div>

      <div class="card"><div class="hd"><h2>Email delivery</h2></div><div class="bd">
        <p>Sending is configured per sender mailbox under <a href="#/senders"><b>Email senders</b></a> (Google, Microsoft 365, Zoho or any SMTP server) — add one entry per address you send from. Notification emails are configured under <a href="#/notifications"><b>Notifications</b></a>.</p>
        <p class="muted small">Tracking links use <span class="mono">${m_baseUrl()}</span>. Set the <span class="mono">BASE_URL</span> environment variable to your public address so opens, clicks and unsubscribes reach this server.</p></div></div></div>
    <div class="mt" id="seccard"></div>
    ${canBackup ? html`<div class="card mt"><div class="hd"><h2>Backups</h2><span class="muted small">an automatic backup is taken daily · before every upgrade a restore point is saved</span><span class="grow"></span><button class="btn sm" data-act="mkbackup">Create backup now</button><a class="btn sm primary" href="/api/admin/backup">Download backup</a></div>
      ${backups.length ? html`<div class="tablewrap" style="max-height:240px;overflow:auto"><table><tbody>${backups.slice(0, 20).map((b) => html`<tr><td class="mono small">${b.name}</td><td>${b.label.startsWith('premigration') ? 'before upgrade' : b.label}</td><td class="small right">${(b.size / 1024).toFixed(0)} KB</td><td class="small muted">${fmtDateTime(b.mtime)}</td></tr>`)}</tbody></table></div>` : html`<div class="empty">No backups yet.</div>`}
      <div class="bd small muted">Backups hold all your data including password hashes and encrypted credentials. Store downloads safely. To restore: stop the server and run <span class="mono">npm run restore -- data/backups/&lt;file&gt; --yes</span>. Keep <span class="mono">data/.secret</span> together with your backups — saved SMTP passwords and API keys cannot be decrypted without it.</div></div>` : ''}
    ${canPurge ? html`<div class="card mt"><div class="hd"><h2>Data management</h2><span class="muted small">deletions are permanent and recorded in the audit log</span></div><div class="tablewrap"><table><tbody>${Object.entries(dataCounts).map(([k, v]) => html`<tr><td><b>${v.count}</b> ${v.label}${v.effects ? html`<div class="small muted">${v.effects}</div>` : ''}</td><td class="right"><button class="btn sm danger" data-act="purge" data-e="${k}" ${v.count ? '' : raw('disabled')}>Delete all…</button></td></tr>`)}</tbody></table></div><div class="bd small muted">Email senders, users, roles and the audit log are never deleted from here. Take a backup first if you might want the records later.</div></div>` : ''}
    ${outbox.length ? html`<div class="card mt"><div class="hd"><h2>Recent simulated mail</h2><span class="muted small">emails handled by simulation senders since server start — nothing was delivered</span></div><div class="tablewrap" style="max-height:320px;overflow:auto"><table><tbody>${outbox.map((o) => html`<tr><td class="small muted nowrap">${ago(o.at)}</td><td>${o.to}</td><td>${o.subject}</td></tr>`)}</tbody></table></div></div>` : ''}`);
  function m_baseUrl() { return store.meta.baseUrl; }
  securityCard($('#seccard', root), { admin }).catch(fail);
  $('#pw', root).addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.currentTarget;
    try { await api('POST', '/auth/password', { current: f.current.value, next: f.next.value }); toast('Password changed', 'ok'); f.reset(); } catch (x) { fail(x); }
  });
  $('#mymode', root).addEventListener('change', (e) => { try { localStorage.setItem('ovantaa_mode', e.target.value); } catch {} applyTheme(store.theme); });
  const preview = () => { draft = { primary: $('#c_primary', root).value, sidebar: $('#c_side', root).value, mode: $('#c_mode', root).value }; applyTheme(draft); };
  on(root, { mkbackup: async () => { const r = await api('POST', '/admin/backups'); toast(`Backup created${r.verified ? ' and verified' : ' — verification FAILED'}`, r.verified ? 'ok' : 'bad'); settings(root); }, purge: (el) => purgeModal(el.dataset.e, () => settings(root)) });
  if (admin) {
    ['#c_primary', '#c_side', '#c_mode'].forEach((id) => $(id, root).addEventListener('input', preview));
    on(root, {
      preset: (el) => { $('#c_primary', root).value = el.dataset.p; $('#c_side', root).value = el.dataset.s; preview(); },
      savetheme: async () => { const t = await api('PUT', '/theme', draft); store.meta.theme = t; applyTheme(t); toast('Company theme saved', 'ok'); },
      resettheme: async () => { const t = await api('PUT', '/theme', DEFAULT_THEME); store.meta.theme = t; applyTheme(t); toast('Theme reset', 'ok'); settings(root); },
      aiclear: async () => { await api('PUT', '/settings/ai', { clear_key: true }); store.meta.ai = await api('GET', '/ai/status'); toast('API key removed'); settings(root); },
    });
    $('#aiform', root).addEventListener('submit', async (e) => {
      e.preventDefault(); const f = e.currentTarget;
      try { await api('PUT', '/settings/ai', { api_key: f.api_key.value || undefined, model: f.model.value }); store.meta.ai = await api('GET', '/ai/status'); toast('AI settings saved', 'ok'); settings(root); } catch (x) { fail(x); }
    });
    window.addEventListener('hashchange', () => applyTheme(store.meta.theme), { once: true }); // discard unsaved preview when leaving
  }
}
