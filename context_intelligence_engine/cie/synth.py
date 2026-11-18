"""Synthetic VzGPT-shaped trace generator (100K sessions x ~7 traces) with planted ground truth.

Why synthetic?  Verizon supplied 36 sessions (mostly billing/IVR). Phase-1 insights (geo mix, temporal
history, upsell clusters) need volume and variety, so we generate sessions that follow the *same
schema* (session -> traces -> workflow span -> tool spans, `turn N workflow`, role == agent name,
`<event>/<context>` system turns, redacted text) and plant known effects so the pipeline can be
validated against truth it never sees (ground truth is written to a separate file).

Two phrasing banks are used: bank "A" (the wording the lexicons were developed against) and bank
"B" (held-out paraphrases).  Reporting extractor recall on A vs B gives an honest generalisation gap.

Usage: python -m cie.synth --sessions 100000 --seed 7
"""
import argparse, gzip, json, math, random, time, multiprocessing as mp
from datetime import datetime, timedelta, timezone
from .config import SYNTH_PATH, GT_PATH, DATA
from .lexicon import CITIES

T0 = datetime(2026, 8, 24, 0, 0, tzinfo=timezone.utc)   # 12 weeks: Aug-24 .. Nov-15
N_WEEKS = 12

# ------------------------------------------------------------------ intents
# key: (journey, domain agent, platform intent_name, base prob)
INTENTS = {
    "bill_explain":       ("bill-explanation", "bill_explain_with_mcp", "head_intent.bill_explain_incorrect", .19),
    "unauthorized_charge": ("charge-dispute", "bill_explain_with_mcp", "head_intent.charge_dispute", .05),
    "payment_help":       ("payment-arrangement", "payment_agent", "head_intent.bill_confirm_due_date", .08),
    "upgrade_device":     ("device-upgrade", "device_upgrade_agent", "head_intent.upgrade", .09),
    "add_line":           ("add-a-line", "plan_add_change", "head_intent.add_line", .06),
    "plan_price":         ("plan-change", "plan_add_change", "head_intent.plan_change", .07),
    "travel_intl":        ("international-travel", "travel_pass_agent", "head_intent.international_billing", .05),
    "hotspot_home":       ("hotspot-home-internet", "home_internet_agent", "head_intent.hotspot", .04),
    "coverage_issue":     ("coverage-issue", "network_support_agent", "head_intent.cannot_make_receive_call", .07),
    "device_damage":      ("device-damage", "device_support_agent", "head_intent.device_damage", .05),
    "discount_inquiry":   ("discount-inquiry", "discount_agent", "head_intent.bill_reduce", .05),
    "churn_threat":       ("cancel-service", "retention_agent", "head_intent.cancel_service", .04),
    "order_return":       ("order-return-status", "order_status_agent", "head_intent.order_status", .04),
    "account_access":     ("account-access", "authentication_acct_pin", "head_intent.account_access", .06),
    "service_outage":     ("service-outage", "network_support_agent", "head_intent.outage", .06),
}
KEYS = list(INTENTS)

