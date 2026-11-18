# Context Intelligence Engine (Phase 1 POC) — Instructions for Development Agents

Read this whole file before writing code. It is the build contract for scope, data model, work
packages and acceptance gates. If code and this file disagree, this file wins. If you must
deviate, update this file in the same commit and record the reason in §13 (Decision log).

Baseline documents (both are git-ignored inputs; ask the user if they are missing):
- Customer brief: *Context Intelligence Engine – Phase 1* (one-page PDF).
- Design baseline: *Phase 1 Findings and POC Design* (markdown, produced with ChatGPT). This file
  adopts it, with the changes listed in §2.

---

## 1. Goal and scope

Turn VzGPT customer–agent traces into **governed, traceable evidence cards** about recurring needs,
buying signals, retention risk, journey friction, value signals and geographic patterns.

```
Raw landing → canonical session model → intents + signals → episodes → features
  → cluster families → patterns → score dimensions → evidence cards → UI / retrieval
                                         ↘ dated, superseded facts (point-in-time)
```

| In scope (Phase 1) | Out of scope |
|---|---|
| Ingesting the real sample + **100,000 synthetic complete conversations** | Customer 360, Network 360, PII/CPNI enrichment |
| Session-centric canonical model with raw lineage | Authoritative price, eligibility, inventory, consent |
| Discovery, definition and versioning of an **L1–L4 intent taxonomy** | Actual revenue, conversion, churn or save validation |
| Signals, episodes, features, four cluster families, patterns, score dimensions | Real-time intervention or autonomous offers |
| Evidence cards with review workflow; persistent dated facts | Production agent changes |
| **Retrieval pipeline**, **web UI**, overnight batch, validation report, runbook | |

Every output must keep five things distinguishable: (1) observations from the real sample;
(2) synthetic scenarios and their generated outcomes; (3) model/rule-inferred signals and
classifications; (4) customer-approved taxonomy and definitions; (5) business hypotheses as opposed
to verified outcomes.

---

## 2. How this plan reconciles the inputs

### 2.1 Confirmed by the customer

| # | Decision | Consequence |
|---|---|---|
| C1 | One session = one complete conversation. A session contains many traces (one per turn), spans and tool calls | The session is the business unit. A trace is never treated as a conversation |
| C2 | No master intent taxonomy exists | Taxonomy discovery, definition, SME review and versioning are core scope (WP4) |
| C3 | 100,000 synthetic **complete conversations**; child records come on top of that | Count distinct `session_id`s, not rows |
| C4 | The sample is redacted production data and is **representative** | Calibrate synthetic data to it (gate G0) |
| C5 | `previous_session_id` is populated in production (assumed for now) | Thread linkage, repeat contact and A→B sequences are first-class |
| C6 | Structured session location will be supplied (schema pending) | Geography comes from a structured field; text places are secondary and typed (§6.6) |
| C7 | City-level aggregates and redacted quotes are acceptable under the CPNI policy | Quotes allowed; k-anonymity and quote sanitising are kept as defence in depth |
| C8 | No `head_intent.*` reference list is available | Use the platform intents seen in the data as *evidence* for the taxonomy, not as the taxonomy |

### 2.2 Adopted from the design baseline (it is right about these)

- Immutable raw landing; every derived row is traceable to session, turn and trace.
- Normalised evaluation records: value, scale, status, evaluator, rationale and version kept separately.
  Similarly named metrics are not assumed comparable. A status code is not proof of resolution.
- A governed L1–L4 taxonomy with definitions, inclusion/exclusion criteria, examples, `UNKNOWN`, stable IDs,
  versions and SME approval. One primary + zero or more secondary intents per session. Optional turn-level intent.
- **Score dimensions are kept separate**: prevalence, recurrence, trend, evidence strength, business
  relevance, geographic concentration. A composite exists only as a configurable, *provisional* view
  until the customer approves weights.
- Cluster families overlap (a session can belong to several). Machine cluster IDs are never exposed as
  taxonomy; governed stable IDs are.
- Scenario-first synthetic generation with scenario/template ID, generator version, seed and batch on every
  record. Evaluation values derive from ground truth through a rubric, not at random. Tool failures and
  retries, multi-intent calls, silence and repetition are included. Held-out test sessions are kept separate.
- Four weekly exit gates with SME review (§10).
- Its logical table names (§5) are adopted so the customer-facing design and the code use the same vocabulary.

### 2.3 Added or corrected here (missing from the design baseline)

