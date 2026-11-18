"""WP0: scenario-first synthetic generator (100K complete sessions, mean ~7 traces) per docs/scenario_catalogue.md Part B.

Output follows the Verizon/Galileo trace schema (same as the real sample and the fixtures). Every session carries
provenance (batch, scenario_id, template_id, generator_version, seed, split, bank) in dataset_metadata.
Ground truth goes to a separate file that only validate.py / tests read.

  python -m cie.synth --sessions 100000 --seed 7
"""
import argparse, gzip, json, math, random, time, uuid, multiprocessing as mp
from datetime import datetime, timedelta, timezone
from .config import DATA
from .fixtures import CARDS, _tool, AGENT_SAY
from .lexicon import CITIES

GEN_VERSION = "2.0.0"
SYNTH_PATH = DATA / "synthetic_traces.jsonl.gz"
GT_PATH = DATA / "synthetic_ground_truth.jsonl.gz"
T0 = datetime(2026, 8, 24, tzinfo=timezone.utc)
N_WEEKS = 12
NS = uuid.UUID("6f1c2a52-0000-4000-8000-0000000051a7")

# ---------------------------------------------------------------- calibrated primary-intent mix (L3 weights)
# Real sample (n=36, confirmed representative): BILL 64%, rep-only 14%, REFUND 8%, rest single digits.
# Target keeps billing dominant but gives every insight family volume (approved spec: billing/pay/refund/account ~70-80%).
MIX = {
    "BILL.EXPLAIN.CHARGES": 18, "BILL.EXPLAIN.BALANCE": 15, "BILL.EXPLAIN.STATEMENT": 2, "BILL.CHARGE.INQUIRY": 7,
    "BILL.CHARGE.DISPUTE": 11, "BILL.CHARGE.FRAUD": 3, "BILL.DUEDATE.CHANGE": 3, "PAY.MAKE.ONE_TIME": 5,
    "PAY.STATUS.NOT_REFLECTED": 3, "PAY.STATUS.FAILED": 2, "PAY.ARRANGE.EXTENSION": 3, "REFUND.REQUEST.OVERPAYMENT": 3,
    "REFUND.REQUEST.CREDIT_INQUIRY": 3, "ACCT.ACCESS.PIN": 3, "ACCT.ACCESS.VERIFY": 2, "ACCT.LOOKUP.NUMBER": 2,
    "ESCALATION.REP.REQUEST": 7, "GENERAL.INFO.HOURS": 1,
    "PLAN.ENQUIRY.OPTIONS": 2.5, "PLAN.ENQUIRY.COMPARE": 1.5, "PLAN.CHANGE.LOWER_COST": 3, "PLAN.DISCOUNT.PROMO": 1.5,
    "ADDSVC.LINE.ADD": 2, "ADDSVC.CONNECT.HOTSPOT_HOME": 1.5, "ADDSVC.TRAVEL.INTERNATIONAL": 2,
    "DEVICE.UPGRADE.ELIGIBILITY": 2.5, "DEVICE.REPLACE.DAMAGE_LOSS": 1.5, "DEVICE.ORDER.RETURN_STATUS": 1.5,
    "SERVICE.CONNECTIVITY.COVERAGE": 2, "SERVICE.OUTAGE.DISRUPTION": 1.5, "SERVICE.ACTIVATION.NEW": 1, "RETENTION.CANCEL.INTENT": 1.5,
}
GENERIC_LABEL = {"BILL.": ["head_intent.bill_plus_operator", "head_intent.bill_problem_general", "head_intent.bill_explain_incorrect"]}

