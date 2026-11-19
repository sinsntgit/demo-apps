"""Single source of truth for every definition shown to users: terms, cluster families + criteria, score dimensions
(telecom-friendly names), KPI proxies and per-page "how to read this page" text.

Consumers: GET /api/glossary -> UI (tooltips, glossary page, per-page help), docs/methodology.md (cie.docs), the guide.
Numbers that appear in text (thresholds, weights, k ranges) are read from config.py, so the text cannot drift from the code.
"""
from . import config as C

# ---------------------------------------------------------------- score dimensions (internal key -> telecom-friendly name)
# `key` is the stored dimension name in pattern_score; `label` is what people see.
SCORE_DIMENSIONS = [
    dict(key="prevalence", label="Customer Reach", icon="reach",
         question="How many care calls does this touch?",
         telecom="How much of your call volume shows this pattern: the bigger the reach, the more contact-centre minutes and customers it affects.",
         formula="Half log-scaled number of supporting sessions (10 sessions = 0, 10,000 = 1) plus half the pattern's rate relative to the highest rate of the same pattern type.",
         example="'Hotspot / home internet' is 6.3% of Denver's calls: a large share of one market's volume.",
         low="Few calls: interesting but small.", high="Touches a large share of calls."),
    dict(key="recurrence", label="Repeat-Call Pull", icon="repeat",
         question="Do these customers have to call back?",
         telecom="How often customers with this need ring again within 7 days on the same thread. Repeat calls are wasted cost and a churn warning.",
         formula="Share of this need's sessions followed by another session in the same thread within 7 days (previous_session_id), multiplied by 2.5 and capped at 1.",
         example="'Service outage' calls are followed by another call about 40% of the time.",
         low="Mostly resolved in one call.", high="Customers keep calling back."),
    dict(key="trend", label="Demand Momentum", icon="momentum",
         question="Is it growing right now?",
         telecom="Whether the need is rising: an outage after a storm, TravelPass questions before a holiday, upgrade interest after a device launch.",
         formula="Emerging patterns: (recent 2-week share / prior 6-week share - 1) / 4. Other city patterns: last 4 weeks vs earlier weeks of the same city and need, (ratio - 1) / 2. Capped 0 to 1; 0 where no time comparison applies.",
         example="Outage calls in Houston are 4.9x the prior level in weeks 8-9.",
         low="Flat or falling.", high="Rising fast: act while it is live."),
    dict(key="evidence_strength", label="Proof Strength", icon="proof",
         question="How sure are we it is real?",
         telecom="Statistical and data quality: could this be chance, and are there real conversations to read behind it? Reviewers should trust high-proof cards first.",
         formula="Average of four parts: significance (minus log10 of the false-discovery-adjusted q-value, divided by 10), confidence-interval tightness, average intent-classification confidence, and quote availability (supporting sessions / 3, capped at 1). Cards are labelled High at 0.75 or more, Medium at 0.55 or more, otherwise Low.",
         example="A card with q = 1e-40 and 100+ supporting calls scores near 1.",
         low="Could be chance or thinly evidenced: check before acting.", high="Statistically solid and well evidenced."),
    dict(key="business_relevance", label="Revenue & Retention Impact", icon="impact",
         question="Does it matter commercially?",
         telecom="How close the pattern is to money: upsell (add a line, upgrade, TravelPass), churn and retention, or cost to serve. This is a policy weight set by family, not measured revenue.",
         formula="Fixed weight by insight family: " + ", ".join(f"{k} {v}" for k, v in C.FAMILY_RELEVANCE.items()) + ". Phase 1 has no revenue data, so this is an editable assumption.",
         example="A churn-risk pattern (0.90) outranks a general account-lookup need (0.55).",
         low="Service/cost-to-serve topic.", high="Directly tied to churn or upsell."),
    dict(key="geo_concentration", label="Local Hotspot", icon="hotspot",
         question="Is it concentrated in particular markets?",
         telecom="Whether demand clusters in a few cities or markets rather than spreading evenly: a hotspot suits a local campaign, network fix or store action.",
         formula="Herfindahl index of the need's sessions across service-location cities, rescaled so an even spread = 0 and a single city = 1; for city patterns, also (shrunk lift - 1) / 3 if higher. Capped 0 to 1.",
         example="Travel demand concentrated in Orlando and Miami scores high.",
         low="Spread evenly across markets.", high="Concentrated in a few markets."),
]
COMPOSITE = dict(key="composite_provisional", label="Priority Score",
                 telecom="One ranking number for the backlog. It is PROVISIONAL: a weighted average of the six scores above, with weights that Verizon has not approved yet. Always read the six scores, not just the total.",
                 formula="Weighted average: " + ", ".join(f"{d['label']} {C.SCORE_WEIGHTS[d['key']]:.0%}" for d in SCORE_DIMENSIONS) + ".")
