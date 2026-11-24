# Ovantaa CRM: phased delivery plan

*Prepared 2026-11-24 from Ovantaa 1.27.1. This is the single, ordered plan that merges the two gap analyses:*
- *[`ROADMAP-SALESFOKUZ-GAPS.md`](ROADMAP-SALESFOKUZ-GAPS.md): field-sales gaps, **G1–G31***
- *[`COMPARISON-ZOHO-HUBSPOT.md`](COMPARISON-ZOHO-HUBSPOT.md): general CRM gaps, **Z1–Z40***
- *[`ROADMAP-CRITICAL-GAPS.md`](ROADMAP-CRITICAL-GAPS.md): the earlier roadmap, whose remaining items (quotes, rules engine, email/calendar sync) are folded in below.*

The Salesfokuz and Zoho/HubSpot comparison tables use their own numbering. This plan refers back to those IDs so nothing is lost.

## How the phases are ordered

1. **Cheap, visible and safe first.** Phase 1 is a set of small changes that each ship on their own in days. Together they remove the most common objections in a demo.
2. **Foundations before the features that need them.** Teams and hierarchy (Phase 3) come before targets, approvals, lead routing and manager reports. The API and webhooks (Phase 2) come before web forms, Facebook leads and integrations. Multiple pipelines and products come before quotes and orders.
3. **Office strengths stay ahead.** Mobile and field work start in Phase 6, once the office CRM has caught up with Zoho and HubSpot.
4. **Every phase is releasable.** Each ends with a version number, a migration that upgrades existing databases in place, and an exit checklist.

### Rules that apply to every phase (from the existing roadmap)

- Each database change is a numbered migration in `server/migrations.js`, with an automatic backup before it runs.
- New automated tests, and the whole existing suite (`npm test`, currently 99+ tests) stays green. Browser test (`npm run e2e`) extended where the UI changes.
- Permissions: every new route is added to `route-permissions.js`, and every new resource to the permission matrix in `permissions.js`. System roles keep their current behaviour unless the phase says otherwise.
- In-app help (`public/help/help.html`) and screenshots (`npm run help:shots`) updated, and the README feature list and `package.json` version bumped.
- One new dependency at most per phase, and only when the alternative is worse (the project currently has three runtime dependencies).
- Estimates are for one developer and are rough. They include tests and help pages.

### Overview

| Phase | Theme | Version | Weeks | Closes |
|---|---|---|---|---|
| 1 | **Quick wins** | 1.28 | 3–4 | Z24, Z25, Z17, G10 (part), G8 (part), G11 (part), G27 (part), G12 (part) |
| 2 | **Sell from the CRM** (1:1 email, pipelines, API, forms) | 1.29–1.30 | 5–6 | Z1, Z3, Z15, Z21, Z37, Z35, G8 |
| 3 | **Team structure and targets** | 1.31 | 3–4 | G13, Z28 (part), G9, G10, Z11, Z12, Z31, G12 |
| 4 | **Automation and reporting** | 1.32–1.33 | 5–6 | Z9, Z10, Z13, Z14, Z16, Z17, Z29, Z30, G26 (office part) |
| 5 | **Products, quotes, orders, collections** | 1.34 | 4–5 | Z19, Z20, G16, G17, G18, G19 |
| 6 | **Mobile app (PWA)** | 1.35 | 3–4 | G1, Z39 (part) |
| 7 | **Field force** | 1.36 | 4–5 | G2, G3, G4 (part), G5, G6 |
| 8 | **Expenses, leaves and field reports** | 1.37 | 3 | G14, G15, G26 |
| 9 | **Communication** (mailbox, calendar, WhatsApp, calling) | 1.38 | 4 | Z2, Z4, Z5, Z6, Z7, G23, G24, G25, G27 |
| 10 | **Service desk, industry templates, dealer portal** | 1.39 | 4–6 | G20–G22, G28, G29, Z36 |
| 11 | **Native app, enterprise admin, languages, hosting** | 2.0 | 5–7 | G4, G7, G30, G31, Z22, Z23, Z27, Z32–Z34, Z38, Z40 |

