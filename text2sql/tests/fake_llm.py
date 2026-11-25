"""A tiny OpenAI-compatible model server for tests and offline demos.

It answers a handful of questions about the bundled retail sample with canned SQL, and
records every request body so tests can prove no result data is ever sent to the model.

    python -m tests.fake_llm            # serves http://127.0.0.1:8765/v1
"""
import asyncio
import json
import os
import random

from fastapi import FastAPI, Request

app = FastAPI()
REQUESTS: list[dict] = []

REVENUE = "ROUND(SUM(oi.quantity * oi.unit_price * (1 - oi.discount)), 2)"
JOIN = "FROM order_items oi JOIN orders o ON o.order_id = oi.order_id"

ORDERS = ("SELECT o.order_id, o.status, o.channel, c.segment, c.region, COUNT(*) AS items, SUM(oi.quantity) AS units, "
          "MAX(oi.unit_price) AS top_price, ROUND(SUM(oi.quantity * oi.unit_price * (1 - oi.discount)), 2) AS order_value "
          "FROM orders o JOIN order_items oi ON oi.order_id = o.order_id JOIN customers c ON c.customer_id = o.customer_id "
          "GROUP BY o.order_id, o.status, o.channel, c.segment, c.region")
# Predictive questions: SQL for the input data set + which analysis to run on it.
PREDICTIVE = [
    # demo-video data sets (see demo/make_data.py)
    ("forecast monthly revenue", "SELECT month, revenue FROM monthly_revenue ORDER BY month",
     {"type": "forecast", "date": "month", "target": "revenue", "horizon": 6}),
    ("segment our customers by", "SELECT customer_id, recency_days, orders_12m, revenue_12m, avg_order_value, region FROM customer_rfm",
     {"type": "clustering", "id": "customer_id", "k": 4}),
    ("unusual days in daily revenue", "SELECT day, revenue FROM daily_revenue ORDER BY day",
     {"type": "anomaly", "date": "day", "target": "revenue"}),
    ("forecast", f"SELECT CAST(date_trunc('month', o.order_date) AS DATE) AS month, {REVENUE} AS revenue {JOIN} "
                 "WHERE o.status = 'completed' AND o.order_date < DATE '2025-10-01' GROUP BY 1 ORDER BY 1",
     {"type": "forecast", "date": "month", "target": "revenue", "horizon": 6}),
    ("segment", f"SELECT c.customer_id, c.segment AS customer_type, c.region, COUNT(DISTINCT o.order_id) AS orders, {REVENUE} AS revenue, "
                f"ROUND(AVG(oi.discount), 3) AS avg_discount {JOIN} JOIN customers c ON c.customer_id = o.customer_id "
                "WHERE o.status = 'completed' GROUP BY 1, 2, 3", {"type": "clustering", "id": "customer_id", "k": None}),
    ("likely", ORDERS, {"type": "classification", "target": "status", "id": "order_id"}),
    ("predict order value", ORDERS, {"type": "regression", "target": "order_value", "id": "order_id"}),
    ("drives", ORDERS, {"type": "drivers", "target": "order_value"}),
    ("unusual days", f"SELECT CAST(o.order_date AS DATE) AS day, {REVENUE} AS revenue {JOIN} GROUP BY 1 ORDER BY 1",
     {"type": "anomaly", "date": "day", "target": "revenue"}),
    ("unusual orders", ORDERS, {"type": "anomaly", "id": "order_id"}),
    ("bad analysis", "SELECT status, COUNT(*) AS orders FROM orders GROUP BY 1", {"type": "forecast", "date": "nope", "target": "orders"}),
]

