import { api, html, raw, setHtml, on, store, toast, fail, modal, confirmBox, field, formValues, badge, fmtDate, fmtDateTime, ago, $ } from './core.js';

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
  const m = store.meta;
  const outbox = ['admin', 'manager'].includes(store.user.role) ? await api('GET', '/campaigns/outbox') : [];
  setHtml(root, html`${page('Settings')}
    <div class="grid g2"><div class="card"><div class="hd"><h2>My account</h2></div><div class="bd"><p><b>${store.user.name}</b><br><span class="muted">${store.user.email} · ${store.user.role}</span></p>
      <form id="pw"><label>Current password<input type="password" name="current" required autocomplete="current-password"></label><label>New password<input type="password" name="next" required minlength="8" autocomplete="new-password"></label><button class="btn primary">Change password</button></form></div></div>
      <div class="card"><div class="hd"><h2>Email delivery</h2></div><div class="bd">
        <p>Transport: <b>${m.mailTransport === 'webhook' ? 'Webhook (live delivery)' : 'Simulation (no real email leaves the server)'}</b></p>
        <p class="muted small">Configure with environment variables: <code>MAIL_TRANSPORT=webhook</code>, <code>MAIL_WEBHOOK_URL</code>, optional <code>MAIL_WEBHOOK_TOKEN</code>. Each message is POSTed as JSON (<code>from, to, subject, html, text, headers</code>) so you can bridge to SES, SendGrid, Postmark, SMTP relay, etc.</p>
        <p class="muted small">Tracking links use <code>${m.baseUrl}</code> — set <code>BASE_URL</code> to your public address so opens, clicks and unsubscribes reach this server.</p></div></div></div>
    ${outbox.length || ['admin', 'manager'].includes(store.user.role) ? html`<div class="card mt"><div class="hd"><h2>Recent outbound mail</h2><span class="muted small">since server start</span></div>${outbox.length ? html`<div class="tablewrap" style="max-height:320px;overflow:auto"><table><tbody>${outbox.map((o) => html`<tr><td class="small muted nowrap">${ago(o.at)}</td><td>${o.to}</td><td>${o.subject}</td></tr>`)}</tbody></table></div>` : html`<div class="empty">No mail sent since the server started.</div>`}</div>` : ''}`);
  $('#pw', root).addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.currentTarget;
    try { await api('POST', '/auth/password', { current: f.current.value, next: f.next.value }); toast('Password changed', 'ok'); f.reset(); } catch (x) { fail(x); }
  });
}
