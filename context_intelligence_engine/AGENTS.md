# Context Intelligence Engine (Phase 1) — Instructions for Development Agents

Read this whole file before writing code. It is the source of truth for scope, contracts,
work packages and acceptance gates. If something here conflicts with code, this file wins;
if you must deviate, update this file in the same commit and say why.

---

## 1. Goal

Turn VzGPT voice-agent traces into **governed, reviewable evidence cards** about recurring
customer needs, journey friction, buying signals and temporal patterns, by behavioural segment
and geography.

```
Traces → signals → episodes → clusters → patterns → score → evidence cards
                                                         ↘ persistent facts (dated)
                         retrieval (BM25 + dense + filters + as-of)  →  UI
```

**In scope:** traces only, 100K sessions (synthetic + the real sample), a batch pipeline,
SQLite, a local web UI, retrieval, and a validation report.

**Out of scope (Phase 1):** Customer 360, Network 360, any PII/CPNI, authoritative
eligibility, price, inventory or consent, and revenue in dollars (show an *opportunity index*
instead and label it as such).

---

## 2. Facts about the input you must design for

Source: `sample/verizon_traces_example.jsonl` (36 sessions, 241 traces). It is git-ignored;
ask the user for it if it is missing. Never commit it.

| Fact | Consequence |
|---|---|
| Each line is a `session` with `traces[]`; each trace has `spans[]` → `workflow` span → nested `llm` / `tool` spans | Walk spans recursively; never assume depth |
| Trace order in the file is arbitrary; turn number comes from `name` = `"turn N workflow"` and does **not** start at 1 | Sort by parsed N, fall back to `created_at` |
| `input`/`output` are JSON **strings** of `[{role, content}]`; `output` can be `null` (≈5%) | Defensive parsing; a null output is not an error |
| `output[].role` is the **agent/skill name** (`bill_explain_with_mcp`, `plan_add_change`, `unauth_bill_explain`, `Root_agent` vs `root_agent`) | Lower-case roles; role changes help mark episode boundaries |
| Customer `content` can be a system event: `<event>session start</event>`, `<event>sys.remote-call-disconnected</event>`, `<context>user pressed 0 on keypad.</context>`, `<context>no user activity detected for 9 seconds.</context>`, `<context>function [...] completed ...</context>` | Store as `kind='event'` with `event_type`; these are friction signals, not utterances |
| Tool `mandatory_set_intent_for_next_step` input has `intent_name` (`head_intent.charge_dispute`, `head_intent.bill_reduce`, …) and `requested_operator` | The **strongest intent signal**: extract it first-class |
| Tools `retrieve_intent_matches.user_intent`, `explain_bill_init_mcp.query`, `handle_out_of_scope.topic` hold an agent paraphrase of the issue | Clean, short intent text: use it as clustering text |
| Tools whose name contains `transfer` (`updated_billing_transfer_call`, `pac_transfer_call`, …) | Escalation actually executed |
| `invalid_auth`, `action_validate_account_pin` failures, `enhanced_secure_pin` loops | Authentication-friction signals |
| Agent text has lower-case markup: `[prosody rate="64%"][warm][short pause]` | Strip it; keep UPPER-case redaction placeholders (`[LOCATION]`, `[CUSTOM_NUMBER_SEQUENCE]`, `[PERSON_NAME]`, `[URL]`, `[GENERIC_ID]`) |
| `input == redacted_input` everywhere in the sample, yet a place name leaked ("Lake Mary Florida") and dollar amounts appear verbatim | Read **only** `redacted_*`; run our own PII scrub too; sanitise quotes again before they reach a card |
| Session `metrics` hold LLM-judge scores (`conversation_quality`, `agentic_session_success`, `agent_efficiency`, `agent_flow`; values may be `[x]`, float or string) and `cm_policy_metric` (JSON string with `journey`, `overall_compliance_rate`) | Parse scalars robustly; any of them may be missing |
| `previous_session_id` is **null in all 36 sessions** | Repeat-contact and sequence features depend on it. Build them, but degrade gracefully and report coverage (see Open Questions) |
| Real mix is billing/IVR/auth-heavy: 86% of sessions transfer, 31% explicitly ask for an agent, almost no upsell language, locations mostly masked | Real-data insights will be mostly *risk/friction*. Need/value/geo insights rely on volume; never inflate them |

---

