import { renderFields, applyVisibility, readValues, activeFields } from './forms.js';
import { api, html, raw, setHtml, store, toast, fail, on, $, $$, modal, confirmBox, fmtDateTime, fmtDate, field, allow, badge, fullName, esc } from './core.js';

// ---------------------------------------------------------------- lead conversion
export async function convertLead(contactId, done) {
  const pv = await api('GET', `/contacts/${contactId}/convert-preview`);
  const dealFields = activeFields('deals'); const lk = dealFields.some((f) => f.type === 'lookup') ? { accounts: (await api('GET', '/accounts?limit=1000&sort=name')).rows.map((x) => [x.id, x.name]), contacts: (await api('GET', '/contacts?limit=1000&sort=name')).rows.map((x) => [x.id, fullName(x)]) } : {};
  const dealLayout = { sections: [{ title: 'More deal details', columns: 2, fields: dealFields.map((f) => f.key) }] };
  const sug = pv.suggested_accounts;
  modal({ title: `Convert ${pv.contact.name}`, submitLabel: 'Convert', body: html`
    <p class="small muted">Turns this lead into a qualified customer record. You can open a deal at the same time; everything is linked and kept in the history.</p>
    <h3 style="margin-bottom:4px">Account</h3>
    <div class="seg" style="display:grid;gap:6px">
      ${pv.contact.account_id ? html`<label class="check"><input type="radio" name="amode" value="none" checked> Keep current account <b>${pv.contact.account_name}</b></label>` : html`<label class="check"><input type="radio" name="amode" value="none" checked> No account</label>`}
      ${pv.can_create_account ? html`<label class="check"><input type="radio" name="amode" value="new" ${sug.length ? '' : ''}> Create a new account</label>
        <div data-for="new" hidden style="margin-left:22px"><label>Account name<input name="aname" value="${pv.suggested_account_name}"></label></div>` : ''}
      <label class="check"><input type="radio" name="amode" value="existing"> Link to an existing account${sug.length ? html` <span class="badge sent">match on email domain</span>` : ''}</label>
      <div data-for="existing" hidden style="margin-left:22px"><label>Account<select name="aid">${sug.map((a) => html`<option value="${a.id}">${a.name}</option>`)}<option value="">Search…</option></select></label>
        <label>Or find by name<input name="asearch" placeholder="Type to search accounts" autocomplete="off"></label></div>
    </div>
    ${pv.can_create_deal ? html`<h3 style="margin-bottom:4px">Deal</h3><label class="check"><input type="checkbox" name="dcreate" checked> Open a deal now</label>
      <div data-for="deal"><div class="row"><label>Deal name<input name="dname" value="${pv.suggested_deal_name}"></label><label>Amount<input type="number" min="0" step="any" name="damount" value="0"></label></div>
      <div class="row"><label>Stage<select name="dstage">${pv.stages.map((s) => html`<option value="${s.key}" ${s.key === 'qualification' ? raw('selected') : ''}>${s.label}</option>`)}</select></label><label>Expected close<input type="date" name="dclose"></label></div>${dealFields.length ? renderFields('deals', {}, lk, { layout: dealLayout }) : ''}</div>` : ''}
    <label>Contact status afterwards<select name="status"><option value="qualified">Qualified</option><option value="customer">Customer</option></select></label>`,
    onOpen: (f) => {
      const sync = () => { const m = f.amode.value; $$('[data-for=new]', f).forEach((e) => (e.hidden = m !== 'new')); $$('[data-for=existing]', f).forEach((e) => (e.hidden = m !== 'existing')); const d = $('[data-for=deal]', f); if (d) d.hidden = !f.dcreate.checked; };
      const vis = () => applyVisibility(f, 'deals', lk); f.addEventListener('input', vis); f.addEventListener('change', () => { sync(); vis(); }); sync(); vis();
      f.asearch?.addEventListener('input', async () => { const r = await api('GET', `/lookup?type=accounts&q=${encodeURIComponent(f.asearch.value)}`); f.aid.innerHTML = r.map((a) => `<option value="${a.id}">${esc(a.label)}</option>`).join(''); });
    },
    onSubmit: async (f) => {
      const m = f.amode.value; const account = m === 'new' ? { mode: 'new', name: f.aname.value } : m === 'existing' ? { mode: 'existing', id: f.aid.value } : { mode: 'none' };
      const deal = f.dcreate?.checked ? { create: true, name: f.dname.value, amount: f.damount.value, stage: f.dstage.value, close_date: f.dclose.value, custom: dealFields.length ? readValues(f, 'deals', lk).custom : undefined } : {};
      const r = await api('POST', `/contacts/${contactId}/convert`, { account, deal, status: f.status.value });
      toast('Lead converted', 'ok'); if (r.deal_id) location.hash = `#/deals/${r.deal_id}`; else done?.();
    } });
}

