import {
  api, html, raw, setHtml, esc, on, store, toast, fail, modal, confirmBox, purgeModal, field, formValues, badge, money, pct, num, fmtDate, fmtDateTime, ago, fullName, $, $$, debounce, allow,
} from './core.js';
import { mountList } from './list.js';

const page = (title, actions = '') => html`<div class="topbar"><h1>${title}</h1><span class="grow"></span>${actions}</div>`;
const rate = (a, b) => (b ? pct(a / b, 1) : '—');

// =============== Campaign list ===============
export async function campaignList(root) {
  const camps = await api('GET', '/campaigns');
  const sent = camps.filter((c) => c.sent > 0);
  const tSent = sent.reduce((a, c) => a + c.sent, 0), tOpen = sent.reduce((a, c) => a + c.opened, 0), tClick = sent.reduce((a, c) => a + c.clicked, 0);
  setHtml(root, html`${page('Campaigns', html`<a class="btn" href="#/segments">Segments</a><a class="btn" href="#/templates">Templates</a><button class="btn primary" data-act="new">+ New campaign</button>${allow('data.purge') ? html`<button class="btn danger" data-act="purge">Delete all…</button>` : ''}`)}
    <div class="grid g4"><div class="card kpi"><div class="l">Campaigns</div><div class="v">${camps.length}</div><div class="s">${camps.filter((c) => c.status === 'draft').length} drafts · ${camps.filter((c) => c.status === 'scheduled').length} scheduled</div></div>
      <div class="card kpi"><div class="l">Emails sent</div><div class="v">${num(tSent)}</div></div>
      <div class="card kpi"><div class="l">Avg open rate</div><div class="v">${rate(tOpen, tSent)}</div></div>
      <div class="card kpi"><div class="l">Avg click rate</div><div class="v">${rate(tClick, tSent)}</div></div></div>
    <div class="card mt">${camps.length ? html`<div class="tablewrap"><table><thead><tr><th>Campaign</th><th>Status</th><th>Audience</th><th>Sent</th><th>Open rate</th><th>Click rate</th><th>Date</th><th></th></tr></thead><tbody>
      ${camps.map((c) => html`<tr><td><a href="#/campaigns/${c.id}"><b>${c.name}</b></a><div class="small muted">${c.subject}</div></td><td>${badge(c.status)}</td><td>${c.segment_name || html`<span class="muted">—</span>`}</td>
        <td>${c.sent || '—'}</td><td>${c.sent ? rate(c.opened, c.sent) : '—'}</td><td>${c.sent ? rate(c.clicked, c.sent) : '—'}</td>
        <td class="small">${c.status === 'scheduled' ? 'Sends ' + fmtDateTime(c.scheduled_at) : c.sent_at ? fmtDate(c.sent_at) : 'Created ' + fmtDate(c.created_at)}</td>
        <td class="nowrap"><button class="btn sm" data-act="dup" data-id="${c.id}">Duplicate</button>${allow('campaigns.delete') && c.status !== 'sending' ? html` <button class="btn sm danger" data-act="del" data-id="${c.id}" aria-label="Delete">✕</button>` : ''}</td></tr>`)}</tbody></table></div>` : html`<div class="empty">No campaigns yet. Create your first one.</div>`}</div>`);
  on(root, {
    new: () => modal({ title: 'New campaign', body: field({ name: 'name', label: 'Campaign name', required: true, placeholder: 'e.g. Autumn webinar invite' }), submitLabel: 'Create',
      onSubmit: async (f) => { const c = await api('POST', '/campaigns', { name: f.name.value, from_name: store.meta.defaults.fromName, from_email: store.meta.defaults.fromEmail }); location.hash = `#/campaigns/${c.id}`; } }),
    purge: () => purgeModal('campaigns', () => campaignList(root)),
    dup: async (el) => { const c = await api('POST', `/campaigns/${el.dataset.id}/duplicate`); location.hash = `#/campaigns/${c.id}`; },
    del: async (el) => { if (await confirmBox('Delete this campaign and its tracking data?', 'Delete')) { await api('DELETE', `/campaigns/${el.dataset.id}`); campaignList(root); } },
  });
}

