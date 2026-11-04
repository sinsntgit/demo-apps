# Ovantaa CRM

An enterprise-style CRM with a full campaign (email marketing) module. **Zero runtime dependencies** — just Node.js 22.5+ (uses the built-in `node:sqlite`).

## Quick start

```bash
npm start            # http://localhost:3000
```

First run creates the database in `data/ovantaa.db` with demo data. Sign in with:

| Role | Email | Password |
|---|---|---|
| Admin | `admin@ovantaa.com` | `Ovantaa@123` |
| Manager | `maya@ovantaa.com` | `Ovantaa@123` |
| Sales rep | `liam@ovantaa.com` | `Ovantaa@123` |

Change these immediately in any real deployment (Settings → My account, Team page). Set `ADMIN_EMAIL` / `ADMIN_PASSWORD` and `SEED_DEMO=0` before first start for a clean production database with only your admin.

## Features

**CRM** — Dashboard (pipeline, forecast, win rate, revenue trend, lead sources, leaderboard, "my records" scope) · Contacts (search, filters, sort, bulk actions, CSV import with upsert-by-email, CSV export, 360° profile) · Accounts · Deals (drag-and-drop Kanban + list, stage-based probability) · Tasks (due/overdue, priority) · Activity timeline (notes, calls, emails, meetings) · Audit log.

**Campaigns** — Rule-based audience **segments** (ALL/ANY, live emailable counts) · reusable **templates** · campaign editor with merge tags (`{{first_name|there}}` fallbacks), live sandboxed preview, test send · send now or **schedule** · automatic **open and click tracking** (HMAC-signed redirect links, so they cannot be used as an open redirector) · one-click **unsubscribe** page + `List-Unsubscribe` headers, honoured immediately and re-checked at send time · per-campaign reports (open/click/unsub rates, top links, timeline, per-recipient status) · frozen audience at send time.

**Security & admin** — scrypt password hashing, signed HttpOnly SameSite=Strict session cookies, login throttling, role-based access (admin / manager / rep), parameterised SQL with whitelisted sort/filter columns, HTML-escaped UI, CSP and security headers, CSV formula-injection protection on export.

## Email delivery

Out of the box mail is **simulated** (messages are logged in Settings → Recent outbound mail; nothing leaves the server). For live delivery:

```bash
MAIL_TRANSPORT=webhook MAIL_WEBHOOK_URL=https://your-relay.example/send MAIL_WEBHOOK_TOKEN=secret \
BASE_URL=https://crm.yourcompany.com npm start
```

Each message is POSTed as JSON `{from,to,subject,html,text,headers,campaign_id}` — bridge it to SES, SendGrid, Postmark or an SMTP relay. `BASE_URL` must be your public address so tracking pixels, links and unsubscribe URLs reach this server.

## Configuration (environment variables)

`PORT` (3000) · `DB_PATH` · `BASE_URL` · `SESSION_SECRET` (auto-generated into `data/.secret` if unset) · `SECURE_COOKIES=1` (set behind HTTPS) · `FROM_NAME`, `FROM_EMAIL`, `COMPANY_ADDRESS` (footer) · `SEND_BATCH_SIZE`, `SEND_DELAY_MS` · `MAIL_*` as above · `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SEED_DEMO`.

## Development

```bash
npm test             # API integration tests (auth, CRUD, injection, campaign lifecycle, tracking, permissions)
npm run e2e          # browser smoke test (requires Playwright + Chromium installed)
npm run seed         # reset DB to demo data
```

Layout: `server/` (http, auth, entities, segments, campaigns engine, api, seed) · `public/` (vanilla ES-module SPA, no build step).

## Known limits

Single-node SQLite (fine for thousands of contacts and tens of thousands of emails per campaign; swap the DB layer for Postgres at larger scale). Recipient selects in forms preload up to 1,000 records. No built-in SMTP client — use the webhook transport.
