# Data dictionary

_Generated from `cie/db.py` (schema 1.0.0). See `data_model.md` for the ERD and grain rules._

## `agent_evaluation`

| Column | Type | PK |
|---|---|---|
| entity_type | TEXT |  |
| entity_id | TEXT |  |
| session_id | TEXT |  |
| metric | TEXT |  |
| canonical_metric | TEXT |  |
| value | REAL |  |
| value_text | TEXT |  |
| scale | TEXT |  |
| status | TEXT |  |
| evaluator | TEXT |  |
| rationale | TEXT |  |
| scorer_version | TEXT |  |

## `agg_daily_intent`

| Column | Type | PK |
|---|---|---|
| day | TEXT |  |
| week | TEXT |  |
| intent_id | TEXT |  |
| city | TEXT |  |
| region | TEXT |  |
| segment | TEXT |  |
| outcome | TEXT |  |
| source | TEXT |  |
| sessions | INTEGER |  |
| opp | INTEGER |  |
| willing | INTEGER |  |
| repeat7 | INTEGER |  |

## `cluster_master`

| Column | Type | PK |
|---|---|---|
| cluster_id | INTEGER | yes |
| stable_id | INTEGER |  |
| family | TEXT |  |
| version | INTEGER |  |
| label | TEXT |  |
| status | TEXT |  |
| size | INTEGER |  |
| sessions | INTEGER |  |
| top_terms | TEXT |  |
| top_intents | TEXT |  |
| top_signals | TEXT |  |
| profile | TEXT |  |
| stability | REAL |  |
| silhouette | REAL |  |
| esc_rate | REAL |  |
| abandon_rate | REAL |  |
| published | INTEGER |  |
| centroid | BLOB |  |
| run_id | INTEGER |  |

## `conversation_session`

| Column | Type | PK |
|---|---|---|
| session_id | TEXT | yes |
| external_id | TEXT |  |
| source | TEXT |  |
| is_synthetic | INTEGER |  |
| provenance_id | TEXT |  |
| created_at | TEXT |  |
| day | TEXT |  |
| week | TEXT |  |
| previous_session_id | TEXT |  |
| thread_id | TEXT |  |
| thread_pos | INTEGER |  |
| customer_key | TEXT |  |
| lang | TEXT |  |
| n_traces | INTEGER |  |
| n_turns | INTEGER |  |
| n_user_utterances | INTEGER |  |
| first_turn_no | INTEGER |  |
| auth_state | TEXT |  |
| journey_label | TEXT |  |
| city | TEXT |  |
| state | TEXT |  |
| region | TEXT |  |
| market | TEXT |  |
| zip3 | TEXT |  |
| geo_source | TEXT |  |
| location_type | TEXT |  |
| outcome | TEXT |  |
| outcome_basis | TEXT |  |
| split | TEXT |  |
| run_id | INTEGER |  |

## `conversation_trace`

| Column | Type | PK |
|---|---|---|
| trace_id | TEXT | yes |
| session_id | TEXT |  |
| turn_no | INTEGER |  |
| seq | INTEGER |  |
| created_at | TEXT |  |
| status_code | TEXT |  |
| is_complete | TEXT |  |
| n_spans | INTEGER |  |

## `conversation_turn`

| Column | Type | PK |
|---|---|---|
| session_id | TEXT | yes |
| turn_no | INTEGER |  |
| seq | INTEGER | yes |
| trace_id | TEXT |  |
| ts | TEXT |  |
| kind | TEXT |  |
| event_type | TEXT |  |
| event_value | TEXT |  |
| user_text | TEXT |  |
| agent_text | TEXT |  |
| agent_role | TEXT |  |
| roles | TEXT |  |
| lang | TEXT |  |

## `data_provenance`

| Column | Type | PK |
|---|---|---|
| provenance_id | TEXT | yes |
| source | TEXT |  |
| is_synthetic | INTEGER |  |
| batch | TEXT |  |
| scenario_id | TEXT |  |
| template_id | TEXT |  |
| generator_version | TEXT |  |
| seed | INTEGER |  |

## `dim_geography`

| Column | Type | PK |
|---|---|---|
| city | TEXT | yes |
| state | TEXT |  |
| region | TEXT |  |
| market | TEXT |  |
| lat | REAL |  |
| lon | REAL |  |

## `dim_intent`

| Column | Type | PK |
|---|---|---|
| intent_id | TEXT | yes |
| level | INTEGER |  |
| parent_id | TEXT |  |
| code | TEXT |  |
| name | TEXT |  |
| family | TEXT |  |
| taxonomy_version | TEXT |  |
| status | TEXT |  |

## `evidence_card`