// =============== Campaign editor / report ===============
export async function campaignDetail(root, id) {
  let c = await api('GET', `/campaigns/${id}`);
  if (['draft', 'scheduled'].includes(c.status)) return editor(root, c);
  return report(root, c);
}

const aiPanel = () => html`<div class="ai"><h3>✨ Write with Claude</h3>${store.meta.ai.configured ? html`
  <p class="small muted" style="margin:4px 0 8px">Describe the campaign and Claude drafts the subject and email. Only what you type here is sent to Claude — no contact data. Always review before sending.</p>
  <textarea id="ai_brief" rows="3" placeholder="e.g. Announce our new analytics module to existing customers and invite them to a 20-minute demo next week."></textarea>
  <div class="row" style="margin-top:8px"><label>Audience<input id="ai_aud" placeholder="e.g. finance heads at mid-size companies"></label><label>Call-to-action link (optional)<input id="ai_cta" type="url" placeholder="https://…"></label></div>
  <div class="row"><label>Tone<select id="ai_tone"><option>Friendly and professional</option><option>Formal</option><option>Casual</option><option>Urgent but respectful</option><option>Warm and personal</option></select></label><label>Length<select id="ai_len"><option>Short (under 100 words)</option><option selected>Medium (100–180 words)</option><option>Long (180–300 words)</option></select></label></div>
  <div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn primary" data-act="aigen">Generate draft</button><button type="button" class="btn" data-act="airewrite">Rewrite current content…</button><button type="button" class="btn" data-act="aiundo" hidden>Undo</button></div>
  <div id="ai_alts" class="chips"></div><div id="ai_msg" class="small muted"></div>` : html`<p class="small muted" style="margin:4px 0 0">AI drafting is not set up yet. ${allow('settings.manage') ? html`Add an Anthropic API key in <a href="#/settings">Settings → AI assistant</a>.` : 'Ask an admin to add an Anthropic API key in Settings.'}</p>`}</div>`;

