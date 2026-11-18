# Validation report: Week 1

Versions: `{"schema": "1.0.0", "rules": "0.3.0", "taxonomy": "v0-draft", "episode_model": "1.0.0", "fixtures": "1.0.0"}`

## G1 Data integrity: PASS

- Real sample: 36 sessions, 241 traces (expected 36 / 241)
- Orphan traces 0, duplicate turn keys 0, synthetic rows without provenance 0, sessions without raw lineage 0, ingest rejects 0
- PII patterns remaining after scrub: 0
- Turn order restored for d9b52d90 (arrives shuffled): [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]

## Scenario fixtures vs truth: PASS

77 scripted synthetic sessions (every L3 intent x 2 + 12 special scenarios).

| Check | Result |
|---|---|
| Primary intent accuracy (L3) | 100% |
| Macro-F1 L3 / L2 | 1.0 / 1.0 |
| Goal-episode count accuracy | 100% |
| Session outcome accuracy | 100% |
| Planted-signal recall | 100% |

These are scripted fixtures whose wording the rules were tuned against: they prove the pipeline end to end, **not** real-world accuracy.

## Real sample vs draft gold labels (directional)

> Draft labels (pre-labelled by Claude, reviewed=false). n=36 is too small for stable estimates. Rules were adjusted after reviewing disagreements on this same set, so these agreement figures are optimistic; G3 needs a fresh SME-reviewed held-out set.

| Measure | Value |
|---|---|
| Primary intent agreement L3 / L2 / L1 | 75% / 75% / 78% |
| L3 agreement on unambiguous sessions | 93% |
| Macro-F1 L3 / L2 | 0.7 / 0.596 |

| Flag / signal | Precision | Recall | TP | FP | FN |
|---|---|---|---|---|---|
| handoff (session flag) | 1.0 | 1.0 | 28 | 0 | 0 |
| auth_failure (session flag) | 1.0 | 1.0 | 22 | 0 | 0 |
| abandoned (session flag) | 1.0 | 0.75 | 3 | 0 | 1 |
| asked_human (session flag) | 1.0 | 0.952 | 20 | 0 | 1 |
| escalation_request | 1.0 | 0.952 | 20 | 0 | 1 |
| auth_failure | 0.909 | 1.0 | 20 | 2 | 0 |
| dispute | 0.333 | 1.0 | 2 | 4 | 0 |
| price_sensitivity | 1.0 | 1.0 | 1 | 0 | 0 |
| confusion | 1.0 | 1.0 | 4 | 0 | 0 |
| frustration | 1.0 | 1.0 | 2 | 0 | 0 |
| customer_repeat | 0.667 | 0.667 | 4 | 2 | 2 |
| no_input | 1.0 | 1.0 | 10 | 0 | 0 |
| dtmf_operator | 1.0 | 1.0 | 1 | 0 | 0 |
| travel_intl | 0.5 | 1.0 | 2 | 2 | 0 |
| abandoned | 1.0 | 1.0 | 3 | 0 | 0 |

### Primary-intent disagreements

| Session | Gold | Pipeline | Ambiguous | Note |
|---|---|---|---|---|
| CID-3389059416 | ESCALATION.REP.REQUEST | BILL.EXPLAIN.CHARGES | yes | Repeats 'customer service'; Spanish; platform guessed bill_breakdown |
| CID-1589049708 | PAY.MAKE.ONE_TIME | BILL.EXPLAIN.CHARGES | yes | 'payment save it' garbled; platform bill_plus_operator |
| CID-2083893756 | PAY.MAKE.ONE_TIME | BILL.CHARGE.DISPUTE | yes | '[name] and payment'; platform bill_explain_incorrect; Spanish; disconnect |
| CID-1225517580 | PAY.STATUS.NOT_REFLECTED | BILL.CHARGE.FRAUD |  | Paid but service inactive (agent paraphrase); PIN failed twice then verified |
| CID-3014354420 | BILL.EXPLAIN.CHARGES | ADDSVC.TRAVEL.INTERNATIONAL |  | International charges on bill; 'Transfer now' |
| CID-0804150856 | PAY.STATUS.NOT_REFLECTED | GENERAL.INFO.HOURS | yes | 'The payment I made' (vague); asks opening hours; transfer tool fired mid-call then disconnect |
| CID-1820668774 | ACCT.LOOKUP.NUMBER | SERVICE.CONNECTIVITY.COVERAGE | yes | Confused/sad; 'problem with someone's phone number'; then 'billing question' |
| CID-1864415350 | BILL.EXPLAIN.CHARGES | BILL.CHARGE.DISPUTE | yes | Only said 'billing'; platform bill_explain_incorrect |
| CID-0246542580 | ACCT.ACCESS.VERIFY | ESCALATION.REP.REQUEST | yes | Wants code sent to new mobile number; 'Get someone on the phone now' |

## Governance

- Pipeline modules reading truth/gold files: none
- UNKNOWN primary-intent share: 0%
- LLM calls this run: 0

## Not yet computed

- G0 calibration (needs 100K synthetic)
- G4 clusters
- G5 patterns
- G6 cards/facts
- G7 retrieval
- G8 performance
- G9 volume shape
- G10 LLM correctness