| Column | Type | PK |
|---|---|---|
| card_id | INTEGER | yes |
| pattern_key | TEXT |  |
| pattern_id | INTEGER |  |
| version | INTEGER |  |
| family | TEXT |  |
| kind | TEXT |  |
| title | TEXT |  |
| observation | TEXT |  |
| population | TEXT |  |
| period | TEXT |  |
| scope | TEXT |  |
| trend | TEXT |  |
| confidence | TEXT |  |
| hypothesis | TEXT |  |
| action | TEXT |  |
| kpi | TEXT |  |
| caveats | TEXT |  |
| scores | TEXT |  |
| composite | REAL |  |
| metrics | TEXT |  |
| data_origin | TEXT |  |
| governance | TEXT |  |
| status | TEXT |  |
| reviewer | TEXT |  |
| review_note | TEXT |  |
| reviewed_at | TEXT |  |
| valid_from | TEXT |  |
| valid_to | TEXT |  |
| superseded_by | INTEGER |  |
| run_id | INTEGER |  |

## `evidence_ref`

| Column | Type | PK |
|---|---|---|
| card_id | INTEGER |  |
| session_id | TEXT |  |
| seq | INTEGER |  |
| turn_no | INTEGER |  |
| trace_id | TEXT |  |
| quote | TEXT |  |
| source | TEXT |  |

## `fact`

| Column | Type | PK |
|---|---|---|
| fact_id | INTEGER | yes |
| scope_type | TEXT |  |
| scope_id | TEXT |  |
| attribute | TEXT |  |
| value | TEXT |  |
| valid_from | TEXT |  |
| valid_to | TEXT |  |
| recorded_at | TEXT |  |
| superseded_by | INTEGER |  |
| source_session | TEXT |  |
| source_seq | INTEGER |  |

## `ingest_reject`

| Column | Type | PK |
|---|---|---|
| run_id | INTEGER |  |
| file | TEXT |  |
| line_no | INTEGER |  |
| reason | TEXT |  |
| snippet | TEXT |  |

## `intent_definition`

| Column | Type | PK |
|---|---|---|
| intent_id | TEXT | yes |
| definition | TEXT |  |
| include_criteria | TEXT |  |
| exclude_criteria | TEXT |  |
| examples | TEXT |  |
| platform_intent_patterns | TEXT |  |
| keyword_rules | TEXT |  |

## `kv`

| Column | Type | PK |
|---|---|---|
| k | TEXT | yes |
| v | TEXT |  |

## `llm_cache`

| Column | Type | PK |
|---|---|---|
| key | TEXT | yes |
| use | TEXT |  |
| model | TEXT |  |
| prompt_version | TEXT |  |
| request | TEXT |  |
| response | TEXT |  |
| input_tokens | INTEGER |  |
| output_tokens | INTEGER |  |
| cache_read | INTEGER |  |
| at | TEXT |  |

## `llm_label`

| Column | Type | PK |
|---|---|---|
| object_type | TEXT |  |
| object_id | TEXT |  |
| use | TEXT |  |
| label | TEXT |  |
| evidence | TEXT |  |
| grounded | INTEGER |  |
| agrees_with_rules | INTEGER |  |
| status | TEXT |  |
| model | TEXT |  |
| prompt_version | TEXT |  |
| at | TEXT |  |

## `need_journey`

| Column | Type | PK |
|---|---|---|
| journey_id | TEXT | yes |
| thread_id | TEXT |  |
| intent_l2 | TEXT |  |
| first_session | TEXT |  |
| last_session | TEXT |  |
| first_at | TEXT |  |
| last_at | TEXT |  |
| n_sessions | INTEGER |  |
| n_episodes | INTEGER |  |
| resolved | INTEGER |  |
| last_outcome | TEXT |  |

## `pattern_master`

| Column | Type | PK |
|---|---|---|
| pattern_id | INTEGER | yes |
| pattern_key | TEXT |  |
| kind | TEXT |  |
| family | TEXT |  |
| subject_type | TEXT |  |
| subject | TEXT |  |
| subject_label | TEXT |  |
| dim_type | TEXT |  |
| dim_value | TEXT |  |
| metric | TEXT |  |
| period | TEXT |  |
| support | INTEGER |  |
| denominator | INTEGER |  |
| rate | REAL |  |
| baseline | REAL |  |
| lift | REAL |  |
| lift_shrunk | REAL |  |
| ci_lo | REAL |  |
| ci_hi | REAL |  |
| pval | REAL |  |
| qval | REAL |  |
| trend | REAL |  |
| recent_rate | REAL |  |
| prior_rate | REAL |  |
| coverage | REAL |  |
| extra | TEXT |  |
| version | TEXT |  |
| run_id | INTEGER |  |

## `pattern_score`

| Column | Type | PK |
|---|---|---|
| pattern_id | INTEGER |  |
| dimension | TEXT |  |
| value | REAL |  |
| method | TEXT |  |
| scoring_version | TEXT |  |

## `policy_verdict`

| Column | Type | PK |
|---|---|---|
| session_id | TEXT |  |
| journey | TEXT |  |
| policy_id | TEXT |  |
| verdict | TEXT |  |
| severity | TEXT |  |
| policy_type | TEXT |  |
| evidence | TEXT |  |
| reason | TEXT |  |

## `processed_day`

| Column | Type | PK |
|---|---|---|
| source | TEXT | yes |
| day | TEXT |  |
| file | TEXT | yes |
| sha256 | TEXT |  |
| sessions | INTEGER |  |
| finished_at | TEXT |  |

