# Methodology: clusters, scores and terms

Generated from `cie/glossary.py`, the same source the UI uses.

## Score dimensions

### Customer Reach (`prevalence`)
- Question: How many care calls does this touch?
- Telecom meaning: How much of your call volume shows this pattern: the bigger the reach, the more contact-centre minutes and customers it affects.
- Formula: Half log-scaled number of supporting sessions (10 sessions = 0, 10,000 = 1) plus half the pattern's rate relative to the highest rate of the same pattern type.
- Weight: None

### Repeat-Call Pull (`recurrence`)
- Question: Do these customers have to call back?
- Telecom meaning: How often customers with this need ring again within 7 days on the same thread. Repeat calls are wasted cost and a churn warning.
- Formula: Share of this need's sessions followed by another session in the same thread within 7 days (previous_session_id), multiplied by 2.5 and capped at 1.
- Weight: None

### Demand Momentum (`trend`)
- Question: Is it growing right now?
- Telecom meaning: Whether the need is rising: an outage after a storm, TravelPass questions before a holiday, upgrade interest after a device launch.
- Formula: Emerging patterns: (recent 2-week share / prior 6-week share - 1) / 4. Other city patterns: last 4 weeks vs earlier weeks of the same city and need, (ratio - 1) / 2. Capped 0 to 1; 0 where no time comparison applies.
- Weight: None

### Proof Strength (`evidence_strength`)
- Question: How sure are we it is real?
- Telecom meaning: Statistical and data quality: could this be chance, and are there real conversations to read behind it? Reviewers should trust high-proof cards first.
- Formula: Average of four parts: significance (minus log10 of the false-discovery-adjusted q-value, divided by 10), confidence-interval tightness, average intent-classification confidence, and quote availability (supporting sessions / 3, capped at 1). Cards are labelled High at 0.75 or more, Medium at 0.55 or more, otherwise Low.
- Weight: None

### Revenue & Retention Impact (`business_relevance`)
- Question: Does it matter commercially?
- Telecom meaning: How close the pattern is to money: upsell (add a line, upgrade, TravelPass), churn and retention, or cost to serve. This is a policy weight set by family, not measured revenue.
- Formula: Fixed weight by insight family: risk 0.9, buying 0.85, value 0.8, friction 0.7, need 0.55, geo 0.6, temporal 0.75. Phase 1 has no revenue data, so this is an editable assumption.
- Weight: None

### Local Hotspot (`geo_concentration`)
- Question: Is it concentrated in particular markets?
- Telecom meaning: Whether demand clusters in a few cities or markets rather than spreading evenly: a hotspot suits a local campaign, network fix or store action.
- Formula: Herfindahl index of the need's sessions across service-location cities, rescaled so an even spread = 0 and a single city = 1; for city patterns, also (shrunk lift - 1) / 3 if higher. Capped 0 to 1.
- Weight: None

## Cluster families

