import { api, html, raw, setHtml, store, toast, fail, on, $, modal, confirmBox, field, fmtDateTime } from './core.js';

const COMMON = ['USD', 'SAR', 'AED', 'INR', 'EUR', 'GBP', 'QAR', 'KWD', 'BHD', 'OMR', 'EGP', 'SGD', 'AUD', 'CAD', 'JPY', 'CNY', 'CHF', 'ZAR'];

/** Settings → Currencies: the pair, one rate per year, and the change history. */
export async function currencyCard(root, { admin }) {
  const d = await api('GET', '/currency'); const draw = () => currencyCard(root, { admin });
  const Y = new Date().getFullYear(); const missing = d.c2 && !d.rates.some((r) => r.year === Y);
  const opt = (cur) => [...new Set([...COMMON, cur].filter(Boolean))].map((c) => html`<option value="${c}" ${c === cur ? raw('selected') : ''}>${c}</option>`);
  setHtml(root, html`<div class="card"><div class="hd"><h2>💱 Deal currencies</h2></div><div class="bd">
    <p class="small muted" style="margin-top:0">Deals are entered in <b>Currency 1</b> and also shown in <b>Currency 2</b>, converted with the rate for the deal's year: for open deals the year of the expected close date (or of the created date if there is none); for won/lost deals the year they closed. Changing a rate updates every deal of that year.</p>
    ${admin ? html`<form id="fxpair" style="display:flex;gap:10px;align-items:end;flex-wrap:wrap">
        <label>Currency 1 (deals are entered in)<select name="c1">${opt(d.c1)}</select></label>
        <label>Currency 2 (converted to)<select name="c2"><option value="">— none —</option>${opt(d.c2)}</select></label>
        <button class="btn">Save currencies</button></form>`
      : html`<p>Currency 1: <b>${d.c1}</b> · Currency 2: <b>${d.c2 || 'not set'}</b></p>`}
    ${d.c2 ? html`<hr style="border:0;border-top:1px solid var(--line);margin:14px 0">
      <div style="display:flex;align-items:center;gap:8px"><h3 style="margin:0">Yearly rates · 1 ${d.c1} = ? ${d.c2}</h3><span class="grow"></span>${admin ? html`<button class="btn sm primary" data-act="add">+ Add year</button>` : ''}</div>
      ${missing ? html`<div class="small" style="margin:8px 0;padding:8px 12px;border-radius:8px;background:#fef3c7;color:#78350f">No rate for ${Y} yet — deals in ${Y} use the latest earlier year${d.rates.length ? '' : ' (none set, so they are not converted)'}.</div>` : ''}
      ${d.deals_without_rate ? html`<p class="small" style="color:var(--bad)">${d.deals_without_rate} deal(s) have no rate for their year or any earlier year.</p>` : ''}
      ${d.rates.length ? html`<div class="tablewrap"><table><thead><tr><th>Year</th><th>Rate</th><th>Note</th><th>Last changed</th><th></th></tr></thead><tbody>${d.rates.map((r) => html`<tr>
        <td><b>${r.year}</b>${r.year === Y ? html` <span class="badge plain">current</span>` : ''}</td><td class="mono">1 ${d.c1} = ${r.rate} ${d.c2}</td><td class="small">${r.note || ''}</td>
        <td class="small muted">${r.updated_by_name || ''} · ${fmtDateTime(r.updated_at)}</td>
        <td>${admin ? html`<button class="btn sm" data-act="edit" data-y="${r.year}" data-r="${r.rate}" data-n="${r.note || ''}">Edit</button> <button class="btn sm danger" data-act="del" data-y="${r.year}" aria-label="Remove ${r.year} rate">✕</button>` : ''}</td></tr>`)}</tbody></table></div>`
        : html`<p class="muted small">No rates yet.</p>`}
      ${d.other_pairs.length ? html`<p class="small muted">Kept from earlier currency settings: ${d.other_pairs.map((p) => `${p.c1}→${p.c2} (${p.first_year}–${p.last_year}, ${p.years} rates)`).join(', ')}. They come back if you switch to that pair again.</p>` : ''}
      <details style="margin-top:10px"><summary class="small" style="cursor:pointer">Change history (${d.history.length})</summary>
        <div class="tablewrap" style="max-height:260px;overflow:auto"><table class="small"><tbody>${d.history.map((h) => html`<tr><td class="nowrap">${fmtDateTime(h.changed_at)}</td><td>${h.changed_by_name || ''}</td>
          <td>${h.year ? html`<b>${h.year}</b> ${h.c1}→${h.c2}: ${h.old_rate ?? '—'} → ${h.new_rate ?? 'removed'}` : ''}${h.note ? html` <span class="muted">${h.note}</span>` : ''}</td></tr>`)}</tbody></table></div></details>`
    : html`<p class="small muted">Choose Currency 2 to start converting deal amounts.</p>`}
  </div></div>`);
  if (!admin) return;
  $('#fxpair', root).addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.currentTarget;
    try { store.meta.currency = await api('PUT', '/currency', { c1: f.c1.value, c2: f.c2.value }); toast('Currencies saved — reload other open tabs to see them', 'ok'); draw(); } catch (x) { fail(x); }
  });
  const rateModal = (year, rate, note = '') => modal({ title: year ? `Rate for ${year}` : 'Add a yearly rate', submitLabel: 'Save rate',
    body: html`${year ? '' : field({ name: 'year', label: 'Year', type: 'number', min: 1990, max: 2100, required: true, default: Y })}
      <label>1 ${d.c1} = how many ${d.c2}?<span class="req">*</span><input name="rate" type="number" step="any" min="0" required value="${rate || ''}" placeholder="e.g. 3.75"></label>
      ${field({ name: 'note', label: 'Note (optional)', placeholder: 'e.g. budget rate approved by finance' }, { note })}
      <p class="small muted">Every deal whose rate date falls in this year is converted with it. The previous value stays in the change history.</p>`,
    onSubmit: async (f) => { await api('PUT', `/currency/rates/${year || f.year.value}`, { rate: f.rate.value, note: f.note.value }); store.meta.currency = (await api('GET', '/meta')).currency; toast('Rate saved', 'ok'); draw(); } });
  on(root, {
    add: () => rateModal(null), edit: (el) => rateModal(Number(el.dataset.y), el.dataset.r, el.dataset.n),
    del: async (el) => { if (await confirmBox(`Remove the ${el.dataset.y} rate? Deals of that year will use the latest earlier year's rate.`, 'Remove')) { await api('DELETE', `/currency/rates/${el.dataset.y}`); store.meta.currency = (await api('GET', '/meta')).currency; toast('Rate removed'); draw(); } },
  });
}
