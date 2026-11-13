# AskData (text2sql/) — handoff guide for an AI coding agent

Read this whole file before changing anything under `text2sql/`. It tells you what the product is,
the rules it must never break, where everything lives, and — most importantly — how work is done here
and what "finished" means. `README.md` is the user-facing overview; `static/help/help.html` is the
in-app manual and the most precise description of intended behaviour.

---

## 1. Who you are working for

- The owner is a **product owner, not a developer**. They describe features in business terms, often
  several at once, and judge the result by using it.
- They run it on **Windows** (PowerShell, Python 3.14), by downloading the branch as a **zip**, copying
  it over `D:\text2sql`, and keeping their existing `data\` folder. Every change must survive that
  update path: an existing data folder must keep working with new code (see §6 "Schema changes").
- They use Claude models through their own Anthropic key and Titan/GoDaddy mail.
- They read replies on a phone or in a side panel between other things. Write for someone arriving cold.

What they value, in order: it works when they try it → their data is safe → it is explained plainly →
they are told what was *not* verified.

---

## 2. Product in one paragraph

A text-to-SQL platform. A user picks a **data model** (a database connection or a folder of Excel/CSV
files, each with its own training data) and an **AI model**, asks a question, sees the SQL, can
confirm or correct it (which trains the system), and gets a chart, table and summary. Results can be
exported, saved in chats, and assembled into **reports** that refresh live, can be shared and scheduled
by email. Admins manage users, groups, data access, row-level filters, AI models, email senders,
settings and an audit log; stewards curate training and watch a quality dashboard.

Roles: `analyst` (ask, own chats, reports) · `steward` (+ training, review queue, dashboard, schema
sync) · `admin` (everything; never row-filtered; sees all reports).

---

## 3. Rules that must never be broken

These are the product's promises. A change that weakens one is wrong even if the feature "works".

1. **No result data goes to the AI model.** `app/engine.py::build_prompt` is the *only* place content
   is assembled for a model: schema metadata, approved training text, earlier questions + SQL, the new
   question. Summaries, chart suggestions and report text are computed locally (`app/summarize.py`).
   Database error text sent for auto-repair is scrubbed of literals (`scrub_error`). The only opt-in
   exception is per-connection sample values of admin-listed columns. `tests/test_platform.py` records
   every request the model receives and asserts result values are absent — keep that test meaningful.
2. **Read-only on source databases.** Every statement, model-written or user-edited or stored in a
   report, goes through `app/sqlguard.py::check` (single SELECT; no DML/DDL/file/sleep functions).
   Never add a code path that executes SQL on a source without it.
3. **Access control is enforced on the server.** Data-model access (`deps.can_use`), row filters
   (`app/rowfilter.py`), masking (`engine._mask`) and report access (`reporting.can_view/can_edit`) are
   applied server-side on every path — chat, edited SQL, reports, PDFs, scheduled emails. The UI only
   hides things. A viewer never gets more than their own access; SQL that cannot be analysed is refused
   for filtered users rather than run unfiltered.
4. **SQL in reports is never taken from the browser.** `reporting.clean_components` copies SQL from one
   of the editor's own successful runs or keeps what is stored.
5. **Secrets are encrypted at rest** (`security.encrypt`, key from `T2S_SECRET_KEY`) and never returned
   by an API: DB passwords, model API keys, SMTP passwords, TOTP secrets.
6. **An existing `data/` folder must keep working after an update.** No destructive schema changes.
7. **No build step for the front end.** Plain ES modules, vendored libraries in `static/vendor/`, a
   strict CSP (`script-src 'self'`; no inline scripts, no CDN). The app must work offline/air-gapped.
8. **Every state-changing admin/security action is audited** (`deps.audit`).
9. **No model-written code is ever executed.** Predictive analysis (`app/predict.py`) runs the app's own
   script templates. The AI model contributes only a method name and column names (`clean_spec`), which are
   checked against the real result columns and inserted with `repr()`. Never interpolate model or user text
   into a script any other way, and never add an "AI writes Python" path without a real sandbox and the
   owner's explicit decision (they chose built-in methods).

---

## 4. Architecture

Python 3.11+ · FastAPI · SQLAlchemy 2 (metadata store: SQLite by default, Postgres via
`T2S_DATABASE_URL`) · sqlglot (SQL parsing/rewriting) · DuckDB (file data models) · fpdf2 + matplotlib
(server PDFs) · Chart.js + jsPDF (browser). Run: `python -m uvicorn app.main:app --port 8000`.

### Backend (`app/`)

| File | Responsibility |
|---|---|
| `main.py` | App, security-header/CSRF middleware, `bootstrap()` (create tables, first admin, sample data), `upgrade_schema()` (adds new columns to existing tables; migrates legacy settings), starts the report scheduler. |
| `config.py` | Env vars, data dirs, `DEFAULT_SETTINGS` (admin-editable settings and their defaults). |
| `db.py` / `models.py` | Engine/session; all tables. `now()` is naive UTC everywhere. |
| `security.py` | bcrypt passwords + policy, JWT session cookie, TOTP + recovery codes, Fernet encryption, lockout, in-memory rate limiter. |
| `deps.py` | `current_user` (also enforces forced password change / mandatory 2FA on every request), role guards, `get_settings`, `audit`, `can_use` (data-model access incl. groups). |
| `sqlguard.py` | Read-only check; masked-column tracing through aliases/CTEs. |
| `rowfilter.py` | Row-level filters: which apply to a user (all / role / group / user), validation, and the rewrite of every reference to a filtered table into a filtered sub-select. |
| `connectors.py` | One engine per connection; schema introspection; `run_query` (row cap, timeout, type conversion, column `type`/`role`/`additive`); DuckDB loader for Excel/CSV with file access switched off; optional sample values. |
| `retrieval.py` | Local BM25 over training items; document chunking. No embeddings API. |
| `llm.py` | Providers: `anthropic` (official SDK), `openai`, `openai_compatible`. Tolerant JSON answer parser. |
| `engine.py` | The pipeline: `build_prompt` → `generate` → `execute` (guard → filters → run → mask → summarise, with auto-repair) and `run_sql` (same for stored SQL, used by reports). |
| `predict.py` | Predictive analysis: script templates (forecast, classify, regress, cluster, anomaly), feature selection, `run(spec, columns, rows)` → narrative, metrics, plot specs, tables, stats, warnings and the exact code that ran. |
| `summarize.py` | Shape-aware summary (single / trend / ranking / cross / pivot / listing / values) and default chart suggestion. Measures vs dimensions; additive vs averaged. |
| `docparse.py` | Text extraction from uploaded training documents. |
| `mailer.py` | Email senders: connect/verify/send, simulation mode, email log. |
| `reporting.py` | Report access, component validation, live `render` per viewer, server-side charts (`chart_panels`, `draw_panel`), `build_pdf` (row/column layout), schedules (`next_run`, `make_snapshot`, `run_due`, scheduler thread). |
| `routers/` | `auth`, `connections`, `training`, `chat`, `reports`, `analytics`, `admin` (users, groups, senders, email log, data access, filters, models, settings, audit). |

### The ask pipeline (the heart of the product)

```
POST /api/chat/ask
  engine.generate   build_prompt (schema + BM25-retrieved docs/examples + last 3 turns) -> llm.complete -> parse JSON
  engine.execute    sqlguard.check -> rowfilter.apply -> connectors.run_query -> _mask
                    on DB error: scrub_error -> ask model to repair (max N) -> retry
                    summarize.summarize + suggest_chart -> stored on QueryRun
