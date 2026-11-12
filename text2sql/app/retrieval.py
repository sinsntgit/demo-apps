"""Local BM25 retrieval over training data. No embeddings API - nothing leaves the server."""
import math
import re
from collections import Counter

_STOP = set("a an the of in on for to by with and or is are was were be what which who how many much show me "
            "list give get all from as at it this that these those per each do does did i we our my".split())


def tokens(text: str) -> list[str]:
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text or "")
    out = []
    for w in re.findall(r"[a-z0-9]+", text.lower()):
        if w in _STOP:
            continue
        out.append(w)
        if len(w) > 3 and w.endswith("s"):       # crude plural folding: orders ~ order
            out.append(w[:-1])
    return out


def rank(query: str, docs: list[str], k1: float = 1.5, b: float = 0.75) -> list[float]:
    """BM25 score of every doc against the query."""
    q = set(tokens(query))
    toks = [tokens(d) for d in docs]
    n = len(docs)
    if not n or not q:
        return [0.0] * n
    avg = sum(len(t) for t in toks) / n or 1
    df = Counter()
    for t in toks:
        df.update(set(t))
    scores = []
    for t in toks:
        tf = Counter(t)
        s = 0.0
        for term in q:
            f = tf.get(term, 0)
            if f:
                idf = math.log(1 + (n - df[term] + 0.5) / (df[term] + 0.5))
                s += idf * f * (k1 + 1) / (f + k1 * (1 - b + b * len(t) / avg))
        scores.append(s)
    return scores


def top(query: str, items: list, text_of, k: int, min_score: float = 0.0) -> list:
    if not items:
        return []
    scores = rank(query, [text_of(i) for i in items])
    order = sorted(range(len(items)), key=lambda i: -scores[i])
    return [items[i] for i in order[:k] if scores[i] > min_score]


def chunk(text: str, size: int = 1200, overlap: int = 150) -> list[str]:
    """Split a document into paragraph-aligned chunks."""
    text = re.sub(r"\r\n?", "\n", text or "").strip()
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks, cur = [], ""
    for p in paras:
        while len(p) > size:                      # very long paragraph: hard split
            chunks.append((cur + "\n\n" + p[:size]).strip() if cur else p[:size])
            cur, p = "", p[size - overlap:]
        if len(cur) + len(p) + 2 > size and cur:
            chunks.append(cur)
            cur = cur[-overlap:] + "\n\n" + p
        else:
            cur = (cur + "\n\n" + p).strip()
    if cur:
        chunks.append(cur)
    return chunks
