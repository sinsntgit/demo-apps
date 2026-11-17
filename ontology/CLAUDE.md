# OntoStudio (ontology/) — handoff guide for an AI coding agent

Read this before changing anything under `ontology/`. `README.md` is the overview and the honest list of what is
verified; `static/help/help.html` is the in-app manual and the most precise description of intended behaviour.
The sibling app `text2sql/` (other branch) is the precedent for the platform parts (auth, admin, front-end style);
its `CLAUDE.md` describes the working method, which applies here unchanged.

## Who this is for

The owner is a product owner, not a developer. They run it on Windows from a zip of the branch and **keep their
`data` folder** across updates. They judge by using it. Value order: it works → their data is safe → it is explained
plainly → they are told what was not verified.

## Product in one paragraph

An ontology studio. A user creates an ontology from a domain, their use cases and requirements, a database schema or
documents; an AI pipeline researches published standards and builds the ontology; the app explains it, draws it, lets
it be edited on the diagram, tests use cases against it, runs a reasoner, and exports PDF / PowerPoint / Excel / OWL /
Turtle / JSON-LD / JSON. Roles: `viewer` (read, export, test) · `ontologist` (create, build, edit) · `admin` (all).

## Rules that must never be broken

1. **Nothing a model returns is trusted.** Every model answer goes through `onto.clean` / `onto.merge` /
   `onto.verify_test`: elements are rebuilt field by field, dangling references repaired or dropped, sizes capped.
   Never store or display raw model JSON.
2. **Scores are computed by the application.** Test-bed coverage and verdict come from `onto.verify_test`; a
   "covered" claim without existing evidence is marked down. Quality score comes from `onto.quality`.
3. **Facts about a catalogued standard come from `catalogue.py`**, not from the model (name, publisher, URL,
   namespace). Model-proposed standards are flagged `in_catalogue: false`; URLs must be http(s).
4. **Access is enforced on the server** through `deps.get_ontology` / `deps.get_folder` on every route (view / edit /
   manage; folder inheritance; the Viewer role is always read-only). The UI only hides.
5. **Databases are read, never written.** `sources.introspect` (per-ontology sources) reads structure only and does not store
   the password. Data sources (`profiling.profile_database`) read structure plus at most 2,000 rows per table, with
   SELECTs built by SQLAlchemy Core only; their password is stored encrypted for re-reads. Passwords must never reach
   an API response, logs, audit or error messages. Only profiles and (where allowed) a few sample values go to a model;
   values of personal-looking columns only if the data source owner allows it; the admin setting `share_sample_values`
   switches all values off.
   Knowledge graphs (`kg.py`) read the rows of mapped tables, again only with SQLAlchemy Core SELECTs and a row limit
   (`graph_rows_per_table`), or the kept copy of an uploaded dataset (`data/datasets/`, `DataSourceItem.stored`).
   Personal-looking columns are not loaded unless the data source allows it (`graph_personal`).
   **Records of a knowledge graph and query results never go to a model** — the model that writes a query gets
   `kg.describe` (which classes have records, which properties hold values), nothing more. Records reach a person
   only through `graph.visible_data` / `_may_see`: they must be able to use every data source the graph was built from.
   Queries run in `kg_worker.py`, a separate process with a time limit, on a store opened read-only; SERVICE is refused.
6. **`builder.py` is the only place content is assembled for a model.** Source material and user text are wrapped in
   tags and described as material, not instructions. Nothing is truncated silently — what was not read is reported.
7. **Secrets are encrypted at rest** (`security.encrypt`) and never returned by an API.
8. **An existing `data/` folder must keep working after an update.** New column → nullable/defaulted; `upgrade_schema`
   adds it. Never rename or drop a column.
9. **No build step, no CDN.** Plain ES modules, strict CSP (`script-src 'self'`), works offline.
10. **Every state-changing action is audited** (`deps.audit`).
11. **Every change to an ontology is a new version** (`builder.save_version`). Nothing overwrites history.

## Architecture

Python 3.11+ · FastAPI · SQLAlchemy 2 (SQLite default) · rdflib + owlrl (+ owlready2/HermiT if Java) · fpdf2 +
matplotlib (PDF, diagram images) · python-pptx · openpyxl · pypdf / python-docx (sources). Front end: buildless ES
modules, hash routes. Run: `python -m uvicorn app.main:app --port 8000`.

