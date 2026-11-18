# Signal catalogue

_Generated from `cie/lexicon.py` (rules 0.3.0)._ Every signal row stores family, type, value, evidence text, confidence, method, rule version and the evidence turn (seq, turn_no, trace_id).

## Customer need (`need`)

| Type | Method | Confidence | Meaning |
|---|---|---|---|
| `coverage_availability` | lexicon | 0.8 | Coverage / availability problem |
| `billing_clarification` | intent | - | Turn classified to a BILL.* intent |
| `payment_issue` | intent | - | Turn classified to a PAY.* intent |
| `refund_credit` | intent | - | Turn classified to a REFUND.* intent |
| `account_access` | intent | - | Turn classified to an ACCT.* intent |
| `service_request` | intent | - | Turn classified to SERVICE.ACTIVATION / DEVICE.ORDER |

## Buying intent (`buying`)

| Type | Method | Confidence | Meaning |
|---|---|---|---|
| `upgrade_device` | lexicon | 0.8 | Interest in a new device, upgrade eligibility or trade-in |
| `add_line` | lexicon | 0.85 | Add-a-line enquiry |
| `plan_question` | lexicon | 0.7 | Question about plans or changing plan |
| `hotspot_home_internet` | lexicon | 0.85 | Hotspot, tethering or home-internet need |
| `travel_intl` | lexicon | 0.85 | Travel / international need |

## Value signal (`value`)

| Type | Method | Confidence | Meaning |
|---|---|---|---|
| `willingness` | lexicon | 0.8 | Explicit willingness to buy / accept |
| `price_sensitivity` | lexicon | 0.85 | Price sensitivity or cost-reduction language |
| `feature_comparison` | lexicon | 0.8 | Comparing plans, features or competitors |
| `device_replacement` | lexicon | 0.85 | Device replacement cue |
| `multi_line_expansion` | lexicon | 0.8 | Multi-line / household expansion |

## Retention risk (`risk`)

| Type | Method | Confidence | Meaning |
|---|---|---|---|
| `churn_intent` | lexicon | 0.9 | Cancellation or switching language |
| `complaint` | lexicon | 0.75 | Complaint about service or company |
| `dispute` | lexicon | 0.85 | Disputed or unauthorised charge |
| `payment_difficulty` | lexicon | 0.8 | Difficulty paying / suspension |
| `repeat_contact_language` | lexicon | 0.85 | Customer says they contacted before / issue persists |

## Journey friction (`friction`)

| Type | Method | Confidence | Meaning |
|---|---|---|---|
| `escalation_request` | lexicon | 0.9 | Asks for a human agent |
| `agent_handoff` | tool | - | A *transfer* tool was executed |
| `auth_failure` | tool | - | invalid_auth / failed PIN / verification failure |
| `no_input` | event | - | 'no user activity detected' system event |
| `dtmf_operator` | event | - | Customer pressed 0 (operator) |
| `agent_loop` | derived | - | Agent repeats an earlier response (token Jaccard >= threshold) |
| `customer_repeat` | derived | - | Customer repeats an earlier utterance |
| `tool_failure` | tool | - | Tool span reports an error / failure status |
| `out_of_scope` | tool | - | handle_out_of_scope tool executed |
| `abandoned` | derived | - | Session ends by disconnect or repeated no-input without handoff |

## Experience indicator (`experience`)

| Type | Method | Confidence | Meaning |
|---|---|---|---|
| `frustration` | lexicon | 0.75 | Frustration / emotional distress |
| `confusion` | lexicon | 0.75 | Confusion about the process or the agent |
| `positive_response` | lexicon | 0.7 | Positive response / satisfaction cue |

## Geographic signal (`geo`)

| Type | Method | Confidence | Meaning |
|---|---|---|---|
| `local_event` | lexicon | 0.75 | Local event, weather or relocation |
| `coverage_local` | lexicon | 0.8 | Coverage tied to a specific place |
| `city_mention` | gazetteer | - | A known city named in customer text (typed: destination/current/unknown) |
| `location_mismatch` | derived | - | Text city differs from the structured service location |
| `location_unresolved` | placeholder | - | [LOCATION] redaction placeholder in customer text |

## Temporal indicator (`temporal`)

| Type | Method | Confidence | Meaning |
|---|---|---|---|
| `repeat_contact` | metadata | - | Session has previous_session_id (thread-linked repeat) |
| `repeat_same_issue` | derived | - | Same L2 intent as the previous session in the thread |

## Methods

- `lexicon`: regex on redacted customer text; `lexicon@paraphrase`: same regex on the agent's issue paraphrase (confidence x0.9).
- `intent`: emitted from turn intent classification (taxonomy rules).
- `tool` / `event` / `metadata` / `placeholder` / `gazetteer`: structural evidence.
- `derived`: computed across turns (loops, repeats, abandonment, thread logic).
- `llm` (not yet enabled): adjudication inside the uncertainty band, see AGENTS.md §2.6.

Full regexes are in `cie/lexicon.py`; the UI Signal Catalogue page shows live counts and example evidence.
