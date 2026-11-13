// Regenerates the screenshots used by the in-app Help (public/help/img/*.jpg).
//   npm run help:shots            (needs Playwright + Chromium: npm i -D playwright && npx playwright install chromium)
// Starts a private copy of the app on a temporary database with demo data, sets up realistic examples and
// photographs each screen. Your own data folder is never touched.
import { createRequire } from 'node:module';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let chromium; try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { console.error('Playwright is needed: npm i -D playwright && npx playwright install chromium'); process.exit(1); }
const OUT = path.join(root, 'public', 'help', 'img'); fs.mkdirSync(OUT, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ovantaa-help-'));

// a stand-in for the Claude API so AI screens have content
const ai = http.createServer((q, r) => { let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => {
  const body = JSON.parse(b || '{}'); r.writeHead(200, { 'content-type': 'application/json' });
  const plan = { explanation: 'Open deals over 50,000, largest first', queries: [{ entity: 'deals', text: '', filters: [{ field: 'amount', op: 'gt', value: '50000', value2: '', values: [] }, { field: 'stage', op: 'in', value: '', value2: '', values: ['prospecting', 'qualification', 'proposal', 'negotiation'] }], sort_field: 'amount', sort_dir: 'desc', limit: 10 }] };
  const draft = { subject: 'Your Q4 pipeline review is ready', subject_alternatives: ['A faster way to close Q4', 'Three ideas for Q4'], preheader: 'Two minutes to read', body_html: '<p>Hi {{first_name|there}},</p><p>Here is a short summary of what changed this quarter…</p>' };
  r.end(JSON.stringify({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(body.output_config ? plan : draft) }] }));
}); });
await new Promise((r) => ai.listen(0, '127.0.0.1', r));
// a local mail catcher so example emails "send" successfully (dev dependency smtp-server)
const { SMTPServer } = createRequire(import.meta.url)('smtp-server');
const sink = new SMTPServer({ authOptional: true, logger: false, onAuth(_a, _s, cb) { cb(null, { user: 1 }); }, onData(stream, _s, cb) { stream.resume(); stream.on('end', () => cb()); } });
await new Promise((r) => sink.listen(0, '127.0.0.1', r));
Object.assign(process.env, { SMTP_TLS_INSECURE: '1', DB_PATH: path.join(work, 'help.db'), DATA_DIR: work, SESSION_SECRET: 'help-shots', SEED_BILLING_DEMO: '0', BASE_URL: 'https://crm.yourcompany.com',
  ANTHROPIC_API_KEY: 'shots', ANTHROPIC_BASE_URL: `http://127.0.0.1:${ai.address().port}` });