Total about **43–54 developer-weeks**. After Phase 5 (about 20–25 weeks) Ovantaa matches Zoho Professional and HubSpot Professional on office selling, with GST invoicing and collections they don't have. After Phase 8 it matches the Salesfokuz Leadfokuz, Factfokuz and Vanfokuz editions.

---

## Phase 1: Quick wins (version 1.28, 3–4 weeks)

**Goal:** a visible upgrade within a month, without touching the core data model. Every item below is independent, so they can ship one at a time.

| # | Item | What to build | Effort | Gap |
|---|---|---|---|---|
| 1.1 | **Recycle bin** | Deletes of contacts, accounts, deals, tasks and invoices-in-draft become soft deletes (`deleted_at`, `deleted_by`) for 30 days. A "Recycle bin" page lists them with Restore and Delete forever. A daily job purges after 30 days. "Delete all" (existing admin feature) still hard-deletes after the typed confirmation. Unique indexes (contact email) must ignore soft-deleted rows. | 4–5 days | Z24 |
| 1.2 | **Field-change history** | New `field_history` table (record, field, old value, new value, user, time) written wherever records are saved. A "History" tab on contact, account and deal pages. Sensitive fields (password hashes, tokens) are never stored. Custom fields included. | 3–4 days | Z24 |
| 1.3 | **Export every list** | CSV/xlsx export for accounts, deals, tasks, activities and invoices, honouring the user's own/all scope and the `export` permission already defined for each resource. Respects active filters. | 2 days | Z25 |
| 1.4 | **Bulk actions everywhere** | The existing contact bulk bar extended to accounts, deals and tasks: change owner, change stage, add tag, delete, mark done. | 3 days | Z17 |
| 1.5 | **Lead rating** | A built-in Hot / Warm / Cold rating on contacts and deals (colour badge on lists, cards and the board; filter; usable in segments and notification rules). Replaces the "make it a custom field" workaround. | 2 days | G10 |
| 1.6 | **Lead source list** | A managed picklist (Website, Facebook, IndiaMART, JustDial, Referral, Walk-in, Event, Cold call…) with an online/offline group, editable in Settings. Existing free-text sources are mapped on migration and unmatched ones kept as "Other: …". Dashboard tile: leads by source and conversion by source. | 2–3 days | G8 (part) |
| 1.7 | **Click-to-call and click-to-WhatsApp** | `tel:` and `https://wa.me/<number>?text=` buttons on contacts, accounts and deals, with a country-code default in Settings. After the tap, a small prompt logs the outcome as a call or WhatsApp activity. Add `whatsapp` to the activity types. | 2 days | G27 (part), Z7 (part) |
| 1.8 | **Task reminders** | A time on tasks, a reminder email before due (set per task: at due time, 1 hour, 1 day), and an optional daily "due today and overdue" digest per user. The mail pipeline from task assignment is reused. | 3 days | G11 (part) |
| 1.9 | **Leaderboard and "my day" dashboard tiles** | Won value and deal count per owner for this month, a "my tasks today" list, and "deals closing this week". Respects own/all scope. | 2 days | G12 (part) |
| 1.10 | **Map link** | "Open in Maps" next to the address and city on accounts and the invoicing address. | 0.5 day | G6 (part) |
| 1.11 | **Several contacts on a deal** | Deals can have more than one contact with a role (decision maker, influencer, user, billing). The existing single contact stays as the primary. Deal pickers follow the account, as they do today. | 3–4 days | Z21 |
| 1.12 | **Housekeeping** | Update the in-app help and screenshots, update the README feature list, and add the new items to the audit log. | 2 days | |

**Data changes (one migration):** `deleted_at`/`deleted_by` on five tables; `field_history`; `rating` on contacts and deals; `lead_sources` plus a mapping of existing values; `reminder_at` and `reminder_sent` on tasks; `deal_contacts`; `whatsapp` allowed in `activities.type` (needs a table rebuild because of the CHECK constraint, which the migration code already knows how to do).

**Risks:** soft delete touches every query that reads a record (add the filter in one shared place, `entities.js`, rather than per route); history writing must not slow bulk imports (batch it).

