"""Custom reports: access rules, live rendering, PDF generation, schedules.

A report stores *queries*, not data. Every time it is opened it is re-run for the person
looking at it, with that person's data-model access and row filters. Scheduled runs use
the owner's access.
"""
import datetime as dt
import io
import logging
import os
import re
import threading
import time
import uuid
from zoneinfo import ZoneInfo

from sqlalchemy import or_, select, update

from . import config, connectors, engine, mailer, sqlguard
from .db import SessionLocal, now
from .deps import can_use, get_settings
from .models import Connection, QueryRun, Report, ReportShare, ReportSnapshot, User, UserGroup, UserGroupMember
from .summarize import is_additive, is_measure

log = logging.getLogger("text2sql.reports")
MAX_COMPONENTS = 40
COUNT = "__count__"
PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"]
MULTI = ("bar", "hbar", "stacked", "line", "area")


# ---- access ---------------------------------------------------------------------------
def group_ids(db, user) -> list[int]:
    return list(db.scalars(select(UserGroupMember.group_id).where(UserGroupMember.user_id == user.id)))


def _mine(db, user):
    """SQL condition: a share row that applies to this user (directly, by role, or through a group)."""
    cond = or_((ReportShare.scope == "user") & (ReportShare.user_id == user.id),
               (ReportShare.scope == "role") & (ReportShare.role == user.role))
    groups = group_ids(db, user)
    return or_(cond, (ReportShare.scope == "group") & ReportShare.group_id.in_(groups)) if groups else cond


def _share(db, user, report) -> ReportShare | None:
    rows = list(db.scalars(select(ReportShare).where(ReportShare.report_id == report.id, _mine(db, user))))
    return max(rows, key=lambda s: s.can_edit, default=None)


def is_owner(user, report) -> bool:
    return user.role == "admin" or report.owner_id == user.id


def can_view(db, user, report) -> bool:
    return is_owner(user, report) or _share(db, user, report) is not None


def can_edit(db, user, report) -> bool:
    if is_owner(user, report):
        return True
    s = _share(db, user, report)
    return bool(s and s.can_edit)


def visible_reports(db, user) -> list[Report]:
    if user.role == "admin":
        return list(db.scalars(select(Report).order_by(Report.updated_at.desc())))
    shared = select(ReportShare.report_id).where(_mine(db, user))
    return list(db.scalars(select(Report).where(or_(Report.owner_id == user.id, Report.id.in_(shared)))
                           .order_by(Report.updated_at.desc())))


# ---- components -----------------------------------------------------------------------
def result_component(run: QueryRun) -> dict:
    return {"id": uuid.uuid4().hex[:10], "type": "result", "run_id": run.id, "connection_id": run.connection_id,
            "sql": run.final_sql, "question": run.question, "title": run.question[:200],
            "show_chart": True, "show_table": True, "show_summary": True, "table_rows": 25,
            "chart": {k: v for k, v in (run.chart or {}).items() if k != "hide"},
            # predictive answers carry their method + columns, so the model is re-fitted on fresh data each time
            "analysis": (run.analysis or {}).get("spec"), "show_analysis": True, "hide": list((run.chart or {}).get("hide") or [])}


def _width(c) -> int:
    """Layout width in sixths of the page: 6 = full, 3 = half, 2 = a third."""
    try:
        w = int(c.get("width") or 6)
    except (TypeError, ValueError):
        w = 6
    return w if w in (2, 3, 4, 6) else 6


def layout_rows(components: list) -> list[list]:
    """Pack components into rows: narrower ones sit side by side until the row is full."""
    rows, cur, used = [], [], 0
    for c in components:
        w = 6 if c["type"] in ("divider", "pagebreak") else int(c.get("width") or 6)
        if cur and (used + w > 6 or w == 6):
            rows.append(cur)
            cur, used = [], 0
        cur.append(c)
        used += w
        if used >= 6:
            rows.append(cur)
            cur, used = [], 0
    if cur:
        rows.append(cur)
    return rows


def recipients(db, report: Report) -> tuple[list[User], list[str]]:
    """Who a schedule emails: (people with an account - each gets their own view, other addresses)."""
    s = report.schedule or {}
    ids = set(int(i) for i in s.get("user_ids") or [])
    gids = [int(g) for g in s.get("group_ids") or []]
    if gids:
        ids |= set(db.scalars(select(UserGroupMember.user_id).where(UserGroupMember.group_id.in_(gids))))
    users = [u for u in db.scalars(select(User).where(User.id.in_(ids))) if u.is_active] if ids else []
    known = {u.email.lower() for u in users}
    extra = [e for e in dict.fromkeys(x.strip() for x in s.get("recipients") or []) if "@" in e and e.lower() not in known]
    return users, extra


