"""Scenario fixtures: a SMALL, deterministic, scripted sample set in the Verizon/Galileo trace schema.

Purpose (Week 1): exercise every L3 intent of taxonomy v0 and every signal type end-to-end, before the
100K synthetic generation (Week 2). Not a statistical sample: never use it for rates or patterns.

Each L3 intent gets two sessions:
  variant A: authenticated, need served, value/buying evidence, resolved-proxy
  variant B: unauthenticated or high-friction, escalated or abandoned
plus special scenarios: multi-intent, thread-linked repeat contacts (need journey), Spanish turn,
tool failure, out-of-scope, location mismatch / destination / [LOCATION] placeholder, no service location.

Truth (scenario id, intents, outcome, planted signal types) is written to a separate file that the pipeline
never reads.   Usage: python -m cie.fixtures
"""
import json, random, uuid
from datetime import datetime, timedelta, timezone
from .config import FIXTURES, FIXTURES_TRUTH, VERSIONS
from .lexicon import CITIES

NS = uuid.UUID("6f1c2a52-0000-4000-8000-00000000c1e0")
T0 = datetime(2026, 9, 14, 13, 0, tzinfo=timezone.utc)

# code: (platform intent_name or None, domain agent role, journey, opener, agent paraphrase, details, evidence)
#   evidence = list of (signal_type, utterance) planted in variant A
CARDS = {
 "BILL.EXPLAIN.CHARGES": ("head_intent.bill_explain", "bill_explain_with_mcp", "bill-explanation",
    "Why is my bill higher than last month?", "customer asking why bill increased", ["It went up about twenty dollars.", "Okay, what's that fee for?"],
    [("price_sensitivity", "That's too much, can I lower my bill?")]),
 "BILL.EXPLAIN.BALANCE": ("head_intent.BillingBalance", "bill_explain_with_mcp", "bill-explanation",
    "What do I owe on this account?", "What do I owe on this account?", ["The main account please."], [("positive_response", "Perfect, thank you so much.")]),
 "BILL.EXPLAIN.STATEMENT": ("head_intent.bill_not_received", "unauth_bill_explain", "bill-explanation",
    "I did not receive my last two statements.", "customer did not receive hard copies of billing statements", ["I want paper copies mailed."], []),
 "BILL.CHARGE.INQUIRY": ("head_intent.charge_inquiry", "bill_explain_with_mcp", "bill-explanation",
    "There's an unexpected charge on my account, what is it?", "review unexpected charge", ["It says equipment charge."], [("confusion", "I don't understand, what is that for?")]),
 "BILL.CHARGE.DISPUTE": ("head_intent.charge_dispute", "bill_explain_with_mcp", "bill-explanation",
    "I'm disputing these TravelPass charges, I wasn't even traveling.", "disputing unexpected TravelPass daily charges", ["Twenty two days of charges."], [("complaint", "This is ridiculous.")]),
 "BILL.CHARGE.FRAUD": ("head_intent.fraud_suspected", "bill_explain_with_mcp", "bill-explanation",
    "Somebody opened a line on my account, it's not my phone.", "unauthorized line, possible fraud", ["I never ordered that phone."], [("frustration", "I'm so frustrated with this.")]),
 "BILL.DUEDATE.CHANGE": ("head_intent.bill_confirm_due_date", "bill_explain_with_mcp", "bill-due-date-change",
    "Can I change my due date to the fifteenth?", "change due date", ["The fifteenth works better with my paycheck."], []),
 "PAY.MAKE.ONE_TIME": (None, "payment_agent", "payment",
    "I want to make a payment on my bill.", "make a payment", ["With my card on file."], [("positive_response", "Great, thanks.")]),
 "PAY.STATUS.NOT_REFLECTED": ("head_intent.payment_status", "bill_explain_with_mcp", "payment",
    "I paid my bill but my phone is still not on.", "I paid my bill but my phone is still not on and service is inactive", ["I paid yesterday."], [("repeat_contact_language", "I already called about this yesterday.")]),
 "PAY.STATUS.FAILED": (None, "payment_agent", "payment",
    "My card was declined when I tried to pay in the app.", "payment declined in app", ["It's a debit card."], []),
 "PAY.ARRANGE.EXTENSION": ("head_intent.payment_arrangement", "payment_agent", "payment-arrangement",
    "I can't pay my bill this month, can I get an extension?", "customer needs payment extension", ["Money is tight until the twentieth."], [("payment_difficulty", "I'm past due and I don't want to be suspended.")]),
 "REFUND.REQUEST.OVERPAYMENT": ("head_intent.bill_refund", "bill_explain_with_mcp", "bill-explanation",
    "I want a refund of my credit balance back to my bank account.", "refund credit balance", ["I paid twice by mistake."], []),
 "REFUND.REQUEST.CREDIT_INQUIRY": ("head_intent.bill_credit_inquiry", "bill_explain_with_mcp", "bill-explanation",
    "I have a question about a credit I was promised.", "question about a credit", ["The last agent said I'd get it."], [("repeat_contact_language", "Nobody called me back about it.")]),
 "ACCT.ACCESS.PIN": ("head_intent.account_access", "authentication_acct_pin", "account-access",
    "I forgot my PIN and can't log in.", "forgot account PIN", ["I don't remember setting one."], []),
 "ACCT.ACCESS.VERIFY": (None, "enhanced_secure_pin", "account-access",
    "The code you texted never arrived.", "verification code not received", ["I checked my messages twice."], []),
 "ACCT.LOOKUP.NUMBER": (None, "unauth_handler", "account-access",
    "I'm calling about a problem with someone's phone number.", "problem with phone number", ["It's my mother's line."], [("confusion", "I'm confused, I don't know what to do.")]),
 "PLAN.ENQUIRY.OPTIONS": ("head_intent.plan_inquiry", "plan_add_change", "plan-change",
    "Which plan is best for me? I keep running out of data.", "plan options, needs more data", ["I use a lot of video."], [("willingness", "Sounds good, sign me up.")]),
 "PLAN.ENQUIRY.COMPARE": ("head_intent.plan_compare", "plan_add_change", "plan-change",
    "What's the difference between the two unlimited plans?", "compare unlimited plans", ["I mostly stream music."], [("feature_comparison", "Does it include hotspot data?")]),
 "PLAN.CHANGE.LOWER_COST": ("head_intent.bill_reduce", "plan_add_change", "plan-change",
    "I would like to know how I can lower my bill.", "I would like to know how I can lower my bill", ["I'm paying too much for what I use."], [("price_sensitivity", "I'm on a tight budget.")]),
 "PLAN.DISCOUNT.PROMO": ("head_intent.discount", "discount_agent", "discount-inquiry",
    "Do you have any discounts for veterans?", "veteran discount inquiry", ["I served in the Army."], [("willingness", "I'd be interested in that.")]),
 "ADDSVC.LINE.ADD": ("head_intent.add_line", "plan_add_change", "add-a-line",
    "I want to add a line for my daughter.", "add a line for daughter", ["She's turning thirteen."], [("multi_line_expansion", "Maybe my son too, so three lines.")]),
 "ADDSVC.CONNECT.HOTSPOT_HOME": ("head_intent.hotspot", "home_internet_agent", "hotspot-home-internet",
    "Do you have 5G home internet at my address?", "5G home internet availability", ["I work from home."], [("willingness", "How do I get it?")]),
 "ADDSVC.TRAVEL.INTERNATIONAL": ("head_intent.international", "travel_pass_agent", "international-travel",
    "I'm traveling to Mexico next week, will my phone work abroad?", "international travel to Mexico", ["About ten days."], [("feature_comparison", "Which one is better, TravelPass or the monthly plan?")]),
 "DEVICE.UPGRADE.ELIGIBILITY": ("head_intent.upgrade", "device_upgrade_agent", "device-upgrade",
    "Am I eligible to upgrade my phone to the new iPhone?", "upgrade eligibility new iPhone", ["I've had this one three years."], [("willingness", "Let's do it.")]),
 "DEVICE.REPLACE.DAMAGE_LOSS": ("head_intent.device_damage", "device_support_agent", "device-damage",
    "I dropped my phone and the screen is cracked.", "cracked screen replacement", ["It still turns on."], [("device_replacement", "I need a replacement phone.")]),
 "DEVICE.ORDER.RETURN_STATUS": ("head_intent.order_status", "order_status_agent", "order-return-status",
    "I returned my equipment and I'm still being charged.", "returned equipment still charged", ["I have the tracking number."], []),
 "SERVICE.CONNECTIVITY.COVERAGE": ("head_intent.cannot_make_receive_call", "network_support_agent", "coverage-issue",
    "I have no signal at my house and my calls keep dropping.", "no signal at home, dropped calls", ["It started last month."], [("coverage_local", "It only happens in my apartment.")]),
 "SERVICE.OUTAGE.DISRUPTION": ("head_intent.outage", "network_support_agent", "service-outage",
    "Is there an outage in my area? My internet is down.", "possible outage", ["Since this morning."], [("local_event", "There was a big storm last night.")]),
 "SERVICE.ACTIVATION.NEW": (None, "device_support_agent", "activation",
    "I need to activate my new phone.", "activate new phone", ["I have the SIM card."], []),
 "RETENTION.CANCEL.INTENT": ("head_intent.cancel_service", "retention_agent", "cancel-service",
    "I want to cancel my service, I'm switching to T-Mobile.", "cancel service, switching carrier", ["It's too expensive here."], [("complaint", "This is unacceptable.")]),
 "GENERAL.INFO.HOURS": (None, "unauth_bill_explain", "general",
    "When is customer service open?", "customer service hours", ["Okay."], []),
 "ESCALATION.REP.REQUEST": ("Operator", "root_agent", "general",
    "Representative, please.", "Speak to someone", ["Representative."], []),
}
AGENT_SAY = {"default": "I can help with that. Let me take a look.", "mid": "Thanks, one moment while I check.",
             "bye": "Thank you for choosing Verizon. Goodbye.", "handoff": "I understand. Let me connect you with an agent.",
             "reask": "I'm sorry, I didn't quite catch that. Could you say that again?"}


