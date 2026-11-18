"""WP9 retrieval: sparse (FTS5 BM25) + dense (LSA from the need-cluster model) + hybrid (RRF k=60) + structured filters
+ as-of (point-in-time) + ask() that answers with citations to cards, sessions and turns (no LLM).

FTS5 is isolated in this module (the rest of the SQL stays portable).
"""
import json, pickle, re
from collections import defaultdict
import numpy as np
from sklearn.preprocessing import normalize
from . import db
from .config import MODELS, VERSIONS
from .facts import facts_as_of
from .lexicon import CITY_RE, CITY_LOOKUP, FAMILY_CATEGORY
from .taxonomy import Taxonomy

RRF_K = 60
FILTERS = {"city": "s.city=?", "region": "s.region=?", "segment": "f.segment=?", "outcome": "s.outcome=?", "source": "s.source=?",
           "split": "s.split=?", "intent": "si.intent_id LIKE ?", "week_from": "s.day>=?", "week_to": "s.day<=?", "asof": "s.created_at<=?"}
FAMILY_WORDS = {"risk": r"\b(risk|churn|cancel|retention|escalat|friction|complain|repeat)", "buying": r"\b(upsell|cross.?sell|buy|purchase|upgrade|add.?a.?line|opportunit)",
                "value": r"\b(price|value|discount|cheap|afford|willing)", "geo": r"\b(city|cities|region|local|where|geograph)"}


def build_index(con):
    with db.stage(con, "retrieval_index", VERSIONS) as (run_id, stats):
        con.execute("DROP TABLE IF EXISTS search_fts")
        con.execute("DELETE FROM search_doc")
        con.execute("""INSERT INTO search_doc(doc_type, ref_id, session_id, text)
                       SELECT 'episode', episode_id, session_id, text FROM session_episode WHERE kind='goal' AND text IS NOT NULL""")
        con.execute("""INSERT INTO search_doc(doc_type, ref_id, session_id, text)
                       SELECT 'card', card_id, NULL, title || ' | ' || observation || ' | ' || scope FROM evidence_card WHERE valid_to IS NULL""")
        con.execute("CREATE VIRTUAL TABLE search_fts USING fts5(text, content='search_doc', content_rowid='doc_id', tokenize='porter unicode61')")
        con.execute("INSERT INTO search_fts(rowid, text) SELECT doc_id, text FROM search_doc")
        stats.update(docs=con.execute("SELECT COUNT(*) FROM search_doc").fetchone()[0])
    return stats