## 3. Plan review: changes from the first draft (already decided)

1. **Vertical slice first.** Milestone 1 runs the real 36 sessions end-to-end (ingest → signals →
   episodes → API → Session Explorer) before any 100K work.
2. **Calibrate synthetic data to the real sample.** The draft generator gives 7.7 turns/session
   (real 6.7), 46% transfers (real 86%), 18% agent requests (real 31%). Add a `--profile`
   switch: `real_calibrated` (default; matches the real observable marginals within tolerance)
   and `opportunity_rich` (more upsell variety, for demos). The 36-session sample is small and
   probably biased toward transferred calls, so tolerances are loose (§9 gate G0).
3. **Cluster goal episodes only.** Authentication/IVR episodes would dominate the clusters, so they
   are excluded from clustering and reported as risk patterns instead. Cluster features =
   platform `intent_name` + agent paraphrase text + cleaned customer text + behavioural tokens.
4. **Re-sanitise evidence quotes.** Before a quote reaches a card, mask dollar amounts, digit
   runs ≥3 and any place below city level. Only quote sessions from cells that meet k-anonymity.
5. **Use an external-content FTS5 table** (`content='episodes'`, `content_rowid='episode_id'`)
   so `snippet()`/`highlight()` work. The draft used contentless tables, which can't do that.
6. **Real-sample gold set.** Hand-label the 36 real sessions (`tests/gold/real_gold.jsonl`:
   platform intent, escalated?, auth-failed?, signal types per turn). This is the only check of
   extractor accuracy on real language. An agent drafts the labels; a human must review them,
   and the file is flagged `reviewed: false` until they do.
7. **Geography must be Phase-2 ready.** Add `geo_source` (`text_gazetteer` now; `account`/`market`
   later) and always report geo coverage. Rates for sparse cells are shrunk.
8. **LLM is optional and off by default.** Define a `SignalExtractor` / `Labeller` interface with the
   rule-based implementation as default, so an LLM can replace it in Phase 2 without schema
   change. No network calls in the default pipeline.
9. **Review decisions survive reruns.** Card identity = a stable `pattern_key` (kind|cluster stable
   id|dim_type|dim_value). A rerun creates a new card version, supersedes the old one
   (`valid_to`, `superseded_by`) and carries its review status forward.

---

## 4. Repository layout and conventions

```
context_intelligence_engine/
  AGENTS.md            ← this file
  README.md            ← runbook for humans (WP11)
  requirements.txt     numpy, scikit-learn, scipy, pytest (no other runtime deps)
  cie/
    config.py lexicon.py db.py        (exist, drafted)
    synth.py                          (exists, has known bugs: §6 WP0)
    ingest.py signals.py episodes.py cluster.py patterns.py cards.py facts.py
    retrieval.py server.py validate.py run_pipeline.py
  ui/ index.html app.js style.css     vanilla JS, no CDN, no build step
  tests/ test_*.py  gold/real_gold.jsonl
  data/   (git-ignored: cie.sqlite, synthetic_*.gz, models)
  reports/ validation.json, validation.md (committed)
  sample/ (git-ignored: Verizon file)
```

Rules:
- Python 3.11+, stdlib + numpy/scikit-learn/scipy only. Server: `http.server.ThreadingHTTPServer`.
- Every stage is a function `run(con, run_id, **cfg) -> dict(stats)` and is **idempotent**: it
  deletes and recomputes its own outputs for the run.
- All thresholds live in `config.py`. No magic numbers in stage code.
- Deterministic: every random call takes a seed from config.
- The pipeline **must never read** `data/synthetic_ground_truth.json.gz`. Only `validate.py` and
  tests may read it. Enforce this with a test that greps `cie/` for the filename.
- Text read from traces is untrusted data. Never `eval` it and never render it as HTML in the UI
  (use `textContent`).
- Commit messages: imperative, scoped (`ingest: …`). Never commit data files or the Verizon sample.

---

## 5. Data contract (SQLite)

`cie/db.py` is the schema source of truth. Required changes:
- `sessions`: add `geo_source TEXT`.
- `episodes_fts`: external content on `episodes(text)`; `cards_fts` external content on `evidence_cards`.
- `evidence_cards`: add `pattern_key TEXT` plus an index on it.
- `clusters`: add `stable_id INTEGER` (persists across runs).