**Exit checklist**
- [ ] A deleted contact, deal or account can be restored with its links intact, and disappears from search, segments, campaigns and live updates while in the bin.
- [ ] History shows who changed which field, from what, to what, on all three record types, including imports and bulk actions.
- [ ] A rep exporting sees only their own records; a role without `export` gets a 403.
- [ ] Upgrade test: an existing 1.27.1 database migrates, keeps all data and passes the suite.

---

## Phase 2: Sell from the CRM (versions 1.29 and 1.30, 5–6 weeks)

**Goal:** a rep can run the whole conversation from the CRM, and outside systems can talk to it.

### 2A: 1:1 email and multiple pipelines (1.29, about 3 weeks)

| # | Item | What to build | Effort | Gap |
|---|---|---|---|---|
| 2.1 | **Send email from a contact, account or deal** | A compose window with template picker, merge tags (the campaign merge system), attachments (existing file store), and a choice of sending mailbox (the "pick the mailbox at send time" work from 1.23). The sent message is saved on the timeline as an email activity and in the mailbox's Sent folder. | 6–7 days | Z1 |
| 2.2 | **Open and click tracking on 1:1 email** | Reuse the campaign tracking pixel and link wrapping. Timeline shows "opened 3 times, last 2 hours ago". Optional "notify me when opened" per rep, delivered as an in-app and email alert. Per-user switch, off by default for privacy. | 3–4 days | Z3 |
| 2.3 | **Email templates for 1:1** | Personal and shared templates separate from campaign templates, with a folder or category. | 2 days | Z1 |
| 2.4 | **Multiple pipelines** | Stages belong to a pipeline (for example New business, Renewals, Partners). A pipeline switcher on the board and list, a pipeline per deal, and per-pipeline probabilities. The existing stage set becomes "Default pipeline". Reports and the business review get a pipeline filter. | 5–6 days | Z15 |

### 2B: API, webhooks and web forms (1.30, about 2–3 weeks)

| # | Item | What to build | Effort | Gap |
|---|---|---|---|---|
| 2.5 | **API keys** | Per-user personal tokens (hashed in the database, shown once), scoped to that user's permissions and rate limited. A documented `/api/v1` namespace covering contacts, accounts, deals, tasks, activities and invoices (read, create, update), with pagination, filters and consistent errors. An OpenAPI file in `docs/`. | 6–7 days | Z37 |
| 2.6 | **Outbound webhooks** | Admin-defined endpoints that receive signed (HMAC) JSON on record created, updated, deleted and stage changed, with retries, a delivery log and a "send test" button. The notification rules code supplies the event list. | 4 days | Z37, Z38 (part) |
| 2.7 | **Web-to-lead forms** | A form builder (choose fields, labels, success message or redirect, default owner, source and tags) that produces a copy-paste HTML snippet and a hosted page. The public endpoint has a honeypot, rate limit, optional CAPTCHA, duplicate check against existing contacts, and an email to the owner. | 5 days | Z35, G8 |
| 2.8 | **Generic inbound lead endpoint** | `POST /api/v1/leads` with a lead-only API key, for IndiaMART, JustDial, Google lead forms and Zapier or Make. Recipes for each in the help pages. | 2 days | G8 |
| 2.9 | **Facebook and Instagram Lead Ads** | Meta webhook with verify token and signature check, fetching the lead through the Graph API with a page token stored encrypted in Settings; form fields mapped to contact fields. Only needs a Meta developer app and a public HTTPS address. | 4–5 days | G8 |

**Data changes:** `pipelines`, a `pipeline_id` on stages and deals; `email_messages` linked to contacts and deals; `api_keys`; `webhooks` and `webhook_deliveries`; `web_forms` and `form_submissions`; `integrations` for stored third-party tokens (encrypted with the same helper used for sender passwords).

**Risks:** public endpoints are the first unauthenticated write paths. They need rate limits, size limits and abuse tests. Facebook needs a public URL and Meta app review, which can take weeks, so start that request early. Tracking pixels in 1:1 mail draw privacy concerns, so the off-by-default setting and a visible footer option matter.

