import { api, html, raw, setHtml, store, toast, fail, modal, $, $$ } from './core.js';

/**
 * Customisation → Deals → Deal stages: add, rename, reorder and delete stages and set each stage's default probability.
 * Closed Won / Closed Lost always stay (last, 100 % / 0 %) but can be renamed.
 */
export async function stagesCard(box) {
  let data = await api('GET', '/customization/stages');
  let rows = data.stages.map((s) => ({ ...s })), moves = {}, dirty = false;
  let tmp = 0;
  const usage = (k) => data.usage[k] || { deals: 0, files: 0 };
  const draw = () => {
    const open = rows.filter((r) => !r.closed), closed = rows.filter((r) => r.closed);
    setHtml(box, html`<div class="card mt"><div class="hd"><h2>Deal stages &amp; probabilities</h2>${dirty ? html`<span class="badge proposal plain">unsaved changes</span>` : ''}<span class="grow"></span>
        <button class="btn sm" data-sact="add">+ Add stage</button><button class="btn sm" data-sact="cancel" ${dirty ? '' : raw('disabled')}>Discard</button><button class="btn sm primary" data-sact="save" ${dirty ? '' : raw('disabled')}>Save stages</button></div>
      <div class="bd"><p class="small muted" style="margin-top:0">The order here is the order on the deals board. The probability is filled in automatically when a deal enters the stage (people can still type their own), and drives the weighted forecast. Changing a probability also updates open deals that still use the old default. <b>Closed Won</b> and <b>Closed Lost</b> can be renamed but always stay.</p>
      <div class="tablewrap"><table><thead><tr><th style="width:70px">Order</th><th>Stage name</th><th style="width:130px">Probability %</th><th>Deals · files</th><th></th></tr></thead><tbody>
        ${open.map((r, i) => html`<tr><td class="nowrap"><button class="btn sm" data-sact="up" data-k="${r.key}" ${i === 0 ? raw('disabled') : ''} aria-label="Move up">↑</button><button class="btn sm" data-sact="down" data-k="${r.key}" ${i === open.length - 1 ? raw('disabled') : ''} aria-label="Move down">↓</button></td>
          <td><input data-label="${r.key}" value="${r.label}" maxlength="40" aria-label="Stage name">${r.key.startsWith('new:') ? html`<div class="small muted">new</div>` : ''}</td>
          <td><input type="number" data-prob="${r.key}" value="${r.prob}" min="0" max="100" step="1" aria-label="Probability"></td>
          <td class="small">${r.key.startsWith('new:') ? '—' : `${usage(r.key).deals} · ${usage(r.key).files}`}</td>
          <td><button class="btn sm danger" data-sact="del" data-k="${r.key}" ${open.length === 1 ? raw('disabled title="Keep at least one open stage"') : ''}>Delete</button></td></tr>`)}
        ${closed.map((r) => html`<tr style="background:var(--soft,#f8fafc)"><td class="small muted">closed</td><td><input data-label="${r.key}" value="${r.label}" maxlength="40" aria-label="Stage name"></td><td class="small">${r.prob}% <span class="muted">(fixed)</span></td><td class="small">${usage(r.key).deals} · ${usage(r.key).files}</td><td></td></tr>`)}
      </tbody></table></div>
      ${Object.keys(moves).length ? html`<div class="banner small" style="margin-top:10px">${Object.entries(moves).map(([k, to]) => html`<div>On save, deals and files in “${(data.stages.find((s) => s.key === k) || {}).label}” move to “${(rows.find((r) => r.key === to) || {}).label || to}”.</div>`)}</div>` : ''}
      </div></div>`);
  };
  const change = () => { dirty = true; draw(); };
  box.oninput = (e) => {
    const t = e.target; const k = t.dataset.label ?? t.dataset.prob; if (k === undefined) return;
    const r = rows.find((x) => x.key === k); if (!r) return;
    if (t.dataset.label !== undefined) r.label = t.value; else r.prob = t.value === '' ? '' : Number(t.value);
    if (!dirty) { dirty = true; const b = $('.hd', box); b.querySelector('[data-sact=save]').disabled = false; b.querySelector('[data-sact=cancel]').disabled = false; }
  };
  box.onclick = async (e) => {
    const el = e.target.closest('[data-sact]'); if (!el) return;
    const act = el.dataset.sact, k = el.dataset.k; const open = rows.filter((r) => !r.closed); const i = open.findIndex((r) => r.key === k);
    try {
      if (act === 'add') { const key = `new:${++tmp}`; rows.splice(open.length, 0, { key, label: `New stage ${tmp}`, prob: 50, closed: false }); change(); setTimeout(() => $(`[data-label="${key}"]`, box)?.select(), 0); }
      if (act === 'up' || act === 'down') { const j = act === 'up' ? i - 1 : i + 1; [open[i], open[j]] = [open[j], open[i]]; rows = [...open, ...rows.filter((r) => r.closed)]; change(); }
      if (act === 'del') {
        const r = rows.find((x) => x.key === k); const u = k.startsWith('new:') ? { deals: 0, files: 0 } : usage(k);
        if (u.deals || u.files) {
          const others = rows.filter((x) => x.key !== k);
          modal({ title: `Delete stage “${r.label}”`, submitLabel: 'Delete stage', body: html`<p>${u.deals} deal${u.deals === 1 ? '' : 's'}${u.files ? ` and ${u.files} file${u.files === 1 ? '' : 's'} in its folder` : ''} ${u.deals + u.files === 1 ? 'is' : 'are'} in this stage. Move them to:</p>
            <label>Stage<select name="to">${others.map((x) => html`<option value="${x.key}">${x.label}</option>`)}</select></label><p class="small muted">Each moved deal gets a note in its history. Nothing is changed until you click <b>Save stages</b>.</p>`,
            onSubmit: async (f) => { moves[k] = f.to.value; rows = rows.filter((x) => x.key !== k); for (const [a, b] of Object.entries(moves)) if (b === k) moves[a] = f.to.value; change(); } });
        } else { rows = rows.filter((x) => x.key !== k); for (const [a, b] of Object.entries(moves)) if (b === k) delete moves[a]; change(); }
      }
      if (act === 'cancel') { rows = data.stages.map((s) => ({ ...s })); moves = {}; dirty = false; draw(); }
      if (act === 'save') {
        // new stages are sent without a key; a move to a new stage is sent by its name
        const labelOf = (key) => rows.find((r) => r.key === key)?.label;
        const body = { stages: rows.map((r) => ({ key: r.key.startsWith('new:') ? undefined : r.key, label: r.label, prob: r.prob })),
          moves: Object.fromEntries(Object.entries(moves).map(([a, b]) => [a, b.startsWith('new:') ? labelOf(b) : b])) };
        const r = await api('PUT', '/customization/stages', body);
        store.meta = await api('GET', '/meta');
        toast(`Deal stages saved${r.moved.length ? ` — ${r.moved.map((m) => `${m.deals} deal(s) moved from “${m.from}” to “${m.to}”`).join('; ')}` : ''}`, 'ok');
        data = await api('GET', '/customization/stages'); rows = data.stages.map((s) => ({ ...s })); moves = {}; dirty = false; draw();
      }
    } catch (x) { fail(x); }
  };
  draw();
}