async function editor(root, c) {
  const [segments, templates] = await Promise.all([api('GET', '/segments'), api('GET', '/templates')]);
  const locked = c.status === 'scheduled';
  const canSend = allow('campaigns.send');
  setHtml(root, html`<div class="topbar"><a href="#/campaigns">← Campaigns</a><h1>${c.name}</h1>${badge(c.status)}<span class="grow"></span>
      <button class="btn" data-act="save">Save draft</button>
      ${canSend ? html`<button class="btn" data-act="test">Send test</button>${locked ? html`<button class="btn" data-act="unschedule">Unschedule</button>` : html`<button class="btn" data-act="schedule">Schedule…</button>`}<button class="btn primary" data-act="send">Send now</button>` : html`<span class="muted small">Managers can send campaigns</span>`}</div>
    ${locked ? html`<div class="card kpi" style="border-color:var(--warn)"><b>Scheduled for ${fmtDateTime(c.scheduled_at)}.</b> Unschedule to keep editing — edits are saved but the audience is frozen at send time.</div>` : ''}
    <div class="editor mt"><div class="card"><div class="bd"><form id="cform">
      <label>Campaign name<input name="name" value="${c.name}" required maxlength="150"></label>
      <label>Send from<select name="sender_id"><option value="">Default sender${store.meta.senders.find((x) => x.is_default) ? ` (${store.meta.senders.find((x) => x.is_default).from_email})` : ''}</option>${store.meta.senders.filter((x) => x.active).map((x) => html`<option value="${x.id}" ${c.sender_id === x.id ? raw('selected') : ''}>${x.label} &lt;${x.from_email}&gt;${x.mode === 'simulate' ? ' — simulation' : ''}</option>`)}</select></label>
      <div id="senderwarn"></div>
      <label>Audience segment<select name="segment_id"><option value="">Choose a segment…</option>${segments.map((s) => html`<option value="${s.id}" ${c.segment_id === s.id ? raw('selected') : ''}>${s.name} (${s.size} emailable)</option>`)}</select></label>
      <div id="audience" class="small muted" style="margin:-4px 0 12px"></div>
      ${aiPanel()}
      <label>Start from template<select id="tplpick"><option value="">— keep current content —</option>${templates.map((t) => html`<option value="${t.id}">${t.name}</option>`)}</select></label>
      <label>Subject line<input name="subject" value="${c.subject}" maxlength="250" placeholder="Use merge tags, e.g. {{first_name|there}}"></label>
      <div class="small muted">Insert merge tag:</div><div class="chips">${store.meta.mergeTags.map((t) => html`<button type="button" class="chip" data-act="tag" data-tag="${t}">{{${t}}}</button>`)}</div>
      <label>Email content (HTML)<textarea name="body_html" rows="14" spellcheck="false">${c.body_html}</textarea></label>
      <p class="small muted">Links are click-tracked automatically, an open pixel is added, and an unsubscribe footer is appended unless you include <code>{{unsubscribe_url}}</code>. Use <code>{{first_name|there}}</code> for fallbacks.</p>
    </form></div></div>
    <div class="card"><div class="hd"><h2>Live preview</h2><span class="grow"></span><span class="small muted" id="subjprev"></span></div><div class="bd"><iframe class="preview" sandbox="" title="Email preview"></iframe></div></div></div>`);
  const form = $('#cform', root); form.addEventListener('submit', (e) => e.preventDefault());
  const frame = $('iframe', root);
  const val = () => ({ name: form.name.value, sender_id: form.sender_id.value || null, segment_id: form.segment_id.value || null, subject: form.subject.value, body_html: form.body_html.value });
  const refreshPreview = debounce(async () => {
    try { const p = await api('POST', '/campaigns/preview', { subject: form.subject.value, body_html: form.body_html.value }); frame.srcdoc = p.html; $('#subjprev', root).textContent = 'Subject: ' + p.subject; } catch (e) { fail(e); }
  }, 350);
  const refreshAudience = async () => {
    const seg = segments.find((s) => String(s.id) === form.segment_id.value); const el = $('#audience', root);
    if (!seg) { el.textContent = ''; return; }
    const p = await api('POST', '/segments/preview', { filter: seg.filter });
    el.textContent = `${p.emailable} contacts will receive this (${p.matching - p.emailable} excluded: unsubscribed or no email).`;
  };
  form.addEventListener('input', refreshPreview); form.segment_id.addEventListener('change', () => refreshAudience().catch(fail));
  $('#tplpick', root).addEventListener('change', (e) => { const t = templates.find((x) => String(x.id) === e.target.value); if (t) { form.subject.value = t.subject; form.body_html.value = t.body_html; refreshPreview(); } e.target.value = ''; });
  const senderWarn = () => {
    const sel = store.meta.senders.find((x) => String(x.id) === form.sender_id.value) || store.meta.senders.find((x) => x.is_default);
    const sim = !sel || sel.mode === 'simulate';
    setHtml($('#senderwarn', root), sim ? html`<div class="banner small"><b>Simulation mode:</b> ${sel ? `"${sel.label}" is a simulation sender` : 'no sender is configured'} — nothing will actually be emailed. ${allow('senders.manage') ? html`<a href="#/senders">Set up a real sender</a>` : 'Ask an admin to configure a real sender.'}</div>` : '');
  };
  form.sender_id.addEventListener('change', senderWarn); senderWarn();
  refreshPreview(); refreshAudience().catch(() => {});
  let aiPrev = null;
  const aiCall = async (btn, payload) => {
    btn.disabled = true; const label = btn.textContent; btn.textContent = 'Claude is writing…'; $('#ai_msg', root).textContent = '';
    try {
      const r = await api('POST', '/ai/campaign', payload);
      aiPrev = { subject: form.subject.value, body: form.body_html.value };
      form.subject.value = r.subject; form.body_html.value = r.body_html; refreshPreview();
      $('[data-act=aiundo]', root).hidden = false;
      setHtml($('#ai_alts', root), html`${r.subject_alternatives.map((a) => html`<button type="button" class="chip" data-act="aialt" data-s="${a}" style="font-family:inherit">${a}</button>`)}`);
      $('#ai_msg', root).textContent = `Draft applied (${r.model}).${r.subject_alternatives.length ? ' Click an alternative subject to swap it in.' : ''} Review the copy and links before sending.`;
    } finally { btn.disabled = false; btn.textContent = label; }
  };
  const save = async (quiet) => { await api('PUT', `/campaigns/${c.id}`, val()); if (!quiet) toast('Draft saved', 'ok'); };
  on(root, {
    tag: (el) => { const t = form.body_html; const s = t.selectionStart; t.setRangeText(`{{${el.dataset.tag}}}`, s, t.selectionEnd, 'end'); t.focus(); refreshPreview(); },
    save: () => save(),
    aigen: (el) => aiCall(el, { task: 'draft', brief: $('#ai_brief', root).value, audience: $('#ai_aud', root).value, cta_url: $('#ai_cta', root).value, tone: $('#ai_tone', root).value, length: $('#ai_len', root).value }),
    airewrite: (el) => modal({ title: 'Rewrite with Claude', submitLabel: 'Rewrite', body: field({ name: 'instruction', label: 'How should it change?', required: true, placeholder: 'e.g. make it shorter and more direct; add urgency; translate to formal tone' }),
      onSubmit: async (f) => aiCall(el, { task: 'rewrite', instruction: f.instruction.value, current_subject: form.subject.value, current_html: form.body_html.value, tone: $('#ai_tone', root).value, audience: $('#ai_aud', root).value, cta_url: $('#ai_cta', root).value }) }),
    aiundo: (el) => { if (aiPrev) { form.subject.value = aiPrev.subject; form.body_html.value = aiPrev.body; refreshPreview(); el.hidden = true; $('#ai_alts', root).innerHTML = ''; $('#ai_msg', root).textContent = 'Reverted to your previous content.'; } },
    aialt: (el) => { form.subject.value = el.dataset.s; refreshPreview(); },
    test: () => modal({ title: 'Send test email', submitLabel: 'Send test', body: html`${field({ name: 'to', label: 'Send to', type: 'email', required: true, default: store.user.email })}<p class="small muted">Test emails use sample merge data and are not tracked.</p>`,
      onSubmit: async (f) => { await save(true); const r = await api('POST', `/campaigns/${c.id}/test`, { to: f.to.value }); toast(r.simulated ? `Simulated — nothing was actually sent to ${r.to}` : `Test email sent to ${r.to} via ${r.sender || 'default sender'}`, r.simulated ? '' : 'ok'); } }),
    schedule: () => modal({ title: 'Schedule campaign', submitLabel: 'Schedule', body: field({ name: 'at', label: 'Send at (your local time)', type: 'datetime-local', required: true }),
      onSubmit: async (f) => { await save(true); await api('POST', `/campaigns/${c.id}/schedule`, { at: new Date(f.at.value).toISOString() }); toast('Campaign scheduled', 'ok'); campaignDetail(root, c.id); } }),
    unschedule: async () => { await api('POST', `/campaigns/${c.id}/unschedule`); campaignDetail(root, c.id); },
    send: async () => {
      await save(true);
      if (!form.segment_id.value) throw new Error('Choose an audience segment first');
      const seg = segments.find((s) => String(s.id) === form.segment_id.value); const p = await api('POST', '/segments/preview', { filter: seg.filter });
      const sd = store.meta.senders.find((x) => String(x.id) === form.sender_id.value) || store.meta.senders.find((x) => x.is_default);
      const via = !sd || sd.mode === 'simulate' ? 'SIMULATION MODE — nobody will actually receive this email' : `from ${sd.from_name || ''} <${sd.from_email}>`;
      if (await confirmBox(`Send "${form.subject.value || c.name}" to ${p.emailable} contacts in "${seg.name}" now, ${via}? This cannot be undone.`, `Send to ${p.emailable}`, false)) {
        const r = await api('POST', `/campaigns/${c.id}/launch`); toast(r.simulated ? `Simulated send to ${r.recipients} recipients (no real email)` : `Sending to ${r.recipients} recipients…`, 'ok'); campaignDetail(root, c.id);
      }
    },
  });
}

