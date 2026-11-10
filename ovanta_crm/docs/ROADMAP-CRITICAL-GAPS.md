# Roadmap: closing the "Critical for a team buying a CRM" gaps

Decisions taken (2026-11-10)

| Question | Decision |
|---|---|
| Hosting model | One company, self-hosted, single database (design stays multi-tenant-friendly where cheap) |
| Customisation | Custom **fields + layouts** only (custom modules later, if ever) |
| Email sync | **IMAP-based logging first**, Gmail/Outlook OAuth afterwards |
| Permissions | **Custom roles** with a view/create/edit/delete/export matrix and **own / all** record scope (no field-level hiding yet) |
| Quotes | Products, price books, quotes → **invoice drafts** (no sales/purchase orders) |
| SSO | None for now; two-factor login yes |
| First feature after the foundation | Lead conversion + file attachments + two-factor login |

## Phase 0 — foundation (this phase)
1. Versioned, tested **database migrations** with an automatic backup before any pending migration.
2. **Backup / restore**: `npm run backup`, daily automatic backups with retention, admin download, `npm run restore`.
3. A real **permissions layer**: roles table, permission matrix, own/all scope, one `can()` function used by every route and by the UI. The three existing roles become system roles with *identical* behaviour; admins can then create custom roles.

## Phase 1 — quick wins  (DONE)
Lead conversion (+ duplicate merge) · file attachments · TOTP two-factor login with recovery codes and revocable sessions.

## Phase 2 — customisation  (custom fields + layouts: DONE; quotes → invoices: next)
Custom fields and layouts (field definitions + validated JSON per record; forms, lists, filters, import/export, segments) · products, price books, quotes → invoice drafts.

## Phase 3 — automation
One rules engine: triggers (created, changed, field/stage change, date-based, schedule) × conditions (AND/OR) × actions (set field, assign owner round-robin, create task, send email, notify, signed webhook, create invoice draft). Approvals and stage gates (required fields / comment / approver per stage). Run log and loop protection.

## Phase 4 — connectivity
IMAP email logging (matched contacts only, per-user opt-in) · meetings with `.ics` invites · Gmail/Outlook OAuth later.

## Working rules
Every phase ships with migrations that upgrade existing databases in place, a pre-migration backup, new automated tests, and the full existing suite still green. Estimates are rough (about 11–15 working weeks in total for one developer); email sync is the least predictable item.
