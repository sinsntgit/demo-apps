"""A stand-in AI model (OpenAI-compatible) for tests and offline demos. It answers each step of the
pipeline with the bundled retail sample, and records every request so tests can check what is sent.

    python -m tests.fake_llm            # serves http://127.0.0.1:8765/v1
"""
import json
import re

from fastapi import FastAPI, Request

from app import sample

app = FastAPI()
REQUESTS: list[dict] = []


def answer(prompt: str) -> dict | str:
    if prompt.strip() == "ping":
        return "OK"
    if "extract everything an ontology" in prompt:
        return {"concepts": [{"term": "Gift voucher", "definition": "A prepaid voucher redeemable against orders.", "kind_of": "", "also_called": ["gift card"]}],
                "relationships": ["Customer - redeems - Gift voucher"], "attributes": ["Gift voucher: balance (amount)"],
                "rules": ["A voucher cannot be redeemed after it expires."], "questions": ["How much voucher balance is outstanding?"]}
    if "Step 1 of building" in prompt:
        return {"domain": sample.DOMAIN, "standards": [*sample.STANDARDS, {"id": "arts", "name": "ARTS Retail Data Model", "publisher": "NRF",
                "url": "javascript:alert(1)", "prefix": "arts", "kind": "standard", "relevance": "medium", "how_used": "Retail reference model.",
                "reused_terms": ["RetailTransaction"]}], "standards_approach": sample.EXPLANATION["standards_approach"]}
    if "Step 2: design the class hierarchy" in prompt:
        classes = [dict(c) for c in sample.CLASSES]
        if "TABLE loans" in prompt:
            classes.append({"id": "Loan", "parent": None, "module": "Sales", "definition": "A loan granted to a customer.", "derived_from": "loans"})
        return {"modules": sample.MODULES, "classes": classes + [{"id": "Ghost Class", "parent": "Nowhere", "module": "Nope", "definition": "Dangling."}]}
    if "Step 3: add the relationships" in prompt:
        return {"properties": sample.PROPERTIES + [{"id": "dangling", "kind": "object", "domain": "Order", "range": "DoesNotExist"}],
                "individuals": sample.INDIVIDUALS, "rules": sample.RULES}
    if "Propose the concrete changes that fix these problems" in prompt:
        return {"findings": ["Brand has no attributes.", "Store and online channel can overlap."],
                "properties": [{"id": "brandName", "label": "brand name", "kind": "data", "domain": "Brand", "range": "string", "cardinality": "1",
                                "definition": "The name the brand is marketed under.", "reason": "Brand had no attributes."}],
                "classes": [{"id": "Brand", "definition": "The trade name under which a product is marketed to customers.", "reason": "A sharper definition."}],
                "rules": [{"id": "R10", "label": "Party kinds", "kind": "disjoint", "statement": "A person is never an organisation.",
                           "applies_to": ["Person", "Organization"], "reason": "Lets the reasoner catch a party recorded as both."}],
                "remove_properties": [{"id": "appliedPromotion", "reason": "Promotions are out of scope for this test."}]}
    if "Step 4: completeness review" in prompt:
        return {"findings": ["Gift cards used as a means of payment are not modelled."],
                "classes": [{"id": "GiftCard", "label": "Gift card", "definition": "A prepaid card that can be redeemed against orders.", "parent": None, "module": "Fulfilment",
                             "reason": "Gift cards are a payment means the scope mentions."}],
                "properties": [{"id": "redeems", "kind": "object", "domain": "Payment", "range": "GiftCard", "definition": "The gift card used for this payment.", "cardinality": "0..1"},
                               {"id": "cardBalance", "kind": "data", "domain": "GiftCard", "range": "decimal", "definition": "Remaining value on the card."}]}
    if "Write the explanation of this ontology" in prompt:
        return sample.EXPLANATION
    if "use cases this ontology answers" in prompt:
        out = []
        m = re.search(r"required use cases, in this order[\s\S]*?\n((?:\d+\. .*\n)+)", prompt)
        for line in (m.group(1).strip().splitlines() if m else []):
            out.append({"title": line.split(". ", 1)[1][:60], "actor": "Owner", "question": line.split(". ", 1)[1], "description": "Required by the owner.",
                        "classes": ["Order", "Customer"], "properties": ["placedBy"], "answer_path": ["Follow placed by."], "sparql": "SELECT * WHERE {}", "required": True})
        return {"use_cases": out + sample.USE_CASES}
    if "change request for the ontology" in prompt:
        if "nothing" in prompt.split("<instruction>")[1]:
            return {"summary": "No change."}
        return {"summary": "Added a loyalty programme.", "classes": [{"id": "LoyaltyProgram", "label": "Loyalty programme", "module": "Party",
                "definition": "A scheme that rewards customers for repeat purchases."}],
                "properties": [{"id": "memberOf", "kind": "object", "domain": "Customer", "range": "LoyaltyProgram", "definition": "The programme the customer belongs to."}]}
    if "USE CASE to test" in prompt:
        text = prompt.split("<use_case>")[1].split("</use_case>")[0].lower()
        if "weather" in text:
            return {"title": "Weather", "summary": "Not covered.", "requirements": [{"text": "Weather forecast", "kind": "concept", "status": "missing", "mapped": []},
                    {"text": "Store location", "kind": "attribute", "status": "covered", "mapped": ["Store"]}], "gaps": ["No weather concept."]}
        if "warranty" in text:
            has = "- Warranty |" in prompt
            return {"title": "Warranty claims", "summary": "Orders exist; warranties " + ("exist." if has else "do not."),
                    "requirements": [{"text": "An order line for a product", "kind": "relationship", "status": "covered", "mapped": ["OrderLine", "forProduct"]},
                                     {"text": "A warranty on a product", "kind": "concept", "status": "covered" if has else "missing", "mapped": ["Warranty"] if has else []},
                                     {"text": "Warranty covers product", "kind": "relationship", "status": "covered" if has else "missing", "mapped": ["coveredBy"] if has else []},
                                     {"text": "Imaginary element", "kind": "concept", "status": "covered", "mapped": ["Hallucinated"]} if not has else
                                     {"text": "Order date", "kind": "attribute", "status": "covered", "mapped": ["orderDate"]}],
                    "gaps": [] if has else [{"text": "No warranty concept", "impact": "Claims cannot be tracked."}],
                    "suggestions": {} if has else {"classes": [{"id": "Warranty", "label": "Warranty", "definition": "A guarantee covering a product for a period.", "module": "Catalogue"}],
                                                   "properties": [{"id": "coveredBy", "kind": "object", "domain": "Product", "range": "Warranty", "definition": "The warranty that covers the product."},
                                                                  {"id": "brokenLink", "kind": "object", "domain": "Product", "range": "NoSuchThing"}]},
                    "answer_path": ["From Order line follow for product."], "sparql": "SELECT ?p WHERE { ?l :forProduct ?p }"}
        return {"title": "Orders by customer", "summary": "Fully answerable.", "requirements": [
            {"text": "Customer", "kind": "concept", "status": "covered", "mapped": ["Customer"]},
            {"text": "Customer places order", "kind": "relationship", "status": "covered", "mapped": ["Customer", "Order", "places"]},
            {"text": "Order total", "kind": "attribute", "status": "covered", "mapped": ["orderTotal"]}], "gaps": [], "answer_path": ["Customer places Order."]}
    return "I am a stand-in model and do not know this step."