**Exit checklist**
- [ ] Send, open and click work end to end against the local fake mail server used in the existing tests.
- [ ] A deal in one pipeline cannot be moved to a stage of another by the API.
- [ ] An API key can do nothing its owner cannot do in the browser (permission tests mirror `permissions.test.js`).
- [ ] A form submission creates one contact, not two, when the same email is submitted twice.

---

## Phase 3: Team structure and targets (version 1.31, 3–4 weeks)

**Goal:** managers see and manage their own team. This is the base for approvals, routing and every manager report afterwards. Today there is no hierarchy: manager and admin both see all records.

| # | Item | What to build | Effort | Gap |
|---|---|---|---|---|
| 3.1 | **Reporting line and teams** | A "reports to" field on each user (no loops; admin can set it), and named teams with a team lead. The Team settings page shows an org tree and lets admins drag a user under a manager. | 4 days | G13 |
| 3.2 | **"Team" record scope** | A third value in the permission matrix between *own* and *all*: your records plus those of everyone below you in the reporting line. Applied to lists, search, segments, exports, dashboards, live updates, the API and campaigns. System roles keep today's behaviour (manager stays *all* until an admin changes it); an admin can now set manager to *team*. | 6–7 days | G13, Z28 (part) |
| 3.3 | **Targets and quotas** | Targets per user or team for a month, quarter or year on: won revenue, number of deals won, new leads, calls and meetings logged, invoices collected. Roll-up from rep to manager to company. Achievement is computed live and shown on the dashboard, the leaderboard and the business review (replacing its single target box). | 5 days | G12, Z31 |
| 3.4 | **Lead and deal assignment rules** | Rules by source, country/state/city, field value or product interest that set the owner on create: round-robin within a team, least-loaded, or a named user, with a fallback and an email to the new owner. Re-assignment of untouched leads after N hours (SLA). A manual "assign" for a selection of records. | 5 days | G9, Z11 |
| 3.5 | **Lead scoring** | Points rules (field values, email opened, form submitted, meeting held) that raise or lower a score and move the rating from Phase 1 between Cold, Warm and Hot automatically. A manual rating still wins. | 4 days | G10, Z12 |
| 3.6 | **Manager views** | "My team" filter and a team activity summary (calls, meetings, new leads, deals won per rep this week), and a team switcher on the dashboard. | 3 days | Z31 |

**Data changes:** `users.reports_to`; `teams`, `team_members`; permission matrix gains the `team` value and every stored custom role is migrated unchanged; `targets`; `assignment_rules`; `lead_scores`.

**Risks:** the scope change is the most invasive item in the plan, because every query that currently branches on own/all gets a third branch. Mitigation: do it behind the single `scopeOf()` function and add a test per resource. Hierarchy lookups need an indexed closure table or a recursive query to stay fast.

**Exit checklist**
- [ ] A manager with *team* scope sees exactly their reports' records (and their reports' reports), nothing else, on every screen, export, search, live update and API call.
- [ ] Moving a rep to another manager changes what both managers see immediately; owners of existing records are not changed.
- [ ] Round-robin spreads 100 test leads evenly and skips inactive users.

---

## Phase 4: Automation and reporting (versions 1.32 and 1.33, 5–6 weeks)

**Goal:** the CRM does the repetitive work, and managers can answer their own questions without a developer.

### 4A: Rules engine and sequences (1.32, about 3 weeks)

| # | Item | What to build | Effort | Gap |
|---|---|---|---|---|
| 4.1 | **Workflow rules engine** | Triggers (record created, field or stage changed, date-based such as "7 days before close date" or "no activity for 14 days", a schedule) × conditions (AND/OR groups on any field) × actions (set a field, assign owner, create a task, send an email from a template, notify, send a webhook, create an invoice draft, add a tag). Run log per rule, loop protection (a rule cannot re-trigger itself more than once), and a dry-run "test on this record". The assignment rules from Phase 3 become one rule type. | 10 days | Z9 |
| 4.2 | **Sequences** | A series of steps (email, wait N days, task, call reminder) that a rep enrols a contact in; it stops on a reply (needs Phase 9 inbox sync for automatic detection; until then, on a manual "replied" tick or an unsubscribe) and respects working days and a daily sending limit. Enrolment from the contact page, a bulk selection, or a rule. Per-step open and click report. | 6–7 days | Z10 |