def clean_components(db, user, incoming: list, existing: list) -> list:
    """Validate what the editor sent. The SQL of a result component is never taken from the
    browser: it is copied from one of the editor's own answered questions, or kept as stored."""
    if not isinstance(incoming, list) or len(incoming) > MAX_COMPONENTS:
        raise ValueError(f"A report can have at most {MAX_COMPONENTS} components.")
    known = {c["id"]: c for c in existing if c.get("type") == "result"}
    out = []
    for c in incoming:
        if not isinstance(c, dict):
            continue
        kind, cid = c.get("type"), str(c.get("id") or uuid.uuid4().hex[:10])[:20]
        if kind in ("heading", "text"):
            item = {"id": cid, "type": kind, "text": str(c.get("text") or "")[:20000], "width": _width(c)}
            if kind == "heading":
                item["level"] = 2 if c.get("level") == 2 else 1
            out.append(item)
        elif kind in ("divider", "pagebreak"):
            out.append({"id": cid, "type": kind})
        elif kind == "result":
            if cid in known:
                base = dict(known[cid])
            else:
                run = db.get(QueryRun, int(c.get("run_id") or 0))
                if not run or run.user_id != user.id or run.status != "success":
                    raise ValueError("A result can only be added from one of your own successfully answered questions.")
                base = result_component(run)
                base["id"] = cid
            chart = c["chart"] if isinstance(c.get("chart"), dict) and c["chart"] else base.get("chart", {})
            base.update(
                title=str(c.get("title") or base["title"])[:200],
                show_chart=bool(c.get("show_chart", True)), show_table=bool(c.get("show_table", True)),
                show_summary=bool(c.get("show_summary", True)), width=_width(c),
                show_analysis=bool(c.get("show_analysis", True)),
                hide=[k for k in (c.get("hide") or []) if k in ("explain", "chart", "table", "stats", "code")],
                table_rows=min(max(int(c.get("table_rows") or 25), 1), 500),
                chart={k: chart.get(k) for k in ("type", "x", "y", "series") if k in chart})
            out.append(base)
        else:
            raise ValueError("Unknown component type.")
    return out


def _tokens(text: str, report, viewer, results: list[dict]) -> str:
    """Live placeholders usable in headings, text, header and footer."""
    stamp = dt.datetime.now()

    def sub(m):
        key, arg = m.group(1).lower(), m.group(2)
        if key == "date":
            return stamp.strftime("%d %b %Y")
        if key == "datetime":
            return stamp.strftime("%d %b %Y %H:%M")
        if key == "viewer":
            return viewer.name or viewer.email
        if key == "title":
            return report.title
        if key in ("summary", "rows") and arg:
            i = int(arg) - 1
            if 0 <= i < len(results) and results[i].get("status") == "ok":
                return results[i]["summary"]["headline"] if key == "summary" else f"{results[i]['row_count']:,}"
            return "(not available)"
        return m.group(0)
    return re.sub(r"\{\{\s*(\w+)\s*(?::\s*(\d+)\s*)?\}\}", sub, text or "")


def render(db, report: Report, viewer: User) -> dict:
    """Re-run every result for this viewer and resolve the text placeholders."""
    cfg = get_settings(db)
    conns: dict = {}
    results = []
    comps = [dict(c) for c in (report.components or [])]
    for c in comps:
        if c["type"] != "result":
            continue
        cid = c["connection_id"]
        if cid not in conns:
            conns[cid] = db.get(Connection, cid)
        conn = conns[cid]
        if not conn or not conn.is_active or not can_use(db, viewer, conn):
            c.update(status="no_access", message="You do not have access to the data model this result comes from.")
        else:
            try:
                spec = c.get("analysis") if c.get("show_analysis", True) and cfg["predictive_enabled"] else None
                res = engine.run_sql(db, conn, next(x["sql"] for x in report.components if x["id"] == c["id"]), cfg, viewer, spec)
                c.update(status="ok", columns=res["columns"], rows=res["rows"], row_count=res["row_count"],
                         analysis=res.get("analysis"),
                         truncated=res["truncated"], summary=res["summary"], filtered=bool(res["filters"]),
                         data_model=conn.name)
            except sqlguard.SQLBlocked as e:
                c.update(status="error", message=f"Blocked: {e}")
            except connectors.ConnectorError as e:
                c.update(status="error", message=str(e))
        if c.get("status") != "ok":
            c.pop("sql", None)          # do not reveal schema details of data the viewer cannot use
        results.append(c)
    for c in comps:
        if c["type"] in ("heading", "text"):
            c["text"] = _tokens(c["text"], report, viewer, results)
    return {"id": report.id, "title": report.title, "description": report.description,
            "header_text": _tokens(report.header_text, report, viewer, results),
            "footer_text": _tokens(report.footer_text, report, viewer, results),
            "page_numbers": report.page_numbers, "components": comps,
            "refreshed_at": now().isoformat(), "viewer": viewer.name or viewer.email}


# ---- charts (server-side, for PDF) -------------------------------------------------------
def _label(v) -> str:
    return "(blank)" if v is None else str(v).replace(" 00:00:00", "")


