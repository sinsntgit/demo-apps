# Intent taxonomy v0-draft (DRAFT for SME review)

_Generated from `taxonomy/taxonomy_v0.yaml`. Stable IDs = codes. L4 variations are added in Week 2 discovery._

Classification evidence order: platform label (0.90; generic routing labels 0.60) > customer keyword (0.70, +0.05 on the platform's need-capture turn) > short IVR token (0.50). Within the same L2, the customer's latest explicit words choose the L3. A representative request is primary only when no other need is stated. Below 0.45 -> `UNKNOWN`.

## BILL: Billing

### BILL.EXPLAIN: Bill explanation

**`BILL.EXPLAIN.CHARGES`: Explain charges / bill higher than expected** (family: need)  
Customer wants the charges on a bill explained, or asks why the bill changed.  
Include: why is my bill higher; explain the charges; what am I billed for  
Exclude: charge the customer says they did not authorise (BILL.CHARGE.FRAUD); explicit dispute (BILL.CHARGE.DISPUTE)  
Platform labels: `bill_explain(?!_incorrect)`, `bill_breakdown`, `bill_problem_general|0.60`, `billingIssues|0.60`, `bill_plus_operator|0.60`

**`BILL.EXPLAIN.BALANCE`: Balance / amount owed** (family: need)  
Customer asks for the current balance, amount due or previous bill amount.  
Include: what do I owe; what is my balance; what was my previous bill  
Exclude: asking to pay it (PAY.MAKE.ONE_TIME)  
Platform labels: `BillingBalance`, `RecentAccountActivity|0.60`

**`BILL.EXPLAIN.STATEMENT`: Statement not received / copies** (family: need)  
Customer did not receive a bill or wants copies of statements.  
Include: did not receive my bill; hard copies of statements  
Exclude: -  
Platform labels: `bill_not_received`

### BILL.CHARGE: Unexpected or disputed charge

**`BILL.CHARGE.INQUIRY`: Unrecognised charge enquiry** (family: need)  
Customer sees a charge they do not recognise and asks what it is, without disputing it yet.  
Include: what is this charge; unexpected charge; review unexpected charge  
Exclude: customer says they did not authorise it (BILL.CHARGE.FRAUD)  
Platform labels: `charge_inquiry`

**`BILL.CHARGE.DISPUTE`: Disputed / incorrect charge** (family: risk)  
Customer states a charge or bill is wrong and wants it corrected or reversed.  
Include: disputing TravelPass charges; overcharged; incorrect bill  
Exclude: fraud / not my account activity (BILL.CHARGE.FRAUD)  
Platform labels: `charge_dispute`, `bill_explain_incorrect|0.60`

**`BILL.CHARGE.FRAUD`: Unauthorised activity / fraud** (family: risk)  
Customer reports a charge, line or device they did not authorise, or account activity that is not theirs.  
Include: I didn't authorize this; not my phone; fraud  
Exclude: -  
Platform labels: `fraud`, `unauthori`

### BILL.DUEDATE: Due date

**`BILL.DUEDATE.CHANGE`: Confirm or change due date** (family: need)  
Customer asks when the bill is due or wants a different due date.  
Include: when is my bill due; change my due date  
Exclude: cannot pay -> PAY.ARRANGE.EXTENSION  
Platform labels: `due_date`

## PAY: Payments

### PAY.MAKE: Make a payment

**`PAY.MAKE.ONE_TIME`: Make a payment** (family: need)  
Customer wants to pay a bill now.  
Include: I want to make a payment  
Exclude: -  
Platform labels: `make_payment`, `payment_make`

### PAY.STATUS: Payment status

**`PAY.STATUS.NOT_REFLECTED`: Payment made but not reflected / service still off** (family: need)  
Customer paid but the payment is not showing or service has not been restored.  
Include: I paid my bill but my phone is still not on  
Exclude: -  
Platform labels: `payment_status`, `restore`

**`PAY.STATUS.FAILED`: Failed or declined payment** (family: friction)  
A payment attempt failed, was declined, or autopay did not run.  
Include: my card was declined  
Exclude: -  
Platform labels: `payment_failed`

### PAY.ARRANGE: Payment arrangement

**`PAY.ARRANGE.EXTENSION`: Extension / payment arrangement** (family: risk)  
Customer cannot pay in full or on time and asks for more time or a plan.  
Include: can I get an extension; I'm past due  
Exclude: -  
Platform labels: `payment_arrangement`, `extension`

## REFUND: Refunds and adjustments

### REFUND.REQUEST: Refund or credit

**`REFUND.REQUEST.OVERPAYMENT`: Refund of overpayment / credit balance** (family: need)  
Customer wants money back for an overpayment, credit balance or partial payment.  
Include: refund my credit balance; overpayment of bills  
Exclude: dispute of a charge (BILL.CHARGE.DISPUTE)  
Platform labels: `bill_refund`, `refund`

**`REFUND.REQUEST.CREDIT_INQUIRY`: Credit / adjustment enquiry** (family: need)  
Customer asks about a credit, adjustment or promised credit on the account.  
Include: question about a credit; where is my credit  
Exclude: -  
Platform labels: `credit_inquiry`, `adjustment`

## ACCT: Account

### ACCT.ACCESS: Account access and authentication

**`ACCT.ACCESS.PIN`: Forgotten PIN / cannot log in** (family: friction)  
Customer cannot authenticate because they do not know the PIN or password.  
Include: I don't have the pin; forgot my password  
Exclude: -  
Platform labels: `account_access`, `pin_reset`, `password`

**`ACCT.ACCESS.VERIFY`: Verification code problems** (family: friction)  
The one-time code / text verification did not arrive or failed.  
Include: the code never arrived  
Exclude: -  
Platform labels: - (keyword rules only)

### ACCT.LOOKUP: Account or number lookup

**`ACCT.LOOKUP.NUMBER`: Problem with phone number / account lookup** (family: friction)  
Customer's number cannot be found, belongs to someone else, or they call about another person's number.  
Include: problem with someone's phone number; new mobile number  
Exclude: -  
Platform labels: `number_lookup`

## PLAN: Products and plans

### PLAN.ENQUIRY: Plan enquiry

**`PLAN.ENQUIRY.OPTIONS`: Plan options / change plan** (family: buying)  
Customer asks what plans exist or wants to change plan (not mainly to save money).  
Include: which plan is best for me; change my plan  
Exclude: mainly to reduce cost (PLAN.CHANGE.LOWER_COST)  
Platform labels: `plan_change`, `plan_add_change`, `plan_inquiry`

**`PLAN.ENQUIRY.COMPARE`: Plan / feature comparison** (family: value)  
Customer compares plans, features or offers, including competitors.  
Include: what's the difference between those two plans  
Exclude: -  
Platform labels: `plan_compare`

### PLAN.CHANGE: Plan cost

**`PLAN.CHANGE.LOWER_COST`: Lower my bill / cheaper plan** (family: value)  
Customer wants to reduce what they pay.  
Include: I want to lower my bill; cheaper plan  
Exclude: asks only about promotions (PLAN.DISCOUNT.PROMO)  
Platform labels: `bill_reduce`

### PLAN.DISCOUNT: Discounts and promotions

**`PLAN.DISCOUNT.PROMO`: Discount / promotion enquiry** (family: value)  
Customer asks which discounts, promotions or loyalty offers apply.  
Include: do you have any discounts; veteran discount  
Exclude: -  
Platform labels: `discount`, `promo`

## ADDSVC: Additional services

### ADDSVC.LINE: Lines

**`ADDSVC.LINE.ADD`: Add a line** (family: buying)  
Customer wants to add a line or device for another person.  
Include: add a line for my daughter  
Exclude: -  
Platform labels: `add_line`, `new_line`

### ADDSVC.CONNECT: Hotspot and home internet

**`ADDSVC.CONNECT.HOTSPOT_HOME`: Hotspot / home internet** (family: buying)  
Customer needs a hotspot, tethering, or home internet / 5G Home / Fios service.  
Include: I need a hotspot for my laptop; 5G home internet  
Exclude: -  
Platform labels: `hotspot`, `home_internet`, `fios`

### ADDSVC.TRAVEL: Travel and international

**`ADDSVC.TRAVEL.INTERNATIONAL`: International travel / calling / TravelPass** (family: buying)  
Customer asks about using service abroad, TravelPass, roaming, or international rates.  
Include: I'm traveling to Mexico; international rates  
Exclude: dispute of TravelPass charges is BILL.CHARGE.DISPUTE (travel becomes secondary)  
Platform labels: `international`, `travel`, `roaming`

## DEVICE: Devices

### DEVICE.UPGRADE: Device upgrade

**`DEVICE.UPGRADE.ELIGIBILITY`: Upgrade / new phone** (family: buying)  
Customer wants a new device, asks about upgrade eligibility or trade-in.  
Include: am I eligible for a new iPhone; trade in my phone  
Exclude: replacement because broken/lost (DEVICE.REPLACE.DAMAGE_LOSS)  
Platform labels: `upgrade`, `trade_in`

### DEVICE.REPLACE: Device replacement

**`DEVICE.REPLACE.DAMAGE_LOSS`: Broken, lost or stolen device** (family: value)  
Device is damaged, lost or stolen and the customer needs a replacement or insurance claim.  
Include: I cracked my screen; my phone was stolen  
Exclude: -  
Platform labels: `device_damage`, `insurance`, `lost_stolen`

### DEVICE.ORDER: Orders and returns

**`DEVICE.ORDER.RETURN_STATUS`: Order / return status** (family: need)  
Customer asks where an order is, or whether returned equipment was received.  
Include: where is my order; I returned my equipment  
Exclude: -  
Platform labels: `order_status`, `return`

## SERVICE: Service

### SERVICE.CONNECTIVITY: Connectivity and coverage

**`SERVICE.CONNECTIVITY.COVERAGE`: Coverage / cannot make or receive calls** (family: need)  
Poor signal, dropped calls, or inability to make or receive calls at a location.  
Include: I have no signal at my house; calls keep dropping  
Exclude: area-wide outage (SERVICE.OUTAGE.DISRUPTION)  
Platform labels: `cannot_make_receive_call`, `coverage`, `signal`

### SERVICE.OUTAGE: Outage

**`SERVICE.OUTAGE.DISRUPTION`: Service outage / disruption** (family: risk)  
Service is down for the customer or their area.  
Include: is there an outage in my area; my internet is down  
Exclude: -  
Platform labels: `outage`

### SERVICE.ACTIVATION: Activation

**`SERVICE.ACTIVATION.NEW`: Activate device / SIM** (family: need)  
Customer needs to activate a new device, SIM or line.  
Include: activate my new phone  
Exclude: -  
Platform labels: `activation`, `activate`

## RETENTION: Retention

### RETENTION.CANCEL: Cancellation

**`RETENTION.CANCEL.INTENT`: Cancel service / switch carrier** (family: risk)  
Customer states they want to cancel, port out, or move to a competitor.  
Include: I want to cancel my service; I'm switching to T-Mobile  
Exclude: cancelling an add-on feature only (PLAN.ENQUIRY.OPTIONS)  
Platform labels: `cancel`, `disconnect`, `port_out`

## GENERAL: General enquiries

### GENERAL.INFO: General information

**`GENERAL.INFO.HOURS`: Hours / when agents are available** (family: need)  
Customer asks when customer service or a department is open.  
Include: when is customer service open  
Exclude: -  
Platform labels: - (keyword rules only)

## ESCALATION: Escalation

### ESCALATION.REP: Representative request

**`ESCALATION.REP.REQUEST`: Representative request with no stated need** (family: friction)  
Customer asks for a person and states no other need. Used as the primary intent only when nothing else is expressed; otherwise it is a friction signal.  
Include: representative please; live agent  
Exclude: any session with another stated need (use that need; escalation becomes a signal)  
Platform labels: `^Operator$`

