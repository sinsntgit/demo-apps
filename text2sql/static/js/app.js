import { h, fill, api, state, initTheme, toggleTheme, fail } from './core.js';
import { loginView, setupView } from './auth.js';
import { chatView, historyView } from './chat.js';

const app = document.getElementById('app');
initTheme();
document.addEventListener('click', () => document.querySelectorAll('.menu .pop').forEach(p => p.classList.add('hidden')));

const ROUTES = [
  { path: 'ask', label: 'Ask', icon: '💬', roles: null, full: true, load: async (root, arg) => chatView(root, arg ? Number(arg) : null) },
  { path: 'reports', label: 'Reports', icon: '📄', roles: null, load: async (root, arg) => (await import('./reports.js')).reportsView(root, arg) },
  { path: 'history', label: 'History', icon: '🕘', roles: null, load: async root => historyView(root) },
  { sect: 'Curate', roles: ['admin', 'steward'] },
  { path: 'training', label: 'Training', icon: '🎓', roles: ['admin', 'steward'], load: async (root, arg) => (await import('./training.js')).trainingView(root, arg) },
  { path: 'data', label: 'Data models', icon: '🗄', roles: ['admin', 'steward'], load: async root => (await import('./connections.js')).connectionsView(root) },
  { path: 'dashboard', label: 'Dashboard', icon: '📈', roles: ['admin', 'steward'], load: async root => (await import('./dashboard.js')).dashboardView(root) },
  { sect: 'Manage', roles: ['admin'] },
  { path: 'admin', label: 'Admin', icon: '⚙', roles: ['admin'], load: async (root, arg) => (await import('./admin.js')).adminView(root, arg) },
  { sect: 'Support', roles: null },
  { path: 'help', label: 'Help', icon: '❓', roles: null, load: async (root, arg) => (await import('./help.js')).helpView(root, arg) },
  { path: 'account', label: 'My account', icon: '👤', roles: null, hidden: true, load: async root => (await import('./account.js')).accountView(root, boot) },
];
const allowed = r => !r.roles || r.roles.includes(state.me.role);

async function boot() {
  try { state.me = await api('GET', '/api/auth/me'); }
  catch { state.me = null; return fill(app, loginView(boot)); }
  document.title = state.me.app_name;
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
  const nav = h('nav', { class: 'nav' }, h('div', { class: 'brand' }, h('i', {}, '▮▮'), state.me.app_name),
    ROUTES.filter(r => allowed(r) && !r.hidden).map(r => r.sect ? h('div', { class: 'sect' }, r.sect) : h('a', { href: '#/' + r.path, 'data-path': r.path }, h('span', {}, r.icon), r.label)),
    h('div', { class: 'who' }, h('a', { href: '#/account', 'data-path': 'account', style: 'padding:4px 0' }, h('div', {}, h('b', {}, state.me.name || state.me.email), h('div', { class: 'dim' }, state.me.role))),
      h('div', { class: 'row', style: 'margin-top:6px' }, h('button', { class: 'btn sm', onclick: toggleTheme, title: 'Switch light / dark theme' }, '◐ Theme'),
        h('button', { class: 'btn sm', onclick: async () => { await api('POST', '/api/auth/logout'); location.hash = ''; location.reload(); } }, 'Sign out'))));
  fill(app, h('div', { class: 'shell' }, nav, main));

  let token = 0;
  async function route(fresh) {
    if (!fresh && await recheck()) return;          // signed-in user or role changed: the whole shell was rebuilt
    const [, path = 'ask', arg] = location.hash.split('/');
    const r = ROUTES.find(x => x.path === path && allowed(x)) || ROUTES[0];
    nav.querySelectorAll('a').forEach(a => a.classList.toggle('on', a.dataset.path === r.path));
    const mine = ++token;
    const root = h('div', {}, h('div', { class: 'page' }, h('span', { class: 'spinner' })));
    fill(main, root);
    try { await r.load(root, arg); } catch (e) { if (mine === token) fill(root, h('div', { class: 'page' }, h('div', { class: 'banner bad' }, e.message))); }
  }
  window.onhashchange = e => {
    // chat keeps its own URL in sync with replaceState; only re-render on real navigation
    route();
  };
  route(true);
}
boot();
