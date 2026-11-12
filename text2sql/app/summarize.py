"""Result summaries and chart suggestions, computed on the server from the rows.

This is deliberately NOT done by the language model: result data never leaves the platform.
"""
import statistics


def _fmt(v) -> str:
    if isinstance(v, bool) or v is None:
        return str(v)
    if isinstance(v, (int, float)):
        a = abs(v)
        if isinstance(v, float) and a < 1000 and v != int(v):
            return f"{v:,.2f}"
        if a >= 1e9:
            return f"{v / 1e9:,.2f}B"
        if a >= 1e6:
            return f"{v / 1e6:,.2f}M"
        return f"{v:,.0f}" if float(v).is_integer() else f"{v:,.2f}"
    return str(v)


def _nice(name: str) -> str:
    return name.replace("_", " ").strip()


_TIME_WORDS = ("year", "yr", "month", "week", "day", "quarter", "qtr", "fy", "period", "date")


def is_measure(c: dict) -> bool:
    return c["type"] == "number" and c.get("role", "measure") == "measure"


def _comparable(columns, rows, measures) -> list[str]:
    """The first measure plus up to two more on a similar scale (one axis only - never dual axes)."""
    idx = {c["name"]: i for i, c in enumerate(columns)}

    def peak(m):
        return max((abs(r[idx[m]]) for r in rows if r[idx[m]] is not None), default=0)
    first = peak(measures[0])
    keep = [measures[0]]
    for m in measures[1:]:
        p = peak(m)
        if first and p and max(first, p) / min(first, p) <= 20:
            keep.append(m)
    return keep[:3]


def suggest_chart(columns: list[dict], rows: list[list]) -> dict:
    """Pick a sensible default view from the result's shape."""
    measures = [c["name"] for c in columns if is_measure(c)]
    dates = [c["name"] for c in columns if c["type"] == "date"]
    text = [c["name"] for c in columns if c["type"] in ("string", "boolean")]
    numdims = [c["name"] for c in columns if c["type"] == "number" and not is_measure(c)]
    time_dims = [n for n in numdims if any(w in n.lower() for w in _TIME_WORDS)]
    n = len(rows)
    idx = {c["name"]: i for i, c in enumerate(columns)}
    x = dates[0] if dates else text[0] if text else time_dims[0] if time_dims else numdims[0] if numdims else None
    if n == 0 or not measures:
        return {"type": "table", "x": x}
    if n == 1:
        return {"type": "kpi", "y": measures[:4]}
    if len(measures) > 4:           # wide / pivoted result: a table reads better than a chart
        return {"type": "table", "x": x, "y": measures[:1]}
    y = _comparable(columns, rows, measures)
    if x is None:
        return {"type": "scatter", "x": measures[0], "y": [measures[1]]} if len(measures) >= 2 else {"type": "kpi", "y": measures}
    if dates or (not text and time_dims):
        series = text[0] if dates and len(text) == 1 and len(measures) == 1 else None
        return {"type": "line", "x": x, "y": y[:1] if series else y, "series": series}
    distinct = len({r[idx[x]] for r in rows})
    others = [d for d in text + numdims if d != x]
    if others and len(measures) == 1 and distinct < n:
        return {"type": "bar", "x": x, "y": measures[:1], "series": others[0]}
    if n <= 6 and len(measures) == 1 and all((r[idx[measures[0]]] or 0) >= 0 for r in rows):
        return {"type": "doughnut", "x": x, "y": measures[:1]}
    return {"type": "bar" if n <= 40 else "line", "x": x, "y": y}


def summarize(columns: list[dict], rows: list[list], truncated: bool) -> dict:
    n = len(rows)
    out = {"row_count": n, "column_count": len(columns), "truncated": truncated, "headline": "", "bullets": [],
           "stats": []}
    if n == 0:
        out["headline"] = "The query ran successfully but returned no rows."
        return out
    idx = {c["name"]: i for i, c in enumerate(columns)}
    nums = [c["name"] for c in columns if is_measure(c)]       # identifiers are never totalled
    label_cols = [c["name"] for c in columns if c["type"] in ("string", "date", "boolean")] or \
                 [c["name"] for c in columns if c["type"] == "number" and not is_measure(c)]

    for c in columns:
        vals = [r[idx[c["name"]]] for r in rows]
        present = [v for v in vals if v is not None]
        s = {"column": c["name"], "type": c["type"], "role": "measure" if is_measure(c) else "dimension",
             "nulls": n - len(present), "distinct": len(set(map(str, present)))}
        if is_measure(c) and present:
            s.update(sum=sum(present), mean=statistics.fmean(present), min=min(present), max=max(present),
                     median=statistics.median(present))
        elif present and c["type"] == "number":
            s.update(min=min(present), max=max(present))
        elif present:
            ordered = sorted(map(str, present))
            s.update(min=ordered[0][:80], max=ordered[-1][:80])
        out["stats"].append(s)

    if n == 1:
        parts = [f"{_nice(c['name'])}: {_fmt(rows[0][idx[c['name']]])}" for c in columns[:6]]
        out["headline"] = " · ".join(parts)
        return out

    out["headline"] = f"{n:,} rows × {len(columns)} columns" + (" (row limit reached - more rows exist)" if truncated else "")
    label = label_cols[0] if label_cols else None
    for m in nums[:3]:
        vals = [(r[idx[m]], r) for r in rows if r[idx[m]] is not None]
        if not vals:
            continue
        total = sum(v for v, _ in vals)
        hi_v, hi_r = max(vals, key=lambda x: x[0])
        lo_v, lo_r = min(vals, key=lambda x: x[0])
        name = _nice(m)
        if label:
            share = f" ({hi_v / total:.0%} of total)" if total and hi_v > 0 and all(v >= 0 for v, _ in vals) else ""
            out["bullets"].append(f"Highest {name}: {hi_r[idx[label]]} at {_fmt(hi_v)}{share}; "
                                  f"lowest: {lo_r[idx[label]]} at {_fmt(lo_v)}.")
        out["bullets"].append(f"{name.capitalize()} totals {_fmt(total)}, averaging {_fmt(total / len(vals))} "
                              f"per row (range {_fmt(lo_v)} to {_fmt(hi_v)}).")
        # trend, when rows are ordered along a date axis
        date_cols = [c["name"] for c in columns if c["type"] == "date"]
        if date_cols and len(vals) >= 3:
            d = idx[date_cols[0]]
            seq = sorted(((r[d], v) for v, r in vals if r[d] is not None), key=lambda x: str(x[0]))
            if len(seq) >= 3 and len({s[0] for s in seq}) == len(seq) and seq[0][1]:
                change = (seq[-1][1] - seq[0][1]) / abs(seq[0][1])
                word = "up" if change > 0 else "down"
                out["bullets"].append(f"{name.capitalize()} is {word} {abs(change):.0%} from the first to the last "
                                      f"period ({_fmt(seq[0][1])} → {_fmt(seq[-1][1])}).")
        if label and len(vals) >= 5 and total > 0 and all(v >= 0 for v, _ in vals):
            top3 = sum(sorted((v for v, _ in vals), reverse=True)[:3])
            out["bullets"].append(f"The top 3 rows account for {top3 / total:.0%} of {name}.")
    if not nums and label:
        from collections import Counter
        common = Counter(str(r[idx[label]]) for r in rows).most_common(3)
        if common[0][1] > 1:
            out["bullets"].append(f"Most frequent {_nice(label)}: " + ", ".join(f"{k} ({v})" for k, v in common) + ".")
    return out
