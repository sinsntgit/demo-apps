import {
  api, qs, html, raw, setHtml, esc, on, store, toast, fail, modal, confirmBox, field, formValues, badge, money, pct, num, fmtDate, ago, initials,
  fullName, can, todayStr, $, $$, debounce,
} from './core.js';
import { mountList } from './list.js';
import { csvToContacts } from './csv.js';

const userOpts = () => store.meta.users.map((u) => [u.id, u.name]);
const lookups = async () => {
  const [a, c, d] = await Promise.all([api('GET', '/accounts?limit=1000&sort=name'), api('GET', '/contacts?limit=1000&sort=name'), api('GET', '/deals?limit=1000&sort=name')]);
  return { accounts: a.rows.map((x) => [x.id, x.name]), contacts: c.rows.map((x) => [x.id, fullName(x)]), deals: d.rows.map((x) => [x.id, x.name]) };
};
const STATUS = ['lead', 'qualified', 'customer', 'churned'];
const page = (title, actions = '') => html`<div class="topbar"><h1>${title}</h1><span class="grow"></span>${actions}</div>`;

// =============== Dashboard ===============
export async function dashboard(root) {
  let scope = sessionStorage.getItem('dashScope') || 'all';
  const draw = async () => {
    const d = await api('GET', `/dashboard?scope=${scope}`);
    const k = d.kpis; const maxRev = Math.max(...d.revenueByMonth.map((m) => m.value), 1);
    const maxStage = Math.max(...d.pipeline.map((s) => s.amount), 1);
    const palette = ['#4f46e5', '#0ea5e9', '#16a34a', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6', '#64748b'];
    const totalSrc = d.leadSources.reduce((a, s) => a + s.count, 0) || 1;
    let acc = 0; const stops = d.leadSources.map((s, i) => { const from = acc; acc += (s.count / totalSrc) * 100; return `${palette[i % 8]} ${from}% ${acc}%`; }).join(',');
    setHtml(root, html`${page(`Welcome back, ${store.user.name.split(' ')[0]}`, html`<select id="scope" aria-label="Scope"><option value="all" ${scope === 'all' ? raw('selected') : ''}>Whole team</option><option value="mine" ${scope === 'mine' ? raw('selected') : ''}>My records</option></select>`)}
      <div class="grid g4">
        <div class="card kpi"><div class="l">Open pipeline</div><div class="v">${money(k.pipelineValue, true)}</div><div class="s">${k.openDeals} open deals · forecast ${money(k.forecast, true)}</div></div>
        <div class="card kpi"><div class="l">Closed won</div><div class="v">${money(k.wonValue, true)}</div><div class="s">Win rate ${pct(k.winRate, 0)}</div></div>
        <div class="card kpi"><div class="l">Contacts</div><div class="v">${num(k.contacts)}</div><div class="s">${num(k.accounts)} accounts</div></div>
        <div class="card kpi"><div class="l">Open tasks</div><div class="v">${k.openTasks}</div><div class="s" style="${k.overdueTasks ? 'color:var(--bad)' : ''}">${k.overdueTasks} overdue</div></div>
      </div>
      <div class="grid g21 mt">
        <div class="card"><div class="hd"><h2>Won revenue · last 6 months</h2></div><div class="bd"><div class="bars">${d.revenueByMonth.map((m) => html`<div class="b"><em>${money(m.value, true)}</em><i style="height:${Math.max(2, (m.value / maxRev) * 100)}%"></i><span>${new Date(m.month + '-02').toLocaleString(undefined, { month: 'short' })}</span></div>`)}</div></div></div>
        <div class="card"><div class="hd"><h2>Lead sources</h2></div><div class="bd" style="display:flex;gap:18px;align-items:center;flex-wrap:wrap"><div class="donut" style="background:conic-gradient(${stops || 'var(--line) 0 100%'})" role="img" aria-label="Lead sources chart"></div><div class="legend">${d.leadSources.map((s, i) => html`<span><i style="background:${palette[i % 8]}"></i>${s.source} <b>${s.count}</b></span>`)}</div></div></div>
      </div>
      <div class="grid g2 mt">
        <div class="card"><div class="hd"><h2>Pipeline by stage</h2><span class="grow"></span><a href="#/deals">Open board →</a></div><div class="bd">${d.pipeline.map((s) => html`<div class="hbar"><span>${s.label}</span><div class="t"><i style="width:${(s.amount / maxStage) * 100}%;${s.key === 'lost' ? 'background:var(--bad)' : s.key === 'won' ? 'background:var(--ok)' : ''}"></i></div><span class="right small">${s.count} · ${money(s.amount, true)}</span></div>`)}</div></div>
        <div class="card"><div class="hd"><h2>Recent campaigns</h2><span class="grow"></span><a href="#/campaigns">All campaigns →</a></div>
          ${d.campaigns.length ? html`<div class="tablewrap"><table><tbody>${d.campaigns.map((c) => html`<tr><td><a href="#/campaigns/${c.id}">${c.name}</a><div class="small muted">${c.sent} sent</div></td><td class="right">${pct(c.sent ? c.opened / c.sent : 0, 0)}<div class="small muted">opened</div></td><td class="right">${pct(c.sent ? c.clicked / c.sent : 0, 0)}<div class="small muted">clicked</div></td></tr>`)}</tbody></table></div>` : html`<div class="empty">No campaigns sent yet.</div>`}</div>
      </div>
      <div class="grid g3 mt">
        <div class="card"><div class="hd"><h2>Top open deals</h2></div><div class="bd">${d.topDeals.map((x) => html`<div style="display:flex;justify-content:space-between;gap:8px;padding:6px 0"><span><a href="#/deals/${x.id}">${x.name}</a></span><b>${money(x.amount, true)}</b></div>`)}</div></div>
        <div class="card"><div class="hd"><h2>Tasks due</h2><span class="grow"></span><a href="#/tasks">All →</a></div><div class="bd">${d.tasksDue.length ? d.tasksDue.map((t) => html`<div style="padding:6px 0">${t.title}<div class="small ${t.due_date < todayStr() ? '' : 'muted'}" style="${t.due_date < todayStr() ? 'color:var(--bad)' : ''}">${t.due_date ? fmtDate(t.due_date) : 'No date'} ${badge(t.priority)}</div></div>`) : html`<span class="muted">All caught up 🎉</span>`}</div></div>
        <div class="card"><div class="hd"><h2>Leaderboard</h2></div><div class="bd">${d.leaderboard.length ? d.leaderboard.map((l, i) => html`<div style="display:flex;gap:10px;align-items:center;padding:6px 0"><span class="avatar">${initials(l.name)}</span><span class="grow">${l.name}<div class="small muted">${l.deals} won</div></span><b>${money(l.value, true)}</b></div>`) : html`<span class="muted">No won deals yet.</span>`}</div></div>
      </div>
      <div class="card mt"><div class="hd"><h2>Recent activity</h2></div><div class="bd">${d.recentActivity.length ? html`<ul class="timeline">${d.recentActivity.map((a) => html`<li><b>${a.user_name || 'Someone'}</b> logged a ${a.type} ${a.contact_id ? html`on <a href="#/contacts/${a.contact_id}">a contact</a>` : ''}<div>${a.body}</div><div class="small muted">${ago(a.created_at)}</div></li>`)}</ul>` : html`<span class="muted">No activity yet.</span>`}</div></div>`);
    $('#scope', root)?.addEventListener('change', (e) => { scope = e.target.value; sessionStorage.setItem('dashScope', scope); draw().catch(fail); });
  };
  await draw();
}

// =============== Contacts ===============
function contactForm(c = {}, lk, onDone) {
  const fields = [
    { name: 'first_name', label: 'First name', required: true }, { name: 'last_name', label: 'Last name' },
    { name: 'email', label: 'Email', type: 'email' }, { name: 'phone', label: 'Phone' },
    { name: 'title', label: 'Job title' }, { name: 'account_id', label: 'Company', type: 'select', options: lk.accounts },
    { name: 'status', label: 'Status', type: 'select', options: STATUS, blank: false, default: 'lead' }, { name: 'source', label: 'Source', placeholder: 'Website, Referral…' },
    { name: 'owner_id', label: 'Owner', type: 'select', options: userOpts(), blank: false, default: store.user.id }, { name: 'tags', label: 'Tags (comma separated)' },
  ];
  const f = (n) => field(fields.find((x) => x.name === n), c);
  modal({ title: c.id ? 'Edit contact' : 'New contact', wide: true,
    body: html`<div class="row">${f('first_name')}${f('last_name')}</div><div class="row">${f('email')}${f('phone')}</div><div class="row">${f('title')}${f('account_id')}</div><div class="row">${f('status')}${f('source')}</div><div class="row">${f('owner_id')}${f('tags')}</div>${field({ name: 'subscribed', label: 'Subscribed to marketing email', type: 'checkbox' }, { subscribed: c.id ? c.subscribed : 1 })}`,
    onSubmit: async (form) => {
      const v = formValues(form, [...fields, { name: 'subscribed', type: 'checkbox' }]);
      const saved = c.id ? await api('PUT', `/contacts/${c.id}`, v) : await api('POST', '/contacts', v);
      toast(c.id ? 'Contact updated' : 'Contact created', 'ok'); onDone?.(saved);
    } });
}

function importModal(done) {
  let rows = [];
  modal({ title: 'Import contacts from CSV', submitLabel: 'Import', wide: true,
    body: html`<p class="muted">Columns recognised: first_name, last_name, email, phone, title, company, status, source, tags. Existing contacts are matched by email and updated; new companies are created automatically (max 5,000 rows).</p>
      <input type="file" accept=".csv,text/csv" id="csvfile"><div id="csvinfo" class="small muted mt"></div>`,
    onOpen: (form) => {
      $('#csvfile', form).addEventListener('change', async (e) => {
        try { rows = csvToContacts(await e.target.files[0].text()); setHtml($('#csvinfo', form), html`<b>${rows.length}</b> rows ready. Preview: ${rows.slice(0, 3).map((r) => `${r.first_name} ${r.last_name} <${r.email}>`).join(' · ')}`); }
        catch (x) { rows = []; setHtml($('#csvinfo', form), html`<span style="color:var(--bad)">${x.message}</span>`); }
      });
    },
    onSubmit: async () => {
      if (!rows.length) throw new Error('Choose a CSV file with at least one data row');
      const r = await api('POST', '/contacts/import', { rows });
      toast(`Imported: ${r.created} new, ${r.updated} updated, ${r.skipped} skipped`, 'ok');
      if (r.errors.length) alert('Some rows were skipped:\n' + r.errors.join('\n'));
      done();
    } });
}

export async function contacts(root) {
  root.innerHTML = '';
  const head = document.createElement('div'); const body = document.createElement('div'); root.append(head, body);
  setHtml(head, page('Contacts', html`<button class="btn" data-act="import">Import CSV</button><a class="btn" href="/api/contacts/export.csv" download>Export CSV</a><button class="btn primary" data-act="new">+ New contact</button>`));
  let list;
  list = mountList(body, {
    key: 'contacts', endpoint: '/contacts', selectable: true, searchPlaceholder: 'Search name, email, company…', empty: 'No contacts match. Add one or import a CSV.',
    filters: [{ name: 'status', label: 'Status', options: STATUS }, { name: 'source', label: 'Source', options: store.meta.sources }, { name: 'owner_id', label: 'Owner', options: userOpts() }],
    columns: [
      { label: 'Name', sort: 'name', render: (c) => html`<a href="#/contacts/${c.id}"><b>${fullName(c)}</b></a><div class="small muted">${c.title || ''}</div>` },
      { label: 'Company', sort: 'account', render: (c) => (c.account_id ? html`<a href="#/accounts/${c.account_id}">${c.account_name}</a>` : '—') },
      { label: 'Email', sort: 'email', render: (c) => html`${c.email || '—'}${c.subscribed ? '' : html` <span class="badge failed" title="Unsubscribed from marketing email">unsub</span>`}` },
      { label: 'Status', sort: 'status', render: (c) => badge(c.status) }, { label: 'Source', render: (c) => c.source || '—' },
      { label: 'Owner', render: (c) => c.owner_name || '—' }, { label: 'Added', sort: 'created_at', render: (c) => fmtDate(c.created_at) },
    ],
    bulk: [{ key: 'status', label: 'Set status' }, { key: 'tag', label: 'Add tag' }, { key: 'owner', label: 'Assign owner' }, ...(can('admin', 'manager') ? [{ key: 'delete', label: 'Delete', danger: true }] : [])],
    onBulk: async (action, ids, done) => {
      const run = async (value) => { await api('POST', '/contacts/bulk', { action, ids, value }); toast(`Updated ${ids.length} contacts`, 'ok'); done(); };
      if (action === 'delete') { if (await confirmBox(`Delete ${ids.length} contacts permanently?`, 'Delete')) await run(); return; }
      const cfg = { status: { name: 'value', label: 'New status', type: 'select', options: STATUS, blank: false }, tag: { name: 'value', label: 'Tag', required: true }, owner: { name: 'value', label: 'Owner', type: 'select', options: userOpts(), blank: false } }[action];
      modal({ title: `Bulk update ${ids.length} contacts`, body: field(cfg), onSubmit: async (f) => run(formValues(f, [cfg]).value) });
    },
  });
  on(head, {
    new: async () => contactForm({}, await lookups(), (c) => { location.hash = `#/contacts/${c.id}`; }),
    import: () => importModal(() => list.reload()),
  });
  // export honours the current search/filters
  head.querySelector('a[download]').addEventListener('click', (e) => {
    const q = body.querySelector('.search').value.trim(); const f = {}; $$('[data-filter]', body).forEach((s) => { if (s.value) f[s.dataset.filter] = s.value; });
    e.currentTarget.href = '/api/contacts/export.csv' + qs({ q, ...f });
  });
}

// ---- timeline widget shared by contact/deal/account pages ----
function timelineCard(activities, linkKey, linkId, reload) {
  const types = { note: '📝', call: '📞', email: '✉️', meeting: '📅' };
  return html`<div class="card"><div class="hd"><h2>Activity</h2></div><div class="bd">
    <form data-form="activity"><div style="display:flex;gap:8px;flex-wrap:wrap"><select name="type" aria-label="Type">${Object.keys(types).map((t) => html`<option value="${t}">${t}</option>`)}</select><input name="body" class="grow" placeholder="Log a note, call, email or meeting…" required maxlength="2000" style="min-width:200px"><button class="btn primary">Log</button></div></form>
    ${activities.length ? html`<ul class="timeline mt">${activities.map((a) => html`<li>${types[a.type]} <b>${a.type}</b> <span class="muted small">· ${a.user_name || ''} · ${ago(a.created_at)}</span><div>${a.body}</div></li>`)}</ul>` : html`<div class="empty">No activity yet.</div>`}</div></div>`;
}
function wireTimeline(root, linkKey, linkId, reload) {
  $('[data-form=activity]', root)?.addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.currentTarget;
    try { await api('POST', '/activities', { type: f.type.value, body: f.body.value, [linkKey]: linkId }); reload(); } catch (x) { fail(x); }
  });
}
const miniTasks = (tasks) => html`<div class="card"><div class="hd"><h2>Tasks</h2></div><div class="bd">${tasks.length ? tasks.map((t) => html`<div style="display:flex;gap:8px;padding:5px 0"><input type="checkbox" data-act="toggletask" data-id="${t.id}" ${t.done ? raw('checked') : ''} aria-label="Done"><span style="${t.done ? 'text-decoration:line-through;opacity:.6' : ''}">${t.title}<div class="small muted">${t.due_date ? fmtDate(t.due_date) : ''}</div></span></div>`) : html`<span class="muted">No tasks.</span>`}</div></div>`;