# Held-out paraphrase bank B (the rules were NOT written against these)
OPEN_B = {
    "BILL.EXPLAIN.CHARGES": ["how come I'm paying more this time", "my statement looks different this month", "what's this extra stuff on my invoice"],
    "BILL.EXPLAIN.BALANCE": ["how much do I need to pay right now", "tell me the amount on my account"],
    "BILL.EXPLAIN.STATEMENT": ["I never got the paper bill in the mail", "the bill didn't come this month"],
    "BILL.CHARGE.INQUIRY": ["there's something on there I don't recognize", "what is this amount that showed up"],
    "BILL.CHARGE.DISPUTE": ["you guys billed me for something that's wrong", "that amount is not right, take it off"],
    "BILL.CHARGE.FRAUD": ["somebody used my account and it wasn't me", "I never signed up for that line"],
    "BILL.DUEDATE.CHANGE": ["can I pay on a different day of the month", "the date my bill is due doesn't work for me"],
    "PAY.MAKE.ONE_TIME": ["I'd like to put money on the account", "I'm trying to pay what I owe"],
    "PAY.STATUS.NOT_REFLECTED": ["I sent the money already but it doesn't show", "I paid and the phone is still cut off"],
    "PAY.STATUS.FAILED": ["the app won't take my card", "my card keeps getting rejected"],
    "PAY.ARRANGE.EXTENSION": ["I'm a little short until payday", "could I split the bill into two payments"],
    "REFUND.REQUEST.OVERPAYMENT": ["I paid twice and want the money back", "send back the extra I put on the account"],
    "REFUND.REQUEST.CREDIT_INQUIRY": ["I was told I'd get money taken off my bill", "where is the credit the rep promised"],
    "ACCT.ACCESS.PIN": ["I don't remember the number you want", "I never set up a code for the account"],
    "ACCT.ACCESS.VERIFY": ["the text with the code isn't coming through", "I didn't get any message from you"],
    "ACCT.LOOKUP.NUMBER": ["it's my mother's number, not mine", "the number on the account changed"],
    "ESCALATION.REP.REQUEST": ["get me a person", "I just want a human"],
    "GENERAL.INFO.HOURS": ["what time do your people start working", "are the stores open tomorrow"],
    "PLAN.ENQUIRY.OPTIONS": ["what kind of packages do you have", "I need something with more data"],
    "PLAN.ENQUIRY.COMPARE": ["how is the top plan different from mine", "which of those two gives me more"],
    "PLAN.CHANGE.LOWER_COST": ["I need to pay less every month", "is there a smaller plan I can switch to"],
    "PLAN.DISCOUNT.PROMO": ["any specials for people who've been with you a long time", "do teachers get anything off"],
    "ADDSVC.LINE.ADD": ["my son needs his own phone on our account", "one more person is joining our plan"],
    "ADDSVC.CONNECT.HOTSPOT_HOME": ["I need internet for my laptop when I'm out", "can I get wifi at the house through you"],
    "ADDSVC.TRAVEL.INTERNATIONAL": ["I'm flying out of the country soon", "will my phone work when I'm in another country"],
    "DEVICE.UPGRADE.ELIGIBILITY": ["my phone is getting old and slow", "can I get the newest model now"],
    "DEVICE.REPLACE.DAMAGE_LOSS": ["my phone took a swim in the pool", "I can't find my phone anywhere"],
    "DEVICE.ORDER.RETURN_STATUS": ["the box I sent back hasn't been confirmed", "my package never showed up"],
    "SERVICE.CONNECTIVITY.COVERAGE": ["I can't hear anyone when I'm home", "my phone barely works inside my apartment"],
    "SERVICE.OUTAGE.DISRUPTION": ["nothing works since this morning", "all my devices lost connection"],
    "SERVICE.ACTIVATION.NEW": ["the new phone you sent won't turn on service", "how do I get my new phone working"],
    "RETENTION.CANCEL.INTENT": ["I'm done with this company", "I'll take my business somewhere else"],
}
SIG = {  # signal type -> (bank A phrases, bank B phrases)
    "willingness": (["I'd be interested in that", "sounds good, sign me up", "let's do it"], ["okay that works for me", "alright put that through"]),
    "price_sensitivity": (["that's too expensive", "do you have a cheaper option", "I'm on a tight budget"], ["that's a lot for me right now", "I can't stretch that far"]),
    "feature_comparison": (["what's the difference between those two", "which one is better"], ["how does that stack up with the others", "what do I actually get with each"]),
    "multi_line_expansion": (["I have three lines on my account", "it's for my whole family"], ["there are five of us on the plan", "everyone in the house needs one"]),
    "device_replacement": (["my screen is cracked", "I need a replacement phone"], ["the display is smashed", "I need another handset"]),
    "escalation_request": (["let me talk to a live agent", "representative please", "I want to speak to someone"], ["can I get a human on the line", "put somebody on who can help"]),
    "complaint": (["this is ridiculous", "this is unacceptable"], ["this is getting me nowhere", "I'm really not happy about all this"]),
    "frustration": (["I'm so frustrated with this", "oh my god, come on"], ["I've had it with this", "seriously, again"]),
    "confusion": (["I don't understand", "what do you mean"], ["I'm lost here", "that doesn't make sense to me"]),
    "repeat_contact_language": (["I already called about this yesterday", "this is the third time I'm calling"], ["I keep having to bring this up", "nobody got back to me about it"]),
    "churn_intent": (["I'll cancel my service if this isn't fixed", "I'm switching to T-Mobile"], ["maybe it's time to look at other carriers", "I'll take my business elsewhere"]),
    "local_event": (["there was a big storm last night", "there's a power outage in my area"], ["we had a transformer blow near us", "the game this weekend packed the whole area"]),
    "positive_response": (["perfect, thank you so much", "that helps, thanks"], ["okay good, appreciate that", "nice, thanks"]),
}
PERSONAS = {  # prior, intent multipliers, signal propensities
    "value_seeker": (.11, {"PLAN.CHANGE.LOWER_COST": 4, "PLAN.DISCOUNT.PROMO": 4, "PAY.ARRANGE.EXTENSION": 2}, {"price_sensitivity": .55, "feature_comparison": .2}),
    "household_builder": (.06, {"ADDSVC.LINE.ADD": 6, "PLAN.ENQUIRY.OPTIONS": 2}, {"multi_line_expansion": .5, "willingness": .35}),
    "traveler": (.05, {"ADDSVC.TRAVEL.INTERNATIONAL": 7, "ADDSVC.CONNECT.HOTSPOT_HOME": 1.5}, {"willingness": .3, "feature_comparison": .25}),
    "upgrader": (.07, {"DEVICE.UPGRADE.ELIGIBILITY": 5, "DEVICE.REPLACE.DAMAGE_LOSS": 2, "PLAN.ENQUIRY.COMPARE": 2}, {"willingness": .4, "feature_comparison": .35}),
    "connectivity_dependent": (.06, {"ADDSVC.CONNECT.HOTSPOT_HOME": 4, "SERVICE.CONNECTIVITY.COVERAGE": 4, "SERVICE.OUTAGE.DISRUPTION": 2.5}, {"complaint": .25, "local_event": .15}),
    "billing_focused": (.50, {}, {"price_sensitivity": .08}),
    "at_risk": (.05, {"RETENTION.CANCEL.INTENT": 8, "BILL.CHARGE.DISPUTE": 2, "SERVICE.CONNECTIVITY.COVERAGE": 2}, {"complaint": .55, "frustration": .4, "churn_intent": .35}),
    "access_blocked": (.08, {"ACCT.ACCESS.PIN": 5, "ACCT.ACCESS.VERIFY": 4, "ESCALATION.REP.REQUEST": 2}, {"frustration": .3, "confusion": .3}),
}
PLANTED = [  # (city, L3 intent, multiplier, week_from, week_to) -> truth for gate G5
    ("Orlando", "ADDSVC.TRAVEL.INTERNATIONAL", 4.0, 0, 11), ("Miami", "ADDSVC.TRAVEL.INTERNATIONAL", 3.0, 0, 11),
    ("Austin", "ADDSVC.LINE.ADD", 3.0, 0, 11), ("Phoenix", "SERVICE.CONNECTIVITY.COVERAGE", 4.0, 0, 11),
    ("Denver", "ADDSVC.CONNECT.HOTSPOT_HOME", 4.0, 0, 11), ("Detroit", "PLAN.CHANGE.LOWER_COST", 3.0, 0, 11),
    ("Detroit", "PLAN.DISCOUNT.PROMO", 3.0, 0, 11), ("Charlotte", "DEVICE.UPGRADE.ELIGIBILITY", 3.0, 0, 11),
    ("Chicago", "PAY.ARRANGE.EXTENSION", 3.0, 0, 11),
    ("Houston", "SERVICE.OUTAGE.DISRUPTION", 8.0, 8, 10),          # emerging (storm)
    ("Atlanta", "ADDSVC.TRAVEL.INTERNATIONAL", 5.0, 9, 11),       # emerging (event travel)
]
SEQUENCES = {"SERVICE.OUTAGE.DISRUPTION": ("RETENTION.CANCEL.INTENT", .40), "SERVICE.CONNECTIVITY.COVERAGE": ("RETENTION.CANCEL.INTENT", .30),
             "BILL.CHARGE.FRAUD": ("BILL.EXPLAIN.CHARGES", .40), "DEVICE.REPLACE.DAMAGE_LOSS": ("DEVICE.UPGRADE.ELIGIBILITY", .40)}