LABELS = {d["key"]: d["label"] for d in SCORE_DIMENSIONS} | {COMPOSITE["key"]: COMPOSITE["label"]}

# ---------------------------------------------------------------- cluster families and criteria
CLUSTER_FAMILIES = [
    dict(key="need", label="Customer Needs & Upsell",
         what="Groups of similar customer requests: add a line, travel and roaming, billing disputes, coverage problems, device upgrades.",
         unit="One customer need inside a call (a 'goal episode'). Login/IVR steps are excluded.",
         features="The customer's words and the agent's one-line issue summary (1-2 word phrases, TF-IDF weighted), the platform's intent label, and behaviour tokens: which signals fired, which agent handled it. Compressed to 96 dimensions (SVD) and length-normalised.",
         method=f"k-means whose starting centres come from the taxonomy: one per intent with {C.NEED_MIN_EPISODES}+ episodes (the rules' own labels, never test answers), plus {', '.join(map(str, C.NEED_EXTRA))} extra centres, the count chosen by silhouette. This makes the clusters repeatable.",
         k=C.NEED_EXTRA, example="'International roaming / TravelPass abroad' or 'Cracked screen / replacement phone'."),
    dict(key="risk", label="Friction & Churn Risk",
         what="Groups of calls that went badly: repeated transfers, failed login, abandoned calls, cancellation talk, disputes.",
         unit="One call (session) with at least one friction or risk signal.",
         features="How many times each of 19 friction/risk signals fired (capped at 3), whether the call escalated, was abandoned or resolved, and whether the caller was unauthenticated. Standardised and length-normalised.",
         method=f"k-means with k chosen by silhouette from {', '.join(map(str, C.RISK_K))}.",
         k=C.RISK_K, example="'Unauthenticated, failed PIN, asks for an agent, escalated'."),
    dict(key="value", label="Price & Upsell Signals",
         what="Groups of calls where the customer showed buying or price behaviour: willingness, price sensitivity, plan comparison, device replacement, extra lines.",
         unit="One call with at least one buying or value signal.",
         features="Counts of 10 buying/value signals plus the call's domain (plans, add-ons, devices, billing, service).",
         method=f"k-means with k chosen by silhouette from {', '.join(map(str, C.VALUE_K))}.",
         k=C.VALUE_K, example="'Price-sensitive plan shopper' or 'Household adding lines, ready to buy'."),
    dict(key="geo", label="Market Demand Profiles",
         what="Groups of cities that call about the same mix of needs.",
         unit="One service-location city with at least 30 sessions.",
         features="For each city, its share of every need category compared with the national mix (over- or under-indexing).",
         method=f"k-means with k chosen by silhouette from {', '.join(map(str, C.GEO_K))}; stability = agreement of repeated fits with different seeds.",
         k=C.GEO_K, example="'Over-indexed on travel and international' (Orlando, Miami, Atlanta)."),
]
CLUSTER_CRITERIA = [
    ("Unit of analysis", "Each family clusters its own unit (episode, call or city). A call can sit in clusters of several families."),
    ("How many clusters", "Chosen automatically per family by silhouette score. Need clusters start from the taxonomy intents (plus a few extras for sub-themes); the other families try the k values listed."),
    ("Published only if stable", f"Bootstrap stability of at least {C.MIN_STABILITY:.2f}: the data is re-sampled {C.N_BOOT} times (80% each), re-clustered, clusters are matched to the original by best centroid similarity, and stability is the average overlap (Jaccard) of matched members. Unstable clusters stay visible but are marked 'unpublished'."),
    ("Published only if big enough", f"At least {C.K_ANON} sessions in the cluster."),
    ("Labels", "Drafted automatically from the top intent and distinctive words. They stay 'draft' until a Verizon reviewer approves, renames or rejects them in the Clusters page; reviewed labels survive refits."),
    ("Stable identities", f"After a refit, a cluster keeps its id when its centre is at least 0.80 cosine-similar to a previous cluster in the same family."),
    ("New kinds of calls", f"In the overnight run, a new episode whose similarity to every cluster is below {C.NOVELTY_COS:.2f} is flagged as 'novel'; a rising novel share signals that a refit is needed."),
    ("What clusters are NOT", "They are machine-found groupings of behaviour, not customer segments from a CRM and not the intent taxonomy. Treat the label as a starting point for review."),
]