```
Predictive questions (only when the user ticked "Use predictive capability" *and* the admin setting allows):
the model also returns `analysis: {type, columns…}`; `execute` then reads up to `analysis_max_rows`, calls
`engine.analyse` → `predict.run`, and stores `{spec, result|error}` in `QueryRun.analysis`. The data table
still shows/stores at most `max_rows`. A failed analysis never fails the answer.

`QueryRun` is at once the chat message, the audit record and the dashboard row. `run_dto` recomputes
the summary on read so old chats benefit from summary improvements.

### Reports

A report stores **queries, not data**. `reporting.render(db, report, viewer)` re-runs each result with
the *viewer's* access and filters; `build_pdf` lays components out in rows by `width` (6 = full, 4, 3,
2 sixths). Scheduled runs save the owner's PDF as a snapshot and email each account-holding recipient a
PDF rendered with *their* access; outside addresses get the owner's view.

### Frontend (`static/`)

Single page, hash routes (`#/ask`, `#/reports/5`, `#/admin/senders`, `#/help/charts`), one module per
screen, lazy-imported from `js/app.js`.

| File | Screen |
|---|---|
| `js/core.js` | `h()` DOM builder, `fill()`, `api()`, `modal()` (maximisable), `toast`, `confirmDialog`, `field/check/select/tabs`, formatting, SQL highlight/pretty-print, theme. |
| `js/app.js` | Boot, role-filtered nav, router, identity re-check (see gotcha 12). |
| `js/results.js` | A chat answer: SQL review/edit/feedback, `chartConfig`/`chartPanels`/`chartBlock`, `dataTable`, `summaryBlock`, exports. Reused by reports and the dashboard. |
| `js/chat.js`, `reports.js`, `training.js`, `connections.js`, `dashboard.js`, `admin.js`, `account.js`, `auth.js`, `help.js` | As named. |
| `help/help.html` + `help/img/` | The manual and its screenshots. |

