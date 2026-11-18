"""Signal lexicon, role/tool semantics, PII guard and gazetteer (rules version: config.VERSIONS['rules']).

Patterns run on *redacted* customer text only. ASR text is noisy, so patterns tolerate fillers.
Every signal type here must appear in docs/signal_catalogue.md (generated from this file).
"""
import re

# family -> category label used in reports (design baseline §7.1)
FAMILY_CATEGORY = {
    "need": "Customer need", "buying": "Buying intent", "value": "Value signal", "risk": "Retention risk",
    "friction": "Journey friction", "experience": "Experience indicator", "geo": "Geographic signal",
    "temporal": "Temporal indicator",
}

# (family, type, confidence, regex, description)
_L = [
    # ---- BUYING INTENT ----
    ("buying", "upgrade_device", .80, r"\b(upgrade (my )?(phone|device)|new (phone|iphone|device|galaxy|pixel)|trade[- ]?in|eligible for (an? )?(upgrade|new phone)|(latest|newest) (iphone|galaxy|pixel|samsung|phone|handset)|iphone ?\d{1,2}|galaxy ?s ?\d{1,2})\b", "Interest in a new device, upgrade eligibility or trade-in"),
    ("buying", "add_line", .85, r"\b(add (a|an|another|one more|an extra|a new) (phone )?line|(new|another|extra|additional) line|add (my|a) (wife|husband|son|daughter|kid|kids|mom|dad|parent|partner)|line for (my|a) (son|daughter|kid|wife|husband|mom|dad)|(his|her|their) own phone)\b", "Add-a-line enquiry"),
    ("buying", "plan_question", .70, r"\b(which plan|plan (options|change|comparison)|change (my )?plan|different plan|unlimited (plan|data)|what plans|more data|run(ning)? out of data|premium unlimited)\b", "Question about plans or changing plan"),
    ("buying", "hotspot_home_internet", .85, r"\b(hot ?spot|tether(ing)?|home internet|5g home|fios|wi-?fi for my (laptop|house|home)|internet (for|at) (my )?(house|home|apartment)|jetpack)\b", "Hotspot, tethering or home-internet need"),
    ("buying", "travel_intl", .85, r"\b(travel ?pass|roaming|international (calling|plan|rates|data|roaming|travel|billing)|going (abroad|overseas)|overseas|abroad|out of the country|(trip|travel(l?ing)?|vacation|cruise|flying|heading) (to|abroad))\b", "Travel / international need"),
    # ---- CUSTOMER NEED (text) ----
    ("need", "coverage_availability", .80, r"\b(no (signal|service|bars|reception)|dead ?zone|spotty|coverage|(poor|bad|weak|terrible|awful) (signal|reception|service)|drops? (my )?calls?|calls? (keep )?drop(ping|ped)?|can'?t (make|receive|get) (calls|a signal)|barely works)\b", "Coverage / availability problem"),
    # ---- VALUE ----
    ("value", "willingness", .80, r"\b(i'?d (like|love|be interested)|i would (like to (get|add|order|buy|upgrade)|love|be interested)|i'?m interested|interested in|sign me up|let'?s do (it|that)|how (do|can) i (get|add|sign up|order|upgrade)|that sounds (good|great|perfect)|sounds good|yes,? please (add|do|go ahead|set)|go ahead and (add|set|order|upgrade|change)|count me in|i'?ll take (it|that))\b", "Explicit willingness to buy / accept"),
    ("value", "price_sensitivity", .85, r"\b(too (expensive|much|high|pricey)|cheaper|lower (my|the) (bill|price|rate|cost)|(reduce|cut|lower) (my )?(bill|cost|payment)|can'?t afford|afford|price (went|has gone|increase|hike)|why (is|did) (it|my bill) (so )?(high|more|go up)|budget|save (some )?money|discount|promo(tion)?s?|bill (is )?(too )?(high|crazy|insane)|paying too much)\b", "Price sensitivity or cost-reduction language"),
    ("value", "feature_comparison", .80, r"\b(what('?s| is) the difference|difference between|compare|comparison|versus|\bvs\.?\b|which (one )?is better|better than|does (it|that|this) (include|come with|have)|worth (it|the extra)|(t-?mobile|at&?t|xfinity|spectrum) (has|offers|is))\b", "Comparing plans, features or competitors"),
    ("value", "device_replacement", .85, r"\b((cracked|broken|shattered|smashed|lost|stolen|dead|water[- ]damaged?|damaged) (my |the |a )?(phone|screen|device|display)|(phone|screen|device|display) (is |got |was )?(cracked|broken|shattered|smashed|lost|stolen|dead|damaged)|replace(ment)? (my |the |a )?(phone|device)|insurance claim|dropped my phone)\b", "Device replacement cue"),
    ("value", "multi_line_expansion", .80, r"\b((two|three|four|five|six|2|3|4|5|6) (more |new |extra )?lines|whole family|family plan|my (kids|children|whole family|employees)|add (my )?(wife|husband|kids?)|more lines|multi[- ]?line)\b", "Multi-line / household expansion"),
    # ---- RETENTION RISK ----
    ("risk", "churn_intent", .90, r"\b(cancel (my )?(service|account|line|plan|contract|verizon)|switch(ing)? (to|over to) (t-?mobile|at&?t|another|a different|xfinity|spectrum)|port (my )?number|leav(e|ing) verizon|close (my )?account|disconnect (my )?(service|line|account)|taking my business elsewhere|done with (this company|verizon))\b", "Cancellation or switching language"),
    ("risk", "complaint", .75, r"\b(ridiculous|unacceptable|terrible|horrible|worst|rip ?off|scam|this is (crazy|insane|absurd)|not (happy|satisfied)|waste of (my )?time)\b", "Complaint about service or company"),
    ("risk", "dispute", .85, r"\b(disput(e|ing)|didn'?t (authorize|make)|unauthori[sz]ed|unrecogni[sz]ed|fraud(ulent)?|(wrong|incorrect|double|duplicate) (charge|bill|billing)|charged (me )?twice|overcharg(ed|e)|billing error|never (ordered|asked for|agreed)|not my (phone|line|account))\b", "Disputed or unauthorised charge"),
    ("risk", "payment_difficulty", .80, r"\b(can'?t (pay|make (a |my )?payment)|late (fee|payment)|past due|payment (arrangement|plan|extension)|extension|behind on|money is tight|short until|suspended|service (is )?(off|suspended|inactive)|collections?)\b", "Difficulty paying / suspension"),
    ("risk", "repeat_contact_language", .85, r"\b((called|calling|spoke|talked|contacted) (before|yesterday|last (week|night|month)|already|again|earlier|twice|several times)|(second|third|fourth|2nd|3rd) time|still (not|haven'?t|hasn'?t|isn'?t|doesn'?t)|nobody (called|fixed|helped|got back)|same (problem|issue)|(already|previously) (told|called|reported|explained)|connected with us recently)\b", "Customer says they contacted before / issue persists"),
    # ---- JOURNEY FRICTION (text) ----
    ("friction", "escalation_request", .90, r"\b((live|real|actual) (agent|person|representative|human|rep)|(speak|talk|connect|transfer)( me)?( with| to)? (a |an |the )?(agent|someone|somebody|person|human|representative|rep|customer (service|care))|representative|operator|supervisor|manager|customer service agent|get (me )?(someone|somebody|a person|an agent) on the (phone|line)|transfer (me|now)|human being|(an? )?associate|customer agent)\b|^\W*(no\W+)?(an? )?(agent|customer service|someone|somebody|a person)( please)?\W*$", "Asks for a human agent"),
    # ---- EXPERIENCE ----
    ("experience", "frustration", .75, r"\b(frustrat(ed|ing)|fed up|sick of|oh my god|so annoying|angry|furious|now now|right now!?|i'?m (very )?(upset|sad|annoyed)|come on)\b", "Frustration / emotional distress"),
    ("experience", "confusion", .75, r"\b(i'?m (so |very )?confused|(i )?don'?t understand|don'?t know (how|what) to do|what do you mean|i don'?t get it|makes no sense|am i talking to|you have what)\b|^\W*(what|huh)\?\W*$", "Confusion about the process or the agent"),
    ("experience", "positive_response", .70, r"\b(thank you so much|that (helps|helped)|perfect|great,? thank(s| you)?|thanks?,? (that|this) (helps|works)|appreciate (it|that|you)|that'?s (great|perfect|helpful)|awesome)\b", "Positive response / satisfaction cue"),
    # ---- GEO (text) ----
    ("geo", "local_event", .75, r"\b(concert|festival|stadium|football game|marathon|convention|conference|hurricane|storm|tornado|flood(ing)?|blackout|power (outage|out)|wildfire|move(d|ing)? (to|into)|relocat(ed|ing)|my neighborhood|in my area|in our area)\b", "Local event, weather or relocation"),
    ("geo", "coverage_local", .80, r"\b((at|in) my (house|home|apartment|office|building|dorm|basement|neighborhood|area|town)|where i live|around here|rural)\b", "Coverage tied to a specific place"),
]
TEXT_SIGNALS = [(f, t, c, re.compile(p, re.I), d) for f, t, c, p, d in _L]