// ---------------------------------------------------------------- duplicates & merge
export async function duplicates(root) {
  let kind = sessionStorage.getItem('dupKind') || 'contacts';
  const draw = async () => {
    const groups = await api('GET', `/duplicates/${kind}`);
    const label = (r) => kind === 'contacts' ? html`<b>${fullName(r)}</b> <span class="muted small">${r.email || 'no email'}${r.phone ? ' · ' + r.phone : ''} · ${r.status}</span>` : html`<b>${r.name}</b> <span class="muted small">${[r.website, r.city, r.vat_number].filter(Boolean).join(' · ')}</span>`;
    setHtml(root, html`<div class="topbar"><h1>Duplicates</h1><span class="grow"></span>
      ${['contacts', 'accounts'].filter((k) => allow(`${k}.merge`)).map((k) => html`<button class="btn ${k === kind ? 'primary' : ''}" data-act="kind" data-k="${k}">${k[0].toUpperCase() + k.slice(1)}</button>`)}</div>
      <p class="muted">Records that share an email, name or VAT number. Pick the one to <b>keep</b>; the others are folded into it — their deals, tasks, notes, invoices, files and campaign history move across, and empty fields on the kept record are filled in. This cannot be undone.</p>
      ${groups.length ? groups.map((g, gi) => html`<div class="card mt" data-g="${gi}"><div class="hd"><h2>${g.reason}</h2><span class="grow"></span><button class="btn sm primary" data-act="merge" data-g="${gi}">Merge into the kept record</button></div>
        <div class="bd">${g.rows.map((r, i) => html`<label class="check" style="display:flex;gap:8px;padding:4px 0"><input type="radio" name="keep${gi}" value="${r.id}" ${i === 0 ? raw('checked') : ''}> <span>${label(r)} <span class="muted small">added ${fmtDate(r.created_at)}</span></span></label>`)}</div></div>`)
      : html`<div class="card empty mt"><h2>No duplicates found</h2><p class="muted">Nothing shares an email, name or VAT number.</p></div>`}`);
    on(root, {
      kind: (el) => { kind = el.dataset.k; sessionStorage.setItem('dupKind', kind); draw(); },
      merge: async (el) => {
        const g = groups[el.dataset.g]; const keep = Number($(`input[name=keep${el.dataset.g}]:checked`, root).value); const drop = g.rows.filter((r) => r.id !== keep);
        if (!(await confirmBox(`Merge ${drop.length} record${drop.length > 1 ? 's' : ''} into the one you kept? The merged-away record${drop.length > 1 ? 's are' : ' is'} deleted.`, 'Merge'))) return;
        for (const r of drop) await api('POST', `/${kind}/${r.id}/merge`, { into: keep });
        toast('Merged', 'ok'); draw();
      },
    });
  };
  await draw();
}

// ---------------------------------------------------------------- attachments
const sizeText = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
/** File attachments card. Render it into `root` for a record of type entity (contacts|accounts|deals|invoices). */
export async function attachments(root, entity, id) {
  if (!allow('attachments.view')) return;
  const files = await api('GET', `/files?entity=${entity}&id=${id}`); const canUp = allow('attachments.upload'), canDel = allow('attachments.delete');
  setHtml(root, html`<div class="card"><div class="hd"><h2>Files</h2><span class="muted small">${files.length || ''}</span><span class="grow"></span>${canUp ? html`<button class="btn sm" data-act="pick">+ Attach file</button><input type="file" hidden multiple data-file>` : ''}</div>
    <div class="bd" data-drop>${files.length ? files.map((f) => html`<div style="display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line)"><span style="font-size:20px">📎</span><div class="grow" style="min-width:0"><a href="/api/files/${f.id}/download" target="_blank" rel="noopener"><b>${f.name}</b></a><div class="small muted">${sizeText(f.size)} · ${f.uploaded_by_name || ''} · ${fmtDateTime(f.created_at)}${f.note ? ' · ' + f.note : ''}</div></div>${canDel ? html`<button class="btn sm danger" data-act="rm" data-id="${f.id}">Remove</button>` : ''}</div>`)
      : html`<p class="muted small" style="margin:0">${canUp ? 'No files yet. Drop a file here or click “Attach file”.' : 'No files.'}</p>`}</div></div>`);
  const upload = async (list) => {
    for (const file of list) {
      const fd = new FormData(); fd.append('file', file, file.name);
      const r = await fetch(`/api/files?entity=${entity}&id=${id}`, { method: 'POST', body: fd }); const j = await r.json().catch(() => ({}));
      if (!r.ok) { fail(new Error(`${file.name}: ${j.error || 'upload failed'}`)); continue; }
      toast(`Attached ${file.name}`, 'ok');
    }
    attachments(root, entity, id);
  };
  const input = $('[data-file]', root); input?.addEventListener('change', () => upload([...input.files]));
  const drop = $('[data-drop]', root);
  if (canUp) { for (const t of ['dragenter', 'dragover']) drop.addEventListener(t, (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); drop.style.outline = '2px dashed var(--primary)'; } }); drop.addEventListener('dragleave', () => (drop.style.outline = '')); drop.addEventListener('drop', (e) => { if (!e.dataTransfer?.files?.length) return; e.preventDefault(); drop.style.outline = ''; upload([...e.dataTransfer.files]); }); }
  on(root, { pick: () => input.click(), rm: async (el) => { if (await confirmBox('Remove this file permanently?', 'Remove')) { await api('DELETE', `/files/${el.dataset.id}`); attachments(root, entity, id); } } });
}
/** Convenience: append an attachments card under a detail page and fill it. */
export function mountAttachments(root, entity, id) {
  let box = $('#attach-box', root); if (!box) { box = document.createElement('div'); box.id = 'attach-box'; box.className = 'mt'; root.append(box); }
  attachments(box, entity, id).catch(() => {});
}
