import {
  api, html, raw, setHtml, esc, on, store, toast, fail, modal, confirmBox, field, formValues, fmtDate, fmtDateTime, ago, $, $$, allow,
} from './core.js';
import { fmt, invLabel } from './invoices.js';
import { readTable, INVOICE_FIELDS, guessInvoiceMapping, applyInvoiceMapping } from './csv.js';

const chip = (cls, text) => html`<span class="badge ${cls}">${text}</span>`;
const page = (title, actions = '') => html`<div class="topbar"><h1>${title}</h1><span class="grow"></span>${actions}</div>`;

// ================= Receivables (owner dashboard) =================
export async function receivables(root) {
  const draw = async () => {
    const [s, claims] = await Promise.all([api('GET', '/receivables'), api('GET', '/payment-claims')]);
    const cur = s.currency; const k = s.kpis; const maxA = Math.max(...s.aging.map((b) => b.amount), 1);
    const maxF = Math.max(...s.forecast.weeks.map((w) => w.amount), 1), maxM = Math.max(...s.monthly.map((m) => Math.max(m.billed, m.collected)), 1);
    const colors = ['var(--ok)', '#84cc16', 'var(--warn)', '#f97316', 'var(--bad)'];
    setHtml(root, html`${page('Receivables', html`<a class="btn" href="#/invoices?status=overdue">Overdue invoices</a>${allow('billing_settings.edit') ? html`<button class="btn" data-act="runrem" title="Send any due reminders now">Run reminders now</button>` : ''}<a class="btn primary" href="#/invoices/new">+ New invoice</a>`)}
      <div class="grid g4"><div class="card kpi"><div class="l">Outstanding</div><div class="v">${fmt(k.outstanding, cur)}</div><div class="s">${k.open_invoices} open invoices</div></div>
        <div class="card kpi"><div class="l">Overdue</div><div class="v" style="color:${k.overdue ? 'var(--bad)' : 'inherit'}">${fmt(k.overdue, cur)}</div><div class="s">${k.overdue_invoices} invoices · ${k.outstanding ? Math.round((k.overdue / k.outstanding) * 100) : 0}% of outstanding</div></div>
        <div class="card kpi"><div class="l">Collected this month</div><div class="v">${fmt(k.collected_this_month, cur)}</div><div class="s">billed ${fmt(k.billed_this_month, cur)}${k.collection_rate != null ? ` · ${Math.round(k.collection_rate * 100)}%` : ''}</div></div>
        <div class="card kpi"><div class="l">Days to get paid</div><div class="v">${k.dso ?? '—'}<span class="small muted"> DSO</span></div><div class="s">${k.avg_days_to_pay != null ? `customers pay in ~${k.avg_days_to_pay} days` : 'no paid invoices yet'}</div></div></div>
      ${claims.length ? html`<div class="banner mt"><b>${claims.length} customer payment notice${claims.length === 1 ? '' : 's'} to check.</b> ${claims.slice(0, 5).map((c) => html`<div class="small"><a href="#/invoices/${c.invoice_id}">${c.number}</a> · ${c.buyer_name} says they paid <b>${fmt(c.amount, c.currency)}</b>${c.reference ? ` (ref ${c.reference})` : ''}</div>`)}</div>` : ''}
      <div class="grid g2 mt"><div class="card"><div class="hd"><h2>Ageing — who owes what, and for how long</h2></div><div class="bd">${s.aging.map((b, i) => html`<div class="bucket"><span>${b.label}</span><div class="t"><i style="width:${(b.amount / maxA) * 100}%;background:${colors[i]}"></i></div><span class="right small"><b>${fmt(b.amount, '')}</b> · ${b.count}</span></div>`)}</div></div>
        <div class="card"><div class="hd"><h2>Cash-in forecast · next 8 weeks</h2><span class="grow"></span><span class="small muted">${fmt(s.forecast.total_8w, cur)}</span></div><div class="bd"><div class="mini-bars">${s.forecast.weeks.map((w, i) => html`<div class="b"><span title="${w.count} invoices">${w.amount ? fmt(w.amount, '').replace('.00', '') : ''}</span><i style="height:${Math.max(2, (w.amount / maxF) * 100)}%"></i><span>${i ? `+${i}w` : 'now'}</span></div>`)}</div>
          <p class="small muted mt">Based on each invoice's due date plus how late that customer has historically paid. Overdue invoices with no history are assumed to arrive in about 2 weeks.${s.forecast.beyond ? ` ${fmt(s.forecast.beyond, cur)} is expected after 8 weeks.` : ''}</p></div></div></div>
      <div class="card mt"><div class="hd"><h2>Overdue customers</h2><span class="grow"></span><span class="small muted">chase the biggest first</span></div>${s.overdue_customers.length ? html`<div class="tablewrap"><table><thead><tr><th>Customer</th><th class="right">Overdue</th><th class="right">Outstanding</th><th>Oldest</th><th>Last reminder</th><th>Contact</th><th></th></tr></thead><tbody>
        ${s.overdue_customers.map((c) => html`<tr><td><b>${c.name}</b><div class="small muted">${c.overdue_invoices} overdue of ${c.invoices} open</div></td><td class="right"><b style="color:var(--bad)">${fmt(c.overdue, cur)}</b></td><td class="right">${fmt(c.outstanding, cur)}</td><td>${chip(c.max_days_overdue > 60 ? 'b-bad' : c.max_days_overdue > 30 ? 'b-warn' : 'b-grey', `${c.max_days_overdue} days`)}</td><td class="small">${c.last_reminder ? ago(c.last_reminder) : '<never>'}</td><td class="small">${c.email || ''}<br>${c.phone || ''}</td><td class="nowrap"><a class="btn sm" href="#/invoices?account_id=${c.account_id || ''}&status=overdue">Invoices</a></td></tr>`)}</tbody></table></div>` : html`<div class="empty">🎉 Nothing overdue.</div>`}</div>
      <div class="card mt"><div class="hd"><h2>Billed vs collected · last 6 months</h2></div><div class="bd"><div class="mini-bars" style="height:150px">${s.monthly.map((m) => html`<div class="b"><span>${fmt(m.collected, '').replace('.00', '')}</span><div style="display:flex;gap:3px;align-items:flex-end;width:100%;height:100%;justify-content:center"><i style="width:40%;height:${Math.max(2, (m.billed / maxM) * 100)}%;background:var(--muted);opacity:.5" title="billed ${m.billed}"></i><i style="width:40%;height:${Math.max(2, (m.collected / maxM) * 100)}%" title="collected ${m.collected}"></i></div><span>${new Date(m.month + '-02').toLocaleString(undefined, { month: 'short' })}</span></div>`)}</div><div class="small muted mt">Grey = billed (net of credit notes) · coloured = collected</div></div></div>`);
    on(root, { runrem: async () => { const r = await api('POST', '/reminders/run'); toast(`Reminders: ${r.sent} sent, ${r.tasks} task(s) created`, 'ok'); draw(); } });
  };
  await draw();
}

