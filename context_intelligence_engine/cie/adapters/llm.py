"""Claude adapter (AGENTS.md §2.6): minimal LLM use, verified output. Off unless ANTHROPIC credentials exist.

U2 adjudication: sessions whose primary intent is UNKNOWN or inside config.LLM_BAND (<= LLM_MAX_SHARE of sessions).
  - claude-haiku-5-5, Message Batches API (50% cost), JSON-schema structured output with a CLOSED enum of intent ids
  - frozen system prompt (taxonomy definitions) with cache_control -> prompt caching
  - grounding check: the quoted evidence must be an exact substring of the cited redacted turn, else rejected
  - agreement routing: LLM == rules -> 'accepted'; else 'needs_review' (never overrides rules silently)
  - responses cached by hash(prompt version, model, input) in llm_cache -> reruns make zero new calls
  - no temperature/top_p/top_k (rejected by current models); stop_reason checked before reading content
"""
import datetime as dt, hashlib, json, os, time
from ..config import LLM_MODELS, LLM_BAND, LLM_MAX_SHARE, LLM_MAX_USD_PER_RUN
from ..taxonomy import Taxonomy

PROMPT_VERSION = "u2-adjudicate-1"
PRICE = {"claude-haiku-5-5": (0.10, 0.50), "claude-sonnet-5-5": (2.0, 10.0)}   # $/MTok in/out (batch halves this)


def available():
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def _system(tax):
    lines = ["You classify the customer's main need in a redacted Verizon customer-service call transcript.",
             "Choose exactly one intent id from the list, or UNKNOWN if none fits. Quote the customer's words verbatim as evidence",
             "(copy an exact substring of one customer turn) and give that turn's seq number. Never invent text.", "", "Intents:"]
    for i in tax.intents:
        lines.append(f"- {i['code']}: {i['name']}. {i.get('definition', '')}")
    return "\n".join(lines)


def _schema(tax):
    return {"type": "object", "additionalProperties": False, "required": ["intent_id", "evidence_seq", "evidence_quote", "confidence"],
            "properties": {"intent_id": {"type": "string", "enum": [i["code"] for i in tax.intents] + ["UNKNOWN"]},
                           "evidence_seq": {"type": "integer"}, "evidence_quote": {"type": "string"},
                           "confidence": {"type": "number"}}}


def candidates(con):
    n = con.execute("SELECT COUNT(*) FROM conversation_session").fetchone()[0]
    rows = con.execute("""SELECT session_id, intent_id, confidence FROM session_intent WHERE role='primary'
                          AND (intent_id='UNKNOWN' OR confidence BETWEEN ? AND ?) ORDER BY confidence LIMIT ?""",
                       (LLM_BAND[0], LLM_BAND[1], int(n * LLM_MAX_SHARE))).fetchall()
    return [dict(r) for r in rows]


def transcript(con, sid):
    t = con.execute("SELECT seq, user_text FROM conversation_turn WHERE session_id=? AND user_text IS NOT NULL ORDER BY seq", (sid,)).fetchall()
    return {r[0]: r[1] for r in t}


def grounded(turns, seq, quote):
    return bool(quote) and seq in turns and quote.strip() and quote.strip() in turns[seq]


