import { api, html, raw, setHtml, store, toast, fail, on, $, modal, confirmBox, purgeModal, field, formValues, badge, fmtDate, fmtDateTime, todayStr, allow, fullName } from './core.js';
import { mountList } from './list.js';
import { attachments, uploadFiles } from './records.js';

const userOpts = () => store.meta.users.map((u) => [u.id, u.name]);
const page = (title, actions = '') => html`<div class="topbar"><h1>${title}</h1><span class="grow"></span>${actions}</div>`;
export const STATUS = { open: ['Open', 'qualification'], issue: ['Issue raised', 'lost'], done: ['Completed', 'won'] };
export const statusBadge = (s) => { const [l, c] = STATUS[s] || [s, '']; return html`<span class="badge ${c}" style="text-transform:none">${l}</span>`; };
const EVENT = { assigned: '📌 Assigned', reassigned: '🔁 Reassigned', issue: '⚠️ Issue raised', completed: '✅ Completed', reopened: '↩️ Reopened', comment: '💬 Reply', updated: '✏️ Updated', email_failed: '✉️ Email failed' };
/** Tell the user truthfully who was emailed, or why nobody was. */
export function mailToast(n, done = 'Saved') {
  if (!n) return toast(done, 'ok');
  if (n.simulated) return toast(`${done} — but NOT emailed: there is no real email sender (only the simulation one). Add or activate a real sender in Email senders.`, 'bad');
  toast(`${done} — emailing ${n.to.map((x) => x.replace(/ <.*/, '')).join(', ')} via ${n.via}`, 'ok');
}
const overdue = (t) => t.status !== 'done' && t.due_date && t.due_date < todayStr();

/** Create / edit a task. Assigning it to someone else emails them the task and its due date. */
export async function taskForm(t = {}, onDone) {
  const [c, d] = await Promise.all([api('GET', '/contacts?limit=1000&sort=name'), api('GET', '/deals?limit=1000&sort=name')]);
  const fields = [{ name: 'title', label: 'Task', required: true }, { name: 'due_date', label: 'Due date', type: 'date', default: todayStr() }, { name: 'priority', label: 'Priority', type: 'select', options: ['low', 'medium', 'high'], blank: false, default: 'medium' },
    { name: 'owner_id', label: 'Assign to', type: 'select', options: userOpts(), blank: false, default: store.user.id }, { name: 'contact_id', label: 'Related contact', type: 'select', options: c.rows.map((x) => [x.id, fullName(x)]) },
    { name: 'deal_id', label: 'Related deal', type: 'select', options: d.rows.map((x) => [x.id, x.name]) }, { name: 'notes', label: 'Details', type: 'textarea' }];
  const f = (n) => field(fields.find((x) => x.name === n), t);
  modal({ title: t.id ? 'Edit task' : 'New task',
    body: html`${f('title')}<div class="row">${f('due_date')}${f('priority')}</div>${f('owner_id')}
      <label data-assignnote>Message to the assignee (optional)<textarea name="assign_note" rows="2" placeholder="Anything they should know"></textarea></label>
      <p class="small muted" data-assignnote style="margin-top:-6px">They will get an email with the task and its due date.</p>
      <div class="row">${f('contact_id')}${f('deal_id')}</div>${f('notes')}`,
    onOpen: (form) => { const sync = () => form.querySelectorAll('[data-assignnote]').forEach((e) => { e.hidden = String(form.owner_id.value) === String(t.id ? t.owner_id : store.user.id); }); form.owner_id.addEventListener('change', sync); sync(); },
    onSubmit: async (form) => {
      const v = formValues(form, fields); v.assign_note = form.assign_note.value;
      const saved = t.id ? await api('PUT', `/tasks/${t.id}`, v) : await api('POST', '/tasks', v);
      mailToast(saved.email_notice, saved.owner_id !== store.user.id && (!t.id || t.owner_id !== saved.owner_id) ? `Task assigned to ${saved.owner_name}` : 'Task saved'); onDone?.(saved);
    } });
}

