import {
  api, qs, html, raw, setHtml, esc, on, store, toast, fail, modal, confirmBox, purgeModal, field, formValues, badge, money, pct, num, fmtDate, fmtDateTime, ago, initials, fullName, todayStr, $, $$, debounce, allow, allowAll,
} from './core.js';
import { mountList } from './list.js';
import { openEntityForm, customDetailCard, customColumns, customFilters, customCardLines, displayValue, activeFields } from './forms.js';
import { readTable, FIELDS, guessMapping, applyMapping, TEMPLATE_CSV } from './csv.js';

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
const contactForm = (c = {}, lk, onDone) => openEntityForm('contacts', c, { lk, onDone, titles: { new: 'New contact', edit: 'Edit contact', noun: 'Contact' } });

function importModal(done) {
  let table = null; let map = {};
  const extra = activeFields('contacts').filter((f) => f.type !== 'lookup').map((f) => [`custom:${f.key}`, `${f.label} (custom)`, [f.label.toLowerCase()]]);
  const drawMap = (form) => {
    const headers = table[0].map((h, i) => [i, h || `Column ${i + 1}`]);
    const preview = applyMapping(table, map, extra).slice(0, 3);
    setHtml($('#imp_map', form), html`<div class="banner info small"><b>${table.length - 1}</b> rows found. Check how your columns map to contact fields (at least a first name or an email is needed).</div>
      <div class="mapgrid">${[...FIELDS, ...extra].map(([k, label]) => html`<span>${label}</span><select data-map="${k}"><option value="-1">— ignore —</option>${headers.map(([i, h]) => html`<option value="${i}" ${map[k] === i ? raw('selected') : ''}>${h}</option>`)}</select>`)}</div>
      <div class="small muted mt">Preview: ${preview.map((r) => [r.first_name, r.last_name, r.email].filter(Boolean).join(' ')).join(' · ') || '—'}</div>
      <div class="row mt">${field({ name: 'tag', label: 'Add this tag to every imported contact', placeholder: 'e.g. expo-2026' })}${field({ name: 'source', label: 'Default source (if blank in file)', placeholder: 'e.g. Trade show' })}</div>
      <div class="row">${field({ name: 'status', label: 'Default status (if blank in file)', type: 'select', options: STATUS, blank: '— keep "lead" —' })}<span></span></div>
      ${field({ name: 'update_existing', label: 'Update contacts that already exist (matched by email)', type: 'checkbox' }, { update_existing: true })}
      <p class="small muted">Only import people who have agreed to hear from you. Contacts marked "no" in a Subscribed column are imported as unsubscribed.</p>`);
  };
  modal({ title: 'Import contacts from a file', submitLabel: 'Import', wide: true,
    body: html`<div class="dropzone" id="imp_drop" tabindex="0" role="button">📄 <b>Drop a file here</b> or click to choose<div class="small">CSV, TSV, TXT or Excel (.xlsx) · up to 5,000 rows · max 8 MB</div><input type="file" id="csvfile" accept=".csv,.tsv,.txt,.xlsx,text/csv" hidden></div>
      <div class="small mt"><a href="#" id="imp_tpl">Download a sample template (CSV)</a> · Existing contacts are matched by email · New companies are created automatically.</div><div id="imp_file" class="small muted mt"></div><div id="imp_map" class="mt"></div>`,
    onOpen: (form) => {
      const input = $('#csvfile', form), drop = $('#imp_drop', form);
      const load = async (file) => {
        if (!file) return;
        try { table = await readTable(file); map = guessMapping(table[0], extra); setHtml($('#imp_file', form), html`📎 ${file.name}`); drawMap(form); }
        catch (x) { table = null; setHtml($('#imp_map', form), html`<div class="err">${x.message}</div>`); }
      };
      drop.addEventListener('click', () => input.click()); drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') input.click(); });
      input.addEventListener('change', () => load(input.files[0]));
      ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
      ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
      drop.addEventListener('drop', (e) => load(e.dataTransfer.files[0]));
      form.addEventListener('change', (e) => { if (e.target.dataset.map) { map[e.target.dataset.map] = Number(e.target.value); const keep = formValues(form, [{ name: 'tag' }, { name: 'source' }, { name: 'status' }]); drawMap(form); Object.entries(keep).forEach(([k, v]) => { form[k].value = v; }); } });
      $('#imp_tpl', form).addEventListener('click', (e) => { e.preventDefault(); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([TEMPLATE_CSV], { type: 'text/csv' })); a.download = 'ovantaa-contacts-template.csv'; a.click(); URL.revokeObjectURL(a.href); });
    },
    onSubmit: async (form) => {
      if (!table) throw new Error('Choose a file first');
      if (map.first_name < 0 && map.email < 0) throw new Error('Map at least a first name or an email column');
      const rows = applyMapping(table, map, extra); if (rows.length > 5000) throw new Error(`The file has ${rows.length} rows; the limit is 5,000 per import.`);
      const r = await api('POST', '/contacts/import', { rows, options: { tag: form.tag.value, source: form.source.value, status: form.status.value, update_existing: form.update_existing.checked } });
      toast(`Imported: ${r.created} new, ${r.updated} updated, ${r.skipped} skipped`, 'ok');
      if (r.errors.length) modal({ title: `${r.skipped} rows skipped`, hideFooter: true, body: html`<ul class="small">${r.errors.map((e) => html`<li>${e}</li>`)}</ul>${r.skipped > r.errors.length ? html`<p class="muted small">…and ${r.skipped - r.errors.length} more.</p>` : ''}` });
      done();
    } });
}