OPEN = {  # opener banks
    "bill_explain": (["I need help understanding my bill this month", "why is my bill higher than last month", "can you explain the charges on my bill"],
                     ["my statement looks different this time around", "what exactly am I being billed for", "the total on my invoice jumped"]),
    "unauthorized_charge": (["there is a charge on my account I did not authorize", "I'm disputing a charge from Verizon", "there's a fraudulent charge on my bill"],
                            ["I see money taken that I never agreed to", "somebody took money out and it wasn't me", "this amount showed up and I have no idea where it came from"]),
    "payment_help": (["I can't make my payment this month, can I get an extension", "I need to change my due date", "I'm past due and want a payment arrangement"],
                     ["I'm a little short until payday", "could I pay half now and the rest later", "money is tight right now and the bill is due"]),
    "upgrade_device": (["I want to upgrade my phone", "am I eligible for a new iPhone", "I'd like to trade in my phone for the latest Galaxy"],
                       ["my phone is getting old and slow what are my options", "thinking about getting the newest handset from you guys", "what can I get for my old phone"]),
    "add_line": (["I want to add a line for my daughter", "can I add another line to my account", "I need a new line for my husband"],
                 ["my son is finally old enough for his own phone", "we need a phone for my mother in law on our account", "one more person is joining our account"]),
    "plan_price": (["I want a cheaper plan", "which plan is best for me", "my bill is too high, can I change my plan"],
                   ["is there a lower tier I could move down to", "I think I'm paying for more than I use", "what are my options besides what I have now"]),
    "travel_intl": (["I'm traveling to {dest} next week and need an international plan", "tell me about TravelPass", "will my phone work abroad"],
                    ["heading to {dest} for a couple of weeks will my phone work there", "my daughter is studying overseas how do I call her", "I'm flying out of the country soon"]),
    "hotspot_home": (["I need a hotspot for my laptop", "do you have 5G home internet at my address", "I want to set up tethering"],
                     ["I work from my truck and need a connection for my computer", "can I get internet at my house without cable", "I need data for my tablet when I'm away from home"]),
    "coverage_issue": (["I have no signal at my house", "my calls keep dropping", "there is a dead zone in my neighborhood"],
                       ["I can't hear anyone when I'm home and the bars keep disappearing", "my phone barely works inside my apartment", "reception is awful where I live"]),
    "device_damage": (["I cracked my screen", "my phone was stolen", "I dropped my phone in water and it's dead"],
                      ["my handset took a swim in the lake", "the display got smashed", "I can't find my phone anywhere, I think it's gone"]),
    "discount_inquiry": (["do you have any discounts or promos", "I want to lower my bill", "is there a deal for long time customers"],
                         ["are there offers for loyal customers", "any way to get my monthly price down", "I heard you have something for veterans"]),
    "churn_threat": (["I want to cancel my service", "I'm switching to T-Mobile", "I'm thinking of leaving Verizon"],
                     ["I've had enough, I'm taking my business elsewhere", "give me one reason to stay", "I'm done with this company"]),
    "order_return": (["where is my order", "I returned my equipment and I'm still being charged", "I never received my package"],
                     ["the box I sent back hasn't been confirmed", "my shipment was supposed to arrive last week", "tracking says delivered but nothing came"]),
    "account_access": (["I forgot my PIN", "I can't log in to my account", "I need to reset my password"],
                       ["the code you texted never arrived", "it keeps saying my account number is wrong", "I'm locked out of everything"]),
    "service_outage": (["my service is out", "there's a power outage and my internet is down", "is there an outage in my area"],
                       ["nothing works at my place since this morning", "all my devices lost connection a while ago", "the whole block is offline"]),
}
DETAIL = ["Yes.", "No.", "Yeah that's right.", "It's the main line on the account.", "About two weeks ago.", "Uh, I think so.",
          "Mm-hm.", "Okay.", "It started last week.", "Just the one phone.", "Right, that one.", "I'm not sure, maybe.", "Sure.", "Can you check that for me?"]
