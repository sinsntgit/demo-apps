import { GET, POST, bad, forbidden, notFound } from './http.js';
import { all, get, run, audit, nowIso } from './db.js';
import { config } from './config.js';
import { ENTITIES, getOne, update, hooks } from './entities.js';
import { hasPerm, scopeOf } from './permissions.js';
import { systemSender, sendLogged } from './mailer.js';
import { fileOut } from './files.js';
import { getSetting, setSetting } from './settings.js';

/*
 * Task assignment between team members:
 *   assign (or reassign) → the assignee is emailed with the due date
 *   the assignee marks it done, or raises an issue with a note and files → the person who assigned it is emailed
 *   the assigner answers (comment), reopens or reassigns → the assignee is emailed
 * Everything is kept on the task's timeline (task_events).
 */
export const STATUSES = ['open', 'done', 'issue'];
const STATUS_LABEL = { open: 'Open', done: 'Completed', issue: 'Issue raised' };
const TASKS = ENTITIES.tasks;
const userRow = (id) => get('SELECT id, name, email, active FROM users WHERE id=?', id);

function addEvent(taskId, kind, body, actor) {
  run('INSERT INTO task_events (task_id, kind, body, actor_type, actor_id, actor_name) VALUES (?,?,?,?,?,?)', taskId, kind, body ? String(body).slice(0, 5000) : null, 'user', actor?.id ?? null, actor?.name ?? null);
}

