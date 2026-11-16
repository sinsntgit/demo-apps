// Ask page: pick a data model + AI model, ask questions, browse saved conversations.
import { h, fill, api, busy, fail, select, state, ago, confirmDialog, toast, modal, field, fmtTime } from './core.js';
import { runCard } from './results.js';

const prefs = { get(k) { try { return localStorage.getItem('t2s-' + k); } catch { return null; } }, set(k, v) { try { localStorage.setItem('t2s-' + k, v); } catch { /* blocked */ } } };

export async function chatView(root, convId) {
  const [conns, models, convs] = await Promise.all([api('GET', '/api/connections'), api('GET', '/api/models'), api('GET', '/api/chat/conversations')]);
  const active = conns.filter(c => c.is_active);
  let conv = null;                                   // {id, title, connection_id}
  let connId = Number(prefs.get('conn')) || active[0]?.id;
  if (!active.some(c => c.id === connId)) connId = active[0]?.id;
  let modelId = Number(prefs.get('model')) || models[0]?.id;
  if (!models.some(m => m.id === modelId)) modelId = models[0]?.id;
  let review = prefs.get('review') === '1';
  let predictive = prefs.get('predictive') === '1';
  let sending = false;

  const list = h('div', { class: 'list' });
  const filter = h('input', { type: 'search', placeholder: 'Find a chat…', 'aria-label': 'Find a chat', oninput: () => drawList() });
  const inner = h('div', { class: 'thread-inner' });
  const thread = h('div', { class: 'thread' }, inner);
  const input = h('textarea', { placeholder: 'Ask a question about your data…', rows: 1 });
  const sendBtn = h('button', { class: 'btn primary', onclick: () => ask(input.value) }, 'Ask');
  const connSel = select(active.map(c => [c.id, `${c.name}  ·  ${c.db_label}`]), connId, v => { connId = Number(v); prefs.set('conn', v); if (conv && conv.connection_id !== connId) newChat(); else welcome(); });
  const modelSel = select(models.map(m => [m.id, m.name]), modelId, v => { modelId = Number(v); prefs.set('model', v); });
  const predictChk = h('input', { type: 'checkbox', checked: predictive, onchange: e => { predictive = e.target.checked; prefs.set('predictive', predictive ? '1' : '0'); } });
  const shareBtn = h('button', { class: 'btn sm hidden', style: 'margin-top:14px', title: 'Share this chat with people or user groups', onclick: () => conv && shareChat(conv) }, '👥 Share chat');
  const sharedNote = h('div', { class: 'hidden' });
  const reviewChk = h('input', { type: 'checkbox', checked: review, onchange: e => { review = e.target.checked; prefs.set('review', review ? '1' : '0'); } });

  function groupOf(iso) {
    const d = new Date(iso + (iso.endsWith('Z') ? '' : 'Z')), now = new Date();
    const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 86400000);
    if (diff <= 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return 'Earlier this week';
    return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }
  const dayLabel = iso => new Date(iso + (iso.endsWith('Z') ? '' : 'Z')).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

  function renameChat(c) {
    const input = h('input', { type: 'text', value: c.title, maxlength: 200 });
    const save = async close => {
      const title = input.value.trim();
      if (!title) return toast('Give the chat a name.', true);
      try { await api('PUT', `/api/chat/conversations/${c.id}`, { title }); c.title = title; if (conv?.id === c.id) conv.title = title; close(); drawList(); } catch (e) { fail(e); }
    };
    const close = modal('Rename chat', h('form', { onsubmit: e => { e.preventDefault(); save(close); } }, field('Name', input)), {
      actions: done => [h('button', { class: 'btn', onclick: done }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => save(done) }, 'Save')] });
    input.select();
  }

  async function shareChat(c) {
    const [people, current] = await Promise.all([api('GET', '/api/reports/people'), api('GET', `/api/chat/conversations/${c.id}/shares`)]).catch(e => { fail(e); return []; });
    if (!people) return;
    const key = s => s.scope === 'role' ? 'role:' + s.role : s.scope === 'group' ? 'group:' + s.group_id : 'user:' + s.user_id;
    const cur = new Map(current.map(s => [key(s), s.can_edit ? 'edit' : 'view']));
    const OPT = [['', 'No access'], ['view', 'Can view'], ['edit', 'Can view and add questions']];
    const row = (k, label, sub) => h('div', { class: 'item row' }, h('div', { style: 'flex:1' }, h('b', {}, label), sub ? h('div', { class: 'small dim' }, sub) : null),
      select(OPT, cur.get(k) || '', v => v ? cur.set(k, v) : cur.delete(k), { class: 'inline' }));
    const others = people.users.filter(u => !u.me);
    modal('Share chat “' + c.title + '”', h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, 'Chats are private until shared. People you share with see your questions and the SQL, and the results are run again with their own data access: if they cannot use this data model they see nothing, and their data filters apply. “Can view and add questions” lets them ask follow-up questions in this chat and rename it; only you can share or delete it.'),
      h('h3', {}, 'User groups'), people.groups.length ? h('div', { class: 'card flush' }, people.groups.map(g => row('group:' + g.id, g.name, `${g.members} member${g.members === 1 ? '' : 's'}${g.description ? ' · ' + g.description : ''}`)))
        : h('div', { class: 'small dim' }, 'No groups yet. An administrator creates them under Admin → User groups.'),
      h('h3', {}, 'By role'), h('div', { class: 'card flush' }, row('role:analyst', 'All analysts'), row('role:steward', 'All data stewards'), row('role:admin', 'All administrators')),
      h('h3', {}, 'Individual people'), others.length ? h('div', { class: 'card flush', style: 'max-height:34vh;overflow:auto' }, others.map(u => row('user:' + u.id, u.name, `${u.email} · ${u.role}`))) : h('div', { class: 'small dim' }, 'No other users yet.')), {
      wide: true, actions: close => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: e => busy(e.target, async () => {
        const shares = [...cur].map(([k, v]) => { const [scope, val] = k.split(':'); const can_edit = v === 'edit';
          return scope === 'role' ? { scope, role: val, can_edit } : scope === 'group' ? { scope, group_id: Number(val), can_edit } : { scope, user_id: Number(val), can_edit }; });
        const r = await api('PUT', `/api/chat/conversations/${c.id}/shares`, { shares });
        const item = convs.find(x => x.id === c.id); if (item) item.shared = r.count > 0;
        close(); drawList(); toast(r.count ? `Chat shared with ${r.count} ${r.count === 1 ? 'person or group' : 'people or groups'}` : 'Chat is private again');
      }) }, 'Save')] });
  }

  function convItem(c, sub) {
    return h('div', { class: 'conv' + (conv?.id === c.id ? ' on' : ''), onclick: () => open(c.id), title: c.title },
      h('div', { class: 't' }, h('b', {}, c.shared ? '👥 ' : '', c.title), h('span', { class: 'small dim' }, sub)),
      c.mine ? h('button', { class: 'btn ghost sm x', title: 'Share chat', 'aria-label': 'Share chat', onclick: e => { e.stopPropagation(); shareChat(c); } }, '👥') : null,
      c.can_edit ? h('button', { class: 'btn ghost sm x', title: 'Rename chat', 'aria-label': 'Rename chat', onclick: e => { e.stopPropagation(); renameChat(c); } }, '✎') : null,
      c.mine ? h('button', { class: 'btn ghost sm x', title: 'Delete chat', 'aria-label': 'Delete chat', onclick: async e => {
          e.stopPropagation();
          if (!await confirmDialog('Delete chat?', `“${c.title}” and its saved results will be removed from your history.`, 'Delete')) return;
          await api('DELETE', `/api/chat/conversations/${c.id}`).catch(fail);
          convs.splice(convs.indexOf(c), 1);
          if (conv?.id === c.id) newChat(); else drawList();
        } }, '🗑') : null);
  }

  function drawList() {
    const needle = filter.value.trim().toLowerCase();
    const shown = needle ? convs.filter(c => (c.title + ' ' + c.connection_name + ' ' + (c.mine ? '' : c.owner)).toLowerCase().includes(needle)) : convs;
    if (!shown.length) return fill(list, h('div', { class: 'empty small' }, convs.length ? 'No chats match.' : 'Your saved chats will appear here.'));
    const out = [];
    const theirs = shown.filter(c => !c.mine);
    if (theirs.length) {
      out.push(h('div', { class: 'conv-group' }, 'Shared with me'));
      theirs.forEach(c => out.push(convItem(c, `${c.owner} · ${c.can_edit ? 'can add questions' : 'view only'} · ${ago(c.updated_at)}`)));
    }
    let group = null;
    for (const c of shown.filter(c => c.mine)) {
      const g = groupOf(c.updated_at);
      if (g !== group) { group = g; out.push(h('div', { class: 'conv-group' }, g)); }
      out.push(convItem(c, `${c.connection_name} · ${['Today', 'Yesterday'].includes(g) ? ago(c.updated_at) : dayLabel(c.updated_at)}`));
    }
    fill(list, out);
  }

  function setMode() {           // composer and header follow what this person may do in the open chat
    const viewOnly = !!conv && !conv.can_edit;
    input.disabled = sendBtn.disabled = viewOnly;
    input.placeholder = viewOnly ? 'View only — this chat was shared with you. Ask its owner for edit access to add questions.' : 'Ask a question about your data…';
    connSel.disabled = !!conv && !conv.mine;
    shareBtn.classList.toggle('hidden', !(conv && conv.mine));
    sharedNote.classList.toggle('hidden', !(conv && !conv.mine));
    if (conv && !conv.mine) fill(sharedNote, h('div', { class: 'banner info', style: 'margin:0 0 12px' }, '👥 Shared by ', h('b', {}, conv.owner),
      conv.can_edit ? ' — you can view it and add questions.' : ' — view only.', ' Results are run with your own data access.'));
  }

  function welcome() {
    if (conv) return;
    const c = active.find(x => x.id === connId);
    const warn = !active.length ? 'No data model is available to you yet. Ask an administrator to connect a database.'
      : !models.length ? 'No AI model is enabled yet. An administrator can add one under Admin → Models.'
      : !c.table_count ? 'This data model has no schema yet. A steward needs to open Data models and press “Sync schema”.' : null;
    fill(inner, h('div', { class: 'empty' }, h('h1', { style: 'margin-bottom:8px' }, 'What would you like to know?'),
      warn ? h('div', { class: 'banner warn', style: 'max-width:520px;margin:12px auto' }, warn)
        : h('p', {}, `Asking `, h('b', {}, c.name), c.description ? ` — ${c.description}` : '', h('br'), h('span', { class: 'small dim' }, `${c.table_count} tables · ${c.db_label}`))));
  }

  function newChat() {
    conv = null; history.replaceState(null, '', '#/ask'); fill(inner); drawList(); welcome(); setMode(); input.focus();
  }

  async function open(id) {
    try {
      const data = await api('GET', `/api/chat/conversations/${id}`);
      conv = { id: data.id, title: data.title, connection_id: data.connection_id, mine: data.mine, can_edit: data.can_edit, owner: data.owner };
      connId = data.connection_id; connSel.value = connId;
      history.replaceState(null, '', `#/ask/${id}`);
      setMode();
      fill(inner, sharedNote, ...(data.no_access ? [h('div', { class: 'banner warn' }, 'This chat uses a data model you do not have access to, so its questions and results are not shown. Ask an administrator for access.')]
        : data.runs.map(r => runCard(r, { readonly: !!r.shared_view, onFollowup: data.can_edit ? ask : null }))));
      drawList();
      thread.scrollTop = thread.scrollHeight;
    } catch (e) { fail(e); newChat(); }
  }

  async function ask(text) {
    const question = (text || '').trim();
    if (!question || sending) return;
    if (!connId || !modelId) return toast('Choose a data model and an AI model first.', true);
    sending = true; sendBtn.disabled = true; input.value = ''; input.style.height = '';
    if (!conv) fill(inner);
    const pending = h('div', {}, h('div', { class: 'q' }, h('div', {}, question)),
      h('div', { class: 'card' }, h('span', { class: 'spinner' }), review ? '  Writing SQL…' : predictive ? '  Writing SQL, running it on your database and, if the question calls for it, fitting a model…' : '  Writing SQL and running it on your database…'));
    inner.append(pending);
    thread.scrollTop = thread.scrollHeight;
    try {
      const out = await api('POST', '/api/chat/ask', { connection_id: connId, model_id: modelId, conversation_id: conv?.id, question, review_first: review, predictive });
      if (!conv) { conv = { ...out.conversation, connection_id: connId, mine: true, can_edit: true }; history.replaceState(null, '', `#/ask/${conv.id}`); setMode(); }
      const name = active.find(c => c.id === connId)?.name || '';
      const existing = convs.find(c => c.id === conv.id);
      if (existing) convs.splice(convs.indexOf(existing), 1);
      convs.unshift({ mine: true, can_edit: true, ...existing, id: conv.id, title: out.conversation.title, connection_id: connId, connection_name: name, updated_at: new Date().toISOString().replace('Z', '') });
      drawList();
      const card = runCard(out.run, { onFollowup: ask });
      pending.replaceWith(card);
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      pending.lastChild.replaceWith(h('div', { class: 'banner bad' }, e.message));
    } finally { sending = false; setMode(); input.focus(); }
  }

  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input.value); } });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; });

  fill(root, h('div', { class: 'ask' },
    h('div', { class: 'convs' }, h('div', { style: 'padding:10px' }, h('button', { class: 'btn', style: 'width:100%;justify-content:center', onclick: newChat }, '＋ New chat'), h('div', { style: 'margin-top:8px' }, filter)), list),
    h('div', { class: 'thread-col' },
      h('div', { class: 'ask-bar' }, h('label', {}, 'Data model', connSel), h('label', {}, 'AI model', modelSel),
        h('label', { class: 'check', style: 'flex-direction:row;font-size:13px;color:var(--text-2);margin-top:14px' }, reviewChk, 'Review SQL before running'),
        h('label', { class: 'check', title: 'When ticked, questions that ask for a forecast, a prediction, segments, key drivers or anomalies also run a statistical model on the data. Other questions are answered as usual.', style: 'flex-direction:row;font-size:13px;color:var(--text-2);margin-top:14px' }, predictChk, '🔮 Use predictive capability'),
        h('a', { class: 'small', href: '#/help/predictive', target: '_blank', rel: 'noopener', style: 'margin-top:14px' }, '?'),
        h('span', { class: 'spacer' }), shareBtn),
      thread,
      h('div', { class: 'composer' }, h('div', { class: 'box' }, input, sendBtn),
        h('div', { class: 'privacy-note' }, '🔒 The AI model only sees your question and the schema & training notes. Query results stay between this server and your database.')))));
  drawList();
  if (convId) await open(convId); else welcome();
  input.focus();
}