class Adjudicator:
    def __init__(self, con, client=None, model=None):
        self.con, self.tax = con, Taxonomy()
        self.model = model or LLM_MODELS["adjudicate"]
        self.client = client
        if self.client is None and available():
            import anthropic
            self.client = anthropic.Anthropic()
        self.system = _system(self.tax)
        self.schema = _schema(self.tax)

    def _params(self, turns):
        body = "\n".join(f"seq {s}: {t}" for s, t in turns.items())
        return dict(model=self.model, max_tokens=1024,
                    system=[{"type": "text", "text": self.system, "cache_control": {"type": "ephemeral"}}],
                    messages=[{"role": "user", "content": f"Transcript (customer turns only):\n{body}"}],
                    output_config={"effort": "low", "format": {"type": "json_schema", "schema": self.schema}})

    def _key(self, params):
        return hashlib.sha256(json.dumps([PROMPT_VERSION, params["model"], params["messages"]], sort_keys=True).encode()).hexdigest()

    def run(self, use_batch=True, poll_seconds=30):
        if self.client is None:
            return {"status": "disabled (no API key); candidates stay needs_review", "candidates": len(candidates(self.con))}
        cands = candidates(self.con)
        reqs, cached = {}, {}
        for c in cands:
            turns = transcript(self.con, c["session_id"])
            if not turns:
                continue
            p = self._params(turns)
            k = self._key(p)
            hit = self.con.execute("SELECT response FROM llm_cache WHERE key=?", (k,)).fetchone()
            (cached if hit else reqs)[c["session_id"]] = (p, k, turns, c, json.loads(hit[0]) if hit else None)
        est = len(reqs) * (4000 * PRICE[self.model][0] + 200 * PRICE[self.model][1]) / 1e6 * (.5 if use_batch else 1)
        if est > LLM_MAX_USD_PER_RUN:
            return {"status": f"budget stop: estimated ${est:.2f} > ${LLM_MAX_USD_PER_RUN}"}
        results = {sid: v[4] for sid, v in cached.items()}
        if reqs:
            results.update(self._batch(reqs, poll_seconds) if use_batch else self._sync(reqs))
        return self._record({**reqs, **cached}, results, len(cached))

    def _sync(self, reqs):
        out = {}
        for sid, (p, k, *_rest) in reqs.items():
            msg = self.client.messages.create(**p)
            out[sid] = self._parse(msg, k, p)
        return out

    def _batch(self, reqs, poll_seconds):
        from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
        from anthropic.types.messages.batch_create_params import Request
        ids = {f"s{i}": sid for i, sid in enumerate(reqs)}
        b = self.client.messages.batches.create(requests=[Request(custom_id=c, params=MessageCreateParamsNonStreaming(**reqs[s][0])) for c, s in ids.items()])
        while self.client.messages.batches.retrieve(b.id).processing_status != "ended":
            time.sleep(poll_seconds)
        out = {}
        for r in self.client.messages.batches.results(b.id):            # results arrive in any order: key by custom_id
            sid = ids[r.custom_id]
            out[sid] = self._parse(r.result.message, reqs[sid][1], reqs[sid][0]) if r.result.type == "succeeded" else {"error": r.result.type}
        return out

    def _parse(self, msg, key, params):
        if msg.stop_reason in ("refusal", "max_tokens"):
            data = {"error": msg.stop_reason}
        else:
            text = next((b.text for b in msg.content if b.type == "text"), "{}")
            data = json.loads(text)
        u = getattr(msg, "usage", None)
        self.con.execute("INSERT OR REPLACE INTO llm_cache VALUES(?,?,?,?,?,?,?,?,?,?)",
                         (key, "U2", params["model"], PROMPT_VERSION, json.dumps(params["messages"])[:4000], json.dumps(data),
                          getattr(u, "input_tokens", None), getattr(u, "output_tokens", None), getattr(u, "cache_read_input_tokens", None),
                          dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")))
        return data

    def _record(self, items, results, n_cached):
        acc = rev = rej = 0
        now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
        for sid, (p, k, turns, cand, _) in items.items():
            d = results.get(sid) or {"error": "missing"}
            if "error" in d:
                status, g, agree = "needs_review", 0, 0
            else:
                g = int(grounded(turns, d.get("evidence_seq"), d.get("evidence_quote")))
                agree = int(d["intent_id"] == cand["intent_id"])
                status = "rejected_ungrounded" if not g else ("accepted" if agree else "needs_review")
            acc += status == "accepted"; rev += status == "needs_review"; rej += status == "rejected_ungrounded"
            self.con.execute("INSERT INTO llm_label VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                             ("session", sid, "U2", d.get("intent_id"), json.dumps({"seq": d.get("evidence_seq"), "quote": d.get("evidence_quote")}),
                              g, agree, status, self.model, PROMPT_VERSION, now))
        self.con.commit()
        return {"status": "ok", "candidates": len(items), "from_cache": n_cached, "accepted": acc, "needs_review": rev, "rejected_ungrounded": rej}