Volumes at 100K: ~700K `turns`, ~150–250K `episodes`, ~1–3M `signals`, DB < 1.5 GB.
Load in batches of 5,000 sessions in one transaction with `PRAGMA synchronous=OFF` during bulk load.

Signal taxonomy (`signals.family/type`). Do not add types without updating `lexicon.py` and this table.

| family | types |
|---|---|
| need | upgrade_device, add_line, plan_question, hotspot_home_internet, travel_intl, coverage_availability, service_request |
| value | willingness, price_sensitivity, feature_comparison, device_replacement, multi_line_expansion |
| risk | escalation_request, agent_handoff (tool), churn_intent, complaint, repeat_contact_language, repeat_contact (metadata), repeat_same_issue (thread), dispute, payment_difficulty, auth_failure, no_input, dtmf_operator, agent_loop, customer_repeat, abandoned, out_of_scope |
| geo | city_mention (value = canonical city), location_unresolved (`[LOCATION]`), local_event, coverage_local |

Every signal row carries `source ∈ {lexicon, platform_intent, tool, event, metadata, derived}` and `conf`.

---

## 6. Work packages

Each WP lists inputs → outputs, the definition of done (DoD), and dependencies. A WP is done only when
its tests pass and its stats appear in `pipeline_runs`.

### WP0 Fix and calibrate the synthetic generator (`synth.py`). No dependencies.
Known bugs to fix:
- Follow-up sequence probability (`SEQUENCES[...] / max(p_follow,.01) * .5`) is ad hoc. Replace it
  with: if the prior is unresolved and its intent is in `SEQUENCES`, force the mapped follow-up with
  the stated probability; otherwise, with p=.68, force the same intent.
- `agent_msgs.insert(...) if ... else None` is an expression used as a statement. Rewrite it.
- Second-episode detail count uses the wrong arithmetic. Make turns/session target a calibrated mean.
- `role` from the last plan item is reused in assembly. Pass it explicitly.
Add `--profile real_calibrated|opportunity_rich`. DoD: gate G0 passes; 100K sessions generate
in < 3 min on 4 cores; ground truth includes the planted effects list and per-session planted signals.

### WP1 Ingestion (`ingest.py`). Depends on: none.
Inputs: `.jsonl` or `.jsonl.gz`, `--source verizon_sample|synthetic`. Streaming parser that:
- reads only `redacted_*`;
- parses turns, events, tool calls (with `intent_name`, `query`/`user_intent`/`topic`, `requested_operator`);
- strips markup;
- runs the PII scrub and counts hits;
- writes rejects with line number and reason;
- upserts by `session_id`;
- resolves `thread_id` from `previous_session_id` chains (union-find) and sets `thread_pos`;
- derives `day`, ISO `week`, `journey`, `auth_state` and the judge metrics.
DoD: the real sample loads with 36 sessions and 241 turns, 0 rejects, and correct turn order (unit test
on session `d9b52d90…`, whose turns 10–22 arrive shuffled). 100K load in < 4 min. Re-running doesn't
duplicate anything.

### WP2 Signals (`signals.py`). Depends on: WP1.
Lexicon signals on customer utterances; platform-intent mapping; tool, event and metadata signals;
derived signals:
- `agent_loop`: agent text token-Jaccard ≥ .8 with an earlier agent turn;
- `customer_repeat`: same test on customer turns, ≥ .7;
- `abandoned`: the last event is a disconnect or ≥2 no-inputs with no transfer;
- `repeat_same_issue`: same platform intent as the previous session in the thread.
City attribution = the most frequent `city_mention` (ties → earliest); `geo_conf` = share.
DoD: gold-set and synthetic metrics reported (G2); ~2 min on 100K.

### WP3 Episodes and segments (`episodes.py`). Depends on: WP2.
Boundaries: a change of non-generic domain agent role, or a new `intent_name`. The leading
auth/bootstrap span is `kind='auth'`; the rest are `kind='goal'`.
Per episode: text (agent paraphrase + platform intent + cleaned customer text), outcome
(escalated if a transfer tool fires or the agent says it will connect; abandoned; else resolved),
friction (weighted, documented in code), signal types, and family mask.
Session rollups: `outcome`, `escalated`, `repeat_flag`, `followup_7d`, `need/value/risk/opp_flag`.
Behavioural `segment` is scored from signal weights in `config.py`, with fixed precedence on ties:
Churn-risk, Deal-seeker, Household expander, Upgrade intender, Traveler, Connectivity-dependent,
Billing-focused, Access-blocked, General. `style` is `self-serve` or `agent-seeking`.
DoD: G3.