# ---------------------------------------------------------------- general terms
TERMS = {
    "cluster": ("Cluster", "A group of similar conversations found automatically (not hand-defined). Each family clusters a different unit: needs in a call, whole calls, or cities."),
    "cluster_family": ("Cluster family", "One of four overlapping views: Customer Needs & Upsell, Friction & Churn Risk, Price & Upsell Signals, Market Demand Profiles. A call can belong to clusters in several families."),
    "stability": ("Stability", f"How repeatable a cluster is: re-cluster 80% samples of the data {C.N_BOOT} times and measure how much of the cluster reappears (0 to 1). Published at {C.MIN_STABILITY:.2f} or more."),
    "silhouette": ("Silhouette", "How well separated a cluster is from its neighbours, from -1 to 1. Above 0.2 is acceptable for text; above 0.5 is crisp."),
    "cluster_size": ("Size", "Number of members: episodes for need clusters, calls for risk and value clusters, cities for market profiles."),
    "published": ("Published", f"Stable (at least {C.MIN_STABILITY:.2f}) and at least {C.K_ANON} sessions. Only published clusters feed cards."),
    "unpublished": ("Unpublished", "Found, but too unstable or too small to rely on. Shown for transparency."),
    "cluster_status": ("Review status", "draft = machine label, not yet reviewed; approved/renamed = a Verizon reviewer accepted or relabelled it; rejected = not meaningful."),
    "novel": ("Novel", "A new call that matches no existing cluster well: a signal that customer behaviour has changed."),
    "episode": ("Episode", "One distinct customer need inside a call (for example a bill question, then an upgrade question = two episodes). Login and phone-menu steps are a separate 'access' episode."),
    "session": ("Session", "One complete customer-agent conversation (one call)."),
    "thread": ("Thread", "Calls linked by previous_session_id: the same customer ringing again about an issue. No customer id exists in Phase 1."),
    "need_journey": ("Need journey", "The same need recurring across a thread within 30 days."),
    "signal": ("Signal", "A piece of evidence in a conversation: a phrase, a tool event or a system event (for example 'asks for an agent', 'login failed', 'price too high')."),
    "signal_family": ("Signal family", "Need, Buying intent, Value, Retention risk, Journey friction, Experience, Geographic, Temporal."),
    "intent": ("Intent", "What the customer wants (for example 'Add a line'). 32 specific intents in 11 domains form the draft taxonomy awaiting Verizon approval."),
    "taxonomy": ("Taxonomy", "The draft intent hierarchy: domain > category > specific intent, with definitions and include/exclude rules."),
    "pattern": ("Pattern", "A statistically tested finding: a need unusually common in a city or segment, a rising trend, a risk rate, or one call type predicting the next."),
    "population": ("Population", "'25 of 266': 25 supporting calls out of 266 comparable calls in that scope."),
    "support": ("Support", "Number of supporting sessions behind a pattern (at least 10 needed)."),
    "lift": ("Lift", "How many times more common than elsewhere. 3.0x = three times the average. 'Shrunk' means pulled toward average for small samples so it does not overstate."),
    "ci": ("95% confidence interval", "The range the true rate probably lies in. Narrow = precise."),
    "qvalue": ("q-value", "The chance the finding is a false alarm after testing thousands of combinations at once (Benjamini-Hochberg). We publish at 1% or lower."),
    "fdr": ("False discovery control", "Testing thousands of city and need combinations produces false alarms by chance; this correction keeps them to about 1%."),
    "kanon": ("Minimum population", f"No city, group or quote is shown for fewer than {C.K_ANON} sessions (privacy and reliability)."),
    "composite": ("Priority Score", COMPOSITE["telecom"]),
    "confidence": ("Confidence (High / Medium / Low)", "Taken from Proof Strength: High at 0.75 or more, Medium at 0.55 or more, otherwise Low."),
    "proxy": ("Proxy", "A behavioural stand-in for a business outcome. Phase 1 has no revenue, conversion or churn data, so no dollar or churn claim is made."),
    "escalation": ("Escalated", "The call ended with a transfer to a human agent (a transfer tool executed). It is a proxy for 'could not be handled by the virtual agent'."),
    "abandoned": ("Abandoned", "The call ended by disconnect or repeated silence without a transfer."),
    "resolved_proxy": ("Resolved (proxy)", "No transfer and no abandonment. Not a verified resolution: no disposition data exists in Phase 1."),
    "friction": ("Friction score", "0 to 1: weighted count of friction signals in a call (login failure, repeats, no response, frustration, tool failure...). 0 smooth, 1 heavy."),
    "segment": ("Segment", "A behavioural group derived from what the customer said and did (for example Deal-seeker, Household expander, Churn-risk). Not a CRM segment."),
    "opportunity": ("Opportunity (proxy)", "A call with a buying or value signal and no churn intent."),
    "opp_index": ("Opportunity index", "A city's buying/value signal density compared with the average (100 = average). A proxy, not revenue."),
    "service_location": ("Service location", "The account's service city from the (assumed) location field: where the service is, not where the caller was."),
    "synthetic": ("Synthetic", "Generated test data calibrated to the real sample, with known planted patterns so the engine can be graded."),
    "planted": ("Planted effect", "A pattern deliberately built into the synthetic data (for example travel demand in Orlando) to check the engine finds it."),
    "emerging": ("Emerging", "A need whose share in the last 2 weeks is significantly above the previous 6 weeks."),
    "sequence": ("Sequence", "How often one type of call is followed by another in the same thread, compared with the overall mix of follow-up calls."),
    "gate": ("Acceptance gate", "A pass/fail check of the engine (for example 'finds the planted patterns')."),
    "mrr": ("MRR", "Mean reciprocal rank: how high the first correct search result appears (1.0 = always first)."),
    "ari": ("ARI", "Adjusted Rand Index: how closely clusters match the true intent groups (0 = random, 1 = identical)."),
    "nmi": ("NMI", "Normalised mutual information: how much knowing the cluster tells you about the true intent (0 to 1)."),
    "claude_tier": ("Claude tier", "Optional: Claude Haiku decides only low-confidence intents (at most 5% of calls). Its answer counts only if its quoted evidence appears word for word in the call and agrees with the rules."),
    "bm25": ("Keyword search (BM25)", "Ranks conversations by matching words, weighting rarer words higher."),
    "dense": ("Semantic search", "Ranks by meaning similarity using compressed word-pattern vectors, so different wording can still match."),
    "hybrid": ("Hybrid search", "Combines keyword and semantic rankings by reciprocal rank fusion."),
    "asof": ("As of", "Show only conversations and facts known at that date and time (point-in-time view)."),
    "outcome": ("Outcome (proxy)", "How the call ended, judged from events: transfer to a human (escalated), disconnect or silence (abandoned), otherwise 'resolved (proxy)'. Not a verified disposition."),
    "evaluation": ("Evaluations", "Quality scores the platform's own judges gave the call (quality, task success, efficiency, flow, policy compliance). 'not_applicable' or 'error' means no value and is never treated as 0."),
    "primary_intent": ("Primary intent", "The main need of the call (one per call)."),
    "secondary_intent": ("Secondary intent", "An additional need also expressed in the same call."),
    "l4_candidate": ("L4 candidate", "A sub-theme the engine found inside an intent by clustering its conversations; a draft for reviewers to approve."),
    "insight_family": ("Insight family", "Which part of the business a card speaks to: buying intent, value, retention risk, customer need, journey friction, or temporal."),
    "provenance": ("Provenance", "Where the data came from: real Verizon sample, synthetic generation, or scripted test fixtures."),
    "fact": ("Persistent fact", "A dated statement about a contact thread (for example 'open issue: billing dispute'). When it changes, the old fact is closed, not deleted."),
}