### 4B: Process control and reports (1.33, about 2–3 weeks)

| # | Item | What to build | Effort | Gap |
|---|---|---|---|---|
| 4.3 | **Stage gates** | Per stage: required fields, a required comment, a required attachment, or a required task. The deal cannot enter the stage until they are met, from the board, form and API alike. | 3–4 days | Z13 |
| 4.4 | **Approvals** | A rule action "ask for approval" (for example a discount above X, a deal above Y, moving to Closed Won). Approver is the reporting manager (Phase 3), a named user or a role; approve or reject by email link or in the app; blocked change is held until then. | 5 days | Z14 |
| 4.5 | **Report builder** | Choose a record type, filters, grouping, columns, and a chart (bar, line, pie, table, funnel); save, share by role, and add to a dashboard. Custom fields are available as columns and filters. | 8–9 days | Z29 |
| 4.6 | **Custom dashboards** | A drag-and-arrange dashboard per user or role from tiles (saved reports, the Phase 1 tiles, targets). | 3 days | Z29 |
| 4.7 | **Scheduled reports** | Email any saved report as a table, CSV or xlsx on a daily, weekly or monthly schedule to chosen users and external addresses. Includes the business review. | 3 days | Z30, G26 (part) |
| 4.8 | **Guided selling hints** | Per stage: a checklist or script shown on the deal (for example qualification questions). Light version of playbooks, no extra engine. | 2 days | Z16 |

**Data changes:** `rules`, `rule_runs`; `sequences`, `sequence_steps`, `sequence_enrolments`; `stage_requirements`; `approval_requests`; `reports`, `dashboards`, `scheduled_reports`.

**Risks:** the rules engine is the largest single piece of work so far. Keep the first release small: three triggers, six actions, no nested groups. Scheduled jobs must survive restarts (store the next-run time, as the invoice reminder job does).

**Exit checklist**
- [ ] A rule that sets a field cannot loop. A failing action is logged and does not roll back the user's save.
- [ ] A blocked stage change gives the same error from the board, the form and the API.
- [ ] A scheduled report arrives once per period, with the recipient's own scope applied, not the creator's.

---

## Phase 5: Products, quotes, orders and collections (version 1.34, 4–5 weeks)

**Goal:** from deal to quote to order to invoice to payment, in one flow. Invoicing, GST, credit notes and receivables already exist and become the back half of this flow.

| # | Item | What to build | Effort | Gap |
|---|---|---|---|---|
| 5.1 | **Product catalogue** | SKU, name, category and sub-category, variants (size/colour), unit, HSN/SAC, tax rate, list price, cost, image, brochure, active flag. CSV/xlsx import using the existing importer. Pickers on invoice lines fill HSN, unit, price and tax. | 6 days | Z19, G16 |
| 5.2 | **Price lists and discount limits** | Price lists per customer group or dealer tier, with validity dates, and a maximum discount per role (above it, approval from Phase 4). | 3 days | Z19 |
| 5.3 | **Quotes** | Line items from the catalogue, taxes, terms, validity, a print/PDF layout in the invoice style, send by email (Phase 2), versions, and a customer page where the buyer can accept or reject (like the invoice portal). Accepting moves the deal to a chosen stage. | 8 days | Z19 |
| 5.4 | **Sales orders** | Quote → order with status *Draft → Pending approval → Approved → Dispatched → Delivered / Cancelled*, an approval threshold, and a dispatch note. Order → invoice draft in one click, partial invoicing allowed. | 6 days | Z20, G17 |
| 5.5 | **Payments by reps** | A rep records cash, cheque, UPI or bank transfer against an invoice or on account, with a photo of the cheque or receipt. This creates a payment claim (the table exists) that accounts confirm or reject. | 3 days | G18 |
| 5.6 | **Account statement** | A ledger per customer with invoices, credit notes, payments and a running balance, as a page, PDF and email, with an "as on" date. | 3 days | G19 |

**Data changes:** `products`, `product_variants`, `price_lists`, `price_list_items`, `quotes`, `quote_lines`, `orders`, `order_lines`; links from `invoice_lines` to products.