const { server } = await import(path.join(root, 'server/index.js'));
const { seedIfEmpty } = await import(path.join(root, 'server/seed.js'));
const { gstinValid } = await import(path.join(root, 'server/regimes.js'));
seedIfEmpty(); await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const failed = [];
const shot = async (name, target = page, opts = {}) => {
  await target.waitForTimeout(350);
  if (!opts.keepToasts) await target.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove())).catch(() => {});
  const el = opts.selector ? target.locator(opts.selector).first() : null;
  await (el || target).screenshot({ path: path.join(OUT, `${name}.jpg`), type: 'jpeg', quality: 82, ...(el ? {} : { fullPage: !!opts.full }) });
  console.log('  ✓', name);
};
const step = async (name, fn) => { try { await fn(); } catch (e) { failed.push(`${name}: ${e.message.split('\n')[0]}`); console.log('  ✗', name, e.message.split('\n')[0]); await page.keyboard.press('Escape').catch(() => {}); } };
const api = (m, u, b) => page.evaluate(async ([m, u, b]) => { const r = await fetch('/api' + u, { method: m, headers: b ? { 'content-type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined }); return r.json().catch(() => ({})); }, [m, u, b]);
const go = async (hash, wait) => { await page.goto(`${base}/#/${hash}`); if (wait) await page.waitForSelector(wait, { timeout: 8000 }); await page.waitForTimeout(400); };
const closeModal = () => page.keyboard.press('Escape');
const gstin = (st, pan) => { for (const c of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ') if (gstinValid(`${st}${pan}1Z${c}`)) return `${st}${pan}1Z${c}`; };

console.log('Taking help screenshots…');
await step('login', async () => { await page.goto(base); await page.waitForSelector('#login'); await shot('login'); });
await page.fill('input[name=email]', 'admin@ovantaa.com'); await page.fill('input[name=password]', 'Ovantaa@123'); await page.click('button.primary'); await page.waitForSelector('.kpi');

// ---------- example data
await api('PUT', '/currency', { c1: 'USD', c2: 'INR' }); await api('PUT', `/currency/rates/${new Date().getFullYear()}`, { rate: 84.2, note: 'Finance budget rate' }); await api('PUT', `/currency/rates/${new Date().getFullYear() - 1}`, { rate: 83.1 });
await api('POST', '/customization/fields', { entity: 'deals', label: 'Deal type', type: 'dropdown', options: ['Direct', 'Partner', 'Reseller'], show_in_list: true, filterable: true });
await api('POST', '/customization/fields', { entity: 'deals', label: 'Partner margin', type: 'percent', visible_when: { field: 'cf_deal_type', values: ['Partner'] } });
const GODADDY = { label: 'SyncSense (GoDaddy)', from_name: 'Santosh T', from_email: 'santosh@syncsense.in', mode: 'smtp', host: 'smtpout.secureserver.net', port: 465, secure: true, username: 'santosh@syncsense.in', password: 'example-only', daily_limit: 250, delay_ms: 0 };
const sender = await api('POST', '/senders', { ...GODADDY, host: '127.0.0.1', port: sink.server.address().port, secure: false });
await page.goto(`${base}/#/dashboard`); await page.reload(); await page.waitForSelector('.kpi');

await step('dashboard', async () => { await go('dashboard', '.kpi'); await shot('dashboard'); });
await step('ai-search', async () => { await go('search', '#sq'); await page.fill('#sq input[name=q]', 'open deals over 50,000 largest first'); await page.click('#sq button.primary'); await page.waitForSelector('#sres .card h2', { timeout: 8000 }); await shot('ai-search'); });
// contacts
await step('contacts', async () => { await go('contacts', 'table tbody tr'); await shot('contacts'); });
await step('contact-import', async () => { await page.click('button[data-act=import]'); await page.waitForSelector('.modal'); await shot('contact-import'); await closeModal(); });
await step('contact-detail', async () => { const c = await api('POST', '/contacts', { first_name: 'Priya', last_name: 'Raman', email: 'priya@blrbooks.in', title: 'Head of Finance', status: 'lead', source: 'Website' }); await go(`contacts/${c.id}`, 'button[data-act=convert]'); globalThis.lead = c; await shot('contact-detail'); });
await step('convert-lead', async () => { await page.click('button[data-act=convert]'); await page.waitForSelector('.modal input[name=amode]'); await page.check('.modal input[name=amode][value=new]'); await page.fill('.modal input[name=aname]', 'Bengaluru Books Pvt Ltd'); await shot('convert-lead'); await closeModal(); });
await step('duplicates', async () => { for (let i = 0; i < 2; i++) await api('POST', '/contacts', { first_name: 'Arjun', last_name: 'Mehta', phone: i ? '+91 98450 11111' : null, email: i ? null : 'arjun@mehta.co' }); await go('duplicates', 'button[data-act=merge]'); await shot('duplicates'); });
await step('accounts', async () => { await go('accounts', 'table tbody tr'); await shot('accounts'); });
// deals
await step('deals-board', async () => { await go('deals', '.dcard'); await shot('deals-board'); });
const deal = await api('POST', '/deals', { name: 'Bengaluru Books — CRM rollout', amount: 48000, stage: 'proposal', close_date: `${new Date().getFullYear()}-12-15`, custom: { cf_deal_type: 'Partner', cf_partner_margin: 12 } });
await step('deal-form', async () => { await go('deals', '.dcard'); await page.click('text=+ New deal'); await page.waitForSelector('.modal input[name=f__name]'); await page.selectOption('.modal select[name=c__cf_deal_type]', 'Partner'); await shot('deal-form'); await closeModal(); });
await step('deal-files', async () => {
  await go(`deals/${deal.id}`, '#attach-box button[data-act=pick]');
  await page.setInputFiles('#attach-box [data-file]', [{ name: 'Proposal v2.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n') }, { name: 'Pricing.csv', mimeType: 'text/csv', buffer: Buffer.from('Item,Price\nLicence,1200\nSupport,300\n') }]);
  await page.waitForSelector('#attach-box a:has-text("Pricing.csv")');
  await shot('deal-detail'); await page.locator('#attach-box').scrollIntoViewIfNeeded(); await shot('deal-files');
});
await step('file-viewer', async () => { await page.click('#attach-box a:has-text("Pricing.csv")'); await page.waitForSelector('.modal td:has-text("Licence")'); await shot('file-viewer'); await closeModal(); });
await step('stage-change', async () => { await page.click('button[data-act=stage]'); await page.waitForSelector('.modal select[name=stage]'); await page.selectOption('.modal select[name=stage]', 'negotiation'); await page.fill('.modal textarea[name=comment]', 'Customer reviewing the PO'); await shot('stage-change'); await page.click('.modal button[type=submit]'); await page.waitForSelector('.toast'); });
await step('stage-history', async () => { await page.locator('.timeline').first().scrollIntoViewIfNeeded(); await shot('stage-history'); });
await step('deals-list', async () => { await go('deals', '.dcard'); await page.click('button:has-text("List")'); await page.waitForSelector('th:has-text("Amount (INR)")'); await shot('deals-list'); await page.click('button:has-text("Board")'); });
// tasks
const users = await api('GET', '/users'); const liam = users.find((u) => u.email.startsWith('liam'));
await step('task-form', async () => { await go('tasks', 'text=+ New task'); await page.click('text=+ New task'); await page.fill('.modal input[name=title]', 'Collect the signed PO'); await page.selectOption('.modal select[name=owner_id]', String(liam.id)); await page.fill('.modal textarea[name=assign_note]', 'Customer promised it this week'); await shot('task-form'); await page.click('.modal button[type=submit]'); await page.waitForSelector('.toast'); });
const task = (await api('GET', '/tasks?q=Collect%20the%20signed&limit=1')).rows?.[0];
await step('task-panel', async () => {
  const ctx2 = await browser.newContext({ viewport: { width: 1360, height: 860 } }); const p2 = await ctx2.newPage();
  await p2.goto(base); await p2.fill('input[name=email]', liam.email); await p2.fill('input[name=password]', 'Ovantaa@123'); await p2.click('button.primary'); await p2.waitForSelector('.kpi');
  await p2.evaluate(async (id) => fetch(`/api/tasks/${id}/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'issue', note: 'Customer needs a revised quote before signing the PO' }) }), task.id);
  await ctx2.close();
  await go('tasks', 'button[data-act=tab]'); await page.click('button[data-act=tab][data-t=by_me]'); await page.waitForSelector('tr.row-issue'); await shot('tasks');
  await page.click('tr.row-issue a[data-act=open]'); await page.waitForSelector('.modal .timeline'); await shot('task-panel'); await closeModal();
});
// campaigns & email
await step('campaign-editor', async () => { await go('campaigns', 'text=+ New campaign'); await shot('campaigns'); await page.click('text=+ New campaign'); await page.fill('.modal input[name=name]', 'Q4 pipeline review'); await page.click('.modal button[type=submit]'); await page.waitForSelector('textarea[name=body_html]'); await page.fill('input[name=subject]', 'Hello {{first_name|there}}'); await shot('campaign-editor'); });
await step('segments', async () => { await go('segments', 'text=+ New segment'); await page.click('text=+ New segment'); await page.waitForSelector('.modal'); await page.fill('.modal input[name=name]', 'Customers in India'); await shot('segment-builder'); await closeModal(); });
await step('senders', async () => { await api('PUT', `/senders/${sender.id}`, GODADDY); await go('senders', 'button[data-act=new]'); await shot('senders'); await api('PUT', `/senders/${sender.id}`, { ...GODADDY, host: '127.0.0.1', port: sink.server.address().port, secure: false }); await page.click('button[data-act=new]'); await page.waitForSelector('.modal #preset'); await shot('sender-form'); await closeModal(); });
await step('notifications', async () => { await go('notifications', 'button[data-act=tab]'); await shot('notifications'); await page.click('button[data-act=tab][data-t=log]'); await page.waitForTimeout(500); await shot('email-log'); });
// invoicing — India GST example
await api('PUT', '/billing/settings', { jurisdiction: 'IN' });
await api('PUT', '/billing/settings', { seller_name: 'SyncSense Technologies Pvt Ltd', vat_number: gstin('27', 'AAPFU0939F'), pan: 'AAPFU0939F', address: { street: '4th floor, Tech Park, FC Road', city: 'Pune', state: '27', postal_code: '411004', country_code: 'IN' }, bank: { bank_name: 'HDFC Bank', account_name: 'SyncSense Technologies Pvt Ltd', account_number: '50100123456789', bank_code: 'HDFC0001234', upi: 'syncsense@hdfcbank' } });
const acc = await api('POST', '/accounts', { name: 'Bengaluru Books Pvt Ltd', vat_number: gstin('29', 'AABCT1332L'), state: 'Karnataka', country_code: 'IN', street: '12 MG Road', city: 'Bengaluru', postal_code: '560001', billing_email: 'accounts@blrbooks.in' });
await page.goto(`${base}/#/dashboard`); await page.reload(); await page.waitForSelector('.kpi');
await step('billing-settings', async () => { await go('billing-settings', 'select[name=jurisdiction]'); await shot('billing-settings'); });
await step('invoice-editor', async () => {
  await go('invoices/new', 'select[name=account_id]'); await page.selectOption('select[name=account_id]', String(acc.id));
  await page.fill('#lines input[data-k=description]', 'CRM implementation services'); await page.fill('#lines input[data-k=hsn_code]', '998314'); await page.fill('#lines input[data-k=qty]', '1'); await page.fill('#lines input[data-k=unit_price]', '100000');
  await page.waitForSelector('#issues :text("Ready to issue")', { timeout: 8000 }); await shot('invoice-editor');
  await page.click('button[data-act=saveissue]'); await page.waitForSelector('.modal input[name=to]', { timeout: 8000 }); await shot('invoice-email'); await closeModal();
});
const inv = (await api('GET', '/invoices?limit=1')).rows[0];
await step('invoice-payment', async () => { await go(`invoices/${inv.id}`, 'button[data-act=pay]'); await shot('invoice-detail'); await page.click('button[data-act=pay]'); await page.waitForSelector('.modal input[name=amount]'); await page.fill('.modal input[name=amount]', '50000'); await shot('invoice-payment'); await page.click('.modal button[type=submit]'); await page.waitForSelector('.toast'); });
await step('invoice-remind', async () => { await page.click('button[data-act=remind]'); await page.waitForSelector('.modal select[name=channel]'); await shot('invoice-reminder'); await closeModal(); });
await step('invoice-print', async () => { await page.goto(`${base}/api/invoices/${inv.id}/print`); await page.waitForSelector('.sheet'); await shot('invoice-print', page, { full: true }); });
await step('invoices', async () => { await go('invoices', 'table tbody tr'); await shot('invoices'); });
await step('receivables', async () => { await go('receivables', '.kpi'); await shot('receivables'); });
await step('readiness', async () => { await go('readiness', 'h1'); await shot('readiness'); });
// two people on one record
await step('conflict', async () => {
  const ctx3 = await browser.newContext({ viewport: { width: 1360, height: 860 } }); const p3 = await ctx3.newPage();
  await p3.goto(base); await p3.fill('input[name=email]', liam.email); await p3.fill('input[name=password]', 'Ovantaa@123'); await p3.click('button.primary'); await p3.waitForSelector('.kpi');
  await page.goto(`${base}/#/deals/${deal.id}`); await page.waitForSelector('h1');
  await p3.goto(`${base}/#/deals/${deal.id}`); await p3.waitForSelector('h1'); await p3.click('button[data-act=edit]'); await p3.waitForSelector('.modal input[name=f__amount]');
  await page.waitForSelector('[data-presence] :text("is editing")', { timeout: 8000 }); await shot('presence');
  await page.click('button[data-act=edit]'); await page.fill('.modal input[name=f__amount]', '52000'); await page.click('.modal button[type=submit]'); await page.waitForSelector('.toast');
  await p3.fill('.modal input[name=f__amount]', '50000'); await p3.click('.modal button[type=submit]'); await p3.waitForSelector('.modal [data-conflicts]'); await shot('conflict', p3); await ctx3.close();
});
// administration
await step('customize', async () => { await go('customize', 'text=Form layout'); await shot('customize'); await page.locator('text=Form layout').first().scrollIntoViewIfNeeded(); await shot('layout-editor'); });
await step('team', async () => { await go('team', 'button[data-act=tab]'); await shot('team'); await page.click('button[data-act=tab][data-t=roles]'); await page.waitForTimeout(500); await shot('roles'); });
await step('settings', async () => { await go('settings', '#fxcard'); await shot('settings'); await page.locator('#fxcard').scrollIntoViewIfNeeded(); await shot('currencies', page, { selector: '#fxcard' }); await page.locator('#seccard').scrollIntoViewIfNeeded(); await shot('security', page, { selector: '#seccard' }); });

await browser.close(); server.close(); ai.close(); sink.close(); fs.rmSync(work, { recursive: true, force: true });
console.log(`\n${fs.readdirSync(OUT).filter((f) => f.endsWith('.jpg')).length} screenshots in ${path.relative(root, OUT)}${failed.length ? `\nNot taken:\n  ${failed.join('\n  ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