DEST = ["Mexico", "Europe", "London", "Cancun", "Japan", "Italy", "Canada"]
FILLERS = ["uh", "um", "like", "you know", "so"]
CITY_W = None


def _w(rng, items, weights):
    x, acc = rng.random() * sum(weights), 0.0
    for it, w in zip(items, weights):
        acc += w
        if x <= acc:
            return it
    return items[-1]


def intent_weights(persona, city, week):
    pm = PERSONAS[persona][1]
    out = []
    for k, base in MIX.items():
        v = base * pm.get(k, 1.0)
        for c, i, m, w0, w1 in PLANTED:
            if c == city and i == k and w0 <= week <= w1:
                v *= m
        if k == "ADDSVC.CONNECT.HOTSPOT_HOME":
            v *= 1 + .05 * week                              # slow-burn global trend
        out.append(v)
    return list(MIX), out


def asr(rng, s):
    """Light ASR noise: fillers, a repeated word, dropped punctuation/case."""
    if rng.random() < .25:
        w = s.split(); i = rng.randrange(len(w)); w.insert(i, rng.choice(FILLERS)); s = " ".join(w)
    if rng.random() < .12:
        w = s.split(); i = rng.randrange(len(w)); w.insert(i, w[i]); s = " ".join(w)
    if rng.random() < .3:
        s = s.rstrip(".?!").lower()
    return s