class _S:
    """Builder for one session."""

    def __init__(self, sid, t, city, auth, scenario, intents, rng):
        self.sid, self.t, self.city, self.auth, self.scenario, self.intents, self.rng = sid, t, city, auth, scenario, intents, rng
        self.turns, self.planted, self.outcome = [], set(), None

    def turn(self, user, roles_texts, tools=(), tool_fail=None):
        self.turns.append((user, roles_texts, list(tools), tool_fail))

    def plant(self, *types):
        self.planted.update(types)


def _tool(name, role, args=None, failed=False):
    out = {"result": {"status": "error", "message": "upstream timeout"}} if failed else {"result": "done"}
    return {"type": "tool", "name": name, "input": json.dumps([{"role": role, "content": args or {}}]),
            "output": json.dumps([{"role": "tool", "content": out}]), "status_code": "500" if failed else "0"}


def _location(city, mode):
    if mode == "none":
        return {}
    st = next(c for c in CITIES if c[0] == city)
    zip3 = {"FL": "328", "TX": "770", "GA": "303", "AZ": "850", "CO": "802", "IL": "606", "MI": "482", "NC": "282",
            "WA": "981", "NY": "100"}.get(st[1], "999")
    if mode == "nested":
        return {"location": {"city": city, "state": st[1], "zip": zip3 + "01", "market": st[3]}}
    return {"svc_city": city, "svc_state": st[1], "svc_zip3": zip3, "svc_market": st[3], "svc_region": st[2],
            "geo_level": "service_address", "geo_asof": "2026-09-14"}


