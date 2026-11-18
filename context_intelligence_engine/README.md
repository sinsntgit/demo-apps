# Context Intelligence Engine: Phase 1 (traces-only)

Turns VzGPT customer-agent traces into governed, evidence-backed insights:
`traces -> signals -> episodes -> clusters -> patterns -> score -> evidence cards`, served in a web UI with search,
an "ask" box, review workflows and a validation report.

- **Build contract for development agents:** [`AGENTS.md`](AGENTS.md) (scope, decisions, work packages, gates).
- **Customer-facing application guide:** the Claude Doc *Context Intelligence Engine: Application Guide* (navigation, demo script, FAQ).
- **Status:** Phase-1 POC complete: 100K synthetic + 36 real sessions, all stages, UI, retrieval, validation. Open items are Verizon decisions (AGENTS.md §2.4 / guide "Limits and Phase 2").

## Run it

Python 3.11+, `pip install -r requirements.txt` (numpy, scikit-learn, scipy, pyyaml, pytest; `anthropic` only to enable the Claude tier).

```bash
python -m cie.synth --sessions 100000 --seed 7        # 100K synthetic sessions (+ ground truth for validation only), ~10 s
python -m cie.run_pipeline --rebuild                  # real sample (if present) + synthetic -> all stages, ~5 min
python -m cie.validate                                # all acceptance gates -> reports/validation.{json,md}
python -m cie.server --port 8080                      # UI at http://127.0.0.1:8080 (pre-warms caches for ~30 s)
python -m pytest -q                                   # 24 tests (fixtures-based, no network)
```

| Mode | Command |
|---|---|
| Overnight batch (new files only, by checksum; downstream stages re-run; reviews kept) | `python -m cie.run_pipeline --daily --inbox landing_inbox/` |
| Weekly cluster refit (stable ids preserved) | `python -m cie.run_pipeline --refit` |
| Re-run from a stage / one stage | `--from-stage patterns` / `--only cards` |
| Clean rebuild including card history | `--rebuild --reset-cards` |
| Claude tier (low-confidence adjudication) | set `ANTHROPIC_API_KEY`, then `python -c "from cie import db; from cie.adapters.llm import Adjudicator; print(Adjudicator(db.connect()).run())"` |

The real sample goes at `sample/verizon_traces_example.jsonl` (git-ignored). Without it everything runs on synthetic data.

## Modules

| Stage | Module | Output tables |
|---|---|---|
| Raw landing + ingest + evaluation mapping | `cie/ingest.py` | `raw_trace_session`, `conversation_*`, `trace_span`, `tool_call`, `agent_evaluation`, `policy_verdict` |
| Intents + signals | `cie/taxonomy.py`, `cie/signals.py`, `cie/lexicon.py`, `taxonomy/taxonomy_v0.yaml` | `turn_intent`, `session_intent`, `session_signal` |
| Episodes, need journeys, features | `cie/episodes.py` | `session_episode`, `need_journey`, `session_feature` |
| Cluster families + L4 discovery | `cie/cluster.py` | `cluster_master`, `session_cluster_membership`, `taxonomy_candidate` |
| Patterns (+ daily aggregates) | `cie/patterns.py` | `agg_daily_intent`, `pattern_master` |
| Scoring (six dimensions + provisional composite) | `cie/scoring.py` | `pattern_score` |
| Evidence cards (versioned) | `cie/cards.py` | `evidence_card`, `evidence_ref` |
| Persistent context (dated facts) | `cie/facts.py` | `fact` |
| Retrieval (BM25 + LSA + RRF, as-of) | `cie/retrieval.py` | `search_doc`, `search_fts` |
| Claude tier (off by default) | `cie/adapters/llm.py` | `llm_cache`, `llm_label` |
| API + UI | `cie/server.py`, `cie/api_insights.py`, `ui/` | (reads) |
| Synthetic generator / fixtures | `cie/synth.py`, `cie/fixtures.py` | files in `data/`, `samples/` |
| Validation | `cie/validate.py` | `reports/validation.{json,md}` |

## Documents

| Deliverable | Where |
|---|---|
| Source data profile | [`docs/W1_source_profile.md`](docs/W1_source_profile.md) |
| Data model, ERD, dictionary | [`docs/data_model.md`](docs/data_model.md), [`docs/data_dictionary.md`](docs/data_dictionary.md) |
| Source-to-target mapping | [`docs/source_to_target.md`](docs/source_to_target.md) |
| Intent taxonomy v0 (11 L1 / 24 L2 / 32 L3) | [`taxonomy/taxonomy_v0.yaml`](taxonomy/taxonomy_v0.yaml), [`docs/taxonomy_v0.md`](docs/taxonomy_v0.md) |
| Signal catalogue (8 families, 41 types) | [`docs/signal_catalogue.md`](docs/signal_catalogue.md) |
| Episode definition | [`docs/episode_definition.md`](docs/episode_definition.md) |
| Scenario catalogue + generator spec | [`docs/scenario_catalogue.md`](docs/scenario_catalogue.md) |
| Validation report | [`reports/validation.md`](reports/validation.md) |

## Data handling

- Only `redacted_*` fields are read; a second PII scrub runs at ingest; card quotes are re-masked.
- Raw files land immutably and content-addressed under `landing/` (git-ignored), with per-session line + SHA-256 lineage.
- The real sample, landed files, database and models are **never committed**. Synthetic data is labelled in every view.
- Real-sample service locations are **assumed** placeholders until Verizon supplies the field (AGENTS.md §2.7).
