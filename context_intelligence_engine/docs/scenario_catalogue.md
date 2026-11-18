# Scenario catalogue and synthetic generation spec

## Part A: Week-1 scenario fixtures (built)

`samples/scenario_fixtures.jsonl`: **77 scripted synthetic sessions, 537 traces (mean 7.0/session)** in the Verizon/Galileo schema, generated deterministically by `python -m cie.fixtures`. Purpose: exercise every L3 intent and every signal type end to end. **Not a statistical sample**; never use it for rates. Truth: `samples/scenario_fixtures_truth.json` (read only by tests/validation).

Every L3 intent has two sessions: **A** = authenticated, need served, value/buying evidence, resolved; **B** = unauthenticated or high friction (rotating: no-input, customer repeat + agent loop, DTMF 0, frustration, tool failure), escalated or abandoned.

| L3 intent | Platform label used | Domain agent | Opener (A/B) | Evidence planted in A |
|---|---|---|---|---|
| `BILL.EXPLAIN.CHARGES` | `head_intent.bill_explain` | `bill_explain_with_mcp` | Why is my bill higher than last month? | price_sensitivity |
| `BILL.EXPLAIN.BALANCE` | `head_intent.BillingBalance` | `bill_explain_with_mcp` | What do I owe on this account? | positive_response |
| `BILL.EXPLAIN.STATEMENT` | `head_intent.bill_not_received` | `unauth_bill_explain` | I did not receive my last two statements. | - |
| `BILL.CHARGE.INQUIRY` | `head_intent.charge_inquiry` | `bill_explain_with_mcp` | There's an unexpected charge on my account, what is it? | confusion |
| `BILL.CHARGE.DISPUTE` | `head_intent.charge_dispute` | `bill_explain_with_mcp` | I'm disputing these TravelPass charges, I wasn't even traveling. | complaint |
| `BILL.CHARGE.FRAUD` | `head_intent.fraud_suspected` | `bill_explain_with_mcp` | Somebody opened a line on my account, it's not my phone. | frustration |
| `BILL.DUEDATE.CHANGE` | `head_intent.bill_confirm_due_date` | `bill_explain_with_mcp` | Can I change my due date to the fifteenth? | - |
| `PAY.MAKE.ONE_TIME` | - (keyword path) | `payment_agent` | I want to make a payment on my bill. | positive_response |
| `PAY.STATUS.NOT_REFLECTED` | `head_intent.payment_status` | `bill_explain_with_mcp` | I paid my bill but my phone is still not on. | repeat_contact_language |
| `PAY.STATUS.FAILED` | - (keyword path) | `payment_agent` | My card was declined when I tried to pay in the app. | - |
| `PAY.ARRANGE.EXTENSION` | `head_intent.payment_arrangement` | `payment_agent` | I can't pay my bill this month, can I get an extension? | payment_difficulty |
| `REFUND.REQUEST.OVERPAYMENT` | `head_intent.bill_refund` | `bill_explain_with_mcp` | I want a refund of my credit balance back to my bank account. | - |
| `REFUND.REQUEST.CREDIT_INQUIRY` | `head_intent.bill_credit_inquiry` | `bill_explain_with_mcp` | I have a question about a credit I was promised. | repeat_contact_language |
| `ACCT.ACCESS.PIN` | `head_intent.account_access` | `authentication_acct_pin` | I forgot my PIN and can't log in. | - |
| `ACCT.ACCESS.VERIFY` | - (keyword path) | `enhanced_secure_pin` | The code you texted never arrived. | - |
| `ACCT.LOOKUP.NUMBER` | - (keyword path) | `unauth_handler` | I'm calling about a problem with someone's phone number. | confusion |
| `PLAN.ENQUIRY.OPTIONS` | `head_intent.plan_inquiry` | `plan_add_change` | Which plan is best for me? I keep running out of data. | willingness |
| `PLAN.ENQUIRY.COMPARE` | `head_intent.plan_compare` | `plan_add_change` | What's the difference between the two unlimited plans? | feature_comparison |
| `PLAN.CHANGE.LOWER_COST` | `head_intent.bill_reduce` | `plan_add_change` | I would like to know how I can lower my bill. | price_sensitivity |
| `PLAN.DISCOUNT.PROMO` | `head_intent.discount` | `discount_agent` | Do you have any discounts for veterans? | willingness |
| `ADDSVC.LINE.ADD` | `head_intent.add_line` | `plan_add_change` | I want to add a line for my daughter. | multi_line_expansion |
| `ADDSVC.CONNECT.HOTSPOT_HOME` | `head_intent.hotspot` | `home_internet_agent` | Do you have 5G home internet at my address? | willingness |
| `ADDSVC.TRAVEL.INTERNATIONAL` | `head_intent.international` | `travel_pass_agent` | I'm traveling to Mexico next week, will my phone work abroad? | feature_comparison |
| `DEVICE.UPGRADE.ELIGIBILITY` | `head_intent.upgrade` | `device_upgrade_agent` | Am I eligible to upgrade my phone to the new iPhone? | willingness |
| `DEVICE.REPLACE.DAMAGE_LOSS` | `head_intent.device_damage` | `device_support_agent` | I dropped my phone and the screen is cracked. | device_replacement |
| `DEVICE.ORDER.RETURN_STATUS` | `head_intent.order_status` | `order_status_agent` | I returned my equipment and I'm still being charged. | - |
| `SERVICE.CONNECTIVITY.COVERAGE` | `head_intent.cannot_make_receive_call` | `network_support_agent` | I have no signal at my house and my calls keep dropping. | coverage_local |
| `SERVICE.OUTAGE.DISRUPTION` | `head_intent.outage` | `network_support_agent` | Is there an outage in my area? My internet is down. | local_event |
| `SERVICE.ACTIVATION.NEW` | - (keyword path) | `device_support_agent` | I need to activate my new phone. | - |
| `RETENTION.CANCEL.INTENT` | `head_intent.cancel_service` | `retention_agent` | I want to cancel my service, I'm switching to T-Mobile. | complaint |
| `GENERAL.INFO.HOURS` | - (keyword path) | `unauth_bill_explain` | When is customer service open? | - |
| `ESCALATION.REP.REQUEST` | `Operator` | `root_agent` | Representative, please. | - |