# ---------------------------------------------------------------- KPI proxies
KPIS = {
    "qualified_opportunity_volume": ("Qualified opportunity volume", "Calls with a buying or value signal and no churn intent. Proxy for upsell/cross-sell opportunity."),
    "conversion_proxy": ("Conversion proxy", "Share of those opportunities where the customer also said something willing ('sign me up'). Not actual conversions."),
    "unmet_need_share": ("Unmet-need share", "Need and buying episodes that ended with a transfer or abandonment: needs the virtual agent did not contain."),
    "repeat_contact_rate_7d": ("Repeat contact (7 days)", "Calls followed by another call in the same thread within 7 days. Thread-linked only: unlinked repeat calls are missed."),
    "escalation_rate": ("Escalation rate", "Calls transferred to a human agent."),
    "save_rate_proxy": ("Save-rate proxy", "Churn-intent calls that did not escalate and had no repeat call: a proxy for 'retained without human help'. Not an actual save."),
    "opportunity_density": ("Opportunity density", "Qualified opportunities per 100 calls."),
}

# ---------------------------------------------------------------- acceptance gates (what each checks, pass criterion)
GATES = {
    "G0": ("Calibration", "Does the synthetic data behave like the real sample (transfers, human requests, unauthenticated calls, system events, call length)?", "Every rate inside the real sample's 95% interval"),
    "G1": ("Data integrity", "Are all 100,000 sessions loaded with no orphan or duplicate records, full lineage, verified raw-file checksums and no personal data left?", "Zero defects"),
    "G2": ("Signal detection", "Does the engine find the signals planted in the synthetic calls, on familiar wording and on held-out paraphrases?", "Familiar wording: recall at least 0.85, precision at least 0.80; held-out wording is reported"),
    "G3": ("Intent classification", "On calls held out of discovery, does the engine assign the right intent?", "Macro-F1 at least 0.85 on intent categories; unknown at most 10%"),
    "G4": ("Clusters", "Are clusters repeatable under re-sampling, and do they line up with the true intents?", f"At least 80% of need clusters with stability {C.MIN_STABILITY:.2f} or more; ARI at least 0.50"),
    "G5": ("Patterns", "Does it find the planted city and trend effects without inventing others?", "At least 9 of 11 planted effects, false-discovery rate at most 10%, both time-boxed events, at least 3 of 4 sequences"),
    "G6": ("Cards and facts", "Does every card carry evidence, a population above the floor, caveats and sanitised quotes, and can any past moment be reconstructed?", "Zero violations"),
    "G7": ("Retrieval", "Does search return the right conversations, honour filters and the as-of date?", "Hybrid MRR within 0.02 of the best single method; filters and as-of 100% correct"),
    "G8": ("Speed", "Do all pages respond quickly and does the full pipeline finish in a reasonable time?", "API 95th percentile under 500 ms; pipeline within 30 minutes"),
    "G9": ("Volume", "Is the synthetic population the agreed size?", "100,000 sessions, mean 7.0 traces each (plus or minus 0.1)"),
    "G10": ("Claude tier", "Is the optional Claude adjudication grounded and within its cap?", "Grounding 100%; at most 5% of calls; skipped until an API key is set"),
    "real": ("Real-sample check", "How does the engine compare with draft hand labels on the 36 real calls?", "Directional only: labels are an unreviewed draft"),
    "governance": ("Governance", "Does the pipeline avoid reading the answer key?", "No pipeline module reads truth or gold files"),
}
INSIGHT_FAMILIES = {"need": "Customer need", "buying": "Buying intent", "value": "Value signal", "risk": "Retention risk",
                    "friction": "Journey friction", "experience": "Experience", "geo": "Geographic", "temporal": "Temporal"}