// ---------------------------------------------------------------- email
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nice = (d) => { if (!d) return 'no due date'; const x = new Date(`${String(d).slice(0, 10)}T00:00:00Z`); return isNaN(x) ? d : x.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); };
const taskLink = (t) => `${config.baseUrl}/#/tasks?task=${t.id}`;
function mailFor(t, { heading, intro, note, actor }) {
  const rows = [['Task', t.title], ['Due', nice(t.due_date)], ['Priority', t.priority], ['Status', STATUS_LABEL[t.status] || t.status], ['Assigned to', t.owner_name || '—'], ['Assigned by', t.assigned_by_name || '—'],
    t.deal_name && ['Deal', t.deal_name], t.contact_name && ['Contact', t.contact_name]].filter(Boolean);
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;color:#222"><h2 style="margin:0 0 8px">${esc(heading)}</h2><p>${esc(intro)}</p>
    ${note ? `<div style="border-left:4px solid #4f46e5;background:#f4f4fb;padding:10px 14px;margin:12px 0;white-space:pre-wrap">${esc(note)}</div>` : ''}
    <table style="border-collapse:collapse;margin:12px 0">${rows.map(([k, v]) => `<tr><td style="padding:4px 14px 4px 0;color:#666">${esc(k)}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>`).join('')}</table>
    ${t.notes ? `<p style="color:#444;white-space:pre-wrap"><span style="color:#666">Notes:</span> ${esc(t.notes)}</p>` : ''}
    <p><a href="${esc(taskLink(t))}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Open the task</a></p>
    <p style="color:#888;font-size:12px">Sent by Ovantaa CRM${actor ? ` on behalf of ${esc(actor.name)}` : ''}.</p></div>`;
  const text = `${heading}\n\n${intro}\n${note ? `\n"${note}"\n` : ''}\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}${t.notes ? `\nNotes: ${t.notes}` : ''}\n\nOpen the task: ${taskLink(t)}\n`;
  return { html, text };
}
/** Email people (user ids) other than the actor. Sending happens in the background; failures are logged in the email log. */
const copyMe = (uid) => getSetting(`task_copy_me:${uid}`, '0') === '1';
/**
 * Email the people involved (user ids) except the person who made the change — unless they asked for a copy of their own changes.
 * Always returns what happened, including why nobody was emailed, so the UI can say so.
 */
function mailUsers(ids, t, subject, content, actor) {
  const people = [...new Set(ids.filter(Boolean).map(Number))];
  const wanted = people.filter((id) => id !== actor?.id); if (actor && copyMe(actor.id)) wanted.push(actor.id);
  const rows = [...new Set(wanted)].map(userRow); const skipped = [];
  if (!people.some((id) => id !== actor?.id)) skipped.push('you are the only person on this task');
  for (const u of rows) if (u && (!u.active || !u.email)) skipped.push(`${u.name} has no active email address`);
  const to = rows.filter((u) => u?.active && u.email);
  const sender = systemSender(); const via = sender ? `${sender.label} (${sender.from_email})` : 'no sender'; const simulated = !sender || sender.mode !== 'smtp';
  if (!to.length) return { to: [], via, simulated, skipped };
  const msg = mailFor(t, { ...content, actor });
  for (const u of to) {
    sendLogged({ sender, to: u.email, subject, ...msg, kind: 'task', event: content.event })
      .then((r) => { if (r.status === 'failed') addEvent(t.id, 'email_failed', `Email to ${u.name} <${u.email}> failed: ${r.error}`, null); })
      .catch((e) => addEvent(t.id, 'email_failed', `Email to ${u.name} <${u.email}> failed: ${e.message}`, null));
  }
  return { to: to.map((u) => `${u.name} <${u.email}>`), via, simulated, skipped };
}
/** Merge several mailUsers() results into one notice for the UI. */
const notice = (...xs) => { const ok = xs.filter(Boolean); if (!ok.length) return null; const to = [...new Set(ok.flatMap((x) => x.to))]; return { to, via: ok[0].via, simulated: ok.some((x) => x.simulated) && to.length > 0, skipped: to.length ? [] : [...new Set(ok.flatMap((x) => x.skipped || []))] }; };
const others = (t) => [t.owner_id, t.assigned_by]; // mailUsers leaves out the person acting

// ---------------------------------------------------------------- assignment (hooked into the normal task create/update)
hooks.before.tasks = (data, body, existing, user) => {
  if ('done' in data && !('status' in body)) { data.status = data.done ? 'done' : (existing?.status === 'issue' ? 'issue' : 'open'); data.completed_at = data.done ? nowIso() : null; }
  const target = 'owner_id' in data ? data.owner_id : existing ? undefined : user.id;
  if (target === undefined || target === null) { if (!existing) { data.owner_id = user.id; data.assigned_by = user.id; data.assigned_at = nowIso(); } return; }
  const u = userRow(target); if (!u || !u.active) throw bad('Choose an active team member to assign the task to');
  if (existing && existing.owner_id === Number(target)) return;
  Object.assign(data, { owner_id: u.id, assigned_by: user.id, assigned_at: nowIso() });
  if (existing) Object.assign(data, { status: 'open', done: 0, completed_at: null }); // a reassigned task starts again
  body.__assigned = { from: existing?.owner_id ?? null };
};
const EDITABLE = { title: 'Title', due_date: 'Due date', priority: 'Priority', notes: 'Details', contact_id: 'Related contact', deal_id: 'Related deal' };
const show = (k, v, row) => (v == null || v === '' ? '—' : k === 'due_date' ? nice(v) : k === 'contact_id' ? (row?.contact_name || `#${v}`) : k === 'deal_id' ? (row?.deal_name || `#${v}`) : String(v).slice(0, 120));
hooks.after.tasks = (t, existing, body, user) => {
  if (body.__assigned) {
    const from = body.__assigned.from; const note = String(body.assign_note || '').trim();
    addEvent(t.id, existing ? 'reassigned' : 'assigned', `${existing ? `Reassigned from ${userRow(from)?.name || 'nobody'} to` : 'Assigned to'} ${t.owner_name}${note ? ` — ${note}` : ''}`, user);
    t.email_notice = notice(
      mailUsers([t.owner_id], t, `${existing ? 'Task reassigned to you' : 'New task for you'}: ${t.title} (due ${nice(t.due_date)})`, { heading: existing ? 'A task was reassigned to you' : 'You have a new task', intro: `${user.name} assigned you a task due ${nice(t.due_date)}.`, note, event: 'task.assigned' }, user),
      existing && from && from !== t.owner_id && mailUsers([from], t, `Task moved to ${t.owner_name}: ${t.title}`, { heading: 'A task was reassigned', intro: `${user.name} reassigned this task from you to ${t.owner_name}.`, note, event: 'task.reassigned' }, user));
    return;
  }
  if (!existing) return;
  const changes = Object.keys(EDITABLE).filter((k) => (existing[k] ?? null) !== (t[k] ?? null)).map((k) => `${EDITABLE[k]}: ${show(k, existing[k], existing)} → ${show(k, t[k], t)}`);
  if (!changes.length) return;
  addEvent(t.id, 'updated', changes.join('\n'), user);
  t.email_notice = notice(mailUsers(others(t), t, `Task updated: ${t.title}${changes.some((c) => c.startsWith('Due date')) ? ` (now due ${nice(t.due_date)})` : ''}`, { heading: 'A task was updated', intro: `${user.name} changed this task.`, note: changes.join('\n'), event: 'task.updated' }, user));
};
/** Deleting a task tells the other person involved. */
hooks.removed = hooks.removed || {};
hooks.removed.tasks = (t, user) => { mailUsers(others(t), { ...t, status: t.status }, `Task deleted: ${t.title}`, { heading: 'A task was deleted', intro: `${user.name} deleted this task.`, event: 'task.deleted' }, user); };