Front-end conventions: build DOM with `h(tag, attrs, ...children)`; replace content with
`fill(el, ...)`; all server calls through `api(method, path, body)` (adds the CSRF header, handles
401/403); buttons that call the server go through `busy(btn, fn)`. Follow the existing dense style.

Chart rules (deliberate — do not "simplify" them away): identifiers/codes/years are **categories**,
never summed; averages/rates/prices are **averaged**, never totalled; **never a second Y axis** — two
measures >20× apart get one panel each; at most 8 series, fixed colour order, the tail folds into
"Other"; charts aggregate rows that share an X value and say so. The browser (`results.js`) and the
server (`reporting.chart_panels`) implement the same logic — **change both**. Predictive plots are a neutral
spec (`kind`, `labels`, `datasets` with a `role`) drawn by `results.js::plotConfig` in the browser and
`reporting.draw_plot` in PDFs — again, change both.

---

## 5. How work is done here (the method)

This is the part to imitate. The quality comes from the loop, not from any single clever step.

### 5.1 Before writing code
1. **Read the code you will touch**, and the Help section describing it. Do not rely on this file alone.
2. **Separate decisions from implementation.** If a choice is genuinely the owner's — it changes what
   they get, costs them setup, or trades privacy/security for convenience — ask, with 2–4 concrete
   options, a recommendation first, and the trade-off of each in plain words. Ask all such questions
   in one go, then build. Past examples that were rightly asked: how strict "no data to the model" is;
   what a schedule does when it fires; who filters can be assigned to; how the summary should improve.
   If the choice is conventional, make it, and say what you chose in the report.
3. **When the owner asks "how do I…" and the honest answer is "you can't yet"**, say so, explain what
   exists, and offer to build the missing part. Do not answer the question you wish they had asked.
4. **When they report a bug, reproduce it first.** Write a small script that shows the symptom, find
   the actual cause, fix that, and rerun the script. Say what the cause was — and what it was *not*
   (e.g. "a stale menu, not a permissions hole").
5. **Look for the precedent.** "Do it like the CRM's Email senders" meant reading
   `../ovanta_crm/public/js/mail.js` and mirroring its fields, presets and Verify / Send test flow.

### 5.2 Order of work for a feature
Backend and data model → API → **tests for the rule being enforced** → UI → browser check →
**look at the screenshots** → Help + README → full test run → commit → push → report.

Design defaults that have served well:
- Enforce on the server; let the UI merely reflect it.
- Prefer the safe failure: refuse rather than run unfiltered; save the report and record why the email
  failed rather than lose both.