export async function contactDetail(root, id) {
  const draw = async () => {
    const d = await api('GET', `/contacts/${id}/360`); const c = d.contact;
    setHtml(root, html`<div class="topbar"><a href="#/contacts">← Contacts</a><span class="grow"></span><button class="btn" data-act="task">+ Task</button><button class="btn" data-act="edit">Edit</button>${can('admin', 'manager') ? html`<button class="btn danger" data-act="del">Delete</button>` : ''}</div>
      <div class="grid g21"><div style="display:grid;gap:16px;align-content:start">
        <div class="card"><div class="bd" style="display:flex;gap:16px;align-items:center"><span class="avatar" style="width:56px;height:56px;font-size:18px">${initials(fullName(c))}</span><div class="grow"><h1>${fullName(c)}</h1><div class="muted">${c.title || ''} ${c.account_id ? html`at <a href="#/accounts/${c.account_id}">${c.account_name}</a>` : ''}</div></div>${badge(c.status)}</div></div>
        ${timelineCard(d.activities, 'contact_id', id)}
        <div class="card"><div class="hd"><h2>Campaign history</h2></div>${d.campaigns.length ? html`<div class="tablewrap"><table><tbody>${d.campaigns.map((m) => html`<tr><td><a href="#/campaigns/${m.id}">${m.name}</a></td><td>${badge(m.status)}</td><td class="small muted">${m.first_open_at ? 'Opened ' + ago(m.first_open_at) : 'Not opened'}${m.first_click_at ? ' · clicked' : ''}${m.unsubscribed_at ? ' · unsubscribed' : ''}</td></tr>`)}</tbody></table></div>` : html`<div class="empty">Not part of any campaign yet.</div>`}</div>
      </div><div style="display:grid;gap:16px;align-content:start">
        <div class="card"><div class="hd"><h2>Details</h2></div><div class="bd" style="display:grid;gap:8px">
          <div><span class="muted small">Email</span><br>${c.email ? html`<a href="mailto:${c.email}">${c.email}</a>` : '—'} ${c.subscribed ? '' : badge('unsubscribed')}</div>
          <div><span class="muted small">Phone</span><br>${c.phone || '—'}</div><div><span class="muted small">Source</span><br>${c.source || '—'}</div>
          <div><span class="muted small">Owner</span><br>${c.owner_name || '—'}</div><div><span class="muted small">Tags</span><br>${c.tags ? c.tags.split(',').map((t) => html`<span class="badge">${t.trim()}</span> `) : '—'}</div>
          <div><span class="muted small">Added</span><br>${fmtDate(c.created_at)}</div></div></div>
        <div class="card"><div class="hd"><h2>Deals</h2><span class="grow"></span><button class="btn sm" data-act="deal">+ Deal</button></div><div class="bd">${d.deals.length ? d.deals.map((x) => html`<div style="display:flex;justify-content:space-between;padding:5px 0"><a href="#/deals/${x.id}">${x.name}</a><span>${money(x.amount, true)} ${badge(x.stage)}</span></div>`) : html`<span class="muted">No deals.</span>`}</div></div>
        ${miniTasks(d.tasks)}</div></div>`);
    wireTimeline(root, 'contact_id', id, draw);
    on(root, {
      edit: async () => contactForm(c, await lookups(), draw),
      del: async () => { if (await confirmBox(`Delete ${fullName(c)}? This also removes their activity history.`, 'Delete')) { await api('DELETE', `/contacts/${id}`); toast('Contact deleted'); location.hash = '#/contacts'; } },
      task: () => taskForm({ contact_id: id }, draw), deal: async () => dealForm({ contact_id: id, account_id: c.account_id }, await lookups(), draw),
      toggletask: async (el) => { await api('POST', `/tasks/${el.dataset.id}/toggle`); draw(); },
    });
  };
  await draw();
}

