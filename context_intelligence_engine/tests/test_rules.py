import re
from pathlib import Path
import yaml
from cie.taxonomy import Taxonomy
from cie.lexicon import TEXT_SIGNALS

TAX = Taxonomy()


def test_every_intent_example_classifies_to_itself():
    bad = []
    for i in TAX.intents:
        for ex in i.get("examples") or []:
            hits = TAX.classify_turn(ex)
            if not hits or i["code"] not in [h[0] for h in hits[:2]]:
                bad.append((i["code"], ex, hits[:2]))
    assert not bad, bad


def test_generic_platform_label_loses_to_customer_words():
    hits = TAX.classify_turn("I want to make a payment", ["head_intent.bill_plus_operator"])
    assert hits[0][0] == "PAY.MAKE.ONE_TIME"


def test_customer_refinement_within_category():
    th = [(0, TAX.classify_turn("Review unexpected charge", ["head_intent.charge_dispute"])),
          (2, TAX.classify_turn("dispute charge")), (3, TAX.classify_turn("It's not my phone.", ["fraud"]))]
    assert TAX.session_intents(th)[0][0] == "BILL.CHARGE.FRAUD"


def test_rep_request_only_primary_when_nothing_else():
    assert TAX.session_intents([(0, TAX.classify_turn("Representative, please."))])[0][0] == "ESCALATION.REP.REQUEST"
    th = [(0, TAX.classify_turn("Representative, please.")), (1, TAX.classify_turn("question about a credit"))]
    assert TAX.session_intents(th)[0][0] == "REFUND.REQUEST.CREDIT_INQUIRY"


POS = {"escalation_request": ["Can I speak to a real human", "No. Customer service.", "connect me to an associate", "agent"],
       "price_sensitivity": ["I would like to know how I can lower my bill", "that's too expensive"],
       "churn_intent": ["I'm switching to T-Mobile", "cancel my service"],
       "confusion": ["Am I talking to Santander Bank?", "What?"],
       "willingness": ["sign me up", "I'd be interested in that"],
       "travel_intl": ["tell me about TravelPass", "I'm traveling to Mexico"]}
NEG = {"escalation_request": ["When is customer service open?", "my agent said"],
       "multi_line_expansion": ["$4 a day on both my lines"],
       "churn_intent": ["cancel the order"]}


def _fires(typ, text):
    return any(t == typ and rx.search(text) for _, t, _, rx, _ in TEXT_SIGNALS)


def test_lexicon_positive_and_negative():
    miss = [(t, x) for t, xs in POS.items() for x in xs if not _fires(t, x)]
    fp = [(t, x) for t, xs in NEG.items() for x in xs if _fires(t, x)]
    assert not miss and not fp, (miss, fp)


def test_taxonomy_codes_unique_and_hierarchical():
    codes = [n["intent_id"] for n in TAX.nodes]
    assert len(codes) == len(set(codes))
    for n in TAX.nodes:
        if n["level"] == 3 and n["parent_id"]:
            assert n["intent_id"].startswith(n["parent_id"] + ".")
