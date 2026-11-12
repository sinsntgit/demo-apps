"""Row-level data filters, custom reports (access, live refresh, PDF, schedule + email), summaries."""
import datetime as dt
import io

import pytest

from tests.conftest import H
from tests.test_platform import ask

SMTP_PORT = 8792


def _login(client, email, role="analyst", name=""):
    from fastapi.testclient import TestClient
    from app.main import app
    made = client.post("/api/admin/users", headers=H, json={"email": email, "role": role, "name": name}).json()
    u = TestClient(app)
    u.post("/api/auth/login", headers=H, json={"email": email, "password": made["temporary_password"]})
    u.post("/api/auth/change-password", headers=H, json={"current": made["temporary_password"], "new": "Report-Passw0rd"})
    return u, made["id"]


@pytest.fixture(scope="module")
def people(admin):
    client, conn, model = admin
    north, north_id = _login(client, "north@test.local", name="Nia North")
    south, south_id = _login(client, "south@test.local", name="Sam South")
    return {"admin": client, "conn": conn, "model": model, "north": north, "north_id": north_id,
            "south": south, "south_id": south_id}


def _regions(run):
    i = [c["name"] for c in run["columns"]].index("region")
    return {r[i] for r in run["rows"]}


def test_filters_are_validated_and_enforced(people):
    a, conn, model = people["admin"], people["conn"], people["model"]
    new = lambda **kw: a.post("/api/admin/filters", headers=H, json={"connection_id": conn, "table_name": "customers", **kw})   # noqa: E731
    assert new(condition="region = 'North'; DROP TABLE x").status_code == 400
    assert new(condition="region IN (SELECT region FROM customers)").status_code == 400
    assert new(condition="region = {nope}").status_code == 400
    assert new(condition="region = 'North'", scope="role", role="admin").status_code == 400
    f1 = new(condition="region = 'North'", scope="user", user_id=people["north_id"], description="North team").json()["id"]
    f2 = new(condition="region = 'South'", scope="user", user_id=people["south_id"]).json()["id"]

    q = "revenue and orders by region"
    assert _regions(ask(people["north"], conn, model, q)["run"]) == {"North"}
    assert _regions(ask(people["south"], conn, model, q)["run"]) == {"South"}
    assert len(_regions(ask(a, conn, model, q)["run"])) == 4                      # administrators are not filtered

    # hand-written SQL cannot get round it: aliases, sub-queries, a CTE reusing the table's name
    run = ask(people["north"], conn, model, "anything", review_first=True)["run"]
    go = lambda sql: people["north"].post(f"/api/chat/runs/{run['id']}/execute", headers=H, json={"sql": sql}).json()   # noqa: E731
    assert go("SELECT DISTINCT x.region FROM customers AS x")["rows"] == [["North"]]
    assert go("SELECT region FROM (SELECT * FROM customers) t GROUP BY 1")["rows"] == [["North"]]
    assert go("SELECT count(*) FROM orders o WHERE o.customer_id IN (SELECT customer_id FROM customers WHERE region = 'South')")["rows"] == [[0]]
    assert go("WITH customers AS (SELECT 1 AS region) SELECT * FROM customers")["status"] == "blocked"
    done = go("SELECT DISTINCT region FROM customers")
    assert done["context"]["filters"] == [f1] and "North" not in done["final_sql"]    # shown SQL stays as written

    # role-wide filter using the signed-in user's own attributes, combined (AND) with the user filter
    f3 = new(condition="lower(email) <> lower({user_email}) AND segment = 'Enterprise'", scope="role", role="analyst").json()["id"]
    assert go("SELECT DISTINCT region, segment FROM customers")["rows"] == [["North", "Enterprise"]]
    a.put(f"/api/admin/filters/{f3}", headers=H, json={"connection_id": conn, "table_name": "customers",
                                                        "condition": "segment = 'Enterprise'", "scope": "role",
                                                        "role": "analyst", "enabled": False})
    assert len(go("SELECT DISTINCT segment FROM customers")["rows"]) == 3
    people["filters"] = [f1, f2, f3]


