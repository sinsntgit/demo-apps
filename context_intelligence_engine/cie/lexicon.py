"""Signal lexicons, platform-intent mapping and the geography gazetteer.

Everything the extractor knows lives here so it can be reviewed / governed in one place.
Patterns run on the *redacted* customer text only (ASR transcripts are noisy, so patterns are
deliberately tolerant of fillers and word order).
"""
import re

# ---------------------------------------------------------------- text-signal lexicon
# (family, type, confidence, regex)
_L = [
    # ---- NEED / UPSELL ----
    ("need", "upgrade_device", .80, r"\b(upgrade|new (phone|iphone|device|galaxy|pixel)|trade[- ]?in|eligible for (an? )?(upgrade|new phone)|latest (iphone|galaxy|pixel|samsung)|iphone ?\d{1,2}|galaxy ?s ?\d{1,2}|pixel ?\d)\b"),
    ("need", "add_line", .85, r"\b(add (a|an|another|one more|an extra|a new) (phone )?line|(new|another|extra|additional) line|add (my|a) (wife|husband|son|daughter|kid|kids|mom|dad|parent|partner|girlfriend|boyfriend|roommate|employee)|line for (my|a) (son|daughter|kid|wife|husband|mom|dad))\b"),
    ("need", "plan_question", .70, r"\b(which plan|plan (options|change|comparison)|change (my )?plan|different plan|unlimited (plan|data)|(welcome|go|play|do|get|start) (more |unlimited )?plan|what plans|data (plan|allowance|cap)|premium unlimited|more data|run out of data|plan that)\b"),
    ("need", "hotspot_home_internet", .85, r"\b(hot ?spot|tether(ing)?|home internet|5g home|fios|wi-?fi for my (laptop|house|home)|internet (for|at) (my )?(house|home|apartment)|jetpack|lte home)\b"),
    ("need", "travel_intl", .85, r"\b(travel ?pass|roaming|international (calling|plan|rates|data|roaming|travel)|going (abroad|overseas)|(trip|travel(l?ing)?|vacation|cruise|holiday|honeymoon) (to|in|abroad|overseas)|overseas|abroad|leaving the country|(to|in) (mexico|canada|europe|london|paris|cancun|japan|italy|spain|brazil|india|ireland))\b"),
    ("need", "coverage_availability", .80, r"\b(no (signal|service|bars|reception)|dead ?zone|spotty|coverage|(poor|bad|weak|terrible) (signal|reception|service)|drops? (my )?calls?|calls? (keep )?drop(ping|ped)?|can'?t get (a )?signal|no 5g|slow data|network (is )?(down|bad|slow))\b"),
    ("need", "service_request", .55, r"\b(i (need|want|would like) (to )?(get|set up|activate|order|sign up|switch|move|transfer)|set up (a|my)|activate (my|a|the)|ship(ped|ping)? (me|my)|schedule (a|an) (appointment|installation|technician))\b"),
    # ---- VALUE ----
    ("value", "willingness", .80, r"\b(i'?d (like|love|be interested)|i would (like|love|be interested)|i'?m interested|interested in|sign me up|let'?s do (it|that)|how (do|can) i (get|add|sign up|order|upgrade)|that sounds (good|great|perfect|fine)|sounds good|yes,? please (add|do|go ahead|set)|go ahead and (add|set|order|upgrade|change)|i want (to get|that|the|it)|count me in|i'?ll take (it|that))\b"),
    ("value", "price_sensitivity", .85, r"\b(too (expensive|much|high|pricey)|cheaper|lower (my|the) (bill|price|rate|cost)|(reduce|cut|lower) (my )?(bill|cost|payment)|afford|can'?t afford|price (went|has gone|increase|hike)|(raised|increased) (my )?(bill|price|rate)|why (is|did) (it|my bill) (so )?(high|more|go up)|budget|save (some )?money|(any|got|have) (a )?(discount|promo|promotion|deal|offer|credit)s?|discount|promo(tion)?|bill (is )?(too )?(high|crazy|insane)|paying too much|costs? (too|so) much)\b"),
    ("value", "feature_comparison", .80, r"\b(what('?s| is) the difference|difference between|compare|comparison|versus|\bvs\.?\b|which (one )?is better|better than|does (it|that|this) (include|come with|have)|what (does|do) .{0,20}(include|come with)|is .{0,25} worth it|(t-?mobile|at&?t|xfinity|spectrum) (has|offers|is)|(whats|what'?s) included)\b"),
    ("value", "device_replacement", .85, r"\b((cracked|broken|shattered|lost|stolen|dead|water[- ]damaged?|damaged) (my |the |a )?(phone|screen|device|iphone|galaxy)|(phone|screen|device) (is |got |was )?(cracked|broken|shattered|lost|stolen|dead|damaged|won'?t (turn on|charge))|replace(ment)? (my |the |a )?(phone|device)|insurance claim|dropped my phone|phone (fell|died))\b"),
    ("value", "multi_line_expansion", .80, r"\b((two|three|four|five|six|2|3|4|5|6) (more |new |extra )?(lines|phones)|whole family|family plan|my (kids|children|whole family|parents|employees|team|staff)|add (my )?(wife|husband|kids?|son|daughter|parents)|several lines|more lines|multi[- ]?line|(all|both) (of )?(our|my) (lines|phones))\b"),
    # ---- RISK ----
    ("risk", "escalation_request", .90, r"\b((live|real|actual) (agent|person|representative|human|rep)|(speak|talk|connect|transfer)( me)?( with| to| me to)? (a |an |the |some ?one|somebody|an? agent|a rep|customer (service|care))|representative|operator|supervisor|manager|customer service agent|get me (a |an )?(agent|someone|somebody|person)|human being|agent (please|now))\b"),
    ("risk", "churn_intent", .90, r"\b(cancel (my )?(service|account|line|plan|contract|verizon)|switch(ing)? (to|over to) (t-?mobile|at&?t|another|a different|xfinity|spectrum)|port (my )?number (out|over)|leav(e|ing) verizon|going (to|with) (t-?mobile|at&?t|xfinity|spectrum)|close (my )?account|stop (my )?service|disconnect (my )?(service|line|account)|competitor)\b"),
    ("risk", "complaint", .75, r"\b(frustrat(ed|ing)|ridiculous|unacceptable|terrible|horrible|worst|fed up|sick of|third time|fourth time|waste of (my )?time|so annoying|not (happy|satisfied)|angry|furious|this is (crazy|insane|absurd)|rip ?off|scam)\b"),
    ("risk", "repeat_contact_language", .85, r"\b((called|calling|spoke|talked|contacted|chatted|came in) (before|yesterday|last (week|night|month)|already|again|earlier|twice|several times)|(second|third|fourth|fifth|2nd|3rd) (time|call)|still (not|haven'?t|hasn'?t|isn'?t|doesn'?t|no)|nobody (called|fixed|helped|followed)|same (problem|issue)|again and again|(already|previously) (told|called|reported|explained)|no one (called|fixed|helped|followed)|supposed to (be|get) (fixed|called|credited))\b"),
    ("risk", "dispute", .85, r"\b(dispute|disputing|didn'?t (authorize|make)|unauthori[sz]ed|unrecogni[sz]ed|fraud(ulent)?|(wrong|incorrect|double|duplicate) (charge|bill|billing)|charged (twice|me)|overcharg(ed|e)|billing error|never (ordered|asked for|agreed))\b"),
    ("risk", "payment_difficulty", .80, r"\b(can'?t (pay|make (a )?payment)|late (fee|payment)|past due|payment (arrangement|plan|extension)|extend(ed)? (my )?due date|behind on|struggling to pay|hardship|suspended|service (is )?(off|suspended|disconnected)|collections?)\b"),
    # ---- GEO (non-gazetteer) ----
    ("geo", "local_event", .75, r"\b(concert|festival|stadium|football game|world cup|super ?bowl|marathon|convention|conference|expo|parade|hurricane|storm|tornado|flood(ing)?|blackout|power (outage|out)|wildfire|snow ?storm|move(d|ing)? (to|into)|relocat(ed|ing)|new (house|apartment|home|job) in|my neighborhood|in my area|in our area|on my street)\b"),
    ("geo", "coverage_local", .80, r"\b((at|in) my (house|home|apartment|office|building|dorm|basement|neighborhood|area|town)|(at|in) (the )?(downtown|campus|airport|mall|stadium)|rural|out in the country|mountain|where i live|around here)\b"),
]
TEXT_SIGNALS = [(f, t, c, re.compile(p, re.I)) for f, t, c, p in _L]