// ================= E-invoicing readiness =================
export async function readiness(root, importFlow) {
  let onlyUsed = sessionStorage.getItem('readyUsed') !== '0'; let show = sessionStorage.getItem('readySev') || 'all';
  const draw = async () => {
    const r = await api('GET', '/readiness'); const s = r.summary;
    const link = (x) => (x.ref?.type === 'account' ? `#/accounts/${x.ref.id}` : x.ref?.type === 'invoice' ? `#/invoices/${x.ref.id}` : x.ref?.type === 'settings' ? '#/billing-settings' : '#/readiness');
    const sevChip = (x) => chip(x.severity === 'error' ? 'b-bad' : x.severity === 'warning' ? 'b-warn' : 'b-info', x.severity === 'error' ? 'Fix' : x.severity === 'warning' ? 'Check' : 'Info');
    const filt = (a) => a.filter((x) => (show === 'all' || x.severity === show));
    const sec = (title, sub, arr, empty) => html`<div class="card mt"><div class="hd"><h2>${title}</h2><span class="muted small">${sub}</span><span class="grow"></span>${arr.length ? chip(arr.some((x) => x.severity === 'error') ? 'b-bad' : 'b-warn', arr.length) : chip('b-ok', '✓')}</div>${filt(arr).length ? html`<div class="tablewrap"><table><tbody>${filt(arr).slice(0, 200).map((x) => html`<tr><td style="width:70px">${sevChip(x)}</td><td>${x.ref?.label && !x.message.startsWith(x.ref.label) ? html`<b>${x.ref.label}</b> ` : ''}${x.message}${x.source === 'import' ? html` <span class="badge b-grey">imported</span>` : ''}</td><td class="right nowrap"><a class="btn sm" href="${link(x)}">${x.ref?.type === 'invoice' ? 'Open' : 'Fix'}</a></td></tr>`)}</tbody></table></div>` : html`<div class="empty">${empty}</div>`}</div>`;
    const customers = r.sections.customers.filter((c) => !onlyUsed || c.used);
    setHtml(root, html`${page('E-invoicing readiness', html`<select id="sev" aria-label="Show"><option value="all" ${show === 'all' ? raw('selected') : ''}>All findings</option><option value="error" ${show === 'error' ? raw('selected') : ''}>Errors only</option><option value="warning" ${show === 'warning' ? raw('selected') : ''}>Warnings only</option></select><button class="btn" data-act="rescan">Re-scan</button>${allow('invoices.import') ? html`<button class="btn primary" data-act="import">Import & check invoices</button>` : ''}`)}
      <p class="muted" style="margin-top:-8px">Find and fix errors <b>before</b> invoices are submitted — customer data, VAT treatment, mandatory fields, credit notes, advance payments and reconciliation gaps. Rules applied: <b>${r.jurisdiction === 'UAE' ? 'UAE (TRN, 5% VAT, Peppol-style mandatory data)' : 'KSA / ZATCA (15-digit VAT number, buyer address, 15% VAT, reporting & clearance status)'}</b>.</p>
      <div class="grid g4"><div class="card kpi"><div class="l">Errors to fix</div><div class="v" style="color:${s.errors ? 'var(--bad)' : 'var(--ok)'}">${s.errors}</div></div><div class="card kpi"><div class="l">Warnings</div><div class="v" style="color:${s.warnings ? 'var(--warn)' : 'var(--ok)'}">${s.warnings}</div></div>
        <div class="card kpi"><div class="l">Drafts ready to issue</div><div class="v">${s.drafts_ready}<span class="small muted"> / ${s.drafts}</span></div></div><div class="card kpi"><div class="l">Customers with problems</div><div class="v">${s.customers_in_use_with_issues}</div><div class="s">of ${s.customers_checked} checked</div></div></div>
      ${sec('Your business profile', 'seller details printed on every invoice', r.sections.seller, 'Your seller details are complete.')}
      <div class="card mt"><div class="hd"><h2>Customer master data</h2><span class="muted small">missing or invalid VAT/TRN, addresses, duplicates, contact details</span><span class="grow"></span><label class="check" style="margin:0"><input type="checkbox" id="onlyused" ${onlyUsed ? raw('checked') : ''}> only customers with invoices</label></div>${filt(customers).length ? html`<div class="tablewrap"><table><tbody>${filt(customers).slice(0, 300).map((x) => html`<tr><td style="width:70px">${sevChip(x)}</td><td><b>${x.ref.label}</b> ${x.message}${x.used ? '' : html` <span class="muted small">(no invoices yet)</span>`}</td><td class="right"><a class="btn sm" href="${link(x)}">Fix</a></td></tr>`)}</tbody></table></div>` : html`<div class="empty">No customer problems found.</div>`}</div>
      ${sec('Invoices awaiting issue', 'drafts and imported invoices — fix before issuing', r.sections.invoices, 'All drafts pass the checks.')}
      ${sec('Submission status', 'ZATCA clearance / reporting and provider results', r.sections.compliance, 'Everything issued has been submitted.')}
      ${sec('Payments & reconciliation', 'unmatched bank transfers, unconfirmed customer notices', r.sections.reconciliation, 'No reconciliation gaps.')}
      ${sec('Audit chain integrity', `${s.chain_checked} issued documents re-verified (counter, previous-hash link and content hash)`, r.sections.chain, 'The numbering and hash chain is intact — nothing was altered after issue.')}`);
    $('#sev', root)?.addEventListener('change', (e) => { show = e.target.value; sessionStorage.setItem('readySev', show); draw().catch(fail); });
    $('#onlyused', root)?.addEventListener('change', (e) => { onlyUsed = e.target.checked; sessionStorage.setItem('readyUsed', onlyUsed ? '1' : '0'); draw().catch(fail); });
    on(root, { rescan: () => draw(), import: () => importFlow(draw) });
  };
  await draw();
}

