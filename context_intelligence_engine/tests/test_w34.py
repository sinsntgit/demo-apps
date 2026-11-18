"""Tests for W3-W4 modules: statistics, facts (point-in-time), LLM adapter (fake client), daily mode, new API routes."""
import json, shutil, sqlite3, threading, urllib.request
from types import SimpleNamespace
import pytest
from cie import patterns, facts, db


def copy_db(src, dst):
    """WAL-safe copy (shutil would miss pages still in the -wal file)."""
    a, b = sqlite3.connect(src), sqlite3.connect(dst)
    a.backup(b); b.close(); a.close()
from cie.adapters import llm


def test_stats_functions():
    lo, hi = patterns.wilson(10, 100)
    assert round(lo, 3) == 0.055 and round(hi, 3) == 0.174
    q = patterns.bh([0.01, 0.04, 0.03, 0.2])
    assert [round(x, 3) for x in q] == [0.04, 0.053, 0.053, 0.2]
    assert patterns.ztest(50, 100, 50, 100) == 1.0 and patterns.ztest(80, 100, 20, 100) < 1e-10
    assert round(patterns.shrunk(0, 0, .2), 3) == 0.2


def test_facts_point_in_time_and_supersession(built_db):
    con = db.connect(built_db)
    facts.run(con)
    t = con.execute("SELECT thread_id FROM conversation_session WHERE external_id='FIX-THREAD:dispute_2_resolved'").fetchone()[0]
    s1, s2 = [r[0] for r in con.execute("SELECT created_at FROM conversation_session WHERE thread_id=? ORDER BY created_at", (t,))]
    before = {f["attribute"]: f["value"] for f in facts.facts_as_of(con, t, s1)}
    after = {f["attribute"]: f["value"] for f in facts.facts_as_of(con, t, s2)}
    assert before.get("open_issue") == "BILL.CHARGE" and "open_issue" not in after and after.get("issue_resolved") == "BILL.CHARGE"
    hist = facts.history(con, t)
    assert any(f["attribute"] == "open_issue" and f["valid_to"] and f["superseded_by"] for f in hist)   # superseded fact stays on record


class FakeClient:
    """Records calls; answers with a fixed label/quote (no network)."""
    def __init__(self, label, quote, stop="end_turn"):
        self.calls, self.label, self.quote, self.stop = 0, label, quote, stop
        self.messages = SimpleNamespace(create=self.create)

    def create(self, **kw):
        assert "temperature" not in kw and kw["output_config"]["format"]["type"] == "json_schema"
        assert kw["system"][0]["cache_control"] == {"type": "ephemeral"}
        self.calls += 1
        seq = int(kw["messages"][0]["content"].split("seq ")[1].split(":")[0])
        body = json.dumps({"intent_id": self.label, "evidence_seq": seq, "evidence_quote": self.quote, "confidence": .8})
        return SimpleNamespace(stop_reason=self.stop, content=[SimpleNamespace(type="text", text=body)],
                               usage=SimpleNamespace(input_tokens=100, output_tokens=20, cache_read_input_tokens=90))


@pytest.fixture()
def band_db(built_db, tmp_path):
    p = tmp_path / "b.sqlite"; copy_db(built_db, p)
    con = db.connect(p); db.init(con)
    sid = con.execute("SELECT session_id FROM conversation_session WHERE external_id='FIX-PLAN.ENQUIRY.OPTIONS:A'").fetchone()[0]
    con.execute("UPDATE session_intent SET confidence=0.5 WHERE session_id=? AND role='primary'", (sid,)); con.commit()
    return con, sid


def test_llm_grounded_agreement_and_cache(band_db):
    con, sid = band_db
    first = con.execute("SELECT user_text FROM conversation_turn WHERE session_id=? AND user_text IS NOT NULL ORDER BY seq LIMIT 1", (sid,)).fetchone()[0]
    fake = FakeClient("PLAN.ENQUIRY.OPTIONS", first[:15])
    r = llm.Adjudicator(con, client=fake).run(use_batch=False)
    assert r["accepted"] >= 1 and fake.calls >= 1
    r2 = llm.Adjudicator(con, client=fake).run(use_batch=False)
    assert r2["from_cache"] == r["candidates"] and fake.calls == r["candidates"]            # rerun makes no new calls


def test_llm_ungrounded_and_disagreement_are_not_accepted(band_db):
    con, sid = band_db
    r = llm.Adjudicator(con, client=FakeClient("PLAN.ENQUIRY.OPTIONS", "words the customer never said")).run(use_batch=False)
    assert r["accepted"] == 0 and r["rejected_ungrounded"] >= 1
    con.execute("DELETE FROM llm_cache")
    first = con.execute("SELECT user_text FROM conversation_turn WHERE session_id=? AND user_text IS NOT NULL ORDER BY seq LIMIT 1", (sid,)).fetchone()[0]
    r = llm.Adjudicator(con, client=FakeClient("BILL.EXPLAIN.CHARGES", first[:10])).run(use_batch=False)
    assert r["accepted"] == 0 and r["needs_review"] >= 1
    con.execute("DELETE FROM llm_cache")
    r = llm.Adjudicator(con, client=FakeClient("PLAN.ENQUIRY.OPTIONS", first[:10], stop="refusal")).run(use_batch=False)
    assert r["accepted"] == 0 and r["needs_review"] >= 1                                      # refusal never becomes a label


def test_llm_disabled_without_key(built_db, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False); monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    assert "disabled" in llm.Adjudicator(db.connect(built_db)).run()["status"]


def test_daily_mode_is_idempotent(tmp_path):
    from cie import run_pipeline
    from cie.config import FIXTURES
    inbox = tmp_path / "inbox"; inbox.mkdir(); shutil.copy(FIXTURES, inbox / "day1.jsonl")
    dbp = tmp_path / "d.sqlite"
    run_pipeline.main(["--daily", "--inbox", str(inbox), "--db", str(dbp)])
    con = sqlite3.connect(dbp)
    n1 = con.execute("SELECT COUNT(*) FROM conversation_session").fetchone()[0]
    run_pipeline.main(["--daily", "--inbox", str(inbox), "--db", str(dbp)])
    assert con.execute("SELECT COUNT(*) FROM conversation_session").fetchone()[0] == n1 == 77
    assert con.execute("SELECT COUNT(*) FROM processed_day").fetchone()[0] == 1


def test_scoring_is_reproducible(built_db, tmp_path):
    from cie import scoring
    p = tmp_path / "s.sqlite"; copy_db(built_db, p)
    con = db.connect(p); db.init(con)
    patterns.run(con); scoring.run(con)
    a = con.execute("SELECT pattern_id, dimension, value FROM pattern_score ORDER BY 1,2").fetchall()
    scoring.run(con)
    assert a == con.execute("SELECT pattern_id, dimension, value FROM pattern_score ORDER BY 1,2").fetchall()


def test_new_api_routes(built_db):
    from http.server import ThreadingHTTPServer
    from cie.server import Handler
    Handler.db_path = built_db
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler); threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        for r in ("cards", "clusters?family=need", "patterns", "geo", "journeys", "llm", "kpis", "taxonomy/candidates", "validation", "ask?q=add%20a%20line"):
            json.loads(urllib.request.urlopen(f"{base}/api/{r}").read())
        req = urllib.request.Request(f"{base}/api/cards/999999/review", data=b'{"status":"approved"}', headers={"Content-Type": "application/json"}, method="POST")
        with pytest.raises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(req)
        assert e.value.code == 400
    finally:
        srv.shutdown()