| Topic | What we do |
|---|---|
| **Retrieval and UI** (explicitly requested by the user) | WP9 and WP11 |
| Platform intent labels exist in tool spans (`mandatory_set_intent_for_next_step.intent_name`, `requested_operator`, agent paraphrases in `retrieve_intent_matches.user_intent` / `explain_bill_init_mcp.query` / `handle_out_of_scope.topic`) | Strongest evidence for taxonomy discovery and classification; extracted first-class |
| Real sample profile: 6.7 turns/session, 86% transferred, 31% explicitly ask for an agent, 32% of turns are system events, 5% null outputs, some Spanish/Portuguese turns | G0 calibration targets; multilingual tolerance in extractors |
| Raw payload is **~549 KB/session (~103 KB gzipped)**, mostly nested LLM span prompts, so 100K sessions is ~56 GB raw / ~10.5 GB gzipped | Raw landing is **gzipped files plus a byte-offset index**, not database blobs. Synthetic spans are schema-faithful but slim (§6.1) |
| Redaction is imperfect: "Lake Mary Florida" and exact dollar amounts appear in redacted text | A second PII scrub at ingest and a quote sanitiser before cards |
| Statistical rigour for patterns | Rate shrinkage, Wilson CIs, Benjamini–Hochberg FDR, k-anonymity floor |
| Validation against planted truth | Synthetic effects with known truth (city×intent lifts, time-boxed events, sequences); recovery and false-discovery measured |
| Storage choice | **SQLite**, as the user asked; it is fine for 100K conversations. All SQL stays portable to the customer's Postgres/warehouse (§4) |

### 2.4 Still open (build with the default; don't block)

| # | Question | Default we build |
|---|---|---|
| O1 | Is "100000" the overnight feed volume **per day**, or the total POC volume? | Total = 100K synthetic conversations (C3). The pipeline is still incremental per day, and the scale gate G9 runs only if per-day is confirmed |
| O2 | Episode definition: whole session, a need within a session, or a sequence of sessions? | **A distinct need within a session** (`session_episode`). Threads (sequences of sessions) are modelled separately; switching is a config flag |
| O3 | Is a stable pseudonymous customer key available beyond `previous_session_id`? | Thread = linkage via `previous_session_id`; `customer_key` column nullable |
| O4 | Structured location schema and location type (home, service or current)? | `user_metadata.location = {city, state, zip3?, market?, type?}`, read through `config.LOCATION_PATHS`; type defaults to `service` |
| O5 | Approved LLM/embedding services and processing location? | None. The rule-based + TF-IDF/LSA path runs offline; LLM and embedding adapters are pluggable and disabled by default |
| O6 | Languages? | English primary; Spanish detected and tagged (`lang`), included in synthetic data at the real-sample rate, routed to `UNKNOWN` intent when rules have no coverage |
| O7 | Synthetic date range | 12 weeks ending 2026-11-15 |
| O8 | Who approves taxonomy, clusters, scores and cards? | The UI records reviewer and time; the approver role is configurable |

---

## 3. Facts about the input you must design for

Source: `sample/verizon_traces_example.jsonl` (36 sessions, 241 traces, one day: 2026-09-14). It is
git-ignored and must never be committed.

- A line is a `session` with `traces[]`. Each trace has `spans[]` → a `workflow` span → nested `llm`
  and `tool` spans. Recurse; never assume depth.
- Trace order in the file is arbitrary. Turn number = N in `name` (`"turn N workflow"`); numbering
  can start above 1 because exports are windows. Fall back to `created_at`.
- `input`/`output` are JSON **strings** of `[{role, content}]`. `output` may be `null`. `content` may be
  a dict (tool payloads).
- `output[].role` is the agent/skill name. Lower-case it (`Root_agent` and `root_agent` are the same).
- System turns arrive as customer content: `<event>session start</event>`,
  `<event>sys.remote-call-disconnected</event>`, `<context>user pressed N on keypad.</context>`,
  `<context>no user activity detected for 9 seconds.</context>`, `<context>function [...] completed ...</context>`.
- Tool names containing `transfer` mean a handoff was executed. `invalid_auth`,
  `action_validate_account_pin`, and `esp_*` loops mean authentication friction.
- Agent text contains lower-case markup (`[prosody rate="64%"][warm]`). Strip it. Keep UPPER-case
  redaction placeholders (`[LOCATION]`, `[CUSTOM_NUMBER_SEQUENCE]`, `[PERSON_NAME]`, `[URL]`, `[GENERIC_ID]`).