// =============== Accounts ===============
function accountForm(a = {}, onDone) {
  const fields = [{ name: 'name', label: 'Company name', required: true }, { name: 'industry', label: 'Industry' }, { name: 'website', label: 'Website', type: 'url', placeholder: 'https://' }, { name: 'size', label: 'Company size', type: 'select', options: ['1-50', '51-200', '201-1000', '1000+'] },
    { name: 'city', label: 'City' }, { name: 'country', label: 'Country' }, { name: 'phone', label: 'Phone' }, { name: 'owner_id', label: 'Owner', type: 'select', options: userOpts(), blank: false, default: store.user.id }, { name: 'notes', label: 'Notes', type: 'textarea' }];
  const f = (n) => field(fields.find((x) => x.name === n), a);
  modal({ title: a.id ? 'Edit account' : 'New account', wide: true,
    body: html`<div class="row">${f('name')}${f('industry')}</div><div class="row">${f('website')}${f('size')}</div><div class="row">${f('city')}${f('country')}</div><div class="row">${f('phone')}${f('owner_id')}</div>${f('notes')}`,
    onSubmit: async (form) => { const v = formValues(form, fields); const s = a.id ? await api('PUT', `/accounts/${a.id}`, v) : await api('POST', '/accounts', v); toast('Account saved', 'ok'); onDone?.(s); } });
}
export async function accounts(root) {
  root.innerHTML = ''; const head = document.createElement('div'), body = document.createElement('div'); root.append(head, body);
  setHtml(head, page('Accounts', html`<button class="btn primary" data-act="new">+ New account</button>`));
  const list = mountList(body, {
    key: 'accounts', endpoint: '/accounts', searchPlaceholder: 'Search accounts…', empty: 'No accounts yet.',
    filters: [{ name: 'industry', label: 'Industry', options: store.meta.industries }, { name: 'owner_id', label: 'Owner', options: userOpts() }],
    columns: [
      { label: 'Account', sort: 'name', render: (a) => html`<a href="#/accounts/${a.id}"><b>${a.name}</b></a><div class="small muted">${[a.city, a.country].filter(Boolean).join(', ')}</div>` },
      { label: 'Industry', sort: 'industry', render: (a) => a.industry || '—' }, { label: 'Size', render: (a) => a.size || '—' },
      { label: 'Contacts', sort: 'contact_count', render: (a) => a.contact_count }, { label: 'Won value', sort: 'won_value', render: (a) => money(a.won_value) }, { label: 'Owner', render: (a) => a.owner_name || '—' },
    ],
  });
  on(head, { new: () => accountForm({}, (a) => { location.hash = `#/accounts/${a.id}`; }) });
}
export async function accountDetail(root, id) {
  const draw = async () => {
    const d = await api('GET', `/accounts/${id}/360`); const a = d.account;
    setHtml(root, html`<div class="topbar"><a href="#/accounts">← Accounts</a><span class="grow"></span><button class="btn" data-act="edit">Edit</button>${can('admin', 'manager') ? html`<button class="btn danger" data-act="del">Delete</button>` : ''}</div>
      <div class="grid g21"><div style="display:grid;gap:16px;align-content:start">
        <div class="card"><div class="bd"><h1>${a.name}</h1><div class="muted">${[a.industry, a.size && a.size + ' employees', [a.city, a.country].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}</div>
          ${a.website ? html`<div><a href="${/^https?:\/\//.test(a.website) ? a.website : '#'}" target="_blank" rel="noopener noreferrer">${a.website}</a></div>` : ''}${a.notes ? html`<p>${a.notes}</p>` : ''}</div></div>
        ${timelineCard(d.activities, 'account_id', id)}</div>
        <div style="display:grid;gap:16px;align-content:start">
          <div class="card"><div class="hd"><h2>Contacts (${d.contacts.length})</h2></div><div class="bd">${d.contacts.length ? d.contacts.map((c) => html`<div style="padding:5px 0"><a href="#/contacts/${c.id}">${fullName(c)}</a> ${badge(c.status)}<div class="small muted">${c.title || ''}</div></div>`) : html`<span class="muted">No contacts.</span>`}</div></div>
          <div class="card"><div class="hd"><h2>Deals (${d.deals.length})</h2></div><div class="bd">${d.deals.length ? d.deals.map((x) => html`<div style="display:flex;justify-content:space-between;padding:5px 0"><a href="#/deals/${x.id}">${x.name}</a><span>${money(x.amount, true)} ${badge(x.stage)}</span></div>`) : html`<span class="muted">No deals.</span>`}</div></div>
        </div></div>`);
    wireTimeline(root, 'account_id', id, draw);
    on(root, {
      edit: () => accountForm(a, draw),
      del: async () => { if (await confirmBox(`Delete ${a.name}? Contacts and deals stay but lose their company link.`, 'Delete')) { await api('DELETE', `/accounts/${id}`); location.hash = '#/accounts'; } },
    });
  };
  await draw();
}