def test_report_lifecycle_sharing_and_live_refresh(people):
    a, conn, model, north, south = (people[k] for k in ("admin", "conn", "model", "north", "south"))
    r1 = ask(north, conn, model, "revenue and orders by region")["run"]
    r2 = ask(north, conn, model, "What is revenue by month?")["run"]
    theirs = ask(south, conn, model, "revenue by category")["run"]

    comps = [{"type": "heading", "text": "Regional review for {{viewer}}", "level": 1},
             {"type": "text", "text": "Prepared {{date}}. {{summary:1}} Rows: {{rows:1}}."},
             {"type": "result", "run_id": r1["id"], "title": "By region", "chart": {"type": "bar", "x": "region", "y": ["revenue", "orders"]},
              "sql": "SELECT * FROM customers"},                       # client-supplied SQL must be ignored
             {"type": "pagebreak"},
             {"type": "result", "run_id": r2["id"], "table_rows": 5}]
    rep = north.post("/api/reports", headers=H, json={"title": "Regional pack", "header_text": "Confidential · {{title}}",
                                                       "footer_text": "AskData", "components": comps}).json()
    rid = rep["id"]
    assert rep["results"] == 2 and all("sql" not in c for c in rep["components"])
    assert north.post("/api/reports", headers=H, json={"title": "x", "components": [{"type": "result", "run_id": theirs["id"]}]}).status_code == 400

    out = north.get(f"/api/reports/{rid}/render").json()
    first = next(c for c in out["components"] if c["type"] == "result")
    assert first["status"] == "ok" and first["filtered"] and {r[0] for r in first["rows"]} == {"North"}
    assert "revenue" in first["sql"].lower() and "customers" in first["sql"] and "SELECT * FROM customers" != first["sql"]
    assert out["components"][0]["text"] == "Regional review for Nia North"
    assert "{{" not in out["components"][1]["text"] and "Rows: 1." in out["components"][1]["text"]
    assert out["header_text"] == "Confidential · Regional pack"

    # private until shared; then each viewer sees their own slice of the data
    assert south.get(f"/api/reports/{rid}").status_code == 404
    north.put(f"/api/reports/{rid}/shares", headers=H, json={"shares": [{"scope": "user", "user_id": people["south_id"]}]})
    seen = south.get(f"/api/reports/{rid}/render").json()
    assert {r[0] for r in next(c for c in seen["components"] if c["type"] == "result")["rows"]} == {"South"}
    assert seen["components"][0]["text"].endswith("Sam South")
    assert south.put(f"/api/reports/{rid}", headers=H, json={"title": "Hacked", "components": []}).status_code == 403
    assert south.put(f"/api/reports/{rid}/schedule", headers=H, json={"enabled": True}).status_code == 403
    assert south.get(f"/api/reports/{rid}/snapshots").status_code == 403
    assert south.delete(f"/api/reports/{rid}", headers=H).status_code == 403
    assert [r["title"] for r in south.get("/api/reports").json()] == ["Regional pack"]

    # can-edit share: may add their own results; existing components keep their stored SQL
    north.put(f"/api/reports/{rid}/shares", headers=H, json={"shares": [{"scope": "role", "role": "analyst", "can_edit": True}]})
    assert south.post(f"/api/reports/{rid}/components", headers=H, json={"run_id": theirs["id"]}).status_code == 200
    assert south.post(f"/api/reports/{rid}/components", headers=H, json={"run_id": r1["id"]}).status_code == 400
    assert north.get(f"/api/reports/{rid}").json()["results"] == 3

    # data-model access is honoured per viewer: restrict the model and the shared viewer loses the data, not the report
    c = next(x for x in a.get("/api/admin/access").json()["connections"] if x["id"] == conn)
    a.put(f"/api/admin/access/{conn}", headers=H, json={"is_active": True, "restricted": True, "user_ids": [people["north_id"]]})
    blocked = south.get(f"/api/reports/{rid}/render").json()
    assert {x["status"] for x in blocked["components"] if x["type"] == "result"} == {"no_access"}
    assert all("sql" not in x and "rows" not in x for x in blocked["components"] if x["type"] == "result")
    assert conn not in [x["id"] for x in south.get("/api/connections").json()]
    a.put(f"/api/admin/access/{conn}", headers=H, json={"is_active": False, "restricted": False, "user_ids": []})
    assert conn not in [x["id"] for x in north.get("/api/connections").json()]         # disabled for everyone but admins
    a.put(f"/api/admin/access/{conn}", headers=H, json={"is_active": c["is_active"], "restricted": False, "user_ids": []})

    pdf = north.get(f"/api/reports/{rid}/pdf")
    assert pdf.status_code == 200 and pdf.content[:5] == b"%PDF-"
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(pdf.content))
    text = " ".join(p.extract_text() for p in reader.pages)
    assert len(reader.pages) >= 2 and "Regional review for Nia North" in text and "Confidential" in text
    assert "Page 1 of" in text and "By region" in text and "North" in text and "South" not in text.replace("Sam South", "")
    assert sum(len(p.images) for p in reader.pages) >= 3            # region chart split into two panels + month chart
    people["report"] = rid


