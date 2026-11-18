"""WP6 cluster families + WP4 taxonomy discovery (L4 candidates).

Four overlapping families (a session can sit in several):
  need   : goal episodes  - TF-IDF(text) + behavioural tokens -> SVD -> MiniBatchKMeans
  risk   : sessions with friction/risk signals - standardised signal/outcome profile -> KMeans
  value  : sessions with value/buying signals  - signal profile + L1 intent -> KMeans
  geo    : service-location cities (>= K_ANON sessions) - L2 intent-share vectors -> KMeans
k is chosen by silhouette; stability = mean Jaccard of matched members over bootstrap refits (Hungarian on centroids).
Governed ids: a refit inherits the previous run's stable_id when centroid cosine >= 0.8 (same family).
"""
import json, pickle, re
from collections import Counter, defaultdict
import numpy as np
from scipy.optimize import linear_sum_assignment
from sklearn.cluster import MiniBatchKMeans, KMeans
from sklearn.decomposition import TruncatedSVD
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics import silhouette_score
from sklearn.preprocessing import normalize, StandardScaler
from . import db
from .config import (VERSIONS, K_ANON, MIN_STABILITY, SVD_DIM, N_BOOT, NEED_K, RISK_K, VALUE_K, GEO_K, MODELS, CLUSTER_SEED,
                     L4_MIN_EPISODES, NOVELTY_COS)
from .taxonomy import Taxonomy, UNKNOWN

STOP = {"the", "a", "an", "and", "or", "to", "of", "my", "i", "is", "it", "on", "for", "in", "me", "you", "that", "this", "with",
        "be", "was", "are", "have", "do", "can", "what", "yes", "no", "okay", "uh", "um", "so", "like", "just", "please", "head_intent"}
FRICTION_T = ["escalation_request", "agent_handoff", "auth_failure", "no_input", "dtmf_operator", "agent_loop", "customer_repeat",
              "tool_failure", "abandoned", "out_of_scope", "churn_intent", "complaint", "dispute", "payment_difficulty",
              "repeat_contact_language", "frustration", "confusion", "repeat_contact", "repeat_same_issue"]
VALUE_T = ["willingness", "price_sensitivity", "feature_comparison", "device_replacement", "multi_line_expansion",
           "upgrade_device", "add_line", "plan_question", "hotspot_home_internet", "travel_intl"]


def _choose_k(X, ks, seed, sample=8000):
    rng = np.random.default_rng(seed)
    idx = rng.choice(X.shape[0], min(sample, X.shape[0]), replace=False)
    best, scores = None, {}
    for k in ks:
        if k >= len(idx):
            continue
        km = MiniBatchKMeans(k, random_state=seed, n_init=3, batch_size=4096).fit(X[idx])
        scores[k] = float(silhouette_score(X[idx], km.labels_, sample_size=min(4000, len(idx)), random_state=seed))
        if best is None or scores[k] > scores[best]:
            best = k
    return best, scores


def _fit(X, k, seed):
    # full k-means (not mini-batch) for the published fit and the bootstrap refits: steadier centroids -> stabler clusters
    return KMeans(k, random_state=seed, n_init=4, max_iter=300).fit(X)


def _match(c_ref, c_new):
    sim = normalize(c_ref) @ normalize(c_new).T
    r, c = linear_sum_assignment(-sim)
    return dict(zip(r, c)), sim


def _stability(X, labels, k, seed, n_boot=N_BOOT, frac=.8):
    rng = np.random.default_rng(seed)
    ref = np.vstack([X[labels == j].mean(0) for j in range(k)])
    jac = np.zeros((n_boot, k))
    for b in range(n_boot):
        idx = rng.choice(X.shape[0], int(frac * X.shape[0]), replace=False)
        km = _fit(X[idx], k, seed + 101 + b)
        m, _ = _match(ref, km.cluster_centers_)
        lab_b = km.labels_
        for j in range(k):
            a = set(np.where(labels[idx] == j)[0]); bb = set(np.where(lab_b == m[j])[0])
            jac[b, j] = len(a & bb) / max(1, len(a | bb))
    return jac.mean(0)


