"""A stand-in AI model (OpenAI-compatible) for tests and offline demos. It answers each step of the
pipeline with the bundled retail sample, and records every request so tests can check what is sent.

    python -m tests.fake_llm            # serves http://127.0.0.1:8765/v1
"""
import asyncio
import json
import os
import re

from fastapi import FastAPI, Request

from app import sample

app = FastAPI()
REQUESTS: list[dict] = []


def answer(prompt: str) -> dict | str:
    if prompt.strip() == "ping":
        return "OK"
    if "You are populating a knowledge graph from a document" in prompt:
        doc = prompt.split('DOCUMENT "')[1].split('"')[0]
        if "coats-judgment" in doc:
            return {"entities": [
                {"id": "e1", "class": "JudicialDecision", "label": "C.I.T., Kolkata-IV v. Coats of India Ltd.", "quote": "C.I.T., KOLKATA-IV Versus M/S. COATS OF INDIA LTD.",
                 "attributes": {"hasDecisionDate": {"value": "2008-09-08", "quote": "Date: 8th September, 2008."},
                                "amountInDispute": {"value": "Rs. 19,14,55,804", "quote": "surplus amount of Rs. 19,14,55,804"},
                                "hasCaseName": {"value": "Made up", "quote": "a sentence that is nowhere in the judgment"}}},
                {"id": "e2", "class": "Court", "label": "High Court at Calcutta", "quote": "IN THE HIGH COURT AT CALCUTTA"},
                {"id": "e3", "class": "Taxpayer", "label": "Coats of India Ltd", "aliases": ["M/S. COATS OF INDIA LTD."], "quote": "M/S. COATS OF INDIA LTD."},
                {"id": "e4", "class": "Provision", "label": "Section 47(iv), Income-tax Act, 1961", "quote": "Section 47(iv) of Income Tax Act"},
                {"id": "e5", "class": "Unicorn", "label": "Something", "quote": "IN THE HIGH COURT AT CALCUTTA"},
                {"id": "e6", "class": "Court", "label": "Supreme Court", "quote": "The Supreme Court decided this in 1990"}],
                "relations": [
                {"subject": "e1", "property": "decidedByCourt", "object": "e2", "quote": "IN THE HIGH COURT AT CALCUTTA"},
                {"subject": "e1", "property": "interpretsResource", "object": "e4", "quote": "as per provision of Section 47(iv) of Income Tax Act"},
                {"subject": "e1", "property": "hasDecisionOutcome", "object": "AssesseeFavoured", "quote": "Hence the appeal is not admitted."},
                {"subject": "e1", "property": "involvesParty", "object": "e3", "quote": "C.I.T., KOLKATA-IV Versus M/S. COATS OF INDIA LTD."},
                {"subject": "e2", "property": "decidedByCourt", "object": "e1", "quote": "IN THE HIGH COURT AT CALCUTTA"}],
                "notes": ["The surplus credited to capital reserve has no place in the ontology."]}
        if "long-judgment" in doc:
            if "(part 1 of" in prompt:
                return {"entities": [
                    {"id": "e1", "class": "JudicialDecision", "label": "C.I.T., Kolkata-IV v. Coats of India Ltd.", "quote": "C.I.T., KOLKATA-IV Versus M/S. COATS OF INDIA LTD."},
                    {"id": "e2", "class": "Taxpayer", "label": "Coats of India Ltd", "quote": "M/S. COATS OF INDIA LTD."}], "relations": []}
            # a later part: it only says "the assessee"; link it if the application said who that is
            earlier = prompt.split("Found in the earlier parts of THIS document")[1].split("\n\n")[0] if "Found in the earlier parts of THIS document" in prompt else ""
            dec = re.search(r"- (x\d+) \| JudicialDecision \|", earlier)
            tp = re.search(r"- (x\d+) \| Taxpayer \| Coats", earlier)
            if dec and tp and "<document_start>" in prompt:
                return {"entities": [], "relations": [{"subject": dec.group(1), "property": "involvesParty", "object": tp.group(1),
                                                       "quote": "the assessee succeeds on every ground"}]}
            return {"entities": [{"id": "e1", "class": "Taxpayer", "label": "The assessee", "quote": "the assessee succeeds on every ground"}], "relations": []}
        if "customer-email" in doc:
            return {"entities": [
                {"id": "e1", "class": "Customer", "label": "Priya Nair", "quote": "Priya Nair",
                 "attributes": {"loyaltyTier": {"value": "Gold", "quote": "I am a Gold member"}}},
                {"id": "e2", "class": "Order", "label": "O-0042", "quote": "I placed order O-0042 on 3 March 2025",
                 "attributes": {"orderNumber": {"value": "O-0042", "quote": "order O-0042"}, "orderDate": {"value": "2025-03-03", "quote": "3 March 2025"}}},
                {"id": "e3", "class": "OrderLine", "label": "Line 1 of order O-0042", "quote": "Line 1 of that order was one Brew Master kettle",
                 "attributes": {"quantity": {"value": "1", "quote": "one Brew Master kettle"}, "unitPrice": {"value": "Rs. 1,899.00", "quote": "Rs. 1,899.00"}}},
                {"id": "e4", "class": "Product", "label": "Brew Master kettle", "quote": "one Brew Master kettle",
                 "attributes": {"productName": {"value": "Brew Master kettle", "quote": "Brew Master kettle"}}},
                {"id": "e5", "class": "ReturnRequest", "label": "Return of the kettle from order O-0042", "quote": "Please open a return for the kettle",
                 "attributes": {"requestedOn": {"value": "2025-03-05", "quote": "Date: 5 March 2025"},
                                "refundAmount": {"value": "1899", "quote": "a refund of Rs. 1,899.00 was approved on the same day"}}},
                {"id": "e6", "class": "Refund", "label": "Full refund requested", "quote": "I would like a full refund"}],
                "relations": [
                {"subject": "e2", "property": "placedBy", "object": "e1", "quote": "I placed order O-0042 on 3 March 2025"},
                {"subject": "e3", "property": "lineOf", "object": "e2", "quote": "Line 1 of that order"},
                {"subject": "e3", "property": "forProduct", "object": "e4", "quote": "one Brew Master kettle"},
                {"subject": "e5", "property": "returnOf", "object": "e3", "quote": "Please open a return for the kettle"},
                {"subject": "e5", "property": "hasReason", "object": "Damaged", "quote": "The kettle arrived damaged"}],
                "notes": ["The customer asks for a full refund, but the ontology has no refund decision."]}
        if "support-notes" in doc:
            known = dict((lab, i) for i, cls, lab in re.findall(r"- (x\d+) \| (\w+) \| ([^|\n]+?)(?: \||\n)", prompt))
            ents = [{"id": known.get("O-0042", "e1"), "class": "Order", "label": "O-0042", "quote": "called about order O-0042"},
                    {"id": "e2", "class": "Customer", "label": "Priya R. Nair", "quote": "Priya R. Nair (Gold)"},
                    {"id": "e3", "class": "Order", "label": "O-0050", "quote": "Order O-0050 for Priya R. Nair"}]
            return {"entities": ents, "relations": [
                {"subject": "e3", "property": "placedBy", "object": "e2", "quote": "Order O-0050 for Priya R. Nair"},
                {"subject": "e3", "property": "hasStatus", "object": "Delivered", "quote": "was delivered on time"}], "notes": []}
        if "coats-note" in doc:
            known = re.findall(r"\n- (x\d+) \| Taxpayer \| ", prompt)
            return {"entities": [
                {"id": "e1", "class": "Taxpayer", "label": "Coats of India Limited", "quote": "Coats of India Limited won"},
                {"id": "e2", "class": "Court", "label": "Calcutta High Court", "quote": "in the Calcutta High Court"}],
                "relations": [], "notes": [], "registry_seen": known}
        return {"entities": [], "relations": []}
    if "You are mapping an ontology onto the tables" in prompt:
        if "TABLE customers" not in prompt:
            return {"maps": [], "notes": ["No tables I recognise."]}
        demo = "BrightMart" in prompt                        # the demo video: mistakes a real model could make
        extra = [{"class": "LoyaltyProgram", "table": "customers"}, {"class": "Brand", "table": "brands"}] if demo else \
                [{"class": "Unicorn", "table": "customers"}, {"class": "Brand", "table": "no_such_table"}]
        return {"maps": [
            {"class": "Customer", "source": "Shop data", "table": "customers", "key": "customer_id", "label": "full_name",
             "attributes": {"email": "email", "customerSince": "since", "loyaltyTier": "tier"}},
            {"class": "Order", "table": "orders", "key": "order_id", "label": "order_no",
             "attributes": {"orderNumber": "order_no", "orderDate": "order_date", "orderTotal": "total"}, "values": {"hasStatus": "status"},
             "links": [{"property": "placedBy", "to_class": "Customer", "side": "from", "column": "customer_id"}]},
            {"class": "OrderLine", "table": "order_lines", "key": "line_id", "attributes": {"quantity": "qty", "unitPrice": "price"},
             "links": [{"property": "lineOf", "to_class": "Order", "side": "from", "column": "order_id"},
                       {"property": "forProduct", "to_class": "Product", "side": "from", "column": "product_id"}]},
            {"class": "Product", "table": "products", "key": "product_id", "label": "product_name",
             "attributes": {"sku": "sku", "productName": "product_name", "gtin": "barcode" if demo else "no_such_column"}},
            *extra], "notes": ["Brands are not in the data."]}
    if "Its knowledge graph holds records" in prompt:
        text = prompt.split("<use_case>")[1].split("</use_case>")[0]
        good = ("SELECT ?order ?number ?customer ?name ?total ?status WHERE { ?order a :Order ; :orderNumber ?number ; :placedBy ?customer ; "
                ":orderTotal ?total ; :hasStatus ?status . ?customer rdfs:label ?name } ORDER BY ?number LIMIT 200")
        if "BAD-QUERY" in text and "was refused by the query engine" not in prompt:
            return {"sparql": "SELECT ?x WHERE { ?x a :Order ", "explanation": "Broken on purpose."}
        if "CHANGE-DATA" in text:
            return {"sparql": "INSERT DATA { :x a :Order }", "explanation": "Tries to write."}
        if "warranty" in text.lower():
            return {"sparql": "SELECT ?w WHERE { ?w a :Warranty }", "explanation": "Warranties.", "cannot_answer": "No warranty data."}
        return {"sparql": good, "explanation": "Lists each order with its customer, total and status.", "columns": {"order": "the order", "name": "customer"}}
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
    if "You are documenting a data source" in prompt and "TABLE order_lines" in prompt:
        T = {"customers": "One row per customer account, with the date they joined and their loyalty tier.",
             "orders": "One row per order placed on the web shop, with its total and where it is in its life.",
             "order_lines": "One row per product on an order, with the quantity and the unit price.",
             "products": "One row per product the shop sells, identified by its stock keeping unit."}
        C = {"customer_id": "Identifies the customer.", "full_name": "The customer's full name.", "email": "The customer's e-mail address.", "since": "The date the customer joined.",
             "tier": "Loyalty level: Gold, Silver or Bronze.", "order_id": "Identifies the order.", "order_no": "The order number shown to the customer.",
             "order_date": "When the order was placed.", "total": "Order total in rupees: the sum of its lines.", "status": "Where the order is: Placed, Paid, Shipped, Delivered or Cancelled.",
             "line_id": "Identifies the order line.", "product_id": "Identifies the product.", "qty": "How many units were ordered.", "price": "Unit price in rupees.",
             "sku": "The product's stock keeping unit code.", "product_name": "The name customers see."}
        out = []
        for t in re.findall(r"\nTABLE (\S+)", prompt):
            cols = re.findall(r"\nTABLE " + re.escape(t) + r"[^\n]*\n((?:  [^\n]*\n?)+)", prompt)
            names = re.findall(r"^  (\S+)  ", cols[0], re.M) if cols else []
            out.append({"name": t, "description": T.get(t, f"One row per {t}."), "columns": {n: C.get(n, f"The {n.replace('_', ' ')}.") for n in names}})
        return {"summary": "An online retailer's customers, the orders they place, the products on each order and the product catalogue.", "tables": out,
                "glossary": [{"term": "Tier", "meaning": "A customer's loyalty level: Gold, Silver or Bronze."}, {"term": "Order status", "meaning": "Placed, Paid, Shipped or Delivered; Cancelled if stopped before shipment."}],
                "questions": ["Is an order's total before or after delivery charges?", "Does a cancelled order keep its lines?"]}
    if "You are documenting a data source" in prompt:
        tables = re.findall(r"\nTABLE (\S+)", prompt)
        out = []
        for t in tables:
            cols = re.findall(r"\nTABLE " + re.escape(t) + r"[^\n]*\n((?:  [^\n]*\n?)+)", prompt)
            names = re.findall(r"^  (\S+)  ", cols[0], re.M) if cols else []
            out.append({"name": t, "description": f"Drafted: each row is one {t.rstrip('s')}.", "columns": {n: f"Drafted meaning of {n}." for n in names}})
        return {"summary": "Drafted summary: dealer-sourced tractor lending.", "tables": out,
                "glossary": [{"term": "Sanction", "meaning": "The credit desk's approval."}], "questions": ["What does stage 'Submitted' cover?"]}
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