def test_senders_groups_schedule_and_email(people):
    from aiosmtpd.controller import Controller
    from app import reporting
    from app.db import SessionLocal
    from app.models import Report

    inbox = []

    class Sink:
        async def handle_DATA(self, server, session, envelope):
            inbox.append(envelope)
            return "250 OK"

    a, north, south, rid = people["admin"], people["north"], people["south"], people["report"]

    # --- email senders: validation, verify, test send, simulation, default
    new = lambda **kw: a.post("/api/admin/senders", headers=H, json={"label": "Reports mailbox", "from_email": "reports@test.local", **kw})   # noqa: E731
    assert new(mode="smtp", host="").status_code == 400
    assert north.get("/api/admin/senders").status_code == 403
    real = new(from_name="AskData Reports", reply_to="help@test.local", host="127.0.0.1", port=SMTP_PORT, password="s3cret").json()
    assert real["is_default"] and real["has_password"] and "password" not in real
    sim = new(label="Demo (simulation)", mode="simulate").json()
    down = a.post(f"/api/admin/senders/{real['id']}/verify", headers=H).json()
    assert not down["ok"] and "Could not connect" in down["message"]
    assert a.get("/api/admin/senders").json()[0]["last_error"]

    # --- user groups
    g = a.post("/api/admin/groups", headers=H, json={"name": "Regional leads", "user_ids": [people["north_id"], people["south_id"]]}).json()["id"]
    assert a.post("/api/admin/groups", headers=H, json={"name": "regional LEADS"}).status_code == 400
    assert north.get("/api/admin/groups").status_code == 403
    directory = north.get("/api/reports/people").json()
    assert directory["groups"] == [{"id": g, "name": "Regional leads", "description": "", "members": 2}]
    assert [x["label"] for x in directory["senders"]] == ["Reports mailbox <reports@test.local>", "Demo (simulation) <reports@test.local>"]

    # share with the group: members get in, and lose access when removed from it
    north.put(f"/api/reports/{rid}/shares", headers=H, json={"shares": [{"scope": "group", "group_id": g}]})
    assert south.get(f"/api/reports/{rid}").status_code == 200
    a.put(f"/api/admin/groups/{g}", headers=H, json={"name": "Regional leads", "user_ids": [people["north_id"]]})
    assert south.get(f"/api/reports/{rid}").status_code == 404
    a.put(f"/api/admin/groups/{g}", headers=H, json={"name": "Regional leads", "user_ids": [people["north_id"], people["south_id"]]})

    # --- schedule to a group + a named person + outside addresses
    assert north.put(f"/api/reports/{rid}/schedule", headers=H, json={"enabled": True, "frequency": "hourly"}).status_code == 400
    assert north.put(f"/api/reports/{rid}/schedule", headers=H, json={"enabled": True, "recipients": ["nope"]}).status_code == 400
    s = north.put(f"/api/reports/{rid}/schedule", headers=H, json={
        "enabled": True, "frequency": "weekly", "weekday": 0, "time": "08:30", "tz": "Asia/Kolkata", "sender_id": real["id"],
        "group_ids": [g], "user_ids": [people["south_id"]], "recipients": ["boss@test.local", "board@test.local"]}).json()
    nxt = dt.datetime.fromisoformat(s["next_run_at"])
    assert (nxt.hour, nxt.minute) == (3, 0) and nxt.weekday() == 0 and s["recipient_count"] == 4      # 08:30 IST = 03:00 UTC

    base = dt.datetime(2026, 11, 12, 10, 0)             # a Thursday, UTC
    assert reporting.next_run({"enabled": True, "frequency": "daily", "time": "09:00", "tz": "UTC"}, base) == dt.datetime(2026, 11, 13, 9, 0)
    assert reporting.next_run({"enabled": True, "frequency": "daily", "time": "11:00", "tz": "UTC"}, base) == dt.datetime(2026, 11, 12, 11, 0)
    assert reporting.next_run({"enabled": True, "frequency": "weekdays", "time": "09:00", "tz": "UTC"}, base + dt.timedelta(days=1)) == dt.datetime(2026, 11, 16, 9, 0)
    assert reporting.next_run({"enabled": True, "frequency": "monthly", "monthday": 1, "time": "06:00", "tz": "UTC"}, base) == dt.datetime(2026, 12, 1, 6, 0)
    assert reporting.next_run({"enabled": False}, base) is None

    server = Controller(Sink(), hostname="127.0.0.1", port=SMTP_PORT)
    server.start()
    try:
        assert a.post(f"/api/admin/senders/{real['id']}/verify", headers=H).json()["ok"]
        t = a.post(f"/api/admin/senders/{real['id']}/test", headers=H, json={"to": "me@test.local, you@test.local"}).json()
        assert t["ok"] and not t["simulated"]
        t = a.post(f"/api/admin/senders/{sim['id']}/test", headers=H, json={"to": "me@test.local"}).json()
        assert t["ok"] and t["simulated"]
        with SessionLocal() as db:                       # make it due, then let the scheduler tick
            db.get(Report, rid).next_run_at = dt.datetime.utcnow() - dt.timedelta(minutes=1)
            db.commit()
        assert reporting.run_due() == 1
        assert reporting.run_due() == 0                  # claimed: does not fire twice
    finally:
        server.stop()

    assert [e.rcpt_tos for e in inbox] == [["me@test.local", "you@test.local"], ["north@test.local"], ["south@test.local"],
                                           ["boss@test.local", "board@test.local"]]
    head = inbox[1].content.decode(errors="replace")
    assert "AskData Reports <reports@test.local>" in head and "Reply-To: help@test.local" in head and "application/pdf" in head

    # each person with an account received the report as *they* are allowed to see it
    import base64
    import email
    from pypdf import PdfReader

    def pdf_text(envelope):
        part = next(p for p in email.message_from_bytes(envelope.content).walk() if p.get_content_type() == "application/pdf")
        return " ".join(pg.extract_text() for pg in PdfReader(io.BytesIO(base64.b64decode(part.get_payload()))).pages)
    to_north, to_south, to_others = pdf_text(inbox[1]), pdf_text(inbox[2]), pdf_text(inbox[3])
    assert "Nia North" in to_north and "848,515.46" in to_north and "856,702.39" not in to_north
    assert "Sam South" in to_south and "856,702.39" in to_south and "848,515.46" not in to_south
    assert "Nia North" in to_others and "848,515.46" in to_others          # outside addresses get the owner's view

    snaps = north.get(f"/api/reports/{rid}/snapshots").json()
    assert len(snaps) == 1 and snaps[0]["status"] == "ok" and len(snaps[0]["emailed_to"]) == 4
    assert north.get(f"/api/reports/{rid}/snapshots/{snaps[0]['id']}/pdf").content[:5] == b"%PDF-"
    log = a.get("/api/admin/email-log").json()
    assert [x["status"] for x in log].count("sent") == 6 and [x["status"] for x in log].count("simulated") == 1
    assert log[0]["context"] == "report: Regional pack"

    # mail server down: the copy is still saved, the reason is recorded and logged
    manual = north.post(f"/api/reports/{rid}/snapshots", headers=H, json={"send": True}).json()
    assert manual["status"] == "ok" and "Not emailed to everyone" in manual["note"] and manual["emailed_to"] == []
    assert a.get("/api/admin/email-log").json()[0]["status"] == "failed"
    # simulation sender: reported as such, nothing leaves
    north.put(f"/api/reports/{rid}/schedule", headers=H, json={"enabled": True, "sender_id": sim["id"], "recipients": ["boss@test.local"]})
    assert "simulation" in north.post(f"/api/reports/{rid}/snapshots", headers=H, json={"send": True}).json()["note"]
    # deleting the group removes its shares
    a.delete(f"/api/admin/groups/{g}", headers=H)
    assert south.get(f"/api/reports/{rid}").status_code == 404

    assert north.delete(f"/api/reports/{rid}", headers=H).status_code == 200
    assert north.get("/api/reports").json() == []
    for f in people["filters"]:
        a.delete(f"/api/admin/filters/{f}", headers=H)
    for x in (real, sim):
        a.delete(f"/api/admin/senders/{x['id']}", headers=H)