RULES = [
    ("budget", "SELECT department, SUM(amount) AS budget FROM budget_2025 GROUP BY 1 ORDER BY 2 DESC"),
    ("weather", None),
    ("delete", "DELETE FROM orders"),
    ("email", "SELECT customer_name, email FROM customers ORDER BY customer_name LIMIT 20"),
    ("alias", "WITH c AS (SELECT customer_name, email AS contact FROM customers) SELECT customer_name, upper(contact) AS reach FROM c LIMIT 5"),
    ("pivot", "SELECT p.product_id, p.product_name, " + ", ".join(
        f"ROUND(SUM(CASE WHEN strftime(o.order_date, '%Y-%m') = '2025-0{m}' THEN oi.quantity * oi.unit_price ELSE 0 END), 2) AS \"2025-0{m}\""
        for m in range(1, 7)) + f" {JOIN} JOIN products p ON p.product_id = oi.product_id WHERE o.status = 'completed' GROUP BY 1, 2 ORDER BY 2"),
    ("product list", "SELECT product_id, product_name, category FROM products ORDER BY product_id"),
    ("month", f"SELECT CAST(date_trunc('month', o.order_date) AS DATE) AS month, {REVENUE} AS revenue {JOIN} "
              "WHERE o.status = 'completed' GROUP BY 1 ORDER BY 1"),
    ("top", f"SELECT c.customer_name, {REVENUE} AS revenue {JOIN} JOIN customers c ON c.customer_id = o.customer_id "
            "WHERE o.status = 'completed' GROUP BY 1 ORDER BY revenue DESC LIMIT 10"),
    ("region", f"SELECT c.region, {REVENUE} AS revenue, COUNT(DISTINCT o.order_id) AS orders {JOIN} "
               "JOIN customers c ON c.customer_id = o.customer_id WHERE o.status = 'completed' GROUP BY 1 ORDER BY revenue DESC"),
    ("channel", f"SELECT o.channel, p.category, {REVENUE} AS revenue {JOIN} JOIN products p ON p.product_id = oi.product_id "
                "WHERE o.status = 'completed' GROUP BY 1, 2 ORDER BY 1, 2"),
    ("categor", f"SELECT p.category, {REVENUE} AS revenue {JOIN} JOIN products p ON p.product_id = oi.product_id "
                "WHERE o.status = 'completed' GROUP BY 1 ORDER BY revenue DESC"),
    ("pg time", "SELECT status, COUNT(*) AS orders, SUM(amount) AS total FROM orders WHERE placed_at::time > '12:30' AND status LIKE 'c%' GROUP BY status ORDER BY 1"),
    ("pg write", "WITH x AS (UPDATE orders SET amount = 0 RETURNING *) SELECT * FROM x"),
    ("status", "SELECT status, COUNT(*) AS orders FROM orders GROUP BY status ORDER BY orders DESC"),
]


def _sap_examples() -> dict:
    """The SAP sample's verified questions, answered with their verified SQL (used by the demo video)."""
    path = os.path.join(os.path.dirname(__file__), "..", "sample_data", "sap_training.json")
    try:
        return {e["question"].strip().lower(): e["sql"] for e in json.load(open(path))["examples"]}
    except Exception:
        return {}


SAP = _sap_examples()
WORDS = {"rev": "revenue", "regn": "region", "rgn": "region", "cust": "customers", "custs": "customers", "qty": "quantity",
         "cat": "category", "cats": "categories", "mth": "month", "yr": "year", "pls": "", "plz": "", "pls.": "", "u": "you"}


def rephrase(text: str) -> dict:
    """Stand-in for "Rephrase": expand abbreviations, drop filler, make it a complete question."""
    if "unrephrasable" in text:
        return {"raw": "Sorry, I cannot help with that."}
    words = [WORDS.get(w.lower().strip("?,."), w) for w in text.strip().rstrip("?").split()]
    q = " ".join(w for w in words if w)
    if not q.lower().startswith(("what", "which", "who", "how", "show", "list", "forecast", "segment", "any")):
        q = "What is the total " + q
    return {"raw": json.dumps({"question": q[0].upper() + q[1:] + "?", "changes": "expanded abbreviations; made it a full question",
                               "unclear": "which time period" if not any(t in q.lower() for t in ("month", "year", "202", "week", "day")) else ""})}


# Combined data model "Sample: SAP + CRM": plans of steps (one per data model) and a combine query run on the server.
SAP_SALES = ("SELECT c.KUNNR AS customer, c.NAME1 AS customer_name, "
             "ROUND(SUM(CASE WHEN k.VBTYP = 'M' THEN k.NETWR ELSE -k.NETWR END), 2) AS net_sales "
             "FROM vbrk k JOIN kna1 c ON c.KUNNR = k.KUNRG WHERE k.FKDAT BETWEEN DATE '2025-01-01' AND DATE '2025-12-31' GROUP BY 1, 2")
CRM_OPEN = "SELECT sap_no, COUNT(*) AS open_tickets FROM tickets t JOIN accounts a ON a.account_id = t.account_id WHERE t.status <> 'Closed' AND a.sap_no IS NOT NULL GROUP BY 1"
STRIP = "coalesce(nullif(ltrim(trim(CAST({} AS VARCHAR)), '0'), ''), '0')"
URGENT_KEYS = ("SELECT DISTINCT a.sap_no FROM tickets t JOIN accounts a ON a.account_id = t.account_id "
               "WHERE t.status <> 'Closed' AND t.priority = 'Urgent' AND a.sap_no IS NOT NULL")