# ---------------------------------------------------------------- per-page help
PAGES = {
    "overview": ("Overview", [
        "Top tiles: how many calls, how many ended in a transfer to an agent, how many carried a buying or price signal, and the average friction score.",
        "KPI proxies are behavioural stand-ins for business outcomes (Phase 1 has no revenue or churn data). Hover any tile for its definition.",
        "The funnel shows the pipeline: sessions produce traces, signals, episodes and need journeys. 'Synthetic' data is generated test data calibrated to the real sample.",
        "Use the Data selector (top right) to switch between All, Real sample (36 calls) and Synthetic (100,000)."]),
    "insights": ("Insights (evidence cards)", [
        "Each card is a tested finding with the exact conversations behind it. Open a card to see its six scores, quotes, caveats and hypothesis.",
        "Scores are shown separately because they answer different questions: Customer Reach, Repeat-Call Pull, Demand Momentum, Proof Strength, Revenue & Retention Impact, Local Hotspot. The Priority Score ranking is a provisional blend of them.",
        "Status workflow: draft > in review > approved or rejected. Only reviewed cards should be acted on."]),
    "geo": ("Geography", [
        "Cities are shown by service location (where the account is serviced), not where the caller was. Cities with fewer than 30 sessions are hidden.",
        "Opportunity index: buying/value signal density versus the average city (100 = average). Escalation and risk views show friction instead.",
        "'Market Demand Profile' names the group of cities with a similar mix of needs (a cluster)."]),
    "journeys": ("Journeys & Trends", [
        "Emerging needs: a need whose share in the last 2 weeks is well above the previous 6 weeks in a city or region.",
        "Sequences: how often one kind of call is followed by another in the same thread. Association, not proof of cause.",
        "Repeat contact uses previous_session_id only, so unlinked repeat calls are missed."]),
    "clusters": ("Clusters", [
        "A cluster is a group of similar conversations found by the engine, not defined by people. Four families group different things: needs, risky calls, price/upsell calls and cities.",
        f"A cluster is published only if it is stable (at least {C.MIN_STABILITY:.2f}) and has at least {C.K_ANON} sessions. Labels are machine drafts until a reviewer approves or renames them.",
        "Click a row for representative customer turns, top cities and the review controls. The full criteria are on the Glossary page."]),
    "ask": ("Ask & search", [
        "Ask in plain language; the engine finds the city, need and topic, then answers from evidence cards and real conversations with citations. No AI writes the answer.",
        "Search ranks conversations by keywords, by meaning, or both. 'As of' shows only what was known at that date."]),
    "sessions": ("Sessions", [
        "One row per call. Filter by intent, signal or outcome; open a call to see the transcript with the intents, signals, tool calls and episodes the engine found.",
        "Outcome is a proxy based on transfer or disconnect events, not a verified resolution."]),
    "taxonomy": ("Taxonomy", [
        "The draft list of what customers call about: 11 domains, 24 categories, 32 intents, each with a definition and include/exclude rules. It awaits Verizon approval.",
        "Primary/Secondary: calls where this is the main or an additional need. Real (36): counts in the real sample.",
        "Discovered L4 candidates are sub-themes the engine found inside an intent, for reviewers to approve."]),
    "signals": ("Signals", [
        "Signals are the evidence the engine extracts from each call, grouped into eight families. The table shows how each is detected, how often it fires and real examples."]),
    "validation": ("Validation", [
        "Acceptance gates test the engine against known truth: does it find the effects planted in the synthetic data, avoid false alarms, classify intents, search accurately and run fast.",
        "Synthetic results prove the pipeline works; they do not prove accuracy on real Verizon speech. The real-sample gold check is draft until Verizon reviews the labels."]),
    "pipeline": ("Pipeline & governance", [
        "Every processing stage is recorded with its versions and statistics. Provenance shows which data is real, which is synthetic. The Claude tier is optional and off until an API key is set."]),
    "glossary": ("Glossary & methodology", [
        "Definitions of every term, how clusters are formed and published, and exactly how each score is calculated."]),
}


