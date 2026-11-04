import { api, html, raw, setHtml, on, store, toast, fail, modal, confirmBox, field, formValues, badge, fmtDateTime, ago, can, $, $$ } from './core.js';

const page = (title, actions = '') => html`<div class="topbar"><h1>${title}</h1><span class="grow"></span>${actions}</div>`;

const PRESETS = {
  google: { label: 'Google (Gmail / Workspace)', host: 'smtp.gmail.com', port: 587, secure: false, daily: 500,
    help: 'Use the full email address as username and a 16-character App Password (Google Account → Security → 2-Step Verification → App passwords). Regular passwords are rejected. Gmail allows roughly 500 messages/day (about 2,000 on Google Workspace); the From address must be this account or a verified "Send mail as" alias.' },
  microsoft: { label: 'Microsoft 365 / Outlook', host: 'smtp.office365.com', port: 587, secure: false, daily: 1000,
    help: 'SMTP AUTH must be enabled for the mailbox by your Microsoft 365 admin. Microsoft is phasing out Basic-auth SMTP (disabled by default for existing tenants from the end of December 2026), so for Microsoft mailboxes prefer a transactional relay long-term.' },
  zoho_in: { label: 'Zoho Mail (India data centre)', host: 'smtp.zoho.in', port: 465, secure: true, daily: 500,
    help: 'Use the full address as username. With two-factor auth on, create an application-specific password in Zoho Accounts → Security. Accounts in other regions use smtp.zoho.com / .eu / .com.au.' },
  zoho: { label: 'Zoho Mail (global)', host: 'smtp.zoho.com', port: 465, secure: true, daily: 500, help: 'Use the full address as username; use an app-specific password if two-factor auth is on.' },
  custom: { label: 'Other SMTP server', host: '', port: 587, secure: false, daily: 500, help: 'Port 587 uses STARTTLS (leave SSL/TLS off); port 465 uses implicit SSL/TLS (turn it on). Transactional providers such as Amazon SES, SendGrid, Postmark or Brevo are recommended for large campaigns.' },
};

function senderModal(s, done) {
  const v = s || { mode: 'smtp', port: 587, daily_limit: 500, delay_ms: 1000, active: true };
  const guess = s ? Object.entries(PRESETS).find(([, p]) => p.host === s.host)?.[0] || 'custom' : 'google';
  modal({ title: s ? `Edit sender · ${s.label}` : 'Add email sender', wide: true, submitLabel: 'Save sender',
    body: html`<div class="row">${field({ name: 'label', label: 'Label (shown in the app)', required: true, placeholder: 'e.g. Santosh – SyncSense' }, v)}${field({ name: 'from_name', label: 'From name', placeholder: 'Santosh T' }, v)}</div>
      <div class="row">${field({ name: 'from_email', label: 'From email address', type: 'email', required: true, placeholder: 'santosh@syncsense.in' }, v)}${field({ name: 'reply_to', label: 'Reply-to (optional)', type: 'email' }, v)}</div>
      ${field({ name: 'mode', label: 'Delivery mode', type: 'select', options: [['smtp', 'Real email via SMTP'], ['simulate', 'Simulation (nothing is sent — for demos/testing)']], blank: false }, v)}
      <div id="smtpbox"><div class="row"><label>Provider preset<select id="preset">${Object.entries(PRESETS).map(([k, p]) => html`<option value="${k}" ${k === guess ? raw('selected') : ''}>${p.label}</option>`)}</select></label><span></span></div>
        <div id="phelp" class="banner info small"></div>
        <div class="row">${field({ name: 'host', label: 'SMTP host', placeholder: 'smtp.gmail.com' }, v)}${field({ name: 'port', label: 'Port', type: 'number', min: 1, max: 65535 }, v)}</div>
        ${field({ name: 'secure', label: 'Use SSL/TLS from the start (port 465). Leave off for port 587 (STARTTLS).', type: 'checkbox' }, v)}
        <div class="row">${field({ name: 'username', label: 'SMTP username', placeholder: 'usually the full email address', }, v)}<label>Password / app password<input type="password" name="password" autocomplete="new-password" placeholder="${s?.has_password ? '•••••••• (leave blank to keep)' : ''}"></label></div></div>
      <div class="row">${field({ name: 'daily_limit', label: 'Max emails per rolling 24h', type: 'number', min: 1 }, v)}${field({ name: 'delay_ms', label: 'Pause between emails (ms)', type: 'number', min: 0, max: 60000 }, v)}</div>
      ${field({ name: 'active', label: 'Active', type: 'checkbox' }, v)}${field({ name: 'is_default', label: 'Use as the default sender', type: 'checkbox' }, { is_default: s?.is_default })}
      <p class="small muted">Passwords are encrypted at rest and never shown again. Gmail and Yahoo expect SPF, DKIM and DMARC records for your sending domain — see the checklist on the senders page.</p>`,
    onOpen: (form) => {
      const sync = () => { $('#smtpbox', form).hidden = form.mode.value !== 'smtp'; };
      const preset = (apply) => { const p = PRESETS[$('#preset', form).value]; setHtml($('#phelp', form), html`${p.help}`); if (apply) { form.host.value = p.host; form.port.value = p.port; form.secure.checked = p.secure; form.daily_limit.value = p.daily; } };
      form.mode.addEventListener('change', sync); $('#preset', form).addEventListener('change', () => preset(true));
      form.from_email.addEventListener('blur', () => { if (!form.username.value) form.username.value = form.from_email.value; });
      sync(); preset(!s);
    },
    onSubmit: async (f) => {
      const b = { ...Object.fromEntries(['label', 'from_name', 'from_email', 'reply_to', 'mode', 'host', 'port', 'username', 'password', 'daily_limit', 'delay_ms'].map((k) => [k, f[k].value])), secure: f.secure.checked, active: f.active.checked, is_default: f.is_default.checked };
      s ? await api('PUT', `/senders/${s.id}`, b) : await api('POST', '/senders', b);
      store.meta = await api('GET', '/meta'); toast('Sender saved', 'ok'); done();
    } });
}

