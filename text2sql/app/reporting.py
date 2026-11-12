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
from .models import Connection, QueryRun, Report, ReportShare, ReportSnapshot, User
from .summarize import is_additive, is_measure

log = logging.getLogger("text2sql.reports")
MAX_COMPONENTS = 40
COUNT = "__count__"
PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"]
MULTI = ("bar", "hbar", "stacked", "line", "area")


# ---- access ---------------------------------------------------------------------------
def _share(db, user, report) -> ReportShare | None:
    rows = list(db.scalars(select(ReportShare).where(
        ReportShare.report_id == report.id,
        or_((ReportShare.scope == "user") & (ReportShare.user_id == user.id),
            (ReportShare.scope == "role") & (ReportShare.role == user.role)))))
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
    shared = select(ReportShare.report_id).where(
        or_((ReportShare.scope == "user") & (ReportShare.user_id == user.id),
            (ReportShare.scope == "role") & (ReportShare.role == user.role)))
    return list(db.scalars(select(Report).where(or_(Report.owner_id == user.id, Report.id.in_(shared)))
                           .order_by(Report.updated_at.desc())))


# ---- components -----------------------------------------------------------------------
def result_component(run: QueryRun) -> dict:
    return {"id": uuid.uuid4().hex[:10], "type": "result", "run_id": run.id, "connection_id": run.connection_id,
            "sql": run.final_sql, "question": run.question, "title": run.question[:200],
            "show_chart": True, "show_table": True, "show_summary": True, "table_rows": 25,
            "chart": dict(run.chart or {})}


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
            item = {"id": cid, "type": kind, "text": str(c.get("text") or "")[:20000]}
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
                show_summary=bool(c.get("show_summary", True)),
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
                res = engine.run_sql(db, conn, next(x["sql"] for x in report.components if x["id"] == c["id"]), cfg, viewer)
                c.update(status="ok", columns=res["columns"], rows=res["rows"], row_count=len(res["rows"]),
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


def draw_panel(panel: dict, tall: bool = True) -> bytes:
    """One chart panel as PNG bytes."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.ticker import FuncFormatter

    kind = panel["type"]
    fig, ax = plt.subplots(figsize=(9, 4.1 if tall else 3.0), dpi=130)
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

    for c in rendered["components"]:
        kind = c["type"]
        if kind == "pagebreak":
            pdf.add_page()
        elif kind == "divider":
            pdf.ln(2)
            pdf.set_draw_color(215)
            pdf.line(pdf.l_margin, pdf.get_y(), pdf.w - pdf.r_margin, pdf.get_y())
            pdf.ln(5)
        elif kind == "heading":
            if pdf.get_y() > pdf.h - 45:
                pdf.add_page()
            para(c["text"], 15 if c.get("level") == 1 else 12, "B", 20, 2)
        elif kind == "text":
            for block in re.split(r"\n\s*\n", c["text"].strip()):
                if block.strip():
                    para(block.strip(), 10, "", 40, 2.5)
        elif kind == "result":
            if pdf.get_y() > pdf.h - 60:
                pdf.add_page()
            para(c.get("title") or c.get("question") or "Result", 12, "B", 20, 1.5)
            if c.get("status") != "ok":
                para(c.get("message") or "This result is not available.", 9.5, "", 170, 4)
                continue
            if c.get("show_summary", True):
                para(c["summary"]["headline"], 10, "", 40, 1.5)
                for bullet in c["summary"]["bullets"][:8]:
                    para("•  " + bullet, 9.5, "", 60, 1)
                pdf.ln(2)
            if c.get("show_chart", True):
                panels = chart_panels(c["columns"], c["rows"], c.get("chart") or {})
                for p in panels:
                    png = draw_panel(p, tall=len(panels) == 1)
                    if not png:
                        continue
                    h = width * (0.47 if len(panels) == 1 else 0.36)
                    if pdf.get_y() + h > pdf.h - 18:
                        pdf.add_page()
                    if len(panels) > 1:
                        para(p.get("y_title", ""), 9.5, "B", 60, 0.5)
                    pdf.image(io.BytesIO(png), x=pdf.l_margin, w=width, h=h, keep_aspect_ratio=True)
                    pdf.ln(3)
            if c.get("show_table", True) and c["rows"]:
                cols = c["columns"][:9]
                limit = c.get("table_rows") or 25
                pdf.set_font("dv", "", 7.5)
                pdf.set_text_color(40)
                pdf.set_draw_color(225)
                head = FontFace(emphasis="BOLD", color=255, fill_color=(42, 120, 214))
                with pdf.table(headings_style=head, line_height=5, cell_fill_color=(246, 246, 244), cell_fill_mode="ROWS",
                               text_align=["RIGHT" if x["type"] == "number" else "LEFT" for x in cols],
                               borders_layout="HORIZONTAL_LINES") as table:
                    table.row([x["name"][:28] for x in cols])
                    for r in c["rows"][:limit]:
                        table.row([_fmt_cell(v, cols[i]["type"] == "number") for i, v in enumerate(r[:len(cols)])])
                notes = []
                if c["row_count"] > limit:
                    notes.append(f"First {limit} of {c['row_count']:,} rows shown.")
                if len(c["columns"]) > len(cols):
                    notes.append(f"First {len(cols)} of {len(c['columns'])} columns shown.")
                if c.get("truncated"):
                    notes.append("Row limit reached; more rows exist in the source.")
                if notes:
                    pdf.ln(1)
                    para(" ".join(notes), 7.5, "", 130, 1)
            pdf.ln(5)
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
    """Render as the owner, save the PDF, optionally email it."""
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
        failed = [c for c in rendered["components"] if c["type"] == "result" and c.get("status") != "ok"]
        if failed:
            snap.note = f"{len(failed)} result(s) could not be refreshed."
        recipients = [r for r in (report.schedule or {}).get("recipients", []) if "@" in r]
        if send and recipients:
            cfg = get_settings(db)
            link = f"\n\nOpen the live report: {cfg['public_url'].rstrip('/')}/#/reports/{report.id}" if cfg.get("public_url") else ""
            try:
                mailer.send(cfg, recipients, f"{report.title} - {dt.datetime.now().strftime('%d %b %Y')}",
                            f"The scheduled report \"{report.title}\" is attached.{link}\n\n"
                            f"Sent by {config.APP_NAME} on behalf of {owner.name or owner.email}.", (snap.file_name, pdf))
                snap.emailed_to = recipients
            except mailer.MailError as e:
                snap.note = (snap.note + " " if snap.note else "") + f"Saved, but not emailed: {e}"
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
