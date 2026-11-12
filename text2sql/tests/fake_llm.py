"""A tiny OpenAI-compatible model server for tests and offline demos.

It answers a handful of questions about the bundled retail sample with canned SQL, and
records every request body so tests can prove no result data is ever sent to the model.

    python -m tests.fake_llm            # serves http://127.0.0.1:8765/v1
"""
import json

from fastapi import FastAPI, Request

app = FastAPI()
REQUESTS: list[dict] = []

REVENUE = "ROUND(SUM(oi.quantity * oi.unit_price * (1 - oi.discount)), 2)"
JOIN = "FROM order_items oi JOIN orders o ON o.order_id = oi.order_id"

RULES = [
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


def answer(system: str, user: str) -> dict:
    question = user.split("## Question")[-1].split("## Your previous attempt failed")[0].lower()
    repairing = "previous attempt failed" in user
    if "ping" == user.strip():
        return {"raw": "OK"}
    if "broken" in question:
        sql = "SELECT status, COUNT(*) AS orders FROM orders GROUP BY status" if repairing \
            else "SELECT no_such_column FROM orders"
        return {"sql": sql, "explanation": "Counts orders by status.", "followups": ["Which status is most common?"]}
    for key, sql in RULES:
        if key in question:
            if sql is None:
                return {"sql": "", "clarification": "This data model has no weather data. Did you mean sales by region?"}
            return {"sql": sql, "explanation": f"Answers the question using the '{key}' pattern.",
                    "followups": ["How does this split by region?", "Show the monthly trend", "Who are the top customers?"]}
    return {"sql": "SELECT COUNT(*) AS total_orders FROM orders", "explanation": "Counts all orders.",
            "followups": ["How many orders by status?", "What is revenue by category?"]}


@app.post("/v1/chat/completions")
async def completions(request: Request):
    body = await request.json()
    REQUESTS.append(body)
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