export async function senders(root) {
  const draw = async () => {
    const list = await api('GET', '/senders'); const admin = can('admin');
    setHtml(root, html`${page('Email senders', admin ? html`<button class="btn primary" data-act="new">+ Add sender</button>` : '')}
      ${list.every((s) => s.mode === 'simulate') ? html`<div class="banner"><b>No real sending is configured yet.</b> ${list.length ? 'Your senders are in simulation mode.' : 'Add a sender'} — campaigns will be recorded as sent but <b>no email leaves the server</b> until you add a sender with real SMTP details.</div>` : ''}
      <div class="card">${list.length ? html`<div class="tablewrap"><table><thead><tr><th>Sender</th><th>Server</th><th>Status</th><th>Last 24h</th><th></th></tr></thead><tbody>
        ${list.map((s) => html`<tr><td><b>${s.label}</b> ${s.is_default ? html`<span class="badge">default</span>` : ''}<div class="small muted">${s.from_name ? `${s.from_name} ` : ''}&lt;${s.from_email}&gt;</div></td>
          <td class="small">${s.mode === 'smtp' ? html`${s.host}:${s.port} ${s.secure ? 'SSL/TLS' : 'STARTTLS'}<div class="muted">${s.username || ''}</div>` : html`<span class="badge simulated">simulation</span>`}</td>
          <td>${!s.active ? badge('disabled') : s.mode === 'simulate' ? html`<span class="muted small">—</span>` : s.last_error ? html`<span class="badge failed">error</span><div class="small" style="color:var(--bad);max-width:280px">${s.last_error}</div>` : s.last_verified_at ? html`<span class="badge sent">verified</span><div class="small muted">${ago(s.last_verified_at)}</div>` : html`<span class="badge draft">not verified</span>`}</td>
          <td>${s.sent_24h} / ${s.daily_limit}<div class="ring"><i style="width:${Math.min(100, (s.sent_24h / s.daily_limit) * 100)}%"></i></div></td>
          <td class="nowrap">${admin ? html`<button class="btn sm" data-act="verify" data-id="${s.id}">Verify</button> <button class="btn sm" data-act="test" data-id="${s.id}">Send test</button> <button class="btn sm" data-act="edit" data-id="${s.id}">Edit</button> <button class="btn sm danger" data-act="del" data-id="${s.id}" aria-label="Delete">✕</button>` : ''}</td></tr>`)}</tbody></table></div>` : html`<div class="empty">No senders yet. Add one for each address you send from.</div>`}</div>
      <div class="grid g2 mt"><div class="card"><div class="hd"><h2>How sending works</h2></div><div class="bd small" style="display:grid;gap:8px">
        <div>Each campaign picks one sender; emails go out one at a time through that mailbox's SMTP server, respecting its <b>24-hour limit</b> and <b>pause</b>. If the limit is hit, the campaign pauses and resumes automatically.</div>
        <div><b>Statuses you will see:</b> <i>Sent</i> = accepted by the mail server (SMTP cannot confirm inbox delivery) · <i>Failed</i> = refused, with the server's reason · <i>Opened</i>/<i>Clicked</i> = tracked pixel and links · <i>Unsubscribed</i>. Open counts are approximate: some mail apps pre-load or block images.</div>
        <div>Delayed bounces (mailbox full, address gone) arrive later as bounce emails in the sender's inbox; this app does not read inboxes, so watch the mailbox and unsubscribe such contacts.</div></div></div>
        <div class="card"><div class="hd"><h2>Deliverability checklist</h2></div><div class="bd small" style="display:grid;gap:8px">
        <div>☐ <b>SPF</b> and <b>DKIM</b> published for every sending domain (e.g. syncsense.in, ezdatamunch.com) — enable DKIM in your mail provider's admin console.</div>
        <div>☐ <b>DMARC</b> record (start with <span class="mono">p=none</span>) aligned with the From domain. Gmail/Yahoo require SPF+DKIM+DMARC for senders above 5,000 emails/day to them.</div>
        <div>☐ Keep spam complaints under 0.1% (hard limit 0.3%). Only email people who expect it; this app adds one-click unsubscribe automatically.</div>
        <div>☐ Warm up new addresses: start with 20–50 emails a day and grow. Mailbox accounts are not built for large cold blasts — use a transactional provider for volume.</div></div></div></div>`);
    const byId = (el) => list.find((s) => String(s.id) === el.dataset.id);
    on(root, {
      new: () => senderModal(null, draw), edit: (el) => senderModal(byId(el), draw),
      del: async (el) => { if (await confirmBox(`Delete sender "${byId(el).label}"? Campaigns using it fall back to the default sender.`, 'Delete')) { await api('DELETE', `/senders/${el.dataset.id}`); draw(); } },
      verify: async (el) => { el.disabled = true; el.textContent = 'Checking…'; try { const r = await api('POST', `/senders/${el.dataset.id}/verify`); toast(r.ok ? (r.note || 'Connection and login OK') : r.error, r.ok ? 'ok' : 'bad'); } finally { draw(); } },
      test: (el) => modal({ title: 'Send test email', submitLabel: 'Send', body: field({ name: 'to', label: 'Send a test to', type: 'email', required: true, default: store.user.email }),
        onSubmit: async (f) => { const r = await api('POST', `/senders/${el.dataset.id}/test`, { to: f.to.value }); toast(r.simulated ? `Simulated — nothing was actually sent to ${r.to}` : `Test email sent to ${r.to}`, r.simulated ? '' : 'ok'); draw(); } }),
    });
  };
  await draw();
}