- `input == redacted_input` throughout the sample. Read **only** `redacted_*`.
- Session metrics have 132 fields and trace metrics about 153: LLM-judge scores (values may be `[x]`, a
  float or a string), rationales, statuses, token/cost fields, and `cm_policy_metric` (a JSON string with
  `journey`, compliance rates and per-policy verdicts). Tokens and costs are operational. Judge
  `*_status: not_applicable` and `*_error_message` mean "no value", not 0.

---

## 4. Engineering rules

- Python 3.11+. Dependencies: numpy, scikit-learn (which includes HDBSCAN), scipy, pytest. The server
  uses `http.server`. The UI is vanilla JS/SVG with no CDN and no build step.
- **SQLite** in WAL mode for the canonical store, with external-content FTS5 for search. Keep SQL portable:
  FTS5 is isolated in `retrieval.py` and no SQLite-only functions are used elsewhere. Target: 100K
  conversations → about 700K turns, about 150–250K episodes and 1–3M signals; DB < 2 GB.
- Every stage is `run(con, run_id, cfg) -> stats`. Stages are idempotent and deterministic (seeded),
  and record themselves in `processing_run`.
- All thresholds, weights and paths live in `config.py`. Versions (taxonomy, rules, model, scoring,
  generator) are recorded on every derived row via `run_id` → `processing_run`.
- The pipeline **never reads ground truth** (`data/synthetic_ground_truth*`). Only `validate.py` and tests
  may. A test greps `cie/` to enforce this.
- Trace text is untrusted. Never `eval` it; render it with `textContent` only.
- Never commit data, the Verizon sample or the baseline documents. Commit messages are imperative and scoped.

Layout:
```
cie/ config.py lexicon.py db.py synth.py locate_sample.py ingest.py evaluations.py taxonomy.py
     signals.py episodes.py features.py cluster.py patterns.py scoring.py cards.py facts.py
     retrieval.py server.py validate.py run_pipeline.py adapters/(llm.py, embed.py: disabled stubs)
ui/  index.html app.js style.css
tests/ test_*.py   gold/real_gold.jsonl (needs human review)   taxonomy/taxonomy_v0.yaml
landing/ (git-ignored) <source>/<day>/*.jsonl.gz + index      reports/ validation.{json,md}
```

---

## 5. Canonical data model

The logical names follow the design baseline; `db.py` is the physical source of truth. Every table has
`run_id`, and rows from generated data have `is_synthetic` / `provenance_id`.

| Group | Table | Grain / key columns |
|---|---|---|
| Raw | `raw_trace_session` | one row per source session: `session_id, source, file, byte_offset, byte_len, sha256, landed_at` (payload stays in the gzipped landing file) |
| Conversation | `conversation_session` | `session_id` PK; `external_id, source, created_at, day, week, previous_session_id, thread_id, thread_pos, customer_key?, lang, n_turns, auth_state, city, state, region, market, zip3, geo_source, location_type, outcome, outcome_basis, is_synthetic, provenance_id` |
| | `conversation_turn` | (`session_id, turn_no`): `trace_id, ts, kind (utterance/event), event_type, event_value, user_text, agent_text, agent_role, roles` |
| Execution | `conversation_trace` | `trace_id` PK, `session_id, turn_no, created_at, status_code, is_complete` |
| | `trace_span` | `span_id, trace_id, parent_id, type, name, step_number` (llm span bodies are not stored) |
| | `tool_call` | `trace_id, session_id, turn_no, tool, intent_name, query, requested_operator, failed` |
| Evaluation | `agent_evaluation` | `entity_type (session/trace), entity_id, metric, value, scale, status, evaluator/model_alias, rationale, scorer_version`. Token/cost fields are excluded. `cm_policy_metric` is exploded into `policy_verdict(session_id, policy_id, verdict, severity, policy_type)` |
| Taxonomy | `dim_intent` | `intent_id` (stable), `level`, `parent_id`, `code`, `name`, `taxonomy_version`, `status` |
| | `intent_definition` | `intent_id, definition, include_criteria, exclude_criteria, examples, platform_intent_patterns, keyword_rules` |
| Classification | `session_intent` | `session_id, intent_id, role (primary/secondary), confidence, method, taxonomy_version` |
| | `turn_intent` | `session_id, turn_no, intent_id, confidence, method` |
| Signals | `session_signal` | `signal_id, session_id, turn_no, trace_id, family, category, type, value, text, confidence, method, rule_version, ts, is_synthetic` |
| Episodes | `session_episode` | `episode_id, session_id, ep_no, kind (auth/goal), start_turn, end_turn, intent_id, domain_agent, text, outcome, friction` |
| Geography | `dim_geography` | `city, state, region, market, lat, lon` |
| Features | `session_feature` | `session_id` plus behavioural/temporal features (friction, n_escalation_requests, auth_failures, repeat_contact_7d, days_since_prev, opp/value/risk flags, segment, style) |
| Clustering | `cluster_master` | `cluster_id` (governed, stable), `family`, `version`, `label`, `status`, `stability`, `centroid` |
| | `session_cluster_membership` | `session_id` (or `episode_id`), `cluster_id, family, distance, run_id` |
| Patterns | `pattern_master` | `pattern_id, pattern_key, kind, family, cluster_id, dim_type, dim_value, period, support, denominator, rate, baseline, lift, ci_lo, ci_hi, qval, version` |
| Scoring | `pattern_score` | `pattern_id, dimension, value, method, scoring_version` (+ a `composite_provisional` row) |
| Evidence | `evidence_card`, `evidence_ref` | card fields (§7, WP10); `evidence_ref(card_id, session_id, turn_no, trace_id, quote)` |
| Persistent context | `fact` | `scope_type, scope_id, attribute, value, valid_from, valid_to, recorded_at, superseded_by, source_session, source_turn` |
| Governance | `processing_run`, `data_provenance`, `review_log`, `decision_log` | run, stage, versions, watermark; synthetic batch/scenario/template/generator version/seed; who approved what and when |
| Aggregates | `agg_daily_cluster`, `agg_daily_signal` | daily counts that feed patterns over rolling windows (7/28/84 days) |
| Search | `episode_fts`, `card_fts` | external-content FTS5 |