export async function historyView(root) {
  const body = h('div', {});
  const search = h('input', { type: 'search', placeholder: 'Search your questions and SQL…', style: 'max-width:360px' });
  const STATUS = { success: 'good', error: 'bad', blocked: 'bad', clarification: 'warn', pending_review: 'info' };
  const monthOf = iso => new Date(iso + 'Z').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const row = r => h('tr', { class: 'click', onclick: () => { location.hash = `#/ask/${r.conversation_id}`; } },
    h('td', { class: 'nowrap' }, fmtTime(r.created_at)), h('td', { class: 'clip' }, r.question), h('td', {}, r.connection_name), h('td', {}, r.model_label),
    h('td', {}, h('span', { class: 'badge ' + (STATUS[r.status] || '') }, r.status.replace('_', ' '))), h('td', { class: 'num' }, r.row_count),
    h('td', {}, r.feedback ? h('span', { class: 'badge ' + (r.feedback === 'incorrect' ? 'bad' : 'good') }, r.feedback) : ''));
  const load = async () => {
    const rows = await api('GET', '/api/chat/history?q=' + encodeURIComponent(search.value));
    if (!rows.length) return fill(body, h('div', { class: 'empty' }, 'Nothing here yet.'));
    const trs = [];
    rows.forEach((r, i) => {       // newest first, with a heading row per month
      const m = monthOf(r.created_at);
      if (i === 0 || m !== monthOf(rows[i - 1].created_at)) trs.push(h('tr', { class: 'group' }, h('td', { colspan: 7 }, m)));
      trs.push(row(r));
    });
    fill(body, h('div', { class: 'tbl-wrap', style: 'max-height:none' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['When', 'Question', 'Data model', 'Model', 'Status', 'Rows', 'Feedback'].map(t => h('th', {}, t)))),
      h('tbody', {}, trs))));
  };
  let t; search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => load().catch(fail), 250); });
  fill(root, h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h1', {}, 'History'), h('span', { class: 'spacer' }), search), body));
  await load();
}