def _record(s, prev=None, loc_mode="flat"):
    traces, t = [], s.t
    for i, (user, roles_texts, tools, _) in enumerate(s.turns):
        t = t + timedelta(seconds=7 + 3 * (i % 4))
        n = i + 1
        out = [{"role": r, "content": x} for r, x in roles_texts] or None
        u = json.dumps([{"role": "user", "content": user}])
        o = json.dumps(out) if out else None
        tid = str(uuid.uuid5(NS, f"{s.sid}/t{n}"))
        traces.append({"type": "trace", "name": f"turn {n} workflow", "created_at": str(t), "input": u, "redacted_input": u,
                       "output": o, "redacted_output": o, "id": tid, "trace_id": tid, "session_id": s.sid, "user_metadata": {},
                       "tags": [], "status_code": 0, "is_complete": True, "metrics": {"duration_ns": 2_000_000_000 + 1000 * i},
                       "spans": [{"type": "workflow", "name": f"turn {n} workflow", "id": str(uuid.uuid5(NS, f"{s.sid}/w{n}")),
                                  "parent_id": tid, "step_number": "0", "spans": tools}]})
    s.rng.shuffle(traces)                                          # export order is not guaranteed
    flags = s.planted
    resolved = s.outcome == "resolved"
    esc_ok = s.outcome == "escalated" and s.intents[0].startswith(("BILL.CHARGE.FRAUD", "BILL.CHARGE.DISPUTE", "RETENTION", "ESCALATION"))
    metrics = {  # evaluation values derived from the scenario via a rubric (not random)
        "conversation_quality": [1.0 if resolved and not flags & {"frustration", "complaint"} else 0.0],
        "agentic_session_success": [1.0 if resolved or esc_ok else 0.0],
        "agent_efficiency": [0.0 if flags & {"agent_loop", "customer_repeat"} else 1.0],
        "agent_flow": [0.0 if "tool_failure" in flags else 1.0],
        "VZ ContextRecall": 0.0 if "customer_repeat" in flags else 1.0,
        "VZ ContextRecall_rationale": "Rubric-derived (fixture).",
        "cm_session_avg_turn_latency_sec": f"{2.0 + 0.1 * len(s.turns):.2f}",
        "cm_policy_metric": json.dumps({"overall_result": True, "metrics": {
            "journey": CARDS[s.intents[0]][2], "overall_compliance_rate": 1.0 if "tool_failure" not in flags else 0.9,
            "verdicts": [{"policy_id": "GEN-03", "verdict": "PASS" if s.intents[0].startswith("BILL.CHARGE.FRAUD") and s.outcome == "escalated" else "NA",
                          "severity": "CRITICAL", "policy_type": "Escalation", "evidence": "fixture", "reason": "rubric"},
                         {"policy_id": "GEN-07", "verdict": "PASS" if s.outcome != "abandoned" else "FAIL",
                          "severity": "MEDIUM", "policy_type": "Escalation", "evidence": "fixture", "reason": "rubric"}]}}),
    }
    um = _location(s.city, loc_mode)
    rec = {"type": "session", "session_id": s.sid, "id": s.sid, "external_id": f"FIX-{s.scenario}", "name": "",
           "created_at": str(s.t), "previous_session_id": prev, "num_traces": None, "status_code": 0,
           "user_metadata": um, "tags": ["synthetic_fixture", f"scenario:{s.scenario}"],
           "input": traces[0]["input"], "output": traces[0]["output"], "metrics": metrics, "traces": traces,
           "dataset_metadata": {"is_synthetic": True, "batch": "fixtures-w1", "scenario_id": s.scenario,
                                "template_id": s.intents[0], "generator_version": VERSIONS["fixtures"], "seed": 11}}
    truth = {"session_id": s.sid, "scenario": s.scenario, "primary_intent": s.intents[0], "intents": s.intents,
             "outcome": s.outcome, "auth": s.auth, "planted_signals": sorted(s.planted), "service_city": s.city if loc_mode != "none" else None,
             "previous_session_id": prev, "n_traces": len(traces), "n_goal_episodes": len(s.intents)}
    return rec, truth