| File | Responsibility |
|---|---|
| `app/main.py` | App, security headers / CSRF middleware, `bootstrap()` (tables, first admin, sample ontology), `upgrade_schema()`. |
| `app/config.py` | Env vars, `DEFAULT_SETTINGS` (admin-editable, incl. appearance), `DEPTHS`, `ACCENTS`. |
| `app/models.py` | `User`, `LLMModel`, `Ontology` (current content), `OntologyVersion`, `KnowledgeGraph`, `Folder`, `FolderAccess`, `Source`, `TestRun`, `Job`, `AuditLog`, `Setting`. |
| `app/deps.py` | Current user, role guards, settings, audit, `folder_level` / `level` / `get_ontology` / `get_folder`. |
| `app/security.py`, `routers/auth.py` | Passwords, sessions, TOTP, encryption, rate limiter; `/api/auth/branding` is public. |
| `app/onto.py` | **The ontology document**: shape, `clean`, `merge`, graph helpers, `quality`, `outline` (prompt form), `verify_test`. |
| `app/catalogue.py` | 65 published ontologies / standards and local keyword matching (`candidates`). |
| `app/builder.py` | Prompts and pipeline stages, `read_sources` (verbatim or distilled), jobs (threads, queue, `recover`), `save_version`. |
| `app/llm.py` | Providers: `anthropic` (official SDK, streamed), `openai`, `openai_compatible`. Tolerant JSON parser. |
| `app/sources.py` | Text extraction from documents; database structure introspection; `Unreadable` messages for users. |
| `app/layout.py` | Diagram layouts → neutral spec (nodes, edges, legend). **One layout, two renderers.** |
| `app/render.py` | `draw` (spec → PNG), `build_pdf`, `build_pptx`, `build_xlsx`. |
| `app/exports.py` | rdflib graph → OWL / Turtle / JSON-LD; native JSON; `import_file`. |
| `app/reasoner.py` | OWL 2 RL with probe individuals; HermiT via owlready2; structural contradictions. |
| `app/profiling.py` | Table and column profiling (types, roles, code lists, ranges, personal-data detection, inferred joins) for databases and dataset files; `describe` renders a profile for the model. Only SQLAlchemy Core SELECTs with a row limit. |
| `app/datasources.py`, `routers/datasources.py` | The data-source library: access (`level`/`get`), reading (`read_database`, `add_files`), linking to ontologies, `material` (what a build receives). Passwords encrypted in `config_enc`, never returned. |
| `app/kg.py`, `app/kg_worker.py`, `routers/graph.py` | Knowledge graphs: the mapping (`clean_mapping` checks every entry against the ontology and the tables; `suggest` matches by names; `merge` keeps what people confirmed), `build` (rows → pyoxigraph store in `data/graphs/<folder>`, a new folder per build), `run_query` (worker process, time limit, read-only), `shape` (result table + picture). Model prompts for mapping and querying are in `builder.py` (`MAP_PROMPT`, `QUERY_PROMPT`, `answer_from_data`). |
| `app/kgdocs.py` | Facts from documents: `documents` / `text_of` (data-source and ontology documents), `chunks`, `accept_chunk` (**every extracted item checked**: class / property / value exist and fit, and its quote must occur in the document - `Doc.find`, which also gives the page from form feeds between PDF pages), name normalisation and merging (`name_key`, `merge`, `suggest_merges`), review status (`set_status`), `evidence`. Stored in `KnowledgeGraph.extracted`; only `accepted` items are built (IRIs `<data base>/doc/<id>`). Prompt `EXTRACT_PROMPT` and job `_extract` in `builder.py`. |
| `app/library.py`, `library/*.onto` | The pre-built library: plain-text ontology files (format documented at the top of `library.py`), parsed and validated at first use; a bad file is logged and skipped. The retail sample is added as the `retail` entry. |
| `app/sample.py` | Hand-written retail ontology installed on first run; also the stand-in model's canned answer. |
| `app/routers/ontologies.py` | Library, folders, sources, jobs, edit, diagrams, versions, exports, test bed, reasoner, usage. |
| `app/routers/admin.py` | Users, models, settings (incl. appearance), AI activity, audit. |
| `static/js/core.js` | `h()`, `fill()`, `api()`, `modal()`, `toast`, `busy`, theme + branding. |
| `static/js/app.js` | Boot, nav, router (tab switches inside an ontology do not reload). |
| `static/js/library.js`, `sources.js` | Library, folder access, import, New ontology wizard; file/folder picker, upload, database form. |
| `static/js/workspace.js` | One ontology: header, AI menu, job progress, Overview, Standards, Sources, Versions. |
| `static/js/editor.js` | Diagram editor, class / property forms, tables, Use cases, Test bed, Quality & reasoning. |
| `static/js/diagram.js` | SVG renderer for a layout spec (zoom, pan, click). |
| `static/js/kg.js` | Knowledge graph tab (status, mapping list and form, coverage, query console); `resultView` is reused by the test bed. |
| `static/js/templates.js` | Pre-built library screen: filter, preview, copy (optionally with an AI instruction). |
| `static/js/usage.js`, `admin.js`, `help.js`, `auth.js`, `account.js` | As named. |

