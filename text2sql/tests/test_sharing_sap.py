"""Shared chats (view / add questions; each viewer sees results with their own access) and the SAP sample data model."""
import json
from pathlib import Path

import pytest

from tests.conftest import H
from tests.test_platform import ask
from tests.test_reports import _login, _regions


@pytest.fixture(scope="module")
def team(admin):
    client, conn, model = admin
    owner, owner_id = _login(client, "owner.share@test.local", name="Olive Owner")
    east, east_id = _login(client, "east.share@test.local", name="Eve East")
    editor, editor_id = _login(client, "editor.share@test.local", name="Ed Editor")
    outsider, _ = _login(client, "outsider.share@test.local", name="Otto Outsider")
    g = client.post("/api/admin/groups", headers=H, json={"name": "Chat readers", "user_ids": [east_id]}).json()["id"]
    f = client.post("/api/admin/filters", headers=H, json={"connection_id": conn, "table_name": "customers",
                                                           "condition": "region = 'East'", "scope": "user", "user_id": east_id}).json()["id"]
    yield {"admin": client, "conn": conn, "model": model, "owner": owner, "owner_id": owner_id, "east": east,
           "editor": editor, "editor_id": editor_id, "outsider": outsider, "group": g}
    client.delete(f"/api/admin/filters/{f}", headers=H)
    client.delete(f"/api/admin/groups/{g}", headers=H)


def test_shared_chat_view_edit_and_own_access(team):
    a, conn, model, owner, east, editor, outsider = (team[k] for k in ("admin", "conn", "model", "owner", "east", "editor", "outsider"))
    out = ask(owner, conn, model, "revenue and orders by region")
    cid = out["conversation"]["id"]
    assert len(_regions(out["run"])) == 4

    # not shared yet: nobody else can open it, not even an administrator
    for u in (east, editor, outsider, a):
        assert u.get(f"/api/chat/conversations/{cid}").status_code == 404
    assert cid not in [c["id"] for c in east.get("/api/chat/conversations").json()]

    # only the owner shares; group -> view, one person -> edit
    assert east.put(f"/api/chat/conversations/{cid}/shares", headers=H, json={"shares": []}).status_code == 404
    r = owner.put(f"/api/chat/conversations/{cid}/shares", headers=H, json={"shares": [
        {"scope": "group", "group_id": team["group"], "can_edit": False},
        {"scope": "user", "user_id": team["editor_id"], "can_edit": True},
        {"scope": "user", "user_id": team["owner_id"], "can_edit": True},        # sharing with yourself is ignored
        {"scope": "role", "role": "superuser"}]})                              # unknown role is ignored
    assert r.json()["count"] == 2
    assert len(owner.get(f"/api/chat/conversations/{cid}/shares").json()) == 2
    mine = next(c for c in owner.get("/api/chat/conversations").json() if c["id"] == cid)
    assert mine["mine"] and mine["shared"]

    # the group member sees it, read-only, with *their* filtered rows - never the owner's stored ones
    listed = next(c for c in east.get("/api/chat/conversations").json() if c["id"] == cid)
    assert not listed["mine"] and not listed["can_edit"] and listed["owner"] == "Olive Owner"
    seen = east.get(f"/api/chat/conversations/{cid}").json()
    run = seen["runs"][0]
    assert run["shared_view"] and run["asked_by"] == "Olive Owner"
    assert _regions(run) == {"East"} and run["context"]["filters"]
    assert "tables" not in run["context"]                  # what was sent to the model stays with the asker
    assert east.post("/api/chat/ask", headers=H, json={"connection_id": conn, "model_id": model, "conversation_id": cid,
                                                       "question": "revenue by category"}).status_code == 403
    assert east.put(f"/api/chat/conversations/{cid}", headers=H, json={"title": "Mine now"}).status_code == 403
    assert east.post(f"/api/chat/runs/{run['id']}/execute", headers=H, json={"sql": "SELECT * FROM customers"}).status_code == 404
    assert east.get(f"/api/chat/runs/{run['id']}/export.xlsx").status_code == 404     # stored rows are the owner's
    assert east.delete(f"/api/chat/conversations/{cid}", headers=H).status_code == 403

    # the editor adds a question to the same chat and may rename it, but not share or delete it
    follow = ask(editor, conn, model, "revenue by category", conversation_id=cid)
    assert follow["conversation"]["id"] == cid and follow["run"]["status"] == "success"
    assert editor.put(f"/api/chat/conversations/{cid}", headers=H, json={"title": "Regional review"}).status_code == 200
    assert editor.put(f"/api/chat/conversations/{cid}/shares", headers=H, json={"shares": []}).status_code == 403
    assert editor.delete(f"/api/chat/conversations/{cid}", headers=H).status_code == 403
    both = owner.get(f"/api/chat/conversations/{cid}").json()
    assert both["title"] == "Regional review" and len(both["runs"]) == 2
    assert both["runs"][1]["asked_by"] == "Ed Editor" and both["runs"][1]["shared_view"]
    assert not both["runs"][0].get("shared_view")           # the owner's own answer, as stored

    # someone without access to the data model learns nothing about the chat's content
    a.put(f"/api/admin/access/{conn}", headers=H, json={"is_active": True, "restricted": True, "user_ids": [team["owner_id"], team["editor_id"]]})
    try:
        blocked = east.get(f"/api/chat/conversations/{cid}").json()
        assert blocked["no_access"] and blocked["runs"] == [] and not blocked["can_edit"]
    finally:
        a.put(f"/api/admin/access/{conn}", headers=H, json={"is_active": True, "restricted": False})

    # un-sharing removes access at once; deleting the chat removes its shares
    owner.put(f"/api/chat/conversations/{cid}/shares", headers=H, json={"shares": []})
    assert east.get(f"/api/chat/conversations/{cid}").status_code == 404
    assert any(e["action"] == "conversation.sharing_changed" for e in a.get("/api/admin/audit?action=conversation.sharing_changed").json()["items"])
    assert owner.delete(f"/api/chat/conversations/{cid}", headers=H).status_code == 200