// =============== Deals ===============
function dealForm(d = {}, lk, onDone) {
  const stages = store.meta.stages.map((s) => [s.key, s.label]);
  const fields = [{ name: 'name', label: 'Deal name', required: true }, { name: 'amount', label: 'Amount (USD)', type: 'number', min: 0, step: '0.01', default: 0 },
    { name: 'stage', label: 'Stage', type: 'select', options: stages, blank: false, default: 'prospecting' }, { name: 'probability', label: 'Probability %', type: 'number', min: 0, max: 100 },
    { name: 'close_date', label: 'Expected close', type: 'date' }, { name: 'owner_id', label: 'Owner', type: 'select', options: userOpts(), blank: false, default: store.user.id },
    { name: 'account_id', label: 'Account', type: 'select', options: lk.accounts }, { name: 'contact_id', label: 'Contact', type: 'select', options: lk.contacts }];
  const f = (n) => field(fields.find((x) => x.name === n), d);
  modal({ title: d.id ? 'Edit deal' : 'New deal', wide: true,
    body: html`${f('name')}<div class="row">${f('amount')}${f('stage')}</div><div class="row">${f('probability')}${f('close_date')}</div><div class="row">${f('account_id')}${f('contact_id')}</div>${f('owner_id')}<p class="small muted">Leave probability empty to use the stage default.</p>`,
    onSubmit: async (form) => { const v = formValues(form, fields); const s = d.id ? await api('PUT', `/deals/${d.id}`, v) : await api('POST', '/deals', v); toast('Deal saved', 'ok'); onDone?.(s); } });
}
export async function deals(root) {
  const view = sessionStorage.getItem('dealView') || 'board';
  root.innerHTML = ''; const head = document.createElement('div'), body = document.createElement('div'); root.append(head, body);
  setHtml(head, page('Deals', html`<div class="tabs" style="margin:0;border:0"><button class="${view === 'board' ? 'on' : ''}" data-act="view" data-v="board">Board</button><button class="${view === 'list' ? 'on' : ''}" data-act="view" data-v="list">List</button></div><button class="btn primary" data-act="new">+ New deal</button>`));
  let reload;
  on(head, {
    view: (el) => { sessionStorage.setItem('dealView', el.dataset.v); deals(root); },
    new: async () => dealForm({}, await lookups(), () => reload?.()),
  });
  if (view === 'list') {
    const l = mountList(body, { key: 'deals', endpoint: '/deals', searchPlaceholder: 'Search deals…', empty: 'No deals yet.',
      filters: [{ name: 'stage', label: 'Stage', options: store.meta.stages.map((s) => [s.key, s.label]) }, { name: 'owner_id', label: 'Owner', options: userOpts() }],
      columns: [{ label: 'Deal', sort: 'name', render: (d) => html`<a href="#/deals/${d.id}"><b>${d.name}</b></a>` }, { label: 'Account', render: (d) => d.account_name || '—' }, { label: 'Amount', sort: 'amount', render: (d) => money(d.amount) },
        { label: 'Stage', sort: 'stage', render: (d) => badge(d.stage) }, { label: 'Prob.', render: (d) => d.probability + '%' }, { label: 'Close', sort: 'close_date', render: (d) => fmtDate(d.close_date) }, { label: 'Owner', render: (d) => d.owner_name || '—' }] });
    reload = l.reload; return;
  }
  const drawBoard = async () => {
    const { rows } = await api('GET', '/deals?limit=1000&sort=amount&dir=desc');
    setHtml(body, html`<div class="kanban">${store.meta.stages.map((s) => {
      const items = rows.filter((d) => d.stage === s.key); const total = items.reduce((a, d) => a + d.amount, 0);
      return html`<div class="col" data-stage="${s.key}"><div class="ch"><b>${s.label}</b><span class="small muted">${items.length} · ${money(total, true)}</span></div><div class="cards">${items.map((d) => html`<div class="dcard" draggable="true" data-id="${d.id}"><b><a href="#/deals/${d.id}" draggable="false">${d.name}</a></b><span class="small muted">${d.account_name || ''}</span><div style="display:flex;justify-content:space-between;margin-top:6px"><b>${money(d.amount, true)}</b><span class="small muted">${d.owner_name?.split(' ')[0] || ''}</span></div>${d.close_date ? html`<div class="small muted">Close ${fmtDate(d.close_date)}</div>` : ''}</div>`)}</div></div>`;
    })}</div><p class="small muted">Drag a card to another column to change its stage.</p>`);
    let dragId = null;
    $$('.dcard', body).forEach((c) => { c.addEventListener('dragstart', (e) => { dragId = c.dataset.id; c.classList.add('dragging'); e.dataTransfer.setData('text/plain', dragId); e.dataTransfer.effectAllowed = 'move'; }); c.addEventListener('dragend', () => c.classList.remove('dragging')); });
    $$('.col', body).forEach((col) => {
      col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('over'); });
      col.addEventListener('dragleave', () => col.classList.remove('over'));
      col.addEventListener('drop', async (e) => { e.preventDefault(); col.classList.remove('over'); const id = dragId || e.dataTransfer.getData('text/plain'); if (!id) return;
        try { await api('POST', `/deals/${id}/stage`, { stage: col.dataset.stage }); await drawBoard(); } catch (x) { fail(x); } });
    });
  };
  reload = drawBoard; await drawBoard();
}
export async function dealDetail(root, id) {
  const draw = async () => {
    const d = await api('GET', `/deals/${id}/360`); const x = d.deal;
    setHtml(root, html`<div class="topbar"><a href="#/deals">← Deals</a><span class="grow"></span><button class="btn" data-act="task">+ Task</button><button class="btn" data-act="edit">Edit</button>${can('admin', 'manager') ? html`<button class="btn danger" data-act="del">Delete</button>` : ''}</div>
      <div class="grid g21"><div style="display:grid;gap:16px;align-content:start"><div class="card"><div class="bd"><h1>${x.name}</h1><div style="display:flex;gap:12px;align-items:center;margin-top:8px"><span class="stat-big">${money(x.amount)}</span>${badge(x.stage)}<span class="muted">${x.probability}% likely · weighted ${money(x.amount * x.probability / 100)}</span></div>
        <div class="funnel mt" aria-hidden="true">${store.meta.stages.slice(0, 5).map((s, i) => html`<i style="flex:1;background:${i <= store.meta.stages.findIndex((q) => q.key === x.stage) ? 'var(--brand)' : 'transparent'}"></i>`)}</div></div></div>
        ${timelineCard(d.activities, 'deal_id', id)}</div>
        <div style="display:grid;gap:16px;align-content:start"><div class="card"><div class="hd"><h2>Details</h2></div><div class="bd" style="display:grid;gap:8px">
          <div><span class="muted small">Account</span><br>${x.account_id ? html`<a href="#/accounts/${x.account_id}">${x.account_name}</a>` : '—'}</div>
          <div><span class="muted small">Contact</span><br>${x.contact_id ? html`<a href="#/contacts/${x.contact_id}">${x.contact_name}</a>` : '—'}</div>
          <div><span class="muted small">Expected close</span><br>${fmtDate(x.close_date)}</div><div><span class="muted small">Owner</span><br>${x.owner_name || '—'}</div></div></div>${miniTasks(d.tasks)}</div></div>`);
    wireTimeline(root, 'deal_id', id, draw);
    on(root, {
      edit: async () => dealForm(x, await lookups(), draw), task: () => taskForm({ deal_id: id }, draw),
      del: async () => { if (await confirmBox(`Delete deal "${x.name}"?`, 'Delete')) { await api('DELETE', `/deals/${id}`); location.hash = '#/deals'; } },
      toggletask: async (el) => { await api('POST', `/tasks/${el.dataset.id}/toggle`); draw(); },
    });
  };
  await draw();
}