**Risks:** GST on quotes and orders must match what the invoice will later say (same tax engine, `regimes.js`). Stock is deliberately not in this phase (see Phase 10).

**Exit checklist**
- [ ] A quote, its order and its invoice show identical totals for the same lines under India GST and under the Saudi VAT regime.
- [ ] A discount above the role's limit cannot be saved without approval.

---

## Phase 6: Mobile app as a PWA (version 1.35, 3–4 weeks)

**Goal:** reps can use the CRM from a phone as an installable app, even with poor signal.

| # | Item | What to build | Effort | Gap |
|---|---|---|---|---|
| 6.1 | **Mobile layout** | A bottom tab bar (Today, Customers, Deals, Tasks, Me), large touch targets, quick-add sheet, and pull-to-refresh, built on the existing responsive CSS. | 6 days | G1 |
| 6.2 | **Installable app** | Web manifest, icons, splash and a service worker, with no build step. | 2 days | G1 |
| 6.3 | **Offline mode** | Cache the rep's own accounts, contacts, today's tasks and the product catalogue. An outbox queues notes, tasks, activities, orders and photos made offline and sends them when back online. Conflicts reuse the existing edit-conflict check and ask the user. | 8–9 days | G1 |
| 6.4 | **Camera** | Photo capture with on-device compression, stored in the existing file store. | 2 days | Z39 |
| 6.5 | **Push notifications** | Web Push (VAPID) for task reminders, assignments, approvals and mentions, with per-user on/off. Uses the Node crypto library, or one small dependency. | 4 days | G11, Z39 |
| 6.6 | **Phone sign-in comfort** | "Remember this device", optional PIN unlock on top of the existing session and 2FA model. | 2 days | |
| 6.7 | **Business-card scanner** | Photo of a card → the AI feature reads name, phone, email and company into a new contact for the rep to confirm. Reuses the existing Claude key setting. | 3 days | Z39 |

**Limit to know:** a web app can read location only while open. Background tracking waits for Phase 11.

**Exit checklist**
- [ ] On a mid-range Android phone, install, go offline, add a note, a task and a photo, go online, and see them on the desktop within a minute.
- [ ] Lighthouse PWA audit passes. Log-out and device revoke work from the phone.

---

## Phase 7: Field force (version 1.36, 4–5 weeks)

**Goal:** know where the field team is, plan their days, and prove visits happened. Needs Phase 3 (teams) and Phase 6 (mobile).

| # | Item | What to build | Effort | Gap |
|---|---|---|---|---|
| 7.1 | **Locations on records** | Latitude and longitude on accounts and contacts, set from the phone on the first visit, by dropping a pin, or by geocoding existing addresses if a geocoder is configured. | 3 days | G6 |
| 7.2 | **Attendance** | Punch in and out with GPS, time and optional selfie. Admin sets work hours, an office geofence, and holidays. Managers get an attendance register for their team. | 6 days | G2 |
| 7.3 | **Visits** | Check in at a customer (distance from the stored location shown and flagged beyond a limit), then check out with purpose, outcome, next action, photos and notes. A visit appears on the timeline. | 6 days | G3 |
| 7.4 | **Routes and beat plans** | Named routes (ordered customer lists), a weekly or one-off plan per rep, a "Today" list on the phone, and planned-vs-visited coverage with missed customers. | 6 days | G5 |
| 7.5 | **Manager map** | Today's punch-ins, visits and last known positions of the team, on a map (Leaflet with OpenStreetMap tiles; Google Maps if a key is added). | 4 days | G4 (part) |
| 7.6 | **Nearby customers and nearest-rep assignment** | "Within N km of me" on the phone, and an assignment rule option "nearest executive" (Phase 3 rules). | 3 days | G6, G9 |
| 7.7 | **Privacy controls** | Consent screen, location collected only while punched in, retention period, and an audit entry on every manager view of a rep's location. India's data protection law (DPDP Act 2023) expects notice and consent. | 3 days | G4 |

**Exit checklist**
- [ ] No location is stored for a rep who is punched out.
- [ ] A manager sees only their team on the map (team scope).
- [ ] The coverage report matches a hand count on a 20-customer test plan.

