import { h, fill, api, state, initTheme, toggleTheme, applyBranding } from './core.js';
import { loginView, setupView } from './auth.js';

const app = document.getElementById('app');
initTheme();
document.addEventListener('click', () => document.querySelectorAll('.menu .pop').forEach(p => p.classList.add('hidden')));

const ROUTES = [
  { path: 'library', label: 'Ontologies', icon: '🗂', roles: null, load: async (root, a) => (await import('./library.js')).libraryView(root, a) },
  { path: 'o', hidden: true, nav: 'library', roles: null, load: async (root, a, b, c) => (await import('./workspace.js')).workspaceView(root, a, b, c) },
  { path: 'templates', label: 'Pre-built library', icon: '📚', roles: null, load: async (root, a) => (await import('./templates.js')).templatesView(root, a) },
  { path: 'usage', label: 'AI usage', icon: '📈', roles: null, load: async root => (await import('./usage.js')).usageView(root) },
  { sect: 'Manage', roles: ['admin'] },
  { path: 'admin', label: 'Admin', icon: '⚙', roles: ['admin'], load: async (root, a) => (await import('./admin.js')).adminView(root, a) },
  { sect: 'Support', roles: null },
  { path: 'help', label: 'Help', icon: '❓', roles: null, load: async (root, a) => (await import('./help.js')).helpView(root, a) },
  { path: 'account', label: 'My account', icon: '👤', roles: null, hidden: true, load: async root => (await import('./account.js')).accountView(root, boot) },
];
const allowed = r => !r.roles || r.roles.includes(state.me.role);
const ROLE = { admin: 'Administrator', ontologist: 'Ontologist', viewer: 'Viewer' };

async function boot() {
  try { applyBranding(await api('GET', '/api/auth/branding')); } catch { /* keep the defaults */ }
  try { state.me = await api('GET', '/api/auth/me'); }
  catch { state.me = null; return fill(app, loginView(boot)); }
  document.title = state.brand?.app_name || state.me.app_name;
  if (state.me.requirements.length || state.me.scope !== 'full') return fill(app, setupView(boot));
  shell();
}
state.onAuthLost = () => { if (state.me) { state.me = null; boot(); } };

// The sign-in cookie is shared by every tab of the browser. If someone else signs in from another tab,
// or an administrator changes this person's role, the menu on screen would be out of date - so the
// identity is re-checked on every navigation, whenever the tab regains focus, and after a 403.
let checking = false;
async function recheck() {
  if (!state.me || checking) return false;
  checking = true;
  try {
    const me = await api('GET', '/api/auth/me');
    const changed = me.id !== state.me.id || me.role !== state.me.role || me.scope !== state.me.scope || me.requirements.length !== state.me.requirements.length;
    if (changed) { document.querySelectorAll('.overlay').forEach(o => o.remove()); await boot(); }
    else state.me = me;
    return changed;
  } catch { state.me = null; await boot(); return true; } finally { checking = false; }
}
state.onForbidden = () => { recheck(); };
document.addEventListener('visibilitychange', () => { if (!document.hidden) recheck(); });
window.addEventListener('focus', () => { recheck(); });

function shell() {
  const main = h('div', { class: 'main' });
  const nav = h('nav', { class: 'nav' }, h('div', { class: 'brand' }, h('i', {}, '◈'), state.brand?.app_name || state.me.app_name),
    ROUTES.filter(r => allowed(r) && !r.hidden).map(r => r.sect ? h('div', { class: 'sect' }, r.sect) : h('a', { href: '#/' + r.path, 'data-path': r.path }, h('span', {}, r.icon), r.label)),
    h('div', { class: 'who' }, h('a', { href: '#/account', 'data-path': 'account', style: 'padding:4px 0' }, h('div', {}, h('b', {}, state.me.name || state.me.email), h('div', { class: 'dim' }, ROLE[state.me.role] || state.me.role))),
      h('div', { class: 'row', style: 'margin-top:6px' }, h('button', { class: 'btn sm', onclick: toggleTheme, title: 'Switch light / dark theme' }, '◐ Theme'),
        h('button', { class: 'btn sm', onclick: async () => { await api('POST', '/api/auth/logout'); location.hash = ''; location.reload(); } }, 'Sign out')),
      h('div', { class: 'dim', style: 'margin-top:8px;font-size:11px' }, `Version ${state.me.version}`)));
  fill(app, h('div', { class: 'shell' }, nav, main));

  let token = 0, shown = '';
  async function route(fresh) {
    if (!fresh && await recheck()) return;          // signed-in user or role changed: the whole shell was rebuilt
    const [, path = 'library', a, b, c] = location.hash.split('/');
    const r = ROUTES.find(x => x.path === path && allowed(x)) || ROUTES[0];
    nav.querySelectorAll('a').forEach(el => el.classList.toggle('on', el.dataset.path === (r.nav || r.path)));
    // inside an ontology, switching tab is handled by the workspace itself (no reload, no flicker)
    if (r.path === 'o' && shown === 'o/' + a && state.onTab) return state.onTab(b, c);
    shown = r.path + '/' + (a || '');
    state.onTab = null;
    const mine = ++token;
    const root = h('div', {}, h('div', { class: 'page' }, h('span', { class: 'spinner' })));
    fill(main, root);
    main.scrollTop = 0;
    try { await r.load(root, a, b, c); } catch (e) { if (mine === token) fill(root, h('div', { class: 'page' }, h('div', { class: 'banner bad' }, e.message), h('p', { style: 'margin-top:12px' }, h('a', { href: '#/library' }, '← Back to the library')))); }
  }
  window.onhashchange = () => route();
  route(true);
}
boot();
