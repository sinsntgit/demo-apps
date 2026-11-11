# Ovantaa CRM

An enterprise-style CRM with campaign (email marketing) management, multi-sender SMTP, AI-written campaigns (Claude), event notifications, spreadsheet import and a themeable UI.

## Quick start

Requires **Node.js 22.5 or newer** (`node -v`).

```bash
cd ovanta_crm
npm install        # runtime dependencies: nodemailer (real SMTP) and qrcode (invoice QR). Required once, and again after upgrading.
npm start          # http://localhost:3000
```

Windows PowerShell is the same; to change the port use `$env:PORT=4000; npm start`.

First run creates the database `data/ovantaa.db` (SQLite) with demo data. Sign in with `admin@ovantaa.com` / `Ovantaa@123` (also `maya@ovantaa.com` manager and `liam@ovantaa.com` rep, same password). **Change these** under Settings / Team. For a clean production database set `ADMIN_EMAIL`, `ADMIN_PASSWORD` and `SEED_DEMO=0` before the first start.

Upgrading from an earlier version: replace the code, run `npm install`, start — your existing database is migrated automatically.

## Sending real email (read this first)

**Out of the box nothing is emailed** — the demo sender is a *simulation*. To send real email, add one **Email sender** per mailbox you send from (menu: *Marketing → Email senders → + Add sender*), pick a provider preset, enter the username and password, click **Verify** and **Send test**. Then choose that sender on each campaign ("Send from").

| Provider | Host / port | Notes |
|---|---|---|
| Google (Gmail / Workspace) | `smtp.gmail.com` 587 (STARTTLS) or 465 (SSL) | Needs an **App Password** (Google Account → Security → 2-Step Verification → App passwords). From address must be that account or a verified "Send mail as" alias. ~500/day personal, ~2,000/day Workspace. |
| Microsoft 365 | `smtp.office365.com` 587 | Admin must enable **SMTP AUTH** for the mailbox. Microsoft is disabling Basic-auth SMTP by default for existing tenants from end of Dec 2026 — plan on a transactional relay. |
| Zoho Mail (India) | `smtp.zoho.in` 465 (SSL) | Full address as username; app-specific password if 2FA is on. Other regions: `smtp.zoho.com`, `.eu`, `.com.au`. |
| Titan Mail / GoDaddy Professional Email | `smtpout.secureserver.net` 465 (SSL) | Full address as username, mailbox password. If 465 fails try 587 with SSL off. |
| Titan Mail (Hostinger, BigRock, other hosts) | `smtp.titan.email` 465 (SSL) | Full address as username, mailbox password. EU accounts: `smtp0101.titan.email`. |
| Other | any | Port 587 = STARTTLS (SSL/TLS off), 465 = SSL/TLS on. For bulk sending use Amazon SES, SendGrid, Postmark, Brevo etc. |

Example for several addresses: create three senders — `santosh@syncsense.in`, `santosh.t@ezdatamunch.com`, `janvi@syncsense.in` — each with its own mailbox's SMTP host and app password. Each has its own **24-hour limit** and **pause between emails**; a campaign that reaches its sender's limit pauses and resumes automatically.

Passwords and API keys are encrypted at rest (AES-256-GCM, key derived from `SESSION_SECRET` / `data/.secret`). **Keep `data/.secret` with your database** — if it is lost the saved passwords must be re-entered.

### If a sender will not log in
Run the built-in diagnostic — it tests the credentials *saved in the app* on both ports and both login methods and prints the server's replies (never the password):
```bash
npm run smtp-test -- --list          # shows saved senders and their ids
npm run smtp-test -- --sender 1      # tests sender #1 exactly as saved
npm run smtp-test -- --host smtpout.secureserver.net --user you@domain.com   # tests typed-in credentials (prompts for the password)
```
If every attempt says **"Greeting never received"** although `Test-NetConnection` to the port succeeds, your network may be connecting over IPv6 and stalling. Retry with `npm run smtp-test -- --sender 1 --ipv4`; if that works, start the app with `SMTP_FORCE_IPV4=1` (PowerShell: `$env:SMTP_FORCE_IPV4=1; npm start`, or `setx SMTP_FORCE_IPV4 1` once and reopen the terminal).

Some providers (Titan, for example) stall the greeting for 20+ seconds for clients that recently failed to log in. The app and the diagnostic now wait up to 60 s (`SMTP_TIMEOUT_MS`); if you see "did not greet us", stop retrying for 15–30 minutes.

