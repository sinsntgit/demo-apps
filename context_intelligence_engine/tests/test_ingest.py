import json
from cie import ingest
from cie.lexicon import PII_PATTERNS


def _rec(traces, **kw):
    return {"session_id": "s1", "created_at": "2026-09-14 10:00:00+00:00", "traces": traces, "metrics": {}, **kw}


def _tr(n, user, out=None, spans=None, ts="2026-09-14 10:00:00"):
    u = json.dumps([{"role": "user", "content": user}])
    o = json.dumps(out) if out is not None else None
    return {"name": f"turn {n} workflow", "created_at": ts, "redacted_input": u, "redacted_output": o, "spans": spans or []}


def test_turn_order_events_and_null_output():
    traces = [_tr(12, "<context>user pressed 0 on keypad.</context>", [{"role": "Root_agent", "content": "[prosody rate=\"64%\"][warm] Hi [PERSON_NAME]"}]),
              _tr(10, "<event>session start</event>", None),
              _tr(11, "<context>no user activity detected for 9 seconds.</context>", [{"role": "tool", "content": {"x": 1}}])]
    s, turns, *_ = ingest.normalise(_rec(traces), "fixtures", [0])
    assert [t[1] for t in turns] == [10, 11, 12]
    assert [t[6] for t in turns] == ["session_start", "no_input", "dtmf"]
    assert turns[2][7] == "0"
    assert turns[2][9] == "Hi [PERSON_NAME]"          # lower-case markup stripped, placeholder kept
    assert turns[2][10] == "root_agent"               # role case-normalised
    assert turns[0][9] is None                        # null output tolerated


def test_tool_spans_recursive_and_intent_fields():
    tool = {"type": "tool", "name": "mandatory_set_intent_for_next_step",
            "input": json.dumps([{"role": "root_agent", "content": {"intent_name": "head_intent.bill_reduce", "requested_operator": True}}])}
    traces = [_tr(1, "lower my bill", [{"role": "root_agent", "content": "ok"}], spans=[{"type": "workflow", "spans": [{"type": "llm", "spans": [tool]}]}])]
    _, _, _, spans, tools, *_ = ingest.normalise(_rec(traces), "fixtures", [0])
    assert len(spans) == 3 and tools[0][3] == "mandatory_set_intent_for_next_step"
    assert tools[0][5] == "head_intent.bill_reduce" and tools[0][7] == 1


def test_location_contract_modes():
    flat = ingest.parse_location({"user_metadata": {"svc_city": "orlando", "svc_state": "fl", "svc_zip3": "32801"}})
    assert flat["city"] == "Orlando" and flat["state"] == "FL" and flat["zip3"] == "328" and flat["geo_source"] == "structured:flat"
    nested = ingest.parse_location({"user_metadata": {"location": {"city": "Phoenix", "zip": "85004"}}})
    assert nested["zip3"] == "850" and nested["region"] == "Southwest"          # ZIP5 truncated, region from gazetteer
    tags = ingest.parse_location({"user_metadata": {}, "tags": ["svc_city:Denver", "svc_state:CO"]})
    assert tags["city"] == "Denver" and tags["geo_source"] == "structured:tags"
    assert ingest.parse_location({"user_metadata": {}}) is None


def test_pii_scrub():
    c = [0]
    out = ingest.scrub("call me at 555-123-4567 or a@b.com, card 4111 1111 1111 1111", c)
    assert "555-123-4567" not in out and "a@b.com" not in out and "4111" not in out and c[0] == 3
    assert ingest.scrub("my bill is $257.61", [0]) == "my bill is $257.61"       # amounts are not PII at ingest


def test_metrics_status_not_coerced_to_zero():
    rows, verdicts = ingest.explode_metrics({"VZ Verbosity": 0.0, "VZ Verbosity_status": "not_applicable",
                                             "agent_flow": [1.0], "Action_Completion_Voice_Agent": "error",
                                             "cm_policy_metric": json.dumps({"metrics": {"journey": "bill-explanation", "overall_compliance_rate": 1.0,
                                                                                        "verdicts": [{"policy_id": "GEN-01", "verdict": "PASS"}]}})}, "session", "s1", "s1")
    by = {r[3]: r for r in rows}
    assert by["VZ Verbosity"][5] is None and by["VZ Verbosity"][8] == "not_applicable"
    assert by["agent_flow"][5] == 1.0 and by["Action_Completion_Voice_Agent"][8] == "error"
    assert verdicts[0][2] == "GEN-01"