# --------------------------------------------------------------- platform intent labels
# intent_name (from mandatory_set_intent_for_next_step) -> list of (family, type)
PLATFORM_INTENT_MAP = [
    (r"bill_reduce|discount|promo|credit_inquiry", [("value", "price_sensitivity")]),
    (r"charge_dispute|fraud|unauthor|bill_refund|bill_explain_incorrect|charge_inquiry", [("risk", "dispute")]),
    (r"operator|plus_operator", [("risk", "escalation_request")]),
    (r"due_date|payment|collection|late", [("risk", "payment_difficulty")]),
    (r"international|travel|roaming", [("need", "travel_intl")]),
    (r"cannot_make_receive_call|coverage|network|signal|outage", [("need", "coverage_availability")]),
    (r"upgrade|device_upgrade|new_phone|trade", [("need", "upgrade_device")]),
    (r"add_line|new_line|plan_add|plan_change|plan", [("need", "plan_question")]),
    (r"hotspot|home_internet|fios|5g_home", [("need", "hotspot_home_internet")]),
    (r"damage|broken|replace|insurance", [("value", "device_replacement")]),
]
PLATFORM_INTENT_MAP = [(re.compile(p, re.I), v) for p, v in PLATFORM_INTENT_MAP]

TRANSFER_TOOL = re.compile(r"transfer", re.I)
ESCALATING_ROLES_GENERIC = {  # agent roles that are plumbing, not a customer goal
    "bootstrap_agent", "root_agent", "smart_greeting", "authentication_acct_pin", "enhanced_secure_pin",
    "adaptive_auth", "tool", "banner_messages", "unauth_handler", "known_products_disambig",
    "unknown_products_disambig", "?", "null",
}
AUTH_ROLES = {"authentication_acct_pin", "enhanced_secure_pin", "adaptive_auth", "bootstrap_agent", "smart_greeting"}