def chart_panels(columns, rows, cfg) -> list[dict]:
    """Mirror of the browser's chart logic: one dict per panel, ready to draw."""
    idx = {c["name"]: i for i, c in enumerate(columns)}
    col = {c["name"]: c for c in columns}
    kind = cfg.get("type") or "bar"
    measures = [c["name"] for c in columns if is_measure(c)]
    x = cfg.get("x") if cfg.get("x") in idx else next((c["name"] for c in columns if not is_measure(c)), None)
    ys = [y for y in (cfg.get("y") or []) if y in measures or y == COUNT] or (measures[:1] or [COUNT])
    rows = rows[:300]
    if kind in ("table", "kpi") or x is None or not rows:
        return []
    name = lambda y: "Count of rows" if y == COUNT else y      # noqa: E731
    val = lambda r, y: 1 if y == COUNT else r[idx[y]]          # noqa: E731

    def grouped(y):
        acc: dict = {}
        for r in rows:
            v = val(r, y)
            if v is not None:
                acc.setdefault(_label(r[idx[x]]), []).append(float(v))
        avg = y != COUNT and not is_additive(col[y])
        return {k: (sum(v) / len(v) if avg else sum(v)) for k, v in acc.items()}

    if kind == "scatter":
        if len(measures) < 2:
            return []
        xm = x if x in measures else measures[0]
        ym = ys[0] if ys[0] in measures and ys[0] != xm else next(m for m in measures if m != xm)
        pts = [(r[idx[xm]], r[idx[ym]]) for r in rows if r[idx[xm]] is not None and r[idx[ym]] is not None]
        return [{"type": "scatter", "points": pts, "x_title": xm, "y_title": ym}]
    if kind in ("pie", "doughnut"):
        pts = sorted(grouped(ys[0]).items(), key=lambda kv: -kv[1])
        if len(pts) > 8:
            pts = pts[:7] + [("Other", sum(v for _, v in pts[7:]))]
        return [{"type": kind, "labels": [p[0] for p in pts], "values": [max(p[1], 0) for p in pts], "title": name(ys[0])}]
    series = cfg.get("series") if cfg.get("series") in idx and cfg.get("series") != x else None
    labels = list(dict.fromkeys(_label(r[idx[x]]) for r in rows))
    if series:
        y = ys[0]
        totals: dict = {}
        for r in rows:
            totals[_label(r[idx[series]])] = totals.get(_label(r[idx[series]]), 0) + abs(float(val(r, y) or 0))
        keep = [k for k, _ in sorted(totals.items(), key=lambda kv: -kv[1])][:7 if len(totals) > 8 else 8]
        names = keep + (["Other"] if len(totals) > len(keep) else [])
        grid = {n: {} for n in names}
        for r in rows:
            s = _label(r[idx[series]])
            g = grid[s if s in keep else "Other"]
            g[_label(r[idx[x]])] = g.get(_label(r[idx[x]]), 0) + float(val(r, y) or 0)
        return [{"type": kind, "labels": labels, "x_title": x, "y_title": name(y),
                 "datasets": [{"label": n, "data": [grid[n].get(lbl) for lbl in labels]} for n in names]}]
    ys = ys[:1] if kind not in MULTI or ys[0] == COUNT else ys[:3]
    data = {y: grouped(y) for y in ys}
    peaks = [max((abs(v) for v in data[y].values()), default=0) for y in ys]
    split = len(ys) == 2 and min(peaks) > 0 and max(peaks) / min(peaks) > 20
    make = lambda group: {"type": kind, "labels": labels, "x_title": x, "y_title": name(group[0]) if len(group) == 1 else "",   # noqa: E731
                          "datasets": [{"label": name(y), "data": [data[y].get(lbl) for lbl in labels]} for y in group]}
    return [make([y]) for y in ys] if split else [make(ys)]


def _compact(v, _pos=None) -> str:
    a = abs(v)
    if a >= 1e9:
        return f"{v / 1e9:.1f}B"
    if a >= 1e6:
        return f"{v / 1e6:.1f}M"
    if a >= 1e4:
        return f"{v / 1e3:.0f}K"
    return f"{v:,.0f}" if float(v).is_integer() else f"{v:,.2f}"