Rules: every trace links to a valid session; unknown or ambiguous values are explicit (`UNKNOWN`), not
null-by-accident; raw metric names and values are retained next to canonical mappings.

---

## 6. Work packages

Each WP lists what it does and its Definition of Done (DoD). Gates (G*) are defined in §8.

### WP0 Synthetic generator (`synth.py`, draft exists)
- **Scenario catalogue** in `tests/taxonomy/scenarios.yaml`: scenario family, ground-truth L1–L3 intent,
  preconditions, workflow, tool events, outcome rules, signal propensities, persona and geography effects.
  It covers every family in the design baseline §10.3, including tool failures/retries, silence, repetition,
  multi-intent and intent change.
- **Calibrate** to the real profile (§2.3) through `--profile real_calibrated`, the default.
  `opportunity_rich` is for UI demos only and is never validated.
- Every session carries `user_metadata.location`, `previous_session_id` chains,
  provenance (`batch, scenario_id, template_id, generator_version, seed`) and a `split` value (`discovery` 80%
  / `test` 20%, by thread).
- Evaluations (judge scores, `cm_policy_metric` journey and verdicts) are **derived from ground truth via a
  documented rubric**.
- Two phrasing banks: A for development and B as held-out paraphrases. Spanish turns appear at the real-sample rate.
- Spans are schema-faithful but slim: `workflow` → `tool` spans with real names and payload keys; no LLM
  prompt bodies.
- Plant known effects: city×intent lifts, two time-boxed emerging events, four A→B sequences, and personas.
  Truth goes only to `data/synthetic_ground_truth.json.gz`.
- Fix the draft's bugs:
  - the ad hoc sequence-probability formula;
  - an expression used as a statement (`agent_msgs.insert(...) if ... else None`);
  - wrong second-episode turn arithmetic;
  - an implicit `role` carried into assembly.
- Also: `locate_sample.py` writes a git-ignored copy of the real sample with a seeded assumed location
  (`geo_source='assumed_sample'`). Delete it once real locations arrive.

**DoD:** G0 passes; 100K sessions generate in < 5 min on 4 cores; 100% of records carry provenance.

### WP1 Raw landing and ingestion (`ingest.py`)
- Landing: copy each input to `landing/<source>/<day>/` (gzip), record a sha256, and index each session's
  byte offset in `raw_trace_session`. Landing files are immutable.
- Parse into the canonical tables:
  - turn ordering and event typing;
  - markup stripping;
  - a second PII scrub (email, phone, card, SSN), with hits counted;
  - tool calls with `intent_name`, `query`, `user_intent`, `topic`, `requested_operator`;
  - language tagging;
  - structured location via `LOCATION_PATHS` → `dim_geography`; unknown cities get `region='Unmapped'`;
  - thread resolution via union-find, including parents that arrive on later days.
