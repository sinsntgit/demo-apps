# OntoStudio — ontology studio

Build a complete ontology for any domain with AI, on top of published industry standards; explain it, draw it,
edit it on the diagram, test whether it answers your use cases, and export it.

In-app **Help** (menu → Help) is the full user and administrator manual, with screenshots.

## What it does

| Area | What you get |
|---|---|
| **Build with AI** | From any of: a domain and scope · your own use cases and requirements · a database schema · documents or a whole folder. Pipeline: read sources → research standards → class hierarchy → relationships, attributes, controlled values, rules → completeness review → explanation → use cases. Runs in the background with live progress. |
| **Industry standards** | Built-in catalogue of 65 published ontologies and standards (schema.org, FIBO, HL7 FHIR, GS1, ISO 20022, SKOS, PROV-O, IOF, SAREF, TM Forum SID…). Candidates are matched locally; the AI chooses, says how each is used, aligns classes to published terms. |
| **Explanation** | Summary, purpose, scope in / out, how to read the model, a paragraph per module, design decisions. Editable; can be rewritten by AI. |
| **Diagram & visual editing** | Class hierarchy, relationships of a module, everything around one class. Click a box or a line to edit; add classes, subclasses, relationships, attributes and metadata from the diagram. |
| **Use cases** | Required (yours), AI-written, manual. Each with a diagram of the part of the model that answers it, the path, SPARQL and an example answer. |
| **Test bed** | Enter any use case → requirement-by-requirement coverage, verdict, gaps, a picture with the proposed additions, one click to add them and re-test. The application verifies the model's claims and computes the score itself. |
| **Quality & reasoning** | Automatic modelling checks (score / 100) · OWL reasoner: built-in OWL 2 RL, and HermiT when Java is present · AI gap review by any configured model, applied only on request. |
| **Library** | Nested folders with access levels (view / edit / owner), private or shared ontologies, import of OWL / Turtle / JSON-LD / JSON files. |
| **Versions** | Every change is a version with a diff; restore any time. |
| **Downloads** | PDF handbook · PowerPoint deck · Excel workbook · OWL (RDF/XML) · Turtle · JSON-LD · JSON. |
| **AI usage dashboard** | Jobs, model calls, tokens, estimated cost per day / kind / model / ontology. Each user sees their own; administrators see everyone and can filter. CSV export. |
| **Administration** | Users and roles, 2FA, AI models (Anthropic Claude, OpenAI, self-hosted OpenAI-compatible such as Ollama / vLLM), appearance (name, accent colour, default theme, sign-in message, export footer), settings, AI activity, audit log. |

## Run it

Needs Python 3.11 or newer.

```bash
cd ontology
pip install -r requirements.txt
python -m uvicorn app.main:app --port 8000
```

Windows (PowerShell):

```powershell
cd D:\ontostudio
py -m pip install -r requirements.txt
py -m uvicorn app.main:app --port 8000
```

Open <http://localhost:8000>. On the first start the administrator's email and a one-time password are printed in
the terminal window; you are asked to choose your own password at first sign-in.

Then: **Admin › AI models** → edit “Claude Opus 5.5”, paste your Anthropic API key, tick Enabled, Save, press **Test**.
A sample ontology is already in the library, so every screen can be tried before a model is set up.

### Settings (environment variables, all optional)

| Variable | Default | Meaning |
|---|---|---|
| `ONTO_DATA_DIR` | `data` folder next to the app | Where the database and the secret key live. **Back this folder up; keep it when updating.** |
| `ONTO_SECRET_KEY` | generated into the data folder | Signs sessions, encrypts stored API keys. |
| `ONTO_ADMIN_EMAIL` / `ONTO_ADMIN_PASSWORD` | `admin@example.com` / generated | First-run administrator. |
| `ONTO_COOKIE_SECURE` | `0` | Set to `1` when served over HTTPS. |
| `ONTO_DATABASE_URL` | SQLite in the data folder | e.g. a PostgreSQL URL. |
| `ONTO_APP_NAME` | `OntoStudio` | Default name (can also be changed in Admin › Appearance). |

Optional extras:

- **Live database reading** needs the driver for that database: see `requirements-drivers.txt`
  (`pip install psycopg2-binary` for PostgreSQL, and so on). Schema scripts and SQLite files need nothing extra.
- **HermiT reasoner** needs Java on the server. Without it the built-in reasoner is used and the HermiT button is greyed out.

### Updating

Replace the application files with the new ones and **keep your `data` folder**. New database columns are added
automatically at start-up. Run `pip install -r requirements.txt` again if the release notes say requirements changed.
Press Ctrl+F5 in the browser afterwards.

## What is sent to the AI model

The domain, scope, required use cases, requirements and notes of the ontology; the text extracted from its source
documents and the *structure* of its databases; entries of the standards catalogue; the ontology itself; and the use
case typed into the test bed. Never: database rows (they are not read), passwords, API keys, other ontologies.
Use a self-hosted model if the source material must not leave your network. The application makes no other outside
connections; it does not look anything up on the internet.

## Tests

```bash
pip install -r requirements-dev.txt
python -m pytest -q            # API tests against a stand-in model (about 20 seconds)
tests/e2e/run.sh               # browser walk-through of every screen (needs Node + Playwright + Chromium)
```

## What has and has not been verified

Verified here, with a stand-in AI model that returns a fixed retail ontology (`tests/fake_llm.py`):

- the whole pipeline end to end, including required use cases, documents, a database schema, retry on unreadable
  model answers, and repair of dangling references in model output;
- the test bed's own checks (a claim pointing at a non-existent element is marked down; score computed by the app);
- folders and access levels for every route, viewer role, sharing;
- OWL / Turtle / JSON-LD exports re-parsed with rdflib; import round-trip; PDF, PowerPoint and Excel opened and read;
- both reasoners on a correct ontology and on one with planted contradictions (HermiT with Java 21);
- AI usage rules (a user cannot see another's usage); appearance; schema upgrade of an older database;
- every screen in a headless browser, including visual editing on the diagram, as administrator and as viewer;
- the Anthropic SDK code path (streaming, effort, token accounting) against an Anthropic-shaped stand-in server.

**Not** verified:

- **Real AI models.** No call was made to the real Anthropic or OpenAI APIs, or to a real self-hosted model. How good
  and how complete a real model's ontology is, how long a build takes and what it costs are therefore unmeasured.
  The first real build is the real test — start with a Standard-size ontology.
- **Live database servers.** Reading structure was run against SQLite only. PostgreSQL, MySQL, SQL Server and Oracle
  use the same code path through their own drivers and were not run against live servers.
- Windows, and Python versions other than 3.13.
- Very large inputs (hundreds of documents; ontologies near the class limit).
- The reused terms the AI lists for a standard are not checked against the standard itself — the UI says so.

Not built: single sign-on; user groups (access is per person or “everyone”); free positioning of boxes in diagrams
(layout is automatic); looking standards up live on the internet; reading rows of data to infer an ontology;
scheduled re-tests; email notifications; a SPARQL endpoint or instance data store.