def _open(s, auth_fail=False):
    s.turn("<event>session start</event>", [("bootstrap_agent", "Thank you for calling Verizon. I'm Verizon's Automated Assistant. How can I help you today?")])
    if s.auth == "auth":
        s.turn("<context>user pressed 1 on keypad.</context>", [("bootstrap_agent", "Thanks, I've confirmed the number you're calling from.")],
               [_tool("set_mdn_confirmation", "bootstrap_agent")])
    else:
        s.turn("<context>user pressed [GENERIC_ID] on keypad.</context>", [("enhanced_secure_pin", "I am sorry, I was unable to find that number on your account.")],
               [_tool("esp_lookup_mdn_role", "enhanced_secure_pin")])
        if auth_fail:
            s.turn("I don't have the pin.", [("enhanced_secure_pin", "I'm sorry, I wasn't able to verify you.")], [_tool("invalid_auth", "enhanced_secure_pin")])
            s.plant("auth_failure")


def _goal(s, code, variant, first=True):
    plat, role, _, opener, para, details, ev = CARDS[code]
    if s.auth == "unauth" and role in ("bill_explain_with_mcp",):
        role = "unauth_bill_explain"
    tools = [_tool("customize_response", role)]
    if plat:
        tools.append(_tool("mandatory_set_intent_for_next_step", "root_agent", {"requested_operator": plat == "Operator", "intent_name": plat}))
    tools.append(_tool("retrieve_intent_matches", "root_agent", {"user_intent": para}))
    if role == "bill_explain_with_mcp":
        tools.append(_tool("explain_bill_init_mcp", role, {"query": para}))
    s.turn(("Also, " + opener[0].lower() + opener[1:]) if not first else opener, [(role, AGENT_SAY["default"])], tools)
    if code == "ESCALATION.REP.REQUEST":
        s.plant("escalation_request")
    for d in details[: (2 if variant == "A" else 1)]:
        s.turn(d, [(role, AGENT_SAY["mid"])])
    if variant == "A":
        for typ, utt in ev:
            s.turn(utt, [(role, AGENT_SAY["mid"])]); s.plant(typ)
    return role