def _stable_ids(con, family, centroids):
    prev = con.execute("SELECT cluster_id, stable_id, centroid FROM cluster_master WHERE family=? AND centroid IS NOT NULL", (family,)).fetchall()
    nxt = (con.execute("SELECT MAX(stable_id) FROM cluster_master").fetchone()[0] or 0) + 1
    ids = [None] * len(centroids)
    if prev:
        P = np.vstack([np.frombuffer(p["centroid"], dtype=np.float32) for p in prev])
        if P.shape[1] == centroids.shape[1]:
            m, sim = _match(centroids, P)
            for i, j in m.items():
                if sim[i, j] >= .8:
                    ids[i] = prev[j]["stable_id"]
    for i in range(len(ids)):
        if ids[i] is None:
            ids[i] = nxt; nxt += 1
    return ids


def _save_clusters(con, run_id, family, rows):
    """rows: list of dict(stable_id,label,size,...,centroid)."""
    prev_status = {r["stable_id"]: (r["status"], r["label"]) for r in con.execute("SELECT stable_id, status, label FROM cluster_master WHERE family=?", (family,))}
    con.execute("DELETE FROM cluster_master WHERE family=?", (family,))
    for r in rows:
        st, lab = prev_status.get(r["stable_id"], ("draft", None))
        label = lab if st in ("approved", "renamed") and lab else r["label"]       # reviewed labels survive refits
        con.execute("""INSERT INTO cluster_master(cluster_id, stable_id, family, version, label, status, size, sessions, top_terms, top_intents,
                       top_signals, profile, stability, silhouette, esc_rate, abandon_rate, published, centroid, run_id)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (r["stable_id"], r["stable_id"], family, 1, label, st, r["size"], r["sessions"], json.dumps(r.get("terms", [])),
                     json.dumps(r.get("intents", [])), json.dumps(r.get("signals", [])), json.dumps(r.get("profile", {})),
                     r["stability"], r["silhouette"], r["esc"], r["abn"], int(r["stability"] >= MIN_STABILITY and r["sessions"] >= K_ANON),
                     np.asarray(r["centroid"], dtype=np.float32).tobytes(), run_id))


def _top_terms(tfidf, vocab, labels, k, n=6):
    glob = np.asarray(tfidf.mean(0)).ravel() + 1e-9
    out = []
    for j in range(k):
        m = np.asarray(tfidf[labels == j].mean(0)).ravel()
        lift = m / glob * (m > 0)
        order = np.argsort(-lift * np.sqrt(m))
        terms = [vocab[i] for i in order if not vocab[i].startswith("__") and not any(w in STOP for w in vocab[i].split())][:n]
        out.append(terms)
    return out


# ------------------------------------------------------------------ need family (episodes)
def need_family(con, run_id, tax, stats):
    rows = con.execute("""SELECT e.episode_id, e.session_id, e.intent_id, e.text, e.signal_types, e.domain_agent, e.platform_intent, e.outcome
                          FROM session_episode e WHERE e.kind='goal' AND e.intent_id IS NOT NULL AND e.intent_id!='UNKNOWN'""").fetchall()
    if len(rows) < 200:
        stats["need"] = "skipped (too few episodes)"; return
    docs = []
    for r in rows:
        toks = " ".join(f"__sig_{s}" for s in (r["signal_types"] or "").split(",") if s)
        toks += f" __role_{r['domain_agent']}" if r["domain_agent"] else ""
        toks += f" __pi_{re.sub(r'[^A-Za-z_]', '', r['platform_intent'])}" if r["platform_intent"] else ""
        docs.append(((r["text"] or "") + " " + toks).lower())
    vec = TfidfVectorizer(min_df=5, max_df=.5, ngram_range=(1, 2), sublinear_tf=True, max_features=40000, token_pattern=r"(?u)\b[\w_']{2,}\b")
    T = vec.fit_transform(docs)
    svd = TruncatedSVD(min(SVD_DIM, T.shape[1] - 1), random_state=CLUSTER_SEED)
    X = normalize(svd.fit_transform(T)).astype(np.float32)
    k, sil = _choose_k(X, NEED_K, CLUSTER_SEED)
    km = _fit(X, k, CLUSTER_SEED)
    labels = km.labels_
    stab = _stability(X, labels, k, CLUSTER_SEED)
    sil_by = {}
    idx = np.random.default_rng(1).choice(len(X), min(8000, len(X)), replace=False)
    from sklearn.metrics import silhouette_samples
    ss = silhouette_samples(X[idx], labels[idx])
    for j in range(k):
        sil_by[j] = float(ss[labels[idx] == j].mean()) if (labels[idx] == j).any() else None
    cent = np.vstack([X[labels == j].mean(0) for j in range(k)])
    ids = _stable_ids(con, "need", cent)
    terms = _top_terms(T, vec.get_feature_names_out(), labels, k)
    out = []
    names = {n["intent_id"]: n["name"] for n in tax.nodes}
    for j in range(k):
        mem = [rows[i] for i in np.where(labels == j)[0]]
        ic = Counter(m["intent_id"] for m in mem).most_common(3)
        sc = Counter(s for m in mem for s in (m["signal_types"] or "").split(",") if s).most_common(6)
        oc = Counter(m["outcome"] for m in mem)
        top_intent = ic[0][0]
        lab = f"{names.get(top_intent, top_intent)} · {', '.join(terms[j][:3])}"
        out.append(dict(stable_id=ids[j], label=lab, size=len(mem), sessions=len({m['session_id'] for m in mem}), terms=terms[j],
                        intents=[(a, b) for a, b in ic], signals=[(a, b) for a, b in sc], stability=float(stab[j]), silhouette=sil_by[j],
                        esc=oc["escalated"] / len(mem), abn=oc["abandoned"] / len(mem), centroid=cent[j],
                        profile={"family_of_top_intent": tax.family(top_intent), "intent_purity": ic[0][1] / len(mem)}))
    _save_clusters(con, run_id, "need", out)
    sims = (X * cent[labels]).sum(1) / np.linalg.norm(cent[labels], axis=1)
    con.executemany("INSERT INTO session_cluster_membership VALUES(?,?,?,?,?,?,?)",
                    [("episode", r["episode_id"], r["session_id"], ids[labels[i]], "need", float(sims[i]), run_id) for i, r in enumerate(rows)])
    MODELS.mkdir(parents=True, exist_ok=True)
    pickle.dump({"vec": vec, "svd": svd, "centroids": cent, "ids": ids}, open(MODELS / "need.pkl", "wb"))
    np.save(MODELS / "episode_vectors.npy", X.astype(np.float16))
    json.dump([r["episode_id"] for r in rows], open(MODELS / "episode_ids.json", "w"))
    stats["need"] = {"episodes": len(rows), "k": k, "silhouette_by_k": sil, "stable_share": float((stab >= MIN_STABILITY).mean()),
                     "mean_stability": float(stab.mean())}
    discover_l4(con, run_id, rows, X, T, vec, tax, stats)


def discover_l4(con, run_id, rows, X, T, vec, tax, stats):
    """Propose L4 variations under each well-populated L3 (discovery split only) + themes inside UNKNOWN."""
    con.execute("DELETE FROM taxonomy_candidate")
    test = {r[0] for r in con.execute("SELECT session_id FROM conversation_session WHERE split='test'")}   # held out from discovery
    by_intent = defaultdict(list)
    for i, r in enumerate(rows):
        if r["session_id"] not in test:
            by_intent[r["intent_id"]].append(i)
    vocab = vec.get_feature_names_out()
    n = 0
    for intent, idxs in by_intent.items():
        if len(idxs) < L4_MIN_EPISODES:
            continue
        sub = X[idxs]
        km = KMeans(3, random_state=CLUSTER_SEED, n_init=5).fit(sub)
        terms = _top_terms(T[idxs], vocab, km.labels_, 3, n=5)
        for j in range(3):
            mem = [idxs[i] for i in np.where(km.labels_ == j)[0]]
            if len(mem) < K_ANON:
                continue
            ex = [re.split(r" \| ", rows[i]["text"] or "")[-1][:140] for i in mem[:5]]
            n += 1
            con.execute("INSERT INTO taxonomy_candidate VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (f"{intent}.V{j + 1}", intent, "L4_variation", " / ".join(terms[j][:3]), json.dumps(terms[j]), len(mem), json.dumps(ex),
                         "rules:kmeans", "draft", run_id))
    stats["l4_candidates"] = n


# ------------------------------------------------------------------ session-profile families
def _profile_family(con, run_id, family, types, ks, extra_cols, stats):
    sess = con.execute("""SELECT s.session_id, s.outcome, s.auth_state, si.intent_id FROM conversation_session s
                          LEFT JOIN session_intent si ON si.session_id=s.session_id AND si.role='primary'""").fetchall()
    sig = defaultdict(Counter)
    for sid, t in con.execute(f"SELECT session_id, type FROM session_signal WHERE type IN ({','.join('?' * len(types))})", types):
        sig[sid][t] += 1
    keep = [r for r in sess if sig.get(r["session_id"])]
    if len(keep) < 200:
        stats[family] = "skipped"; return
    cols = list(types) + extra_cols
    M = np.zeros((len(keep), len(cols)), dtype=np.float32)
    for i, r in enumerate(keep):
        for t, c in sig[r["session_id"]].items():
            M[i, cols.index(t)] = min(c, 3)
        for c in extra_cols:
            if c.startswith("out_") and r["outcome"] == c[4:]:
                M[i, cols.index(c)] = 1
            if c.startswith("auth_") and r["auth_state"] == c[5:]:
                M[i, cols.index(c)] = 1
            if c.startswith("l1_") and (r["intent_id"] or "").startswith(c[3:] + "."):
                M[i, cols.index(c)] = 1
    X = normalize(StandardScaler().fit_transform(M)).astype(np.float32)
    k, sil = _choose_k(X, ks, CLUSTER_SEED)
    km = _fit(X, k, CLUSTER_SEED)
    labels = km.labels_
    stab = _stability(X, labels, k, CLUSTER_SEED)
    cent = np.vstack([X[labels == j].mean(0) for j in range(k)])
    ids = _stable_ids(con, family, cent)
    glob = M.mean(0) + 1e-6
    out = []
    for j in range(k):
        mm = M[labels == j]; mean = mm.mean(0)
        over = sorted(((mean[c] / glob[c], cols[c], mean[c]) for c in range(len(cols)) if mean[c] > .15), reverse=True)[:4]
        mem = [keep[i] for i in np.where(labels == j)[0]]
        oc = Counter(m["outcome"] for m in mem)
        lab = " + ".join(c.replace("out_", "outcome:").replace("auth_", "").replace("l1_", "") for _, c, _ in over[:3]) or "baseline"
        out.append(dict(stable_id=ids[j], label=lab, size=len(mem), sessions=len(mem), signals=[(c, round(float(v), 2)) for _, c, v in over],
                        intents=Counter(m["intent_id"] for m in mem).most_common(3), stability=float(stab[j]), silhouette=None,
                        esc=oc["escalated"] / len(mem), abn=oc["abandoned"] / len(mem), centroid=cent[j],
                        profile={c: round(float(mean[i]), 3) for i, c in enumerate(cols)}))
    _save_clusters(con, run_id, family, out)
    con.executemany("INSERT INTO session_cluster_membership VALUES(?,?,?,?,?,?,?)",
                    [("session", r["session_id"], r["session_id"], ids[labels[i]], family, None, run_id) for i, r in enumerate(keep)])
    stats[family] = {"sessions": len(keep), "k": k, "silhouette_by_k": sil, "stable_share": float((stab >= MIN_STABILITY).mean())}


def geo_family(con, run_id, tax, stats):
    rows = con.execute("""SELECT s.city, si.intent_id FROM conversation_session s JOIN session_intent si ON si.session_id=s.session_id AND si.role='primary'
                          WHERE s.city IS NOT NULL AND s.city!='UNKNOWN'""").fetchall()
    by = defaultdict(Counter)
    for c, i in rows:
        by[c][tax.l2(i)] += 1
    cities = [c for c, v in by.items() if sum(v.values()) >= K_ANON]
    if len(cities) < 8:
        stats["geo"] = "skipped"; return
    l2s = sorted({k for c in cities for k in by[c]})
    M = np.array([[by[c][l] / sum(by[c].values()) for l in l2s] for c in cities], dtype=np.float32)
    glob = M.mean(0) + 1e-6
    X = normalize(M / glob - 1).astype(np.float32)
    k, sil = _choose_k(X, GEO_K, CLUSTER_SEED, sample=len(X))
    km = KMeans(k, random_state=CLUSTER_SEED, n_init=10).fit(X)
    labels = km.labels_
    stab = np.ones(k)  # few points: stability via repeated seeds
    seeds = [KMeans(k, random_state=s, n_init=10).fit(X).labels_ for s in range(1, 5)]
    from sklearn.metrics import adjusted_rand_score
    ari = float(np.mean([adjusted_rand_score(labels, l) for l in seeds]))
    cent = np.vstack([X[labels == j].mean(0) for j in range(k)])
    ids = _stable_ids(con, "geo", cent)
    names = {n["intent_id"]: n["name"] for n in tax.nodes}
    out = []
    for j in range(k):
        mm = M[labels == j].mean(0)
        over = sorted(((mm[i] / glob[i], l2s[i]) for i in range(len(l2s))), reverse=True)[:3]
        mem = [cities[i] for i in np.where(labels == j)[0]]
        lab = "Over-indexed: " + ", ".join(names.get(l, l) for _, l in over[:2])
        out.append(dict(stable_id=ids[j], label=lab, size=len(mem), sessions=int(sum(sum(by[c].values()) for c in mem)),
                        intents=[(l, round(float(r), 2)) for r, l in over], signals=[], terms=mem, stability=ari, silhouette=None,
                        esc=0, abn=0, centroid=cent[j], profile={"cities": mem}))
    _save_clusters(con, run_id, "geo", out)
    con.executemany("INSERT INTO session_cluster_membership VALUES(?,?,?,?,?,?,?)",
                    [("city", c, None, ids[labels[i]], "geo", None, run_id) for i, c in enumerate(cities)])
    stats["geo"] = {"cities": len(cities), "k": k, "seed_ARI": round(ari, 3)}


def run(con, tax=None):
    tax = tax or Taxonomy()
    with db.stage(con, "clusters", VERSIONS) as (run_id, stats):
        con.execute("DELETE FROM session_cluster_membership")
        need_family(con, run_id, tax, stats)
        _profile_family(con, run_id, "risk", FRICTION_T, RISK_K, ["out_escalated", "out_abandoned", "out_resolved_proxy", "auth_unauthenticated"], stats)
        _profile_family(con, run_id, "value", VALUE_T, VALUE_K, ["l1_PLAN", "l1_ADDSVC", "l1_DEVICE", "l1_BILL", "l1_SERVICE"], stats)
        geo_family(con, run_id, tax, stats)
    return stats


def assign_new(con, episode_rows):
    """Daily mode: assign new goal episodes to published need centroids; low similarity -> novel (-1)."""
    m = pickle.load(open(MODELS / "need.pkl", "rb"))
    docs = [(r["text"] or "").lower() for r in episode_rows]
    X = normalize(m["svd"].transform(m["vec"].transform(docs)))
    C = normalize(m["centroids"])
    S = X @ C.T
    best = S.argmax(1)
    return [(m["ids"][b] if S[i, b] >= NOVELTY_COS else -1, float(S[i, b])) for i, b in enumerate(best)]