class Retriever:
    def __init__(self, con):
        self.con = con
        self.tax = Taxonomy()
        self.model = pickle.load(open(MODELS / "need.pkl", "rb")) if (MODELS / "need.pkl").exists() else None
        if self.model and (MODELS / "episode_vectors.npy").exists():
            self.V = np.load(MODELS / "episode_vectors.npy").astype(np.float32)
            self.ids = json.load(open(MODELS / "episode_ids.json"))
            self.pos = {e: i for i, e in enumerate(self.ids)}
        else:
            self.V, self.ids, self.pos = None, [], {}

    # -------------------------------------------------- candidate filtering
    def _filter_sql(self, filters):
        where, args = [], []
        for k, v in (filters or {}).items():
            if v in (None, "") or k not in FILTERS:
                continue
            where.append(FILTERS[k]); args.append(v + "%" if k == "intent" else v)
        return (" AND " + " AND ".join(where)) if where else "", args

    def _allowed(self, filters):
        w, a = self._filter_sql(filters)
        if not w:
            return None
        rows = self.con.execute(f"""SELECT e.episode_id FROM session_episode e JOIN conversation_session s USING(session_id)
                                    LEFT JOIN session_feature f USING(session_id)
                                    LEFT JOIN session_intent si ON si.session_id=s.session_id AND si.role='primary'
                                    WHERE e.kind='goal' {w}""", a).fetchall()
        return {r[0] for r in rows}

    # -------------------------------------------------- methods
    def bm25(self, q, k=50, allowed=None, doc_type="episode"):
        terms = re.findall(r"[A-Za-z']{2,}", q.lower())
        if not terms:
            return []
        match = " OR ".join(f'"{t}"' for t in terms)
        try:
            rows = self.con.execute("""SELECT d.ref_id, d.doc_type, bm25(search_fts) AS sc FROM search_fts JOIN search_doc d ON d.doc_id=search_fts.rowid
                                       WHERE search_fts MATCH ? AND d.doc_type=? ORDER BY sc LIMIT ?""", (match, doc_type, k * (20 if allowed is not None else 1))).fetchall()
        except Exception:                       # index not built yet (python -m cie.run_pipeline --only index)
            return []
        out = [(r[0], -r[2]) for r in rows if allowed is None or r[0] in allowed]
        return out[:k]

    def dense(self, q, k=50, allowed=None):
        if self.V is None:
            return []
        v = normalize(self.model["svd"].transform(self.model["vec"].transform([q.lower()]))).astype(np.float32)[0]
        if allowed is not None:
            idx = np.array([self.pos[e] for e in allowed if e in self.pos], dtype=int)
            if len(idx) == 0:
                return []
            s = self.V[idx] @ v
            top = idx[np.argsort(-s)[:k]]
            return [(self.ids[i], float(self.V[i] @ v)) for i in top]
        s = self.V @ v
        top = np.argpartition(-s, min(k, len(s) - 1))[:k]
        top = top[np.argsort(-s[top])]
        return [(self.ids[i], float(s[i])) for i in top]

    def hybrid(self, q, k=50, allowed=None):
        lists = [self.bm25(q, 100, allowed), self.dense(q, 100, allowed)]
        score = defaultdict(float)
        for lst in lists:
            for rank, (doc, _) in enumerate(lst):
                score[doc] += 1.0 / (RRF_K + rank + 1)
        return sorted(score.items(), key=lambda x: -x[1])[:k]

    def search(self, q, method="hybrid", filters=None, k=20, with_facts=True):
        allowed = self._allowed(filters)
        hits = {"bm25": self.bm25, "dense": self.dense, "hybrid": self.hybrid}[method](q, k, allowed)
        out = []
        for ep, sc in hits:
            r = self.con.execute("""SELECT e.episode_id, e.session_id, e.intent_id, e.outcome, e.start_seq, e.text, s.city, s.created_at, s.thread_id, s.source,
                                    f.segment FROM session_episode e JOIN conversation_session s USING(session_id) LEFT JOIN session_feature f USING(session_id)
                                    WHERE e.episode_id=?""", (ep,)).fetchone()
            if not r:
                continue
            d = dict(r); d["score"] = round(float(sc), 4)
            d["snippet"] = (d.pop("text") or "")[-220:]
            if with_facts and filters and filters.get("asof"):
                d["facts_as_of"] = facts_as_of(self.con, d["thread_id"], filters["asof"])
            out.append(d)
        return out

    def cards(self, q, filters=None, k=5):
        rows = self.bm25(q, 30, None, "card")
        ids = [int(r[0]) for r in rows]
        if not ids:
            return []
        cards = {c["card_id"]: dict(c) for c in self.con.execute(f"SELECT * FROM evidence_card WHERE card_id IN ({','.join('?' * len(ids))})", ids)}
        out = [cards[i] for i in ids if i in cards]
        if filters and filters.get("city"):
            out = sorted(out, key=lambda c: filters["city"] not in (c["scope"] or "") and filters["city"] not in (c["title"] or ""))
        if filters and filters.get("family"):
            out = sorted(out, key=lambda c: c["family"] != filters["family"])
        return out[:k]

    # -------------------------------------------------- ask
    def parse(self, q):
        f = {}
        m = CITY_RE.search(q)
        if m:
            f["city"] = CITY_LOOKUP[m.group(1).lower()]
        hits = self.tax.classify_turn(q)
        if hits and hits[0][1] >= .7 and hits[0][0] != "ESCALATION.REP.REQUEST":
            f["intent"] = hits[0][0]
        for fam, rx in FAMILY_WORDS.items():
            if re.search(rx, q, re.I):
                f["family"] = fam; break
        return f

    def ask(self, q):
        f = self.parse(q)
        names = {n["intent_id"]: n["name"] for n in self.tax.nodes}
        cards = self.cards(q + " " + " ".join(v for k, v in f.items() if k == "city"), f)
        sfilter = {k: v for k, v in f.items() if k in ("city", "intent")}
        hits = self.search(q, "hybrid", sfilter, k=8, with_facts=False)
        stats = None
        if sfilter:
            w, a = self._filter_sql(sfilter)
            r = self.con.execute(f"""SELECT COUNT(*), AVG(s.outcome='escalated'), AVG(f.opp_flag) FROM conversation_session s
                                     LEFT JOIN session_feature f USING(session_id) LEFT JOIN session_intent si ON si.session_id=s.session_id AND si.role='primary'
                                     WHERE 1=1 {w}""", a).fetchone()
            stats = {"sessions": r[0], "escalation_rate": round(r[1] or 0, 3), "opportunity_share": round(r[2] or 0, 3)}
        parts = []
        if f:
            parts.append("Interpreted as: " + ", ".join(f"{k} = {names.get(v, v)}" for k, v in f.items()) + ".")
        if stats and stats["sessions"]:
            parts.append(f"{stats['sessions']:,} matching sessions; {stats['escalation_rate']:.0%} escalated to a human; {stats['opportunity_share']:.0%} carry a buying/value signal.")
        if cards:
            parts.append("Most relevant evidence cards: " + "; ".join(f"[card {c['card_id']}] {c['title']}" for c in cards[:3]) + ".")
        if hits:
            parts.append("Example conversations: " + "; ".join(f"[session {h['session_id'][:8]} turn {h['start_seq']}]" for h in hits[:3]) + ".")
        if not parts:
            parts.append("No matching evidence. Try naming a need (e.g. 'add a line'), a city, or a family (risk, upsell, value).")
        return {"question": q, "interpreted_filters": f, "answer": " ".join(parts), "stats": stats, "cards": cards, "episodes": hits,
                "method": "rules + hybrid retrieval (no LLM)", "data_note": "Synthetic population unless the card says 'verizon_sample'."}