def _close(s, role, outcome, friction=()):
    for f in friction:
        if f == "no_input":
            s.turn("<context>no user activity detected for 9 seconds.</context>", [(role, "Are you still there?")]); s.plant("no_input")
        elif f == "customer_repeat":
            u = s.turns[-1][0] if not s.turns[-1][0].startswith("<") else "I need help with my bill."
            s.turn(u, [(role, AGENT_SAY["reask"])]); s.turn(u, [(role, AGENT_SAY["reask"])]); s.plant("customer_repeat", "agent_loop")
        elif f == "dtmf0":
            s.turn("<context>user pressed 0 on keypad.</context>", [(role, "Okay, one moment.")]); s.plant("dtmf_operator")
        elif f == "frustration":
            s.turn("Oh my god. Get someone on the phone now.", [(role, AGENT_SAY["handoff"])]); s.plant("frustration", "escalation_request")
        elif f == "tool_failure":
            s.turn("Can you check that again?", [(role, "I'm having trouble pulling that up right now.")],
                   [_tool("billing_mcp_retrieve_account_remarks", role, {"remarkType": "PA"}, failed=True)]); s.plant("tool_failure")
        elif f == "out_of_scope":
            s.turn("Can you help me with my car insurance?", [("root_agent", "I'm set up to help with Verizon-related things.")],
                   [_tool("handle_out_of_scope", "root_agent", {"user_utterance": "car insurance", "topic": "out_of_scope"})]); s.plant("out_of_scope")
    s.outcome = outcome
    if outcome == "escalated":
        if "escalation_request" not in s.planted:
            s.turn("I want to talk to a live agent.", [(role, AGENT_SAY["handoff"])]); s.plant("escalation_request")
        s.turn("Okay.", [("root_agent", "Just a moment")], [_tool("updated_billing_transfer_call", "root_agent", {"action": "transfer_to_agent"})])
        s.plant("agent_handoff")
    elif outcome == "abandoned":
        if "no_input" not in s.planted:
            s.turn("<context>no user activity detected for 9 seconds.</context>", [(role, "Are you still there?")]); s.plant("no_input")
        s.turn("<context>no user activity detected for 9 seconds.</context>", [(role, "I haven't heard anything.")])
        s.turn("<event>sys.remote-call-disconnected</event>", [])
        s.plant("abandoned")
    else:
        s.turn("That's all, thank you.", [(role, AGENT_SAY["bye"])])