Special scenarios:

| Scenario | Purpose |
|---|---|
| `SPECIAL:multi_bill_then_upgrade` | two needs in one call (cross-sell episode) |
| `SPECIAL:multi_travel_then_hotspot` | two buying needs + destination city mention |
| `THREAD:outage_1` | need journey start |
| `THREAD:outage_2` | repeat contact, same issue, abandoned |
| `THREAD:outage_3_cancel` | outage -> cancellation sequence (thread pos 2) |
| `THREAD:dispute_1` | dispute escalated |
| `THREAD:dispute_2_resolved` | follow-up resolves the dispute (journey resolved) |
| `SPECIAL:location_mismatch_current` | text city differs from service location |
| `SPECIAL:location_placeholder` | [LOCATION] redaction placeholder |
| `SPECIAL:no_service_location` | missing structured location -> UNKNOWN |
| `SPECIAL:spanish` | Spanish turn tagging |
| `SPECIAL:out_of_scope` | handle_out_of_scope tool |
| `SPECIAL:household_value` | add-a-line + lower cost, multi-line + willingness |

Location variants: flat `svc_*` keys (most), nested `location{}` (every 9th), none (1).

## Part B: 100K synthetic generation spec (Week 2, for approval before generation)

Generation is **scenario-first**: scenario family -> ground-truth L1-L3 intent(s) -> preconditions -> workflow (agent roles, tools) -> dialogue -> deterministic tool outcomes -> outcome -> rubric-derived evaluations.

### Volume and shape

- 100,000 complete sessions, **mean 7.0 traces/session** (range 3-14, sd ~2; `--fixed-traces 7` available).
- 12 weeks ending 2026-11-15; diurnal/weekday profile; `previous_session_id` chains (thread-linked repeats).
- Splits by thread: 80% `discovery`, 20% `test` (held out from taxonomy discovery and threshold tuning).

### Calibration targets (gate G0, from the real sample; sample confirmed representative)

| Marginal | Real sample (n=36) | Synthetic target |
|---|---|---|
| Traces/session | mean 6.69, median 6.5 | mean 7.0 (user requirement) |
| Escalated (transfer executed) | 28/36 = 78% | within real 95% CI |
| Abandoned | 3/36 | within CI |
| Unauthenticated | 21/36 = 58% | within CI |
| System-event share of turns | 32% | within CI |
| Null agent output | 6% | within CI |
| Primary L1 mix | BILL 23, ESCALATION 5, REFUND 3, SERVICE 1, ADDSVC 1, PAY 1, PLAN 1, GENERAL 1 | billing/payments/refunds/account ~70-80%; products/devices/service/retention 20-30% so every insight family has volume |

### Planted effects (truth for G5; final list to be approved)

- City x intent lifts (e.g. Orlando/Miami travel, Phoenix coverage, Denver hotspot, Austin add-a-line, Detroit price/discount).
- Two time-boxed emerging events (e.g. Houston outage weeks 8-10; Atlanta travel weeks 9-11).
- Sequences across threads: outage -> cancel, coverage -> cancel, dispute -> bill explanation, device damage -> upgrade.
- Personas biasing intents and value signals (value seeker, household builder, traveler, upgrader, connectivity-dependent, billing-focused, at-risk).

### Language and controls

- Two phrasing banks: A (rules developed against) and B (held-out paraphrases) to measure the generalisation gap; ASR noise (fillers, truncation, repeated words); Spanish/Portuguese turns at the real rate.
- Fictional ids only; no real phone numbers, cards, addresses or credentials; `[PLACEHOLDER]` redaction style as in production.
- Every record: `is_synthetic`, batch, scenario_id, template_id, generator_version, seed. Tool and final outcomes consistent with the dialogue; evaluations from a rubric (not random).
- Schema-faithful but slim spans (tool spans with real names/payload keys; no LLM prompt bodies), to keep 100K sessions to a few GB.
- The existing draft `cie/synth.py` is superseded by this spec; its known bugs are listed in AGENTS.md WP0.