SIG = {  # injected signal phrases: type -> (bank A, bank B)
    "willingness": (["I'd be interested in that", "yes please go ahead and add it", "sounds good, sign me up", "let's do it"],
                    ["okay that works for me", "alright I'll go with that one", "fine, put that through", "yeah I want that option"]),
    "price_sensitivity": (["that's too expensive", "do you have a cheaper option", "I'm on a tight budget", "why did my bill go up"],
                          ["hmm that's a lot for me right now", "I can't stretch that far each month", "is there anything lower than that", "money's been tight"]),
    "feature_comparison": (["what's the difference between those two", "does it include hotspot data", "which one is better"],
                           ["how does that stack up with the other carriers", "is the bigger one really worth the extra", "what do I actually get with each"]),
    "multi_line_expansion": (["I have three lines on my account", "it's for my whole family", "I want to add my kids too"],
                             ["there are five of us on the plan", "everyone in the house needs one", "my wife and the kids as well"]),
    "device_replacement": (["my screen is cracked", "I need a replacement phone"], ["the display is smashed", "I need another handset"]),
    "escalation_request": (["let me talk to a live agent", "I want a representative", "get me a real person", "I need to speak to a supervisor"],
                           ["can I get a human on the line", "put someone on who can actually help", "I'd rather talk to somebody directly", "connect me with your team"]),
    "complaint": (["this is ridiculous", "I'm so frustrated with this", "this is unacceptable"],
                  ["this is getting me nowhere", "I've wasted enough time on this", "I'm really not happy about all this"]),
    "repeat_contact_language": (["I already called about this yesterday", "this is the third time I'm calling", "it's still not fixed, same problem"],
                                ["I keep having to bring this up again", "nobody has gotten back to me about it", "I was told this would be handled"]),
    "churn_intent": (["I'll cancel my service if this isn't fixed", "I'm going to switch to AT&T"], ["I'll take my business elsewhere", "maybe it's time to look at other carriers"]),
    "local_event": (["there was a big storm last night", "I just moved to a new house"], ["the game this weekend is packing the whole area", "we had a transformer blow near us"]),
}
CITY_PH = (["I'm calling from {city}", "I live in {city}", "I'm at my house in {city}"], ["we're based in {city}", "up here near {city}", "I'm out in {city} right now"])
DEST = ["Mexico", "Europe", "London", "Paris", "Cancun", "Japan", "Italy", "Canada", "Brazil", "India", "Ireland", "Spain"]
AGENT_OPEN = {
    "bill_explain": ["I can help you understand your bill. One moment while I pull up your account.", "Let me look at your recent charges."],
    "unauthorized_charge": ["I'm sorry about that. Let me check the charge you're asking about.", "I understand your concern, let me look into that."],
    "payment_help": ["I can help with your payment. Let me check your options.", "Let me look at your due date and balance."],
    "upgrade_device": ["I can help you with an upgrade. Let me check your eligibility.", "Happy to look at upgrade options for you."],
    "add_line": ["I can help you add a line. Which plan would you like it on?", "Sure, let's get another line set up."],
    "plan_price": ["I can review your plan options. Let me look at what you have now.", "Let's see how we can fit your needs."],
    "travel_intl": ["I can help with international options. Where are you headed?", "TravelPass could be a fit. Let me explain how it works."],
    "hotspot_home": ["I can look at hotspot and home internet options for you.", "Let me check availability for your address."],
    "coverage_issue": ["I'm sorry you're having trouble with your signal. Let me check the network in your area.", "Let me look at coverage where you are."],
    "device_damage": ["I'm sorry to hear that. Let me see your protection and replacement options.", "I can help with a replacement."],
    "discount_inquiry": ["Let me check which offers your account qualifies for.", "I can look for savings on your account."],
    "churn_threat": ["I'm sorry to hear that. Let me see what I can do to help.", "I understand. Can you tell me what's driving that?"],
    "order_return": ["Let me check the status of your order.", "I can look up your return."],
    "account_access": ["I can help you get back into your account. For security I need to verify you.", "Let's reset that. First, let me verify your identity."],
    "service_outage": ["I'm sorry your service is out. Let me check for outages in your area.", "Let me look at the network status."],
}
AGENT_MID = ["Let me check that for you.", "Thanks for that detail. One moment.", "I see. Let me look at the account.", "Okay, I'm working on that now.", "Got it, thank you."]
AGENT_REASK = "I'm sorry, I didn't quite catch that. Could you tell me again what you need help with today?"
BYE = "Thank you for choosing Verizon. Goodbye."