MARKUP = re.compile(r"\[(?:prosody[^\]]*|[a-z][a-z _\-]*)\]")  # lower-case tags only (placeholders are UPPER)
PLACEHOLDER = re.compile(r"\[[A-Z_]{3,}\]")

# PII guard run *in addition to* the vendor's redaction (defence in depth)
PII_PATTERNS = [
    ("email", re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")),
    ("ssn", re.compile(r"\b\d{3}-\d{2}-\d{4}\b")),
    ("card", re.compile(r"\b(?:\d[ -]?){13,16}\b")),
    ("phone", re.compile(r"\b(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b")),
]

# --------------------------------------------------------------- gazetteer
# city, state, region, lat, lon
CITIES = [
    ("New York", "NY", "Northeast", 40.71, -74.01), ("Brooklyn", "NY", "Northeast", 40.65, -73.95),
    ("Boston", "MA", "Northeast", 42.36, -71.06), ("Philadelphia", "PA", "Northeast", 39.95, -75.17),
    ("Pittsburgh", "PA", "Northeast", 40.44, -80.0), ("Newark", "NJ", "Northeast", 40.74, -74.17),
    ("Baltimore", "MD", "Mid-Atlantic", 39.29, -76.61), ("Washington", "DC", "Mid-Atlantic", 38.91, -77.04),
    ("Richmond", "VA", "Mid-Atlantic", 37.54, -77.44), ("Charlotte", "NC", "Southeast", 35.23, -80.84),
    ("Raleigh", "NC", "Southeast", 35.78, -78.64), ("Atlanta", "GA", "Southeast", 33.75, -84.39),
    ("Orlando", "FL", "Southeast", 28.54, -81.38), ("Miami", "FL", "Southeast", 25.76, -80.19),
    ("Tampa", "FL", "Southeast", 27.95, -82.46), ("Jacksonville", "FL", "Southeast", 30.33, -81.66),
    ("Lake Mary", "FL", "Southeast", 28.76, -81.32), ("Nashville", "TN", "Southeast", 36.16, -86.78),
    ("Memphis", "TN", "Southeast", 35.15, -90.05), ("New Orleans", "LA", "South", 29.95, -90.07),
    ("Houston", "TX", "South", 29.76, -95.37), ("Dallas", "TX", "South", 32.78, -96.8),
    ("Austin", "TX", "South", 30.27, -97.74), ("San Antonio", "TX", "South", 29.42, -98.49),
    ("Oklahoma City", "OK", "South", 35.47, -97.52), ("Chicago", "IL", "Midwest", 41.88, -87.63),
    ("Detroit", "MI", "Midwest", 42.33, -83.05), ("Cleveland", "OH", "Midwest", 41.5, -81.69),
    ("Columbus", "OH", "Midwest", 39.96, -83.0), ("Indianapolis", "IN", "Midwest", 39.77, -86.16),
    ("Milwaukee", "WI", "Midwest", 43.04, -87.91), ("Minneapolis", "MN", "Midwest", 44.98, -93.27),
    ("St. Louis", "MO", "Midwest", 38.63, -90.2), ("Kansas City", "MO", "Midwest", 39.1, -94.58),
    ("Denver", "CO", "Mountain", 39.74, -104.99), ("Salt Lake City", "UT", "Mountain", 40.76, -111.89),
    ("Phoenix", "AZ", "Southwest", 33.45, -112.07), ("Las Vegas", "NV", "Southwest", 36.17, -115.14),
    ("Albuquerque", "NM", "Southwest", 35.08, -106.65), ("Los Angeles", "CA", "West", 34.05, -118.24),
    ("San Diego", "CA", "West", 32.72, -117.16), ("San Francisco", "CA", "West", 37.77, -122.42),
    ("San Jose", "CA", "West", 37.34, -121.89), ("Sacramento", "CA", "West", 38.58, -121.49),
    ("Seattle", "WA", "Pacific NW", 47.61, -122.33), ("Portland", "OR", "Pacific NW", 45.52, -122.68),
]
CITY_INFO = {c[0]: {"state": c[1], "region": c[2], "lat": c[3], "lon": c[4]} for c in CITIES}
_alias = {"nyc": "New York", "new york city": "New York", "dc": "Washington", "d.c.": "Washington",
          "vegas": "Las Vegas", "la": None, "philly": "Philadelphia", "nola": "New Orleans",
          "sf": "San Francisco", "frisco": None, "okc": "Oklahoma City", "slc": "Salt Lake City",
          "kc": "Kansas City", "saint louis": "St. Louis", "st louis": "St. Louis"}
_names = {c[0].lower(): c[0] for c in CITIES}
_names.update({k: v for k, v in _alias.items() if v})
# longest first so "new york city" beats "new york", "lake mary" etc.
CITY_RE = re.compile(r"\b(" + "|".join(sorted((re.escape(k) for k in _names), key=len, reverse=True)) + r")\b(?:,? (?:" +
                     "|".join(sorted({c[1] for c in CITIES}) + ["florida", "texas", "california", "georgia"]) + r")\b)?", re.I)
CITY_LOOKUP = _names