/** The task panel: details, timeline, files, and the actions the viewer may take. */
export async function openTask(id, onChange) {
  let a; try { a = await api('GET', `/tasks/${id}/activity`); } catch (e) { return fail(e); }
  const t = a.task; const others = userOpts();
  modal({ title: t.title, wide: true, hideFooter: true, body: html`
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">${statusBadge(t.status)} ${badge(t.priority)}
      <span class="small">Due <b style="${overdue(t) ? 'color:var(--bad)' : ''}">${t.due_date ? fmtDate(t.due_date) : 'no date'}${overdue(t) ? ' · overdue' : ''}</b></span>
      <span class="small muted">· assigned to <b>${t.owner_name || '—'}</b>${t.assigned_by_name ? html` by <b>${t.assigned_by_name}</b>` : ''}</span><span class="grow"></span>
      ${t.deal_id ? html`<a class="small" href="#/deals/${t.deal_id}" data-close>Deal: ${t.deal_name}</a>` : ''}${t.contact_id ? html`<a class="small" href="#/contacts/${t.contact_id}" data-close>Contact: ${t.contact_name}</a>` : ''}</div>
    ${t.notes ? html`<div style="white-space:pre-wrap;padding:10px 12px;background:var(--brand-l);border-radius:8px;margin-bottom:12px">${t.notes}</div>` : ''}
    ${a.can_work ? html`<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
      ${t.status !== 'done' ? html`<button type="button" class="btn primary" data-act="done">✅ Mark complete</button>` : html`<button type="button" class="btn" data-act="reopen">↩️ Reopen</button>`}
      ${t.status !== 'done' && a.is_assignee ? html`<button type="button" class="btn" data-act="issue">⚠️ Raise an issue</button>` : ''}
      <button type="button" class="btn" data-act="reply">💬 Reply</button>
      <button type="button" class="btn" data-act="reassign">🔁 ${t.status === 'issue' && a.is_assigner ? 'Resolve & send back / reassign' : 'Reassign'}</button></div>` : ''}
    <div id="tp-form"></div>
    <div class="grid g2"><div><h3 style="margin-top:0">Timeline</h3><ul class="timeline">${a.events.map((e) => html`<li><div><b>${EVENT[e.kind] || e.kind}</b> <span class="small muted">· ${e.actor_name || 'system'} · ${fmtDateTime(e.created_at)}</span></div>${e.body ? html`<div style="margin-top:4px;white-space:pre-wrap;${['issue', 'email_failed'].includes(e.kind) ? 'padding:6px 10px;background:#fee2e2;color:#7f1d1d;border-radius:8px' : ''}">${e.body}</div>` : ''}</li>`)}</ul>${a.events.length ? '' : html`<p class="muted small">No activity yet.</p>`}</div>
      <div id="tp-files"></div></div>`,
  onOpen: (form, close) => {
    const box = $('#tp-form', form); const refresh = () => { close(); onChange?.(); openTask(id, onChange); };
    attachments($('#tp-files', form), 'tasks', id).catch(() => {});
    const sub = (inner, label, submit) => {
      setHtml(box, html`<div class="card" style="margin-bottom:12px"><div class="bd">${inner}<div style="display:flex;gap:8px;margin-top:8px"><button type="button" class="btn primary" data-act="go">${label}</button><button type="button" class="btn" data-act="cancelsub">Cancel</button></div><div class="err" hidden></div></div></div>`);
      on(box, { cancelsub: () => setHtml(box, ''), go: async () => { const err = $('.err', box); try { await submit(); refresh(); } catch (e) { err.textContent = e.message; err.hidden = false; } } });
      box.querySelector('textarea,select')?.focus();
    };
    const filesInput = html`<label>Attach files (optional)<input type="file" name="tfiles" multiple></label>`;
    const sendFiles = async () => { const inp = box.querySelector('[name=tfiles]'); if (inp?.files?.length) await uploadFiles('tasks', id, inp.files); };
    on(form, {
      done: () => sub(html`<label>Completion note (optional)<textarea name="note" rows="2" placeholder="What was done"></textarea></label>${filesInput}`, 'Mark complete', async () => { const r = await api('POST', `/tasks/${id}/status`, { status: 'done', note: box.querySelector('[name=note]').value }); await sendFiles(); mailToast(r.mail, 'Completed'); }),
      issue: () => sub(html`<label>What is the problem?<span class="req">*</span><textarea name="note" rows="3" placeholder="e.g. Waiting for the customer's PO; the price list is out of date…"></textarea></label>${filesInput}`, 'Raise issue', async () => { const r = await api('POST', `/tasks/${id}/status`, { status: 'issue', note: box.querySelector('[name=note]').value }); await sendFiles(); mailToast(r.mail, 'Issue raised'); }),
      reopen: () => sub(html`<label>Why reopen? (optional)<textarea name="note" rows="2"></textarea></label>`, 'Reopen', async () => { const r = await api('POST', `/tasks/${id}/status`, { status: 'open', note: box.querySelector('[name=note]').value }); mailToast(r.mail, 'Reopened'); }),
      reply: () => sub(html`<label>Reply<textarea name="note" rows="3"></textarea></label>${filesInput}`, 'Send reply', async () => { const r = await api('POST', `/tasks/${id}/comment`, { body: box.querySelector('[name=note]').value }); await sendFiles(); mailToast(r.mail, 'Reply added'); }),
      reassign: () => sub(html`<div class="row"><label>Assign to<select name="owner">${others.map(([v, l]) => html`<option value="${v}" ${v === t.owner_id ? raw('selected') : ''}>${l}${v === t.owner_id ? ' (current)' : ''}</option>`)}</select></label><label>Due date<input type="date" name="due" value="${t.due_date || ''}"></label></div>
          <label>Note for them<textarea name="note" rows="2" placeholder="${t.status === 'issue' ? 'How the issue was resolved' : 'Why it is being reassigned'}"></textarea></label>${filesInput}<p class="small muted" style="margin-top:-4px">The task is reopened and they are emailed with the due date.</p>`,
        'Assign', async () => { const to = Number(box.querySelector('[name=owner]').value); await sendFiles(); const r = await api('POST', `/tasks/${id}/assign`, { owner_id: to, due_date: box.querySelector('[name=due]').value, note: box.querySelector('[name=note]').value }); mailToast(r.mail, `Assigned to ${others.find(([v]) => v === to)?.[1]}`); }),
    });
  } });
}

