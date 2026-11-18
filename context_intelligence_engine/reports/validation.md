# Validation report

> Synthetic gates prove pipeline capability and statistical behaviour on a generated population with known truth. They do not prove accuracy on real Verizon conversations; the real-sample gold set (draft, needs SME review) is the only real-language evidence.

Versions: `{"schema": "1.0.0", "rules": "0.3.0", "taxonomy": "v0-draft", "episode_model": "1.0.0", "fixtures": "1.0.0"}`

| Gate | Result | Summary |
|---|---|---|
| G0_calibration | **PASS** | 7/8 marginals inside the real sample's 95% CI; intent-mix TVD 0.30 |
| G1_integrity | **PASS** | 100,000 synthetic + 36 real sessions; 0 orphans/duplicates expected; PII hits 0; sha256 verified on 300 landed lines (0 mismatches) |
| G2_signals | **PASS** | Lexicon signals: bank A precision 0.83, recall 0.964; held-out bank B precision 0.611, recall 0.29; structural recall 0.999 |
| G3_intent_classification | **PASS** | Held-out test split (20,043): macro-F1 L2 0.879, L3 0.883; accuracy A 0.952, B 0.788; UNKNOWN 2.5% |
| G4_clusters | **PASS** | Need clusters vs true intent: ARI 0.54, NMI 0.80; need stable share 0.806; SME label reviews 0 |
| G5_patterns | **PASS** | 11/11 planted city×intent effects recovered, geo FDR 0%; time-boxed events flagged 2/2; sequences 4/4; 2 unplanted emerging flag(s) |
| G6_cards_facts | **PASS** | 26 active cards, 0 governance violations, 0 unsanitised quote tokens; point-in-time reconstruction 699/699 |
| G7_retrieval | **PASS** | 60 queries: MRR bm25 0.897, dense 0.897, hybrid 0.911; filters ok; as-of ok |
| G8_api_performance | **INFO** | skipped (--quick) |
| G9_volume | **PASS** | 100,000 sessions, mean 7.02 traces/session (target 7.0 ± 0.1) |
| G10_llm | **INFO** | Claude tier disabled (no API key). 5,001 candidate sessions (5.0% ≤ 5% cap); grounding enforced in code; accepted-but-ungrounded 0 |
| real_sample_gold_draft | **INFO** | n=36 (unreviewed draft): primary L3 72%, unambiguous 89%; handoff/auth-failure detection precision 1.0/1.0 |
| governance | **PASS** | pipeline never reads ground truth or gold files |

## G0_calibration

```json
{
 "pass": true,
 "metrics": {
  "transfer": {
   "real": 0.778,
   "real_ci": [
    0.619,
    0.883
   ],
   "synthetic": 0.794,
   "inside": true
  },
  "asks_human": {
   "real": 0.556,
   "real_ci": [
    0.396,
    0.705
   ],
   "synthetic": 0.538,
   "inside": true
  },
  "unauth": {
   "real": 0.583,
   "real_ci": [
    0.422,
    0.729
   ],
   "synthetic": 0.587,
   "inside": true
  },
  "billing_l1": {
   "real": 0.75,
   "real_ci": [
    0.589,
    0.862
   ],
   "synthetic": 0.651,
   "inside": true
  },
  "event_share": {
   "real": 0.344,
   "real_ci": [
    0.287,
    0.406
   ],
   "synthetic": 0.366,
   "inside": true
  },
  "null_output_share": {
   "real": 0.075,
   "real_ci": [
    0.048,
    0.115
   ],
   "synthetic": 0.051,
   "inside": true
  },
  "mean_traces": {
   "real": 6.69,
   "real_ci": [
    5.75,
    7.56
   ],
   "synthetic": 7.02,
   "inside": true,
   "note": "User requirement is 7 traces/session; the real sample mean is 6.69 with a CI of about 5.7-7.7."
  },
  "intent_L1_mix_tvd": {
   "value": 0.301,
   "inside": null,
   "note": "Synthetic deliberately adds product/service/retention volume so every insight family exists (approved spec); TVD is reported."
  }
 },
 "summary": "7/8 marginals inside the real sample's 95% CI; intent-mix TVD 0.30"
}
```

## G1_integrity

