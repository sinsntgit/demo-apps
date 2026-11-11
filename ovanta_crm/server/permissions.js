/**
 * Permission model.
 *   resource.action  e.g. "contacts.view", "invoices.issue"
 * Two kinds of action:
 *   'scope' → "none" | "own" | "all"   (record resources: own = records where the user is the owner / creator)
 *   'bool'  → true | false
 * Roles are rows in the `roles` table holding a permissions JSON object { resource: { action: value } }.
 */
const S = 'scope', B = 'bool';
const rec = (extra = {}) => ({ view: S, create: B, edit: S, delete: S, ...extra });
export const RESOURCES = {
  contacts: { label: 'Contacts', scoped: true, actions: rec({ export: B, import: B, merge: B }) },
  accounts: { label: 'Accounts', scoped: true, actions: rec({ export: B, merge: B }) },
  deals: { label: 'Deals', scoped: true, actions: rec({ export: B }) },
  tasks: { label: 'Tasks', scoped: true, actions: rec() },
  activities: { label: 'Activity notes (calls, notes, meetings)', scoped: true, actions: { create: B, delete: S } },
  invoices: { label: 'Invoices', scoped: true, actions: rec({ issue: B, payment: B, remind: B, notes: B, import: B, submit: B }) },
  attachments: { label: 'File attachments (on records you can see) — only Administrators can delete files', actions: { view: B, upload: B } },
  campaigns: { label: 'Campaigns', actions: { view: B, create: B, edit: B, delete: B, send: B } },
  segments: { label: 'Segments', actions: { view: B, create: B, edit: B, delete: B } },
  templates: { label: 'Email templates', actions: { view: B, create: B, edit: B, delete: B } },
  receivables: { label: 'Receivables dashboard', actions: { view: B } },
  readiness: { label: 'E-invoicing readiness', actions: { view: B } },
  billing_settings: { label: 'Billing settings', actions: { view: B, edit: B } },
  senders: { label: 'Email senders', actions: { view: B, manage: B } },
  notifications: { label: 'Notification rules', actions: { view: B, manage: B } },
  email_log: { label: 'Email log', actions: { view: B } },
  ai: { label: 'AI writing assistant', actions: { use: B } },
  settings: { label: 'Company settings (theme, AI key)', actions: { manage: B } },
  users: { label: 'Users & roles', actions: { view: B, manage: B } },
  audit: { label: 'Audit log', actions: { view: B } },
  data: { label: 'Data management', actions: { backup: B, purge: B } },
  customization: { label: 'Customisation (custom fields & form layouts)', actions: { manage: B } },
};
export const ACTION_LABELS = { view: 'View', create: 'Create', edit: 'Edit', delete: 'Delete', export: 'Export', import: 'Import', send: 'Send', issue: 'Issue', payment: 'Payments', remind: 'Email & remind', notes: 'Credit/debit notes', submit: 'Submit', manage: 'Manage', use: 'Use', merge: 'Merge duplicates', upload: 'Upload', backup: 'Backup', purge: 'Delete all' };

const RANK = { none: 0, own: 1, all: 2 };
const scopeVal = (v) => (v === true || v === 'all' ? 'all' : v === 'own' ? 'own' : 'none');

/** Coerce any input into a complete, valid permissions object (unknown keys dropped, missing = denied, edit/delete never exceed view). */
export function normalizePerms(raw) {
  const out = {};
  for (const [res, def] of Object.entries(RESOURCES)) {
    out[res] = {};
    for (const [act, kind] of Object.entries(def.actions)) {
      const v = raw?.[res]?.[act];
      out[res][act] = kind === S ? scopeVal(v) : v === true || v === 'true' || v === 'all';
    }
    if (def.actions.view === S) for (const act of ['edit', 'delete']) if (def.actions[act] === S && RANK[out[res][act]] > RANK[out[res].view]) out[res][act] = out[res].view;
  }
  return out;
}

const build = (fn) => { const o = {}; for (const [res, def] of Object.entries(RESOURCES)) { o[res] = {}; for (const [act, kind] of Object.entries(def.actions)) o[res][act] = fn(res, act, kind); } return o; };
const FULL = build((_r, _a, k) => (k === S ? 'all' : true));
const MANAGER_DENY = ['customization.manage', 'senders.manage', 'notifications.manage', 'billing_settings.edit', 'settings.manage', 'users.view', 'users.manage', 'audit.view', 'data.backup', 'data.purge'];
const MANAGER = build((r, a, k) => (MANAGER_DENY.includes(`${r}.${a}`) ? (k === S ? 'none' : false) : k === S ? 'all' : true));
const REP_GRANTS = {
  contacts: { view: 'all', create: true, edit: 'all', delete: 'own', export: true, import: true }, accounts: { view: 'all', create: true, edit: 'all', delete: 'own', export: true },
  deals: { view: 'all', create: true, edit: 'all', delete: 'own', export: true }, tasks: { view: 'all', create: true, edit: 'all', delete: 'own' }, activities: { create: true, delete: 'own' },
  invoices: { view: 'all', create: true, edit: 'all', delete: 'own' }, attachments: { view: true, upload: true }, campaigns: { view: true, create: true, edit: true }, segments: { view: true, create: true, edit: true }, templates: { view: true, create: true, edit: true }, ai: { use: true },
};
const REP = normalizePerms(REP_GRANTS);

/** The three built-in roles. admin is immutable; manager and rep may be edited by an administrator. */
export const SYSTEM_ROLES = [
  { name: 'admin', label: 'Administrator', description: 'Full access to everything, including users, roles, settings and data management.', permissions: FULL },
  { name: 'manager', label: 'Manager', description: 'All sales, marketing and billing work: send campaigns, issue invoices, record payments. No user, settings or data administration.', permissions: MANAGER },
  { name: 'rep', label: 'Sales rep', description: 'Create and edit CRM records and draft invoices and campaigns. Can delete only their own records. Cannot send campaigns or issue invoices.', permissions: REP },
];

/** Check a permission key against a (normalised) permissions object. Returns 'all'|'own'|false for scope actions, true|false otherwise. */
export function check(perms, key) {
  const [res, act] = String(key).split('.'); const kind = RESOURCES[res]?.actions?.[act];
  if (!kind) return false;
  const v = perms?.[res]?.[act];
  if (kind === S) return v === 'all' || v === 'own' ? v : false;
  return v === true;
}
export const hasPerm = (user, key) => !!check(user?.perms, key);
export const scopeOf = (user, key) => check(user?.perms, key);
/** True if the user may act on this specific record (owner_id compared for 'own'). */
export function canOnRecord(user, key, ownerId) { const s = scopeOf(user, key); return s === 'all' || (s === 'own' && ownerId != null && ownerId === user.id); }