DELAY = float(os.environ.get("FAKE_LLM_DELAY", "0"))      # seconds per call; the demo video sets it so that build stages are visible


@app.post("/v1/chat/completions")
async def chat(request: Request):
    body = await request.json()
    await asyncio.sleep(DELAY)
    REQUESTS.append(body)
    prompt = body["messages"][-1]["content"]
    if "BROKEN-JSON" in prompt and "Your previous reply could not be read" not in prompt:
        out = "Sure! Here it is: {not json"
    else:
        out = answer(prompt)
        out = out if isinstance(out, str) else "```json\n" + json.dumps(out) + "\n```"
    resp = {"id": "x", "object": "chat.completion", "model": body.get("model"),
            "choices": [{"index": 0, "message": {"role": "assistant", "content": out}, "finish_reason": "stop"}]}
    if body.get("model") == "no-usage":                 # a gateway that reports no token usage
        return resp
    if body.get("model") == "new-usage-names":          # a server that uses input / output token names
        return {**resp, "usage": {"input_tokens": len(prompt) // 4, "output_tokens": len(out) // 4}}
    return {**resp, "usage": {"prompt_tokens": len(prompt) // 4, "completion_tokens": len(out) // 4}}


@app.post("/v1/messages")
async def messages(request: Request):
    """Anthropic-shaped endpoint (streaming), so the Claude code path is exercised too."""
    from fastapi.responses import StreamingResponse
    body = await request.json()
    await asyncio.sleep(DELAY)
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