// =============== Notifications ===============
const recipientSummary = (r, users) => [
  r.notify_owner ? 'record owner' : null, ...r.user_ids.map((id) => users.find((u) => u.id === id)?.name).filter(Boolean), ...(r.extra_emails ? r.extra_emails.split(', ') : []),
].filter(Boolean).join(', ');

function ruleModal(rule, done) {
  const v = rule || { event: 'deal.stage_changed', active: true, user_ids: [] };
  const dealish = (e) => e.startsWith('deal.');
  modal({ title: rule ? 'Edit notification rule' : 'New notification rule', wide: true, submitLabel: 'Save rule',
    body: html`${field({ name: 'name', label: 'Rule name', required: true, placeholder: 'e.g. Tell the founders when a deal is won' }, v)}
      ${field({ name: 'event', label: 'When this happens…', type: 'select', options: Object.entries(store.meta.events), blank: false }, v)}
      <div class="card kpi" style="margin-bottom:12px"><b class="small">Send the email to</b>
        <div class="pill-row mt">${store.meta.users.map((u) => html`<label class="check" style="margin:0"><input type="checkbox" name="u_${u.id}" ${v.user_ids.includes(u.id) ? raw('checked') : ''}> ${u.name} <span class="muted small">(${u.role})</span></label>`)}</div>
        ${field({ name: 'notify_owner', label: 'The owner of the record', type: 'checkbox' }, v)}
        ${field({ name: 'extra_emails', label: 'Other email addresses (comma separated)', placeholder: 'partner@example.com, ops@syncsense.in' }, v)}</div>
      <div id="dealopts" class="row">${field({ name: 'min_amount', label: 'Only deals worth at least (USD)', type: 'number', min: 0 }, v)}
        <div><div class="small" style="font-weight:600;margin-bottom:4px">Only when the deal is in stage</div><div class="pill-row">${store.meta.stages.map((s) => html`<label class="check" style="margin:0"><input type="checkbox" name="s_${s.key}" ${(v.only_stage || '').split(',').includes(s.key) ? raw('checked') : ''}> ${s.label}</label>`)}</div></div></div>
      ${field({ name: 'sender_id', label: 'Send from', type: 'select', options: store.meta.senders.filter((s) => s.active).map((s) => [s.id, `${s.label} <${s.from_email}>`]), blank: 'Default sender' }, v)}
      ${field({ name: 'subject_template', label: 'Custom subject (optional)', placeholder: 'Placeholders: {{name}} {{stage}} {{amount}} {{owner}} {{actor}}' }, v)}
      ${field({ name: 'intro', label: 'Extra message at the top (optional)', type: 'textarea', rows: 2 }, v)}
      ${field({ name: 'active', label: 'Rule is active', type: 'checkbox' }, v)}`,
    onOpen: (form) => { const sync = () => { $('#dealopts', form).hidden = !dealish(form.event.value); }; form.event.addEventListener('change', sync); sync(); },
    onSubmit: async (f) => {
      const user_ids = store.meta.users.filter((u) => f[`u_${u.id}`].checked).map((u) => u.id);
      const only_stage = store.meta.stages.filter((s) => f[`s_${s.key}`].checked).map((s) => s.key).join(',');
      const b = { name: f.name.value, event: f.event.value, user_ids, notify_owner: f.notify_owner.checked, extra_emails: f.extra_emails.value, sender_id: f.sender_id.value || null,
        subject_template: f.subject_template.value, intro: f.intro.value, active: f.active.checked, ...(dealish(f.event.value) ? { min_amount: f.min_amount.value, only_stage } : {}) };
      rule ? await api('PUT', `/notifications/rules/${rule.id}`, b) : await api('POST', '/notifications/rules', b); toast('Rule saved', 'ok'); done();
    } });
}