def build():
    rng = random.Random(11)
    cities = [c[0] for c in CITIES]
    recs, truths = [], []
    k = 0

    def sid(tag):
        return str(uuid.uuid5(NS, tag))

    def new(tag, t, city, auth, intents):
        return _S(sid(tag), t, city, auth, tag, intents, random.Random(tag))
    # ---- two variants per L3 intent
    for i, code in enumerate(CARDS):
        for v in ("A", "B"):
            k += 1
            t = T0 + timedelta(days=(k % 10), minutes=37 * k)
            city = cities[(3 * k) % len(cities)]
            auth = "auth" if v == "A" else "unauth"
            s = new(f"{code}:{v}", t, city, auth, [code])
            _open(s, auth_fail=(v == "B" and i % 2 == 0))
            role = _goal(s, code, v)
            if v == "A":
                _close(s, role, "resolved")
            else:
                fr = [["no_input"], ["customer_repeat"], ["dtmf0"], ["frustration"], ["tool_failure"]][i % 5]
                _close(s, role, "abandoned" if i % 3 == 0 else "escalated", fr)
            r, tr = _record(s, loc_mode="nested" if k % 9 == 0 else "flat")
            recs.append(r); truths.append(tr)
    # ---- special scenarios
    def special(tag, intents, auth, city, outcome, extra_user=(), friction=(), prev=None, loc="flat", day=0):
        t = T0 + timedelta(days=day, hours=2)
        s = new(tag, t, city, auth, intents)
        _open(s)
        role = None
        for j, code in enumerate(intents):
            role = _goal(s, code, "A", first=(j == 0))
        for typ, utt in extra_user:
            s.turn(utt, [(role, AGENT_SAY["mid"])]); s.plant(typ)
        _close(s, role, outcome, friction)
        r, tr = _record(s, prev=prev, loc_mode=loc)
        recs.append(r); truths.append(tr)
        return r["session_id"]
    # multi-intent: bill question then upgrade (cross-sell)
    special("SPECIAL:multi_bill_then_upgrade", ["BILL.EXPLAIN.CHARGES", "DEVICE.UPGRADE.ELIGIBILITY"], "auth", "Charlotte", "resolved")
    special("SPECIAL:multi_travel_then_hotspot", ["ADDSVC.TRAVEL.INTERNATIONAL", "ADDSVC.CONNECT.HOTSPOT_HOME"], "auth", "Orlando", "resolved",
            extra_user=[("city_mention", "I'm flying to Miami first, then Cancun.")])
    # thread: outage -> repeat -> cancel (need journey + repeat contact + repeat_same_issue)
    a = special("THREAD:outage_1", ["SERVICE.OUTAGE.DISRUPTION"], "auth", "Houston", "escalated", day=1)
    b = special("THREAD:outage_2", ["SERVICE.OUTAGE.DISRUPTION"], "auth", "Houston", "abandoned",
                extra_user=[("repeat_contact_language", "This is the third time I'm calling, same problem.")], prev=a, day=3)
    special("THREAD:outage_3_cancel", ["RETENTION.CANCEL.INTENT"], "auth", "Houston", "escalated",
            extra_user=[("frustration", "I'm fed up.")], prev=b, day=6)
    # thread: dispute -> resolved follow-up (issue resolved supersedes open_issue)
    c = special("THREAD:dispute_1", ["BILL.CHARGE.DISPUTE"], "auth", "Phoenix", "escalated", day=2)
    special("THREAD:dispute_2_resolved", ["BILL.CHARGE.DISPUTE"], "auth", "Phoenix", "resolved",
            extra_user=[("positive_response", "That helps, thank you so much.")], prev=c, day=5)
    # location typing / mismatch / placeholder / missing location
    special("SPECIAL:location_mismatch_current", ["SERVICE.CONNECTIVITY.COVERAGE"], "auth", "Denver", "resolved",
            extra_user=[("city_mention", "I'm in Seattle right now visiting family and there's no signal.")])
    special("SPECIAL:location_placeholder", ["SERVICE.CONNECTIVITY.COVERAGE"], "auth", "Atlanta", "resolved",
            extra_user=[("location_unresolved", "I live in [LOCATION] and it's a dead zone.")])
    special("SPECIAL:no_service_location", ["BILL.EXPLAIN.BALANCE"], "auth", "Chicago", "resolved", loc="none")
    # Spanish turn + out-of-scope + tool failure
    special("SPECIAL:spanish", ["BILL.EXPLAIN.CHARGES"], "auth", "Miami", "escalated",
            extra_user=[("lang_es", "Necesito ayuda con mi factura, por favor.")])
    special("SPECIAL:out_of_scope", ["GENERAL.INFO.HOURS"], "unauth", "Detroit", "resolved", friction=["out_of_scope"])
    special("SPECIAL:household_value", ["ADDSVC.LINE.ADD", "PLAN.CHANGE.LOWER_COST"], "auth", "Austin", "resolved",
            extra_user=[("multi_line_expansion", "It's for my whole family."), ("willingness", "I'd like to add them today.")])
    for tr in truths:   # remove non-catalogue markers from planted set
        tr["planted_signals"] = [x for x in tr["planted_signals"] if x != "lang_es"]
    return recs, truths


def write():
    recs, truths = build()
    FIXTURES.parent.mkdir(parents=True, exist_ok=True)
    with open(FIXTURES, "w") as f:
        for r in recs:
            f.write(json.dumps(r) + "\n")
    json.dump({"note": "Truth for scenario fixtures. The pipeline never reads this file.", "version": VERSIONS["fixtures"],
               "sessions": truths}, open(FIXTURES_TRUTH, "w"), indent=1)
    n_tr = sum(t["n_traces"] for t in truths)
    print(f"fixtures: {len(recs)} sessions, {n_tr} traces (mean {n_tr / len(recs):.1f}) -> {FIXTURES}")


if __name__ == "__main__":
    write()
