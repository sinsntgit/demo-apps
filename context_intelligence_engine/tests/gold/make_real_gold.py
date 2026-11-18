"""Draft gold labels for the 36 real sessions. Written by reading each transcript (not from pipeline output).
STATUS: reviewed=false until a Verizon SME confirms each row (AGENTS.md §3 item 6, gate G2/G3).
Keyed by external_id prefix (CID-xxxxxxxxxx) so the file contains no transcript text.
Fields: primary, secondary, ambiguous, handoff (transfer tool executed), asked_human, auth_failure, abandoned,
signals (key signal types a reviewer expects), note.
"""
import json, sqlite3, sys
G = [
 ("CID-1824853926", "ESCALATION.REP.REQUEST", [], 0, 1, 1, 1, 0, ["escalation_request", "auth_failure"], "No need stated; 'No. Customer service.'"),
 ("CID-3389059416", "ESCALATION.REP.REQUEST", ["BILL.EXPLAIN.CHARGES"], 1, 1, 1, 1, 0, ["escalation_request", "customer_repeat", "auth_failure"], "Repeats 'customer service'; Spanish; platform guessed bill_breakdown"),
 ("CID-0182697608", "BILL.EXPLAIN.BALANCE", [], 0, 0, 0, 0, 0, [], "Need only visible in agent paraphrase 'What is my balance?'; truncated window"),
 ("CID-1606408318", "REFUND.REQUEST.OVERPAYMENT", [], 0, 1, 0, 0, 0, ["out_of_scope"], "Credit balance back to bank account"),
 ("CID-1589049708", "PAY.MAKE.ONE_TIME", [], 1, 0, 0, 0, 0, [], "'payment save it' garbled; platform bill_plus_operator"),
 ("CID-1774192172", "ESCALATION.REP.REQUEST", [], 0, 1, 1, 1, 0, ["escalation_request", "auth_failure", "no_input"], "No PIN; asks for representative; no need stated"),
 ("CID-2083893756", "PAY.MAKE.ONE_TIME", ["BILL.CHARGE.DISPUTE"], 1, 0, 0, 1, 1, ["auth_failure", "abandoned"], "'[name] and payment'; platform bill_explain_incorrect; Spanish; disconnect"),
 ("CID-0107671024", "REFUND.REQUEST.OVERPAYMENT", [], 0, 1, 0, 0, 0, ["no_input", "out_of_scope"], "Refund partial payment"),
 ("CID-3174381604", "BILL.EXPLAIN.BALANCE", [], 0, 1, 0, 1, 0, ["auth_failure", "confusion"], "'What's my bill?'; 'Re-authenticate me'"),
 ("CID-0470418740", "BILL.CHARGE.INQUIRY", ["BILL.DUEDATE.CHANGE"], 0, 1, 1, 1, 0, ["auth_failure", "escalation_request"], "Money taken before due date; 'connect me'"),
 ("CID-1225517580", "PAY.STATUS.NOT_REFLECTED", [], 0, 1, 0, 1, 0, ["auth_failure", "no_input"], "Paid but service inactive (agent paraphrase); PIN failed twice then verified"),
 ("CID-1556488120", "BILL.CHARGE.FRAUD", ["BILL.CHARGE.DISPUTE"], 0, 1, 0, 0, 0, ["dispute"], "Buyout charge; 'It's not my phone'"),
 ("CID-3014354420", "BILL.EXPLAIN.CHARGES", ["ADDSVC.TRAVEL.INTERNATIONAL"], 0, 1, 1, 0, 0, ["escalation_request", "travel_intl", "no_input"], "International charges on bill; 'Transfer now'"),
 ("CID-3941747378", "BILL.CHARGE.DISPUTE", ["ADDSVC.TRAVEL.INTERNATIONAL"], 0, 1, 0, 0, 0, ["travel_intl"], "TravelPass charges dispute; customer has 2 lines (not expansion)"),
 ("CID-2321029278", "BILL.EXPLAIN.CHARGES", [], 0, 0, 0, 0, 0, [], "'I have a question on my bill.'; truncated window"),
 ("CID-0800324612", "BILL.CHARGE.INQUIRY", [], 0, 0, 1, 0, 0, ["escalation_request"], "'Speak to someone' then 'unexpected charge'; no transfer in window"),
 ("CID-3796207652", "BILL.EXPLAIN.CHARGES", [], 1, 1, 0, 1, 0, ["dtmf_operator", "auth_failure"], "'gluing' (ASR of billing?); presses 0 repeatedly; Portuguese"),
 ("CID-3113243892", "ESCALATION.REP.REQUEST", [], 0, 1, 1, 1, 0, ["escalation_request", "auth_failure", "no_input"], "Number entry fails; 'agent'"),
 ("CID-0964082806", "BILL.EXPLAIN.BALANCE", [], 0, 1, 1, 1, 0, ["escalation_request", "auth_failure", "no_input"], "Previous bill; 'connect me to an associate'"),
 ("CID-0524529276", "BILL.CHARGE.FRAUD", ["BILL.CHARGE.INQUIRY"], 0, 1, 0, 0, 0, ["confusion", "location_unresolved", "city_mention"], "Unrecognised $ bank charge, says not authorised; asks if talking to a bank; 'Lake Mary Florida' leaked"),
 ("CID-0458901234", "BILL.EXPLAIN.BALANCE", [], 0, 1, 1, 1, 0, ["escalation_request", "customer_repeat", "auth_failure"], "'What do I owe'; 'speak to a agent' x2"),
 ("CID-3510362540", "BILL.CHARGE.DISPUTE", [], 0, 1, 1, 0, 0, ["escalation_request", "confusion", "customer_repeat"], "Cancelled but still charged (equipment)"),
 ("CID-0688947352", "BILL.CHARGE.FRAUD", ["BILL.CHARGE.DISPUTE"], 0, 1, 1, 1, 0, ["escalation_request", "auth_failure", "dispute"], "'fraud'; bill $515 higher; 'All of it'"),
 ("CID-3822709482", "REFUND.REQUEST.CREDIT_INQUIRY", [], 0, 1, 1, 1, 0, ["escalation_request", "auth_failure"], "'question about a credit'; representative x2"),
 ("CID-0804150856", "PAY.STATUS.NOT_REFLECTED", ["GENERAL.INFO.HOURS"], 1, 1, 0, 1, 1, ["auth_failure"], "'The payment I made' (vague); asks opening hours; transfer tool fired mid-call then disconnect"),
 ("CID-2397370856", "PLAN.CHANGE.LOWER_COST", [], 0, 1, 1, 0, 0, ["price_sensitivity", "escalation_request", "no_input"], "Lower my bill; agents closed, 'I'll try back' (likely repeat contact)"),
 ("CID-2443972106", "ESCALATION.REP.REQUEST", [], 0, 0, 1, 1, 1, ["escalation_request", "customer_repeat", "abandoned"], "'Live representative' x2, then disconnect"),
 ("CID-3244755916", "BILL.EXPLAIN.STATEMENT", [], 0, 1, 1, 1, 0, ["escalation_request", "no_input"], "Hard-copy statements; served by text link ('That's all'); transfer tool still fired on no-input"),
 ("CID-3397689626", "BILL.CHARGE.DISPUTE", ["ADDSVC.TRAVEL.INTERNATIONAL"], 0, 1, 1, 0, 0, ["escalation_request", "customer_repeat"], "TravelPass concern; 'Live representative' x2"),
 ("CID-1820668774", "ACCT.LOOKUP.NUMBER", ["BILL.EXPLAIN.CHARGES"], 1, 1, 0, 1, 0, ["confusion", "frustration", "no_input", "auth_failure"], "Confused/sad; 'problem with someone's phone number'; then 'billing question'"),
 ("CID-2927594356", "BILL.EXPLAIN.BALANCE", [], 0, 1, 1, 1, 0, ["escalation_request", "auth_failure"], "Smart greeting: outstanding balance; 'customer agent'; Portuguese"),
 ("CID-2408817616", "BILL.DUEDATE.CHANGE", ["PAY.MAKE.ONE_TIME"], 1, 0, 0, 0, 0, [], "'The first payment is due'; 'payments'; adaptive auth pending"),
 ("CID-3870630808", "PAY.MAKE.ONE_TIME", [], 0, 1, 1, 1, 0, ["escalation_request", "customer_repeat", "auth_failure"], "Make a payment + connect to agent, repeated"),
 ("CID-4055950472", "BILL.EXPLAIN.CHARGES", [], 0, 0, 1, 1, 1, ["escalation_request", "auth_failure", "abandoned"], "'billing problems'; wants agent; Spanish; disconnect"),
 ("CID-1864415350", "BILL.EXPLAIN.CHARGES", [], 1, 1, 1, 1, 0, ["escalation_request", "no_input", "auth_failure"], "Only said 'billing'; platform bill_explain_incorrect"),
 ("CID-0246542580", "ACCT.ACCESS.VERIFY", ["ESCALATION.REP.REQUEST"], 1, 1, 1, 1, 0, ["escalation_request", "frustration", "auth_failure"], "Wants code sent to new mobile number; 'Get someone on the phone now'"),
]
KEYS = ["primary", "secondary", "ambiguous", "handoff", "asked_human", "auth_failure", "abandoned", "signals", "note"]

if __name__ == "__main__":
    db = sys.argv[1] if len(sys.argv) > 1 else "data/cie.sqlite"
    con = sqlite3.connect(db)
    with open("tests/gold/real_gold.jsonl", "w") as f:
        for row in G:
            ext = row[0]
            sid = con.execute("SELECT session_id FROM conversation_session WHERE external_id LIKE ?", (ext + "%",)).fetchone()
            rec = {"external_id_prefix": ext, "session_id": sid[0] if sid else None, **dict(zip(KEYS, row[1:])),
                   "labeller": "claude-draft (U3 pre-label)", "reviewed": False}
            for k in ("ambiguous", "handoff", "asked_human", "auth_failure", "abandoned"):
                rec[k] = bool(rec[k])
            f.write(json.dumps(rec) + "\n")
    print(f"wrote {len(G)} gold rows")