SAP_FOR_KEYS = ("SELECT c.KUNNR AS customer, c.NAME1 AS customer_name, k.WAERK AS currency, COUNT(*) AS invoices_2025, "
                "ROUND(SUM(CASE WHEN k.VBTYP = 'M' THEN k.NETWR ELSE -k.NETWR END), 2) AS net_sales "
                "FROM vbrk k JOIN kna1 c ON c.KUNNR = k.KUNRG WHERE k.FKDAT BETWEEN DATE '2025-01-01' AND DATE '2025-12-31' "
                "AND LTRIM(k.KUNRG, '0') IN ({{s1.sap_no|to_text}}) GROUP BY 1, 2, 3")
PLANS = [
    ("keys out of order", {"steps": [{"id": "s1", "source": "sap", "sql": SAP_FOR_KEYS.replace("s1.", "s2.")},
                                     {"id": "s2", "source": "crm", "sql": URGENT_KEYS}], "combine": "SELECT * FROM s1"}),
    ("keys from every ticket", {"steps": [{"id": "s1", "source": "crm", "sql": "SELECT ticket_id, a.sap_no FROM tickets t JOIN accounts a ON a.account_id = t.account_id WHERE a.sap_no IS NOT NULL"},
                                          {"id": "s2", "source": "sap", "sql": SAP_FOR_KEYS}], "combine": "SELECT * FROM s2"}),
    ("urgent", {"steps": [{"id": "s1", "source": "crm", "sql": URGENT_KEYS}, {"id": "s2", "source": "sap", "sql": SAP_FOR_KEYS}],
                "combine": "SELECT customer_name, currency, invoices_2025, net_sales FROM s2 ORDER BY currency, net_sales DESC"}),
    ("plan broken", None),
    ("every billing item", {"steps": [{"id": "s1", "source": "sap", "sql": "SELECT * FROM vbrp"},
                                      {"id": "s2", "source": "crm", "sql": CRM_OPEN}],
                            "combine": "SELECT * FROM s1 JOIN s2 ON s1.KUNNR = s2.sap_no"}),
    ("without the key rule", {"steps": [{"id": "s1", "source": "sap", "sql": SAP_SALES}, {"id": "s2", "source": "crm", "sql": CRM_OPEN}],
                              "combine": "SELECT s1.customer_name, s2.open_tickets FROM s1 JOIN s2 ON s1.customer = CAST(s2.sap_no AS VARCHAR)"}),
    ("every posting", {"steps": [{"id": "s1", "source": "sap", "sql": "SELECT KUNNR, DMBTR FROM bseg WHERE KOART = 'D'"},
                                 {"id": "s2", "source": "crm", "sql": "SELECT a.sap_no, t.ticket_id FROM tickets t JOIN accounts a ON a.account_id = t.account_id WHERE a.sap_no IS NOT NULL"}],
                       "combine": f"SELECT COUNT(*) AS joined_rows, ROUND(SUM(s1.DMBTR), 2) AS amount FROM s1 JOIN s2 ON {STRIP.format('s1.KUNNR')} = {STRIP.format('s2.sap_no')}"}),
    ("outside the steps", {"steps": [{"id": "s1", "source": "crm", "sql": CRM_OPEN}], "combine": "SELECT * FROM kna1"}),
    ("tickets by priority", {"steps": [{"id": "s1", "source": "crm", "sql": "SELECT priority, COUNT(*) AS tickets FROM tickets GROUP BY 1"}],
                             "combine": "SELECT * FROM s1 ORDER BY tickets DESC"}),
    ("open tickets", {"steps": [{"id": "s1", "source": "sap", "sql": SAP_SALES}, {"id": "s2", "source": "crm", "sql": CRM_OPEN}],
                      "combine": f"SELECT s1.customer_name, s1.net_sales AS net_sales_2025, COALESCE(s2.open_tickets, 0) AS open_tickets "
                                 f"FROM s1 LEFT JOIN s2 ON {STRIP.format('s1.customer')} = {STRIP.format('s2.sap_no')} "
                                 "ORDER BY s1.net_sales DESC LIMIT 10"}),
]