class Sess:
    def __init__(self):
        self.turns, self.planted, self.secondary = [], set(), []

    def turn(self, user, msgs, tools=()):
        self.turns.append((user, msgs, list(tools)))

    def say(self, rng, typ, bank, role):
        self.planted.add(typ)
        self.turn(asr(rng, rng.choice(SIG[typ][bank])), [(role, AGENT_SAY["mid"])])


def build_session(rng, sid, t, persona, city, auth, intent, prev, depth, week):
    s = Sess()
    bank = 0 if rng.random() < .6 else 1
    sigp = dict(PERSONAS[persona][2])
    target = max(3, min(14, int(round(rng.gauss(5.25, 2.0)))))
    # --- opening & authentication (calibrated: ~58% unauthenticated, events ~30% of turns)
    s.turn("<event>session start</event>", [("bootstrap_agent", "Thank you for calling Verizon. I'm Verizon's Automated Assistant.")])
    if rng.random() < .30:
        s.turn('<context>function [get_call_details_convo_iq_wrapper] completed with response {"result": {"status": "success"}}</context>', [])
    auth_fail = False
    if auth == "unauth":
        if rng.random() < .6:
            s.turn("<context>user pressed [GENERIC_ID] on keypad.</context>", [("enhanced_secure_pin", "I am sorry, I was unable to find that number on your account.")],
                   [_tool("esp_lookup_mdn_role", "enhanced_secure_pin")])
        if rng.random() < .35:
            s.turn("<context>no user activity detected for 9 seconds.</context>", [("enhanced_secure_pin", "It looks like we didn't receive a response.")]); s.planted.add("no_input")
        auth_fail = True
        s.turn(asr(rng, rng.choice(["I don't have the pin.", "I don't know it.", "I don't have my PIN."])),
               [("enhanced_secure_pin", "I'm sorry, I wasn't able to verify you.")], [_tool("invalid_auth", "enhanced_secure_pin")])
        s.planted.add("auth_failure")
    else:
        s.turn("<context>user pressed 1 on keypad.</context>", [("bootstrap_agent", "Thanks, I've confirmed the number.")], [_tool("set_mdn_confirmation", "bootstrap_agent")])
    # --- goal episodes
    intents = [intent]
    if intent != "ESCALATION.REP.REQUEST" and rng.random() < .16:
        ks, ws = intent_weights(persona, city, week)
        second = _w(rng, ks, ws)
        if second.split(".")[1] != intent.split(".")[1] and second != "ESCALATION.REP.REQUEST":
            intents.append(second)
    role = "root_agent"
    for ei, code in enumerate(intents):
        plat, role, journey, opener, para, details, ev = CARDS[code]
        if auth == "unauth" and role == "bill_explain_with_mcp":
            role = "unauth_bill_explain"
        text = opener if bank == 0 else rng.choice(OPEN_B[code])
        text = text.format(dest=rng.choice(DEST)) if "{dest}" in text else text
        if ei == 1:
            text = "Also, " + text[0].lower() + text[1:]
        if depth and ei == 0 and rng.random() < .5:
            s.planted.add("repeat_contact_language"); text += ". " + rng.choice(SIG["repeat_contact_language"][bank])
        if rng.random() < .08:     # text place mention (destination / current), separate from service location
            other = rng.choice([c[0] for c in CITIES if c[0] != city])
            text += f", I'm {'flying to' if code.startswith('ADDSVC.TRAVEL') else 'in'} {other} right now"; s.planted.add("city_mention")
        tools = [_tool("customize_response", role)]
        r = rng.random()
        if plat and r < .70:
            tools.append(_tool("mandatory_set_intent_for_next_step", "root_agent", {"requested_operator": plat == "Operator", "intent_name": plat}))
        elif r < .85 and code.startswith("BILL."):
            tools.append(_tool("mandatory_set_intent_for_next_step", "root_agent", {"requested_operator": False, "intent_name": rng.choice(GENERIC_LABEL["BILL."])}))
        if rng.random() < .8:
            tools.append(_tool("retrieve_intent_matches", "root_agent", {"user_intent": para if bank == 0 or rng.random() < .5 else text[:80]}))
        s.turn(asr(rng, text), [(role, AGENT_SAY["default"])], tools)
        if code == "ESCALATION.REP.REQUEST":
            s.planted.add("escalation_request")
        # intent-linked evidence (bank A wording from the card; bank B from SIG paraphrases)
        for typ, utt in ev:
            if rng.random() < .45 and typ in SIG:
                if bank == 0:
                    s.planted.add(typ); s.turn(asr(rng, utt), [(role, AGENT_SAY["mid"])])
                else:
                    s.say(rng, typ, 1, role)
        for typ, p in sigp.items():
            if rng.random() < p and typ not in s.planted:
                s.say(rng, typ, bank, role)
        if ei == 0 and rng.random() < .05:
            s.turn("Necesito ayuda con mi cuenta, por favor.", [(role, "Would you like to switch the call to Spanish?")])
    # pad to target length with neutral details

    # --- friction & outcome (calibrated: ~75% handoff, ~58% ask for a human, ~8% abandoned)
    friction = rng.random() < (.55 if auth == "unauth" else .3)
    if friction:
        f = rng.choice(["customer_repeat", "dtmf0", "no_input", "tool_failure", "agent_loop"])
        if f == "customer_repeat":
            u = "Representative." if rng.random() < .5 else "I need help with my bill."
            s.turn(u, [(role, AGENT_SAY["reask"])]); s.turn(u, [(role, AGENT_SAY["reask"])]); s.planted.update({"customer_repeat", "agent_loop"})
            if u == "Representative.":
                s.planted.add("escalation_request")
        elif f == "dtmf0":
            s.turn("<context>user pressed 0 on keypad.</context>", [(role, "Okay, one moment.")]); s.planted.add("dtmf_operator")
        elif f == "no_input":
            s.turn("<context>no user activity detected for 9 seconds.</context>", [(role, "Are you still there?")]); s.planted.add("no_input")
        elif f == "tool_failure":
            s.turn("Can you check that again?", [(role, "I'm having trouble pulling that up right now.")],
                   [_tool("billing_mcp_retrieve_account_remarks", role, {"remarkType": "PA"}, failed=True)]); s.planted.add("tool_failure")
        else:
            s.turn("Okay.", [(role, AGENT_SAY["reask"])]); s.turn("What?", [(role, AGENT_SAY["reask"])]); s.planted.update({"agent_loop", "confusion"})
    p_esc = .70 + (.2 if auth_fail else 0) + (.1 if intent.startswith(("BILL.CHARGE", "RETENTION", "ESCALATION")) else 0) - (.25 if intent.startswith(("PLAN.", "ADDSVC.", "DEVICE.UPGRADE")) else 0)
    r = rng.random()
    outcome = "escalated" if r < p_esc else ("abandoned" if r < p_esc + .05 + (.04 if auth_fail else 0) else "resolved")
    if outcome == "escalated":
        u = "Okay."
        if "escalation_request" not in s.planted and rng.random() < .75:
            s.planted.add("escalation_request")
            u = asr(rng, rng.choice(SIG["escalation_request"][0 if rng.random() < .7 else bank]))
        s.turn(u, [("root_agent", "Just a moment")], [_tool("updated_billing_transfer_call", "root_agent", {"action": "transfer_to_agent"})])
        s.planted.add("agent_handoff")
    elif outcome == "abandoned":
        if rng.random() < .5:
            s.turn("<context>no user activity detected for 9 seconds.</context>", [(role, "Are you still there?")]); s.planted.add("no_input")
            s.turn("<context>no user activity detected for 9 seconds.</context>", [(role, "I haven't heard anything.")])
        s.turn("<event>sys.remote-call-disconnected</event>", [])
        s.planted.add("abandoned")
    else:
        if rng.random() < .4:
            s.say(rng, "positive_response", bank, role)
        s.turn("That's all, thank you.", [(role, AGENT_SAY["bye"])])
    # pad with neutral detail turns (inserted before the closing turn) up to the sampled total trace count
    while len(s.turns) < target:
        s.turns.insert(len(s.turns) - 1, (asr(rng, rng.choice(["Yes.", "No.", "Okay.", "Uh, I think so.", "It's the main line.", "About two weeks ago.", "Mm-hm.", "Can you check that?"])),
                                          [(role, AGENT_SAY["mid"])], []))
    return s, intents, outcome, bank


