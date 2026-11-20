"""Builds the demo environment the video is recorded in (run after demo/stack.sh start).

Everything here goes through the app's own HTTP API, as an administrator would, except for spreading the
timestamps of the history over the last two weeks (a direct SQLite update) so that the chat list and the
dashboard look like a product that has been in use for a while.

Writes demo/out/state.json (ids, passwords) and demo/out/admin.storage.json (a signed-in browser session).
"""
import base64
import datetime as dt
import io
import json
import random
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import pyotp
import requests

BASE = "http://localhost:8010"
OUT = Path(__file__).parent / "out"
RETAIL = Path(__file__).parent.parent / "sample_data" / "retail"
ADMIN = ("admin@acme.example", "Demo-Passw0rd!")
PEOPLE = [  # name, email, role
    ("Priya Nair", "priya.nair@acme.example", "steward"),
    ("Tom Becker", "tom.becker@acme.example", "analyst"),
    ("Lena Okafor", "lena.okafor@acme.example", "analyst"),
    ("Sam Rivera", "sam.rivera@acme.example", "analyst"),
    ("Dana Cho", "dana.cho@acme.example", "analyst"),
    ("Maya Brooks", "maya.brooks@acme.example", "analyst", False),    # sees results only - no SQL, no code
]
USER_PW = "Demo-Passw0rd-1"
random.seed(11)


class Client:
    def __init__(self):
        self.s = requests.Session()
        self.s.headers["X-Requested-With"] = "fetch"

    def call(self, method, path, ok=(200,), **kw):
        r = self.s.request(method, BASE + path, **kw)
        if r.status_code not in ok:
            raise SystemExit(f"{method} {path} -> {r.status_code} {r.text[:300]}")
        return r.json() if r.headers.get("content-type", "").startswith("application/json") else r.text

    get = lambda self, p, **k: self.call("GET", p, **k)          # noqa: E731
    post = lambda self, p, body=None, **k: self.call("POST", p, json=body, **k)   # noqa: E731
    put = lambda self, p, body=None, **k: self.call("PUT", p, json=body, **k)     # noqa: E731


def login(email, pw):
    c = Client()
    c.post("/api/auth/login", {"email": email, "password": pw})
    return c