export async function contacts(root) {
  root.innerHTML = '';
  const head = document.createElement('div'); const body = document.createElement('div'); root.append(head, body);
  setHtml(head, page('Contacts', html`<button class="btn" data-act="import">Import CSV</button><a class="btn" href="/api/contacts/export.csv" download>Export CSV</a><button class="btn primary" data-act="new">+ New contact</button>${allow('data.purge') ? html`<button class="btn danger" data-act="purge">Delete all…</button>` : ''}`));
  let list;
  list = mountList(body, {
    key: 'contacts', endpoint: '/contacts', selectable: true, searchPlaceholder: 'Search name, email, company…', empty: 'No contacts match. Add one or import a CSV.',
    filters: [{ name: 'status', label: 'Status', options: STATUS }, { name: 'source', label: 'Source', options: store.meta.sources }, { name: 'owner_id', label: 'Owner', options: userOpts() }, ...customFilters('contacts')],
    columns: [
      { label: 'Name', sort: 'name', render: (c) => html`<a href="#/contacts/${c.id}"><b>${fullName(c)}</b></a><div class="small muted">${c.title || ''}</div>` },
      { label: 'Company', sort: 'account', render: (c) => (c.account_id ? html`<a href="#/accounts/${c.account_id}">${c.account_name}</a>` : '—') },
      { label: 'Email', sort: 'email', render: (c) => html`${c.email || '—'}${c.subscribed ? '' : html` <span class="badge failed" title="Unsubscribed from marketing email">unsub</span>`}` },
      { label: 'Status', sort: 'status', render: (c) => badge(c.status) }, { label: 'Source', render: (c) => c.source || '—' },
      { label: 'Owner', render: (c) => c.owner_name || '—' }, ...customColumns('contacts'), { label: 'Added', sort: 'created_at', render: (c) => fmtDate(c.created_at) },
    ],
    bulk: [{ key: 'status', label: 'Set status' }, { key: 'tag', label: 'Add tag' }, { key: 'owner', label: 'Assign owner' }, ...(allowAll('contacts.delete') ? [{ key: 'delete', label: 'Delete', danger: true }] : [])],
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
    purge: () => purgeModal('contacts', () => list.reload()),
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
    setHtml(root, html`<div class="topbar"><a href="#/contacts">← Contacts</a><span class="grow"></span><button class="btn" data-act="task">+ Task</button><button class="btn" data-act="edit">Edit</button>${allow('contacts.delete') ? html`<button class="btn danger" data-act="del">Delete</button>` : ''}</div>
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
        ${customDetailCard('contacts', c)}
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
async function accountForm(a = {}, onDone) { openEntityForm('accounts', a, { lk: await lookups(), onDone, titles: { new: 'New account', edit: 'Edit account', noun: 'Account' } }); }

export async function accounts(root) {
  root.innerHTML = ''; const head = document.createElement('div'), body = document.createElement('div'); root.append(head, body);
  setHtml(head, page('Accounts', html`<button class="btn primary" data-act="new">+ New account</button>${allow('data.purge') ? html`<button class="btn danger" data-act="purge">Delete all…</button>` : ''}`));
  const list = mountList(body, {
    key: 'accounts', endpoint: '/accounts', searchPlaceholder: 'Search accounts…', empty: 'No accounts yet.',
    filters: [{ name: 'industry', label: 'Industry', options: store.meta.industries }, { name: 'owner_id', label: 'Owner', options: userOpts() }, ...customFilters('accounts')],
    columns: [
      { label: 'Account', sort: 'name', render: (a) => html`<a href="#/accounts/${a.id}"><b>${a.name}</b></a><div class="small muted">${[a.city, a.country].filter(Boolean).join(', ')}</div>` },
      { label: 'Industry', sort: 'industry', render: (a) => a.industry || '—' }, { label: 'Size', render: (a) => a.size || '—' },
      { label: 'Contacts', sort: 'contact_count', render: (a) => a.contact_count }, { label: 'Won value', sort: 'won_value', render: (a) => money(a.won_value) }, { label: 'Owner', render: (a) => a.owner_name || '—' }, ...customColumns('accounts'),
    ],
  });
  on(head, { new: () => accountForm({}, (a) => { location.hash = `#/accounts/${a.id}`; }), purge: () => purgeModal('accounts', () => list.reload()) });
}
export async function accountDetail(root, id) {
  const draw = async () => {
    const d = await api('GET', `/accounts/${id}/360`); const a = d.account;
    setHtml(root, html`<div class="topbar"><a href="#/accounts">← Accounts</a><span class="grow"></span><button class="btn" data-act="edit">Edit</button>${allow('accounts.delete') ? html`<button class="btn danger" data-act="del">Delete</button>` : ''}</div>
      <div class="grid g21"><div style="display:grid;gap:16px;align-content:start">
        <div class="card"><div class="bd"><h1>${a.name}</h1><div class="muted">${[a.industry, a.size && a.size + ' employees', [a.city, a.country].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}</div>
          ${a.website ? html`<div><a href="${/^https?:\/\//.test(a.website) ? a.website : '#'}" target="_blank" rel="noopener noreferrer">${a.website}</a></div>` : ''}${a.notes ? html`<p>${a.notes}</p>` : ''}</div></div>
        ${timelineCard(d.activities, 'account_id', id)}</div>
        <div style="display:grid;gap:16px;align-content:start">
          ${customDetailCard('accounts', a)}
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
const stageLabel = (k) => store.meta.stages.find((s) => s.key === k)?.label || k;
const stageBadge = (k) => html`<span class="badge ${k}">${stageLabel(k)}</span>`;
const dayWord = (n) => (n < 1 ? 'under a day' : `${n} day${n === 1 ? '' : 's'}`);

/** The full journey of a deal, oldest first: stage → stage, when, who moved it, owner at the time, comment. */
export function historyView(history, deal) {
  if (!history.length) return html`<div class="empty">No stage movements recorded yet.</div>`;
  const first = history[0], last = history[history.length - 1];
  const ms = (t) => new Date(String(t).replace(' ', 'T') + 'Z').getTime();
  const closed = ['won', 'lost'].includes(last.to_stage);
  const span = Math.max(0, Math.round((((closed ? ms(last.changed_at) : Date.now()) - ms(first.changed_at)) / 86400000) * 10) / 10);
  const path = history.map((h) => h.to_stage).filter((st, i, a) => i === 0 || st !== a[i - 1]);
  return html`<div class="small muted" style="margin-bottom:10px">${closed ? `${stageLabel(last.to_stage)} after ${dayWord(span)}` : `Open for ${dayWord(span)}`} · ${history.length} stage ${history.length === 1 ? 'entry' : 'entries'}${deal ? html` · currently <b>${stageLabel(deal.stage)}</b>` : ''}</div>
    <div class="pill-row" style="margin-bottom:12px">${path.map((st, i) => html`${i ? html`<span class="muted">→</span>` : ''}${stageBadge(st)}`)}</div>
    <ul class="timeline">${history.map((h, i) => html`<li>
      <div>${h.from_stage ? html`${stageBadge(h.from_stage)} <span class="muted">→</span> ` : html`<span class="muted small">Started at</span> `}${stageBadge(h.to_stage)} ${i === history.length - 1 ? html`<span class="badge">current</span>` : ''}</div>
      <div class="small" style="margin-top:3px"><b>${fmtDateTime(h.changed_at)}</b> · moved by <b>${h.changed_by_name || 'unknown'}</b> · owner then: <b>${h.owner_name || '—'}</b> · value ${money(h.amount)}${h.days_in_previous != null ? html` · after <b>${dayWord(h.days_in_previous)}</b> in ${stageLabel(h.from_stage)}` : ''}</div>
      ${h.comment ? html`<div style="margin-top:4px;padding:6px 10px;background:var(--brand-l);border-radius:8px">💬 ${h.comment}</div>` : ''}</li>`)}</ul>`;
}
export async function historyModal(dealId, name) {
  const [h, d] = await Promise.all([api('GET', `/deals/${dealId}/history`), api('GET', `/deals/${dealId}`)]);
  modal({ title: `Stage history · ${name || d.name}`, wide: true, hideFooter: true, body: html`${historyView(h, d)}<p class="mt"><a href="#/deals/${dealId}" data-close>Open the full deal page →</a></p>` });
}
/** Move a deal to another stage, with an optional comment that is stored in its history. */
export function stageModal(deal, onDone, target) {
  const stages = store.meta.stages.map((s) => [s.key, s.label]);
  modal({ title: `Move deal · ${deal.name}`, submitLabel: 'Move deal',
    body: html`<p class="small muted">Currently <b>${stageLabel(deal.stage)}</b>. The move, your name, the deal owner and your comment are saved to the deal's history.</p>
      ${field({ name: 'stage', label: 'Move to stage', type: 'select', options: stages, blank: false }, { stage: target || deal.stage })}
      ${field({ name: 'comment', label: 'Comment (optional)', type: 'textarea', rows: 3, placeholder: 'Why is it moving? e.g. proposal accepted, waiting on legal, lost on price…' })}`,
    onSubmit: async (f) => {
      if (f.stage.value === deal.stage) throw new Error('Choose a different stage to move this deal.');
      await api('POST', `/deals/${deal.id}/stage`, { stage: f.stage.value, comment: f.comment.value }); toast(`Moved to ${stageLabel(f.stage.value)}`, 'ok'); onDone?.();
    } });
}

const dealForm = (d = {}, lk, onDone) => openEntityForm('deals', d, { lk, onDone, titles: { new: 'New deal', edit: 'Edit deal', noun: 'Deal' },
  extra: (rec) => html`<label>${rec.id ? 'Comment on the stage change (optional — saved only if you change the stage)' : 'Note for the deal history (optional)'}<textarea name="stage_comment" data-extra rows="2"></textarea></label><p class="small muted">Leave probability empty to use the stage default.</p>` });

export async function deals(root) {
  const view = sessionStorage.getItem('dealView') || 'board';
  root.innerHTML = ''; const head = document.createElement('div'), body = document.createElement('div'); root.append(head, body);
  setHtml(head, page('Deals', html`<div class="tabs" style="margin:0;border:0"><button class="${view === 'board' ? 'on' : ''}" data-act="view" data-v="board">Board</button><button class="${view === 'list' ? 'on' : ''}" data-act="view" data-v="list">List</button></div><button class="btn primary" data-act="new">+ New deal</button>${allow('data.purge') ? html`<button class="btn danger" data-act="purge">Delete all…</button>` : ''}`));
  let reload;
  on(head, {
    view: (el) => { sessionStorage.setItem('dealView', el.dataset.v); deals(root); },
    new: async () => dealForm({}, await lookups(), () => reload?.()),
    purge: () => purgeModal('deals', () => reload?.()),
  });
  if (view === 'list') {
    const l = mountList(body, { key: 'deals', endpoint: '/deals', searchPlaceholder: 'Search deals…', empty: 'No deals yet.',
      filters: [{ name: 'stage', label: 'Stage', options: store.meta.stages.map((s) => [s.key, s.label]) }, { name: 'owner_id', label: 'Owner', options: userOpts() }, ...customFilters('deals')],
      columns: [{ label: 'Deal', sort: 'name', render: (d) => html`<a href="#/deals/${d.id}"><b>${d.name}</b></a>` }, { label: 'Account', render: (d) => d.account_name || '—' }, { label: 'Amount', sort: 'amount', render: (d) => money(d.amount) },
        { label: 'Stage', sort: 'stage', render: (d) => badge(d.stage) }, { label: 'Prob.', render: (d) => d.probability + '%' }, { label: 'Close', sort: 'close_date', render: (d) => fmtDate(d.close_date) }, { label: 'Owner', render: (d) => d.owner_name || '—' }, ...customColumns('deals'),
        { label: 'History', render: (d) => html`<button class="btn sm" data-act="hist" data-id="${d.id}" data-name="${d.name}">🕘 History</button>` }] });
    on(body, { hist: (el) => historyModal(el.dataset.id, el.dataset.name) });
    reload = l.reload; return;
  }
  const drawBoard = async () => {
    const { rows } = await api('GET', '/deals?limit=1000&sort=amount&dir=desc');
    setHtml(body, html`<div class="kanban">${store.meta.stages.map((s) => {
      const items = rows.filter((d) => d.stage === s.key); const total = items.reduce((a, d) => a + d.amount, 0);
      return html`<div class="col" data-stage="${s.key}"><div class="ch"><b>${s.label}</b><span class="small muted">${items.length} · ${money(total, true)}</span></div><div class="cards">${items.map((d) => html`<div class="dcard" draggable="true" data-id="${d.id}"><b><a href="#/deals/${d.id}" draggable="false">${d.name}</a></b><span class="small muted">${d.account_name || ''}</span><div style="display:flex;justify-content:space-between;margin-top:6px"><b>${money(d.amount, true)}</b><span class="small muted">${d.owner_name?.split(' ')[0] || ''}</span></div>${customCardLines('deals', d).map((x) => html`<div class="small"><span class="muted">${x.d.label}:</span> ${x.v}</div>`)}<div style="margin-top:6px"><button class="btn sm" data-act="hist" data-id="${d.id}" data-name="${d.name}" draggable="false">🕘 History</button></div>${d.close_date ? html`<div class="small muted">Close ${fmtDate(d.close_date)}</div>` : ''}</div>`)}</div></div>`;
    })}</div><p class="small muted">Drag a card to another column (you can add a comment), or open 🕘 History to see how a deal has moved.</p>`);
    let dragId = null;
    $$('.dcard', body).forEach((c) => { c.addEventListener('dragstart', (e) => { dragId = c.dataset.id; c.classList.add('dragging'); e.dataTransfer.setData('text/plain', dragId); e.dataTransfer.effectAllowed = 'move'; }); c.addEventListener('dragend', () => c.classList.remove('dragging')); });
    $$('.col', body).forEach((col) => {
      col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('over'); });
      col.addEventListener('dragleave', () => col.classList.remove('over'));
      col.addEventListener('drop', async (e) => { e.preventDefault(); col.classList.remove('over'); const id = dragId || e.dataTransfer.getData('text/plain'); if (!id) return;
        const deal = rows.find((r) => String(r.id) === String(id)); if (!deal || deal.stage === col.dataset.stage) return;
        stageModal(deal, drawBoard, col.dataset.stage); });
    });
  };
  on(body, { hist: (el) => historyModal(el.dataset.id, el.dataset.name) });
  reload = drawBoard; await drawBoard();
}
export async function dealDetail(root, id) {
  const draw = async () => {
    const d = await api('GET', `/deals/${id}/360`); const x = d.deal;
    setHtml(root, html`<div class="topbar"><a href="#/deals">← Deals</a><span class="grow"></span><button class="btn primary" data-act="stage">Change stage</button><button class="btn" data-act="task">+ Task</button><button class="btn" data-act="edit">Edit</button>${allow('deals.delete') ? html`<button class="btn danger" data-act="del">Delete</button>` : ''}</div>
      <div class="grid g21"><div style="display:grid;gap:16px;align-content:start"><div class="card"><div class="bd"><h1>${x.name}</h1><div style="display:flex;gap:12px;align-items:center;margin-top:8px"><span class="stat-big">${money(x.amount)}</span>${badge(x.stage)}<span class="muted">${x.probability}% likely · weighted ${money(x.amount * x.probability / 100)}</span></div>
        <div class="funnel mt" aria-hidden="true">${store.meta.stages.slice(0, 5).map((s, i) => html`<i style="flex:1;background:${i <= store.meta.stages.findIndex((q) => q.key === x.stage) ? 'var(--brand)' : 'transparent'}"></i>`)}</div></div></div>
        <div class="card"><div class="hd"><h2>Stage history</h2></div><div class="bd">${historyView(d.history, x)}</div></div>
        ${timelineCard(d.activities, 'deal_id', id)}</div>
        <div style="display:grid;gap:16px;align-content:start"><div class="card"><div class="hd"><h2>Details</h2></div><div class="bd" style="display:grid;gap:8px">
          <div><span class="muted small">Account</span><br>${x.account_id ? html`<a href="#/accounts/${x.account_id}">${x.account_name}</a>` : '—'}</div>
          <div><span class="muted small">Contact</span><br>${x.contact_id ? html`<a href="#/contacts/${x.contact_id}">${x.contact_name}</a>` : '—'}</div>
          <div><span class="muted small">Expected close</span><br>${fmtDate(x.close_date)}</div><div><span class="muted small">Owner</span><br>${x.owner_name || '—'}</div></div></div>${customDetailCard('deals', x)}${miniTasks(d.tasks)}</div></div>`);
    wireTimeline(root, 'deal_id', id, draw);
    on(root, {
      edit: async () => dealForm(x, await lookups(), draw), stage: () => stageModal(x, draw), task: () => taskForm({ deal_id: id }, draw),
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
  setHtml(head, page('Tasks', html`<button class="btn primary" data-act="new">+ New task</button>${allow('data.purge') ? html`<button class="btn danger" data-act="purge">Delete all…</button>` : ''}`));
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
  on(head, { new: () => taskForm({}, list.reload), purge: () => purgeModal('tasks', () => list.reload()) });
  body.addEventListener('change', async (e) => { if (e.target.dataset.act === 'toggle') { try { await api('POST', `/tasks/${e.target.dataset.id}/toggle`); list.reload(); } catch (x) { fail(x); } } });
  on(body, {
    edit: async (el) => taskForm(await api('GET', `/tasks/${el.dataset.id}`), list.reload),
    del: async (el) => { if (await confirmBox('Delete this task?', 'Delete')) { await api('DELETE', `/tasks/${el.dataset.id}`); list.reload(); } },
  });
}
