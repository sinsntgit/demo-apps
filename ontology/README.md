# OntoStudio — ontology studio

Build a complete ontology for any domain with AI, on top of published industry standards; explain it, draw it,
edit it on the diagram, test whether it answers your use cases, and export it.

In-app **Help** (menu → Help) is the full user and administrator manual, with screenshots.

## What it does

| Area | What you get |
|---|---|
| **Build with AI** | From any of: a domain and scope · your own use cases and requirements · a database schema · documents or a whole folder. Pipeline: read sources → research standards → class hierarchy → relationships, attributes, controlled values, rules → completeness review → explanation → use cases. Runs in the background with live progress. |
| **Data sources** | A reusable library of databases (PostgreSQL, MySQL, SingleStore, SQL Server, Oracle, Snowflake, SQLite) and uploaded datasets (CSV, Excel, JSON) and documents (PDF, Word, PowerPoint, Markdown, text, JSON, XML). Tables are profiled on the server — row counts, types, keys, references (declared or inferred across files), code lists with their values, ranges, personal-data detection; people add documentation (notes and files) and business descriptions, and “Describe with AI” drafts the descriptions from the documentation for them to check; any number of ontologies can be built from scratch from them. Sample values to the AI are on per data source, off for personal columns, and can be switched off by an administrator. |
| **Pre-built library** | 22 ready-made starter ontologies across 19 industries (lending, banking, insurance, healthcare, manufacturing, supply chain, procurement, HR, CRM, finance, telecom, energy, IT service management, cybersecurity, projects, education, real estate, agriculture, public sector, data governance, travel, retail). Preview, copy into your library - optionally tailored by AI at once - and build on it. Any ontology can also be duplicated. |
| **Industry standards** | Built-in catalogue of 65 published ontologies and standards (schema.org, FIBO, HL7 FHIR, GS1, ISO 20022, SKOS, PROV-O, IOF, SAREF, TM Forum SID…). Candidates are matched locally; the AI chooses, says how each is used, aligns classes to published terms. |
| **Explanation** | Summary, purpose, scope in / out, how to read the model, a paragraph per module, design decisions. Editable; can be rewritten by AI. |
| **Diagram & visual editing** | Class hierarchy, relationships of a module, everything around one class. Expand / collapse branches (or all at once), show / hide attributes, maximise to the full window. Click a box or a line to edit; add classes, subclasses, relationships, attributes and metadata from the diagram. |
| **Use cases** | Required (yours), AI-written, manual. Each with a diagram of the part of the model that answers it, the path, SPARQL and an example answer. |
| **Proposed changes** | The reasoner proposes the changes that remove each contradiction (with alternatives where it is a business choice); “Propose fixes with AI” turns reasoner and modelling-check findings into add / change / delete items with reasons; the gap review and the test bed use the same tick-and-apply list, with dependencies kept together. |
| **Knowledge graph** | The ontology filled with your actual records. Map classes to tables, attributes to columns, relationships to joins and controlled values to code columns — matched by names, proposed by AI (every entry checked against the ontology and the tables), reviewed as drafts. Build it from the data sources (read-only, up to 10,000 rows per table by default; personal columns left out unless the owner allows them), see records and values per class and property and the data problems found, and query it (SPARQL, read-only, time-limited) with a table of results and a picture of the records behind them. **From documents** too: the AI extracts entities and relationships from judgments, opinions, contracts or policies using the ontology as its only vocabulary; every item must quote the document's own words, which the application checks; the same thing mentioned in different documents is merged; nothing enters the graph until a person accepts it, and every record keeps the document, page and quote it came from. An **explorer** to find records and follow their links; downloads of the graph (Turtle) and the mapping (W3C R2RML); nightly or weekly rebuilds. Only people with access to every data source behind it see its records. |
| **Test bed** | Enter any use case → requirement-by-requirement coverage, verdict, gaps, a picture with the proposed additions, tick which to add, then “Test again” re-checks the same requirements so the scores compare. The application verifies the model's claims and computes the score itself. With a knowledge graph built, the use case is also **answered from your data**: the AI writes a query, the application runs it, and you see the rows, the records behind them and what has no data — the results never go to the AI. |
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
| `ONTO_HERMIT_MEMORY_MB` | `1024` | Memory HermiT asks Java for first; it steps down to 512 and 256 MB automatically if Java cannot reserve it. |
| `ONTO_APP_NAME` | `OntoStudio` | Default name (can also be changed in Admin › Appearance). |

Optional extras:

- **Live database reading** needs the driver for that database: see `requirements-drivers.txt`
  (`pip install psycopg2-binary` for PostgreSQL, and so on). Schema scripts and SQLite files need nothing extra.
- **HermiT reasoner** needs Java on the server — a 64-bit Java is recommended (a 32-bit Java can reserve only a little memory). Without it the built-in reasoner is used and the HermiT button is greyed out.

### Updating

1. Stop the application (Ctrl+C in its window).
2. Replace the application files with the new ones and **keep your `data` folder**. New database columns are added
   automatically at start-up.