def test_side_by_side_layout_in_pdf(admin):
    """Components given half / third width sit next to each other on the page."""
    from pypdf import PdfReader
    client, conn, model = admin
    r1 = ask(client, conn, model, "revenue and orders by region")["run"]
    r2 = ask(client, conn, model, "revenue by category")["run"]
    comps = [{"type": "heading", "text": "Side by side", "level": 1},
             {"type": "result", "run_id": r1["id"], "title": "LEFTBLOCK", "width": 3, "show_table": False},
             {"type": "result", "run_id": r2["id"], "title": "RIGHTBLOCK", "width": 3, "show_table": False},
             {"type": "text", "text": "THIRD-A", "width": 2}, {"type": "text", "text": "THIRD-B", "width": 2},
             {"type": "text", "text": "THIRD-C", "width": 2}, {"type": "text", "text": "FULLWIDTH", "width": 99}]
    rep = client.post("/api/reports", headers=H, json={"title": "Layout", "components": comps}).json()
    assert [c.get("width") for c in rep["components"]] == [6, 3, 3, 2, 2, 2, 6]         # invalid width falls back to full
    data = client.get(f"/api/reports/{rep['id']}/pdf").content
    page = PdfReader(io.BytesIO(data)).pages[0]
    import pypdfium2
    doc = pypdfium2.PdfDocument(data)
    text = doc[0].get_textpage()
    where = {}
    for key in ("LEFTBLOCK", "RIGHTBLOCK", "THIRD-A", "THIRD-B", "THIRD-C", "FULLWIDTH"):
        hit = text.search(key).get_next()
        if hit:
            left, bottom, _, _ = text.get_charbox(hit[0])
            where[key] = (left, bottom)             # PDF coordinates: y grows upwards
    assert len(where) == 6, where
    assert abs(where["LEFTBLOCK"][1] - where["RIGHTBLOCK"][1]) < 2 and where["RIGHTBLOCK"][0] > where["LEFTBLOCK"][0] + 200
    assert where["THIRD-A"][0] < where["THIRD-B"][0] < where["THIRD-C"][0]
    assert abs(where["THIRD-A"][1] - where["THIRD-C"][1]) < 2 and where["THIRD-A"][1] < where["LEFTBLOCK"][1] - 100
    assert where["FULLWIDTH"][1] < where["THIRD-A"][1] and abs(where["FULLWIDTH"][0] - where["THIRD-A"][0]) < 2
    assert len(page.images) == 2              # one chart in each half
    client.delete(f"/api/reports/{rep['id']}", headers=H)


