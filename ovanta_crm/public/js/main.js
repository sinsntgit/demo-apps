import { api, html, raw, setHtml, store, toast, fail, icon, initials, on, applyTheme, allow, $, $$ } from './core.js';
import * as crm from './crm.js';
import * as camp from './campaigns.js';
import * as admin from './admin.js';
import * as mail from './mail.js';
import * as inv from './invoices.js';
import * as bill from './billing.js';
import * as cust from './customize.js';
import { loadCustomization } from './forms.js';
import { forcedSetup } from './security.js';
import * as rec from './records.js';
import { aiSearch } from './search.js';

const app = $('#app');

const NAV = [
  ['Workspace', [['search', 'AI search', 'search'], ['dashboard', 'Dashboard', 'home'], ['contacts', 'Contacts', 'users'], ['accounts', 'Accounts', 'building'], ['deals', 'Deals', 'deal'], ['tasks', 'Tasks', 'task'], ['duplicates', 'Duplicates', 'users', 'contacts.merge']]],
  ['Billing', [['invoices', 'Invoices', 'invoice'], ['receivables', 'Receivables', 'wallet', 'receivables.view'], ['readiness', 'E-invoicing readiness', 'shield', 'readiness.view'], ['billing-settings', 'Billing settings', 'cog', 'billing_settings.view']]],
  ['Marketing', [['campaigns', 'Campaigns', 'mail'], ['segments', 'Segments', 'seg'], ['templates', 'Templates', 'tpl'], ['senders', 'Email senders', 'send', 'senders.view']]],
  ['Admin', [['customize', 'Customisation', 'tpl', 'customization.manage'], ['notifications', 'Notifications', 'bell', 'notifications.view'], ['team', 'Team & roles', 'team', 'users.view'], ['settings', 'Settings', 'cog']]],
];

const ROUTES = [
  [/^dashboard$/, (r) => crm.dashboard(r)], [/^contacts$/, (r) => crm.contacts(r)], [/^contacts\/(\d+)$/, (r, id) => crm.contactDetail(r, id)],
  [/^accounts$/, (r) => crm.accounts(r)], [/^accounts\/(\d+)$/, (r, id) => crm.accountDetail(r, id)],
  [/^deals$/, (r) => crm.deals(r)], [/^deals\/(\d+)$/, (r, id) => crm.dealDetail(r, id)], [/^tasks$/, (r) => crm.tasks(r)],
  [/^campaigns$/, (r) => camp.campaignList(r)], [/^campaigns\/(\d+)$/, (r, id) => camp.campaignDetail(r, id)],
  [/^segments$/, (r) => camp.segments(r)], [/^templates$/, (r) => camp.templates(r)],
  [/^invoices$/, (r) => inv.invoiceList(r, () => bill.importInvoices(() => { location.hash = '#/readiness'; }))], [/^invoices\/new$/, (r) => inv.invoiceEditor(r, null)], [/^invoices\/(\d+)\/edit$/, (r, id) => inv.invoiceEditor(r, id)], [/^invoices\/(\d+)$/, (r, id) => inv.invoiceDetail(r, id)],
  [/^receivables$/, (r) => bill.receivables(r)], [/^readiness$/, (r) => bill.readiness(r, (done) => bill.importInvoices(done))], [/^billing-settings$/, (r) => bill.billingSettings(r)],
  [/^senders$/, (r) => mail.senders(r)], [/^notifications$/, (r) => mail.notifications(r)],
  [/^duplicates$/, (r) => rec.duplicates(r)], [/^search$/, (r) => aiSearch(r)], [/^customize$/, (r) => cust.customize(r)], [/^team$/, (r) => admin.team(r)], [/^settings$/, (r) => admin.settings(r)],
];

function loginView(msg = '') {
  setHtml(app, html`<div class="login"><form class="box" id="login"><div class="brand"><span class="logo"><i></i></span>Ovantaa CRM</div>
    <h2 style="margin-bottom:4px">Sign in</h2><p class="muted" style="margin-top:0">Welcome back — let's close some deals.</p>
    <div class="err" ${msg ? '' : raw('hidden')}>${msg}</div>
    <label>Email<input type="email" name="email" required autocomplete="username" autofocus></label>
    <label>Password<input type="password" name="password" required autocomplete="current-password"></label>
    <button class="btn primary" style="width:100%;justify-content:center">Sign in</button></form></div>`);
  $('#login').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.currentTarget;
    try { const r = await api('POST', '/auth/login', { email: f.email.value, password: f.password.value }); if (r.needs_2fa) return twofaStep(r.challenge); store.user = r.user; await boot(); }
    catch (x) { const el = $('.err', f); el.textContent = x.message; el.hidden = false; }
  });
}