3. Run `pip install -r requirements.txt` again if the release notes say requirements changed.
4. Start the application again **from the folder you updated**.
5. Check the version shown at the bottom of the menu.

The browser always fetches the new screens after an update (since version 1.6 the files are served under a fingerprint
of their content). A page that was left open during the update offers to reload.

## What is sent to the AI model

The domain, scope, required use cases, requirements and notes of the ontology; the text extracted from its source
documents and the *structure* of its databases; entries of the standards catalogue; the ontology itself; and the use
case typed into the test bed; to propose a knowledge-graph mapping, the table profiles; to write a query for the test bed, which
classes of the graph have records and which properties hold values; to extract facts, the text of the documents chosen. Never: bulk database rows, the records of a knowledge graph or
the results of its queries, passwords, API keys, other ontologies.
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
- data sources: profiling of a SQLite database and of CSV files (keys, inferred joins across files, code lists, personal-data detection), business descriptions reaching the model, personal values never sent, statistics-only mode, access rules, encrypted database password and re-read, building an ontology from a data source alone;
- all 22 pre-built ontologies: parsed without loss, quality score 93+, valid Turtle export, consistent under the reasoner;
  copy and duplicate with their access rules;
- knowledge graphs: AI-proposed mapping checked (non-existent classes, tables and columns dropped and reported), matching by names,
  building from kept CSV files and from a database (SQLite standing in for a live server) with the row limit per table, types of
  ancestor classes and inverse links added, dangling links and unmatched code values counted, personal columns left out unless allowed,
  queries that write or call other servers refused, syntax errors reported, the test bed answering a use case from the data (with one
  correction of a broken query), query results never reaching the model, records hidden from people without access to the data
  source (ontologist and viewer), the old store removed after a rebuild and the graph removed with its ontology;
- knowledge graphs from documents: invented classes, quotes not in the document and relationships with the wrong domain rejected with
  their reason; amounts and dates converted; pages found from the quote; the same company named differently in two documents merged and
  the second document told about it; near-duplicates offered for merging; nothing in the graph before acceptance; re-reading a document
  keeps what was accepted; answers, the explorer and the console citing document, page and quote; records hidden from people without
  access; quotes and pages also checked on the user's three real judgments (PDF, up to 57 pages); the explorer, Turtle and R2RML
  downloads (both re-parsed); scheduled rebuilds, including one switched off because its owner lost access;
- OWL and Turtle import keeping modules, rules (incl. disjoint classes), cardinalities, namespace and scope (round trip of the sample;
  the user's 69-class tax ontology comes back with its 8 modules and 50 rules);
- every screen in a headless browser, including visual editing on the diagram, as administrator and as viewer;
- the Anthropic SDK code path (streaming, effort, token accounting) against an Anthropic-shaped stand-in server.

**Not** verified:

- **Extraction quality with a real model.** The checks were exercised with a stand-in model's planted mistakes; how much a real model
  finds in a long judgment, how often it paraphrases instead of quoting, and what it costs per document are unmeasured.
- **Real AI models.** No call was made to the real Anthropic or OpenAI APIs, or to a real self-hosted model. How good
  and how complete a real model's ontology is, how long a build takes and what it costs are therefore unmeasured.
  The first real build is the real test — start with a Standard-size ontology.
- **Live database servers.** Reading structure and profiling were run against SQLite only. For PostgreSQL, MySQL, SingleStore, SQL Server, Oracle and Snowflake the drivers were installed and checked to accept their connection settings and reach the network (no server was available to log in to). PostgreSQL, MySQL, SQL Server and Oracle
  use the same code path through their own drivers and were not run against live servers.
- Windows, and Python versions other than 3.13.
- Very large inputs (hundreds of documents; ontologies near the class limit). Knowledge graphs were built from a few hundred rows;
  build times and query speed for tables of 100,000+ rows were not measured.
- Knowledge graphs against live PostgreSQL, MySQL, SQL Server, Oracle, Snowflake or SingleStore servers (the same SQLAlchemy code path
  as profiling, run against SQLite only). The query time limit relies on stopping a separate process; that was checked on Linux,
  not on Windows.
- The reused terms the AI lists for a standard are not checked against the standard itself — the UI says so.
- **The pre-built ontologies are starter models written for this application**, aligned to the published standards from
  knowledge of them. They were not compared term by term with the official ontology files (which could not be
  downloaded here) and have not been reviewed by a practitioner of each industry. They are sound as models
  (see above); whether each fits a given organisation is for that organisation to judge and extend.

Not built: single sign-on; user groups (access is per person or “everyone”); free positioning of boxes in diagrams
(layout is automatic); looking standards up live on the internet; reading rows of data to infer an ontology;
scheduled re-tests; email notifications. Knowledge graphs: not yet built are querying a database in place without copying it,
loading into an external graph database, linking a record from documents to the same record from tables (they stay separate), and
mapping a class with more than one identifying column. Scanned PDFs (images only) cannot be read.