```json
{
 "synthetic_sessions": 100000,
 "real_sessions": 36,
 "real_traces": 241,
 "orphan_traces": 0,
 "duplicate_turn_keys": 0,
 "synthetic_without_provenance": 0,
 "sessions_without_raw_lineage": 0,
 "rejects": 0,
 "pii_hits_after_scrub": 0,
 "real_turn_order_d9b52d90": [
  10,
  11,
  12,
  13,
  14,
  15,
  16,
  17,
  18,
  19,
  20,
  21,
  22
 ],
 "landing_sha256_checked": 300,
 "landing_sha256_mismatch": 0,
 "pass": true,
 "summary": "100,000 synthetic + 36 real sessions; 0 orphans/duplicates expected; PII hits 0; sha256 verified on 300 landed lines (0 mismatches)"
}
```

## G2_signals

```json
{
 "lexicon_types": [
  "churn_intent",
  "complaint",
  "confusion",
  "device_replacement",
  "escalation_request",
  "feature_comparison",
  "frustration",
  "local_event",
  "multi_line_expansion",
  "positive_response",
  "price_sensitivity",
  "repeat_contact_language",
  "willingness"
 ],
 "structural_types": [
  "abandoned",
  "agent_handoff",
  "agent_loop",
  "auth_failure",
  "city_mention",
  "customer_repeat",
  "dtmf_operator",
  "no_input",
  "tool_failure"
 ],
 "A_mean_precision": 0.83,
 "A_mean_recall": 0.964,
 "B_mean_precision": 0.611,
 "B_mean_recall": 0.29,
 "structural_recall": 0.999,
 "note": "Precision counts any detection in a session where the type was not deliberately planted as FP; generated dialogue contains incidental mentions, so precision is a lower bound.",
 "pass": true,
 "summary": "Lexicon signals: bank A precision 0.83, recall 0.964; held-out bank B precision 0.611, recall 0.29; structural recall 0.999"
}
```

## G3_intent_classification

```json
{
 "test_sessions": 20043,
 "macro_f1_L3": 0.883,
 "macro_f1_L2": 0.879,
 "accuracy_L3": 0.887,
 "accuracy_L3_by_bank": {
  "A": 0.952,
  "B": 0.788
 },
 "unknown_rate": 0.025,
 "llm_note": "Bank-B (held-out wording) errors are the target of the Claude adjudication tier, which is disabled until an API key is configured.",
 "pass": true,
 "summary": "Held-out test split (20,043): macro-F1 L2 0.879, L3 0.883; accuracy A 0.952, B 0.788; UNKNOWN 2.5%"
}
```

## G4_clusters

```json
{
 "episodes_scored": 97423,
 "ARI_need_vs_intent": 0.54,
 "NMI_need_vs_intent": 0.798,
 "families": {
  "geo": {
   "clusters": 4,
   "stable_share": 0.0,
   "mean_stability": 0.573
  },
  "need": {
   "clusters": 36,
   "stable_share": 0.806,
   "mean_stability": 0.762
  },
  "risk": {
   "clusters": 6,
   "stable_share": 0.667,
   "mean_stability": 0.68
  },
  "value": {
   "clusters": 6,
   "stable_share": 0.833,
   "mean_stability": 0.779
  }
 },
 "sme_label_reviews": 0,
 "pass": true,
 "summary": "Need clusters vs true intent: ARI 0.54, NMI 0.80; need stable share 0.806; SME label reviews 0"
}
```

## G5_patterns

```json
{
 "planted_city_intent_effects": 11,
 "recovered_as_geo_mix": 11,
 "geo_false_discoveries": [],
 "geo_empirical_FDR": 0.0,
 "time_boxed_events": [
  {
   "city": "Houston",
   "intent": "SERVICE.OUTAGE.DISRUPTION",
   "planted_weeks": [
    8,
    10
   ],
   "flagged": true,
   "flagged_windows": [
    [
     8,
     9
    ]
   ]
  },
  {
   "city": "Atlanta",
   "intent": "ADDSVC.TRAVEL.INTERNATIONAL",
   "planted_weeks": [
    9,
    11
   ],
   "flagged": true,
   "flagged_windows": [
    [
     10,
     11
    ]
   ]
  }
 ],
 "sequences_recovered": "4/4",
 "emerging_unplanted": [
  [
   "ADDSVC.TRAVEL.INTERNATIONAL",
   "Denver"
  ],
  [
   "ADDSVC.TRAVEL.INTERNATIONAL",
   "Mountain"
  ]
 ],
 "tests_and_kept": {
  "aggregate_rows": 79468,
  "tested": {
   "geo_mix": 1472,
   "segment_mix": 231,
   "risk_rate": 312,
   "opportunity": 46,
   "sequence": 522,
   "emerging": 1418
  },
  "kept": {
   "geo_mix": 11,
   "segment_mix": 6,
   "risk_rate": 14,
   "sequence": 13,
   "emerging": 4
  },
  "total_tests": 4001,
  "window_start": "2026-08-24"
 },
 "pass": true,
 "summary": "11/11 planted city\u00d7intent effects recovered, geo FDR 0%; time-boxed events flagged 2/2; sequences 4/4; 2 unplanted emerging flag(s)"
}
```