// ---------------------------------------------------------------- who may act
function loadTask(id, user) { return getOne(TASKS, id, user); } // respects own/all scope (own includes tasks you assigned)
const canWork = (t, user) => t.owner_id === user.id || t.assigned_by === user.id || scopeOf(user, 'tasks.edit') === 'all';

export function setStatus(t, status, note, user) {
  if (!STATUSES.includes(status)) throw bad('Unknown status');
  if (!canWork(t, user)) throw forbidden('Only the assignee, the person who assigned it, or someone who can edit all tasks can change this task.');
  note = String(note || '').trim();
  if (status === 'issue' && !note) throw bad('Describe the issue so the person who assigned the task can act on it');
  if (status === t.status && !note) return activity(t.id, user);
  run('UPDATE tasks SET status=?, done=?, completed_at=? WHERE id=?', status, status === 'done' ? 1 : 0, status === 'done' ? nowIso() : null, t.id);
  const kind = { done: 'completed', issue: 'issue', open: 'reopened' }[status];
  addEvent(t.id, kind, note, user); audit(user, `task_${kind}`, 'tasks', t.id, t.title);
  const fresh = getOne(TASKS, t.id);
  const subject = { done: `Task completed: ${t.title}`, issue: `Issue raised on task: ${t.title}`, open: `Task reopened: ${t.title}` }[status];
  const intro = { done: `${user.name} marked this task as completed.`, issue: `${user.name} raised an issue on this task. Reply on the task, reopen it, or reassign it.`, open: `${user.name} reopened this task (due ${nice(fresh.due_date)}).` }[status];
  const mail = mailUsers(others(fresh), fresh, subject, { heading: subject.split(':')[0], intro, note, event: `task.${kind}` }, user);
  return { ...activity(t.id, user), mail };
}

export function activity(id, user) {
  const t = loadTask(id, user);
  const events = all('SELECT id, kind, body, actor_name, created_at FROM task_events WHERE task_id=? ORDER BY id', t.id);
  const files = hasPerm(user, 'attachments.view') ? all("SELECT * FROM files WHERE entity='tasks' AND record_id=? ORDER BY id DESC", t.id).map(fileOut) : [];
  return { task: t, events, files, can_work: canWork(t, user), is_assignee: t.owner_id === user.id, is_assigner: t.assigned_by === user.id };
}