- Rejects are written with line number and reason. Upsert by `session_id`. A `processed_day` watermark
  makes reruns idempotent.

**DoD:** G1. On the real sample: 36 sessions and 241 traces; the turns of session `d9b52d90…` come out in
order. 100K sessions ingest in < 6 min.

### WP2 Evaluation mapping (`evaluations.py`)
Explode session and trace metrics into `agent_evaluation`. Keep raw names. Map them to a small canonical
set: quality, task success, efficiency, flow, context recall, tamper protection, and policy compliance.
Each mapping documents its scale. Explode `cm_policy_metric` verdicts into `policy_verdict`.

**DoD:** a mapping table is documented in code; `not_applicable` and error statuses are never coerced to 0.

### WP3 Signals (`signals.py`, lexicons in `lexicon.py`)
Families and types:

| Family (design baseline §7.1) | Types |
|---|---|
| Customer need | billing_clarification, payment_issue, account_access, service_request, coverage_availability |
| Buying intent | upgrade_device, add_line, plan_question, hotspot_home_internet, travel_intl |
| Value signal | willingness, price_sensitivity, feature_comparison, device_replacement, multi_line_expansion |
| Retention risk | churn_intent, complaint, dispute, payment_difficulty, repeat_contact_language |
| Journey friction | escalation_request, agent_handoff (tool), auth_failure, no_input, dtmf_operator, agent_loop, customer_repeat, tool_failure, abandoned, out_of_scope |
| Experience | frustration, confusion, positive_response |
| Geographic | city_mention (typed: destination / current / residence / unknown), location_mismatch, location_unresolved, local_event, coverage_local |
| Temporal | repeat_contact, repeat_same_issue, days_since_prev |

Each signal carries a confidence, a method (`lexicon` / `platform_intent` / `tool` / `event` / `metadata` / `derived` / `llm`),
a rule version, and evidence turn and trace IDs.

**DoD:** G2.

### WP4 Intent taxonomy and classification (`taxonomy.py`)
1. **Seed (v0):** the L1 domains and L2 candidates from design baseline §6.2, stored in
   `tests/taxonomy/taxonomy_v0.yaml` with draft definitions.
2. **Discover:**
   - Profile the platform `intent_name` values and agent paraphrases.
   - Run HDBSCAN on episode vectors from the discovery split, using LSA by default or the embedding adapter if one is approved.
   - Propose L3/L4 candidates, including any clusters not covered by v0.
   - Output a review pack with representative quotes per candidate.
3. **SME review in the UI** (Taxonomy page): approve, rename, merge or split; edit definitions and criteria.
   Each action writes `review_log` and produces a new `taxonomy_version`.
4. **Classify** sessions, turns and episodes against the approved version. Rules (platform-intent patterns +
   keyword rules from `intent_definition`) come first, then nearest-centroid backoff, with a calibrated confidence.
   Below `MIN_INTENT_CONF` → `UNKNOWN`. Output one primary intent and the secondaries.
5. **Gap loop:** report the low-confidence and `UNKNOWN` share by candidate theme.

**DoD:** G3. Taxonomy v1 is published with definitions for every L3; the review log is complete.

### WP5 Episodes and features (`episodes.py`, `features.py`)
- Episode = a distinct need within a session (O2, configurable). A boundary is a change of domain agent,
  a new `intent_name`, or a turn-level intent change held for 2 turns. The leading auth/bootstrap span is
  `kind='auth'`.
- Outcome: escalated (transfer tool), abandoned (disconnect or ≥2 no-inputs without handoff), or
  resolved-proxy. Record `outcome_basis`; never use `status_code`.
- Session features (§5), behavioural segment (rule-scored in config) and style (`self-serve` / `agent-seeking`).

**DoD:** goal-episode count matches the planted intents on ≥ 85% of synthetic sessions.

### WP6 Cluster families (`cluster.py`)
- Four overlapping families, each clustered on its own feature view:
  - **Need/upsell:** goal-episode text + need/buying signals.
  - **Risk/retention:** friction, risk and temporal features + text.
  - **Value:** value-signal profile + text.
  - **Geographic:** cluster × geography demand profiles (city vectors of intent shares).
- Method:
  1. TF-IDF + token features (`__pi_`, `__sig_`, `__tool_`, `__role_`), then TruncatedSVD and L2 normalisation.
  2. HDBSCAN for exploration, MiniBatchKMeans for stable assignment.
  3. Choose k by silhouette.
