"""Result summaries and chart suggestions, computed on the server from the rows.

This is deliberately NOT done by the language model: result data never leaves the platform.

The summary is written for the *shape* of the result:
  single   one row                      -> the figures themselves
  trend    a period column + measures   -> total, peak, low, change over the period
  ranking  a category + measures        -> leader, share, runners-up, concentration
  cross    two categories + a measure   -> leaders on each side, biggest combination
  pivot    a category + many measure columns (e.g. one per month)
  listing  no measures                  -> what is listed and how values are spread
  values   measures only                -> spread and relationship
"""
import re
import statistics
from collections import Counter, defaultdict

_TIME_WORDS = ("year", "yr", "month", "week", "day", "quarter", "qtr", "fy", "period", "date")
_PERIOD_VALUE = re.compile(r"^\d{4}([-/]?(Q[1-4]|W?\d{1,2})([-/]\d{1,2})?)?$|^(Q[1-4])[ -/]?\d{4}$", re.I)
# Averages, rates and prices must not be added up across rows.
_NON_ADDITIVE = re.compile(r"(avg|average|mean|median|pct|percent|percentage|rate|ratio|share|margin|price|"
                           r"per_|_per|score|index|rank|growth|yoy|mom|rating|age\b)", re.I)


def is_measure(c: dict) -> bool:
    return c["type"] == "number" and c.get("role", "measure") == "measure"


def is_additive(c: dict) -> bool:
    """False for averages / rates / prices: these are averaged, never totalled."""
    if "additive" in c:
        return bool(c["additive"])
    return not _NON_ADDITIVE.search(c["name"])


def enrich(columns: list[dict]) -> list[dict]:
    """Fill in 'additive' (and a default role) on column metadata, in place."""
    for c in columns:
        c.setdefault("role", "measure" if c["type"] == "number" else "dimension")
        if is_measure(c):
            c["additive"] = is_additive(c)
    return columns


# ---- formatting ---------------------------------------------------------------------
def _fmt(v) -> str:
    if isinstance(v, bool) or v is None:
        return str(v)
    if isinstance(v, (int, float)):
        a = abs(v)
        if a >= 1e9:
            return f"{v / 1e9:,.2f}B"
        if a >= 1e6:
            return f"{v / 1e6:,.2f}M"
        if a >= 1e4:
            return f"{v / 1e3:,.1f}K"
        if float(v).is_integer():
            return f"{v:,.0f}"
        return f"{v:,.2f}" if a >= 1 else f"{v:.3g}"
    return str(v).replace(" 00:00:00", "")


def _lbl(v) -> str:
    """A category / period value as a label (never number-formatted: 2024 stays 2024)."""
    return "(blank)" if v is None else str(v).replace(" 00:00:00", "")