## G6_cards_facts

```json
{
 "active_cards": 26,
 "card_violations": [],
 "quote_sanitiser_violations": 0,
 "point_in_time_checks": 699,
 "point_in_time_failures": 0,
 "superseded_facts_on_record": 54141,
 "card_versions": 26,
 "pass": true,
 "summary": "26 active cards, 0 governance violations, 0 unsanitised quote tokens; point-in-time reconstruction 699/699"
}
```

## G7_retrieval

```json
{
 "queries": 60,
 "query_text": "first 'include' phrase of the intent definition (not the generated wording)",
 "by_method": {
  "bm25": {
   "p10": 0.432,
   "mrr": 0.897,
   "ndcg": 0.535
  },
  "dense": {
   "p10": 0.798,
   "mrr": 0.897,
   "ndcg": 0.811
  },
  "hybrid": {
   "p10": 0.813,
   "mrr": 0.911,
   "ndcg": 0.822
  }
 },
 "filters_correct": true,
 "asof_correct": true,
 "pass": true,
 "summary": "60 queries: MRR bm25 0.897, dense 0.897, hybrid 0.911; filters ok; as-of ok"
}
```

## G8_api_performance

```json
{
 "pass": null,
 "summary": "skipped (--quick)"
}
```

## G9_volume

```json
{
 "synthetic_sessions": 100000,
 "mean_traces": 7.018,
 "min_traces": 4,
 "pass": true,
 "summary": "100,000 sessions, mean 7.02 traces/session (target 7.0 \u00b1 0.1)"
}
```

## G10_llm

```json
{
 "enabled": false,
 "candidate_sessions": 5001,
 "candidate_share": 0.05,
 "labels": {},
 "accepted_ungrounded": 0,
 "pass": null,
 "summary": "Claude tier disabled (no API key). 5,001 candidate sessions (5.0% \u2264 5% cap); grounding enforced in code; accepted-but-ungrounded 0"
}
```

## real_sample_gold_draft