## `processing_run`

| Column | Type | PK |
|---|---|---|
| run_id | INTEGER | yes |
| stage | TEXT |  |
| started_at | TEXT |  |
| finished_at | TEXT |  |
| status | TEXT |  |
| versions | TEXT |  |
| stats | TEXT |  |
| error | TEXT |  |

## `raw_trace_session`

| Column | Type | PK |
|---|---|---|
| session_id | TEXT | yes |
| source | TEXT |  |
| landing_file | TEXT |  |
| line_no | INTEGER |  |
| byte_offset | INTEGER |  |
| byte_len | INTEGER |  |
| sha256 | TEXT |  |
| landed_at | TEXT |  |
| run_id | INTEGER |  |

## `review_log`

| Column | Type | PK |
|---|---|---|
| review_id | INTEGER | yes |
| object_type | TEXT |  |
| object_id | TEXT |  |
| action | TEXT |  |
| reviewer | TEXT |  |
| note | TEXT |  |
| at | TEXT |  |

## `search_doc`

| Column | Type | PK |
|---|---|---|
| doc_id | INTEGER | yes |
| doc_type | TEXT |  |
| ref_id | TEXT |  |
| session_id | TEXT |  |
| text | TEXT |  |

## `session_cluster_membership`

| Column | Type | PK |
|---|---|---|
| object_type | TEXT |  |
| object_id | TEXT |  |
| session_id | TEXT |  |
| cluster_id | INTEGER |  |
| family | TEXT |  |
| similarity | REAL |  |
| run_id | INTEGER |  |

## `session_episode`

| Column | Type | PK |
|---|---|---|
| episode_id | TEXT | yes |
| session_id | TEXT |  |
| ep_no | INTEGER |  |
| kind | TEXT |  |
| start_seq | INTEGER |  |
| end_seq | INTEGER |  |
| intent_id | TEXT |  |
| intent_conf | REAL |  |
| domain_agent | TEXT |  |
| platform_intent | TEXT |  |
| text | TEXT |  |
| n_user_turns | INTEGER |  |
| outcome | TEXT |  |
| outcome_basis | TEXT |  |
| friction | REAL |  |
| signal_types | TEXT |  |
| boundary_reason | TEXT |  |

## `session_feature`

| Column | Type | PK |
|---|---|---|
| session_id | TEXT | yes |
| friction | REAL |  |
| n_escalation_requests | INTEGER |  |
| n_auth_failures | INTEGER |  |
| n_no_input | INTEGER |  |
| n_handoffs | INTEGER |  |
| repeat_contact | INTEGER |  |
| days_since_prev | REAL |  |
| need_flag | INTEGER |  |
| buying_flag | INTEGER |  |
| value_flag | INTEGER |  |
| risk_flag | INTEGER |  |
| opp_flag | INTEGER |  |
| segment | TEXT |  |
| style | TEXT |  |

## `session_intent`

| Column | Type | PK |
|---|---|---|
| session_id | TEXT |  |
| intent_id | TEXT |  |
| role | TEXT |  |
| confidence | REAL |  |
| method | TEXT |  |
| taxonomy_version | TEXT |  |
| evidence | TEXT |  |

## `session_signal`

| Column | Type | PK |
|---|---|---|
| signal_id | INTEGER | yes |
| session_id | TEXT |  |
| seq | INTEGER |  |
| turn_no | INTEGER |  |
| trace_id | TEXT |  |
| family | TEXT |  |
| category | TEXT |  |
| type | TEXT |  |
| value | TEXT |  |
| text | TEXT |  |
| confidence | REAL |  |
| method | TEXT |  |
| rule_version | TEXT |  |
| ts | TEXT |  |
| is_synthetic | INTEGER |  |

## `taxonomy_candidate`

| Column | Type | PK |
|---|---|---|
| candidate_id | TEXT | yes |
| parent_intent | TEXT |  |
| kind | TEXT |  |
| label | TEXT |  |
| top_terms | TEXT |  |
| size | INTEGER |  |
| examples | TEXT |  |
| proposed_by | TEXT |  |
| status | TEXT |  |
| run_id | INTEGER |  |

## `tool_call`

| Column | Type | PK |
|---|---|---|
| session_id | TEXT |  |
| seq | INTEGER |  |
| trace_id | TEXT |  |
| tool | TEXT |  |
| agent_role | TEXT |  |
| intent_name | TEXT |  |
| query | TEXT |  |
| requested_operator | INTEGER |  |
| failed | INTEGER |  |
| args | TEXT |  |

## `trace_span`

| Column | Type | PK |
|---|---|---|
| span_id | TEXT |  |
| trace_id | TEXT |  |
| session_id | TEXT |  |
| parent_id | TEXT |  |
| depth | INTEGER |  |
| type | TEXT |  |
| name | TEXT |  |
| step_number | TEXT |  |

## `turn_intent`

| Column | Type | PK |
|---|---|---|
| session_id | TEXT |  |
| seq | INTEGER |  |
| intent_id | TEXT |  |
| confidence | REAL |  |
| method | TEXT |  |
| evidence | TEXT |  |