async function report(root, c) {
  let filter = '';
  const draw = async () => {
    c = await api('GET', `/campaigns/${c.id}`); const s = c.stats;
    const recips = await api('GET', `/campaigns/${c.id}/recipients${filter ? '?filter=' + filter : ''}`);
    const maxT = Math.max(...s.timeline.map((t) => t.opens + t.clicks), 1);
    const tile = (label, v, sub, w) => html`<div class="card kpi"><div class="l">${label}</div><div class="v">${v}</div><div class="s">${sub}</div>${w != null ? html`<div class="ring"><i style="width:${Math.min(100, w * 100)}%"></i></div>` : ''}</div>`;
    setHtml(root, html`<div class="topbar"><a href="#/campaigns">← Campaigns</a><h1>${c.name}</h1>${badge(c.status)}<span class="grow"></span><button class="btn" data-act="dup">Duplicate</button><button class="btn" data-act="preview">View email</button></div>
      <div class="muted" style="margin:-10px 0 16px">Subject: <b>${c.subject}</b> · Audience: ${c.segment_name || 'deleted segment'} · From: ${c.sender_label ? `${c.sender_label} <${c.sender_email}>` : 'default sender'} · ${c.sent_at ? 'Sent ' + fmtDateTime(c.sent_at) : 'Sending…'}</div>
      ${c.simulated ? html`<div class="banner"><b>This was a simulation.</b> No email was actually sent — the statuses below are simulated. Configure a real sender under <a href="#/senders">Email senders</a>.</div>` : ''}
      ${c.note ? html`<div class="banner">${c.note}</div>` : ''}
      ${s.failed ? html`<div class="banner bad"><b>${s.failed} email${s.failed === 1 ? '' : 's'} failed.</b> ${s.failures.map((f) => html`<div class="small">${f.n}× ${f.error}</div>`)}</div>` : ''}
      <div class="pill-row" style="margin-bottom:12px"><span class="badge queued">Queued ${s.queued}</span><span class="badge sent">Sent ${s.sent}</span><span class="badge failed">Failed ${s.failed}</span><span class="badge opened">Opened ${s.opened}</span><span class="badge clicked">Clicked ${s.clicked}</span><span class="badge unsubscribed">Unsubscribed ${s.unsubscribed}</span></div>
      ${c.status === 'sending' ? html`<div class="card kpi" style="border-color:var(--warn)">Sending in progress — ${s.sent + s.failed} of ${s.total} processed. <a href="#/campaigns/${c.id}" data-act="refresh">Refresh</a></div>` : ''}
      <div class="grid g4 mt">${tile('Delivered', num(s.sent), `${s.total} recipients${s.failed ? ` · ${s.failed} failed` : ''}`, s.total ? s.sent / s.total : 0)}${tile('Open rate', rate(s.opened, s.sent), `${s.opened} unique · ${s.total_opens} total opens`, s.open_rate)}
        ${tile('Click rate', rate(s.clicked, s.sent), `${s.clicked} unique · click-to-open ${rate(s.clicked, s.opened)}`, s.click_rate)}${tile('Unsubscribes', s.unsubscribed, rate(s.unsubscribed, s.sent) + ' of delivered', null)}</div>
      <div class="grid g2 mt"><div class="card"><div class="hd"><h2>Engagement over time</h2></div><div class="bd">${s.timeline.length ? html`<div class="bars">${s.timeline.map((t) => html`<div class="b"><em>${t.opens}/${t.clicks}</em><i style="height:${Math.max(2, ((t.opens + t.clicks) / maxT) * 100)}%"></i><span>${fmtDate(t.day)}</span></div>`)}</div><div class="small muted">opens / clicks per day</div>` : html`<div class="empty">No engagement yet.</div>`}</div></div>
        <div class="card"><div class="hd"><h2>Top links</h2></div>${s.top_links.length ? html`<div class="tablewrap"><table><tbody>${s.top_links.map((l) => html`<tr><td style="word-break:break-all">${l.url}</td><td class="right nowrap"><b>${l.clicks}</b> clicks<div class="small muted">${l.unique_clicks} unique</div></td></tr>`)}</tbody></table></div>` : html`<div class="empty">No link clicks yet.</div>`}</div></div>
      <div class="card mt"><div class="hd"><h2>Recipients</h2><span class="grow"></span><select id="rf" aria-label="Filter recipients">${[['', 'All'], ['queued', 'Queued'], ['sent', 'Sent'], ['failed', 'Failed'], ['opened', 'Opened'], ['clicked', 'Clicked'], ['unsubscribed', 'Unsubscribed']].map(([v, l]) => html`<option value="${v}" ${filter === v ? raw('selected') : ''}>${l}</option>`)}</select></div>
        <div class="tablewrap"><table><thead><tr><th>Recipient</th><th>Status</th><th>Sent</th><th>Opened</th><th>Clicked</th><th>Detail</th></tr></thead><tbody>${recips.length ? recips.map((r) => html`<tr><td>${r.contact_id ? html`<a href="#/contacts/${r.contact_id}">${r.name || r.email}</a>` : r.email}<div class="small muted">${r.email}</div></td><td>${badge(r.state)}</td><td class="small">${r.sent_at ? ago(r.sent_at) : '—'}</td><td class="small">${r.first_open_at ? html`${ago(r.first_open_at)}${r.open_count > 1 ? ` ×${r.open_count}` : ''}` : '—'}</td><td class="small">${r.first_click_at ? html`${ago(r.first_click_at)}${r.click_count > 1 ? ` ×${r.click_count}` : ''}` : '—'}</td><td class="small ${r.error ? '' : 'muted'}" style="${r.error ? 'color:var(--bad)' : ''};max-width:300px">${r.unsubscribed_at ? 'Unsubscribed ' : ''}${r.error || (r.status === 'sent' ? (r.response || '').slice(0, 60) : '')}</td></tr>`) : html`<tr><td colspan="6" class="empty">No recipients match.</td></tr>`}</tbody></table></div>
        ${recips.length >= 500 ? html`<div class="pager">Showing first 500 recipients.</div>` : ''}</div>`);
    $('#rf', root)?.addEventListener('change', (e) => { filter = e.target.value; draw().catch(fail); });
    if (c.status === 'sending') { clearTimeout(report.t); report.t = setTimeout(() => { if (location.hash === `#/campaigns/${c.id}`) draw().catch(() => {}); }, 2000); }
  };
  on(root, {
    dup: async () => { const n = await api('POST', `/campaigns/${c.id}/duplicate`); location.hash = `#/campaigns/${n.id}`; },
    refresh: () => draw(),
    preview: async () => { const p = await api('POST', '/campaigns/preview', { subject: c.subject, body_html: c.body_html }); modal({ title: p.subject, wide: true, hideFooter: true, body: html`<iframe class="preview" sandbox="" title="Email" srcdoc="${p.html}"></iframe>` }); },
  });
  await draw();
}

