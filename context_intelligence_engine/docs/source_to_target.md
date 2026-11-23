# Source-to-target mapping (VzGPT / Galileo export -> canonical model)

| Source field | Target | Transformation |
|---|---|---|
| line (session record) | `raw_trace_session` | landed gzipped, immutable; line no, byte offset, sha256 |
| `session_id` (fallback `id`) | `conversation_session.session_id` | as-is |
| `external_id` (`CID-...`) | `external_id` | as-is (call id; not a customer id) |
| `created_at` | `created_at`, `day`, `week` | ISO week derived |
| `previous_session_id` | `previous_session_id`, `thread_id`, `thread_pos` | union-find over chains; thread root = first session |
| `user_metadata.svc_*` / `.location{}` / trace `user_metadata` / `tags svc_*:` | `city, state, zip3, market, region, geo_source, location_type` | **assumed contract** (AGENTS.md §2.7); ZIP5 truncated to ZIP3; gazetteer fills region; `location_type='service'` |
| `dataset_metadata` (synthetic only) | `data_provenance`, `is_synthetic`, `provenance_id` | batch / scenario / template / generator version / seed |
| `metrics.*` (session) | `agent_evaluation` (entity `session`) | grouped by base name; `_status`, `_rationale`/`_explanation`/`_error_message`, `_model_alias`, `_scorer_version_id` kept; tokens/costs/`@aggregates` dropped; canonical names for 17 metrics |
| `metrics.cm_policy_metric` (JSON string) | `agent_evaluation(policy_compliance)`, `policy_verdict`, `journey_label` | per-policy verdict, severity, type, evidence, reason |
| `traces[]` | `conversation_trace`, `conversation_turn` | sorted by `created_at` (agent-server clock), then `turn N` in `name` as tie-break; `seq` = 0..n-1 |
| `traces[].redacted_input` | `conversation_turn.user_text` or `kind='event'` | `<event>`/`<context>` -> `event_type` (session_start, disconnect, dtmf + key, no_input + secs, function_result + name); PII re-scrub; language tag |
| `traces[].redacted_output` | `agent_text`, `agent_role`, `roles` | concatenate non-tool messages; strip lower-case markup (`[prosody ...]`, `[warm]`); keep UPPER placeholders; roles lower-cased |
| `traces[].spans[]` (recursive) | `trace_span` | id, parent, depth, type, name, step |
| tool spans | `tool_call` | `intent_name` (or `handle_out_of_scope.topic`), `query`/`user_intent`/`user_utterance`, `requested_operator`, `failed` (status_code or error payload) |
| `traces[].metrics` (whitelist of 11 quality metrics) | `agent_evaluation` (entity `trace`) | same rules as session metrics |
| derived | `turn_intent`, `session_intent`, `session_signal`, `session_episode`, `need_journey`, `session_feature` | rules versioned in `config.VERSIONS` |

Fields deliberately **not** used: raw `input`/`output` (redacted copies only), token/cost fields (operational), annotation fields (empty in sample).
