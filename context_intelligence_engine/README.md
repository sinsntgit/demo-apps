# Context Intelligence Engine: Phase 1 (traces-only)

Turns VzGPT customer-agent traces into governed, evidence-backed insights:
`traces -> signals -> episodes -> clusters -> patterns -> score -> evidence cards`.

- **Build contract for development agents:** [`AGENTS.md`](AGENTS.md) (scope, decisions, work packages, gates).
- **Status:** Week 1 delivered (discovery, design and vertical slice). Clusters, patterns, cards, retrieval and the 100K synthetic set are Weeks 2-4.

## Run it

Requires Python 3.11+ (`pip install -r requirements.txt`; only `pyyaml` is needed for Week 1, and `numpy`/`scikit-learn` are needed from Week 2 on).

```bash
# 1. put the Verizon export (git-ignored) at sample/verizon_traces_example.jsonl  (optional: fixtures run without it)
python -m cie.fixtures                    # (re)build the 77 scenario fixtures (already committed)
python -m cie.run_pipeline --rebuild      # ingest real sample + fixtures -> signals -> intents -> episodes
python -m cie.validate                    # writes reports/validation.{json,md}
python -m cie.docs                        # regenerates generated docs (profile, catalogue, taxonomy, dictionary)
python -m cie.server --port 8080          # UI at http://127.0.0.1:8080
python -m pytest -q                       # 16 tests
```

## Week-1 deliverables

| # | Deliverable (design baseline §12, Week 1) | Where |
|---|---|---|
| 1 | Source data profiling and assessment | [`docs/W1_source_profile.md`](docs/W1_source_profile.md) (generated) |
| 2 | Canonical data model and ERD | [`docs/data_model.md`](docs/data_model.md), [`docs/data_dictionary.md`](docs/data_dictionary.md), `cie/db.py` |
| 3 | Source-to-target mapping | [`docs/source_to_target.md`](docs/source_to_target.md) |
| 4 | Intent taxonomy draft (v0, 11 L1 / 24 L2 / 32 L3) | [`taxonomy/taxonomy_v0.yaml`](taxonomy/taxonomy_v0.yaml), [`docs/taxonomy_v0.md`](docs/taxonomy_v0.md) |
| 5 | Signal catalogue (8 families, 41 types) | [`docs/signal_catalogue.md`](docs/signal_catalogue.md), `cie/lexicon.py` |
| 6 | Episode definition (proposal) | [`docs/episode_definition.md`](docs/episode_definition.md) |
| 7 | Scenario catalogue + 100K generation spec | [`docs/scenario_catalogue.md`](docs/scenario_catalogue.md), [`samples/`](samples/) |
| 8 | Architecture and governance design | [`AGENTS.md`](AGENTS.md) §2-§9 |
| + | Vertical slice: ingest -> intents -> signals -> episodes -> UI | `cie/`, `ui/` |
| + | Draft real gold set (36 sessions, needs SME review) | `tests/gold/` |
| + | Validation report | [`reports/validation.md`](reports/validation.md) |

## Data handling

- Only `redacted_*` fields are read; a second PII scrub runs at ingest. Raw lines are landed immutably under `landing/` (git-ignored) with sha256 lineage.
- The real sample, landed files and the database are **never committed**. The committed `samples/` are synthetic fixtures (77 scripted sessions), clearly labelled in data and UI.
- Real-sample service locations are **assumed** (deterministic, `geo_source=structured:flat`, `geo_level=assumed_sample`) until Verizon supplies the field.
- No LLM calls in Week 1. The Claude adapter (Haiku 5.5 adjudication, Sonnet 5.5 discovery/gold) is specified in AGENTS.md §2.6 and arrives with an API key.