export async function tasks(root) {
  let tab = sessionStorage.getItem('taskTab') || 'to_me'; const seeAll = allow('tasks.view');
  root.innerHTML = ''; const head = document.createElement('div'), tabs = document.createElement('div'), body = document.createElement('div'); root.append(head, tabs, body);
  setHtml(head, page('Tasks', html`<button class="btn primary" data-act="new">+ New task</button>${allow('data.purge') ? html`<button class="btn danger" data-act="purge">Delete all…</button>` : ''}`));
  const drawTabs = async () => {
    const s = await api('GET', '/tasks-summary').catch(() => ({}));
    setHtml(tabs, html`${s.email && !s.email.real ? html`<div class="banner warn" style="margin-bottom:12px;padding:10px 14px;border-radius:10px;background:#fef3c7;color:#78350f">⚠️ <b>Task emails are not being delivered.</b> The only email sender is a simulation${s.email.via ? ` (${s.email.via})` : ''}. ${allow('senders.view') ? html`Add your Gmail / GoDaddy / Titan mailbox in <a href="#/senders">Email senders</a> and click Verify — task emails will then use it automatically.` : 'Ask an administrator to add a real email sender.'} <a href="#" data-act="testmail">Send me a test task email</a></div>` : ''}
    ${s.email?.real ? html`<div class="small muted" style="margin-bottom:10px">✉️ Task emails are sent from <b>${s.email.via}</b> · <a href="#" data-act="testmail">Send me a test task email</a></div>` : ''}
    <div class="tabs" role="tablist" style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap">
      ${[['to_me', `Assigned to me`, s.to_me_open, s.to_me_overdue ? `${s.to_me_overdue} overdue` : ''], ['by_me', 'Assigned by me', s.by_me_open, s.by_me_issues ? `${s.by_me_issues} issue${s.by_me_issues > 1 ? 's' : ''}` : ''], ...(seeAll ? [['all', 'All tasks']] : [])].map(([k, l, n, warn]) =>
        html`<button class="btn ${k === tab ? 'primary' : ''}" role="tab" aria-selected="${k === tab}" data-act="tab" data-t="${k}">${l}${n ? html` <span class="badge plain" style="margin-left:4px">${n}</span>` : ''}${warn ? html` <span class="badge lost plain">${warn}</span>` : ''}</button>`)}</div>`);
  };
  const list = mountList(body, { key: 'tasks', endpoint: '/tasks', searchPlaceholder: 'Search tasks…', empty: 'No tasks here.',
    extra: () => (tab === 'all' ? {} : { mine: tab }),
    filters: [{ name: 'status', label: 'Status', options: [['open', 'Open'], ['issue', 'Issue raised'], ['done', 'Completed']] }, { name: 'due', label: 'Due', options: [['overdue', 'Overdue'], ['today', 'Today'], ['week', 'Next 7 days']] }, { name: 'owner_id', label: 'Assigned to', options: userOpts() }, { name: 'priority', label: 'Priority', options: ['low', 'medium', 'high'] }],
    rowClass: (t) => (t.status === 'issue' ? 'row-issue' : ''),
    columns: [
      { label: '', render: (t) => html`<input type="checkbox" data-act="toggle" data-id="${t.id}" ${t.status === 'done' ? raw('checked') : ''} aria-label="Mark complete">`, cls: 'nowrap' },
      { label: 'Task', sort: 'title', render: (t) => html`<a href="#" data-act="open" data-id="${t.id}" style="${t.status === 'done' ? 'text-decoration:line-through;opacity:.6' : ''}"><b>${t.title}</b></a>${t.file_count ? html` <span class="small muted" title="${t.file_count} file(s)">📎${t.file_count}</span>` : ''}
          <div class="small muted">${t.contact_id ? html`<a href="#/contacts/${t.contact_id}">${t.contact_name}</a>` : ''}${t.contact_id && t.deal_id ? ' · ' : ''}${t.deal_id ? html`<a href="#/deals/${t.deal_id}">${t.deal_name}</a>` : ''}</div>` },
      { label: 'Due', sort: 'due_date', render: (t) => html`<span style="${overdue(t) ? 'color:var(--bad);font-weight:600' : ''}">${fmtDate(t.due_date)}</span>` },
      { label: 'Status', sort: 'status', render: (t) => statusBadge(t.status) },
      { label: 'Priority', sort: 'priority', render: (t) => badge(t.priority) },
      { label: 'Assigned to', render: (t) => t.owner_name || '—' }, { label: 'Assigned by', render: (t) => t.assigned_by_name || '—' },
      { label: '', render: (t) => html`<button class="btn sm" data-act="open" data-id="${t.id}">Open</button> <button class="btn sm" data-act="edit" data-id="${t.id}">Edit</button> <button class="btn sm danger" data-act="del" data-id="${t.id}" aria-label="Delete">✕</button>` },
    ] });
  const reload = () => { list.reload(); drawTabs(); };
  on(head, { new: () => taskForm({}, reload), purge: () => purgeModal('tasks', reload) });
  on(tabs, {
    tab: (el) => { tab = el.dataset.t; sessionStorage.setItem('taskTab', tab); reload(); },
    testmail: async (el) => {
      el.textContent = 'Sending…';
      try {
        const r = await api('POST', '/tasks/test-email');
        if (r.status === 'sent') toast(`Test email accepted by the mail server for ${r.to} (sent from ${r.via}). Check your inbox and spam folder.`, 'ok');
        else if (r.simulated) toast(`Not sent: only the simulation sender exists (${r.via}). Add a real sender in Email senders.`, 'bad');
        else toast(`Sending failed via ${r.via}: ${r.error}`, 'bad');
      } catch (x) { fail(x); }
      el.textContent = 'Send me a test task email';
    },
  });
  body.addEventListener('change', async (e) => { if (e.target.dataset.act === 'toggle') { try { await api('POST', `/tasks/${e.target.dataset.id}/toggle`); reload(); } catch (x) { fail(x); reload(); } } });
  on(body, {
    open: (el) => openTask(el.dataset.id, reload),
    edit: async (el) => taskForm(await api('GET', `/tasks/${el.dataset.id}`), reload),
    del: async (el) => { if (await confirmBox('Delete this task?', 'Delete')) { await api('DELETE', `/tasks/${el.dataset.id}`); reload(); } },
  });
  await drawTabs();
  const m = location.hash.match(/[?&]task=(\d+)/); if (m) { history.replaceState(null, '', '#/tasks'); openTask(m[1], reload); }
}
