# AskData — text-to-SQL platform

Ask business questions in plain English, get the SQL, the result, a chart and a summary.
Works with **SQL Server, Oracle, Snowflake, SingleStore, MySQL, PostgreSQL** and **folders of Excel / CSV files**.

The AI model only ever writes SQL. It is given your question, the schema and your training notes —
**never query results**. The SQL is run by this server directly against your source, and the rows go
straight to the browser.

## Quick start

```bash
cd text2sql
pip install -r requirements.txt -r requirements-drivers.txt
python -m uvicorn app.main:app --port 8000
```

Open http://localhost:8000. The first-run admin password is printed in the server log (you must change it
at first sign-in). A sample data model, **Sample: Retail sales** (CSV files), is created so you can try
it immediately. Then:

1. **Admin → AI models** — add your Anthropic / OpenAI key, or a self-hosted OpenAI-compatible endpoint.
2. **Data models → Connect a data source** — add a database; press **Sync schema**.
3. **Training** — add documentation, question → SQL examples, upload documents.
4. **Ask** — pick the data model and the AI model, ask a question.

Docker: `cp .env.example .env`, set `T2S_SECRET_KEY`, then `docker compose up --build`.

No API key yet? `python -m tests.fake_llm` starts a stand-in model on `http://127.0.0.1:8765/v1` that
answers a few questions about the sample data (add it as a *Self-hosted* model, model ID `fake-1`).

## What it does

| Area | Capability |
|---|---|
| **Data models** | Any number of connections, each with its own schema, training data, access list and privacy settings. Users pick the data model before asking. |
| **Training** | Per data model: schema sync (names, types, keys, comments), business documentation, verified question → SQL examples (add, bulk-import CSV/JSON), uploaded documents (PDF, Word, Excel, Markdown, text), extra DDL. The most relevant items are retrieved for each question. Export as JSON. |
| **Model choice** | Admins register models (Anthropic Claude, OpenAI, self-hosted OpenAI-compatible such as Ollama / vLLM); users choose one per question. Keys are encrypted at rest. |
| **Answers** | Shows the generated SQL and a one-line explanation. Optional *review SQL before running*. Auto-repair when the database rejects the SQL. Clarifying question when the request is ambiguous. |
| **Confirm / correct** | *Correct* turns the answer into a verified example. *Edit SQL* → run → *save my correction* teaches the model the right query. *Incorrect* flags it with a note. Analyst feedback can go through a steward approval queue (admin setting). |
| **Predictive** | Opt-in per question (“Use predictive capability”): forecasting, classification / regression, key drivers, segmentation and anomaly detection. The AI model only names the method and columns; the server runs its own tested scikit-learn / statsmodels routines on the query result and shows key figures, charts, result tables, statistical output and the exact Python that ran (feature engineering included). Each part can be shown or hidden. Works in reports and PDFs. |
| **Summary** | Explains the result by its shape (trend, ranking, two-way breakdown, pivot, listing): leaders and shares, highs and lows, change over the period, concentration. Averages, rates and prices are never totalled. Computed on the server. |
| **Output** | Chart (bar, horizontal, stacked, line, area, pie, doughnut, scatter, big numbers) with selectable axes, extra measure and split-by. IDs, codes and years are treated as categories, never summed; two measures on different scales get a panel each; sortable table; locally computed summary. Export **PDF report**, CSV, Excel, chart PNG. |
| **Follow-ups & history** | Suggested follow-up questions; conversations keep context (earlier questions + SQL); chats and results are saved, searchable, renamable and grouped by date. |
| **Reports** | Drag-and-drop designer: place results from any number of chats (chart, table, summary each optional), headings, text, dividers and page breaks; set widths (full, ⅔, ½, ⅓) to put objects side by side; header, footer and page numbers. Stores queries, not data: refreshed live for whoever opens it. Live text placeholders. PDF export with the same layout. Share with user groups, roles or people (view / edit). Schedule daily / weekdays / weekly / monthly and email the PDF to groups, any number of people and outside addresses — each account holder receives a copy rendered with their own data access. |
| **Email senders** | Admin → Email senders: one or more mailboxes with provider presets (Titan / GoDaddy, Google, Microsoft 365, Zoho, any SMTP), Verify, Send test, simulation mode, default sender, and an email log. |
| **User groups** | Admin → User groups: named lists of users, used for data-model access, data filters, and sharing and emailing reports. |
| **Data access & filters** | Admin → Data access: enable / disable a data model, open it to all or to selected user groups and users, and add row-level filters (`region = 'North'`, `rep_email = {user_email}`) per user, per group, per role or for everyone. Filters are applied by the server to every query — model-written, hand-edited or in a report. |
| **Help** | Built-in Help page for users, stewards and administrators with screenshots, search and print (`static/help/help.html`). |
| **Security** | TOTP two-factor authentication with recovery codes (optional or enforced org-wide), bcrypt passwords with policy, account lockout, session revocation, roles, per-data-model access, CSRF protection, security headers, full audit log. |
| **Admin** | Users (roles, reset password / 2FA, unlock), AI models, settings (row limit, timeout, rate limit, 2FA enforcement, feedback mode, result retention), audit log with CSV export. |
| **Dashboard** | Success rate, SQL accuracy from user verdicts, auto-corrections, latency, tokens and spend; trends; breakdown by AI model, data model and user; common failures; a drill-down log of every query with its SQL, output and what was sent to the model. |

