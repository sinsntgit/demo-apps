import { api, html, raw, setHtml, on, store, toast, fail, modal, confirmBox, field, formValues, badge, fmtDate, fmtDateTime, ago, applyTheme, THEME_PRESETS, DEFAULT_THEME, $ } from './core.js';

const page = (title, actions = '') => html`<div class="topbar"><h1>${title}</h1><span class="grow"></span>${actions}</div>`;

export async function team(root) {
  const draw = async () => {
    const [users, log] = await Promise.all([api('GET', '/users'), api('GET', '/audit')]);
    setHtml(root, html`${page('Team', html`<button class="btn primary" data-act="new">+ Invite user</button>`)}
      <div class="card"><div class="tablewrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Joined</th><th></th></tr></thead><tbody>
      ${users.map((u) => html`<tr><td><b>${u.name}</b></td><td>${u.email}</td><td>${badge(u.role)}</td><td>${u.active ? badge('active') : badge('disabled')}</td><td>${fmtDate(u.created_at)}</td><td><button class="btn sm" data-act="edit" data-id="${u.id}">Edit</button></td></tr>`)}</tbody></table></div></div>
      <div class="card mt"><div class="hd"><h2>Audit log</h2><span class="muted small">Last 200 events</span></div><div class="tablewrap" style="max-height:360px;overflow:auto"><table><tbody>
      ${log.map((l) => html`<tr><td class="small muted nowrap">${fmtDateTime(l.created_at)}</td><td>${l.user_name || 'system'}</td><td>${l.action} <b>${l.entity}</b> ${l.entity_id ? '#' + l.entity_id : ''}</td><td class="small muted">${l.detail || ''}</td></tr>`)}</tbody></table></div></div>`);
    const roles = [['admin', 'Admin – everything'], ['manager', 'Manager – can send campaigns, delete'], ['rep', 'Sales rep – own work']];
    const open = (u) => modal({ title: u ? `Edit ${u.name}` : 'Invite user',
      body: html`${field({ name: 'name', label: 'Full name', required: true }, u || {})}${u ? '' : field({ name: 'email', label: 'Email', type: 'email', required: true })}${field({ name: 'role', label: 'Role', type: 'select', options: roles, blank: false }, u || { role: 'rep' })}
        ${u ? field({ name: 'active', label: 'Account active', type: 'checkbox' }, u) : ''}${field({ name: 'password', label: u ? 'Reset password (leave blank to keep)' : 'Initial password', type: 'password', required: !u, placeholder: 'min 8 chars, letters & numbers' })}`,
      onSubmit: async (f) => {
        const v = { name: f.name.value, role: f.role.value, password: f.password.value || undefined };
        if (u) { v.active = f.active.checked; await api('PUT', `/users/${u.id}`, v); } else await api('POST', '/users', { ...v, email: f.email.value });
        store.meta = await api('GET', '/meta'); toast('User saved', 'ok'); draw();
      } });
    on(root, { new: () => open(null), edit: (el) => open(users.find((x) => String(x.id) === el.dataset.id)) });
  };
  await draw();
}

export async function settings(root) {
  const admin = store.user.role === 'admin';
  const [outbox, ai] = await Promise.all([['admin', 'manager'].includes(store.user.role) ? api('GET', '/campaigns/outbox') : [], api('GET', '/ai/status')]);
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
    ${outbox.length ? html`<div class="card mt"><div class="hd"><h2>Recent simulated mail</h2><span class="muted small">emails handled by simulation senders since server start — nothing was delivered</span></div><div class="tablewrap" style="max-height:320px;overflow:auto"><table><tbody>${outbox.map((o) => html`<tr><td class="small muted nowrap">${ago(o.at)}</td><td>${o.to}</td><td>${o.subject}</td></tr>`)}</tbody></table></div></div>` : ''}`);
  function m_baseUrl() { return store.meta.baseUrl; }
  $('#pw', root).addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.currentTarget;
    try { await api('POST', '/auth/password', { current: f.current.value, next: f.next.value }); toast('Password changed', 'ok'); f.reset(); } catch (x) { fail(x); }
  });
  $('#mymode', root).addEventListener('change', (e) => { try { localStorage.setItem('ovantaa_mode', e.target.value); } catch {} applyTheme(store.theme); });
  const preview = () => { draft = { primary: $('#c_primary', root).value, sidebar: $('#c_side', root).value, mode: $('#c_mode', root).value }; applyTheme(draft); };
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
