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