- Stability: bootstrap, Hungarian matching and Jaccard. Publish only if stability ≥ `MIN_STABILITY`.
- Governed IDs: a new run matches previous centroids (cos ≥ .8) and inherits their IDs. Labels need SME review
  (`cluster_master.status`).
- Daily mode assigns to published centroids only. An episode with low similarity to every centroid goes to
  `novel`; a refit alert fires when the novel share stays high.

**DoD:** G4.

### WP7 Patterns (`patterns.py`)
- Compute from `agg_daily_*` over rolling windows.
- Pattern kinds:
  - intent or cluster × city / region / market;
  - × segment;
  - risk rates (escalation, abandonment, repeat contact, auth failure);
  - emerging (last 2 weeks vs prior 6);
  - sequences across threads (A → B within 7 days);
  - recurrence (repeat same issue).
- Statistics: Beta-binomial shrinkage, Wilson CI, two-proportion z-test, Benjamini–Hochberg across all cells.
- Keep a pattern only if support ≥ `K_ANON` sessions, |shrunk lift| clears `MIN_LIFT`, and q ≤ `FDR_Q`.
- Every pattern records its denominator, period and coverage.

**DoD:** G5.

### WP8 Scoring (`scoring.py`)
Store six dimensions in [0, 1], each with a documented formula and version:
- **prevalence:** support share;
- **recurrence:** repeat across sessions/threads;
- **trend:** slope or emerging z;
- **evidence strength:** q-value, CI width, extraction confidence, quote count;
- **business relevance:** a configured family weight;
- **geographic concentration:** a Gini/HHI-style concentration measure.

`composite_provisional` uses config weights, is labelled *provisional* everywhere, and is recomputable from
stored dimensions.

**DoD:** recalculation test passes (same inputs + version → same scores).

### WP9 Retrieval (`retrieval.py`)
- Sparse: FTS5 BM25 over episodes and cards.
- Dense: LSA vectors reused from WP6, stored as float16 `.npy`, searched with cosine. The embedding
  adapter replaces this if one is approved.
- Hybrid: RRF (k=60).
- Filters: intent (any level), family, cluster, city, region, segment, outcome, week range, source,
  is_synthetic, split.
- As-of: return only data with `created_at ≤ asof`, and attach `facts_as_of(thread)` to each hit.
- `ask(q)`:
  1. parse filters (gazetteer, taxonomy names, family words);
  2. rank cards, then episodes;
  3. return a templated answer that cites card, session and turn IDs.
  No LLM unless the adapter is enabled.

**DoD:** G7.

### WP10 Evidence cards and persistent facts (`cards.py`, `facts.py`)
- **Card fields** (design baseline §9):
  - title, category, observation;
  - population (support / denominator);
  - period vs comparison period;
  - segment/geography, only from structured or reliable attributes;
  - trend with its method;
  - 3–5 evidence quotes (`evidence_ref`, sanitised; diverse sessions);
  - confidence;
  - score dimensions + provisional composite;
  - business hypothesis;
  - caveats (auto: synthetic origin, coverage, proxies, sample size);
  - governance (run, taxonomy / model / rules / scoring versions, review status);
  - `pattern_key` and version.
- **Reruns:** a rerun creates a new version, closes the old one (`valid_to`, `superseded_by`) and carries
  its review status forward.
- **Quote sanitiser:** before display, mask dollar amounts, runs of ≥3 digits, and places below city.
- **Facts:** per thread — `open_issue` (superseded by `issue_resolved`), `stated_interest`,
  `price_sensitive`, `last_outcome`, `primary_intent`. Per card: its versions.

**DoD:** G6.

### WP11 API and UI (`server.py`, `ui/`)
API (JSON). List endpoints take `limit`, `offset` and the common filters.

| Route | Returns |
|---|---|
| `GET /api/overview` | volumes, funnel per stage, family mix, KPI proxies, coverage, provenance split |
| `GET /api/taxonomy` | the taxonomy tree |
| `POST /api/taxonomy/review` | records an SME action |
| `GET /api/intents/{id}` | definition, volumes, examples, confusion |
| `GET /api/cards` | card list |
| `GET /api/cards/{id}` | card detail |
| `POST /api/cards/{id}/review` | records a review decision |
| `GET /api/clusters?family=` | cluster list |
| `GET /api/clusters/{id}` | cluster detail |
| `POST /api/clusters/{id}/review` | records a review decision |
| `GET /api/patterns?kind=` | pattern list |
| `GET /api/geo` | per-city view |
| `GET /api/sessions` | session list |
| `GET /api/sessions/{id}` | transcript, signals, episodes, tools, evaluations, policy verdicts, thread, facts as-of |
| `GET /api/search?q=&method=&asof=` | search results |
| `GET /api/ask?q=` | templated answer with citations |
| `GET /api/validation` | validation report |
| `GET /api/runs` | pipeline run history |