// ================= Import invoices (Zoho Books / QuickBooks / Xero / local systems) =================
export function importInvoices(done) {
  let table = null; let map = {};
  const drawMap = (form) => {
    const headers = table[0].map((h, i) => [i, h || `Column ${i + 1}`]); const preview = applyInvoiceMapping(table, map).slice(0, 3);
    setHtml($('#imp_map', form), html`<div class="banner info small"><b>${table.length - 1}</b> rows found. Check the column matching — rows with the same invoice number become one invoice with several lines.</div>
      <div class="mapgrid">${INVOICE_FIELDS.map(([k, label]) => html`<span>${label}</span><select data-map="${k}"><option value="-1">— none —</option>${headers.map(([i, h]) => html`<option value="${i}" ${map[k] === i ? raw('selected') : ''}>${h}</option>`)}</select>`)}</div>
      <div class="small muted mt">Preview: ${preview.map((r) => `${r.invoice_number || '(no number)'} · ${r.customer} · ${r.description} · ${r.qty}×${r.unit_price}`).join('  |  ') || '—'}</div>
      <div class="row mt">${field({ name: 'jurisdiction', label: 'Check against', type: 'select', options: [['KSA', 'Saudi Arabia (ZATCA)'], ['UAE', 'UAE (Peppol / FTA)'], ['IN', 'India (GST)'], ['GEN', 'Any other country']], blank: false }, { jurisdiction: store.billingJur || 'KSA' })}<span></span></div>
      <p class="small muted">Invoices are imported as <b>drafts</b> — nothing is issued or submitted. Customers are matched by VAT/TRN or name and created if missing. Previously imported numbers are skipped.</p>`);
  };
  modal({ title: 'Import invoices from your accounting system', wide: true, submitLabel: 'Import & check',
    body: html`<div class="dropzone" id="imp_drop" tabindex="0" role="button">📄 <b>Drop an export here</b> or click to choose<div class="small">CSV or Excel (.xlsx) exported from Zoho Books, QuickBooks, Xero or any system — one row per invoice line</div><input type="file" id="csvfile" accept=".csv,.tsv,.txt,.xlsx" hidden></div><div id="imp_file" class="small muted mt"></div><div id="imp_map" class="mt"></div>`,
    onOpen: (form) => {
      const input = $('#csvfile', form), drop = $('#imp_drop', form);
      const load = async (file) => { if (!file) return; try { table = await readTable(file); map = guessInvoiceMapping(table[0]); setHtml($('#imp_file', form), html`📎 ${file.name}`); drawMap(form); } catch (x) { table = null; setHtml($('#imp_map', form), html`<div class="err">${x.message}</div>`); } };
      drop.addEventListener('click', () => input.click()); input.addEventListener('change', () => load(input.files[0]));
      ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); })); ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
      drop.addEventListener('drop', (e) => load(e.dataTransfer.files[0]));
      form.addEventListener('change', (e) => { if (e.target.dataset.map) { const j = form.jurisdiction?.value; map[e.target.dataset.map] = Number(e.target.value); drawMap(form); if (j && form.jurisdiction) form.jurisdiction.value = j; } });
    },
    onSubmit: async (form) => {
      if (!table) throw new Error('Choose a file first');
      if (map.customer < 0 || map.unit_price < 0) throw new Error('Match at least the customer and unit price columns');
      const rows = applyInvoiceMapping(table, map); if (rows.length > 5000) throw new Error('Limit is 5,000 rows per import');
      const r = await api('POST', '/invoices/import', { rows, jurisdiction: form.jurisdiction.value });
      modal({ title: `Imported ${r.invoices} invoice draft${r.invoices === 1 ? '' : 's'}`, wide: true, hideFooter: true,
        body: html`<div class="pill-row" style="margin-bottom:10px">${chip('b-ok', `${r.clean} clean`)}${chip('b-warn', `${r.with_warnings} with warnings`)}${chip('b-bad', `${r.with_errors} with errors`)}${r.skipped_duplicates ? chip('b-grey', `${r.skipped_duplicates} skipped (already imported)`) : ''}${r.accounts_created ? chip('b-info', `${r.accounts_created} customers created`) : ''}</div>
          <div class="tablewrap" style="max-height:340px;overflow:auto"><table><tbody>${r.results.map((x) => html`<tr><td><b>${x.id ? html`<a href="#/invoices/${x.id}/edit" data-close>${x.number}</a>` : x.number}</b> <span class="muted small">${x.customer || ''}</span></td><td>${x.skipped ? chip('b-grey', x.skipped) : x.failed ? chip('b-bad', x.failed) : x.errors ? chip('b-bad', `${x.errors} error${x.errors === 1 ? '' : 's'}`) : x.warnings ? chip('b-warn', `${x.warnings} warning${x.warnings === 1 ? '' : 's'}`) : chip('b-ok', 'ready')}${x.top?.length ? html`<div class="small muted">${x.top.join(' · ')}</div>` : ''}</td></tr>`)}</tbody></table></div>
          <p class="small muted mt">Open each draft to fix the highlighted problems, or use <a href="#/readiness" data-close>E-invoicing readiness</a> for the full exception list.</p>` });
      done?.();
    } });
}