// =============== Segments ===============
function ruleRow(r, i) {
  const F = store.meta.segmentFields; const f = F[r.field] || F.status;
  const opLabels = { is: 'is', is_not: 'is not', contains: 'contains', not_contains: 'does not contain', starts_with: 'starts with', before: 'is before', after: 'is after', is_empty: 'is empty', is_not_empty: 'is not empty' };
  const noVal = ['is_empty', 'is_not_empty'].includes(r.op);
  return html`<div class="rule" data-i="${i}"><select data-k="field" aria-label="Field">${Object.entries(F).map(([k, v]) => html`<option value="${k}" ${k === r.field ? raw('selected') : ''}>${v.label}</option>`)}</select>
    <select data-k="op" aria-label="Operator">${store.meta.segmentOps.map((o) => html`<option value="${o}" ${o === r.op ? raw('selected') : ''}>${opLabels[o]}</option>`)}</select>
    ${noVal ? html`<span></span>` : f.type === 'enum' ? html`<select data-k="value" aria-label="Value">${f.options.map((o) => html`<option ${o === r.value ? raw('selected') : ''}>${o}</option>`)}</select>` : html`<input data-k="value" value="${r.value}" aria-label="Value" type="${f.type === 'date' ? 'date' : 'text'}">`}
    <button type="button" class="btn sm danger" data-act="rm" aria-label="Remove rule">✕</button></div>`;
}
function segmentModal(seg, done) {
  const st = { match: seg?.filter.match || 'all', rules: (seg?.filter.rules || [{ field: 'status', op: 'is', value: 'lead' }]).map((r) => ({ ...r })) };
  let body;
  const draw = (form) => {
    setHtml($('#rules', form), html`${st.rules.map(ruleRow)}`);
    refresh(form);
  };
  const refresh = debounce(async (form) => {
    try { const p = await api('POST', '/segments/preview', { filter: st }); setHtml($('#segprev', form), html`<b>${p.emailable}</b> emailable contacts (${p.matching} match in total).${p.sample.length ? html` Sample: ${p.sample.map((s) => fullName(s)).join(', ')}…` : ''}`); }
    catch (e) { setHtml($('#segprev', form), html`<span style="color:var(--bad)">${e.message}</span>`); }
  }, 250);
  modal({ title: seg ? 'Edit segment' : 'New segment', wide: true, submitLabel: 'Save segment',
    body: html`${field({ name: 'name', label: 'Segment name', required: true }, seg || {})}${field({ name: 'description', label: 'Description' }, seg || {})}
      <label>Contacts must match <select id="match" style="display:inline;width:auto"><option value="all" ${st.match === 'all' ? raw('selected') : ''}>ALL</option><option value="any" ${st.match === 'any' ? raw('selected') : ''}>ANY</option></select> of these rules</label>
      <div id="rules"></div><button type="button" class="btn sm" data-act="add">+ Add rule</button>
      <div id="segprev" class="card kpi mt small"></div><p class="small muted">Unsubscribed contacts and contacts without an email address are always excluded at send time.</p>`,
    onOpen: (form) => {
      draw(form);
      $('#match', form).addEventListener('change', (e) => { st.match = e.target.value; refresh(form); });
      form.addEventListener('change', (e) => {
        const row = e.target.closest('.rule'); if (!row) return; const r = st.rules[row.dataset.i]; r[e.target.dataset.k] = e.target.value;
        if (e.target.dataset.k === 'field') { const f = store.meta.segmentFields[r.field]; r.value = f.type === 'enum' ? f.options[0] : ''; r.op = 'is'; draw(form); } else if (e.target.dataset.k === 'op') draw(form); else refresh(form);
      });
      form.addEventListener('input', (e) => { const row = e.target.closest('.rule'); if (row && e.target.tagName === 'INPUT') { st.rules[row.dataset.i].value = e.target.value; refresh(form); } });
      on(form, { add: () => { st.rules.push({ field: 'status', op: 'is', value: 'lead' }); draw(form); }, rm: (el) => { st.rules.splice(el.closest('.rule').dataset.i, 1); draw(form); } });
    },
    onSubmit: async (form) => {
      const payload = { name: form.name.value, description: form.description.value, filter: st };
      seg ? await api('PUT', `/segments/${seg.id}`, payload) : await api('POST', '/segments', payload); toast('Segment saved', 'ok'); done();
    } });
}
export async function segments(root) {
  const draw = async () => {
    const segs = await api('GET', '/segments');
    setHtml(root, html`${page('Segments', html`<a class="btn" href="#/campaigns">← Campaigns</a><button class="btn primary" data-act="new">+ New segment</button>${allow('data.purge') ? html`<button class="btn danger" data-act="purge">Delete all…</button>` : ''}`)}
      <div class="card">${segs.length ? html`<div class="tablewrap"><table><thead><tr><th>Segment</th><th>Rules</th><th>Emailable</th><th></th></tr></thead><tbody>${segs.map((s) => html`<tr><td><b>${s.name}</b><div class="small muted">${s.description || ''}</div></td>
        <td class="small">${s.filter.rules.length ? s.filter.rules.map((r) => `${store.meta.segmentFields[r.field]?.label || r.field} ${r.op.replace(/_/g, ' ')} ${r.value}`).join(s.filter.match === 'any' ? ' OR ' : ' AND ') : 'Everyone'}</td>
        <td><b>${s.size}</b> <span class="muted small">of ${s.total_matching}</span></td><td class="nowrap"><button class="btn sm" data-act="edit" data-id="${s.id}">Edit</button>${allow('segments.delete') ? html` <button class="btn sm danger" data-act="del" data-id="${s.id}" aria-label="Delete">✕</button>` : ''}</td></tr>`)}</tbody></table></div>` : html`<div class="empty">No segments yet.</div>`}</div>`);
    on(root, {
      purge: () => purgeModal('segments', draw), new: () => segmentModal(null, draw), edit: (el) => segmentModal(segs.find((s) => String(s.id) === el.dataset.id), draw),
      del: async (el) => { if (await confirmBox('Delete this segment? Campaigns using it will lose their audience.', 'Delete')) { await api('DELETE', `/segments/${el.dataset.id}`); draw(); } },
    });
  };
  await draw();
}