GET('/api/tasks/:id/activity', ({ params, user }) => activity(params.id, user));
POST('/api/tasks/:id/status', ({ params, body, user }) => setStatus(loadTask(params.id, user), body.status, body.note, user));
POST('/api/tasks/:id/comment', ({ params, body, user }) => {
  const t = loadTask(params.id, user); if (!canWork(t, user)) throw forbidden('Only the assignee or the person who assigned it can reply on this task.');
  const text = String(body.body || '').trim(); if (!text) throw bad('Write a reply first');
  addEvent(t.id, 'comment', text, user);
  const mail = mailUsers(others(t), t, `New reply on task: ${t.title}`, { heading: 'New reply on a task', intro: `${user.name} replied on this task.`, note: text, event: 'task.comment' }, user);
  return { ...activity(t.id, user), mail };
});
/** Reassign (to the same or another person), optionally with a new due date and a note. */
POST('/api/tasks/:id/assign', ({ params, body, user }) => {
  const t = loadTask(params.id, user); if (!canWork(t, user)) throw forbidden('Only the assignee, the person who assigned it, or someone who can edit all tasks can reassign it.');
  const to = Number(body.owner_id); if (!to) throw bad('Choose who should do the task');
  const patch = { owner_id: to, assign_note: body.note }; if (body.due_date !== undefined) patch.due_date = body.due_date || null;
  if (to === t.owner_id) { // same person again: reopen and remind them
    run('UPDATE tasks SET due_date=? WHERE id=?', patch.due_date ?? t.due_date, t.id);
    run("UPDATE tasks SET status='open', done=0, completed_at=NULL, assigned_by=?, assigned_at=? WHERE id=?", user.id, nowIso(), t.id);
    const fresh = getOne(TASKS, t.id); const note = String(body.note || '').trim();
    addEvent(t.id, 'reassigned', `Sent back to ${fresh.owner_name} (due ${nice(fresh.due_date)})${note ? ` — ${note}` : ''}`, user);
    const mail = mailUsers([fresh.owner_id], fresh, `Task sent back to you: ${fresh.title} (due ${nice(fresh.due_date)})`, { heading: 'A task was sent back to you', intro: `${user.name} has addressed the issue and sent the task back to you. It is due ${nice(fresh.due_date)}.`, note, event: 'task.assigned' }, user);
    return { ...activity(t.id, user), mail };
  }
  const saved = update(TASKS, t.id, patch, user);
  return { ...activity(t.id, user), mail: saved.email_notice || null };
});
/** Send yourself a sample task email now and report exactly what the mail server said. */
POST('/api/tasks/test-email', async ({ user }) => {
  const u = userRow(user.id); const sender = systemSender();
  if (!u?.email) throw bad('Your user account has no email address');
  const sample = { id: 0, title: 'Test task email', due_date: new Date().toISOString().slice(0, 10), priority: 'medium', status: 'open', owner_name: u.name, assigned_by_name: u.name };
  const msg = mailFor(sample, { heading: 'Test task email', intro: 'If you can read this, task emails from Ovantaa CRM reach you.', actor: user });
  const r = await sendLogged({ sender, to: u.email, subject: 'Ovantaa CRM — test task email', ...msg, kind: 'task', event: 'task.test' });
  return { to: u.email, via: sender ? `${sender.label} (${sender.from_email})` : 'no sender', simulated: !sender || sender.mode !== 'smtp', status: r.status, error: r.error };
});
/** Counts for the Tasks page tabs and the menu badge. */
/** Personal preference: also email me about changes I make myself. */
POST('/api/tasks/prefs', ({ user, body }) => { setSetting(`task_copy_me:${user.id}`, body.copy_me ? '1' : '0'); return { copy_me: !!body.copy_me }; });
GET('/api/tasks-summary', ({ user }) => ({
  copy_me: copyMe(user.id),
  email: (() => { const s = systemSender(); return { real: !!s && s.mode === 'smtp', via: s ? `${s.label} (${s.from_email})` : null }; })(),
  to_me_open: get("SELECT COUNT(*) n FROM tasks WHERE owner_id=? AND status<>'done'", user.id).n,
  to_me_overdue: get("SELECT COUNT(*) n FROM tasks WHERE owner_id=? AND status<>'done' AND due_date < date('now')", user.id).n,
  by_me_issues: get("SELECT COUNT(*) n FROM tasks WHERE assigned_by=? AND owner_id<>? AND status='issue'", user.id, user.id).n,
  by_me_open: get("SELECT COUNT(*) n FROM tasks WHERE assigned_by=? AND owner_id<>? AND status<>'done'", user.id, user.id).n,
}));
export { notFound };