---

## Phase 8: Expenses, leaves and field reports (version 1.37, 3 weeks)

**Goal:** the admin side of managing a field team. Approvals use the reporting line from Phase 3.

| # | Item | What to build | Effort | Gap |
|---|---|---|---|---|
| 8.1 | **Expenses** | Claims with category, amount, date, receipt photo, linked visit or day, and travel allowance per km (from visit distances or an odometer entry). Approval by manager, then finance, then marked paid. Limits per category and role, and an export for accounts. | 7 days | G14 |
| 8.2 | **Leaves and holidays** | Leave types, balances, apply and approve, holiday calendar, and links to the attendance register. | 4 days | G15 |
| 8.3 | **Field reports** | Daily activity per rep (punch-in/out, visits, orders, collections, distance), attendance register, coverage vs beat plan, target vs achievement, collections, expenses. Built in the Phase 4 report builder where possible, with fixed layouts for the rest. Scheduled by email (Phase 4). | 7 days | G26 |
| 8.4 | **Rewards** | Badges and simple reward rules on top of targets (for example "top 3 this month"), shown on the leaderboard. | 2 days | G12 |

**Exit checklist**
- [ ] An expense above the manager's limit goes on to the next approver. A rejected claim returns to the rep with the comment.
- [ ] Attendance, leave and holiday data agree in the register.

---

## Phase 9: Communication (version 1.38, 4 weeks)

**Goal:** conversations arrive in the CRM by themselves.

| # | Item | What to build | Effort | Gap |
|---|---|---|---|---|
| 9.1 | **Mailbox sync** | Read incoming and outgoing mail through IMAP for the senders already configured, matching by address to contacts, per-user opt-in, only matched mail stored. Replies stop sequences automatically. Gmail and Microsoft OAuth afterwards. | 8–10 days | Z2 |
| 9.2 | **Calendar and meetings** | Meetings with attendees, `.ics` invites, reminders and push, then Google Calendar and Outlook sync. A booking link showing a rep's free slots, which creates the meeting and the contact. | 8 days | Z5, G25 |
| 9.3 | **Mail add-in** | A Gmail and Outlook side panel showing and logging the CRM record. Lower priority and can slip. | 5 days | Z4 |
| 9.4 | **WhatsApp Business API** | Template messages from contacts, deals and invoices, inbound replies logged on the timeline, opt-in tracking. Needs Meta business verification and per-message charges, so it is optional. The Phase 1 click-to-chat stays as the no-setup option. | 6 days | Z7 |
| 9.5 | **Cloud telephony** | Click-to-call through an Indian provider (Exotel, MyOperator or Knowlarity), call logs and recordings attached to the contact via webhooks. | 5 days | Z6, G27 |
| 9.6 | **Sales library and announcements** | Shared folders of brochures, price lists and training files (available offline on mobile) with view tracking; manager broadcasts to teams with read receipts. | 4 days | G23, G24 |

**Risks:** mailbox sync is the least predictable item. Ship IMAP first and treat OAuth as a second release. Store mail bodies only for matched contacts, and let each user switch it off.

---

## Phase 10: Service desk, industry templates and dealer portal (version 1.39, 4–6 weeks)

**Goal:** vertical depth, built on everything above. Can be split, and the industry order should follow your first target market (open decision below).

| # | Item | What to build | Effort | Gap |
|---|---|---|---|---|
| 10.1 | **Tickets and service desk** | Complaints from forms, email, WhatsApp or manual entry; assignment (nearest or area technician); visit check-in with photos; resolved/unresolved; re-visit scheduling; SLA timers; recurring-issue report; warranty look-up by serial or QR. Knowledge base and a customer portal with ticket status. | 10–12 days | G22, Z36 |
| 10.2 | **Industry templates** | One click applies preset custom fields, layouts, stages, visit types, report packs and sample data for: distribution/FMCG/manufacturing, real estate, BFSI, healthcare/pharma, service. | 6–8 days | G29 |
| 10.3 | **Stock and returns (distribution)** | Simple stock per warehouse with dispatch notes, stock deducted on delivery, product returns linked to credit notes, distributor → retailer hierarchy. An alternative is a sync with Tally or Zoho Books (open decision). | 8–10 days | G20, G28 |
| 10.4 | **Real-estate inventory** | Projects → units with a colour-coded Available / Blocked / Sold board, hold expiry, and a booking that creates the deal. | 5 days | G29 |
| 10.5 | **Dealer portal** | Extend the invoice portal into a dealer login with catalogue, price list, order placement, order status, ledger and invoices. | 7 days | G21 |
| 10.6 | **Small widgets** | EMI calculator (BFSI), competitor capture and dealer feedback on visits (FMCG). | 3 days | G29 |

