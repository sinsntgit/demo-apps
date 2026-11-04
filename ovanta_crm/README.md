# Ovantaa CRM

An enterprise-style CRM with campaign (email marketing) management, multi-sender SMTP, AI-written campaigns (Claude), event notifications, spreadsheet import and a themeable UI.

## Quick start

Requires **Node.js 22.5 or newer** (`node -v`).

```bash
cd ovanta_crm
npm install        # one dependency: nodemailer (real SMTP sending). Required once, and again after upgrading.
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
| Titan Mail | `smtp.titan.email` 465 (SSL) | Full address as username, mailbox password. EU accounts: `smtp0101.titan.email`. If 465 fails try 587 with SSL off. |
| Other | any | Port 587 = STARTTLS (SSL/TLS off), 465 = SSL/TLS on. For bulk sending use Amazon SES, SendGrid, Postmark, Brevo etc. |

Example for several addresses: create three senders — `santosh@syncsense.in`, `santosh.t@ezdatamunch.com`, `janvi@syncsense.in` — each with its own mailbox's SMTP host and app password. Each has its own **24-hour limit** and **pause between emails**; a campaign that reaches its sender's limit pauses and resumes automatically.

Passwords and API keys are encrypted at rest (AES-256-GCM, key derived from `SESSION_SECRET` / `data/.secret`). **Keep `data/.secret` with your database** — if it is lost the saved passwords must be re-entered.

### If a sender will not log in
Run the built-in diagnostic — it tests the credentials *saved in the app* on both ports and both login methods and prints the server's replies (never the password):
```bash
npm run smtp-test -- --list          # shows saved senders and their ids
npm run smtp-test -- --sender 1      # tests sender #1 exactly as saved
npm run smtp-test -- --host smtp.titan.email --user you@domain.com   # tests typed-in credentials (prompts for the password)
```
If every attempt says **"Greeting never received"** although `Test-NetConnection` to the port succeeds, your network may be connecting over IPv6 and stalling. Retry with `npm run smtp-test -- --sender 1 --ipv4`; if that works, start the app with `SMTP_FORCE_IPV4=1` (PowerShell: `$env:SMTP_FORCE_IPV4=1; npm start`, or `setx SMTP_FORCE_IPV4 1` once and reopen the terminal).

`535 authentication failed` = the server rejected the username/password. Re-type the password with "Show password" ticked (browser autofill can insert the wrong one), and confirm the same host/user/password works in Thunderbird or Outlook.

### Delivery statuses
Each campaign recipient shows the furthest state reached: **Queued → Sent → Opened → Clicked**, or **Failed** (with the mail server's reason), or **Unsubscribed**.
* *Sent* means the receiving mail server **accepted** the message. SMTP cannot confirm inbox delivery.
* Later bounces (full mailbox, address no longer exists) arrive as bounce emails in the sender's inbox; this app does not read inboxes — watch the mailbox and unsubscribe such contacts.
* *Opened* uses a tracking pixel and is approximate (some mail apps pre-load or block images). *Clicked* uses signed redirect links.
* Notification and test emails are listed with Sent/Failed in *Notifications → Email log*.

### Deliverability checklist
Publish **SPF**, **DKIM** and **DMARC** for each sending domain (syncsense.in, ezdatamunch.com…). Gmail and Yahoo require all three for senders above ~5,000 emails/day to them, one-click unsubscribe (added automatically here) and spam complaints below 0.3% (aim for under 0.1%). Warm up new addresses slowly.

## Features
* **CRM** — dashboard, contacts (360° view, bulk actions), accounts, deals (drag-and-drop board), tasks, activity timeline, audit log, roles (admin / manager / rep).
* **Campaigns** — rule-based segments, templates, merge tags (`{{first_name|there}}`), live preview, test send, schedule or send now, per-recipient tracking and reports, frozen audience, automatic unsubscribe.
* **Write with Claude** — in the campaign editor: describe the campaign, get subject + body + alternative subjects, rewrite existing copy, undo. Admin adds an Anthropic API key in *Settings → AI assistant* (or `ANTHROPIC_API_KEY`). Only the text you type is sent to Anthropic — never contact data. Model defaults to `claude-sonnet-5-5` (changeable in Settings or `ANTHROPIC_MODEL`).
* **Notifications** — *Notifications → Rules*: when a contact is added/updated/deleted/imported, an account is created, or a deal is created/updated/changes stage/is won/lost/deleted, email chosen users, the record owner and/or any addresses. Optional filters (minimum deal amount, stages), custom subject, choice of sender, "send me a test". Recipients get at most one email per action; imports send a single summary. Admins create/edit/delete rules; managers can view them and the email log.
* **Import contacts** — drag-and-drop **CSV, TSV, TXT or Excel (.xlsx)** (up to 5,000 rows / 8 MB), automatic column detection and mapping, default tag/source/status, update-or-skip existing, sample template download. Old `.xls` files: save as `.xlsx` or CSV.
* **Themes** — *Settings → Appearance*: company accent and sidebar colours (presets or custom, live preview, saved for everyone including the login page) plus light/dark/auto; each user can override light/dark for their own browser.

## Configuration (environment variables)
`PORT` (3000) · `DB_PATH` · `BASE_URL` (**public address, needed for tracking links and unsubscribe**) · `SESSION_SECRET` · `SECURE_COOKIES=1` (behind HTTPS) · `COMPANY_ADDRESS` (email footer) · `SEND_BATCH_SIZE` · `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` · `SMTP_TLS_INSECURE=1` (only for internal relays with self-signed certificates) · `SMTP_FORCE_IPV4=1` (connect to mail servers over IPv4 only) · `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SEED_DEMO` · legacy `MAIL_TRANSPORT=webhook` + `MAIL_WEBHOOK_URL`/`MAIL_WEBHOOK_TOKEN` (used only when no sender exists).

## Tests
```bash
npm test       # 20 API tests: auth, CRUD, injection, campaigns, SMTP sending against a local fake mail server,
               # daily-limit pause/resume, notifications, AI (fake Claude API), themes, import options
npm run e2e    # browser test (needs Playwright + Chromium): navigation, forms, xlsx import, theme, AI panel, drag-and-drop
npm run seed   # reset to demo data
```

## Database
SQLite via Node's built-in `node:sqlite` (single file `data/ovantaa.db`, back it up while the server is stopped). Fine for thousands of contacts and tens of thousands of emails per campaign.

## Sources for the provider notes
[Gmail SMTP settings & limits](https://www.zeliq.com/blog/gmail-smtp-settings) · [Microsoft: SMTP AUTH Basic deprecation timeline](https://techcommunity.microsoft.com/blog/Exchange/updated-exchange-online-smtp-auth-basic-authentication-deprecation-timeline/4489835) · [Gmail & Yahoo bulk sender requirements](https://www.bounteous.com/insights/2024/01/31/2024-gmail-and-yahoo-deliverability-changes/) · [Zoho SMTP settings](https://meshworld.in/blog/devops/email/smtp/zoho-smtp-server/). These are third-party summaries; confirm against your provider's own documentation.