`535 authentication failed` = the server rejected the username/password. Re-type the password with "Show password" ticked (browser autofill can insert the wrong one), and confirm the same host/user/password works in Thunderbird or Outlook.

### Delivery statuses
Each campaign recipient shows the furthest state reached: **Queued → Sent → Opened → Clicked**, or **Failed** (with the mail server's reason), or **Unsubscribed**.
* *Sent* means the receiving mail server **accepted** the message. SMTP cannot confirm inbox delivery.
* Later bounces (full mailbox, address no longer exists) arrive as bounce emails in the sender's inbox; this app does not read inboxes — watch the mailbox and unsubscribe such contacts.
* *Opened* uses a tracking pixel and is approximate (some mail apps pre-load or block images). *Clicked* uses signed redirect links.
* Notification and test emails are listed with Sent/Failed in *Notifications → Email log*.

### Deliverability checklist
Publish **SPF**, **DKIM** and **DMARC** for each sending domain (syncsense.in, ezdatamunch.com…). Gmail and Yahoo require all three for senders above ~5,000 emails/day to them, one-click unsubscribe (added automatically here) and spam complaints below 0.3% (aim for under 0.1%). Warm up new addresses slowly.

## E-invoicing, invoices & collections (KSA first, UAE-ready)

Menu **Billing**: *Invoices · Receivables · E-invoicing readiness · Billing settings*. Start in **Billing settings**: enter your registered name, VAT number (KSA: 15 digits, starts and ends with 3) / TRN, address and bank IBAN.

**What it does**
* **Arabic / English invoices** — tax invoices (B2B), simplified invoices (B2C), credit notes and debit notes; bilingual or single-language, right-to-left Arabic, VAT per line (standard / zero-rated / exempt / out-of-scope with reason), printable/PDF view with QR code.
* **Compliant numbering & integrity** — gap-free sequential numbers per series (`INV-`, `CN-`, `DN-`), a global invoice counter (ICV), each invoice hash-chained to the previous one (PIH), UUID, UBL 2.1 XML in the ZATCA structure and a TLV QR. **Issued invoices are immutable** — the API *and the database itself* refuse edits or deletes; corrections are credit/debit notes that reference the original and require a reason. The audit trail is append-only and a chain check re-verifies every hash.
* **Pre-submission validation** — about 40 rules before an invoice can be issued: seller/buyer VAT format, buyer address, exemption reasons, dates, totals, currency, advance-payment lines, credit limits, duplicates. Errors block issuing; warnings are shown. The **E-invoicing readiness** page scans everything — customer master data, drafts, imports, submission status (e.g. simplified invoices not reported within 24 h), reconciliation gaps and chain integrity — and links to the fix. Switch the regime between **KSA** and **UAE** in Billing settings.
* **Import & check** — upload an export from Zoho Books, QuickBooks, Xero or any system (CSV/Excel, one row per line). Columns are matched automatically; invoices become *drafts* with an exception report; nothing is issued or submitted.
* **Get paid** — a public **payment page** per invoice (bilingual, bank-transfer instructions, "I have paid" notice that you confirm against your bank), **automatic reminders** (email through your senders; WhatsApp as ready-to-send links or via your gateway; SMS via your gateway) on a before/after-due schedule that then repeats, **collection tasks** for overdue invoices that close when paid, and payment recording with bank-reconciliation tick-boxes.
* **Owner dashboard** — outstanding, overdue, collected this month, days sales outstanding, **ageing** buckets, **overdue customers**, an **8-week cash-in forecast** (due date + each customer's historical lateness) and billed-vs-collected by month.

**What is NOT included (be aware before relying on it for compliance)**
* **Live ZATCA clearance/reporting is not built in.** It requires your onboarding with ZATCA (CSID/OTP) and a cryptographically signed XML (XAdES) plus the Phase-2 signature QR tags and PDF/A-3. This app prepares, validates, numbers, chains and builds the unsigned UBL/QR, then hands the invoice to **your certified provider/solution** through *Billing settings → E-invoicing provider* (JSON webhook; replies `cleared`/`reported`/`rejected`). Until a provider is connected invoices show **"Ready · not submitted"** and the app warns not to send B2B invoices to customers. I could not test against ZATCA's sandbox from here.
* **UAE (Peppol PINT-AE) export is not built** — UAE currently gets the validation rules and workflow only.
* WhatsApp Business API / SMS use *your* gateway; without one WhatsApp reminders are one-click links. Bank feeds are not connected (reconciliation is manual). Zoho/QuickBooks/Xero are file-import only, not live connectors.
* Rules are a strong subset of ZATCA/FTA requirements, not the full official schematron — treat a clean "ready" as a good pre-check, not as legal assurance. Have your accountant confirm VAT treatment.
* Issued invoices can never be deleted (tax records must be kept); "Delete all" does not include them.

## Custom fields & form layouts

**Admin → Customisation** (permission: *Customisation*, administrators by default). Choose **Deals, Accounts or Contacts**, then:

* **Add fields**: single-line text, comment (multi-line), number, percentage, amount (money), date, **dropdown** (you type the list of options), multi-select, checkbox, email, phone, web link, and **link to another record** (e.g. a *Partner* that points to an account). Each field can be **required**, have help text, a default, min/max/decimals, and can be shown as a **column in lists**, **filterable**, and **searchable**.
* **Show only when…**: e.g. show *Partner* and *Partner margin* only when *Deal type = Partner*. Hidden fields are not required and keep any saved value.
* **Arrange the form**: group fields into named **sections** (one or two columns), **drag** them (or use ↑ ↓), hide optional standard fields, **preview**, and **save** — the saved layout is what everyone sees when creating or editing records. New fields appear automatically at the end until you place them. *Reset to default* undoes it.
* **Archive** a field to hide it everywhere while keeping its data (restore any time), or delete it **permanently** (removes the values from every record). The field *type* and internal key never change after creation, so saved values stay valid. Renaming a dropdown option renames it on every record that uses it.

Custom values appear on the record's detail page (grouped by your sections), in list columns and filters, on deal cards, in **CSV export and import** (contacts; columns are matched by field name), and as **conditions in campaign segments** (contact and account fields). They are validated on the server — required fields, option lists, number ranges, dates, emails, links and record links — whichever way a record is saved. Limits: 100 custom fields per record type, 200 options per list. Tasks and invoices have no custom fields yet.

## Lead conversion, duplicates, attachments & two-factor sign-in

* **Convert a lead** — on a contact page, **Convert lead**: link or create the account (the dialog suggests accounts whose website matches the person's email domain), optionally open a deal in the same step (including any custom fields your admin made required), and mark the contact *Qualified* or *Customer*. All-or-nothing; the contact keeps a permanent link to the deal and shows **Converted ✓**.
* **Duplicates & merge** (*Duplicates* in the menu; permission *Merge duplicates*) — groups of contacts with the same email or name, and accounts with the same name or VAT number. Pick the record to keep: the others' deals, tasks, notes, invoices, files and campaign history move across, empty fields are filled, tags are united and an unsubscribed contact stays unsubscribed. Custom "link to a record" fields are re-pointed. Permanent — it is recorded in the audit log.
* **Attachments** — a **Files** card on every contact, account, deal and invoice. Add up to **20 files at once** (drag them onto the card or click *Add files*), up to 25 MB each (`MAX_UPLOAD_MB`). Programs and scripts (.exe, .js, .bat …) are refused. People only see files on records they can see; the *File attachments* permission controls view and upload. **Only Administrators can delete files** (deal stage folders, tasks and every other record) — no other role can be given that right, and every deletion is in the audit log. **Back up `data/files/` together with the database backups** — database backups contain the file list, not the file contents.
* **Deal stage folders** — on a deal, files live in one folder per stage (Prospecting, Qualification, Proposal …) plus *General*. Uploads go to the current stage's folder unless you pick another; a file can be moved to another folder from its row. On disk they are stored the same way: `data/files/deals/<deal id>/<stage>/…`. When you **change stage** (button or board drag) you can attach files to the new stage in the same dialog, and the **stage history** lists each stage's files as links.
* **File viewer** — click any file to view it without downloading: PDFs, images, video/audio, text and CSV, and a preview of **Excel (.xlsx, first sheet)** and **Word (.docx, text)**. Arrows step through the record's files; *Copy link* gives an in-app link that opens the record and the file (people still sign in). For PowerPoint and older Office files — or the original Excel/Word layout — **Office viewer ↗** opens Microsoft's online viewer through a link that works for one hour. That needs Ovantaa to be reachable on the internet (`BASE_URL` set to your public https address) and sends that file to Microsoft, so it is only used when you click it; every such link is recorded in the audit log.
* **Two-factor sign-in (authenticator app, TOTP)** — *Settings → Security*: scan the QR code (Google/Microsoft Authenticator, Authy, 1Password…), confirm with a code, and save the **10 one-time recovery codes** (shown once). A code can never be used twice. Administrators can **require** it for administrators or for everyone (*Settings → Security → Company policy*): people who have not set it up are taken to a set-up page at their next sign-in and cannot use the app until done. A lost phone: an administrator uses **Reset 2FA** on *Team & roles* (the person is signed out everywhere and sets it up again).
* **Sessions** — sign-in is now a server-side session: *Settings → Security → Signed-in devices* lists them and can sign out any or all others; signing out, changing your password, resetting 2FA or deactivating a user ends sessions immediately.

## Tasks: assigning work to your team

* **Assign** — *+ New task* (or *+ Task* on a contact/deal) → **Assign to** a team member, with a due date, priority, details and an optional message. The assignee is **emailed** the task, its due date and a link that opens it. Tasks are only assigned to internal users; contacts and accounts are just “related to”.
* **Assigned to me / Assigned by me / All tasks** tabs on the Tasks page, with counts (open, overdue, issues). The *Tasks* menu item shows how many open tasks you have plus issues waiting on you.
* **The assignee** opens a task and can **Mark complete** (with an optional note) or **Raise an issue** (a description is required) — both can attach **several files**. The person who assigned it is emailed either way.
* **The assigner** sees issues highlighted, can **Reply** (emails the assignee), **Reopen**, or **Resolve & send back / Reassign** — to the same person or someone else, with a new due date, a note and files. The new assignee is emailed (and the previous one is told it moved).
* Every step is on the task's **timeline** (who, when, what), and all files are in the task's *Files* card with the viewer.
* **Emails on every change** — assigned, reassigned / moved away, sent back, edited (due date, title, priority, details, related records — the email lists what changed), reply, issue raised, completed, reopened and deleted. The person who made the change is not emailed about it.
* Task and notification emails use your **default sender if it is a real mailbox**, otherwise the first active real (SMTP) sender — never the built-in *Demo sender (simulation)* when a real one exists. Adding your first real sender also makes it the default. After each action the app tells you who is being emailed and from which address; if only the simulation sender exists, the Tasks page shows a warning and nothing is claimed as sent. A delivery failure (wrong password, server down…) appears on the task's timeline with the server's message, and every task email is in *Notifications → Email log*.
* People with own-scope roles also see tasks they assigned to others.

## Two currencies on deals

* **Settings → Deal currencies** (administrators): choose **Currency 1** (what deal amounts are entered in, e.g. USD) and **Currency 2** (e.g. SAR), then add **one rate per year** — *2026: 1 USD = 3.76 SAR*. Every change is kept in the *Change history* (who, when, old → new); switching to another currency pair keeps the old pair's rates and brings them back if you switch again.
* **Which year's rate a deal uses:** while a deal is open, the year of its **expected close date** (or of its **created date** if no close date is set); once it is **won or lost**, the year it was **closed**. If that year has no rate yet, the latest earlier year's rate is used and the deal page says so; with no rate at all the deal is not converted.
* Amounts are converted live, so correcting a year's rate updates every deal of that year.
* Shown on the **deal page** (*≈ SAR 37,600* with the rate and the date it was based on), as an extra **Amount (SAR)** column in the deals list (sortable), on **board cards and column totals**, and on the **dashboard** (open pipeline, forecast, closed won, top deals, leaderboard, monthly revenue on hover). **AI search** understands amounts in either currency.

## Several people working on the same record

* **Edits merge.** An edit form sends only the fields you changed. If Liam changes a deal's amount while Maya changes its close date, both changes are kept.
* **Same-field conflicts are caught.** If someone else changed the *same* field after you opened the form, nothing is overwritten: the form shows *Was / Their value / Your value* for each such field and you choose, then Save again. Works for built-in and custom fields on contacts, accounts, deals and tasks. (Every record carries a version number; changes made by bulk actions, imports or background jobs count too.)
* **See who else is there.** Record pages show *“👁 Liam is viewing”* / *“✏️ Liam is editing”*. If someone saves while your edit form is open, the form tells you straight away.
* **Pages refresh themselves.** When someone else changes a record you are looking at (or a list of contacts, accounts, deals or tasks you have open), it updates within a second — but never while you have a dialog open; it waits until you close it. You only hear about records your role lets you see.
* History-type data (deal stage moves, notes, task timeline, files, audit log, invoice events) is only ever added to, so it never conflicts. Issued invoices cannot change at all.

## AI search

**AI search** (top of the menu, or **Ctrl + K** anywhere) answers questions in plain language across **deals, contacts, accounts, files, campaigns and segments**, including your custom fields — e.g. *“open partner deals over 100k closing this quarter”*, *“proposal PDFs uploaded in the last 30 days”*, *“accounts with more than 3 open deals”*, *“everything about Acme”*. The results show how the question was understood (the filters used), and file results open in the viewer.

How it works: Claude receives only your question, today's date, user names and the **names** of the searchable fields — never your records. It returns a search plan; Ovantaa checks every field and operator against a fixed list and runs it as a normal database query with your permissions (own/all scope, attachments, campaigns…). Anything in the plan it cannot use is skipped and shown as a note. Without an Anthropic API key (or if Claude is unavailable) it falls back to a keyword search, and you can choose *Keyword* mode at any time.

## Roles & permissions

**Team & roles → Roles & permissions** (administrators). A role is a set of permissions per area (contacts, accounts, deals, tasks, invoices, campaigns, segments, templates, receivables, billing settings, senders, notifications, users, audit log, data management…). For the core records — contacts, accounts, deals, tasks, invoices and activity notes — each of view / edit / delete can be **None, Own or All**: with *Own*, a person only sees and changes records they own; records owned by others behave as if they do not exist (list, search, lookups, exports, bulk actions, dashboard totals and imports all follow).

* Three built-in roles keep today's behaviour exactly: **Administrator** (locked, full access), **Manager** and **Sales rep** (both editable).
* Create your own roles (or duplicate one), assign them to users on the Users tab. Changes apply **immediately**, even to people already logged in.
* **No privilege escalation**: you can only grant permissions you hold yourself, so a delegated "manage users" role cannot create a more powerful one. The last active administrator cannot be removed, and you cannot change your own role.
* The complete API access matrix is one readable file, `server/route-permissions.js`; a test fails if a new route is added without being classified.
* Scope applies to the CRM records above. Campaigns, segments and templates are organisation-wide by design — restrict them with their own permissions.
* Small tightening vs. earlier versions: the *Email senders* list now needs the "view senders" permission (reps no longer have it by default).

## Backups, upgrades & restore

* An **automatic backup is taken every day** (the newest 14 are kept) in `data/backups/`; `BACKUP_DAILY=0` turns this off, `BACKUP_KEEP` changes the count.
* **Before any upgrade that changes the database structure, a restore point is saved first** (`…-premigration-…db`). Migrations are versioned and run in a transaction; if one fails it is rolled back, nothing is half-applied, and the app says so.
* `npm run backup` — verified backup now. *Settings → Backups* — create a backup or download one (administrators).
* **Restore**: stop the server, then `npm run restore` (lists backups) and `npm run restore -- data/backups/<file>.db --yes`. The current database is copied aside first, so a restore can be undone.
* Backups contain password hashes and encrypted credentials. Keep **`data/.secret`** safe together with them: saved SMTP passwords and API keys cannot be decrypted without it.

## Roadmap

See [`docs/ROADMAP-CRITICAL-GAPS.md`](docs/ROADMAP-CRITICAL-GAPS.md). Done: foundation, roles, custom fields, lead conversion, duplicates, attachments, two-factor. Next: quotes → invoices, automation rules, email/calendar sync.

## Features
* **Deal stage history** — every stage move is stored permanently: from → to, date/time, who moved it, the deal owner *at that moment*, the deal value, an optional comment, and the days spent in the previous stage. Shown on the deal page (*Stage history*), via **🕘 History** on every card/row of the Deals board and list, and recorded however the stage changes (drag-and-drop, *Change stage*, or the edit form). Moving a card on the board asks for an optional comment. Deals that existed before this feature get a single starting entry; earlier movements can't be reconstructed. Deleting a deal deletes its history.
* **CRM** — dashboard, contacts (360° view, bulk actions), accounts, deals (drag-and-drop board), tasks, activity timeline, audit log, roles (admin / manager / rep).
* **Campaigns** — rule-based segments, templates, merge tags (`{{first_name|there}}`), live preview, test send, schedule or send now, per-recipient tracking and reports, frozen audience, automatic unsubscribe.
* **Write with Claude** — in the campaign editor: describe the campaign, get subject + body + alternative subjects, rewrite existing copy, undo. Admin adds an Anthropic API key in *Settings → AI assistant* (or `ANTHROPIC_API_KEY`). Only the text you type is sent to Anthropic — never contact data. Model defaults to `claude-sonnet-5-5` (changeable in Settings or `ANTHROPIC_MODEL`).
* **Notifications** — *Notifications → Rules*: when a contact is added/updated/deleted/imported, an account is created, or a deal is created/updated/changes stage/is won/lost/deleted, email chosen users, the record owner and/or any addresses. Optional filters (minimum deal amount, stages), custom subject, choice of sender, "send me a test". Recipients get at most one email per action; imports send a single summary. Admins create/edit/delete rules; managers can view them and the email log.
* **Import contacts** — drag-and-drop **CSV, TSV, TXT or Excel (.xlsx)** (up to 5,000 rows / 8 MB), automatic column detection and mapping, default tag/source/status, update-or-skip existing, sample template download. Old `.xls` files: save as `.xlsx` or CSV.
* **Delete all** — admins can delete everything of one type (contacts, accounts, deals, tasks, activity notes, campaigns, segments, templates, notification rules, email log) from a **Delete all…** button on each page or from *Settings → Data management*. It shows the count and what else is removed, requires typing `DELETE`, is blocked while campaigns are sending, and is recorded in the audit log. Email senders, users and the audit log are never deleted this way. Managers and reps can still delete or bulk-delete individual records (reps only their own).
* **Themes** — *Settings → Appearance*: company accent and sidebar colours (presets or custom, live preview, saved for everyone including the login page) plus light/dark/auto; each user can override light/dark for their own browser.

## Configuration (environment variables)
`PORT` (3000) · `DB_PATH` · `BASE_URL` (**public address, needed for tracking links and unsubscribe**) · `SESSION_SECRET` · `SECURE_COOKIES=1` (behind HTTPS) · `FILES_DIR`, `MAX_UPLOAD_MB` (attachments) · `COMPANY_ADDRESS` (email footer) · `SEND_BATCH_SIZE` · `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` · `SMTP_TLS_INSECURE=1` (only for internal relays with self-signed certificates) · `SEED_BILLING_DEMO=0` (skip demo invoices) · `SMTP_FORCE_IPV4=1` (connect to mail servers over IPv4 only) · `SMTP_TIMEOUT_MS` (default 60000) · `BACKUP_DIR`, `BACKUP_KEEP` (14), `BACKUP_DAILY=0`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SEED_DEMO` · legacy `MAIL_TRANSPORT=webhook` + `MAIL_WEBHOOK_URL`/`MAIL_WEBHOOK_TOKEN` (used only when no sender exists).

## Tests
```bash
npm test       # 93 tests (API, permissions, migrations, backups): auth, CRUD, injection, campaigns, SMTP sending against a local fake mail server,
               # daily-limit pause/resume, notifications, AI (fake Claude API), themes, import options
npm run e2e    # browser test (needs Playwright + Chromium): navigation, forms, xlsx import, theme, AI panel, drag-and-drop
npm run seed   # reset to demo data
```

## Database
SQLite via Node's built-in `node:sqlite` (single file `data/ovantaa.db`, back it up while the server is stopped). Fine for thousands of contacts and tens of thousands of emails per campaign.

## Sources for the provider notes
[Gmail SMTP settings & limits](https://www.zeliq.com/blog/gmail-smtp-settings) · [Microsoft: SMTP AUTH Basic deprecation timeline](https://techcommunity.microsoft.com/blog/Exchange/updated-exchange-online-smtp-auth-basic-authentication-deprecation-timeline/4489835) · [Gmail & Yahoo bulk sender requirements](https://www.bounteous.com/insights/2024/01/31/2024-gmail-and-yahoo-deliverability-changes/) · [Zoho SMTP settings](https://meshworld.in/blog/devops/email/smtp/zoho-smtp-server/). These are third-party summaries; confirm against your provider's own documentation.