def test_sap_sample_data_model_and_training(admin):
    client, _, _ = admin
    spec = json.loads((Path(__file__).parent.parent / "sample_data" / "sap_training.json").read_text(encoding="utf-8"))
    sap = next(c for c in client.get("/api/connections").json() if c["name"] == spec["name"])
    assert sap["table_count"] >= 30
    kinds = client.get(f"/api/training/{sap['id']}").json()["counts"]
    assert kinds == {"ddl": len(spec["dictionary"]), "documentation": len(spec["documentation"]), "sql_pair": len(spec["examples"])}

    # every verified example runs on the data and returns rows; SD billing and FI revenue reconcile
    from app import engine
    from app.db import SessionLocal
    from app.deps import get_settings
    from app.models import Connection, User
    with SessionLocal() as db:
        conn, admin_user, cfg = db.get(Connection, sap["id"]), db.query(User).filter(User.role == "admin").first(), get_settings(db)
        for e in spec["examples"]:
            res = engine.run_sql(db, conn, e["sql"], cfg, admin_user)
            assert res["row_count"] > 0, e["question"]
            if "reconcile" in e["question"]:
                diff = [c["name"] for c in res["columns"]].index("difference")
                assert all(abs(r[diff]) < 0.01 for r in res["rows"])
        fc = next(e for e in spec["examples"] if e.get("analysis"))
        res = engine.run_sql(db, conn, fc["sql"], cfg, admin_user, fc["analysis"])
        assert res["analysis"]["result"]["metrics"], res["analysis"]

    # added once per installation: a restart does not duplicate it, and a deleted sample does not come back
    from app.main import add_sample_model
    add_sample_model("sap_training.json", 1)
    assert sum(c["name"] == spec["name"] for c in client.get("/api/connections").json()) == 1
