from cie.ingest import trace_order_key


def _t(name, ts):
    return {"name": name, "created_at": ts}


def test_created_at_is_primary_turn_number_secondary():
    # array order (updated_at, newest first) is the reverse of conversation order
    traces = [_t("turn 10 workflow", "2026-09-14 15:34:17.000000+00:00"), _t("turn 3 workflow", "2026-09-14 15:32:15.000000+00:00"),
              _t("turn 1 workflow", "2026-09-14 15:31:58.000000+00:00")]
    assert [t["name"] for t in sorted(traces, key=trace_order_key)] == ["turn 1 workflow", "turn 3 workflow", "turn 10 workflow"]


def test_turn_number_breaks_timestamp_ties():
    ts = "2026-09-14 15:32:15.000000+00:00"
    traces = [_t("turn 5 workflow", ts), _t("turn 4 workflow", ts)]
    assert [t["name"] for t in sorted(traces, key=trace_order_key)] == ["turn 4 workflow", "turn 5 workflow"]


def test_missing_or_bad_timestamp_sorts_last_and_mixed_formats_compare():
    traces = [_t("turn 2 workflow", None), _t("turn 9 workflow", "2026-09-14T15:00:00Z"), _t("turn 8 workflow", "2026-09-14 14:00:00")]
    assert [t["name"] for t in sorted(traces, key=trace_order_key)] == ["turn 8 workflow", "turn 9 workflow", "turn 2 workflow"]