def to_record(rng, sid, t, s, intents, outcome, prev, city, meta, offset):
    traces, ts = [], t
    for i, (user, msgs, tools) in enumerate(s.turns):
        ts = ts + timedelta(seconds=rng.randint(4, 25))
        n = i + 1 + offset
        u = json.dumps([{"role": "user", "content": user}])
        o = json.dumps([{"role": r, "content": x} for r, x in msgs]) if msgs else None
        tid = str(uuid.uuid5(NS, f"{sid}/{n}"))
        traces.append({"type": "trace", "name": f"turn {n} workflow", "created_at": str(ts), "input": u, "redacted_input": u, "output": o,
                       "redacted_output": o, "id": tid, "trace_id": tid, "session_id": sid, "metrics": {},
                       "spans": [{"type": "workflow", "name": f"turn {n} workflow", "spans": tools}]})
    rng.shuffle(traces)
    fl = s.planted
    succ = 1.0 if outcome == "resolved" or (outcome == "escalated" and intents[0].startswith(("BILL.CHARGE.FRAUD", "RETENTION", "ESCALATION"))) else 0.0
    loc = {"svc_city": city, "svc_state": CITY_STATE[city][0], "svc_zip3": CITY_STATE[city][2], "svc_market": CITY_STATE[city][1],
           "svc_region": CITY_STATE[city][3], "geo_level": "service_address", "geo_asof": str(t.date())}
    metrics = {"conversation_quality": [1.0 if outcome == "resolved" and not fl & {"frustration", "complaint"} else 0.0],
               "agentic_session_success": [succ], "agent_efficiency": [0.0 if fl & {"agent_loop", "customer_repeat"} else 1.0],
               "agent_flow": [0.0 if "tool_failure" in fl else 1.0], "cm_session_avg_turn_latency_sec": f"{1.5 + rng.random() * 2.5:.2f}",
               "cm_policy_metric": json.dumps({"overall_result": True, "metrics": {"journey": CARDS[intents[0]][2],
                                               "overall_compliance_rate": 0.9 if "tool_failure" in fl else 1.0, "verdicts": []}})}
    return {"type": "session", "session_id": sid, "id": sid, "external_id": f"SYN-{sid[:13]}", "created_at": str(t),
            "previous_session_id": prev, "num_traces": None, "status_code": 0, "user_metadata": loc, "tags": [],
            "input": traces[0]["input"], "output": traces[0]["output"], "metrics": metrics, "traces": traces, "dataset_metadata": meta}