Roles: **analyst** (ask, own history) · **data steward** (plus training, review queue, dashboard) · **admin** (everything).

## The privacy boundary

`app/engine.py::build_prompt` is the only place content is assembled for the model. It contains:

- table / column names, types, keys and comments for the relevant tables
- approved training items (documentation, examples, document passages)
- earlier questions and SQL from the same conversation
- the new question

Never included: query results, row counts, summaries, chart data or anything from a predictive analysis. Summaries and chart suggestions are
computed on the server (`app/summarize.py`). When a query fails, the database error is scrubbed of literal
values before the model is asked to fix it. A test (`tests/test_platform.py`) records every request the
model receives and asserts that result values are absent.

**Opt-in exception:** per data model, an admin can list specific low-cardinality columns (for example
`orders.status`) whose distinct values (max 20) are added to the schema notes so the model writes correct
filters. It is off by default, audited when enabled, and purged when disabled.

If even schema names must stay on your network, use a self-hosted model.

## Safeguards on the source database

- Every statement — model-written or user-edited — is parsed (`app/sqlguard.py`) and must be a single
  `SELECT`. DML, DDL, multi-statements, `SELECT … INTO`, and file / shell / sleep functions are rejected.
- Sessions are opened read-only where the database supports it, with a statement timeout and a row cap.
- Excel / CSV folders are loaded into an in-memory DuckDB with file-system access switched off.
- Row-level data filters are enforced by rewriting every reference to a filtered table into a filtered
  sub-select (`app/rowfilter.py`); SQL that cannot be analysed is refused for filtered users.
- Masked columns: values are replaced in results, including when reached through aliases or CTEs.
- **Still give the platform a database account with SELECT-only grants on just the schemas it needs.**
  The guard is defence in depth, not a substitute for database permissions.

## Configuration

Environment variables (see `.env.example`):

| Variable | Purpose |
|---|---|
| `T2S_SECRET_KEY` | Signs sessions and encrypts stored credentials. **Set it in production and keep it safe** — losing it makes stored passwords and API keys unreadable. If unset, one is generated in the data directory. |
| `T2S_ADMIN_EMAIL`, `T2S_ADMIN_PASSWORD` | First-run administrator. |
| `T2S_COOKIE_SECURE=1` | Required when served over HTTPS (which production must be). |
| `T2S_DATABASE_URL` | Metadata store. SQLite by default; PostgreSQL recommended for production. |
| `T2S_DATA_DIR` | Where SQLite, uploaded data files and the generated secret live. |

Everything else is under **Admin → Settings**.

## Tests

```bash
pip install -r requirements-dev.txt
python -m pytest
# browser checks against a fresh instance (needs Node + Playwright):
tests/e2e/run.sh
# include live-PostgreSQL checks:
T2S_TEST_PG=user:password@host:5432/dbname python -m pytest
```

## What has and has not been verified

- Verified end to end: Excel / CSV folders, PostgreSQL (live server, read-only role), all UI flows in a
  browser, 2FA, exports.
- MySQL, SingleStore, SQL Server, Oracle and Snowflake use the same SQLAlchemy code path as PostgreSQL
  with their own drivers and dialect-aware SQL checks, but **have not been run against live servers** —
  test each connection in your environment.
- The Claude and OpenAI integrations were exercised against local stand-in servers that speak the same
  API, not against the real services. In particular, how well a real model recognises a predictive
  question and prepares the right data set for it has not been measured.

## Production notes

- Put it behind HTTPS (reverse proxy) and set `T2S_COOKIE_SECURE=1`.
- Rate limiting and the query thread pool are per process; run one app process per container, scale with
  containers and a shared PostgreSQL metadata store.
- Scheduled reports run in a background thread of the app process; email needs a sender under
  Admin → Email senders. Email delivery was tested against a local test mail server, not a real provider.
- On start-up the app adds any columns a newer version introduced to existing tables (and creates new
  tables), so an existing data folder keeps working after an update. Back it up first all the same.
- Not included: SSO (SAML / OIDC).

## Working on the code

[`CLAUDE.md`](CLAUDE.md) is the handoff guide for developers and AI coding agents: architecture, the rules the
product must never break, how changes are verified, and known pitfalls.