# Signals produced by other methods (documented in the catalogue)
DERIVED_SIGNALS = [
    ("need", "billing_clarification", "intent", "Turn classified to a BILL.* intent"),
    ("need", "payment_issue", "intent", "Turn classified to a PAY.* intent"),
    ("need", "refund_credit", "intent", "Turn classified to a REFUND.* intent"),
    ("need", "account_access", "intent", "Turn classified to an ACCT.* intent"),
    ("need", "service_request", "intent", "Turn classified to SERVICE.ACTIVATION / DEVICE.ORDER"),
    ("friction", "agent_handoff", "tool", "A *transfer* tool was executed"),
    ("friction", "auth_failure", "tool", "invalid_auth / failed PIN / verification failure"),
    ("friction", "no_input", "event", "'no user activity detected' system event"),
    ("friction", "dtmf_operator", "event", "Customer pressed 0 (operator)"),
    ("friction", "agent_loop", "derived", "Agent repeats an earlier response (token Jaccard >= threshold)"),
    ("friction", "customer_repeat", "derived", "Customer repeats an earlier utterance"),
    ("friction", "tool_failure", "tool", "Tool span reports an error / failure status"),
    ("friction", "out_of_scope", "tool", "handle_out_of_scope tool executed"),
    ("friction", "abandoned", "derived", "Session ends by disconnect or repeated no-input without handoff"),
    ("geo", "city_mention", "gazetteer", "A known city named in customer text (typed: destination/current/unknown)"),
    ("geo", "location_mismatch", "derived", "Text city differs from the structured service location"),
    ("geo", "location_unresolved", "placeholder", "[LOCATION] redaction placeholder in customer text"),
    ("temporal", "repeat_contact", "metadata", "Session has previous_session_id (thread-linked repeat)"),
    ("temporal", "repeat_same_issue", "derived", "Same L2 intent as the previous session in the thread"),
]