def payload():
    """JSON for GET /api/glossary."""
    return {
        "score_dimensions": [dict(d, weight=C.SCORE_WEIGHTS[d["key"]]) for d in SCORE_DIMENSIONS],
        "composite": COMPOSITE,
        "score_labels": LABELS,
        "cluster_families": CLUSTER_FAMILIES,
        "cluster_criteria": [{"criterion": a, "detail": b} for a, b in CLUSTER_CRITERIA],
        "terms": {k: {"label": v[0], "definition": v[1]} for k, v in TERMS.items()},
        "kpis": {k: {"label": v[0], "definition": v[1]} for k, v in KPIS.items()},
        "pages": {k: {"title": v[0], "help": v[1]} for k, v in PAGES.items()},
        "gates": {k: {"name": v[0], "checks": v[1], "criterion": v[2]} for k, v in GATES.items()},
        "insight_families": INSIGHT_FAMILIES,
        "thresholds": {"min_stability": C.MIN_STABILITY, "k_anon": C.K_ANON, "fdr_q": C.FDR_Q, "min_lift": C.MIN_LIFT, "min_support": C.MIN_SUPPORT,
                       "shrink_m": C.SHRINK_M, "n_boot": C.N_BOOT, "novelty_cos": C.NOVELTY_COS, "scoring_version": C.SCORING_VERSION},
    }