/** Second sign-in step: authenticator code, or a recovery code. */
function twofaStep(challenge, recovery = false) {
  setHtml(app, html`<div class="login"><form class="box" id="tf"><div class="brand"><span class="logo"><i></i></span>Ovantaa CRM</div>
    <h2 style="margin-bottom:4px">Two-factor check</h2><p class="muted" style="margin-top:0">${recovery ? 'Enter one of your saved recovery codes.' : 'Enter the 6-digit code from your authenticator app.'}</p>
    <div class="err" hidden></div>
    <label>${recovery ? 'Recovery code' : 'Code'}<input name="code" ${recovery ? '' : raw('inputmode="numeric" maxlength="7" pattern="[0-9 ]{6,7}"')} autocomplete="one-time-code" required autofocus></label>
    <button class="btn primary" style="width:100%;justify-content:center">Verify</button>
    <p class="small" style="text-align:center"><a href="#" id="tf-alt">${recovery ? 'Use my authenticator app' : 'Use a recovery code instead'}</a> · <a href="#" id="tf-back">Back</a></p></form></div>`);
  $('#tf-alt').addEventListener('click', (e) => { e.preventDefault(); twofaStep(challenge, !recovery); });
  $('#tf-back').addEventListener('click', (e) => { e.preventDefault(); loginView(); });
  $('#tf').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.currentTarget;
    try { const r = await api('POST', '/auth/2fa', { challenge, [recovery ? 'recovery_code' : 'code']: f.code.value }); store.user = r.user; await boot(); }
    catch (x) { const el = $('.err', f); el.textContent = x.message; el.hidden = false; if (/expired/i.test(x.message)) setTimeout(() => loginView(x.message), 1200); }
  });
}

function shell() {
  setHtml(app, html`<div class="shell"><aside class="side" id="side"><div class="brand"><span class="logo"><i></i></span>Ovantaa CRM</div>
    <nav class="nav" aria-label="Main">${NAV.map(([group, items]) => html`<h4>${group}</h4>${items.filter((i) => !i[3] || allow(i[3])).map(([k, l, ic]) => html`<a href="#/${k}" data-nav="${k}">${icon(ic)}${l}</a>`)}`)}</nav>
    <div class="me"><span class="avatar">${initials(store.user.name)}</span><div class="who"><b>${store.user.name}</b><span>${store.user.role_label || store.user.role}</span></div><button class="btn sm" data-act="logout" title="Sign out">Sign out</button></div></aside>
    <main class="main"><button class="btn menu-btn" data-act="menu" style="margin-bottom:12px" aria-label="Open menu">☰ Menu</button><div id="view"></div></main></div>`);
  on($('.shell'), { menu: () => $('#side').classList.toggle('open'), logout: async () => { await api('POST', '/auth/logout'); store.user = null; location.hash = '#/login'; loginView(); } });
}

let renderId = 0;
async function route() {
  if (!store.user) return;
  const path = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('?')[0];
  if (path === 'login') { location.hash = '#/dashboard'; return; }
  const view = $('#view'); if (!view) return;
  const id = ++renderId;
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', path === a.dataset.nav || path.startsWith(a.dataset.nav + '/')));
  $('#side')?.classList.remove('open');
  for (const [re, fn] of ROUTES) {
    const m = re.exec(path);
    if (m) {
      // Each navigation gets its own container, so a slow earlier route can only write into a detached node.
      const target = document.createElement('div');
      setHtml(target, html`<div class="empty">Loading…</div>`);
      view.replaceChildren(target);
      try { await fn(target, ...m.slice(1)); } catch (e) { if (id === renderId) setHtml(target, html`<div class="card empty"><h2>Something went wrong</h2><p>${e.message}</p><a class="btn" href="#/dashboard">Go to dashboard</a></div>`); }
      return;
    }
  }
  setHtml(view, html`<div class="card empty"><h2>Page not found</h2><a class="btn" href="#/dashboard">Go to dashboard</a></div>`);
}

async function boot() {
  if (store.user?.limited) return forcedSetup(app, async () => { store.user = (await api('GET', '/auth/me')).user; boot(); }, async () => { await api('POST', '/auth/logout'); store.user = null; loginView(); });
  try { store.meta = await api('GET', '/meta'); await loadCustomization(); } catch { return loginView(); }
  shell();
  if (!location.hash || location.hash === '#/login') location.hash = '#/dashboard';
  route();
}

window.addEventListener('hashchange', route);
window.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && store.user && !store.user.limited) { e.preventDefault(); location.hash = '#/search'; } });
window.addEventListener('ovantaa:logout', () => loginView('Your session expired. Please sign in again.'));
(async () => {
  try { applyTheme(await api('GET', '/theme')); } catch {}
  try { const r = await api('GET', '/auth/me'); store.user = r.user; await boot(); } catch { loginView(); }
})();