# ------------------------------------------------------------------ planted truth
PLANTED = [  # (city, intent, multiplier, week_from, week_to)   weeks are 0-based, inclusive
    ("Orlando", "travel_intl", 4.0, 0, 11), ("Miami", "travel_intl", 3.0, 0, 11),
    ("Austin", "add_line", 2.6, 0, 11), ("Phoenix", "coverage_issue", 3.5, 0, 11),
    ("Denver", "hotspot_home", 3.0, 0, 11), ("Detroit", "discount_inquiry", 3.0, 0, 11),
    ("Detroit", "plan_price", 2.0, 0, 11), ("Charlotte", "upgrade_device", 2.5, 0, 11),
    ("Chicago", "payment_help", 2.5, 0, 11),
    ("Houston", "service_outage", 7.0, 8, 10),      # emerging, time-boxed (storm)
    ("Atlanta", "travel_intl", 4.0, 9, 11),         # emerging, time-boxed (event travel)
]
SEQUENCES = {  # prior intent -> (follow-up intent, prob when prior unresolved)
    "service_outage": ("churn_threat", .42), "coverage_issue": ("churn_threat", .30),
    "unauthorized_charge": ("bill_explain", .45), "device_damage": ("upgrade_device", .40),
}
PERSONAS = {  # persona: (prior, {intent: weight multiplier}, sig propensities)
    "value_seeker": (.17, {"discount_inquiry": 4, "plan_price": 3, "bill_explain": 1.4, "payment_help": 1.5}, {"price_sensitivity": .55, "feature_comparison": .2}),
    "household_builder": (.12, {"add_line": 5, "plan_price": 1.5, "upgrade_device": 1.5}, {"multi_line_expansion": .5, "willingness": .35}),
    "traveler": (.08, {"travel_intl": 6, "hotspot_home": 1.5}, {"willingness": .3, "feature_comparison": .25}),
    "upgrader": (.13, {"upgrade_device": 4, "device_damage": 2, "plan_price": 1.3}, {"willingness": .4, "feature_comparison": .35, "price_sensitivity": .2}),
    "connectivity_dependent": (.12, {"hotspot_home": 5, "coverage_issue": 4, "service_outage": 2.5}, {"complaint": .25, "feature_comparison": .2}),
    "billing_focused": (.20, {"bill_explain": 3, "payment_help": 2.5, "unauthorized_charge": 3, "order_return": 2}, {"price_sensitivity": .12}),
    "at_risk": (.08, {"churn_threat": 8, "coverage_issue": 2, "service_outage": 2, "unauthorized_charge": 1.5}, {"complaint": .6, "repeat_contact_language": .45, "churn_intent": .3}),
    "general": (.10, {}, {}),
}
P_CITY_MENTION, P_CITY_VISIBLE = 0.50, 0.50   # mention rate; chance the (vendor-redacted) text keeps the raw city


def _wchoice(rng, items, weights):
    tot = sum(weights); x = rng.random() * tot; acc = 0
    for it, w in zip(items, weights):
        acc += w
        if x <= acc: return it
    return items[-1]


def _intent_weights(persona, city, week):
    pm = PERSONAS[persona][1]
    w = []
    for k in KEYS:
        v = INTENTS[k][3] * pm.get(k, 1.0)
        for c, i, m, w0, w1 in PLANTED:
            if c == city and i == k and w0 <= week <= w1: v *= m
        if k == "hotspot_home": v *= 1 + 0.045 * week          # global slow-burn trend
        w.append(v)
    return w


def _ev(t): return {"role": "user", "content": t}