```json
{
 "sessions": 36,
 "reviewed": 0,
 "primary_accuracy_L3": 0.722,
 "primary_accuracy_L2": 0.722,
 "unambiguous_accuracy_L3": 0.889,
 "flags": {
  "handoff": {
   "precision": 1.0,
   "recall": 1.0,
   "f1": 1.0,
   "tp": 28,
   "fp": 0,
   "fn": 0
  },
  "auth_failure": {
   "precision": 1.0,
   "recall": 1.0,
   "f1": 1.0,
   "tp": 22,
   "fp": 0,
   "fn": 0
  },
  "abandoned": {
   "precision": 1.0,
   "recall": 0.75,
   "f1": 0.857,
   "tp": 3,
   "fp": 0,
   "fn": 1
  },
  "asked_human": {
   "precision": 1.0,
   "recall": 0.952,
   "f1": 0.976,
   "tp": 20,
   "fp": 0,
   "fn": 1
  }
 },
 "signals": {
  "escalation_request": {
   "precision": 1.0,
   "recall": 0.952,
   "f1": 0.976,
   "tp": 20,
   "fp": 0,
   "fn": 1
  },
  "auth_failure": {
   "precision": 0.909,
   "recall": 1.0,
   "f1": 0.952,
   "tp": 20,
   "fp": 2,
   "fn": 0
  },
  "dispute": {
   "precision": 0.333,
   "recall": 1.0,
   "f1": 0.5,
   "tp": 2,
   "fp": 4,
   "fn": 0
  },
  "price_sensitivity": {
   "precision": 1.0,
   "recall": 1.0,
   "f1": 1.0,
   "tp": 1,
   "fp": 0,
   "fn": 0
  },
  "confusion": {
   "precision": 1.0,
   "recall": 1.0,
   "f1": 1.0,
   "tp": 4,
   "fp": 0,
   "fn": 0
  },
  "frustration": {
   "precision": 1.0,
   "recall": 1.0,
   "f1": 1.0,
   "tp": 2,
   "fp": 0,
   "fn": 0
  },
  "customer_repeat": {
   "precision": 0.667,
   "recall": 0.667,
   "f1": 0.667,
   "tp": 4,
   "fp": 2,
   "fn": 2
  },
  "no_input": {
   "precision": 1.0,
   "recall": 1.0,
   "f1": 1.0,
   "tp": 10,
   "fp": 0,
   "fn": 0
  },
  "dtmf_operator": {
   "precision": 1.0,
   "recall": 1.0,
   "f1": 1.0,
   "tp": 1,
   "fp": 0,
   "fn": 0
  },
  "travel_intl": {
   "precision": 0.5,
   "recall": 1.0,
   "f1": 0.667,
   "tp": 2,
   "fp": 2,
   "fn": 0
  },
  "abandoned": {
   "precision": 1.0,
   "recall": 1.0,
   "f1": 1.0,
   "tp": 3,
   "fp": 0,
   "fn": 0
  }
 },
 "disagreements": [
  {
   "session": "CID-3389059416",
   "gold": "ESCALATION.REP.REQUEST",
   "pipeline": "BILL.EXPLAIN.CHARGES",
   "ambiguous": true,
   "note": "Repeats 'customer service'; Spanish; platform guessed bill_breakdown"
  },
  {
   "session": "CID-1606408318",
   "gold": "REFUND.REQUEST.OVERPAYMENT",
   "pipeline": "BILL.CHARGE.DISPUTE",
   "ambiguous": false,
   "note": "Credit balance back to bank account"
  },
  {
   "session": "CID-1589049708",
   "gold": "PAY.MAKE.ONE_TIME",
   "pipeline": "BILL.EXPLAIN.CHARGES",
   "ambiguous": true,
   "note": "'payment save it' garbled; platform bill_plus_operator"
  },
  {
   "session": "CID-2083893756",
   "gold": "PAY.MAKE.ONE_TIME",
   "pipeline": "BILL.CHARGE.DISPUTE",
   "ambiguous": true,
   "note": "'[name] and payment'; platform bill_explain_incorrect; Spanish; disconnect"
  },
  {
   "session": "CID-1225517580",
   "gold": "PAY.STATUS.NOT_REFLECTED",
   "pipeline": "BILL.CHARGE.FRAUD",
   "ambiguous": false,
   "note": "Paid but service inactive (agent paraphrase); PIN failed twice then verified"
  },
  {
   "session": "CID-3014354420",
   "gold": "BILL.EXPLAIN.CHARGES",
   "pipeline": "ADDSVC.TRAVEL.INTERNATIONAL",
   "ambiguous": false,
   "note": "International charges on bill; 'Transfer now'"
  },
  {
   "session": "CID-0804150856",
   "gold": "PAY.STATUS.NOT_REFLECTED",
   "pipeline": "GENERAL.INFO.HOURS",
   "ambiguous": true,
   "note": "'The payment I made' (vague); asks opening hours; transfer tool fired mid-call then disconnect"
  },
  {
   "session": "CID-1820668774",
   "gold": "ACCT.LOOKUP.NUMBER",
   "pipeline": "SERVICE.CONNECTIVITY.COVERAGE",
   "ambiguous": true,
   "note": "Confused/sad; 'problem with someone's phone number'; then 'billing question'"
  },
  {
   "session": "CID-1864415350",
   "gold": "BILL.EXPLAIN.CHARGES",
   "pipeline": "BILL.CHARGE.DISPUTE",
   "ambiguous": true,
   "note": "Only said 'billing'; platform bill_explain_incorrect"
  },
  {
   "session": "CID-0246542580",
   "gold": "ACCT.ACCESS.VERIFY",
   "pipeline": "ESCALATION.REP.REQUEST",
   "ambiguous": true,
   "note": "Wants code sent to new mobile number; 'Get someone on the phone now'"
  }
 ],
 "caveat": "Draft labels (Claude pre-label, reviewed=false); n=36; rules were tuned after seeing these disagreements, so figures are optimistic until an SME-reviewed held-out set exists.",
 "pass": null,
 "summary": "n=36 (unreviewed draft): primary L3 72%, unambiguous 89%; handoff/auth-failure detection precision 1.0/1.0"
}
```

## governance

```json
{
 "pipeline_modules_reading_truth": [],
 "pass": true,
 "summary": "pipeline never reads ground truth or gold files"
}
```