UI pages, all hash-routed, in light and dark themes, working at 1280 px and 390 px:
1. **Overview.** Volumes and coverage.
2. **Insight Backlog.** Evidence cards with a review drawer.
3. **Taxonomy.** Tree, definitions and SME review.
4. **Clusters.** By family, with label review.
5. **Geography.** US dot map and city table.
6. **Journeys & Trends.** Emerging patterns, sequences, repeat contact.
7. **Session Explorer.** Transcript with highlighted signals, episode bands, tool chips, evaluation panel and as-of facts timeline.
8. **Ask / Search.**
9. **Validation.**
10. **Pipeline & Governance.** Runs, versions, thresholds, decision log.

On every page:
- Synthetic data carries a visible badge.
- KPI proxies are labelled "proxy" and show no dollar figures.
- Each number has a tooltip with its definition.

**DoD:** G8.

### WP12 Validation, orchestration, docs (`validate.py`, `run_pipeline.py`, `README.md`)
- `run_pipeline` modes: full, `--daily --inbox`, `--refit`, `--from-stage`, `--only`.
- Each run records itself in `processing_run`, logs exceptions, and is resumable.
- Retention (`RAW_RETENTION_DAYS`) applies to normalised raw turns; landing files are kept per policy.
- `validate.py` writes `reports/validation.{json,md}` covering every gate. It states plainly that synthetic
  results show pipeline capability, not real-world accuracy.
- The README contains the runbook, the data dictionary (generated from `db.py`) and the architecture diagram.

---

## 7. KPI proxies (labelled "proxy" everywhere)

| Proxy | Definition |
|---|---|
| Qualified opportunity volume | sessions with a buying-intent or value signal and no churn intent |
| Conversion proxy | share of those sessions with `willingness` |
| Unmet-need share | buying/need episodes that ended escalated or abandoned |
| Repeat-contact rate | sessions followed by another session in the same thread within 7 days |
| Escalation rate | sessions with an executed handoff |
| Save-rate proxy | churn-intent sessions with no handoff and no repeat within 7 days |
| Opportunity density | qualified opportunities per 100 sessions |
| Opportunity index | density × conversion proxy, indexed so the global value = 100 |

No revenue, margin, churn or save **outcomes** are claimed (design baseline §15).

---

## 8. Acceptance gates (`validate.py` computes all of them)

| Gate | Check | Threshold |
|---|---|---|
| G0 Calibration | synthetic vs real: mean turns, event share, transfer share, agent-request share, null-output share, auth-failure share, platform-intent family mix | proportions inside the real 95% Wilson CI; mean turns inside the bootstrap CI; intent-mix total variation distance ≤ .15 |
| G1 Data integrity | 100,000 distinct synthetic sessions; 100% of traces link to a session; schema conformity 100%; provenance on 100% of synthetic rows; 0 duplicate keys; post-scrub PII hits = 0; real-sample turn order correct; landing sha256 verified | exact |
| G2 Signals | per-type precision and recall vs planted truth, bank A vs bank B; gold-set precision on real data (after human review) | A: precision ≥ .90, recall ≥ .85. B: report the gap. Gold: precision ≥ .80 for escalation_request, dispute, auth_failure, price_sensitivity |
| G3 Intent classification | macro-F1 on the held-out `test` split (L2 and L3) against scenario ground truth; on the reviewed real gold set; `UNKNOWN` rate | macro-F1 ≥ .85 (L2) on synthetic test; real gold reported with its n; `UNKNOWN` ≤ 10% |
| G4 Clusters | ARI/NMI vs ground-truth intent (need family); bootstrap stability; silhouette; SME label review recorded | ARI ≥ .50; ≥ 80% of clusters with stability ≥ .60 |
| G5 Patterns | recovery of planted city×intent effects; empirical FDR on null cells; time-boxed events flagged inside their window; sequence recovery | ≥ 9/11 effects; FDR ≤ .10; both events; ≥ 3/4 sequences |
| G6 Cards and facts | every card has evidence refs, denominator, period, caveats, versions; k-anonymity holds; 0 sanitiser violations; point-in-time reconstruction test passes | 0 violations |
| G7 Retrieval | 60 ground-truth queries (intent × city): P@10, MRR, nDCG@10 for bm25 / dense / hybrid; filter correctness; as-of correctness | hybrid MRR ≥ max(bm25, dense) − .02; filters and as-of 100% |
| G8 UI/API and performance | every route smoke-tested; API p95 < 500 ms on 100K; full pipeline on 100K ≤ 30 min on 4 cores; the overnight daily run is idempotent | as stated |
| G9 Scale (only if O1 = per day) | 7 consecutive daily batches of 100K in incremental mode | each day ≤ 30 min; DB growth within retention plan |