# L3 intent prefix -> need-signal type emitted from classification
INTENT_NEED_SIGNAL = [("BILL.", "billing_clarification"), ("PAY.", "payment_issue"), ("REFUND.", "refund_credit"),
                      ("ACCT.", "account_access"), ("SERVICE.ACTIVATION", "service_request"), ("DEVICE.ORDER", "service_request")]

# ----------------------------------------------------------------- roles / tools / events
GENERIC_ROLES = {"bootstrap_agent", "root_agent", "smart_greeting", "authentication_acct_pin", "enhanced_secure_pin",
                 "adaptive_auth", "tool", "banner_messages", "unauth_handler", "known_products_disambig",
                 "unknown_products_disambig"}
AUTH_ROLES = {"authentication_acct_pin", "enhanced_secure_pin", "adaptive_auth"}
UNAUTH_ROLE = re.compile(r"^unauth", re.I)
TRANSFER_TOOL = re.compile(r"transfer", re.I)
AUTH_FAIL_TOOL = re.compile(r"^(invalid_auth)$", re.I)
INTENT_TOOLS = {"mandatory_set_intent_for_next_step", "retrieve_intent_matches", "explain_bill_init_mcp", "handle_out_of_scope"}
AGENT_AUTH_FAIL = re.compile(r"(pin (did not|didn'?t) match|pin was incorrect|unable to authenticate|wasn'?t able to send the code|unable to find that number|code you entered (is|was) (incorrect|invalid))", re.I)
AGENT_HANDOFF_TEXT = re.compile(r"(connect(ing)? you (with|to)|transfer(ring)? you|hold while i transfer|get you to an agent)", re.I)