def plan(user: str) -> dict:
    question = user.split("## Question")[-1].split("## Your previous plan failed")[0].lower()
    repairing = "previous plan failed" in user
    for key, p in PLANS:
        if key in question:
            if p is None:           # a step that fails until the model repairs it
                p = PLANS[-1][1] if repairing else {"steps": [{"id": "s1", "source": "sap", "sql": "SELECT no_such_column FROM kna1"},
                                                              {"id": "s2", "source": "crm", "sql": CRM_OPEN}], "combine": "SELECT * FROM s1"}
            return {**p, "explanation": "Net sales from SAP, open tickets from the CRM, matched on the customer number.",
                    "followups": ["Which of these customers have urgent tickets?", "Show net sales by month for these customers"]}
    if "weather" in question:
        return {"steps": [], "clarification": "Neither data model has weather data. Did you mean tickets by priority?"}
    return {**PLANS[-1][1], "explanation": "Combines SAP net sales with CRM open tickets.", "followups": []}


def answer(system: str, user: str) -> dict:
    if "rewrite a business user's question" in system:
        return rephrase(user.split("## Question to rewrite")[-1])
    if "short plan of SQL steps" in system:
        return plan(user)
    question = user.split("## Question")[-1].split("## Your previous attempt failed")[0].lower()
    repairing = "previous attempt failed" in user
    if "ping" == user.strip():
        return {"raw": "OK"}
    if "broken" in question:
        sql = "SELECT status, COUNT(*) AS orders FROM orders GROUP BY status" if repairing \
            else "SELECT no_such_column FROM orders"
        return {"sql": sql, "explanation": "Counts orders by status.", "followups": ["Which status is most common?"]}
    for key, sql, analysis in PREDICTIVE:
        if key in question:
            return {"sql": sql, "explanation": f"Prepares the data for a {analysis['type']} analysis.", "analysis": analysis,
                    "followups": ["What drives order value?", "Segment our customers", "Any unusual days?"]}
    if question.strip().rstrip("?") in {k.rstrip("?") for k in SAP}:
        sql = next(v for k, v in SAP.items() if k.rstrip("?") == question.strip().rstrip("?"))
        return {"sql": sql, "explanation": "Answers the question from the SAP sales and finance tables.",
                "followups": ["Show the open sales order backlog by sales organisation", "Which customers have the most overdue receivables?"]}
    for key, sql in RULES:
        if key in question:
            if sql is None:
                return {"sql": "", "clarification": "This data model has no weather data. Did you mean sales by region?"}
            return {"sql": sql, "explanation": f"Answers the question using the '{key}' pattern.",
                    "followups": ["How does this split by region?", "Show the monthly trend", "Who are the top customers?"]}
    return {"sql": "SELECT COUNT(*) AS total_orders FROM orders", "explanation": "Counts all orders.",
            "followups": ["How many orders by status?", "What is revenue by category?"]}


async def _latency():
    """FAKE_LLM_DELAY=1.5 makes the stand-in answer in about that many seconds (used for the demo video)."""
    delay = float(os.environ.get("FAKE_LLM_DELAY", "0"))
    if delay:
        await asyncio.sleep(delay * random.uniform(0.75, 1.25))


@app.post("/v1/chat/completions")
async def completions(request: Request):
    body = await request.json()
    REQUESTS.append(body)
    await _latency()
    msgs = {m["role"]: m["content"] for m in body["messages"]}
    ans = answer(msgs.get("system", ""), msgs.get("user", ""))
    content = ans.get("raw") or json.dumps(ans)
    return {"id": "fake", "object": "chat.completion", "model": body.get("model"),
            "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": sum(len(m["content"]) for m in body["messages"]) // 4,
                      "completion_tokens": len(content) // 4, "total_tokens": 0}}


@app.post("/v1/messages")
async def anthropic_messages(request: Request):
    """Anthropic Messages API shape, so the Claude provider path can be exercised offline."""
    body = await request.json()
    REQUESTS.append(body)
    await _latency()
    system = body.get("system") if isinstance(body.get("system"), str) else json.dumps(body.get("system"))
    user = body["messages"][-1]["content"]
    user = user if isinstance(user, str) else " ".join(b.get("text", "") for b in user)
    ans = answer(system or "", user)
    text = ans.get("raw") or json.dumps(ans)
    return {"id": "msg_fake", "type": "message", "role": "assistant", "model": body.get("model"),
            "content": [{"type": "text", "text": text}], "stop_reason": "end_turn", "stop_sequence": None,
            "usage": {"input_tokens": 900, "output_tokens": 60, "cache_read_input_tokens": 0,
                      "cache_creation_input_tokens": 0}}


@app.get("/requests")
def requests():
    return REQUESTS


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")