---

## Phase 11: Native app, enterprise admin, languages and hosting (version 2.0, 5–7 weeks)

**Goal:** the items that need the most care or are not needed by every customer.

| # | Item | What to build | Effort | Gap |
|---|---|---|---|---|
| 11.1 | **Native wrapper (Capacitor)** | Android first, then iOS: background location every N minutes while punched in, route replay, distance for travel allowance, GPS-off and mock-location alerts, battery status, optional call-log sync, push through FCM/APNs, store listings. | 15–18 days | G4, G7 |
| 11.2 | **Enterprise security** | SSO (SAML/OIDC), field-level permissions, record sharing rules, IP allow-lists, a sandbox copy for testing changes, and data-privacy tools (consent log, export or erase on request). | 12–15 days | Z40 |
| 11.3 | **Languages** | Move interface text into message files; Hindi and one regional language first for the mobile UI, then Arabic for the full UI (it is already used on invoices). | 8–10 days | G30, Z40 |
| 11.4 | **Data model extras** | Formula, roll-up and conditional-layout fields; more than two currencies with daily rates; custom objects if the 2026-11-10 decision is reopened. | 10 days | Z22, Z23, Z27 |
| 11.5 | **AI assistant** | Summarise a record, draft a reply, create tasks or update fields on command, meeting notes, deal risk hints. Builds on the existing Claude settings; actions always confirmed by the user. | 8 days | Z33, Z32 |
| 11.6 | **Hosting model** | Depending on the decision: stay self-hosted with installation and support; one instance per customer with automated provisioning, backups and upgrades; or true multi-tenancy (a bigger change). A free-trial flow if hosted. | 5–20 days | G31 |

---

## Decisions needed, and when

| # | Decision | Needed before | Recommendation |
|---|---|---|---|
| 1 | Approve Phase 1 as the first release? | Now | Yes. Nothing in it depends on the other decisions. |
| 2 | Keep the "fields and layouts only" decision (no custom objects)? | Phase 11 (Phase 10 if real-estate or service units are urgent) | Keep for now; the industry templates cover the main cases. |
| 3 | Email sync: IMAP first, or direct Gmail/Microsoft OAuth? | Phase 9 | IMAP first, OAuth second. |
| 4 | Maps: OpenStreetMap (free) or Google Maps (billing key)? | Phase 7 | OpenStreetMap, with Google as an option. |
| 5 | First industry focus? | Phase 10 (and the choice of the two demo datasets earlier) | Distribution and manufacturing, the largest segment in Salesfokuz's customer stories. |
| 6 | Stock: built in, or sync with Tally/Zoho Books? | Phase 10 | Sync for larger customers, simple built-in stock for small ones. |
| 7 | WhatsApp: click-to-chat only, or the Business API? | Phase 9 | Click-to-chat now; API when a customer needs templates. Apply for Meta verification early either way. |
| 8 | Hosting model | Phase 11, but affects pricing talks now | One instance per customer. |
| 9 | Will Facebook Lead Ads be needed soon? | Phase 2 (Meta app review takes weeks) | If yes, start the review as soon as Phase 1 ships. |

## How I would run each phase

1. Branch per phase (for example `phase-1-quick-wins`), with one commit per numbered item so any item can be dropped.
2. Migration and tests first, then API, then UI, then help pages.
3. Run `npm test` and `npm run e2e` before every commit. Upgrade a copy of a real 1.27.1 database before each release.
4. Release notes in the README, version bump in `package.json`, and a demo script for the sales team listing what is new.