def gen_thread(rng, tid, city_w, city_names):
    """One contact thread = root session + 0..3 follow-ups (previous_session_id chain). Returns list of (rec, gt)."""
    out = []
    persona = _wchoice(rng, list(PERSONAS), [PERSONAS[p][0] for p in PERSONAS])
    city = _wchoice(rng, city_names, city_w)
    auth = "unauth" if rng.random() < .46 else "auth"
    week = rng.randrange(N_WEEKS)
    t = T0 + timedelta(weeks=week, days=rng.randrange(7), hours=rng.randrange(7, 22), minutes=rng.randrange(60), seconds=rng.randrange(60))
    prev, prev_intent, prev_outcome, depth = None, None, None, 0
    forced = None
    while True:
        wk = int((t - T0).days // 7)
        if wk >= N_WEEKS + 1: break
        if forced:
            intent = forced
        else:
            intent = _wchoice(rng, KEYS, _intent_weights(persona, city, min(wk, N_WEEKS - 1)))
        rec, gt = gen_session(rng, f"{tid}-{depth}", t, persona, city, auth, intent, prev, wk, depth)
        out.append((rec, gt))
        prev, prev_outcome, prev_intent = rec["session_id"], gt["outcome"], intent
        # follow-up logic -> temporal/sequence structure
        forced = None
        p_follow = .50 if gt["outcome"] != "resolved" else .07
        if depth >= 3 or rng.random() > p_follow: break
        if prev_intent in SEQUENCES and prev_outcome != "resolved" and rng.random() < SEQUENCES[prev_intent][1] / max(p_follow, .01) * .5 + .0:
            forced = SEQUENCES[prev_intent][0]
        elif rng.random() < .68:
            forced = prev_intent
        depth += 1
        t = t + timedelta(days=rng.randint(1, 6), hours=rng.randint(-3, 6), minutes=rng.randrange(60))
    return out


def gen_session(rng, sid, t, persona, city, auth, intent, prev, week, depth):
    journey, domain, platform, _ = INTENTS[intent]
    bank = 0 if rng.random() < .6 else 1                       # 60% bank A, 40% held-out bank B
    sigp = PERSONAS[persona][2]
    plan = []                                                  # list of dict(user, agent_role(s), agent_text, tools)
    planted = {}                                               # signal types deliberately injected (truth)
    friction = min(1.0, max(0.0, rng.betavariate(1.3, 3.2) + (.25 if auth == "unauth" else 0) + (.2 if depth else 0)))

    def sig_phrase(typ):
        phr = rng.choice(SIG[typ][bank]); planted[typ] = planted.get(typ, 0) + 1; return phr

    # decide city text
    mention = rng.random() < P_CITY_MENTION
    visible = rng.random() < P_CITY_VISIBLE
    shown_city, dest_conf = None, False
    if mention:
        shown_city = city
        if intent == "travel_intl" and rng.random() < .10:      # destination city confound
            shown_city = rng.choice([c[0] for c in CITIES if c[0] != city]); dest_conf = True
    city_text = None
    if shown_city:
        cn = shown_city if visible else "[LOCATION]"
        city_text = rng.choice(CITY_PH[bank]).format(city=cn) if not dest_conf else f"I'm flying to {cn} for a few days"

    # ---- phase 1: bootstrap/auth
    plan.append(dict(user="<event>session start</event>", role="bootstrap_agent", text="Thank you for calling Verizon. I'm Verizon's Automated Assistant. How can I help you today?", tools=[]))
    auth_failed = False
    if auth == "unauth":
        if rng.random() < .5:
            plan.append(dict(user="<context>no user activity detected for 9 seconds.</context>", role="enhanced_secure_pin", text="It looks like we didn't receive a response. Please enter the ten digit mobile number.", tools=[("esp_set_pin_collection_mode", {})]))
        plan.append(dict(user="<context>user pressed [GENERIC_ID] on keypad.</context>", role="enhanced_secure_pin", text="I am sorry, I was unable to find that number on your account.", tools=[("esp_lookup_mdn_role", {})]))
        auth_failed = rng.random() < .55
        if auth_failed:
            plan.append(dict(user="I don't have the pin", role="authentication_acct_pin", text="That PIN did not match. Please try again.", tools=[("action_validate_account_pin", {})]))
    # ---- phase 2: goal episode(s)
    episodes = [intent]
    if rng.random() < .22:
        episodes.append(_wchoice(rng, KEYS, _intent_weights(persona, city, min(week, N_WEEKS - 1))))
    unresolved_drive = friction
    n_target = max(4, min(14, int(round(rng.gauss(7, 2.1)))))
    for ei, it in enumerate(episodes):
        jn, dom, plat, _ = INTENTS[it]
        role = "unauth_bill_explain" if (auth_failed and ei == 0) else dom
        opener = rng.choice(OPEN[it][bank]).format(dest=rng.choice(DEST))
        if ei == 1: opener = "Also, " + opener[0].lower() + opener[1:]
        if depth and ei == 0 and rng.random() < .55: opener += ". " + sig_phrase("repeat_contact_language")
        if city_text and ei == 0 and rng.random() < .8: opener += ", " + city_text
        tools = [("customize_response", {}), ("mandatory_set_intent_for_next_step", {"requested_operator": False, "intent_name": plat}),
                 ("retrieve_intent_matches", {"user_intent": opener.split(",")[0][:80]})]
        plan.append(dict(user=opener, role=role, text=rng.choice(AGENT_OPEN[it]), tools=tools, ep=ei, intent=it))
        # persona / intent driven signals
        pool = []
        for typ, p in sigp.items():
            if rng.random() < p: pool.append(typ)
        if it == "discount_inquiry" and rng.random() < .5: pool.append("price_sensitivity")
        if it in ("add_line",) and rng.random() < .4: pool.append("multi_line_expansion")
        if it == "upgrade_device" and rng.random() < .35: pool.append("feature_comparison")
        if it == "device_damage" and rng.random() < .55: pool.append("device_replacement")
        if it in ("unauthorized_charge", "churn_threat", "service_outage", "coverage_issue") and rng.random() < friction + .15: pool.append("complaint")
        if it == "service_outage" and rng.random() < .35: pool.append("local_event")
        if it in ("upgrade_device", "add_line", "plan_price", "hotspot_home", "travel_intl") and rng.random() < .35: pool.append("willingness")
        pool = list(dict.fromkeys(pool))
        rng.shuffle(pool)
        n_det = max(0, n_target - len(plan) - 2) // len(episodes) if ei == 0 else max(1, (n_target - len(plan)) // 2)
        n_det = max(1, n_det)
        last_user = opener
        for di in range(n_det):
            if pool and rng.random() < .65:
                u = sig_phrase(pool.pop())
            elif friction > .45 and rng.random() < .30:
                u = "<context>no user activity detected for 9 seconds.</context>"
            elif friction > .5 and rng.random() < .25:
                u = last_user if len(last_user) < 80 else rng.choice(DETAIL)            # customer repeats self
            else:
                u = rng.choice(DETAIL)
            reask = friction > .5 and rng.random() < .25
            plan.append(dict(user=u, role=role, text=AGENT_REASK if reask else (rng.choice(AGENT_MID)), tools=[], ep=ei, intent=it))
            last_user = u
        while pool and ei == 0 and len(plan) < 16:                                       # make sure planted signals actually surface
            plan.append(dict(user=sig_phrase(pool.pop()), role=role, text=rng.choice(AGENT_MID), tools=[], ep=ei, intent=it))
    # ---- phase 3: outcome
    p_esc = {"churn_threat": .55, "unauthorized_charge": .5, "service_outage": .35, "device_damage": .3}.get(intent, .18) + .35 * friction + (.25 if auth_failed else 0)
    r = rng.random()
    if r < p_esc: outcome = "escalated"
    elif r < p_esc + .05 + .22 * friction * (1.2 if auth == "unauth" else .6): outcome = "abandoned"
    else: outcome = "resolved"
    role = plan[-1]["role"]
    if outcome == "escalated":
        if rng.random() < .75: plan.append(dict(user=sig_phrase("escalation_request"), role=role, text="I understand. Let me connect you with an agent.", tools=[]))
        if rng.random() < .35: plan.append(dict(user="<context>user pressed 0 on keypad.</context>", role=role, text="Okay, connecting you now.", tools=[]))
        plan.append(dict(user=rng.choice(["Okay.", "Yes please.", "Thank you."]), role="root_agent", text="Just a moment", tools=[("updated_billing_transfer_call", {"action": "transfer_to_agent"})]))
    elif outcome == "abandoned":
        if rng.random() < .5: plan.append(dict(user="<context>no user activity detected for 9 seconds.</context>", role=role, text="Are you still there?", tools=[]))
        plan.append(dict(user="<event>sys.remote-call-disconnected</event>", role=None, text=None, tools=[]))
    else:
        plan.append(dict(user=rng.choice(["That's all, thank you.", "No, that's everything.", "Okay, thanks."]), role=role, text=BYE, tools=[]))

    # ---- assemble session record in Verizon trace schema
    off = rng.choice([0, 0, 0, 2, 5, 8, 12])                    # real exports are windows; turn numbers needn't start at 1
    traces = []
    tcur = t
    for i, p in enumerate(plan):
        tcur = tcur + timedelta(seconds=rng.randint(4, 28))
        agent_msgs = [] if p["role"] is None else [{"role": p["role"], "content": p["text"]}]
        if p.get("tools") and any(n.endswith("transfer_call") for n, _ in p["tools"]):
            agent_msgs.insert(0, {"role": role, "content": "Please hold while I transfer you."}) if rng.random() < .5 else None
        spans_tools = [{"type": "tool", "name": n, "input": json.dumps([{"role": p["role"] or "root_agent", "content": a}]),
                        "output": json.dumps([{"role": "tool", "content": {"result": "done"}}])} for n, a in p["tools"]]
        u = json.dumps([_ev(p["user"])]); o = json.dumps(agent_msgs) if agent_msgs else None
        traces.append({"type": "trace", "name": f"turn {i + 1 + off} workflow", "created_at": str(tcur), "input": u, "redacted_input": u,
                       "output": o, "redacted_output": o, "metrics": {},
                       "spans": [{"type": "workflow", "name": f"turn {i + 1 + off} workflow", "spans": spans_tools}]})
    rng.shuffle(traces)                                         # export order is not guaranteed
    succ = 1.0 if (outcome == "resolved" and rng.random() < .9) or (outcome == "escalated" and rng.random() < .5) else 0.0
    rec = {"type": "session", "session_id": sid, "external_id": f"SYN-{sid}", "created_at": str(t), "previous_session_id": prev,
           "num_traces": None, "status_code": 0, "user_metadata": {}, "tags": [], "input": traces[0]["input"], "output": traces[0]["output"],
           "metrics": {"conversation_quality": [round(rng.random() * .3 + (.7 if outcome == "resolved" else .35), 2)],
                       "agentic_session_success": [succ], "agent_efficiency": [round(1 - friction * .6, 2)], "agent_flow": [1.0 if friction < .6 else 0.0],
                       "cm_session_avg_turn_latency_sec": str(round(1.2 + rng.random() * 3, 2)),
                       "cm_policy_metric": json.dumps({"overall_result": True, "metrics": {"journey": journey, "overall_compliance_rate": round(.85 + rng.random() * .15, 2)}})},
           "traces": traces}
    vis_city = shown_city if (mention and visible) else None
    gt = {"session_id": sid, "persona": persona, "true_city": city, "intents": episodes, "primary_intent": intent, "outcome": outcome,
          "n_episodes_goal": len(episodes), "auth_state": auth, "auth_failed": auth_failed, "planted_signals": planted, "bank": "AB"[bank],
          "city_visible": vis_city, "city_is_destination": dest_conf and visible, "city_mentioned": mention, "week": week, "depth": depth,
          "prev": prev, "friction": round(friction, 3), "n_turns": len(plan)}
    return rec, gt


def _worker(args):
    seed, n_threads, start = args
    rng = random.Random(seed)
    cities = [c[0] for c in CITIES]
    rng2 = random.Random(1)  # city weights fixed across workers (population-like)
    cw = [rng2.choice([.6, .8, 1, 1, 1.3, 1.6, 2.2]) for _ in cities]
    recs, gts = [], []
    for i in range(n_threads):
        for rec, gt in gen_thread(rng, f"S{start + i:06d}", cw, cities):
            recs.append(json.dumps(rec, separators=(",", ":")))
            gts.append(gt)
    return recs, gts


def generate(n_sessions=100_000, seed=7, out=SYNTH_PATH, gt_out=GT_PATH, procs=4):
    DATA.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    per = 2500
    n_threads_total = int(n_sessions / 1.6 * 1.15)             # ~1.6 sessions/thread; oversample then truncate
    jobs = [(seed * 7919 + k, min(per, n_threads_total - k * per), k * per) for k in range(math.ceil(n_threads_total / per))]
    written, all_gt, turns = 0, [], 0
    with gzip.open(out, "wt", compresslevel=3) as f, mp.Pool(procs) as pool:
        for recs, gts in pool.imap(_worker, jobs):
            for r, g in zip(recs, gts):
                if written >= n_sessions: break
                f.write(r + "\n"); all_gt.append(g); written += 1; turns += g["n_turns"]
            if written >= n_sessions: pool.terminate(); break
    meta = {"seed": seed, "n_sessions": written, "avg_turns": turns / max(written, 1), "planted": PLANTED, "sequences": SEQUENCES,
            "p_city_mention": P_CITY_MENTION, "p_city_visible": P_CITY_VISIBLE, "weeks": N_WEEKS, "t0": str(T0)}
    with gzip.open(gt_out, "wt") as f: json.dump({"meta": meta, "sessions": all_gt}, f, separators=(",", ":"))
    print(f"generated {written:,} sessions, avg {turns / written:.2f} turns/session in {time.time() - t0:.0f}s -> {out}")
    return meta


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--sessions", type=int, default=100_000); ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default=str(SYNTH_PATH)); ap.add_argument("--gt", default=str(GT_PATH))
    a = ap.parse_args()
    generate(a.sessions, a.seed, a.out, a.gt)