- Reuse the existing mechanism (one guard, one `run_sql`, one `chartBlock`) rather than a parallel one.
- Add the small adjacent thing that makes the feature usable (an email log next to senders; "already
  has access via group X" next to a user) — but not speculative features.
- Explain in the UI at the point of use, in the owner's vocabulary, why something is the way it is.

### 5.3 Verification — non-negotiable
"It should work" is not a result. For every change:

```bash
python -m pytest -q                       # API-level tests, a few seconds
tests/e2e/run.sh                          # browser suites against a fresh instance (see file header)
tests/e2e/run.sh reports                  # one suite: features | reports | groups | predictive | session
T2S_TEST_PG=user:pw@host:5432/db python -m pytest tests/test_postgres.py   # live Postgres, optional
```

- `tests/fake_llm.py` is a stand-in model (OpenAI- and Anthropic-shaped endpoints) with canned SQL for
  the sample data; add a rule there when a test needs a particular query.
- Write tests that would fail if the *rule* broke: the filtered user must not see the other region
  through an alias, a sub-query, or a CTE; the shared viewer must get `no_access`, not data; the
  emailed PDF for user A must contain A's numbers and not B's.
- After a UI change, drive it in the browser **and open the screenshots**. Bugs found only this way so
  far: the word "null" rendered on screen, cramped/wrapped tables, unreadable chart text in narrow PDF
  columns, garbled characters in a PDF.
- Open generated PDFs/exports and read them. Check server logs for tracebacks after a browser run.
- If a browser step fails, find out whether the app or the test is wrong before changing either.
- If something could not be verified (a database you have no server for, a real mail provider, the
  real model API, Docker), **say so plainly** in the report and in the README's "what has and has not
  been verified". Never imply coverage you do not have.

### 5.4 Documentation is part of the change
- Update `static/help/help.html` for any behaviour a user or admin can see, and `README.md`'s feature
  table and verification notes.
- Help screenshots are produced by the `tests/e2e/*.js` suites and copied by name into
  `static/help/img/`. Regenerate the ones for screens you changed. Check for drift:
  ```bash
  grep -o 'img/[a-z0-9-]*\.png' static/help/help.html | sort -u | sed 's#img/##' > /tmp/used
  ls static/help/img | sort > /tmp/have; comm -3 /tmp/used /tmp/have     # must print nothing
  ```
- Numbers quoted in Help (limits, defaults) must match the code.

### 5.5 Git
- Work on the branch you were given. Never push elsewhere or open a pull request unless asked.
- One commit per coherent change; the message says what changed and why in plain sentences.
- Do not commit `data/`, caches, or stray screenshots. Clean up test processes you started.
- Push when the work is verified, so the owner's zip link has it.

### 5.6 Reporting back to the owner
Lead with the outcome and how it was verified, in one or two sentences. Then, per request they made,
what now exists and how to use it — in their words, not file names. Then anything they must know:
decisions you made for them, limits, what was not tested. End with the update steps when files
changed (zip link, "keep your `data` folder", whether to reinstall requirements, Ctrl+F5).
Be exact about state: "built and pushed", "written but untested", "not started" are different things.
No filler, no internal identifiers, no claiming more than the checks showed.

---

## 6. Things that will bite you (learned the hard way)

1. **`null` on screen.** `el.append(null)` / `replaceChildren(null)` render the text "null". Use
   `fill()` or pass children through `h()`; for conditional siblings spread an array.
2. **Schema changes.** There is no migration tool. New tables: just add the model. New columns on an
   existing table: add a nullable/defaulted column — `main.upgrade_schema()` issues `ALTER TABLE ADD
   COLUMN` at start-up (no foreign key on such columns; clean up manually). Never rename or drop a
   column or change its meaning; add a new one and migrate in `upgrade_schema`. There is a test that
   upgrades an old-shaped database — extend it.
3. **Label vs value formatting** in `summarize.py`: `_lbl()` for categories/periods, `_fmt()` for
   numbers. Formatting a year with `_fmt` gives "2,024".
4. **Shared test state.** The pytest fixtures are session-scoped: all test modules share one app and
   one database, run alphabetically. Other data models and users exist when your test runs; assert on
   your own objects and delete what you create (filters, senders, groups, restricted flags).
5. **Executing SQL through SQLAlchemy `text()`** treats `:name` as a bind parameter; `run_query`
   escapes single colons. Keep that if you touch it (`'12:30'`, `::time`, `LIKE 'c%'` are tested).
6. **DuckDB sandbox.** Files are loaded into memory, then `enable_external_access=false` and the
   configuration is locked. Do not reorder that.
7. **PDF text.** Browser exports (jsPDF core fonts) are Latin-1 only — text is sanitised. Server PDFs
   use DejaVu from matplotlib's font folder and handle Unicode. In narrow report columns use
   `align="L"` and the smaller chart canvas (`narrow=True`).
8. **Reading positions out of a PDF in tests:** use `pypdfium2`; pypdf's visitor reports wrong
   coordinates for some text.
9. **HTML drag and drop:** `<button>` elements are not draggable in every browser — draggable palette
   items are `div[role=button]`. In Playwright, scroll the target into view before dragging.
10. **Playwright text selectors** match substrings and several elements ("Chart" also matches
    "? Chart help"); prefer `button:text-is("Chart")` or scoped locators.
11. **Syntax-checking front-end modules:** `cp static/js/x.js /tmp/x.mjs && node --check /tmp/x.mjs`.
12. **One browser, one identity.** The session cookie is shared by all tabs. `app.js` re-checks
    `/api/auth/me` on navigation, focus and 403 and rebuilds the shell if the user or role changed.
    To test two users in a browser script, use two browser *contexts*.
13. **Mail servers differ.** STARTTLS is used when the server advertises it; port 465 needs implicit
    TLS; some relays reject AUTH. Map each failure to a sentence a non-technical admin can act on.
14. **The scheduler** runs in a thread of the app process and claims a due report with a conditional
    `UPDATE`, so several instances do not double-send. Keep it idempotent.
15. **Model code.** Before changing `llm.py`, read the current Anthropic SDK guidance available to you
    (parameters and model behaviour change between generations). The answer format is prompt-based JSON
    parsed by `parse_answer`, deliberately provider-neutral; refusals and truncation are handled
    explicitly. Use exact current model IDs; never invent date-suffixed ones.
16. **Windows.** Tell the owner to start with `py -3.14 -m uvicorn …` (stale `uvicorn.exe` launchers
    exist on their PATH) and that installing into a shared Python can disturb other packages.
17. **A chart can exist and still be blank.** The predictive charts were once destroyed by an unrelated
    repaint (`cleanup()` shared between two blocks) while every "canvas exists" check passed. The e2e suite
    now reads pixels (`drawn()` in `tests/e2e/predictive.js`). Assert that something was *drawn*.
18. **Statistics on real data misbehave.** First versions forecast a negative count, flagged 71% of rows
    as anomalies and reused a column name. Run every method on the sample data and *read the numbers*
    (see `test_engine_rules`); prefer honest messages ("no better than a naive guess") over a confident chart.
19. **The suite asks many questions as one user**; `conftest.py` raises the per-minute limit. A sudden
    wave of 429s in tests is that limit.
20. **Element screenshots of a scrolling area are clipped** to what is visible; enlarge the viewport first
    (`shotRun` in `tests/e2e/predictive.js`). Help images for tall answers are crops of those captures.
21. **Big one-line edits to dense JS** are where syntax slips happen. Edit in small, anchored
    replacements, and syntax-check after each file.

---

## 7. State of verification (keep this current)

- Verified end to end: Excel/CSV data models, PostgreSQL (live, read-only role), all UI flows in a
  headless browser, 2FA, exports, reports (design, live refresh, PDF layout, sharing, schedules),
  email against a local test server, row filters, group access, schema upgrade of an older database.
- **Not** run against live servers: MySQL, SingleStore, SQL Server, Oracle, Snowflake (same SQLAlchemy
  path as Postgres, own drivers).
- **Not** run against the real services: Anthropic / OpenAI APIs (stand-in servers only), a real
  SMTP provider, Docker image and compose file, Python 3.14 (developed on 3.13).
- Predictive analysis is verified on the sample data with a stand-in model only: whether a real model
  reliably returns a good `analysis` spec and input data set is unmeasured. Statistical methods are
  general-purpose (Holt-Winters / naive, logistic + random forest, ridge, k-means, isolation forest).
- Not built: free-form AI-written analysis code (deliberately), per-series forecasts in one question, SSO, scheduled data refresh of file models, report free-form (pixel) positioning,
  group selection in the Data models page's "Access" dialog (groups are set under Admin → Data access).

---

## 8. Definition of done

- [ ] The request is met as the owner would experience it, not just as an endpoint.
- [ ] No rule in §3 is weakened; new server paths enforce access, filters, guard and audit.
- [ ] `python -m pytest -q` passes, with new tests for the new rule/behaviour.
- [ ] `tests/e2e/run.sh` passes; you looked at the screenshots of what you changed.
- [ ] An existing `data/` folder still starts (schema upgrade considered).
- [ ] Help, README and screenshots match the behaviour.
- [ ] Committed and pushed; test processes stopped; nothing stray in the tree.
- [ ] The report states what was done, what was decided on the owner's behalf, and what was not
      verified.

---

## 9. What this file cannot do

It carries the context, the rules and the method. It does not carry judgement. When something here
conflicts with what you see in the code, trust the code and fix this file. When a request is not
covered, apply §3 and §5: protect the promises, verify for real, and tell the owner the truth about
what you did.