def _nice(name: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", name).replace("_", " ")).strip().lower()


def _plural(word: str, n: int) -> str:
    if n == 1 or word.endswith("s"):
        return word
    return word[:-1] + "ies" if word.endswith("y") and word[-2:-1] not in "aeiou" else word + "s"


def _pct(part, whole) -> str:
    return f"{part / whole:.0%}" if whole else "n/a"


def _change(a, b) -> str:
    if not a:
        return f"from {_fmt(a)} to {_fmt(b)}"
    c = (b - a) / abs(a)
    word = "up" if c > 0 else "down" if c < 0 else "unchanged"
    return f"{word} {abs(c):.0%} ({_fmt(a)} → {_fmt(b)})" if c else f"unchanged at {_fmt(a)}"


# ---- chart suggestion ---------------------------------------------------------------
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


def _period_column(columns, rows) -> str | None:
    """The column that orders the rows in time, if there is one."""
    idx = {c["name"]: i for i, c in enumerate(columns)}
    for c in columns:
        if c["type"] == "date":
            return c["name"]
    for c in columns:
        if c["type"] == "number" and not is_measure(c) and any(w in c["name"].lower() for w in _TIME_WORDS):
            return c["name"]
    for c in columns:
        if c["type"] == "string":
            vals = [r[idx[c["name"]]] for r in rows[:50] if r[idx[c["name"]]] is not None]
            if vals and all(_PERIOD_VALUE.match(str(v).strip()) for v in vals):
                return c["name"]
    return None


def suggest_chart(columns: list[dict], rows: list[list]) -> dict:
    """Pick a sensible default view from the result's shape."""
    measures = [c["name"] for c in columns if is_measure(c)]
    text = [c["name"] for c in columns if c["type"] in ("string", "boolean")]
    numdims = [c["name"] for c in columns if c["type"] == "number" and not is_measure(c)]
    period = _period_column(columns, rows)
    n = len(rows)
    idx = {c["name"]: i for i, c in enumerate(columns)}
    x = period or (text[0] if text else numdims[0] if numdims else None)
    if n == 0 or not measures:
        return {"type": "table", "x": x}
    if n == 1:
        return {"type": "kpi", "y": measures[:4]}
    if len(measures) > 4:           # wide / pivoted result: a table reads better than a chart
        return {"type": "table", "x": x, "y": measures[:1]}
    y = _comparable(columns, rows, measures)
    if x is None:
        return {"type": "scatter", "x": measures[0], "y": [measures[1]]} if len(measures) >= 2 else {"type": "kpi", "y": measures}
    others = [d for d in text + numdims if d != x]
    distinct = len({r[idx[x]] for r in rows})
    if period:
        series = others[0] if others and len(measures) == 1 and distinct < n else None
        return {"type": "line", "x": x, "y": y[:1] if series else y, "series": series}
    if others and len(measures) == 1 and distinct < n:
        return {"type": "bar", "x": x, "y": measures[:1], "series": others[0]}
    if n <= 6 and len(measures) == 1 and all((r[idx[measures[0]]] or 0) >= 0 for r in rows):
        return {"type": "doughnut", "x": x, "y": measures[:1]}
    return {"type": "bar" if n <= 40 else "line", "x": x, "y": y}


# ---- summary ------------------------------------------------------------------------
def _stats(columns, rows) -> list[dict]:
    n, out = len(rows), []
    for i, c in enumerate(columns):
        present = [r[i] for r in rows if r[i] is not None]
        s = {"column": c["name"], "type": c["type"], "role": "measure" if is_measure(c) else "dimension",
             "nulls": n - len(present), "distinct": len(set(map(str, present)))}
        if is_measure(c) and present:
            s.update(mean=statistics.fmean(present), min=min(present), max=max(present),
                     median=statistics.median(present), additive=is_additive(c))
            if is_additive(c):
                s["sum"] = sum(present)
        elif present and c["type"] == "number":
            s.update(min=min(present), max=max(present))
        elif present:
            ordered = sorted(map(str, present))
            s.update(min=ordered[0][:80], max=ordered[-1][:80])
        out.append(s)
    return out


def _totals(rows, key_i, val_i) -> dict:
    """Sum of a measure per distinct key, in first-seen order."""
    t: dict = defaultdict(float)
    for r in rows:
        if r[val_i] is not None:
            t[_lbl(r[key_i])] += r[val_i]
    return dict(t)


def _averages(rows, key_i, val_i) -> dict:
    acc: dict = defaultdict(list)
    for r in rows:
        if r[val_i] is not None:
            acc[_lbl(r[key_i])].append(r[val_i])
    return {k: statistics.fmean(v) for k, v in acc.items()}


def _ranking(col, by: dict, what: str, lines: list, detail: bool = True):
    """Describe one measure across categories."""
    name, k = _nice(col["name"]), len(by)
    if not by:
        return
    ranked = sorted(by.items(), key=lambda kv: -kv[1])
    (top, top_v), (low, low_v) = ranked[0], ranked[-1]
    if not is_additive(col):
        avg = statistics.fmean(by.values())
        lines.append(f"{name.capitalize()} averages {_fmt(avg)} across {k} {_plural(what, k)}: highest is {top} "
                     f"({_fmt(top_v)}), lowest is {low} ({_fmt(low_v)}).")
        return
    total = sum(by.values())
    positive = total > 0 and all(v >= 0 for v in by.values())
    if k == 1:
        lines.append(f"{name.capitalize()} for {top} is {_fmt(top_v)}.")
        return
    avg = total / k
    lead = f"{top} has the highest {name} at {_fmt(top_v)}"
    if positive:
        lead += f" — {_pct(top_v, total)} of the {_fmt(total)} total"
        if avg and top_v / avg >= 1.5:
            lead += f", {top_v / avg:.1f}× the average {what}"
    lines.append(lead + ".")
    if not detail:
        return
    if k >= 3:
        nxt = ", ".join(f"{a} ({_fmt(v)}{', ' + _pct(v, total) if positive else ''})" for a, v in ranked[1:3])
        lines.append(f"Next: {nxt}.")
    lines.append(f"Lowest: {low} at {_fmt(low_v)}" + (f" ({_pct(low_v, total)})." if positive else "."))
    if positive and k >= 5:
        top3 = sum(v for _, v in ranked[:3])
        above = sum(v > avg for v in by.values())
        lines.append(f"The top 3 {_plural(what, 3)} account for {_pct(top3, total)} of {name}; "
                     f"{above} of {k} are above the average of {_fmt(avg)}.")


def _trend(col, seq: list, what: str, lines: list):
    """Describe one measure over ordered periods. seq = [(period_label, value)]."""
    name, k = _nice(col["name"]), len(seq)
    vals = [v for _, v in seq]
    if not vals:
        return
    (hi_p, hi_v), (lo_p, lo_v) = max(seq, key=lambda x: x[1]), min(seq, key=lambda x: x[1])
    if is_additive(col):
        lines.append(f"{name.capitalize()} totals {_fmt(sum(vals))} over {k} {_plural(what, k)}, "
                     f"averaging {_fmt(sum(vals) / k)} per {what}.")
    else:
        lines.append(f"{name.capitalize()} averages {_fmt(statistics.fmean(vals))} over {k} {_plural(what, k)}.")
    if k >= 2:
        lines.append(f"Highest in {hi_p} ({_fmt(hi_v)}); lowest in {lo_p} ({_fmt(lo_v)}).")
        lines.append(f"From {seq[0][0]} to {seq[-1][0]} it is {_change(vals[0], vals[-1])}.")
    if k >= 3 and vals[-2]:
        lines.append(f"The latest {what}, {seq[-1][0]}, is {_change(vals[-2], vals[-1])} on the one before"
                     + (" — check whether that period is complete." if vals[-1] < 0.6 * vals[-2] else "."))
    if k >= 6:
        half = k // 2
        a, b = statistics.fmean(vals[:half]), statistics.fmean(vals[-half:])
        if a and abs(b - a) / abs(a) >= 0.1:
            lines.append(f"The second half of the period averages {_fmt(b)} per {what}, "
                         f"{'above' if b > a else 'below'} the first half's {_fmt(a)}.")


def summarize(columns: list[dict], rows: list[list], truncated: bool) -> dict:
    enrich(columns)
    n = len(rows)
    out = {"row_count": n, "column_count": len(columns), "truncated": truncated, "headline": "", "bullets": [],
           "shape": "empty", "stats": _stats(columns, rows)}
    if n == 0:
        out["headline"] = "The query ran successfully but returned no rows — nothing matches the question's conditions."
        return out
    idx = {c["name"]: i for i, c in enumerate(columns)}
    col = {c["name"]: c for c in columns}
    measures = [c["name"] for c in columns if is_measure(c)]
    period = _period_column(columns, rows)
    text = [c["name"] for c in columns if c["type"] in ("string", "boolean") and c["name"] != period]
    numdims = [c["name"] for c in columns if c["type"] == "number" and not is_measure(c) and c["name"] != period]
    cats = text + numdims
    b = out["bullets"]
    caveats = []
    if truncated:
        caveats.append(f"Only the first {n:,} rows were returned (row limit), so totals and rankings here are partial.")

    if n == 1:
        out["shape"] = "single"
        out["headline"] = " · ".join(f"{_nice(c['name'])}: {_fmt(rows[0][idx[c['name']]])}" for c in columns[:6])

    elif not measures:
        out["shape"] = "listing"
        out["headline"] = f"A list of {n:,} rows with {len(columns)} columns — there is nothing numeric to total."
        for d in (cats + ([period] if period else []))[:3]:
            counts = Counter(_lbl(r[idx[d]]) for r in rows if r[idx[d]] is not None)
            if not counts:
                continue
            if len(counts) == n:
                b.append(f"Every row has a different {_nice(d)} ({n:,} distinct).")
            else:
                top = ", ".join(f"{k} ({v})" for k, v in counts.most_common(3))
                b.append(f"{len(counts)} distinct {_plural(_nice(d), len(counts))}; most frequent: {top}.")

    elif len(measures) > 4 and (cats or period) and all(is_additive(col[m]) for m in measures):
        # wide pivot: one row per category, one column per period/series
        out["shape"] = "pivot"
        label = text[0] if text else (cats[0] if cats else period)
        what = _nice(label)
        row_tot = {_lbl(r[idx[label]]):
                   sum(r[idx[m]] or 0 for m in measures) for r in rows}
        col_tot = {m: sum(r[idx[m]] or 0 for r in rows) for m in measures}
        grand = sum(col_tot.values())
        out["headline"] = (f"A cross-table of {len(row_tot)} {_plural(what, len(row_tot))} (rows) by {len(measures)} "
                           f"columns ({measures[0]} … {measures[-1]}), totalling {_fmt(grand)} overall.")
        ranked = sorted(row_tot.items(), key=lambda kv: -kv[1])
        b.append(f"Largest row: {ranked[0][0]} with {_fmt(ranked[0][1])} across all columns"
                 + (f" ({_pct(ranked[0][1], grand)} of the total)" if grand > 0 else "") + "; smallest: "
                 f"{ranked[-1][0]} with {_fmt(ranked[-1][1])}.")
        if len(ranked) >= 5 and grand > 0:
            b.append(f"The top 3 {_plural(what, 3)} make up {_pct(sum(v for _, v in ranked[:3]), grand)} of the total.")
        hi, lo = max(col_tot, key=col_tot.get), min(col_tot, key=col_tot.get)
        b.append(f"Highest column: {hi} ({_fmt(col_tot[hi])}); lowest: {lo} ({_fmt(col_tot[lo])}).")
        b.append(f"Column totals go {_change(col_tot[measures[0]], col_tot[measures[-1]])} from {measures[0]} to {measures[-1]}.")
        cell = max(((r[idx[m]] or 0, _lbl(r[idx[label]]), m) for r in rows for m in measures), key=lambda t: t[0])
        b.append(f"Biggest single value: {cell[1]} in {cell[2]} ({_fmt(cell[0])}).")
        blanks = sum(1 for r in rows for m in measures if not r[idx[m]])
        if blanks:
            b.append(f"{blanks} of {n * len(measures)} cells are empty or zero.")

    elif period:
        out["shape"] = "trend"
        what = _nice(period)
        what = "period" if what in ("date", "order date") or what.endswith(" date") else what
        order = sorted({r[idx[period]] for r in rows if r[idx[period]] is not None}, key=str)
        labels = [_lbl(p) for p in order]
        split = cats[0] if cats and len(order) < n else None
        out["headline"] = (f"{', '.join(_nice(m) for m in measures[:3]).capitalize()} by {what} from {labels[0]} to "
                           f"{labels[-1]}" + (f", split by {_nice(split)}" if split else "") + f" ({len(order)} {_plural(what, len(order))}).")
        for m in measures[:3]:
            agg = _totals if is_additive(col[m]) else _averages
            by = agg(rows, idx[period], idx[m])
            _trend(col[m], [(lbl, by[lbl]) for lbl in labels if lbl in by], what, b)
        if split and is_additive(col[measures[0]]):
            _ranking(col[measures[0]], _totals(rows, idx[split], idx[measures[0]]), _nice(split), b, detail=False)

    elif cats:
        label = cats[0]
        what = _nice(label)
        distinct = len({r[idx[label]] for r in rows})
        second = cats[1] if len(cats) > 1 and distinct < n else None
        m0 = measures[0]
        agg0 = _totals if is_additive(col[m0]) else _averages
        if second:
            out["shape"] = "cross"
            what2 = _nice(second)
            d2 = len({r[idx[second]] for r in rows})
            out["headline"] = (f"{_nice(m0).capitalize()} broken down by {what} ({distinct}) and {what2} ({d2}) — "
                               f"{n:,} combinations.")
            _ranking(col[m0], agg0(rows, idx[label], idx[m0]), what, b, detail=False)
            _ranking(col[m0], agg0(rows, idx[second], idx[m0]), what2, b, detail=False)
            best = max((r for r in rows if r[idx[m0]] is not None), key=lambda r: r[idx[m0]], default=None)
            if best:
                b.append(f"Biggest single combination: {_lbl(best[idx[label]])} / {_lbl(best[idx[second]])} "
                         f"at {_fmt(best[idx[m0]])}.")
        else:
            out["shape"] = "ranking"
            out["headline"] = (f"{', '.join(_nice(m) for m in measures[:3]).capitalize()} for each of "
                               f"{distinct} {_plural(what, distinct)}.")
            for i, m in enumerate(measures[:3]):
                agg = _totals if is_additive(col[m]) else _averages
                _ranking(col[m], agg(rows, idx[label], idx[m]), what, b, detail=(i == 0))
            if len(measures) >= 2 and n >= 3:
                a = max(rows, key=lambda r: r[idx[measures[0]]] or 0)
                c = max(rows, key=lambda r: r[idx[measures[1]]] or 0)
                if a is not c:
                    b.append(f"The leaders differ: {_lbl(a[idx[label]])} is top for {_nice(measures[0])}, "
                             f"{_lbl(c[idx[label]])} for {_nice(measures[1])}.")
    else:
        out["shape"] = "values"
        out["headline"] = f"{n:,} rows of figures with no category column to group them by."
        for m in measures[:3]:
            v = [r[idx[m]] for r in rows if r[idx[m]] is not None]
            if v:
                b.append(f"{_nice(m).capitalize()}: ranges from {_fmt(min(v))} to {_fmt(max(v))}, average "
                         f"{_fmt(statistics.fmean(v))}, median {_fmt(statistics.median(v))}.")
        if len(measures) >= 2 and n >= 5:
            pairs = [(r[idx[measures[0]]], r[idx[measures[1]]]) for r in rows
                     if r[idx[measures[0]]] is not None and r[idx[measures[1]]] is not None]
            try:
                corr = statistics.correlation([p[0] for p in pairs], [p[1] for p in pairs])
                strength = "strongly" if abs(corr) >= 0.7 else "moderately" if abs(corr) >= 0.4 else "barely"
                b.append(f"{_nice(measures[0]).capitalize()} and {_nice(measures[1])} are {strength} related "
                         f"({'they rise together' if corr > 0 else 'one falls as the other rises'}; correlation {corr:.2f}).")
            except (statistics.StatisticsError, ZeroDivisionError):
                pass

    nulls = [s["column"] for s in out["stats"] if s["nulls"] and s["role"] == "measure"]
    if nulls and n > 1:
        caveats.append(f"Some rows have no value for {', '.join(nulls[:3])}; they are left out of the figures above.")
    out["bullets"] = b + caveats
    return out
