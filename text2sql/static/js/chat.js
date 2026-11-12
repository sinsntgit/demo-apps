// Ask page: pick a data model + AI model, ask questions, browse saved conversations.
import { h, fill, api, busy, fail, select, state, ago, confirmDialog, toast } from './core.js';
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
  let sending = false;

  const list = h('div', { class: 'list' });
  const inner = h('div', { class: 'thread-inner' });
  const thread = h('div', { class: 'thread' }, inner);
  const input = h('textarea', { placeholder: 'Ask a question about your data…', rows: 1 });
  const sendBtn = h('button', { class: 'btn primary', onclick: () => ask(input.value) }, 'Ask');
  const connSel = select(active.map(c => [c.id, `${c.name}  ·  ${c.db_label}`]), connId, v => { connId = Number(v); prefs.set('conn', v); if (conv && conv.connection_id !== connId) newChat(); else welcome(); });
  const modelSel = select(models.map(m => [m.id, m.name]), modelId, v => { modelId = Number(v); prefs.set('model', v); });
  const reviewChk = h('input', { type: 'checkbox', checked: review, onchange: e => { review = e.target.checked; prefs.set('review', review ? '1' : '0'); } });

  function drawList() {
    fill(list, ...(convs.length ? convs.map(c => h('div', { class: 'conv' + (conv?.id === c.id ? ' on' : ''), onclick: () => open(c.id) },
      h('div', { class: 't' }, h('b', {}, c.title), h('span', { class: 'small dim' }, `${c.connection_name} · ${ago(c.updated_at)}`)),
      h('button', { class: 'btn ghost sm x', title: 'Delete conversation', onclick: async e => {
        e.stopPropagation();
        if (!await confirmDialog('Delete conversation?', `“${c.title}” and its saved results will be removed from your history.`, 'Delete')) return;
        await api('DELETE', `/api/chat/conversations/${c.id}`).catch(fail);
        convs.splice(convs.indexOf(c), 1);
        if (conv?.id === c.id) newChat(); else drawList();
      } }, '🗑'))) : [h('div', { class: 'empty small' }, 'Your saved conversations will appear here.')]));
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
    conv = null; history.replaceState(null, '', '#/ask'); fill(inner); drawList(); welcome(); connSel.disabled = false; input.focus();
  }

  async function open(id) {
    try {
      const data = await api('GET', `/api/chat/conversations/${id}`);
      conv = { id: data.id, title: data.title, connection_id: data.connection_id };
      connId = data.connection_id; connSel.value = connId;
      history.replaceState(null, '', `#/ask/${id}`);
      fill(inner, ...data.runs.map(r => runCard(r, { onFollowup: ask })));
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
      h('div', { class: 'card' }, h('span', { class: 'spinner' }), review ? '  Writing SQL…' : '  Writing SQL and running it on your database…'));
    inner.append(pending);
    thread.scrollTop = thread.scrollHeight;
    try {
      const out = await api('POST', '/api/chat/ask', { connection_id: connId, model_id: modelId, conversation_id: conv?.id, question, review_first: review });
      if (!conv) { conv = { ...out.conversation, connection_id: connId }; history.replaceState(null, '', `#/ask/${conv.id}`); }
      const name = active.find(c => c.id === connId)?.name || '';
      const existing = convs.find(c => c.id === conv.id);
      if (existing) convs.splice(convs.indexOf(existing), 1);
      convs.unshift({ id: conv.id, title: out.conversation.title, connection_id: connId, connection_name: name, updated_at: new Date().toISOString().replace('Z', '') });
      drawList();
      const card = runCard(out.run, { onFollowup: ask });
      pending.replaceWith(card);
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      pending.lastChild.replaceWith(h('div', { class: 'banner bad' }, e.message));
    } finally { sending = false; sendBtn.disabled = false; input.focus(); }
  }

  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input.value); } });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; });

  fill(root, h('div', { class: 'ask' },
    h('div', { class: 'convs' }, h('div', { style: 'padding:10px' }, h('button', { class: 'btn', style: 'width:100%;justify-content:center', onclick: newChat }, '＋ New chat')), list),
    h('div', { class: 'thread-col' },
      h('div', { class: 'ask-bar' }, h('label', {}, 'Data model', connSel), h('label', {}, 'AI model', modelSel),
        h('label', { class: 'check', style: 'flex-direction:row;font-size:13px;color:var(--text-2);margin-top:14px' }, reviewChk, 'Review SQL before running')),
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
  const load = async () => {
    const rows = await api('GET', '/api/chat/history?q=' + encodeURIComponent(search.value));
    fill(body, rows.length ? h('div', { class: 'tbl-wrap', style: 'max-height:none' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['When', 'Question', 'Data model', 'Model', 'Status', 'Rows', 'Feedback'].map(t => h('th', {}, t)))),
      h('tbody', {}, rows.map(r => h('tr', { class: 'click', onclick: () => { location.hash = `#/ask/${r.conversation_id}`; } },
        h('td', { class: 'nowrap' }, ago(r.created_at)), h('td', { class: 'clip' }, r.question), h('td', {}, r.connection_name), h('td', {}, r.model_label),
        h('td', {}, h('span', { class: 'badge ' + (STATUS[r.status] || '') }, r.status.replace('_', ' '))), h('td', { class: 'num' }, r.row_count),
        h('td', {}, r.feedback ? h('span', { class: 'badge ' + (r.feedback === 'incorrect' ? 'bad' : 'good') }, r.feedback) : '')))))) : h('div', { class: 'empty' }, 'Nothing here yet.'));
  };
  let t; search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => load().catch(fail), 250); });
  fill(root, h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h1', {}, 'History'), h('span', { class: 'spacer' }), search), body));
  await load();
}