CITY_STATE = {}


def gen_thread(rng, tidx, seed, cities, city_w):
    out = []
    persona = _w(rng, list(PERSONAS), [p[0] for p in PERSONAS.values()])
    city = _w(rng, cities, city_w)
    auth = "unauth" if rng.random() < .55 else "auth"
    week = rng.randrange(N_WEEKS)
    t = T0 + timedelta(weeks=week, days=rng.randrange(7), hours=rng.randrange(8, 22), minutes=rng.randrange(60))
    split = "test" if rng.random() < .2 else "discovery"
    prev, depth, forced = None, 0, None
    while True:
        wk = min(N_WEEKS - 1, (t - T0).days // 7)
        if (t - T0).days >= 7 * N_WEEKS:
            break
        ks, ws = intent_weights(persona, city, wk)
        intent = forced or _w(rng, ks, ws)
        sid = str(uuid.uuid5(NS, f"{seed}/{tidx}/{depth}"))
        s, intents, outcome, bank = build_session(rng, sid, t, persona, city, auth, intent, prev, depth, wk)
        meta = {"is_synthetic": True, "batch": f"synth-{seed}", "scenario_id": f"{intents[0]}|{outcome}", "template_id": intents[0],
                "generator_version": GEN_VERSION, "seed": seed, "split": split, "bank": "AB"[bank]}
        offset = rng.choice([0, 0, 0, 2, 5, 9])
        rec = to_record(rng, sid, t, s, intents, outcome, prev, city, meta, offset)
        gt = {"session_id": sid, "primary_intent": intents[0], "intents": intents, "outcome": outcome, "persona": persona, "city": city,
              "week": wk, "split": split, "bank": "AB"[bank], "auth": auth, "planted_signals": sorted(s.planted), "prev": prev,
              "depth": depth, "n_traces": len(s.turns), "n_goal_episodes": len(intents)}
        out.append((rec, gt))
        p_follow = {"resolved": .07, "escalated": .30, "abandoned": .50}[outcome]
        if depth >= 3 or rng.random() > p_follow:
            break
        nxt = SEQUENCES.get(intent)
        forced = nxt[0] if nxt and outcome != "resolved" and rng.random() < nxt[1] / p_follow * .5 else (intent if rng.random() < .6 else None)
        prev, depth = sid, depth + 1
        t = t + timedelta(days=rng.randint(1, 6), hours=rng.randint(0, 8))
    return out


def _worker(args):
    seed, start, n_threads = args
    rng = random.Random(seed * 1_000_003 + start)
    cities = [c[0] for c in CITIES]
    r2 = random.Random(1)
    city_w = [r2.choice([.6, .8, 1, 1, 1.3, 1.6, 2.2]) for _ in cities]
    lines, gts = [], []
    for i in range(start, start + n_threads):
        for rec, gt in gen_thread(rng, i, seed, cities, city_w):
            lines.append(json.dumps(rec, separators=(",", ":"))); gts.append(json.dumps(gt, separators=(",", ":")))
    return lines, gts


ZIP3 = {"NY": "100", "MA": "021", "PA": "191", "NJ": "071", "MD": "212", "DC": "200", "VA": "232", "NC": "282", "GA": "303", "FL": "328",
        "TN": "372", "LA": "701", "TX": "770", "OK": "731", "IL": "606", "MI": "482", "OH": "441", "IN": "462", "WI": "532", "MN": "554",
        "MO": "631", "CO": "802", "UT": "841", "AZ": "850", "NV": "891", "NM": "871", "CA": "900", "WA": "981", "OR": "972"}
for c in CITIES:
    CITY_STATE[c[0]] = (c[1], c[3], ZIP3.get(c[1], "999"), c[2])


def generate(n_sessions=100_000, seed=7, out=SYNTH_PATH, gt_out=GT_PATH, procs=4):
    DATA.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    per, n_threads = 2000, int(n_sessions / 1.25 * 1.1)
    jobs = [(seed, k, min(per, n_threads - k)) for k in range(0, n_threads, per)]
    written = traces = 0
    with gzip.open(out, "wt", compresslevel=3) as f, gzip.open(gt_out, "wt", compresslevel=3) as g, mp.Pool(procs) as pool:
        for lines, gts in pool.imap(_worker, jobs):
            for line, gt in zip(lines, gts):
                if written >= n_sessions:
                    break
                f.write(line + "\n"); g.write(gt + "\n"); written += 1; traces += json.loads(gt)["n_traces"]
            if written >= n_sessions:
                break
    meta = {"generator_version": GEN_VERSION, "seed": seed, "sessions": written, "traces": traces, "mean_traces": round(traces / max(written, 1), 3),
            "planted": PLANTED, "sequences": SEQUENCES, "weeks": N_WEEKS, "t0": str(T0), "seconds": round(time.time() - t0, 1)}
    json.dump(meta, open(DATA / "synthetic_meta.json", "w"), indent=1)
    print(f"generated {written:,} sessions / {traces:,} traces (mean {traces / written:.2f}) in {time.time() - t0:.0f}s -> {out}")
    return meta


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--sessions", type=int, default=100_000); ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    generate(a.sessions, a.seed)