### WP4 Clustering (`cluster.py`). Depends on: WP3.
Goal episodes only. Features: TF-IDF (1–2 grams, min_df 5, sublinear) concatenated with token
features `__pi_<intent>`, `__sig_<type>`, `__tool_<name>`, `__role_<agent>`, then TruncatedSVD
(`SVD_DIM`) and L2 normalisation, then MiniBatchKMeans. Choose k from `K_CANDIDATES` by silhouette on
a 20K sample.
Stability: run `N_BOOT` bootstrap fits, match clusters to the reference by Hungarian on centroid
cosine, and set stability = mean Jaccard of matched member sets. Publish a cluster only if
stability ≥ `MIN_STABILITY`.
Stable IDs: match to the previous run's centroids (cosine ≥ .8) and inherit `stable_id`.
Label = top c-TF-IDF terms + dominant platform intent + dominant signal; `family` = most enriched
signal family.
Persist the vectorizer and SVD to `data/` for retrieval.
DoD: G4.

### WP5 Patterns and scoring (`patterns.py`). Depends on: WP4.
Pattern kinds:
- `geo_mix`: cluster × city or region; denominator = goal episodes with a known city.
- `segment_mix`: cluster × segment.
- `risk_rate`: escalation, abandonment, repeat-contact and auth-failure rate by cluster, city and segment.
- `emerging`: weekly share; last 2 weeks vs the prior 6, by cluster and by cluster × region.
- `sequence`: P(next session in the thread is cluster B | cluster A) vs P(B).
- `kpi`: global KPI proxies.
Statistics:
- Beta-binomial shrinkage toward the baseline (`SHRINK_M`).
- Wilson CI.
- Two-proportion z-test, then Benjamini–Hochberg across *all* tested cells (`FDR_Q`).
- Keep a pattern only if support ≥ `K_ANON` sessions, shrunk lift ≥ `MIN_LIFT` (or ≤ 1/`MIN_LIFT` for risk), and q ≤ `FDR_Q`.
Score (0–100) = `W_EFFECT·effect + W_SUPPORT·support + W_SIG·significance + W_TREND·trend`, each
normalised to [0,1] by a documented formula. Tier A ≥ 70, B ≥ 50, else C.
KPI proxies, each named exactly as below and labelled "proxy" in the UI:

| Proxy | Definition |
|---|---|
| qualified opportunity volume | goal episodes with a need or value signal and no churn_intent |
| conversion proxy | share of those episodes with `willingness` |
| unmet-need share | need episodes that ended escalated or abandoned |
| repeat-contact rate | sessions with `followup_7d` |
| escalation rate | sessions that escalated |
| save-rate proxy | churn-intent sessions with no escalation and no follow-up in 7 days |
| opportunity density | qualified opportunities per 100 sessions |
| opportunity index | opportunity density × conversion proxy, indexed to 100 = global |

DoD: G5.

### WP6 Evidence cards and persistent facts (`cards.py`, `facts.py`). Depends on: WP5.
Card fields:
- `title` and `headline` from templates: "{Cluster} is {lift}× more common in {city} ({rate} vs {baseline})";
- `kpi` and `hypothesis`, taken from the PDF KPI table for the family;
- `action` (a hypothesis, never a promise);
- `caveats`, auto-generated: geo coverage, sample size, synthetic origin, proxy KPIs;
- metrics JSON;
- 3–5 quotes: diverse sessions, highest-confidence signals, re-sanitised, each with `session_id` and `turn_no`;
- `data_origin` (`synthetic` / `verizon_sample` / `mixed`);
- `pattern_key`, status, and version.
Cards over the top `MAX_CARDS` patterns, with at most 3 per cluster.
Facts store:
- one row per (scope, attribute, value, valid_from, valid_to);
- per thread: `open_issue`, superseded by `issue_resolved`; `stated_interest`; `price_sensitive`; `last_outcome`;
- per card: version history.
Superseded rows keep their dates. Expose `facts_as_of(scope_id, ts)`.
DoD: G6.