def draw_plot(plot: dict) -> bytes:
    """A plot produced by the predictive engine (line with range / bars / scatter) as PNG bytes."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.ticker import FuncFormatter

    kind, grey = plot["kind"], "#55544e"
    fig, ax = plt.subplots(figsize=(9, 3.9), dpi=130)
    nan = lambda vs: [float("nan") if v is None else v for v in vs]      # noqa: E731
    if kind == "line":
        labels = plot["labels"]
        pos = list(range(len(labels)))
        by = {d["role"]: d for d in plot["datasets"]}
        if "upper" in by and "lower" in by:
            ax.fill_between(pos, nan(by["lower"]["data"]), nan(by["upper"]["data"]), color=PALETTE[1], alpha=0.18,
                            label=by["upper"]["label"], linewidth=0)
        for d in plot["datasets"]:
            if d["role"] == "actual":
                ax.plot(pos, nan(d["data"]), color=PALETTE[0], linewidth=2, label=d["label"])
            elif d["role"] == "forecast":
                ax.plot(pos, nan(d["data"]), color=PALETTE[1], linewidth=2, linestyle="--", label=d["label"])
            elif d["role"] == "flag":
                ax.scatter(pos, nan(d["data"]), color=PALETTE[7], s=42, zorder=3, label=d["label"])
        step = max(1, len(pos) // 22)
        ax.set_xticks(pos[::step], labels[::step], rotation=40, ha="right")
        ax.yaxis.set_major_formatter(FuncFormatter(_compact))
        ax.grid(axis="y", color="#e9e8e3", linewidth=0.8)
        ax.legend(frameon=False, fontsize=9, loc="upper left")
    elif kind == "scatter":
        n = 0
        for d in plot["datasets"]:
            xs, ys = zip(*d["points"]) if d["points"] else ((), ())
            if d["role"] == "forecast":
                ax.plot(xs, ys, color=grey, linestyle="--", linewidth=1.2, label=d["label"])
            else:
                ax.scatter(xs, ys, s=22, alpha=0.8, color=PALETTE[7] if d["role"] == "flag" else PALETTE[n % 8], label=d["label"][:40])
                n += d["role"] != "flag"
        ax.xaxis.set_major_formatter(FuncFormatter(_compact))
        ax.yaxis.set_major_formatter(FuncFormatter(_compact))
        ax.grid(color="#e9e8e3", linewidth=0.8)
        ax.legend(frameon=False, fontsize=8, loc="best")
    else:
        labels, sets = [str(lbl)[:44] for lbl in plot["labels"]], plot["datasets"]
        pos = list(range(len(labels)))
        w = 0.74 / max(len(sets), 1)
        for i, d in enumerate(sets):
            off = [p - 0.37 + w * (i + 0.5) for p in pos]
            color = PALETTE[7] if d["role"] == "flag" else PALETTE[i]
            if kind == "hbar":
                ax.barh(off, [v or 0 for v in d["data"]], height=w * 0.9, color=color, label=d["label"])
            else:
                ax.bar(off, [v or 0 for v in d["data"]], width=w * 0.9, color=color, label=d["label"])
        if kind == "hbar":
            ax.set_yticks(pos, labels)
            ax.invert_yaxis()
            ax.xaxis.set_major_formatter(FuncFormatter(_compact))
            ax.grid(axis="x", color="#e9e8e3", linewidth=0.8)
        else:
            ax.set_xticks(pos, labels, rotation=30 if len(pos) > 5 else 0, ha="right" if len(pos) > 5 else "center")
            ax.yaxis.set_major_formatter(FuncFormatter(_compact))
            ax.grid(axis="y", color="#e9e8e3", linewidth=0.8)
        if len(sets) > 1:
            ax.legend(frameon=False, fontsize=9)
    ax.set_xlabel(plot.get("x_title", ""), color=grey)
    ax.set_ylabel(plot.get("y_title", ""), color=grey)
    ax.set_axisbelow(True)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color("#cfcec8")
    ax.tick_params(colors=grey, labelsize=9)
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return buf.getvalue()


def draw_panel(panel: dict, tall: bool = True, narrow: bool = False) -> bytes:
    """One chart panel as PNG bytes."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.ticker import FuncFormatter

    kind = panel["type"]
    # a narrow (side-by-side) slot gets a smaller canvas, so text stays readable once scaled to fit
    fig, ax = plt.subplots(figsize=(5.0, 2.9) if narrow else (9, 4.1 if tall else 3.0), dpi=170 if narrow else 130)
    grey = "#55544e"
    if kind in ("pie", "doughnut"):
        vals = panel["values"]
        if sum(vals) <= 0:
            plt.close(fig)
            return b""
        ax.pie(vals, labels=None, colors=PALETTE[:len(vals)], startangle=90, counterclock=False,
               wedgeprops={"width": 0.42 if kind == "doughnut" else 1, "edgecolor": "white", "linewidth": 2})
        total = sum(vals)
        ax.legend([f"{lbl[:28]}  {v / total:.0%}" for lbl, v in zip(panel["labels"], vals)], loc="center left",
                  bbox_to_anchor=(1.0, 0.5), frameon=False, fontsize=10)
        ax.set_aspect("equal")
    elif kind == "scatter":
        xs, ys = zip(*panel["points"]) if panel["points"] else ((), ())
        ax.scatter(xs, ys, color=PALETTE[0], alpha=0.8, s=28)
        ax.set_xlabel(panel["x_title"], color=grey)
        ax.set_ylabel(panel["y_title"], color=grey)
        ax.xaxis.set_major_formatter(FuncFormatter(_compact))
        ax.yaxis.set_major_formatter(FuncFormatter(_compact))
    else:
        labels, sets = panel["labels"], panel["datasets"]
        pos = list(range(len(labels)))
        short = [lbl[:22] for lbl in labels]
        if kind in ("line", "area"):
            for i, d in enumerate(sets):
                vals = [float("nan") if v is None else v for v in d["data"]]
                ax.plot(pos, vals, color=PALETTE[i], linewidth=2, marker="o" if len(pos) <= 40 else None,
                        markersize=4, label=d["label"])
                if kind == "area":
                    ax.fill_between(pos, vals, color=PALETTE[i], alpha=0.18)
        elif kind == "stacked":
            base = [0.0] * len(pos)
            for i, d in enumerate(sets):
                vals = [v or 0 for v in d["data"]]
                ax.bar(pos, vals, bottom=base, color=PALETTE[i], width=0.62, label=d["label"], edgecolor="white", linewidth=0.8)
                base = [a + b for a, b in zip(base, vals)]
        else:
            w = 0.74 / max(len(sets), 1)
            for i, d in enumerate(sets):
                off = [p - 0.37 + w * (i + 0.5) for p in pos]
                vals = [v or 0 for v in d["data"]]
                if kind == "hbar":
                    ax.barh(off, vals, height=w * 0.92, color=PALETTE[i], label=d["label"])
                else:
                    ax.bar(off, vals, width=w * 0.92, color=PALETTE[i], label=d["label"])
        step = max(1, len(pos) // 24)
        if kind == "hbar":
            ax.set_yticks(pos[::step], short[::step])
            ax.invert_yaxis()
            ax.xaxis.set_major_formatter(FuncFormatter(_compact))
            ax.grid(axis="x", color="#e9e8e3", linewidth=0.8)
            ax.set_xlabel(panel.get("y_title", ""), color=grey)
        else:
            ax.set_xticks(pos[::step], short[::step], rotation=40 if len(pos) > 6 else 0,
                          ha="right" if len(pos) > 6 else "center")
            ax.yaxis.set_major_formatter(FuncFormatter(_compact))
            ax.grid(axis="y", color="#e9e8e3", linewidth=0.8)
            ax.set_ylabel(panel.get("y_title", ""), color=grey)
            ax.set_xlabel(panel.get("x_title", ""), color=grey)
        ax.set_axisbelow(True)
        if len(sets) > 1:
            ax.legend(frameon=False, fontsize=9, ncol=min(len(sets), 4), loc="upper center", bbox_to_anchor=(0.5, -0.22 if len(pos) > 6 else -0.14))
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color("#cfcec8")
    ax.tick_params(colors=grey, labelsize=9)
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return buf.getvalue()


# ---- PDF ----------------------------------------------------------------------------------
def _fmt_cell(v, numeric: bool) -> str:
    if v is None:
        return ""
    if numeric and isinstance(v, (int, float)) and not isinstance(v, bool):
        return f"{v:,.0f}" if float(v).is_integer() else f"{v:,.2f}"
    return str(v).replace(" 00:00:00", "")[:60]


def build_pdf(rendered: dict) -> bytes:
    import matplotlib
    from fpdf import FPDF
    from fpdf.enums import XPos, YPos
    from fpdf.fonts import FontFace

    fonts = os.path.join(matplotlib.get_data_path(), "fonts", "ttf")

    class PDF(FPDF):
        def header(self):
            if rendered["header_text"]:
                self.set_font("dv", "", 8)
                self.set_text_color(120)
                self.cell(0, 6, rendered["header_text"], new_x=XPos.LMARGIN, new_y=YPos.NEXT)
                self.set_draw_color(220)
                self.line(self.l_margin, self.get_y(), self.w - self.r_margin, self.get_y())
                self.ln(4)

        def footer(self):
            self.set_y(-12)
            self.set_font("dv", "", 8)
            self.set_text_color(120)
            self.cell(0, 6, rendered["footer_text"] or "")
            if rendered["page_numbers"]:
                self.set_x(self.l_margin)
                self.cell(0, 6, f"Page {self.page_no()} of {{nb}}", align="R")

    pdf = PDF(format="A4")
    pdf.add_font("dv", "", os.path.join(fonts, "DejaVuSans.ttf"))
    pdf.add_font("dv", "B", os.path.join(fonts, "DejaVuSans-Bold.ttf"))
    pdf.add_font("dvm", "", os.path.join(fonts, "DejaVuSansMono.ttf"))
    pdf.set_auto_page_break(True, margin=16)
    pdf.set_margins(15, 14, 15)
    pdf.add_page()
    width = pdf.w - pdf.l_margin - pdf.r_margin

    def para(text, size=10, style="", color=30, gap=2.5, lh=None):
        pdf.set_font("dv", style, size)
        pdf.set_text_color(color)
        pdf.multi_cell(width, lh or size * 0.52, text, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        pdf.ln(gap)

    para(rendered["title"], 20, "B", 15, 1.5)
    if rendered["description"]:
        para(rendered["description"], 10, "", 90, 1.5)
    para(f"Data refreshed {dt.datetime.now().strftime('%d %b %Y %H:%M')} for {rendered['viewer']}", 8, "", 130, 5)

    full = width
    gap = 6

    def text_h(text, size, w):
        pdf.set_font("dv", "", size)
        lines = pdf.multi_cell(w, size * 0.52, text, dry_run=True, output="LINES")
        return len(lines) * size * 0.52 + 2.5

    def estimate(c, w) -> float:
        """Rough height of a component at width w, used to keep side-by-side rows on one page."""
        kind = c["type"]
        if kind == "heading":
            return text_h(c["text"], 15 if c.get("level") == 1 else 12, w) + 2
        if kind == "text":
            return sum(text_h(b, 10, w) for b in re.split(r"\n\s*\n", c["text"].strip()) if b.strip())
        if kind != "result":
            return 8
        h = text_h(c.get("title") or "", 12, w) + 2
        if c.get("status") != "ok":
            return h + 10
        if (c.get("analysis") or {}).get("result"):
            return 10_000                       # predictive output is long: always give it the full width
        if c.get("show_summary", True):
            h += text_h(c["summary"]["headline"], 10, w) + sum(text_h("•  " + b, 9.5, w) for b in c["summary"]["bullets"][:8]) + 2
        if c.get("show_chart", True):
            n = len(chart_panels(c["columns"], c["rows"], c.get("chart") or {}))
            h += n * (w * (0.58 if w < full - 1 else 0.47 if n == 1 else 0.36) + 5)
        if c.get("show_table", True):
            h += (min(len(c["rows"]), c.get("table_rows") or 25) + 1) * 5.2 + 6
        return h + 5

    def para_at(x, w, text, size=10, style="", color=30, gap_after=2.5):
        pdf.set_font("dv", style, size)
        pdf.set_text_color(color)
        pdf.set_x(x)
        pdf.multi_cell(w, size * 0.52, text, new_x=XPos.LEFT, new_y=YPos.NEXT, align="L")
        pdf.ln(gap_after)

    def draw(c, x, w, narrow):
        kind = c["type"]
        if kind == "heading":
            para_at(x, w, c["text"], 15 if c.get("level") == 1 else 12, "B", 20, 2)
        elif kind == "text":
            for block in re.split(r"\n\s*\n", c["text"].strip()):
                if block.strip():
                    para_at(x, w, block.strip(), 10, "", 40, 2.5)
        elif kind == "result":
            para_at(x, w, c.get("title") or c.get("question") or "Result", 12, "B", 20, 1.5)
            if c.get("status") != "ok":
                para_at(x, w, c.get("message") or "This result is not available.", 9.5, "", 170, 4)
                return
            pa = c.get("analysis") or {}
            hide = set(c.get("hide") or [])
            if pa.get("error"):
                para_at(x, w, "The predictive analysis could not be run: " + pa["error"], 9.5, "", 150, 3)
            elif pa.get("result"):
                r = pa["result"]
                para_at(x, w, f"{r['title']} — {r['method']}", 10.5, "B", 30, 1.5)
                for note in r.get("warnings") or []:
                    para_at(x, w, "Note: " + note, 9, "", 130, 1)
                if "explain" not in hide:
                    para_at(x, w, "   |   ".join(f"{m['label']}: {m['value']}" for m in r["metrics"]), 9.5, "B", 50, 1.5)
                    for bullet in r["narrative"]:
                        para_at(x, w, "•  " + bullet, 9.5, "", 60, 1)
                    pdf.ln(2)
                if "chart" not in hide:
                    for plot in r["plots"]:
                        h = w * 0.45
                        if not narrow and pdf.get_y() + h + 8 > pdf.h - 18:
                            pdf.add_page()
                        para_at(x, w, plot["title"], 9.5, "B", 60, 0.5)
                        pdf.image(io.BytesIO(draw_plot(plot)), x=x, y=pdf.get_y(), w=w, h=h, keep_aspect_ratio=True)
                        pdf.set_y(pdf.get_y() + h + 3)
                for key, group in (("table", r["tables"]), ("stats", r["stats"])):
                    if key in hide:
                        continue
                    for t in group:
                        cols = t["columns"][:9 if not narrow else max(2, int(w // 22))]
                        para_at(x, w, t["title"] + (f" (first 25 of {t['row_count']:,} rows)" if t["row_count"] > 25 else ""), 9.5, "B", 60, 0.5)
                        pdf.set_font("dv", "", 7.5)
                        pdf.set_text_color(40)
                        pdf.set_draw_color(225)
                        saved = pdf.l_margin
                        pdf.set_left_margin(x)
                        pdf.set_x(x)
                        with pdf.table(headings_style=FontFace(emphasis="BOLD", color=255, fill_color=(42, 120, 214)), line_height=5,
                                       cell_fill_color=(246, 246, 244), cell_fill_mode="ROWS", width=w, align="LEFT",
                                       text_align=["RIGHT" if k["type"] == "number" else "LEFT" for k in cols],
                                       borders_layout="HORIZONTAL_LINES") as table:
                            table.row([k["name"][:28] for k in cols])
                            for row in t["rows"][:25]:
                                table.row([_fmt_cell(v, cols[i]["type"] == "number")[:60] for i, v in enumerate(row[:len(cols)])])
                        pdf.set_left_margin(saved)
                        pdf.ln(3)
                if "code" not in hide:
                    para_at(x, w, "Code that produced this (Python)", 9.5, "B", 60, 0.5)
                    pdf.set_font("dvm", "", 6.3)
                    pdf.set_text_color(60)
                    pdf.set_x(x)
                    pdf.multi_cell(w, 3.1, r["code"], new_x=XPos.LEFT, new_y=YPos.NEXT, align="L")
                    pdf.ln(3)
                para_at(x, w, "Data used", 10.5, "B", 30, 1.5)
            if c.get("show_summary", True):
                para_at(x, w, c["summary"]["headline"], 10, "", 40, 1.5)
                for bullet in c["summary"]["bullets"][:8]:
                    para_at(x, w, "•  " + bullet, 9.5, "", 60, 1)
                pdf.ln(2)
            if c.get("show_chart", True):
                panels = chart_panels(c["columns"], c["rows"], c.get("chart") or {})
                for p in panels:
                    png = draw_panel(p, tall=len(panels) == 1, narrow=narrow)
                    if not png:
                        continue
                    h = w * (0.58 if narrow else 0.47 if len(panels) == 1 else 0.36)
                    if not narrow and pdf.get_y() + h > pdf.h - 18:
                        pdf.add_page()
                    if len(panels) > 1:
                        para_at(x, w, p.get("y_title", ""), 9.5, "B", 60, 0.5)
                    pdf.image(io.BytesIO(png), x=x, y=pdf.get_y(), w=w, h=h, keep_aspect_ratio=True)
                    pdf.set_y(pdf.get_y() + h + 3)
            if c.get("show_table", True) and c["rows"]:
                cols = c["columns"][:9 if not narrow else max(2, int(w // 22))]
                limit = c.get("table_rows") or 25
                pdf.set_font("dv", "", 7.5 if not narrow else 7)
                pdf.set_text_color(40)
                pdf.set_draw_color(225)
                head = FontFace(emphasis="BOLD", color=255, fill_color=(42, 120, 214))
                pdf.set_x(x)
                saved = pdf.l_margin
                pdf.set_left_margin(x)
                with pdf.table(headings_style=head, line_height=5, cell_fill_color=(246, 246, 244), cell_fill_mode="ROWS",
                               text_align=["RIGHT" if k["type"] == "number" else "LEFT" for k in cols], width=w,
                               align="LEFT", borders_layout="HORIZONTAL_LINES") as table:
                    table.row([k["name"][:28] for k in cols])
                    for r in c["rows"][:limit]:
                        table.row([_fmt_cell(v, cols[i]["type"] == "number")[:60 if not narrow else 22] for i, v in enumerate(r[:len(cols)])])
                pdf.set_left_margin(saved)
                notes = []
                if c["row_count"] > limit:
                    notes.append(f"First {limit} of {c['row_count']:,} rows shown.")
                if len(c["columns"]) > len(cols):
                    notes.append(f"First {len(cols)} of {len(c['columns'])} columns shown.")
                if c.get("truncated"):
                    notes.append("Row limit reached; more rows exist in the source.")
                if notes:
                    pdf.ln(1)
                    para_at(x, w, " ".join(notes), 7.5, "", 130, 1)
            pdf.ln(5)

    usable = pdf.h - 16 - 24
    for row in layout_rows(rendered["components"]):
        first = row[0]
        if first["type"] == "pagebreak":
            pdf.add_page()
            continue
        if first["type"] == "divider":
            pdf.ln(2)
            pdf.set_draw_color(215)
            pdf.line(pdf.l_margin, pdf.get_y(), pdf.w - pdf.r_margin, pdf.get_y())
            pdf.ln(5)
            continue
        widths = [(full + gap) * int(c.get("width") or 6) / 6 - gap for c in row]
        heights = [estimate(c, w) for c, w in zip(row, widths)]
        if len(row) == 1 and widths[0] >= full - 1:
            if first["type"] in ("heading", "result") and pdf.get_y() > pdf.h - (45 if first["type"] == "heading" else 60):
                pdf.add_page()
            draw(first, pdf.l_margin, full, False)
            continue
        if max(heights) > usable:                      # too tall to sit side by side: stack full width instead
            for c in row:
                draw(c, pdf.l_margin, full, False)
            continue
        if pdf.get_y() + max(heights) > pdf.h - 18:
            pdf.add_page()
        top, x, bottom = pdf.get_y(), pdf.l_margin, pdf.get_y()
        pdf.set_auto_page_break(False)
        for c, w in zip(row, widths):
            pdf.set_y(top)
            draw(c, x, w, True)
            bottom = max(bottom, pdf.get_y())
            x += w + gap
        pdf.set_auto_page_break(True, margin=16)
        pdf.set_y(min(bottom, pdf.h - 18))
    return bytes(pdf.output())


# ---- schedules ------------------------------------------------------------------------------
def next_run(schedule: dict | None, after: dt.datetime | None = None) -> dt.datetime | None:
    """Next firing time (naive UTC) after `after`."""
    if not schedule or not schedule.get("enabled"):
        return None
    try:
        tz = ZoneInfo(schedule.get("tz") or "UTC")
    except Exception:
        tz = ZoneInfo("UTC")
    hh, mm = (int(x) for x in (schedule.get("time") or "08:00").split(":")[:2])
    local = (after or now()).replace(tzinfo=dt.timezone.utc).astimezone(tz)
    cand = local.replace(hour=hh, minute=mm, second=0, microsecond=0)
    freq = schedule.get("frequency", "daily")
    for _ in range(400):
        ok = cand > local and (
            freq == "daily"
            or (freq == "weekdays" and cand.weekday() < 5)
            or (freq == "weekly" and cand.weekday() == int(schedule.get("weekday", 0)))
            or (freq == "monthly" and cand.day == min(max(int(schedule.get("monthday", 1)), 1), 28)))
        if ok:
            return cand.astimezone(dt.timezone.utc).replace(tzinfo=None)
        cand += dt.timedelta(days=1)
    return None


def snapshot_path(report_id: int, snapshot_id: int):
    folder = config.REPORTS_DIR / str(report_id)
    folder.mkdir(parents=True, exist_ok=True)
    return folder / f"{snapshot_id}.pdf"


def make_snapshot(db, report: Report, trigger: str, send: bool) -> ReportSnapshot:
    """Render as the owner and save the PDF. When sending: every recipient who has an account gets
    a PDF rendered with their own data access; other addresses get the owner's copy."""
    owner = db.get(User, report.owner_id)
    snap = ReportSnapshot(report_id=report.id, trigger=trigger)
    db.add(snap)
    db.flush()
    try:
        if not owner or not owner.is_active:
            raise RuntimeError("The report's owner account is disabled.")
        rendered = render(db, report, owner)
        pdf = build_pdf(rendered)
        snapshot_path(report.id, snap.id).write_bytes(pdf)
        stamp = dt.datetime.now().strftime("%Y-%m-%d")
        snap.file_name = re.sub(r"[^\w\- ]", "", report.title).strip()[:60] + f" {stamp}.pdf"
        notes = []
        failed = [c for c in rendered["components"] if c["type"] == "result" and c.get("status") != "ok"]
        if failed:
            notes.append(f"{len(failed)} result(s) could not be refreshed.")
        users, extra = recipients(db, report)
        if send and (users or extra):
            cfg = get_settings(db)
            sender = mailer.pick_sender(db, (report.schedule or {}).get("sender_id"))
            link = f"\n\nOpen the live report: {cfg['public_url'].rstrip('/')}/#/reports/{report.id}" if cfg.get("public_url") else ""
            subject = f"{report.title} - {dt.datetime.now().strftime('%d %b %Y')}"
            body = (f"The scheduled report \"{report.title}\" is attached.{link}\n\n"
                    f"Sent by {config.APP_NAME} on behalf of {owner.name or owner.email}.")
            sent, problems, simulated = [], [], False
            jobs = [([u.email], u) for u in users] + ([(extra, None)] if extra else [])
            for to, person in jobs:
                try:
                    attachment = pdf if person is None or person.id == owner.id else build_pdf(render(db, report, person))
                    how = mailer.send(db, sender, to, subject, body, (snap.file_name, attachment), context=f"report: {report.title}")
                    simulated = simulated or how == "simulated"
                    sent += to
                except mailer.MailError as e:
                    problems.append(str(e))
                    if sender is None:
                        break
            snap.emailed_to = sent
            if simulated:
                notes.append("Sender is in simulation mode - nothing was actually emailed.")
            if problems:
                notes.append("Not emailed to everyone: " + problems[0])
        snap.note = " ".join(notes)
    except Exception as e:      # a broken report must not stop the scheduler
        log.exception("Report %s snapshot failed", report.id)
        snap.status, snap.note = "error", str(e)[:500]
    # keep the 30 most recent snapshots per report
    old = list(db.scalars(select(ReportSnapshot).where(ReportSnapshot.report_id == report.id)
                          .order_by(ReportSnapshot.id.desc()).offset(30)))
    for o in old:
        snapshot_path(report.id, o.id).unlink(missing_ok=True)
        db.delete(o)
    return snap


def run_due(limit: int = 5) -> int:
    """Fire every schedule that is due. Safe with several app instances: a report is claimed
    by moving next_run_at forward in a single conditional UPDATE."""
    fired = 0
    with SessionLocal() as db:
        due = list(db.scalars(select(Report).where(Report.next_run_at.is_not(None), Report.next_run_at <= now()).limit(limit)))
        for report in due:
            nxt = next_run(report.schedule, now())
            claimed = db.execute(update(Report).where(Report.id == report.id, Report.next_run_at == report.next_run_at)
                                 .values(next_run_at=nxt)).rowcount
            db.commit()
            if not claimed:
                continue
            db.refresh(report)
            make_snapshot(db, report, "schedule", send=True)
            db.commit()
            fired += 1
    return fired


def start_scheduler() -> threading.Event:
    stop = threading.Event()

    def loop():
        while not stop.wait(30):
            try:
                run_due()
            except Exception:
                log.exception("Report scheduler tick failed")
    threading.Thread(target=loop, name="report-scheduler", daemon=True).start()
    return stop
