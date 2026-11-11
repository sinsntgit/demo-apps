/**
 * THE access matrix for the API: "METHOD pattern" → permission key.
 * Routes not listed here need only a valid login (see LOGIN_ONLY). A test fails if a new route is in neither list.
 * Record-level "own/all" scope is enforced inside the handlers (entities.js and api3.js) on top of these checks.
 */
const crud = (path, res) => ({ [`GET /api/${path}`]: `${res}.view`, [`GET /api/${path}/:id`]: `${res}.view`, [`POST /api/${path}`]: `${res}.create`, [`PUT /api/${path}/:id`]: `${res}.edit`, [`DELETE /api/${path}/:id`]: `${res}.delete` });
export const ROUTE_PERMS = {
  ...crud('contacts', 'contacts'), ...crud('accounts', 'accounts'), ...crud('deals', 'deals'), ...crud('tasks', 'tasks'),
  'GET /api/contacts/:id/360': 'contacts.view', 'GET /api/accounts/:id/360': 'accounts.view', 'GET /api/deals/:id/360': 'deals.view', 'GET /api/deals/:id/history': 'deals.view',
  'POST /api/tasks/:id/toggle': 'tasks.edit', 'POST /api/deals/:id/stage': 'deals.edit',
  'POST /api/activities': 'activities.create', 'DELETE /api/activities/:id': 'activities.delete',
  'POST /api/contacts/import': 'contacts.import', 'GET /api/contacts/export.csv': 'contacts.export', 'POST /api/contacts/bulk': 'contacts.edit',
  'GET /api/segments': 'segments.view', 'POST /api/segments/preview': 'segments.view', 'POST /api/segments': 'segments.create', 'PUT /api/segments/:id': 'segments.edit', 'DELETE /api/segments/:id': 'segments.delete',
  'GET /api/templates': 'templates.view', 'POST /api/templates': 'templates.create', 'PUT /api/templates/:id': 'templates.edit', 'DELETE /api/templates/:id': 'templates.delete',
  'GET /api/campaigns': 'campaigns.view', 'GET /api/campaigns/:id': 'campaigns.view', 'GET /api/campaigns/:id/recipients': 'campaigns.view', 'POST /api/campaigns': 'campaigns.create', 'POST /api/campaigns/:id/duplicate': 'campaigns.create',
  'POST /api/campaigns/preview': 'campaigns.edit', 'PUT /api/campaigns/:id': 'campaigns.edit', 'DELETE /api/campaigns/:id': 'campaigns.delete',
  'GET /api/campaigns/outbox': 'campaigns.send', 'POST /api/campaigns/:id/test': 'campaigns.send', 'POST /api/campaigns/:id/launch': 'campaigns.send', 'POST /api/campaigns/:id/schedule': 'campaigns.send', 'POST /api/campaigns/:id/unschedule': 'campaigns.send',
  'GET /api/senders': 'senders.view', 'POST /api/senders': 'senders.manage', 'PUT /api/senders/:id': 'senders.manage', 'DELETE /api/senders/:id': 'senders.manage', 'POST /api/senders/:id/verify': 'senders.manage', 'POST /api/senders/:id/test': 'senders.manage',
  'GET /api/email-log': 'email_log.view', 'GET /api/notifications/rules': 'notifications.view', 'POST /api/notifications/rules': 'notifications.manage', 'PUT /api/notifications/rules/:id': 'notifications.manage', 'DELETE /api/notifications/rules/:id': 'notifications.manage', 'POST /api/notifications/rules/:id/test': 'notifications.manage',
  'POST /api/ai/campaign': 'ai.use', 'PUT /api/settings/ai': 'settings.manage', 'PUT /api/theme': 'settings.manage',
  'GET /api/admin/data-counts': 'data.purge', 'POST /api/admin/purge': 'data.purge', 'GET /api/admin/backup': 'data.backup', 'GET /api/admin/backups': 'data.backup', 'POST /api/admin/backups': 'data.backup',
  'GET /api/users': 'users.view', 'POST /api/users': 'users.manage', 'PUT /api/users/:id': 'users.manage', 'GET /api/audit': 'audit.view',
  'GET /api/roles': 'users.view', 'POST /api/roles': 'users.manage', 'PUT /api/roles/:id': 'users.manage', 'DELETE /api/roles/:id': 'users.manage', 'POST /api/roles/:id/duplicate': 'users.manage',
  'GET /api/billing/settings': 'billing_settings.view', 'PUT /api/billing/settings': 'billing_settings.edit', 'GET /api/billing/chain': 'readiness.view', 'POST /api/reminders/run': 'billing_settings.edit',
  'GET /api/invoices': 'invoices.view', 'GET /api/invoices/:id': 'invoices.view', 'GET /api/invoices/:id/xml': 'invoices.view', 'GET /api/invoices/:id/print': 'invoices.view', 'POST /api/invoices/validate': 'invoices.create',
  'POST /api/invoices': 'invoices.create', 'PUT /api/invoices/:id': 'invoices.edit', 'DELETE /api/invoices/:id': 'invoices.delete',
  'POST /api/invoices/:id/issue': 'invoices.issue', 'POST /api/invoices/:id/submit': 'invoices.submit', 'POST /api/invoices/:id/payments': 'invoices.payment', 'PUT /api/payments/:id/reconcile': 'invoices.payment',
  'GET /api/payment-claims': 'invoices.payment', 'POST /api/payment-claims/:id/confirm': 'invoices.payment', 'POST /api/payment-claims/:id/reject': 'invoices.payment',
  'POST /api/invoices/:id/credit-note': 'invoices.notes', 'POST /api/invoices/:id/debit-note': 'invoices.notes', 'POST /api/invoices/:id/remind': 'invoices.remind', 'POST /api/invoices/import': 'invoices.import',
  'POST /api/customization/fields': 'customization.manage', 'PUT /api/customization/fields/:id': 'customization.manage', 'POST /api/customization/fields/:id/archive': 'customization.manage', 'POST /api/customization/fields/:id/restore': 'customization.manage', 'DELETE /api/customization/fields/:id': 'customization.manage',
  'PUT /api/customization/layout/:entity': 'customization.manage', 'DELETE /api/customization/layout/:entity': 'customization.manage',
  'GET /api/contacts/:id/convert-preview': 'contacts.edit', 'POST /api/contacts/:id/convert': 'contacts.edit',
  'GET /api/duplicates/contacts': 'contacts.merge', 'GET /api/duplicates/accounts': 'accounts.merge', 'POST /api/contacts/:id/merge': 'contacts.merge', 'POST /api/accounts/:id/merge': 'accounts.merge',
  'GET /api/files': 'attachments.view', 'POST /api/files': 'attachments.upload', 'GET /api/files/:id/download': 'attachments.view', 'DELETE /api/files/:id': 'attachments.view', 'PUT /api/files/:id': 'attachments.upload', 'GET /api/files/:id/view': 'attachments.view', 'POST /api/files/:id/link': 'attachments.view',
  'POST /api/users/:id/reset-2fa': 'users.manage', 'GET /api/settings/security': 'settings.manage', 'PUT /api/settings/security': 'settings.manage',
  'GET /api/tasks/:id/activity': 'tasks.view', 'POST /api/tasks/:id/status': 'tasks.view', 'POST /api/tasks/:id/comment': 'tasks.view', 'POST /api/tasks/:id/assign': 'tasks.edit',
  'GET /api/receivables': 'receivables.view', 'GET /api/readiness': 'readiness.view',
};
/** Routes that only need a valid login (they expose no restricted data). */
export const LOGIN_ONLY = new Set(['GET /api/auth/me', 'POST /api/auth/password', 'GET /api/meta', 'GET /api/lookup', 'GET /api/dashboard', 'GET /api/notifications/events', 'GET /api/ai/status', 'GET /api/customization',
  'GET /api/tasks-summary', 'POST /api/search/ai', 'GET /api/search/fields', 'GET /api/2fa/status', 'POST /api/2fa/setup', 'POST /api/2fa/enable', 'POST /api/2fa/disable', 'POST /api/2fa/recovery-codes', 'GET /api/sessions', 'DELETE /api/sessions/:id', 'POST /api/sessions/revoke-others']);