EVENT_RE = re.compile(r"^\s*<(event|context)>(.*)</\1>\s*$", re.S)
DTMF_RE = re.compile(r"user pressed (.+?) on keypad", re.I)
NOINPUT_RE = re.compile(r"no user activity detected", re.I)
FUNC_RE = re.compile(r"function \[([^\]]+)\] completed", re.I)

MARKUP = re.compile(r"\[(?:prosody[^\]]*|[a-z][a-z _\-]*)\]")        # lower-case tags; UPPER placeholders kept
PLACEHOLDER = re.compile(r"\[[A-Z_]{3,}\]")
LOCATION_PH = re.compile(r"\[LOCATION\]")
TOKEN = re.compile(r"[a-z']+")

# defence-in-depth PII scrub (applied at ingest on top of vendor redaction)
PII_PATTERNS = [
    ("[EMAIL]", re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")),
    ("[SSN]", re.compile(r"\b\d{3}-\d{2}-\d{4}\b")),
    ("[CARD]", re.compile(r"\b(?:\d[ -]?){13,16}\b")),
    ("[PHONE_NUMBER]", re.compile(r"(?<![\w$])(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b")),
]
# extra masking for quotes shown on evidence cards
QUOTE_MASKS = [(re.compile(r"\$\s?\d[\d,]*(\.\d+)?"), "[AMOUNT]"), (re.compile(r"\b\d{3,}\b"), "[NUMBER]")]

# Spanish / Portuguese markers (real sample contains both)
LANG_MARKERS = {
    "es": re.compile(r"\b(el día|cómo|qué|gracias|por favor|sí|necesito|cuenta|factura|hablar con|español|quiero|ayuda)\b", re.I),
    "pt": re.compile(r"\b(não|obrigad[oa]|você|conta|preciso|português)\b", re.I),
}

# ----------------------------------------------------------------- gazetteer
# city, state, region, market (ASSUMED/illustrative market names, not Verizon's), lat, lon
CITIES = [
    ("New York", "NY", "Northeast", "NY Metro", 40.71, -74.01), ("Brooklyn", "NY", "Northeast", "NY Metro", 40.65, -73.95),
    ("Boston", "MA", "Northeast", "New England", 42.36, -71.06), ("Philadelphia", "PA", "Northeast", "Philadelphia Tri-State", 39.95, -75.17),
    ("Pittsburgh", "PA", "Northeast", "Western PA", 40.44, -80.0), ("Newark", "NJ", "Northeast", "NY Metro", 40.74, -74.17),
    ("Baltimore", "MD", "Mid-Atlantic", "Washington-Baltimore", 39.29, -76.61), ("Washington", "DC", "Mid-Atlantic", "Washington-Baltimore", 38.91, -77.04),
    ("Richmond", "VA", "Mid-Atlantic", "Virginia", 37.54, -77.44), ("Charlotte", "NC", "Southeast", "Carolinas", 35.23, -80.84),
    ("Raleigh", "NC", "Southeast", "Carolinas", 35.78, -78.64), ("Atlanta", "GA", "Southeast", "Georgia", 33.75, -84.39),
    ("Orlando", "FL", "Southeast", "Central Florida", 28.54, -81.38), ("Lake Mary", "FL", "Southeast", "Central Florida", 28.76, -81.32),
    ("Miami", "FL", "Southeast", "South Florida", 25.76, -80.19), ("Tampa", "FL", "Southeast", "Central Florida", 27.95, -82.46),
    ("Jacksonville", "FL", "Southeast", "North Florida", 30.33, -81.66), ("Nashville", "TN", "Southeast", "Tennessee", 36.16, -86.78),
    ("Memphis", "TN", "Southeast", "Tennessee", 35.15, -90.05), ("New Orleans", "LA", "South", "Gulf Coast", 29.95, -90.07),
    ("Houston", "TX", "South", "Houston", 29.76, -95.37), ("Dallas", "TX", "South", "North Texas", 32.78, -96.8),
    ("Austin", "TX", "South", "Central Texas", 30.27, -97.74), ("San Antonio", "TX", "South", "Central Texas", 29.42, -98.49),
    ("Oklahoma City", "OK", "South", "Oklahoma", 35.47, -97.52), ("Chicago", "IL", "Midwest", "Chicago", 41.88, -87.63),
    ("Detroit", "MI", "Midwest", "Michigan", 42.33, -83.05), ("Cleveland", "OH", "Midwest", "Ohio", 41.5, -81.69),
    ("Columbus", "OH", "Midwest", "Ohio", 39.96, -83.0), ("Indianapolis", "IN", "Midwest", "Indiana", 39.77, -86.16),
    ("Milwaukee", "WI", "Midwest", "Wisconsin", 43.04, -87.91), ("Minneapolis", "MN", "Midwest", "Upper Midwest", 44.98, -93.27),
    ("St. Louis", "MO", "Midwest", "Missouri", 38.63, -90.2), ("Kansas City", "MO", "Midwest", "Missouri", 39.1, -94.58),
    ("Denver", "CO", "Mountain", "Colorado", 39.74, -104.99), ("Salt Lake City", "UT", "Mountain", "Utah", 40.76, -111.89),
    ("Phoenix", "AZ", "Southwest", "Arizona", 33.45, -112.07), ("Las Vegas", "NV", "Southwest", "Nevada", 36.17, -115.14),
    ("Albuquerque", "NM", "Southwest", "New Mexico", 35.08, -106.65), ("Los Angeles", "CA", "West", "Southern California", 34.05, -118.24),
    ("San Diego", "CA", "West", "Southern California", 32.72, -117.16), ("San Francisco", "CA", "West", "Bay Area", 37.77, -122.42),
    ("San Jose", "CA", "West", "Bay Area", 37.34, -121.89), ("Sacramento", "CA", "West", "Northern California", 38.58, -121.49),
    ("Seattle", "WA", "Pacific NW", "Pacific Northwest", 47.61, -122.33), ("Portland", "OR", "Pacific NW", "Pacific Northwest", 45.52, -122.68),
]
CITY_INFO = {c[0]: {"state": c[1], "region": c[2], "market": c[3], "lat": c[4], "lon": c[5]} for c in CITIES}
STATE_REGION = {}
for c in CITIES:
    STATE_REGION.setdefault(c[1], c[2])
_names = {c[0].lower(): c[0] for c in CITIES}
_names.update({"nyc": "New York", "new york city": "New York", "philly": "Philadelphia", "nola": "New Orleans",
               "vegas": "Las Vegas", "saint louis": "St. Louis", "st louis": "St. Louis"})
CITY_LOOKUP = _names
CITY_RE = re.compile(r"\b(" + "|".join(sorted((re.escape(k) for k in _names), key=len, reverse=True)) + r")\b", re.I)
# location typing for text mentions
DEST_CUE = re.compile(r"\b(to|visiting|trip to|flying to|heading to|travel(l?ing)? to|going to)\s+$", re.I)
CURRENT_CUE = re.compile(r"\b(i'?m (in|at|out in)|calling from|right now in|currently in)\s+$", re.I)
RESIDENCE_CUE = re.compile(r"\b(i live in|my (house|home|apartment) in|we live in|based in|near)\s+$", re.I)