### Customer Needs & Upsell (`need`)
- what: Groups of similar customer requests: add a line, travel and roaming, billing disputes, coverage problems, device upgrades.
- unit: One customer need inside a call (a 'goal episode'). Login/IVR steps are excluded.
- features: The customer's words and the agent's one-line issue summary (1-2 word phrases, TF-IDF weighted), the platform's intent label, and behaviour tokens: which signals fired, which agent handled it. Compressed to 96 dimensions (SVD) and length-normalised.
- method: k-means whose starting centres come from the taxonomy: one per intent with 100+ episodes (the rules' own labels, never test answers), plus 0, 2, 4, 6 extra centres, the count chosen by silhouette. This makes the clusters repeatable.
- k: (0, 2, 4, 6)
- example: 'International roaming / TravelPass abroad' or 'Cracked screen / replacement phone'.

### Friction & Churn Risk (`risk`)
- what: Groups of calls that went badly: repeated transfers, failed login, abandoned calls, cancellation talk, disputes.
- unit: One call (session) with at least one friction or risk signal.
- features: How many times each of 19 friction/risk signals fired (capped at 3), whether the call escalated, was abandoned or resolved, and whether the caller was unauthenticated. Standardised and length-normalised.
- method: k-means with k chosen by silhouette from 4, 5, 6.
- k: (4, 5, 6)
- example: 'Unauthenticated, failed PIN, asks for an agent, escalated'.

### Price & Upsell Signals (`value`)
- what: Groups of calls where the customer showed buying or price behaviour: willingness, price sensitivity, plan comparison, device replacement, extra lines.
- unit: One call with at least one buying or value signal.
- features: Counts of 10 buying/value signals plus the call's domain (plans, add-ons, devices, billing, service).
- method: k-means with k chosen by silhouette from 4, 5, 6.
- k: (4, 5, 6)
- example: 'Price-sensitive plan shopper' or 'Household adding lines, ready to buy'.

### Market Demand Profiles (`geo`)
- what: Groups of cities that call about the same mix of needs.
- unit: One service-location city with at least 30 sessions.
- features: For each city, its share of every need category compared with the national mix (over- or under-indexing).
- method: k-means with k chosen by silhouette from 4, 5, 6; stability = agreement of repeated fits with different seeds.
- k: (4, 5, 6)
- example: 'Over-indexed on travel and international' (Orlando, Miami, Atlanta).

## Cluster criteria

- **Unit of analysis**: Each family clusters its own unit (episode, call or city). A call can sit in clusters of several families.
- **How many clusters**: Chosen automatically per family by silhouette score. Need clusters start from the taxonomy intents (plus a few extras for sub-themes); the other families try the k values listed.
- **Published only if stable**: Bootstrap stability of at least 0.60: the data is re-sampled 4 times (80% each), re-clustered, clusters are matched to the original by best centroid similarity, and stability is the average overlap (Jaccard) of matched members. Unstable clusters stay visible but are marked 'unpublished'.
- **Published only if big enough**: At least 30 sessions in the cluster.
- **Labels**: Drafted automatically from the top intent and distinctive words. They stay 'draft' until a Verizon reviewer approves, renames or rejects them in the Clusters page; reviewed labels survive refits.
- **Stable identities**: After a refit, a cluster keeps its id when its centre is at least 0.80 cosine-similar to a previous cluster in the same family.
- **New kinds of calls**: In the overnight run, a new episode whose similarity to every cluster is below 0.35 is flagged as 'novel'; a rising novel share signals that a refit is needed.
- **What clusters are NOT**: They are machine-found groupings of behaviour, not customer segments from a CRM and not the intent taxonomy. Treat the label as a starting point for review.

## Terms

- **95% confidence interval**: The range the true rate probably lies in. Narrow = precise.
- **Abandoned**: The call ended by disconnect or repeated silence without a transfer.
- **Acceptance gate**: A pass/fail check of the engine (for example 'finds the planted patterns').
- **ARI**: Adjusted Rand Index: how closely clusters match the true intent groups (0 = random, 1 = identical).
- **As of**: Show only conversations and facts known at that date and time (point-in-time view).
- **Claude tier**: Optional: Claude Haiku decides only low-confidence intents (at most 5% of calls). Its answer counts only if its quoted evidence appears word for word in the call and agrees with the rules.
- **Cluster**: A group of similar conversations found automatically (not hand-defined). Each family clusters a different unit: needs in a call, whole calls, or cities.
- **Cluster family**: One of four overlapping views: Customer Needs & Upsell, Friction & Churn Risk, Price & Upsell Signals, Market Demand Profiles. A call can belong to clusters in several families.
- **Confidence (High / Medium / Low)**: Taken from Proof Strength: High at 0.75 or more, Medium at 0.55 or more, otherwise Low.
- **Emerging**: A need whose share in the last 2 weeks is significantly above the previous 6 weeks.
- **Episode**: One distinct customer need inside a call (for example a bill question, then an upgrade question = two episodes). Login and phone-menu steps are a separate 'access' episode.
- **Escalated**: The call ended with a transfer to a human agent (a transfer tool executed). It is a proxy for 'could not be handled by the virtual agent'.
- **Evaluations**: Quality scores the platform's own judges gave the call (quality, task success, efficiency, flow, policy compliance). 'not_applicable' or 'error' means no value and is never treated as 0.
- **False discovery control**: Testing thousands of city and need combinations produces false alarms by chance; this correction keeps them to about 1%.
- **Friction score**: 0 to 1: weighted count of friction signals in a call (login failure, repeats, no response, frustration, tool failure...). 0 smooth, 1 heavy.
- **Hybrid search**: Combines keyword and semantic rankings by reciprocal rank fusion.
- **Insight family**: Which part of the business a card speaks to: buying intent, value, retention risk, customer need, journey friction, or temporal.
- **Intent**: What the customer wants (for example 'Add a line'). 32 specific intents in 11 domains form the draft taxonomy awaiting Verizon approval.
- **Keyword search (BM25)**: Ranks conversations by matching words, weighting rarer words higher.
- **L4 candidate**: A sub-theme the engine found inside an intent by clustering its conversations; a draft for reviewers to approve.
- **Lift**: How many times more common than elsewhere. 3.0x = three times the average. 'Shrunk' means pulled toward average for small samples so it does not overstate.
- **Minimum population**: No city, group or quote is shown for fewer than 30 sessions (privacy and reliability).
- **MRR**: Mean reciprocal rank: how high the first correct search result appears (1.0 = always first).
- **Need journey**: The same need recurring across a thread within 30 days.
- **NMI**: Normalised mutual information: how much knowing the cluster tells you about the true intent (0 to 1).
- **Novel**: A new call that matches no existing cluster well: a signal that customer behaviour has changed.
- **Opportunity (proxy)**: A call with a buying or value signal and no churn intent.
- **Opportunity index**: A city's buying/value signal density compared with the average (100 = average). A proxy, not revenue.
- **Outcome (proxy)**: How the call ended, judged from events: transfer to a human (escalated), disconnect or silence (abandoned), otherwise 'resolved (proxy)'. Not a verified disposition.
- **Pattern**: A statistically tested finding: a need unusually common in a city or segment, a rising trend, a risk rate, or one call type predicting the next.
- **Persistent fact**: A dated statement about a contact thread (for example 'open issue: billing dispute'). When it changes, the old fact is closed, not deleted.
- **Planted effect**: A pattern deliberately built into the synthetic data (for example travel demand in Orlando) to check the engine finds it.
- **Population**: '25 of 266': 25 supporting calls out of 266 comparable calls in that scope.
- **Primary intent**: The main need of the call (one per call).
- **Priority Score**: One ranking number for the backlog. It is PROVISIONAL: a weighted average of the six scores above, with weights that Verizon has not approved yet. Always read the six scores, not just the total.
- **Provenance**: Where the data came from: real Verizon sample, synthetic generation, or scripted test fixtures.
- **Proxy**: A behavioural stand-in for a business outcome. Phase 1 has no revenue, conversion or churn data, so no dollar or churn claim is made.
- **Published**: Stable (at least 0.60) and at least 30 sessions. Only published clusters feed cards.
- **q-value**: The chance the finding is a false alarm after testing thousands of combinations at once (Benjamini-Hochberg). We publish at 1% or lower.
- **Resolved (proxy)**: No transfer and no abandonment. Not a verified resolution: no disposition data exists in Phase 1.
- **Review status**: draft = machine label, not yet reviewed; approved/renamed = a Verizon reviewer accepted or relabelled it; rejected = not meaningful.
- **Secondary intent**: An additional need also expressed in the same call.
- **Segment**: A behavioural group derived from what the customer said and did (for example Deal-seeker, Household expander, Churn-risk). Not a CRM segment.
- **Semantic search**: Ranks by meaning similarity using compressed word-pattern vectors, so different wording can still match.
- **Sequence**: How often one type of call is followed by another in the same thread, compared with the overall mix of follow-up calls.
- **Service location**: The account's service city from the (assumed) location field: where the service is, not where the caller was.
- **Session**: One complete customer-agent conversation (one call).
- **Signal**: A piece of evidence in a conversation: a phrase, a tool event or a system event (for example 'asks for an agent', 'login failed', 'price too high').
- **Signal family**: Need, Buying intent, Value, Retention risk, Journey friction, Experience, Geographic, Temporal.
- **Silhouette**: How well separated a cluster is from its neighbours, from -1 to 1. Above 0.2 is acceptable for text; above 0.5 is crisp.
- **Size**: Number of members: episodes for need clusters, calls for risk and value clusters, cities for market profiles.
- **Stability**: How repeatable a cluster is: re-cluster 80% samples of the data 4 times and measure how much of the cluster reappears (0 to 1). Published at 0.60 or more.
- **Support**: Number of supporting sessions behind a pattern (at least 10 needed).
- **Synthetic**: Generated test data calibrated to the real sample, with known planted patterns so the engine can be graded.
- **Taxonomy**: The draft intent hierarchy: domain > category > specific intent, with definitions and include/exclude rules.
- **Thread**: Calls linked by previous_session_id: the same customer ringing again about an issue. No customer id exists in Phase 1.
- **Unpublished**: Found, but too unstable or too small to rely on. Shown for transparency.