def test_upgrade_adds_new_columns_and_migrates_mail_settings(tmp_path):
    """An older database gains the new columns in place; the old single mail-server setting becomes a sender."""
    import sqlite3
    import subprocess
    import sys
    db = tmp_path / "text2sql.db"
    con = sqlite3.connect(db)
    con.executescript("""
        CREATE TABLE report_shares (id INTEGER PRIMARY KEY, report_id INTEGER, scope VARCHAR(10), user_id INTEGER, role VARCHAR(20), can_edit BOOLEAN);
        CREATE TABLE settings (key VARCHAR(100) PRIMARY KEY, value JSON);
        INSERT INTO settings VALUES ('smtp_host', '{"v": "smtp.old.example"}'), ('smtp_from', '{"v": "old@example.com"}'), ('smtp_port', '{"v": 465}'), ('smtp_security', '{"v": "ssl"}');
        INSERT INTO report_shares VALUES (1, 1, 'role', NULL, 'analyst', 0);
    """)
    con.commit()
    con.close()
    code = ("from app.main import bootstrap; bootstrap(); import sqlite3; c = sqlite3.connect(r'%s');"
            "print([r[1] for r in c.execute('pragma table_info(report_shares)')]);"
            "print(c.execute('select label, host, port, secure, from_email, is_default from email_senders').fetchall());"
            "print(c.execute('select count(*) from report_shares').fetchone())") % db
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=".",
                         env={**__import__("os").environ, "T2S_DATA_DIR": str(tmp_path), "T2S_ADMIN_PASSWORD": "Upgrade-Passw0rd"})
    assert out.returncode == 0, out.stderr[-600:]
    assert "'group_id'" in out.stdout and "('Default sender', 'smtp.old.example', 465, 1, 'old@example.com', 1)" in out.stdout
    assert "(1,)" in out.stdout