// ================= Billing settings =================
export async function billingSettings(root) {
  const ro = allow('billing_settings.edit') ? '' : raw('disabled');
  const { settings: s, issues, regimes, presets, states } = await api('GET', '/billing/settings'); const admin = allow('billing_settings.edit');
  const jur = s.jurisdiction; const gulf = jur === 'KSA' || jur === 'UAE'; const IN = jur === 'IN'; const GEN = jur === 'GEN';
  const sel = (name, opts, cur, attrs = '') => html`<select name="${name}" ${ro} ${raw(attrs)}>${opts.map(([v, l]) => html`<option value="${v}" ${String(v) === String(cur) ? raw('selected') : ''}>${l}</option>`)}</select>`;
  const senders = store.meta.senders.filter((x) => x.active);
  const F = (n, label, v, o = {}) => html`<label>${label}<input name="${n}" value="${v ?? ''}" ${o.type ? raw(`type="${o.type}"`) : ''} ${o.ph ? raw(`placeholder="${esc(o.ph)}"`) : ''} ${o.dir ? raw(`dir="${o.dir}"`) : ''} ${ro}></label>`;
  const sch = s.reminders.schedule;
  setHtml(root, html`${page('Billing settings', admin ? html`<button class="btn primary" data-act="save">Save settings</button>` : '')}
    ${!admin ? html`<div class="banner info small">Only an administrator can change billing settings.</div>` : ''}
    ${issues.filter((i) => i.severity === 'error').length ? html`<div class="banner bad"><b>Your business profile is incomplete — invoices cannot be issued yet.</b>${issues.filter((i) => i.severity === 'error').map((i) => html`<div class="small">• ${i.message}</div>`)}</div>` : ''}
    <form id="bs" class="grid g2" style="align-items:start"><div style="display:grid;gap:16px">
      <div class="card"><div class="hd"><h2>Invoicing mode</h2></div><div class="bd">
        <label>Country rules<select name="jurisdiction" data-switch ${ro}>${Object.entries(regimes).map(([k, r]) => html`<option value="${k}" ${jur === k ? raw('selected') : ''}>${r.label}</option>`)}</select></label>
        ${GEN ? html`<label>Country<select name="country" data-switch ${ro}>${Object.entries(presets).map(([k, p]) => html`<option value="${k}" ${s.country === k ? raw('selected') : ''}>${p.name}${k !== 'OTHER' ? ` — ${p.tax}${p.rate ? ' ' + p.rate + '%' : ''}, ${p.currency}` : ''}</option>`)}</select></label>` : ''}
        <p class="small muted" style="margin-bottom:0">${gulf ? 'Bilingual tax invoices, strict VAT-number and address checks, QR code, hash chain and (optionally) submission to the tax authority through your provider.' : IN ? 'GST tax invoices: GSTIN checks, place of supply, CGST + SGST within your state or IGST across states, HSN/SAC codes and amount in words.' : 'Plain invoices in English with your own tax name, rate and tax-ID label. Choosing a country fills in typical defaults — check them against your own registration.'}
          Changing this applies to new invoices; invoices already created keep the rules they were made under.</p></div></div>
      <div class="card"><div class="hd"><h2>Business profile</h2></div><div class="bd">
        <div class="row">${F('seller_name', 'Registered business name', s.seller_name)}${gulf ? F('seller_name_ar', 'Business name (Arabic)', s.seller_name_ar, { dir: 'rtl' }) : html`<span></span>`}</div>
        ${GEN || IN ? html`<label class="check"><input type="checkbox" name="tax_registered" ${s.tax_registered !== false ? raw('checked') : ''} ${ro}> Registered for ${s.tax_label || 'tax'} (charge tax and show my tax ID)</label>` : ''}
        <div class="row">${F('vat_number', s.tax_id_label || (jur === 'UAE' ? 'TRN' : 'VAT registration number'), s.vat_number, { ph: jur === 'KSA' ? '15 digits, starts and ends with 3' : jur === 'UAE' ? '15 digits' : IN ? 'e.g. 27ABCDE1234F1Z5' : '' })}${jur === 'KSA' ? F('cr_number', 'Commercial registration (CR)', s.cr_number) : IN ? F('pan', 'PAN (optional)', s.pan, { ph: 'ABCDE1234F' }) : html`<span></span>`}</div>
        ${GEN ? html`<div class="row">${F('tax_label', 'Tax name on invoices', s.tax_label, { ph: 'VAT, GST, Sales tax…' })}${F('tax_id_label', 'Tax ID label', s.tax_id_label, { ph: 'VAT no., EIN, ABN…' })}</div>${F('invoice_title', 'Invoice title', s.invoice_title, { ph: 'Invoice / Tax Invoice / VAT Invoice' })}` : ''}
        <div class="row">${F('a_street', 'Street', s.address.street)}${jur === 'KSA' ? F('a_building_no', 'Building no.', s.address.building_no) : html`<span></span>`}</div>
        <div class="row">${gulf ? F('a_district', 'District', s.address.district) : html`<span></span>`}${F('a_city', 'City', s.address.city)}</div>
        <div class="row">${IN ? html`<label>State (for GST)${sel('a_state', [['', 'Choose…'], ...Object.entries(states).map(([c, n]) => [c, `${n} (${c})`])], s.address.state)}</label>` : F('a_state', 'State / province / region', s.address.state)}${F('a_postal_code', IN ? 'PIN code' : 'Postal code', s.address.postal_code)}</div>
        ${F('a_country_code', 'Country code (2 letters)', s.address.country_code, { ph: 'IN, GB, US, TH…' })}</div></div>
      <div class="card"><div class="hd"><h2>Numbering & defaults</h2></div><div class="bd"><p class="small muted">Numbers are sequential with no gaps and are never reused. Each document type has its own series.${IN ? ' GST allows at most 16 characters per invoice number.' : ''}</p>
        <div class="row">${F('invoice_prefix', 'Invoice prefix', s.invoice_prefix)}${F('credit_prefix', 'Credit note prefix', s.credit_prefix)}</div><div class="row">${F('debit_prefix', 'Debit note prefix', s.debit_prefix)}${F('currency', 'Default currency', s.currency, { ph: 'INR, USD, GBP…' })}</div>
        <div class="row">${F('payment_terms_days', 'Default payment terms (days)', s.payment_terms_days, { type: 'number' })}${F('vat_rate', `Default ${s.tax_label || 'tax'} rate %`, s.vat_rate, { type: 'number' })}</div>
        ${gulf ? html`<label>Default language${sel('default_lang', [['both', 'Arabic + English'], ['en', 'English'], ['ar', 'Arabic']], s.default_lang)}</label>` : ''}</div></div>
      <div class="card"><div class="hd"><h2>Payment details (shown on invoices and the payment page)</h2></div><div class="bd">
        <div class="row">${F('b_bank_name', 'Bank', s.bank.bank_name)}${F('b_account_name', 'Account name', s.bank.account_name)}</div>
        <div class="row">${F('b_account_number', 'Account number', s.bank.account_number)}${F('b_iban', 'IBAN (if you have one)', s.bank.iban, { ph: gulf ? 'SA… / AE…' : 'GB…, DE…' })}</div>
        <div class="row">${F('b_bank_code_label', 'Bank code name', s.bank.bank_code_label, { ph: IN ? 'IFSC' : 'Sort code, Routing no., BSB…' })}${F('b_bank_code', IN ? 'IFSC' : 'Bank code', s.bank.bank_code)}</div>
        <div class="row">${F('b_swift', 'SWIFT / BIC (international payments)', s.bank.swift)}${IN ? F('b_upi', 'UPI ID', s.bank.upi, { ph: 'business@bank' }) : html`<span></span>`}</div>
        <label>Note on the payment page<textarea name="portal_note" rows="2" ${ro}>${s.portal_note}</textarea></label></div></div></div>
    <div style="display:grid;gap:16px">
      <div class="card"><div class="hd"><h2>Automatic payment reminders</h2></div><div class="bd">
        <label class="check"><input type="checkbox" name="r_enabled" ${s.reminders.enabled ? raw('checked') : ''} ${ro}> Send reminders automatically</label>
        <label>Send email from<select name="r_sender" ${ro}><option value="">Default sender</option>${senders.map((x) => html`<option value="${x.id}" ${s.reminders.sender_id === x.id ? raw('selected') : ''}>${x.label} &lt;${x.from_email}&gt;${x.mode === 'simulate' ? ' — simulation' : ''}</option>`)}</select></label>
        <div class="small" style="font-weight:600;margin:8px 0 4px">Schedule — days relative to the due date (negative = before)</div>
        ${[...sch, ...Array.from({ length: Math.max(0, 6 - sch.length) }, () => ({ offset: '', channels: [] }))].map((x, i) => html`<div class="sched" data-row="${i}"><input type="number" name="s_offset_${i}" value="${x.offset}" placeholder="days" ${ro}>${['email', 'whatsapp', 'sms'].map((c) => html`<label class="check" style="margin:0"><input type="checkbox" name="s_${c}_${i}" ${x.channels.includes(c) ? raw('checked') : ''} ${ro}> ${c}</label>`)}</div>`)}
        <div class="row">${F('r_repeat', 'Then repeat every (days, 0 = never)', s.reminders.repeat_days, { type: 'number' })}<span></span></div>
        <label class="check"><input type="checkbox" name="r_tasks" ${s.reminders.create_collection_tasks ? raw('checked') : ''} ${ro}> Create a collection task when an invoice is overdue</label>
        <label class="check"><input type="checkbox" name="r_watasks" ${s.reminders.create_whatsapp_tasks ? raw('checked') : ''} ${ro}> No WhatsApp gateway? Create a task with a ready-to-send WhatsApp link</label>
        <p class="small muted">Messages are ${gulf ? 'bilingual' : 'in English'} and include the payment link and payment details. Customers with a pending "I have paid" notice are not chased.</p></div></div>
      <div class="card"><div class="hd"><h2>WhatsApp / SMS gateway</h2></div><div class="bd"><p class="small muted">Optional. Without a gateway, WhatsApp reminders become one-click links your team sends, and SMS is unavailable. Connect your own gateway (Twilio, Unifonic, WhatsApp Cloud API relay…) that accepts <span class="mono">{channel, to, message, invoice_number}</span> as JSON.</p>
        <label>Mode<select name="m_mode" ${ro}><option value="none" ${s.messaging.mode === 'none' ? raw('selected') : ''}>No gateway</option><option value="webhook" ${s.messaging.mode === 'webhook' ? raw('selected') : ''}>Webhook</option></select></label>${F('m_url', 'Gateway URL', s.messaging.url, { ph: 'https://…' })}
        <label>Bearer token <span class="muted">${s.messaging.has_token ? '(saved — enter a new one to replace)' : ''}</span><input name="m_token" type="password" autocomplete="off" ${ro}></label></div></div>
      <div class="card" ${gulf ? '' : raw('hidden')}><div class="hd"><h2>E-invoicing provider (clearance / reporting)</h2></div><div class="bd">
        <div class="banner info small"><b>How compliance works here.</b> The app validates every invoice, numbers it without gaps, chains it with hashes and builds the UBL 2.1 XML and QR code. <b>ZATCA clearance/reporting needs your onboarding (CSID) and a cryptographically signed invoice</b> — that is done by a certified provider/solution you connect below. Until then invoices stay "Ready · not submitted". The UAE (Peppol) workflow supports validation now; PINT-AE export is planned.</div>
        <label>Mode<select name="p_mode" ${ro}><option value="none" ${s.asp.mode === 'none' ? raw('selected') : ''}>Not connected (validate and prepare only)</option><option value="webhook" ${s.asp.mode === 'webhook' ? raw('selected') : ''}>Submit to my provider (webhook)</option></select></label>${F('p_url', 'Provider URL', s.asp.url, { ph: 'https://…' })}
        <label>Bearer token <span class="muted">${s.asp.has_token ? '(saved — enter a new one to replace)' : ''}</span><input name="p_token" type="password" autocomplete="off" ${ro}></label>
        <p class="small muted">The provider receives JSON with the invoice number, UUID, hash, ICV, QR and base64 XML, and replies <span class="mono">{status: cleared | reported | rejected, message}</span>.</p></div></div></div></form>`);
  const form = $('#bs', root);
  form.addEventListener('change', async (e) => {
    if (!e.target.matches('[data-switch]')) return;
    const toJur = form.elements.jurisdiction.value, toCountry = form.elements.country?.value;
    const label = toJur === 'GEN' && e.target.name === 'country' ? presets[toCountry]?.name : regimes[toJur].label;
    if (!(await confirmBox(`Switch invoicing to “${label}”? Currency, tax rate and labels are set to that country's usual defaults (you can change them). Existing invoices keep their own rules.`, 'Switch', false))) { billingSettings(root); return; }
    try { await api('PUT', '/billing/settings', { jurisdiction: toJur, ...(toJur === 'GEN' ? { country: e.target.name === 'country' ? toCountry : (s.jurisdiction === 'GEN' ? s.country : 'OTHER') } : {}) }); store.billingJur = toJur; toast('Invoicing mode switched', 'ok'); } catch (x) { fail(x); }
    billingSettings(root);
  });
  on(root, { save: async () => {
    const g = (n) => form.elements[n]; const sched = [];
    for (let i = 0; i < 12; i++) { const o = g(`s_offset_${i}`); if (!o) break; const ch = ['email', 'whatsapp', 'sms'].filter((c) => g(`s_${c}_${i}`)?.checked); if (o.value !== '' && ch.length) sched.push({ offset: Number(o.value), channels: ch }); }
    const v = (n) => (g(n) ? g(n).value : undefined);
    const body = { jurisdiction: v('jurisdiction'), country: v('country'), seller_name: v('seller_name'), seller_name_ar: v('seller_name_ar'), vat_number: v('vat_number'), cr_number: v('cr_number'), pan: v('pan'),
      tax_label: v('tax_label'), tax_id_label: v('tax_id_label'), invoice_title: v('invoice_title'), vat_rate: v('vat_rate'), ...(g('tax_registered') ? { tax_registered: g('tax_registered').checked } : {}),
      address: { street: v('a_street'), building_no: v('a_building_no'), district: v('a_district'), city: v('a_city'), state: v('a_state'), postal_code: v('a_postal_code'), country_code: v('a_country_code') },
      invoice_prefix: v('invoice_prefix'), credit_prefix: v('credit_prefix'), debit_prefix: v('debit_prefix'), currency: v('currency'), payment_terms_days: v('payment_terms_days'), default_lang: v('default_lang'),
      bank: { bank_name: v('b_bank_name'), account_name: v('b_account_name'), iban: v('b_iban'), swift: v('b_swift'), account_number: v('b_account_number'), bank_code: v('b_bank_code'), bank_code_label: v('b_bank_code_label'), upi: v('b_upi') }, portal_note: v('portal_note'),
      reminders: { enabled: g('r_enabled').checked, sender_id: g('r_sender').value || null, schedule: sched, repeat_days: g('r_repeat').value, create_collection_tasks: g('r_tasks').checked, create_whatsapp_tasks: g('r_watasks').checked },
      messaging: { mode: g('m_mode').value, url: g('m_url').value, ...(g('m_token').value ? { token: g('m_token').value } : {}) }, asp: { mode: g('p_mode').value, url: g('p_url').value, ...(g('p_token').value ? { token: g('p_token').value } : {}) } };
    const r = await api('PUT', '/billing/settings', body); store.billingJur = r.settings.jurisdiction; toast('Billing settings saved', 'ok'); billingSettings(root);
  } });
}