### WP7 Retrieval (`retrieval.py`). Depends on: WP4 (index) and WP6 (cards).
- Sparse: FTS5 BM25 over episodes and cards.
- Dense: LSA vectors (reuse WP4's vectorizer and SVD), float16 `.npy`, brute-force cosine.
- Hybrid: RRF (k=60).
- Filters: city, region, segment, family, cluster, week range, source, outcome.
- As-of: limit to sessions with `created_at ≤ asof`, and attach `facts_as_of` for each hit's thread.
- `ask(question)`:
  1. parse filters from the text (gazetteer, family lexicon, segment names);
  2. rank cards, then episodes;
  3. return a templated answer that cites card and session IDs.
  No LLM.
DoD: G7.

### WP8 API server (`server.py`). Depends on: WP1 (works with partial data).
Serves `ui/` and JSON. Read-only connections, except review POSTs. Every list endpoint takes
`limit`/`offset` and the common filters (`city, region, segment, family, source, week_from, week_to`).

| Method & path | Returns |
|---|---|
| GET /api/overview | KPI proxies, funnel counts per stage, family mix, weekly volume, data origin, geo coverage |
| GET /api/cards?status=&family=&min_score= | card list |
| GET /api/cards/{id} | card + version history |
| POST /api/cards/{id}/review `{status, reviewer, note}` | updated card (status ∈ draft, in_review, approved, rejected) |
| GET /api/clusters, /api/clusters/{id} | list; detail with terms, signals, outcome rates, weekly series, city mix, sample quotes |
| GET /api/geo | per-city rows: lat, lon, sessions, coverage, intent mix, opportunity index, risk index |
| GET /api/patterns?kind= | pattern rows |
| GET /api/sessions/{id} | turns, signals, episodes, tools, thread, facts timeline |
| GET /api/sessions?random=1&filters | session list |
| GET /api/search?q=&method=bm25\|dense\|hybrid&asof= | ranked hits with scores and the reason they matched |
| GET /api/ask?q= | answer + cited cards/sessions |
| GET /api/validation | `reports/validation.json` |
| GET /api/runs | pipeline run history and stage timings |

DoD: p95 < 500 ms on 100K for every GET (measured in G8). Errors return JSON `{error}` with a 4xx/5xx status.

### WP9 UI (`ui/`). Depends on: the WP8 contract (can start against stub JSON).
A single-page app with hash routing. Light and dark themes via CSS tokens. Works at 1280px and 390px.
Charts are hand-made SVG. No external assets.
Pages:
1. **Overview**: KPI tiles, a pipeline funnel (sessions → episodes → clusters → patterns → cards), family mix, weekly trend, data-origin banner.
2. **Insight Backlog**: card list with filters; a detail drawer (metrics, quotes linking to sessions, caveats, version history); approve/reject/note.
3. **Geography**: US dot map (lat/lon projection, simple outline), plus a sortable city table with intent-mix bars, coverage, and opportunity and risk indexes.
4. **Clusters**: a table, then detail (terms, signals, outcome rates, weekly sparkline, top cities, quotes).
5. **Journeys and Trends**: emerging patterns, sequence A→B lifts, repeat-contact funnel.
6. **Session Explorer**: transcript with signals highlighted inline, episode boundaries, tool chips, thread timeline, and an as-of facts panel.
7. **Ask / Search**: query box, method toggle, filters, results with scores.
8. **Validation**: gates with pass/fail and metric tables.
9. **Pipeline**: runs, stage timings, governance thresholds (read-only).
Every number shown names its definition in a tooltip. Synthetic data is always visibly labelled.

### WP10 Validation and tests (`validate.py`, `tests/`). Depends on: all WPs.
Produces `reports/validation.json` + `.md` with every gate in §9. Unit tests cover:
- turn ordering;
- event parsing;
- span recursion;
- PII scrub;
- the lexicon on gold phrases;
- shrinkage, BH and Wilson against hand-computed values;
- Hungarian stable-ID matching;
- facts supersession and as-of;
- RRF;
- each API route (smoke test);
- the "pipeline never reads ground truth" grep test.

### WP11 Orchestrator and runbook (`run_pipeline.py`, `README.md`). Depends on: all WPs.
```
python -m cie.synth --sessions 100000 --profile real_calibrated
python -m cie.run_pipeline --ingest sample/verizon_traces_example.jsonl:verizon_sample --ingest data/synthetic_traces.jsonl.gz:synthetic
python -m cie.validate
python -m cie.server --port 8080
```
`run_pipeline` supports `--from-stage` and `--only` and records each stage in `pipeline_runs`. A run is
the "overnight batch": ingest new files, recompute downstream stages, version the cards.

---

## 7. Milestones (target delivery Dec 18)

| Milestone | Content | By |
|---|---|---|
| M1 Vertical slice | WP1, WP2, WP3 on the real 36; WP8 session endpoints; WP9 Session Explorer; gold set drafted | Nov 25 |
| M2 Scale | WP0 calibrated; 100K ingested; G0 and G1 pass | Nov 28 |
| M3 Intelligence | WP4, WP5, WP6; G3–G6 pass | Dec 5 |
| M4 Retrieval + full UI | WP7, WP8, WP9 complete; G7 and G8 pass | Dec 12 |
| M5 Hardening | WP10 report, WP11 runbook, demo script, review with the user | Dec 16 |

Parallelism: WP0 runs in parallel with WP1; WP9 runs in parallel from M1 against stub JSON;
WP7 and WP10 test scaffolding start once WP4 lands.

---

## 8. Governance rules (must hold at all times)

- No pattern, card, geo cell or quote is published with support below `K_ANON` sessions.
- Quotes pass the second sanitiser (§3.4). A test scans every card's quotes for phone, email,
  card, SSN, `$amount`, `\d{3,}` and gazetteer-external addresses; the count must be 0.
- Every card has ≥3 evidence quotes, caveats and a data origin. Cards from synthetic data say so in the title badge.
- Only cards with `status='approved'` count as "published". Review status changes are logged with the reviewer and time.
- KPIs that are proxies are labelled "proxy". No dollar figures.

---

## 9. Acceptance gates (`validate.py` must compute all of them)

| Gate | Check | Threshold |
|---|---|---|
| G0 Calibration | synthetic vs real: mean turns, event share, transfer share, agent-request share, null-output share | each within ±25% relative, or within the real sample's 95% CI |
| G1 Ingest integrity | sessions and turns reconcile with the source; 0 duplicate keys; rejects logged; PII hits post-scrub = 0; real sample turn order correct | exact |
| G2 Signals | synthetic per-type precision / recall, bank A vs bank B; gold-set precision on real data | A: precision ≥ .90, recall ≥ .85. B: report only (the gap is the finding). Gold: precision ≥ .80 for escalation_request, dispute, auth_failure, price_sensitivity |
| G3 Episodes and segments | goal-episode count = planted intents per session; segment vs latent persona (NMI) | exact-count accuracy ≥ .85; NMI reported |
| G4 Clusters | ARI and NMI vs primary planted intent on goal episodes; bootstrap stability; silhouette | ARI ≥ .50; ≥ 80% of clusters stable ≥ .60 |
| G5 Patterns | recovery of the 11 planted city×intent effects (incl. 2 time-boxed); FDR on null cells; sequence recovery (outage→churn, coverage→churn, dispute→bill, damage→upgrade) | ≥ 9/11 recovered; empirical FDR ≤ .10; both emerging events flagged inside their window; ≥ 3/4 sequences |
| G6 Cards and facts | governance rules in §8; facts as-of returns the value valid at that time (property test) | 0 violations |
| G7 Retrieval | 60 GT queries (intent × city): P@10, MRR, nDCG@10 for bm25 / dense / hybrid; filter correctness | hybrid MRR ≥ max(bm25, dense) − .02; filters 100% correct |
| G8 Performance | 100K end-to-end pipeline on 4 cores; API p95 | pipeline ≤ 20 min; p95 < 500 ms |

The report must also state, in plain words, what the synthetic gates do **not** prove: that the
language extractors work on real Verizon traffic. G2-gold is the only evidence of that.

---

## 10. Open questions for Verizon (track them; don't block on them)

1. Is `previous_session_id` populated in production exports? Repeat-contact and sequence insights depend on it.
2. Can a non-PII geography key (market, DMA or state) be supplied in Phase 1? Text-only geography will be sparse (`[LOCATION]` masking).
3. Is the 36-session sample representative, or filtered to transferred calls? (It shows 86% transfers.)
4. What is the full `head_intent.*` taxonomy? The real file shows 19 values; we map them in `lexicon.PLATFORM_INTENT_MAP`.
5. Are city-level aggregates and redacted quotes acceptable in evidence cards under the CPNI policy?
6. What volume and frequency will the overnight feed have (files/day, sessions/day)?