export async function notifications(root) {
  let tab = sessionStorage.getItem('notifTab') || 'rules';
  const draw = async () => {
    const admin = can('admin');
    const body = tab === 'rules' ? await rulesView(admin) : await logView();
    setHtml(root, html`${page('Notifications', tab === 'rules' && admin ? html`<button class="btn primary" data-act="new">+ New rule</button>` : '')}
      <div class="tabs"><button class="${tab === 'rules' ? 'on' : ''}" data-act="tab" data-t="rules">Rules</button><button class="${tab === 'log' ? 'on' : ''}" data-act="tab" data-t="log">Email log</button></div>${body.view}`);
    on(root, { tab: (el) => { tab = el.dataset.t; sessionStorage.setItem('notifTab', tab); draw(); }, new: () => ruleModal(null, draw), ...body.handlers(draw) });
    $('#lf', root)?.addEventListener('change', () => { sessionStorage.setItem('logFilter', $('#lf', root).value); draw(); });
  };
  const rulesView = async (admin) => {
    const rules = await api('GET', '/notifications/rules');
    return { view: html`<p class="muted">Email people automatically when records change. Choose an event, who should be told, and which sender to use. Emails are sent in the background; every attempt appears in the Email log.</p>
      <div class="card">${rules.length ? html`<div class="tablewrap"><table><thead><tr><th>Rule</th><th>Event</th><th>Recipients</th><th>Filters</th><th>Active</th><th></th></tr></thead><tbody>${rules.map((r) => html`<tr>
        <td><b>${r.name}</b></td><td class="small">${store.meta.events[r.event]}</td><td class="small">${recipientSummary(r, store.meta.users) || '—'}</td>
        <td class="small muted">${[r.min_amount != null ? `≥ $${r.min_amount}` : '', r.only_stage ? `stage: ${r.only_stage}` : ''].filter(Boolean).join(' · ') || '—'}</td>
        <td>${admin ? html`<input type="checkbox" data-act="toggle" data-id="${r.id}" ${r.active ? raw('checked') : ''} aria-label="Active">` : r.active ? badge('active') : badge('disabled')}</td>
        <td class="nowrap">${admin ? html`<button class="btn sm" data-act="rtest" data-id="${r.id}">Send me a test</button> <button class="btn sm" data-act="edit" data-id="${r.id}">Edit</button> <button class="btn sm danger" data-act="del" data-id="${r.id}" aria-label="Delete">✕</button>` : ''}</td></tr>`)}</tbody></table></div>` : html`<div class="empty">No rules yet.${admin ? ' Create one, e.g. “Deal won → notify the whole team”.' : ''}</div>`}</div>`,
      handlers: (redraw) => ({
        edit: (el) => ruleModal(rules.find((r) => String(r.id) === el.dataset.id), redraw),
        del: async (el) => { if (await confirmBox('Delete this notification rule?', 'Delete')) { await api('DELETE', `/notifications/rules/${el.dataset.id}`); redraw(); } },
        rtest: async (el) => { const r = await api('POST', `/notifications/rules/${el.dataset.id}/test`); toast(r.simulated ? 'Simulated — configure a real sender to receive it' : `Test sent to ${r.to}`, r.simulated ? '' : 'ok'); },
        toggle: async (el) => { const r = rules.find((x) => String(x.id) === el.dataset.id); await api('PUT', `/notifications/rules/${r.id}`, { ...r, active: el.checked }); toast(el.checked ? 'Rule enabled' : 'Rule disabled', 'ok'); },
      }) };
  };
  const logView = async () => {
    const f = sessionStorage.getItem('logFilter') || '';
    const rows = await api('GET', `/email-log${f ? '?status=' + f : ''}`);
    return { view: html`<div class="card"><div class="hd"><h2>Recent notification & test emails</h2><span class="grow"></span><select id="lf" aria-label="Status"><option value="">All</option><option value="sent" ${f === 'sent' ? raw('selected') : ''}>Sent</option><option value="failed" ${f === 'failed' ? raw('selected') : ''}>Failed</option><option value="simulated" ${f === 'simulated' ? raw('selected') : ''}>Simulated</option></select></div>
      ${rows.length ? html`<div class="tablewrap"><table><thead><tr><th>When</th><th>Type</th><th>To</th><th>Subject</th><th>Sender</th><th>Status</th></tr></thead><tbody>${rows.map((l) => html`<tr><td class="small nowrap">${fmtDateTime(l.created_at)}</td><td class="small">${l.kind}${l.event ? html`<div class="muted">${l.event}</div>` : ''}</td><td class="small">${l.to_email}</td><td class="small">${l.subject}</td><td class="small">${l.sender_label || 'default'}</td>
        <td>${badge(l.status)}${l.error ? html`<div class="small" style="color:var(--bad);max-width:320px">${l.error}</div>` : ''}${l.response && l.status === 'sent' ? html`<div class="small muted" title="Server response">${l.response.slice(0, 40)}</div>` : ''}</td></tr>`)}</tbody></table></div>` : html`<div class="empty">No emails yet.</div>`}</div>
      <p class="small muted">Sent = accepted by the mail server. Campaign emails are tracked per recipient on each campaign's report.</p>`, handlers: () => ({}) };
  };
  await draw();
}