@app.post("/v1/chat/completions")
async def chat(request: Request):
    body = await request.json()
    REQUESTS.append(body)
    prompt = body["messages"][-1]["content"]
    if "BROKEN-JSON" in prompt and "Your previous reply could not be read" not in prompt:
        out = "Sure! Here it is: {not json"
    else:
        out = answer(prompt)
        out = out if isinstance(out, str) else "```json\n" + json.dumps(out) + "\n```"
    return {"id": "x", "object": "chat.completion", "model": body.get("model"),
            "choices": [{"index": 0, "message": {"role": "assistant", "content": out}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": len(prompt) // 4, "completion_tokens": len(out) // 4}}


@app.post("/v1/messages")
async def messages(request: Request):
    """Anthropic-shaped endpoint (streaming), so the Claude code path is exercised too."""
    from fastapi.responses import StreamingResponse
    body = await request.json()
    REQUESTS.append(body)
    out = answer(body["messages"][-1]["content"])
    out = out if isinstance(out, str) else json.dumps(out)

    def events():
        def ev(name, data):
            return f"event: {name}\ndata: {json.dumps({'type': name, **data})}\n\n"
        yield ev("message_start", {"message": {"id": "msg_1", "type": "message", "role": "assistant", "model": body["model"], "content": [],
                                               "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 120, "output_tokens": 0}}})
        yield ev("content_block_start", {"index": 0, "content_block": {"type": "text", "text": ""}})
        for i in range(0, len(out), 400):
            yield ev("content_block_delta", {"index": 0, "delta": {"type": "text_delta", "text": out[i:i + 400]}})
        yield ev("content_block_stop", {"index": 0})
        yield ev("message_delta", {"delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": len(out) // 4}})
        yield ev("message_stop", {})
    return StreamingResponse(events(), media_type="text/event-stream")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")
