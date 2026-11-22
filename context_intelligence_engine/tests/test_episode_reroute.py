from cie.episodes import segment_session
from cie.taxonomy import Taxonomy

TAX = Taxonomy()


def _turn(seq, kind, text=None, role="root_agent"):
    return {"seq": seq, "kind": kind, "user_text": text, "agent_text": "", "agent_role": role, "event_type": None}


def _intent(seq, code, conf, method):
    return {"seq": seq, "intent_id": code, "confidence": conf, "method": method}


def _tool(seq, name):
    return {"seq": seq, "tool": "mandatory_set_intent_for_next_step", "intent_name": name, "query": None, "requested_operator": None, "failed": 0}


def _run(turns, ti, tools):
    return [e for e in segment_session("s", turns, ti, tools, [], TAX) if e["kind"] == "goal"]


def test_reroute_on_event_turn_after_speech_is_not_a_new_need():
    # customer says one thing; the platform then re-routes twice on turns with no customer words
    turns = [_turn(0, "utterance", "refund partial payment"), _turn(1, "event"), _turn(2, "event")]
    ti = [_intent(0, "REFUND.REQUEST.OVERPAYMENT", .9, "platform_intent"), _intent(1, "PAY.MAKE.ONE_TIME", .9, "platform_intent"),
          _intent(2, "REFUND.REQUEST.OVERPAYMENT", .9, "platform_intent")]
    tools = [_tool(0, "head_intent.bill_refund"), _tool(1, "make_payment"), _tool(2, "head_intent.bill_refund")]
    eps = _run(turns, ti, tools)
    assert len(eps) == 1 and eps[0]["intent_id"] == "REFUND.REQUEST.OVERPAYMENT"


def test_platform_label_on_customer_speech_still_opens_an_episode():
    turns = [_turn(0, "utterance", "refund partial payment"), _turn(1, "utterance", "and I want to pay my bill")]
    ti = [_intent(0, "REFUND.REQUEST.OVERPAYMENT", .9, "platform_intent"), _intent(1, "PAY.MAKE.ONE_TIME", .9, "platform_intent")]
    tools = [_tool(0, "head_intent.bill_refund"), _tool(1, "make_payment")]
    assert len(_run(turns, ti, tools)) == 2