// =============== Tasks ===============
async function taskForm(t = {}, onDone) {
  const lk = await lookups();
  const fields = [{ name: 'title', label: 'Task', required: true }, { name: 'due_date', label: 'Due date', type: 'date', default: todayStr() }, { name: 'priority', label: 'Priority', type: 'select', options: ['low', 'medium', 'high'], blank: false, default: 'medium' },
    { name: 'owner_id', label: 'Assignee', type: 'select', options: userOpts(), blank: false, default: store.user.id }, { name: 'contact_id', label: 'Contact', type: 'select', options: lk.contacts }, { name: 'deal_id', label: 'Deal', type: 'select', options: lk.deals }, { name: 'notes', label: 'Notes', type: 'textarea' }];
  const f = (n) => field(fields.find((x) => x.name === n), t);
  modal({ title: t.id ? 'Edit task' : 'New task', body: html`${f('title')}<div class="row">${f('due_date')}${f('priority')}</div>${f('owner_id')}<div class="row">${f('contact_id')}${f('deal_id')}</div>${f('notes')}`,
    onSubmit: async (form) => { const v = formValues(form, fields); t.id ? await api('PUT', `/tasks/${t.id}`, v) : await api('POST', '/tasks', v); toast('Task saved', 'ok'); onDone?.(); } });
}
export async function tasks(root) {
  root.innerHTML = ''; const head = document.createElement('div'), body = document.createElement('div'); root.append(head, body);
  setHtml(head, page('Tasks', html`<button class="btn primary" data-act="new">+ New task</button>`));
  const list = mountList(body, { key: 'tasks', endpoint: '/tasks', searchPlaceholder: 'Search tasks…', empty: 'No tasks. Enjoy the quiet!',
    filters: [{ name: 'done', label: 'State', options: [['0', 'Open'], ['1', 'Done']] }, { name: 'due', label: 'Due', options: [['overdue', 'Overdue'], ['today', 'Today'], ['week', 'Next 7 days']] }, { name: 'owner_id', label: 'Assignee', options: userOpts() }, { name: 'priority', label: 'Priority', options: ['low', 'medium', 'high'] }],
    columns: [
      { label: '', render: (t) => html`<input type="checkbox" data-act="toggle" data-id="${t.id}" ${t.done ? raw('checked') : ''} aria-label="Mark done">`, cls: 'nowrap' },
      { label: 'Task', sort: 'title', render: (t) => html`<span style="${t.done ? 'text-decoration:line-through;opacity:.6' : ''}">${t.title}</span>` },
      { label: 'Due', sort: 'due_date', render: (t) => html`<span style="${!t.done && t.due_date && t.due_date < todayStr() ? 'color:var(--bad);font-weight:600' : ''}">${fmtDate(t.due_date)}</span>` },
      { label: 'Priority', sort: 'priority', render: (t) => badge(t.priority) },
      { label: 'Related', render: (t) => t.contact_id ? html`<a href="#/contacts/${t.contact_id}">${t.contact_name}</a>` : t.deal_id ? html`<a href="#/deals/${t.deal_id}">${t.deal_name}</a>` : '—' },
      { label: 'Assignee', render: (t) => t.owner_name || '—' },
      { label: '', render: (t) => html`<button class="btn sm" data-act="edit" data-id="${t.id}">Edit</button> <button class="btn sm danger" data-act="del" data-id="${t.id}" aria-label="Delete">✕</button>` },
    ] });
  on(head, { new: () => taskForm({}, list.reload) });
  body.addEventListener('change', async (e) => { if (e.target.dataset.act === 'toggle') { try { await api('POST', `/tasks/${e.target.dataset.id}/toggle`); list.reload(); } catch (x) { fail(x); } } });
  on(body, {
    edit: async (el) => taskForm(await api('GET', `/tasks/${el.dataset.id}`), list.reload),
    del: async (el) => { if (await confirmBox('Delete this task?', 'Delete')) { await api('DELETE', `/tasks/${el.dataset.id}`); list.reload(); } },
  });
}