Knowledge graph (`KnowledgeGraph`, one per ontology): `mapping = {"maps": [{id, class, source, item, table, key, label,
where{column,value}, ai, attributes[{property, column}], values[{property, column}], links[{property, to (map id), side
from|to|link, column, link_item, link_table, to_column}]}]}`; `stats` from the last build; `sources` = data source ids it holds data
of (decides who sees records). Record IRIs: `<namespace without #>/data/s<source>/<table>/<key>`.

Content shape (`Ontology.content`): `meta`, `standards[]`, `modules[]`, `classes[]` (id, label, definition, parent,
module, aligned_to, alignment, synonyms, abstract, derived_from), `properties[]` (id, label, kind object|data, domain,
range, cardinality, inverse, derived_from), `individuals[]`, `rules[]` (kind `disjoint` becomes `owl:disjointWith`),
`explanation{}`, `use_cases[]`.

## Things that will bite you

1. `el.append(null)` renders the text "null": build DOM with `h()` / `fill()`.
2. Diagram specs are drawn by `static/js/diagram.js` **and** `app/render.py::draw`. Change both.
3. `onto.merge` updates only the fields the caller supplied (so a field can be cleared); a brand-new element gets
   defaults from `clean_*`.
4. A property whose domain or (object) range does not exist is dropped by `clean` — by design.
5. Jobs run in threads with their own DB session; SQLite is in WAL mode. A job that fails must leave the ontology
   `ready` (or `failed` if never built) — see the `finally` in `builder.run`.
6. Routes: fixed paths before `/ontologies/{oid}/run/{kind}`; do not add a catch-all two-segment POST under an ontology.
7. The pytest fixtures are session-scoped: one app, one database, shared by all tests. Delete what you create.
8. HermiT rejects `xsd:date` and friends; `reasoner._graph` swaps them in a copy only.
9. Toasts linger ~3.5 s: in browser tests wait for the toast with *your* text.
10. `tests/fake_llm.py` decides what to answer from phrases in the prompt ("Step 2: design the class hierarchy" …).
    If you reword a prompt, update the stand-in.
11. Before changing `llm.py`, read current Anthropic SDK guidance: requests are streamed (`messages.stream` →
    `get_final_message`), `max_tokens` 64000, effort via `output_config`, no sampling parameters, no `thinking`
    parameter (current models think adaptively by default). Use exact model IDs.
12. In `routers/ontologies.py` the module `app.library` is imported as `prebuilt`, because the route function
    `library()` (GET /api/library) has the same name.
13. A library ontology must survive `onto.clean` without losing anything - `library.parse` raises if a property or
    class is dropped. The test `test_every_library_ontology_is_sound` holds every file to the same bar; run it after
    adding or editing a `.onto` file. Library content is never edited at run time: users work on copies (`_new_copy`).
14. Front-end files are served under `/static/v-<ASSET_TAG>/` (a hash of the files, `config.ASSET_TAG`), injected into
    `index.html` by `main.spa`; the middleware maps it back to `/static/`. Before this, browsers kept lazy-loaded
    modules from earlier versions and updates "did not show". Keep module imports relative (`./x.js`) so they stay
    under the versioned prefix.
15. Jobs of kind `graph` call no model (`builder.NO_MODEL`): no AI slot, excluded from the AI usage dashboard. The test job
    commits the design result before answering from the data, so a failure there never loses the test. `_job()` drops a result
    key named `proposed` — do not use that name in a job result.
16. Scheduled rebuilds: `routers/graph.run_due` is called every minute by a thread started in `main.lifespan`; a rebuild runs as the
    person who set it up (`refresh_user_id`) and is switched off when they lost access. A summary dict must not use the key
    `proposed` either (it travels in job results) - hence `to_review`.
17. A pyoxigraph store left open blocks deleting its folder on Windows; old stores are removed after each build and at start-up
    (`kg.cleanup`), ignoring errors.
18. Help screenshots are produced by `tests/e2e/features.js` and copied by name into `static/help/img/`.
    Check for drift: every `img/*.png` named in `help.html` must exist.

## Verification — non-negotiable

```bash
python -m pytest -q        # API tests
tests/e2e/run.sh           # browser walk-through; look at the screenshots of what you changed
```

Open generated PDFs / decks / workbooks and read them. Say plainly what was not verified, and keep the
"What has and has not been verified" section of `README.md` current.

## Definition of done

- [ ] The request works as the owner would experience it.
- [ ] No rule above is weakened; new routes check access and audit.
- [ ] `pytest` and `tests/e2e/run.sh` pass, with a test for the new rule or behaviour.
- [ ] An existing `data/` folder still starts.
- [ ] Help, README and screenshots match the behaviour.
- [ ] Committed and pushed; test processes stopped.
