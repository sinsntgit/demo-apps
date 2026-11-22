# Episode definition (proposal for customer approval)

Three layers (AGENTS.md §2.5):

| Layer | Definition | Used for |
|---|---|---|
| Session | one complete conversation | population counts, denominators |
| **Episode** | one distinct customer need inside a session, with its own outcome; the leading login/IVR span is a separate `access` episode | signals -> features -> clusters |
| Need journey | the same L2 need across a `previous_session_id` thread within 30 days | repeat contact, unresolved needs, temporal history |

## Boundary rules (deterministic, versioned `episode_model 1.1.0`)

A customer turn with a classified intent opens a new **goal** episode when:

1. it is the first intent of the session (after the access span); or
2. a **platform intent label** on that turn has a different L2 from the open episode; or
3. the customer uses an explicit **new-need cue** ("also", "one more thing", "another question") with a different L2; or
4. a keyword intent (confidence >= 0.70) with a different L2 **holds for 2 customer turns**.

It does **not** open a new episode when:

- the turn carries a **value signal** (price, comparison, ...): "That's too much, can I lower my bill?" inside a bill question is evidence about that need. It is kept as a secondary intent and a value signal, so cross-sell is still visible;
- the intent is an **account-access problem said during authentication** ("I don't have the PIN"): that is friction in the access episode;
- the intent is a **representative request**: that is friction, not a need. If the call only ever asks for a person, the episode's intent is `ESCALATION.REP.REQUEST`;
- the turn is a **system event with no customer words** (the platform re-routes the call through another skill agent) and the customer has already spoken: the routing label is not a new need (added in 1.1.0 after reviewing the real sample, where 6 of 49 goal episodes were such re-routes);
- the domain agent changes but the need does not (recorded as `+role_change` evidence only).

## Episode outcome

`escalated` (transfer tool or agent hand-off phrase) / `abandoned` (disconnect or >=2 no-inputs without hand-off) /
`moved_on` (a later episode started) / `resolved_proxy` (none of the above). Proxy only: no verified disposition exists in Phase 1.

## Open for customer decision

If Verizon prefers "episode = whole session" or "episode = sequence of sessions", `session_episode` collapses to one row
per session or `need_journey` becomes the primary unit; no schema change is required.