// =============== Templates ===============
export async function templates(root) {
  const draw = async () => {
    const list = await api('GET', '/templates');
    setHtml(root, html`${page('Email templates', html`<a class="btn" href="#/campaigns">← Campaigns</a><button class="btn primary" data-act="new">+ New template</button>${allow('data.purge') ? html`<button class="btn danger" data-act="purge">Delete all…</button>` : ''}`)}
      <div class="grid g3">${list.map((t) => html`<div class="card"><div class="hd"><h2>${t.name}</h2></div><div class="bd"><div class="small muted">Subject</div><div>${t.subject}</div></div><div class="hd" style="border-top:1px solid var(--line);border-bottom:0"><button class="btn sm" data-act="edit" data-id="${t.id}">Edit</button>${allow('templates.delete') ? html`<button class="btn sm danger" data-act="del" data-id="${t.id}">Delete</button>` : ''}</div></div>`)}</div>
      ${list.length ? '' : html`<div class="card empty">No templates yet.</div>`}`);
    const open = (t) => modal({ title: t ? 'Edit template' : 'New template', wide: true,
      body: html`${field({ name: 'name', label: 'Template name', required: true }, t || {})}${field({ name: 'subject', label: 'Subject', required: true }, t || {})}${field({ name: 'body_html', label: 'HTML content', type: 'textarea', rows: 12, required: true, default: '<p>Hi {{first_name|there}},</p>' }, t || {})}<p class="small muted">Merge tags: ${store.meta.mergeTags.map((m) => `{{${m}}}`).join('  ')}</p>`,
      onSubmit: async (f) => { const v = { name: f.name.value, subject: f.subject.value, body_html: f.body_html.value }; t ? await api('PUT', `/templates/${t.id}`, v) : await api('POST', '/templates', v); toast('Template saved', 'ok'); draw(); } });
    on(root, { purge: () => purgeModal('templates', draw), new: () => open(null), edit: (el) => open(list.find((x) => String(x.id) === el.dataset.id)),
      del: async (el) => { if (await confirmBox('Delete this template?', 'Delete')) { await api('DELETE', `/templates/${el.dataset.id}`); draw(); } } });
  };
  await draw();
}