---

## 9. Governance rules (must always hold)

- Nothing is published below `K_ANON` = 30 sessions: no pattern, card, geo cell or quote.
- Only `approved` cards, clusters and taxonomy versions count as published. Every review writes `review_log`.
- Synthetic, sample and mixed provenance is visible on every card and chart.
- Geography always states its `geo_source` and `location_type`. A mentioned place is never inferred to be the
  customer's residence.
- Everything is versioned: taxonomy, rules/lexicon, models, scoring, generator.

---

## 10. Four-week plan (today 2026-11-18, delivery 2026-12-18)

| Week | Build | Exit gate (customer review) |
|---|---|---|
| **W1** (Nov 18–25) Discovery and design + vertical slice | Profiling report on the real sample; db.py schema + ERD + source-to-target mapping; taxonomy v0; signal catalogue; episode definition proposal (O2); scenario catalogue + generator spec. **Vertical slice:** WP1 → WP3 → WP5 on the real 36 sessions; Session Explorer; real gold set drafted | Schema, taxonomy v0, episode definition, scenario catalogue approved; open questions O1–O8 answered or defaults accepted |
| **W2** (Nov 26–Dec 2) Data + intelligence foundation | WP0 complete (100K, G0); WP1/WP2 at scale (G1); WP3 (G2); WP4 discovery + review pack; WP5 features | 100K count, linkage, provenance, scenario coverage, taxonomy v1 approved |
| **W3** (Dec 3–9) Clusters, patterns, scoring | WP4 classification (G3); WP6 (G4); WP7 (G5); WP8; Taxonomy/Clusters/Geo/Journeys UI pages | Cluster families, pattern definitions, score dimensions and evidence examples reviewed |
| **W4** (Dec 10–16, buffer to Dec 18) Cards, retrieval, batch, handover | WP10 (G6); WP9 (G7); WP11 complete (G8); WP12 overnight mode, validation report, runbook; G9 if O1 = per day; demo | End-to-end demo; card review; Phase 1 acceptance |

Parallel lanes for agents:
- **Data:** WP0, WP1, WP2, WP12 orchestration.
- **Intelligence:** WP3, WP4, WP5, WP6, WP7, WP8.
- **Product:** WP9, WP10, WP11 (the UI can start in W1 against stub JSON).
- **QA:** gold set, tests and `validate.py` from W1.

---

## 11. Synthetic data controls

- Fictional identifiers only. No real phone numbers, cards, addresses or credentials.
- Every record is labelled with `is_synthetic` and its provenance (batch, scenario, template, generator version, seed).
- Tool outcomes and final outcomes are consistent with the dialogue. Evaluations come from the rubric, not at random.
- Discovery and test splits are separated by thread. Taxonomy discovery and threshold tuning use **discovery only**.
- Distributions are documented in `reports/synthetic_profile.md` and never presented as population statistics.

---

## 12. Definition of done (every PR)

- Tests pass (`pytest -q`); the relevant gate(s) are computed by `validate.py`.
- No thresholds hard-coded outside `config.py`; versions are bumped when rules or scoring change.
- Docs updated: this file (if the contract changed), the README runbook, the data dictionary.
- No data, sample or baseline documents committed.

---

## 13. Decision log

| Date | Decision | Source |
|---|---|---|
| 2026-11-18 | Session = complete conversation; no taxonomy; 100K synthetic complete conversations | Design baseline (customer clarifications) |
| 2026-11-18 | Sample is representative; `previous_session_id` is available; structured location will be supplied; city-level aggregates and redacted quotes OK under CPNI; no `head_intent` list | User |
| 2026-11-18 | SQLite as POC store with portable SQL; raw landing as gzipped files + offset index | User request; payload size measurement |
| 2026-11-18 | Separate score dimensions; composite is provisional until approved | Design baseline |
| 2026-11-18 | Default episode = need within session; default volume reading = 100K total (O1, O2 still open) | This plan |
