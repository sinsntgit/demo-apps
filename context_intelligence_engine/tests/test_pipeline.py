import json, re, sqlite3, threading, urllib.request
from pathlib import Path
from cie.config import FIXTURES_TRUTH, ROOT


def test_fixtures_end_to_end(built_db):
    con = sqlite3.connect(built_db)
    truth = json.load(open(FIXTURES_TRUTH, encoding="utf-8"))["sessions"]
    omap = {"resolved": "resolved_proxy", "escalated": "escalated", "abandoned": "abandoned"}
    for t in truth:
        sid = t["session_id"]
        assert con.execute("SELECT intent_id FROM session_intent WHERE session_id=? AND role='primary'", (sid,)).fetchone()[0] == t["primary_intent"], t["scenario"]
        assert con.execute("SELECT COUNT(*) FROM session_episode WHERE session_id=? AND kind='goal'", (sid,)).fetchone()[0] == t["n_goal_episodes"], t["scenario"]
        assert con.execute("SELECT outcome FROM conversation_session WHERE session_id=?", (sid,)).fetchone()[0] == omap[t["outcome"]], t["scenario"]
        got = {r[0] for r in con.execute("SELECT type FROM session_signal WHERE session_id=?", (sid,))}
        assert set(t["planted_signals"]) <= got, (t["scenario"], set(t["planted_signals"]) - got)


def test_threads_and_need_journeys(built_db):
    con = sqlite3.connect(built_db)
    pos = con.execute("SELECT thread_pos FROM conversation_session WHERE external_id='FIX-THREAD:outage_3_cancel'").fetchone()[0]
    assert pos == 2
    j = con.execute("SELECT n_sessions, last_outcome FROM need_journey WHERE intent_l2='SERVICE.OUTAGE' AND n_sessions>1").fetchone()
    assert j == (2, "abandoned")
    assert con.execute("SELECT COUNT(*) FROM session_signal WHERE type='repeat_same_issue'").fetchone()[0] >= 2


def test_every_catalogue_signal_type_is_exercised(built_db):
    from cie.lexicon import TEXT_SIGNALS, DERIVED_SIGNALS
    con = sqlite3.connect(built_db)
    seen = {r[0] for r in con.execute("SELECT DISTINCT type FROM session_signal")}
    catalogue = {t for _, t, *_ in TEXT_SIGNALS} | {t for _, t, *_ in DERIVED_SIGNALS}
    assert catalogue - seen == set(), catalogue - seen


def test_pipeline_never_reads_ground_truth():
    offenders = [p.name for p in (ROOT / "cie").glob("*.py") if p.name not in ("validate.py", "fixtures.py", "synth.py", "config.py")
                 and re.search(r"FIXTURES_TRUTH|GT_PATH|ground_truth|real_gold", p.read_text(encoding="utf-8"))]
    assert not offenders, offenders


def test_api_routes(built_db):
    from http.server import ThreadingHTTPServer
    from cie.server import Handler
    Handler.db_path = built_db
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    get = lambda p: json.loads(urllib.request.urlopen(base + p).read())
    try:
        ov = get("/api/overview")
        assert ov["funnel"][0]["n"] == 77
        rows = get("/api/sessions?limit=5")["rows"]
        d = get("/api/sessions/" + rows[0]["session_id"])
        assert d["turns"] and d["intents"] and d["episodes"]
        assert get("/api/taxonomy")["nodes"] and get("/api/signals")["signals"] and "runs" in get("/api/runs")
        req = urllib.request.Request(base + "/api/review", data=json.dumps({"object_type": "intent", "object_id": "BILL.EXPLAIN.CHARGES", "action": "approve", "reviewer": "test"}).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        assert json.loads(urllib.request.urlopen(req).read())["ok"]
        assert b"<title>Context Intelligence Engine</title>" in urllib.request.urlopen(base + "/").read()
        try:
            urllib.request.urlopen(base + "/../cie/config.py"); assert False
        except urllib.error.HTTPError as e:
            assert e.code == 404
    finally:
        srv.shutdown()