def main():
    admin = login(*ADMIN)
    state = {"admin": ADMIN[0], "admin_password": ADMIN[1], "user_password": USER_PW}

    # ---------------------------------------------------------------- AI models
    fast = admin.post("/api/admin/models", {"name": "Fast model", "provider": "openai_compatible", "model_id": "fake-1",
                                            "base_url": "http://127.0.0.1:8765/v1", "is_default": True, "price_in": 0.5, "price_out": 2.5})
    deep = admin.post("/api/admin/models", {"name": "Accurate model", "provider": "openai_compatible", "model_id": "fake-2",
                                            "base_url": "http://127.0.0.1:8765/v1", "price_in": 4, "price_out": 20})
    models = [fast["id"], deep["id"]]

    # ---------------------------------------------------------------- users and groups
    ids = {}
    for name, email, role, *rest in PEOPLE:
        made = admin.post("/api/admin/users", {"email": email, "name": name, "role": role, "show_sql": rest[0] if rest else True})
        u = Client()
        u.post("/api/auth/login", {"email": email, "password": made["temporary_password"]})
        u.post("/api/auth/change-password", {"current": made["temporary_password"], "new": USER_PW})
        ids[email] = made["id"]
    north = admin.post("/api/admin/groups", {"name": "North sales team", "description": "Account managers covering the North region",
                                             "user_ids": [ids["tom.becker@acme.example"], ids["lena.okafor@acme.example"]]})["id"]
    finance = admin.post("/api/admin/groups", {"name": "Finance", "description": "Finance and FP&A",
                                               "user_ids": [ids["priya.nair@acme.example"], ids["dana.cho@acme.example"]]})["id"]
    leads = admin.post("/api/admin/groups", {"name": "Sales leadership", "description": "Regional heads and the CRO",
                                             "user_ids": [ids["priya.nair@acme.example"], ids["sam.rivera@acme.example"]]})["id"]
    state.update(north=north, finance=finance, leads=leads, users=ids)

    # ---------------------------------------------------------------- data models
    conns = {c["name"]: c for c in admin.get("/api/connections")}
    retail = conns["Sample: Retail sales"]
    retail.update(name="Retail sales (CSV files)", description="Orders, customers and products exported from the shop system.",
                  masked_columns=["email"])
    admin.put(f"/api/connections/{retail['id']}", {k: retail[k] for k in
              ("name", "description", "db_type", "is_active", "restricted", "allow_samples", "sample_columns", "masked_columns")} | {"config": {}})
    # extra tables in the CSV data model, used by the predictive scenes (synthetic: demo/make_data.py)
    subprocess.run([sys.executable, str(Path(__file__).parent / "make_data.py")], check=True)
    sets = [("uploads", (n, (OUT / "data_sets" / n).read_bytes(), "text/csv")) for n in ("monthly_revenue.csv", "daily_revenue.csv", "customer_rfm.csv")]
    admin.s.post(f"{BASE}/api/connections/{retail['id']}/files", files=sets).raise_for_status()
    admin.post(f"/api/connections/{retail['id']}/sync")
    pg = admin.post("/api/connections", {
        "name": "Sales warehouse (PostgreSQL)", "db_type": "postgres", "description": "The same sales data in the production warehouse.",
        "config": {"host": "127.0.0.1", "port": "5544", "database": "warehouse", "username": "askdata_ro", "password": "readonly-demo"},
        "masked_columns": ["email"]})
    admin.post(f"/api/connections/{pg['id']}/sync")

    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Budget"
    ws.append(["Department", "Quarter", "Category", "Amount"])
    for dept, base in (("Sales", 410), ("Marketing", 260), ("Operations", 340), ("Engineering", 520), ("Finance", 150)):
        for q in ("Q1", "Q2", "Q3", "Q4"):
            for cat, share in (("Salaries", .62), ("Software", .14), ("Travel", .12), ("Events", .12)):
                ws.append([dept, q, cat, round(base * share * 1000 * random.uniform(.85, 1.2) / 4, 2)])
    buf = io.BytesIO()
    wb.save(buf)
    fin = admin.post("/api/connections", {"name": "Finance workbook (Excel)", "db_type": "files", "restricted": True,
                                          "description": "Annual budget by department - Excel files in a shared folder.", "config": {}})
    admin.s.post(f"{BASE}/api/connections/{fin['id']}/files", files=[("uploads", ("Budget 2025.xlsx", buf.getvalue()))]).raise_for_status()
    admin.post(f"/api/connections/{fin['id']}/sync")
    admin.put(f"/api/admin/access/{fin['id']}", {"is_active": True, "restricted": True, "group_ids": [finance]})
    admin.post("/api/admin/filters", {"connection_id": retail["id"], "table_name": "customers", "condition": "region = 'North'",
                                      "scope": "group", "group_id": north, "description": "North sales team only sees North customers"})
    admin.post("/api/admin/filters", {"connection_id": pg["id"], "table_name": "customers", "condition": "region = 'North'",
                                      "scope": "group", "group_id": north, "description": "North sales team only sees North customers"})
    state.update(retail=retail["id"], pg=pg["id"], fin=fin["id"], fast=fast["id"], deep=deep["id"])

    # ---------------------------------------------------------------- companies: logo for ours, a second company, a shared AI model
    from PIL import Image, ImageDraw, ImageFont
    logo = Image.new("RGB", (420, 120), "#14213d")
    d = ImageDraw.Draw(logo)
    d.rounded_rectangle((18, 18, 102, 102), 18, fill="#2a78d6")
    d.text((60, 60), "A", fill="white", anchor="mm", font=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 56))
    d.text((124, 60), "ACME", fill="white", anchor="lm", font=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 54))
    (OUT / "data_sets").mkdir(parents=True, exist_ok=True)
    logo_png = OUT / "data_sets" / "acme-logo.png"
    logo.save(logo_png)
    g = Image.new("RGB", (420, 120), "#0f6b63")        # a logo for the company the video adds on camera
    gd = ImageDraw.Draw(g)
    gd.ellipse((18, 18, 102, 102), fill="#ffb020")
    gd.text((124, 60), "GLOBEX", fill="white", anchor="lm", font=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 54))
    g.save(OUT / "data_sets" / "globex-logo.png")
    mine = next(c for c in admin.get("/api/admin/companies") if c["is_mine"])
    admin.s.post(f"{BASE}/api/admin/companies/{mine['id']}/logo", files={"upload": ("acme-logo.png", logo_png.read_bytes(), "image/png")}).raise_for_status()
    fixtures = Path(__file__).parent.parent / "tests" / "e2e" / "fixtures"
    shared = admin.post("/api/admin/models", {"name": "Group model (shared)", "provider": "openai_compatible", "model_id": "fake-1",
                                              "base_url": "http://127.0.0.1:8765/v1", "scope": "platform", "price_in": 3, "price_out": 15})
    nw = admin.post("/api/admin/companies", {"name": "Northwind Traders", "admin_email": "maria.anders@northwind.example",
                                             "admin_name": "Maria Anders", "samples": True})
    maria = Client()
    maria.post("/api/auth/login", {"email": "maria.anders@northwind.example", "password": nw["temporary_password"]})
    maria.post("/api/auth/change-password", {"current": nw["temporary_password"], "new": USER_PW})
    admin.s.post(f"{BASE}/api/admin/companies/{nw['id']}/logo", files={"upload": ("northwind-logo.png", (fixtures / "northwind-logo.png").read_bytes(), "image/png")}).raise_for_status()
    admin.s.post(f"{BASE}/api/admin/companies/{nw['id']}/template", files={"upload": ("corporate-template.potx", (fixtures / "corporate-template.potx").read_bytes())}).raise_for_status()
    admin.put(f"/api/admin/models/{shared['id']}/sharing", {"share_all": False, "company_ids": [nw["id"]]})
    state.update(shared_model=shared["id"], northwind=nw["id"], northwind_admin="maria.anders@northwind.example", own_company=mine["id"])

    # ---------------------------------------------------------------- email sender (talks to the local mail sink)
    sender = admin.post("/api/admin/senders", {"label": "Reports mailbox", "from_name": "AskData Reports", "from_email": "reports@acme.example",
                                               "reply_to": "analytics@acme.example", "mode": "smtp", "host": "smtp.demo-mail.test", "port": 2525,
                                               "secure": False, "username": "", "password": "", "is_default": True})
    admin.post(f"/api/admin/senders/{sender['id']}/verify")
    admin.put("/api/admin/settings", {"public_url": "https://askdata.acme.example", "rate_limit_per_min": 600, "rephrase_model_id": fast["id"]})

    # ---------------------------------------------------------------- training for each data model
    admin.post(f"/api/training/{retail['id']}", {"kind": "documentation", "title": "Planning tables",
               "content": "monthly_revenue: company revenue per month in US dollars. daily_revenue: company revenue per day. "
                          "customer_rfm: one row per customer with recency_days (days since the last order), orders_12m and revenue_12m (last twelve months)."})
    for conn_id in (retail["id"], pg["id"]):
        admin.post(f"/api/training/{conn_id}", {"kind": "documentation", "title": "Active customer",
                   "content": "An active customer has at least one completed order in the last 90 days."})
        admin.post(f"/api/training/{conn_id}", {"kind": "documentation", "title": "Order statuses",
                   "content": "completed = paid and delivered. returned = sent back and refunded. cancelled = never shipped. pending = awaiting payment. "
                              "Only completed orders count as revenue."})
        admin.post(f"/api/training/{conn_id}", {"kind": "documentation", "title": "Regions",
                   "content": "Customers belong to one of four sales regions: North, South, East and West. Region is stored on the customer, not on the order."})
        admin.post(f"/api/training/{conn_id}", {"kind": "sql_pair", "question": "How many orders do we have by status?",
                   "sql": "SELECT status, COUNT(*) AS orders FROM orders GROUP BY status ORDER BY orders DESC"})
        admin.post(f"/api/training/{conn_id}", {"kind": "sql_pair", "question": "Who are our top 10 customers by revenue?",
                   "sql": "SELECT c.customer_name, ROUND(SUM(oi.quantity * oi.unit_price * (1 - oi.discount)), 2) AS revenue\n"
                          "FROM order_items oi JOIN orders o ON o.order_id = oi.order_id JOIN customers c ON c.customer_id = o.customer_id\n"
                          "WHERE o.status = 'completed' GROUP BY c.customer_name ORDER BY revenue DESC LIMIT 10"})
    glossary = ("KPI glossary\n\nAOV (average order value) is revenue divided by the number of completed orders.\n\n"
                "Net revenue is quantity x unit price x (1 - discount) on completed orders. Refunds for returned orders are excluded.\n\n"
                "Repeat customer: a customer with two or more completed orders.\n\nChurn is not tracked for this data set.\n")
    admin.s.post(f"{BASE}/api/training/{retail['id']}/upload", files={"upload": ("KPI glossary.md", glossary.encode(), "text/markdown")}).raise_for_status()
    admin.post(f"/api/training/{fin['id']}", {"kind": "documentation", "title": "Budget workbook",
               "content": "Budget 2025 has one row per department, quarter and cost category. Amount is the approved budget in US dollars."})

    # ---------------------------------------------------------------- history (as several people, across two weeks)
    users = {e: login(e, USER_PW) for _, e, *_ in PEOPLE}
    asked = []        # (client, run, conn)

    def ask(c, conn, q, model=None, predictive=False, conv=None, review=False):
        out = c.post("/api/chat/ask", {"connection_id": conn, "model_id": model or random.choice(models), "question": q,
                                       "predictive": predictive, "conversation_id": conv, "review_first": review})
        asked.append((c, out["run"], conn))
        return out

    Q = ["What is revenue by month?", "Who are our top customers by revenue?", "How does revenue split by region?",
         "Show revenue by channel and category", "How many orders do we have by status?", "What is revenue by category?"]
    P = ["Forecast revenue for the next 6 months", "Segment our customers", "What drives order value?",
         "Any unusual days in revenue?", "Which orders are likely to be returned?"]
    for day in range(14):
        for _ in range(random.randint(1, 4)):
            who = random.choice(list(users.values()) + [admin])
            conn = random.choice([retail["id"], retail["id"], pg["id"]])
            q = random.choice(Q if random.random() < .7 else P)
            c = ask(who, conn, q, predictive=q in P)
            asked[-1] += (day,)
    # a few answers that were wrong and then corrected, a few marked incorrect
    sample = [a for a in asked if a[1]["status"] == "success" and not a[1].get("analysis")]
    for c, run, conn, *_ in sample[:14]:
        c.post(f"/api/chat/runs/{run['id']}/feedback", {"verdict": "correct"})
    for c, run, conn, *_ in sample[14:17]:
        c.post(f"/api/chat/runs/{run['id']}/feedback", {"verdict": "incorrect", "issue_type": "filter", "note": "Should exclude cancelled orders"})
    edited = sample[17:20]
    for c, run, conn, *_ in edited:
        c.post(f"/api/chat/runs/{run['id']}/execute", {"sql": run["final_sql"] + "\n"})
    for c, run, conn, *_ in edited:   # a corrected SQL is a different SQL: nudge it so it counts as an edit
        r = c.post(f"/api/chat/runs/{run['id']}/execute", {"sql": run["final_sql"].replace("SELECT ", "SELECT /* checked */ ", 1)})
        c.post(f"/api/chat/runs/{run['id']}/feedback", {"verdict": "correct"})
    # analyst feedback waiting for a steward to approve
    tom = users["tom.becker@acme.example"]
    for q in ("Who are our top customers by revenue?", "What is revenue by category?"):
        r = ask(tom, retail["id"], q)["run"]
        tom.post(f"/api/chat/runs/{r['id']}/feedback", {"verdict": "correct"})

    # people who tidy their question with ✨ Rephrase before asking (feeds the dashboard's Rephrased tile)
    for who, q, use in ((users["tom.becker@acme.example"], "rev by cat pls", True), (users["lena.okafor@acme.example"], "top cust", True),
                        (users["sam.rivera@acme.example"], "rev by mth", True), (users["dana.cho@acme.example"], "rev by regn", False),
                        (users["maya.brooks@acme.example"], "rev by cat", True)):
        rp = who.post("/api/chat/rephrase", {"connection_id": retail["id"], "question": q})
        if use and rp.get("question"):
            out = who.post("/api/chat/ask", {"connection_id": retail["id"], "model_id": fast["id"], "question": rp["question"], "rephrase_id": rp["id"]})
            asked.append((who, out["run"], retail["id"], random.randint(0, 6)))

    # named conversations the video opens (admin): today, yesterday, this week, last month
    keep = []
    for title_q, age_days, predictive in (("Revenue and orders by region", 33, False), ("How many orders do we have by status?", 4, False),
                                          ("Who are our top customers by revenue?", 1, False)):
        out = ask(admin, retail["id"], title_q, model=fast["id"], predictive=predictive)
        keep.append((out["conversation"]["id"], age_days))
    out = ask(admin, retail["id"], "What is revenue by month?", model=fast["id"])
    ask(admin, retail["id"], "Show revenue by channel and category", model=fast["id"], conv=out["conversation"]["id"])
    keep.append((out["conversation"]["id"], 0))
    state["seed_conv"] = out["conversation"]["id"]

    # a report that already exists, so the Reports page is not empty (built from two throw-away answers)
    base, throwaway = {}, []
    for q in ("What is revenue by month?", "How does revenue split by region?"):
        out = ask(admin, retail["id"], q, model=fast["id"])
        base[q] = out["run"]
        throwaway.append(out["conversation"]["id"])

    def comp(q, **kw):
        return {"type": "result", "run_id": base[q]["id"], "title": q, "width": 3, **kw}
    rep = admin.post("/api/reports", {"title": "Monthly sales review", "description": "Revenue trend and regional split for the leadership meeting",
                                      "header_text": "Acme · Confidential", "footer_text": "Prepared by Analytics · {{date}}",
                                      "components": [{"type": "heading", "text": "Sales performance", "level": 1},
                                                     comp("What is revenue by month?", width=6), comp("How does revenue split by region?")]})
    admin.put(f"/api/reports/{rep['id']}/shares", {"shares": [{"scope": "group", "group_id": leads}]})
    admin.put(f"/api/reports/{rep['id']}/schedule", {"enabled": True, "frequency": "weekly", "weekday": 0, "time": "08:30", "tz": "Asia/Kolkata",
                                                     "group_ids": [leads], "user_ids": [], "recipients": [], "sender_id": sender["id"]})
    for cid in throwaway:                      # the report keeps its own copy of the queries
        admin.call("DELETE", f"/api/chat/conversations/{cid}")
    state["admin_user_id"] = admin.get("/api/auth/me")["id"]

    # ---------------------------------------------------------------- spread the history over time (SQLite, off the books)
    db = sqlite3.connect(OUT / "data" / "text2sql.db")
    now = dt.datetime.utcnow()
    rows = db.execute("select id, conversation_id from query_runs order by id").fetchall()
    day_of = {}
    for c, run, conn, *rest in asked:
        if rest:
            day_of[run["id"]] = rest[0]
    for run_id, conv_id in rows:
        d = day_of.get(run_id, 0)
        t = now - dt.timedelta(days=d, hours=random.randint(0, 9), minutes=random.randint(0, 59))
        db.execute("update query_runs set created_at=? where id=?", (t.strftime("%Y-%m-%d %H:%M:%S.%f"), run_id))
    for conv_id, runs_at in db.execute("select conversation_id, max(created_at) from query_runs group by conversation_id").fetchall():
        db.execute("update conversations set updated_at=? where id=?", (runs_at, conv_id))
    for conv_id, age in keep:      # the conversations the video shows in the chat list
        t = (now - dt.timedelta(days=age, minutes=random.randint(5, 90))).strftime("%Y-%m-%d %H:%M:%S.%f")
        db.execute("update conversations set updated_at=? where id=?", (t, conv_id))
        db.execute("update query_runs set created_at=? where conversation_id=?", (t, conv_id))
    db.commit()
    db.close()

    # ---------------------------------------------------------------- admin: two-factor on, then keep a signed-in browser session
    setup = admin.post("/api/auth/2fa/setup")
    secret = setup["secret"]
    code = pyotp.TOTP(secret).now()
    admin.post("/api/auth/2fa/enable", {"code": code})
    state["totp_secret"] = secret
    cookie = admin.s.cookies.get("t2s_session")
    (OUT / "admin.storage.json").write_text(json.dumps({"cookies": [{"name": "t2s_session", "value": cookie, "domain": "localhost", "path": "/",
                                                                      "httpOnly": True, "secure": False, "sameSite": "Strict", "expires": -1}], "origins": []}))
    # a session for Tom (no 2FA) so the row-level-security scene can start signed in if needed
    (OUT / "state.json").write_text(json.dumps(state, indent=1))
    print("seeded:", {k: v for k, v in state.items() if k not in ("totp_secret", "users")})


if __name__ == "__main__":
    main()
