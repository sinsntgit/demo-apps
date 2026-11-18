"""Taxonomy loading and rule-based intent classification (AGENTS.md WP4, v0 rules tier).

Classification order per turn: platform label (conf .90) > keyword rule (.70) > weak IVR token (.50).
The LLM adjudication tier (§2.6 U2) plugs in later for turns inside config.LLM_BAND; until then such turns
are only flagged.
"""
import json, re
from collections import defaultdict
import yaml
from .config import TAXONOMY_DIR, MIN_INTENT_CONF

CONF_PLATFORM, CONF_KEYWORD, CONF_WEAK = 0.90, 0.70, 0.50
# tie-break: dispute/fraud and stated needs outrank product mentions on the same turn (the product is the object of the issue)
FAMILY_RANK = {"risk": 0, "need": 1, "value": 2, "buying": 3, "friction": 4, None: 5}
REP_INTENT = "ESCALATION.REP.REQUEST"
UNKNOWN = "UNKNOWN"


class Taxonomy:
    def __init__(self, path=None):
        path = path or (TAXONOMY_DIR / "taxonomy_v0.yaml")
        self.doc = yaml.safe_load(open(path, encoding="utf-8"))
        self.version = self.doc["version"]
        self.nodes, self.intents = [], []
        for d in self.doc["domains"]:
            self.nodes.append(dict(intent_id=d["code"], level=1, parent_id=None, code=d["code"], name=d["name"], family=None))
            for c in d["categories"]:
                self.nodes.append(dict(intent_id=c["code"], level=2, parent_id=d["code"], code=c["code"], name=c["name"], family=None))
                for i in c["intents"]:
                    rec = dict(intent_id=i["code"], level=3, parent_id=c["code"], code=i["code"], name=i["name"], family=i["family"])
                    self.nodes.append(rec)
                    i = dict(i)
                    i["_platform"] = [(re.compile(p.split("|")[0], re.I), float(p.split("|")[1]) if "|" in p else CONF_PLATFORM) for p in i.get("platform") or []]
                    i["_kw"] = [re.compile(p, re.I) for p in i.get("keywords") or []]
                    i["_weak"] = [re.compile(p, re.I) for p in i.get("weak") or []]
                    self.intents.append(i)
        self.nodes.append(dict(intent_id=UNKNOWN, level=3, parent_id=None, code=UNKNOWN, name="Unknown / unclassified", family=None))
        self.by_id = {n["intent_id"]: n for n in self.nodes}

    def l2(self, intent_id):
        n = self.by_id.get(intent_id)
        return n["parent_id"] if n and n["level"] == 3 and n["parent_id"] else intent_id

    def l1(self, intent_id):
        return intent_id.split(".")[0] if intent_id else None

    def family(self, intent_id):
        n = self.by_id.get(intent_id)
        return n["family"] if n else None

    def load_db(self, con):
        con.execute("DELETE FROM dim_intent"); con.execute("DELETE FROM intent_definition")
        for n in self.nodes:
            con.execute("INSERT INTO dim_intent VALUES(?,?,?,?,?,?,?,?)", (n["intent_id"], n["level"], n["parent_id"], n["code"],
                        n["name"], n["family"], self.version, self.doc.get("status", "draft")))
        for i in self.intents:
            con.execute("INSERT INTO intent_definition VALUES(?,?,?,?,?,?,?)", (i["code"], i.get("definition"),
                        json.dumps(i.get("include", [])), json.dumps(i.get("exclude", [])), json.dumps(i.get("examples", [])),
                        json.dumps(i.get("platform", [])), json.dumps((i.get("keywords") or []) + (i.get("weak") or []))))

    # ------------------------------------------------------------ classification
    def classify_turn(self, text, platform_labels=(), paraphrases=()):
        """Return list of (intent_id, conf, method, evidence) sorted best first."""
        hits = {}

        def add(code, conf, method, ev):
            if code not in hits or conf > hits[code][0]:
                prev = hits.get(code)
                hits[code] = (conf, method, ev)
                if prev and "keyword" in prev[1] and "keyword" not in method:
                    hits[code] = (conf, method + "+keyword", ev)       # customer words corroborate the label
            elif method == "keyword" and "keyword" not in hits[code][1]:
                c, m, e = hits[code]
                hits[code] = (c, m + "+keyword", e)
        for i in self.intents:
            for lab in platform_labels:
                for p, c in i["_platform"]:
                    if lab and p.search(lab):
                        add(i["code"], c, "platform_intent" if c >= CONF_PLATFORM else "platform_generic", lab)
                        break
            for src in [text] + list(paraphrases):
                if not src:
                    continue
                for p in i["_kw"]:
                    m = p.search(src)
                    if m:
                        add(i["code"], CONF_KEYWORD if src is text else CONF_KEYWORD - .05, "keyword" if src is text else "paraphrase", m.group(0))
                        break
                if text and src is text:
                    for p in i["_weak"]:
                        m = p.search(text)
                        if m:
                            add(i["code"], CONF_WEAK, "weak_token", m.group(0))
        out = [(k, v[0], v[1], v[2]) for k, v in hits.items()]
        # specificity tiebreak: a substantive intent beats the representative-request intent at equal confidence
        out.sort(key=lambda x: (-x[1], x[0] == REP_INTENT, FAMILY_RANK.get(self.family(x[0]), 5), -len(x[3] or ""), x[0]))   # ties -> longer (more specific) evidence
        return out

    def session_intents(self, turn_hits):
        """turn_hits: list of (seq, [(intent, conf, method, ev)...]). Returns [(intent, role, conf, method, evidence)]."""
        score, best, first, last_kw = defaultdict(float), {}, {}, {}
        for seq, hits in turn_hits:
            for code, conf, method, ev in hits:
                score[code] += conf
                first.setdefault(code, seq)
                if ("keyword" in method or method.startswith("weak_token")) and conf >= 0.70:
                    last_kw[code] = seq
                if code not in best or conf > best[code][0]:
                    best[code] = (conf, method, f"seq {seq}: {ev}")
        if not score:
            return [(UNKNOWN, "primary", 0.0, "none", "")]
        substantive = {k: v for k, v in score.items() if k != REP_INTENT}
        pool = substantive or score
        ranked = sorted(pool, key=lambda k: (-best[k][0], first[k], FAMILY_RANK.get(self.family(k), 5), -score[k], k))   # ties -> first stated need
        primary = ranked[0]
        # within the same L2, the customer's own words pick the specific L3 over the platform's routing label
        if best[primary][1].startswith("platform"):
            own = [k for k in last_kw if self.l2(k) == self.l2(primary)]
            if own:
                primary = max(own, key=lambda k: last_kw[k])      # latest customer refinement within the category
        res = [(primary, "primary", round(best[primary][0], 2), best[primary][1], best[primary][2])]
        for k in sorted(score, key=lambda k: -score[k]):
            if k != primary and best[k][0] >= MIN_INTENT_CONF:
                res.append((k, "secondary", round(best[k][0], 2), best[k][1], best[k][2]))
        if best[primary][0] < MIN_INTENT_CONF:
            res[0] = (UNKNOWN, "primary", round(best[primary][0], 2), "below_threshold", best[primary][2])
        return res
