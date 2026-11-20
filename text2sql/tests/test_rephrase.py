"""'Rephrase': a small, cheap prompt that suggests a clearer question; logged with its cost; linked to the question asked."""
import json

from tests.conftest import FAKE_PORT, H
from tests.test_platform import ask


def _last_prompt(fake_llm) -> tuple[str, str]:
    msgs = {m["role"]: m["content"] for m in fake_llm.REQUESTS[-1]["messages"]}
    return msgs["system"], msgs["user"]


def test_rephrase_prompt_is_small_and_safe(admin, fake_llm):
    client, conn, model = admin
    out = ask(client, conn, model, "revenue and orders by region")          # a normal question, for comparison
    normal = sum(len(m["content"]) for m in fake_llm.REQUESTS[-1]["messages"])
    cid = out["conversation"]["id"]

    r = client.post("/api/chat/rephrase", headers=H, json={"connection_id": conn, "model_id": model, "question": "rev by cat pls",
                                                          "conversation_id": cid}).json()
    system, user = _last_prompt(fake_llm)
    assert r["question"] == "What is the total revenue by category?" and r["changes"] and r["unclear"] == "which time period"
    assert "What is total revenue by product category?" in r["similar"]          # verified example found locally
    assert r["input_tokens"] > 0 and r["cost"] > 0 and r["model_label"] == "Fake"
    # small: names only, no DDL, no SQL (not even the verified examples' or the conversation's), no result values
    assert len(system) + len(user) < normal, (len(system) + len(user), normal)
    assert "order_items(" in user and "CREATE TABLE" not in user and "SELECT" not in user.upper()
    assert "revenue and orders by region" in user                                   # earlier question gives context
    revenue_values = {str(row[1]) for row in out["run"]["rows"]}
    assert not any(v in user for v in revenue_values)

    # asking with the suggestion links the answer to it; someone else's suggestion id is ignored
    run = ask(client, conn, model, r["question"], rephrase_id=r["id"])["run"]
    from app.db import SessionLocal
    from app.models import QueryRun, RephraseLog
    with SessionLocal() as db:
        assert db.get(QueryRun, run["id"]).rephrase_id == r["id"] and db.get(RephraseLog, r["id"]).used

    dash = client.get("/api/analytics/summary?days=7").json()["rephrase"]
    assert dash["count"] >= 1 and dash["used"] >= 1 and dash["cost"] > 0 and dash["rephrased"]["questions"] >= 1

    # a reply the app cannot use: still 200, an explanation, and the free suggestions; logged as an error
    bad = client.post("/api/chat/rephrase", headers=H, json={"connection_id": conn, "model_id": model, "question": "unrephrasable revenue by category"}).json()
    assert bad["error"] and "question" not in bad and bad["similar"]


def test_rephrase_settings_and_access(admin, fake_llm):
    client, conn, model = admin
    other = client.post("/api/admin/models", headers=H, json={"name": "Cheap rephraser", "provider": "openai_compatible", "model_id": "fake-1",
                                                              "base_url": f"http://127.0.0.1:{FAKE_PORT}/v1", "price_in": 0.1, "price_out": 0.2}).json()
    assert client.put("/api/admin/settings", headers=H, json={"rephrase_model_id": 999999}).status_code == 400
    client.put("/api/admin/settings", headers=H, json={"rephrase_model_id": other["id"]})
    try:
        r = client.post("/api/chat/rephrase", headers=H, json={"connection_id": conn, "model_id": model, "question": "top cust"}).json()
        assert r["model_label"] == "Cheap rephraser"                     # the admin's choice, not the question's model
        client.put("/api/admin/settings", headers=H, json={"rephrase_enabled": False})
        assert client.get("/api/chat/options").json() == {"rephrase": False}
        assert client.post("/api/chat/rephrase", headers=H, json={"connection_id": conn, "question": "top cust"}).status_code == 400
    finally:
        client.put("/api/admin/settings", headers=H, json={"rephrase_enabled": True, "rephrase_model_id": 0})
        client.delete(f"/api/admin/models/{other['id']}", headers=H)
    assert client.get("/api/chat/options").json() == {"rephrase": True}

    # another person's chat cannot be used as context
    from tests.test_reports import _login
    u, _ = _login(client, "rephrase.user@test.local")
    cid = ask(client, conn, model, "revenue by category")["conversation"]["id"]
    assert u.post("/api/chat/rephrase", headers=H, json={"connection_id": conn, "model_id": model, "question": "and by region",
                                                         "conversation_id": cid}).status_code == 404
    assert json.dumps(fake_llm.REQUESTS[-1]).count("and by region") == 0


def test_rephrase_prompt_is_a_fraction_of_a_full_prompt_on_a_real_schema(admin):
    """On the SAP sample (30 tables, field dictionary, business rules) a rephrase costs under a quarter of a question."""
    from app import engine
    from app.db import SessionLocal
    from app.models import Connection
    with SessionLocal() as db:
        c = db.query(Connection).filter(Connection.name == "Sample: SAP Sales & Finance").order_by(Connection.id).first()   # the first company's copy
        q = "top customers by revenue in germany last year"
        full = sum(map(len, engine.build_prompt(db, c, q, [], 1000, True)[:2]))
        small = sum(map(len, engine.build_rephrase_prompt(db, c, q, [], engine.similar_questions(db, c.id, q))))
        assert small < full * 0.25, (small, full)