def test_summary_explains_each_shape():
    from app.connectors import _package
    from app.summarize import summarize

    def s(names, rows):
        r = _package(names, rows, 1000, 1)
        return summarize(r["columns"], r["rows"], False)

    trend = s(["month", "revenue"], [("2025-01", 100.0), ("2025-02", 150.0), ("2025-03", 300.0), ("2025-04", 90.0)])
    assert trend["shape"] == "trend" and "from 2025-01 to 2025-04" in trend["headline"]
    text = " ".join(trend["bullets"])
    assert "totals 640" in text and "Highest in 2025-03 (300)" in text and "down 70%" in text and "complete" in text

    rank = s(["category", "revenue", "avg_price"], [("A", 600.0, 10.0), ("B", 300.0, 30.0), ("C", 100.0, 20.0)])
    text = " ".join(rank["bullets"])
    assert rank["shape"] == "ranking" and "A has the highest revenue at 600 — 60% of the 1,000 total" in text
    assert "Avg price averages 20" in text and "avg price at" not in text          # averages are never totalled
    assert next(x for x in rank["stats"] if x["column"] == "avg_price").get("sum") is None

    cross = s(["channel", "category", "revenue"], [("Web", "A", 5.0), ("Web", "B", 7.0), ("Shop", "A", 1.0), ("Shop", "B", 2.0)])
    assert cross["shape"] == "cross" and "Biggest single combination: Web / B at 7" in " ".join(cross["bullets"])

    pivot = s(["product_id", "product", "2025-01", "2025-02", "2025-03", "2025-04", "2025-05"],
              [(1, "Pen", 1.0, 2.0, 3.0, 4.0, 5.0), (2, "Ink", 10.0, 0.0, 10.0, 10.0, 20.0)])
    text = " ".join(pivot["bullets"])
    assert pivot["shape"] == "pivot" and "2 products (rows) by 5 columns" in pivot["headline"]
    assert "Largest row: Ink with 50" in text and "Highest column: 2025-05 (25)" in text and "product_id" not in text

    years = s(["order_year", "orders"], [(2023, 10), (2024, 15)])
    assert years["shape"] == "trend" and "from 2023 to 2024" in years["headline"] and "2,023" not in str(years)

    listing = s(["customer_id", "name", "city"], [(1, "a", "X"), (2, "b", "X"), (3, "c", "Y")])
    assert listing["shape"] == "listing" and "nothing numeric to total" in listing["headline"]
    assert "2 distinct cities; most frequent: X (2)" in " ".join(listing["bullets"])

    assert "no rows" in s(["a"], [])["headline"]
