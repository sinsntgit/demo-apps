"""Server-side documents: diagrams as PNG (matplotlib), the PDF handbook (fpdf2) and the PowerPoint deck
(python-pptx). Diagrams are drawn from the same specs the browser uses (layout.py)."""
import io
import os
from datetime import datetime

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt                                    # noqa: E402
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch     # noqa: E402
from matplotlib.path import Path                                   # noqa: E402

from . import config, layout, onto                                 # noqa: E402

# module colours (fill, border) - the browser uses the same order in app.css (.g0 ... .g8)
PALETTE = [("#e3eefc", "#2a78d6"), ("#e2f4ea", "#1a7f4b"), ("#fbf0d6", "#9a6400"), ("#f1e8fb", "#6b3fc4"), ("#fde8e4", "#c0362c"),
           ("#e0f4f6", "#0e7c86"), ("#fbe7f2", "#b0347c"), ("#ecefd9", "#5c6b12"), ("#e9e9ee", "#4a4a68")]
INK, MUTED, ACCENT = "#16160f", "#6b6a63", "#2a78d6"
FONT_DIR = os.path.join(os.path.dirname(matplotlib.__file__), "mpl-data", "fonts", "ttf")


def _clip(ax, ay, bx, by, w, h):
    """Point where the segment from the centre of a box (ax, ay, w, h) towards (bx, by) leaves the box."""
    dx, dy = bx - ax, by - ay
    if not dx and not dy:
        return ax, ay
    t = min((w / 2) / abs(dx) if dx else 9e9, (h / 2) / abs(dy) if dy else 9e9)
    return ax + dx * t, ay + dy * t


def draw(spec: dict, max_px: int = 2600) -> bytes:
    """Diagram spec -> PNG."""
    W, H = max(spec["width"], 120), max(spec["height"], 60)
    dpi = max(60, min(170, int(max_px / max(W, H) * 100)))
    fig = plt.figure(figsize=(W / 100, H / 100), dpi=dpi)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, W); ax.set_ylim(H, 0); ax.axis("off")
    nodes = {n["id"]: n for n in spec["nodes"]}
    for e in spec["edges"]:
        a, b = nodes[e["a"]], nodes[e["b"]]
        if spec["kind"] == "hierarchy":
            x1, x2 = a["x"] + a["w"] / 2, b["x"] - b["w"] / 2
            mid = x1 + 18
            ax.plot([x1, mid, mid, x2], [a["y"], a["y"], b["y"], b["y"]], color="#b9b8b0", lw=0.9, solid_capstyle="round", zorder=1)
            continue
        gap, sub = e["style"].startswith("gap"), e["style"].endswith("sub")
        if sub:                                       # "is a kind of": arrow points at the parent
            a, b = b, a
        color = "#c77700" if gap else "#9a9990" if sub else "#55544e"
        if "cx" in e:                                 # bowed link: quadratic curve through a control point
            c2 = (2 * e["cx"] - (a["x"] + b["x"]) / 2, e["cy"])
            p1, p2 = _clip(a["x"], a["y"], c2[0], c2[1], a["w"], a["h"]), _clip(b["x"], b["y"], c2[0], c2[1], b["w"], b["h"])
            path = Path([p1, c2, p2], [Path.MOVETO, Path.CURVE3, Path.CURVE3])
            lx, ly = (p1[0] + 2 * c2[0] + p2[0]) / 4, (p1[1] + 2 * c2[1] + p2[1]) / 4
        else:
            p1, p2 = _clip(a["x"], a["y"], b["x"], b["y"], a["w"], a["h"]), _clip(b["x"], b["y"], a["x"], a["y"], b["w"], b["h"])
            path = Path([p1, p2], [Path.MOVETO, Path.LINETO])
            lx, ly = (p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2
        ax.add_patch(FancyArrowPatch(path=path, arrowstyle="-|>", mutation_scale=9, lw=1, color=color, fill=False,
                                     linestyle=(0, (4, 3)) if gap or sub else "solid", zorder=1))
        if e["label"]:
            ax.text(lx, ly, e["label"], ha="center", va="center", fontsize=6.4, color=color, zorder=3,
                    bbox=dict(boxstyle="round,pad=0.2", fc="white", ec="none", alpha=0.92))
    for n in spec["nodes"]:
        fill, edge = PALETTE[n["group"] % len(PALETTE)] if n["group"] >= 0 else ("#16160f", "#16160f")
        style = n["style"]
        if style == "gap":
            fill, edge = "#fff7e8", "#c77700"
        elif style == "dim":
            fill, edge = "#f3f2ee", "#b9b8b0"
        ax.add_patch(FancyBboxPatch((n["x"] - n["w"] / 2 + 3, n["y"] - n["h"] / 2 + 3), n["w"] - 6, n["h"] - 6,
                                    boxstyle="round,pad=3,rounding_size=6", fc=fill, ec="#1a7f4b" if style == "hit" else edge,
                                    lw=2 if style == "hit" else 1, linestyle=(0, (4, 3)) if style == "gap" else "solid", zorder=2))
        top = n["y"] - n["h"] / 2 + 15 if n["attrs"] else n["y"]
        color = "white" if style == "root" else MUTED if style == "dim" else INK
        ax.text(n["x"] - (n["w"] / 2 - 10 if n["sub"] else 0), top, n["label"], ha="left" if n["sub"] else "center", va="center",
                fontsize=7.2, fontweight="bold", color=color, zorder=4)
        if n["sub"]:
            ax.text(n["x"] + n["w"] / 2 - 9, top, n["sub"], ha="right", va="center", fontsize=5.8, color=MUTED, zorder=4)
        for i, a in enumerate(n["attrs"]):
            ax.text(n["x"] - n["w"] / 2 + 10, top + 16 + i * 15, a, ha="left", va="center", fontsize=6.2,
                    color="#c77700" if a.startswith("+") else "#55544e", zorder=4)
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=dpi)
    plt.close(fig)
    return buf.getvalue()


def _size(spec):
    return max(spec["width"], 120), max(spec["height"], 60)


def coverage_bar(counts: dict, w_in: float = 6.0) -> bytes:
    total = sum(counts.values()) or 1
    fig = plt.figure(figsize=(w_in, 0.55), dpi=160)
    ax = fig.add_axes([0, 0.1, 1, 0.8]); ax.axis("off"); ax.set_xlim(0, 1); ax.set_ylim(0, 1)
    x = 0
    for key, col in (("covered", "#1a7f4b"), ("partial", "#d99a1c"), ("missing", "#c0362c")):
        w = counts[key] / total
        if w:
            ax.add_patch(plt.Rectangle((x, 0), w - 0.004, 1, color=col))
            ax.text(x + w / 2, 0.5, f"{counts[key]} {key}", ha="center", va="center", color="white", fontsize=8, fontweight="bold")
        x += w
    buf = io.BytesIO(); fig.savefig(buf, format="png"); plt.close(fig)
    return buf.getvalue()


VERDICT = {"addressed": "Addressed", "partly": "Partly addressed", "not_addressed": "Not addressed"}


# ---- PDF ----------------------------------------------------------------------------------------
def build_pdf(o, c: dict, tests: list) -> bytes:
    from fpdf import FPDF
    from fpdf.enums import XPos, YPos
    from fpdf.fonts import FontFace

    class Doc(FPDF):
        def header(self):
            if self.page_no() > 1:
                self.set_font("dv", "", 8); self.set_text_color(138, 137, 130)
                self.cell(0, 6, f"{c['meta']['name']}  ·  version {o.version}", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
                self.ln(2)

        def footer(self):
            self.set_y(-12); self.set_font("dv", "", 8); self.set_text_color(138, 137, 130)
            self.cell(0, 6, f"{config.APP_NAME}  ·  page {self.page_no()}", align="C")

    pdf = Doc(format="A4")
    pdf.set_margins(16, 14, 16); pdf.set_auto_page_break(True, 16)
    for style, f in (("", "DejaVuSans.ttf"), ("B", "DejaVuSans-Bold.ttf"), ("I", "DejaVuSans-Oblique.ttf")):
        pdf.add_font("dv", style, os.path.join(FONT_DIR, f))
    pdf.add_font("dvm", "", os.path.join(FONT_DIR, "DejaVuSansMono.ttf"))
    width = pdf.w - 32

    def h1(t):
        pdf.add_page(); pdf.set_font("dv", "B", 17); pdf.set_text_color(22, 22, 15)
        pdf.multi_cell(0, 9, t, new_x=XPos.LMARGIN, new_y=YPos.NEXT); pdf.ln(2)

    def h2(t):
        if pdf.get_y() > pdf.h - 45:
            pdf.add_page()
        pdf.ln(3); pdf.set_font("dv", "B", 12); pdf.set_text_color(22, 22, 15)
        pdf.multi_cell(0, 7, t, new_x=XPos.LMARGIN, new_y=YPos.NEXT); pdf.ln(1)

    def para(t, size=9.5, style="", color=(40, 40, 34), font="dv", lh=5):
        if not t:
            return
        pdf.set_font(font, style, size); pdf.set_text_color(*color)
        pdf.multi_cell(0, lh, t, new_x=XPos.LMARGIN, new_y=YPos.NEXT); pdf.ln(1.5)

    def bullets(items):
        pdf.set_font("dv", "", 9.5); pdf.set_text_color(40, 40, 34)
        for it in items:
            pdf.set_x(18); pdf.multi_cell(width - 2, 5, "•  " + it, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        pdf.ln(1.5)

    def table(head, rows, widths, size=7.8):
        if not rows:
            return
        pdf.set_font("dv", "", size); pdf.set_text_color(40, 40, 34); pdf.set_draw_color(215, 214, 208)
        with pdf.table(col_widths=widths, line_height=4.3, text_align="LEFT", padding=1.2, borders_layout="HORIZONTAL_LINES",
                       headings_style=FontFace(emphasis="BOLD", fill_color=(243, 242, 238), color=(60, 60, 54)), width=width) as t:
            t.row(head)
            for r in rows:
                t.row([str(x) for x in r])
        pdf.ln(3)

    def picture(spec, max_h=235):
        w, h = _size(spec)
        mm_w = min(width, w * 0.2)                     # never blow a small diagram up to full width
        mm_h = mm_w * h / w
        if mm_h > max_h:
            mm_h, mm_w = max_h, max_h * w / h
        if pdf.get_y() + mm_h > pdf.h - 18:
            pdf.add_page()
        pdf.image(io.BytesIO(draw(spec)), x=16 + (width - mm_w) / 2, w=mm_w, h=mm_h)
        pdf.ln(3)

    ix, st, ex = onto.index(c), onto.stats(c), c["explanation"]
    mods = {m["id"]: m for m in c["modules"]}
    # cover
    pdf.add_page(); pdf.ln(48)
    pdf.set_font("dv", "", 11); pdf.set_text_color(*[int(ACCENT[i:i + 2], 16) for i in (1, 3, 5)])
    pdf.cell(0, 7, "ONTOLOGY HANDBOOK", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.set_font("dv", "B", 26); pdf.set_text_color(22, 22, 15)
    pdf.multi_cell(0, 12, c["meta"]["name"], new_x=XPos.LMARGIN, new_y=YPos.NEXT); pdf.ln(3)
    para(f"Domain: {c['meta']['domain']}", 11)
    para(f"Version {o.version}  ·  {datetime.now():%d %B %Y}  ·  owner {o.owner_email or '-'}", 9.5, color=(107, 106, 99))
    pdf.ln(6)
    table(["Modules", "Classes", "Relationships", "Attributes", "Controlled values", "Rules", "Use cases", "Standards"],
          [[st["modules"], st["classes"], st["object_properties"], st["data_properties"], st["individuals"], st["rules"], st["use_cases"], st["standards"]]],
          (1,) * 8, 9)
    para(f"Namespace: {c['meta']['namespace']}", 8.5, font="dvm", color=(107, 106, 99))

    h1("1  What this ontology is")
    para(ex.get("summary"))
    if ex.get("purpose"):
        h2("Purpose"); para(ex["purpose"])
    h2("Scope"); para(c["meta"]["scope"])
    if ex.get("scope_in"):
        para("Covered", style="B"); bullets(ex["scope_in"])
    if ex.get("scope_out"):
        para("Not covered", style="B"); bullets(ex["scope_out"])
    if ex.get("how_to_read"):
        h2("How to read the model"); para(ex["how_to_read"])
    if ex.get("design_decisions"):
        h2("Design decisions")
        for d in ex["design_decisions"]:
            para(d["title"], style="B"); para(d["text"])

    h1("2  Industry standards it builds on")
    para(ex.get("standards_approach"))
    para("Standards are taken from the built-in catalogue or proposed by the AI model. Confirm links and reused terms "
         "against the publisher's documentation before publishing.", 8.5, "I", (107, 106, 99))
    for s in c["standards"]:
        h2(f"{s['name']}  ({s['relevance']} relevance)")
        para(" · ".join(x for x in (s["publisher"], s["kind"], s["url"]) if x), 8.5, color=(107, 106, 99))
        para(s["how_used"])
        if s["reused_terms"]:
            para("Terms reused or aligned: " + ", ".join(s["reused_terms"]), 8.5, font="dvm", lh=4.5)
    aligned = [[k["label"], k["aligned_to"], k["alignment"]] for k in c["classes"] if k["aligned_to"]]
    if aligned:
        h2("Class alignment"); table(["Class", "Aligned to", "How"], aligned, (3, 3, 1.6))

    h1("3  Conceptual diagram")
    para("The class hierarchy. Each box is a class, coloured by module; a line reads \"is a kind of\" from right to left.")
    big = st["classes"] > 45
    picture(layout.hierarchy(c, max_depth=2 if big else None))
    if c["modules"]:
        para("Modules: " + "   ".join(f"■ {m['name']}" for m in c["modules"]), 8.5, color=(107, 106, 99))

    h1("4  Modules, classes and relationships")
    for m in c["modules"]:
        h2(m["name"])
        para(ex.get("module_notes", {}).get(m["id"]) or m["description"])
        own = [k for k in c["classes"] if k["module"] == m["id"]]
        if big and len(own) > 1:
            picture(layout.hierarchy(c, module=m["id"]), 120)
        spec = layout.module_map(c, m["id"])
        if spec["edges"]:
            para("Relationships of this module (grey boxes belong to other modules):", 8.5, "I", (107, 106, 99))
            picture(spec, 130)
        table(["Class", "Kind of", "Definition", "Aligned to"],
              [[k["label"], ix["classes"][k["parent"]]["label"] if k["parent"] else "-", k["definition"], k["aligned_to"] or "-"] for k in own],
              (2.2, 1.7, 6, 2))
        props = [p for p in c["properties"] if p["domain"] in {k["id"] for k in own}]
        table(["Property", "On class", "Points to / type", "Card.", "Meaning"],
              [[p["label"], ix["classes"][p["domain"]]["label"], ix["classes"][p["range"]]["label"] if p["kind"] == "object" else p["range"],
                p["cardinality"], p["definition"]] for p in props], (2.2, 2, 2.2, 1, 5))
    if c["individuals"]:
        h2("Controlled values")
        by: dict = {}
        for i in c["individuals"]:
            by.setdefault(i["type"], []).append(i)
        table(["List", "Values"], [[ix["classes"][t]["label"], ", ".join(i["label"] for i in v)] for t, v in by.items()], (2.5, 9))
    if c["rules"]:
        h2("Rules"); table(["#", "Rule", "Kind"], [[r["id"], r["statement"], r["kind"]] for r in c["rules"]], (0.8, 9, 1.6))

    if c["use_cases"]:
        h1("5  Use cases the ontology answers")
        for u in c["use_cases"]:
            h2(f"{u['id']}  {u['title']}")
            para(f"{u['actor']} asks: “{u['question']}”" if u["actor"] else u["question"], style="I")
            para(u["description"])
            if u["classes"]:
                picture(layout.use_case(c, u), 85)
            if u["answer_path"]:
                para("How the ontology answers it", style="B"); bullets(u["answer_path"])
            if u["sparql"]:
                para(u["sparql"], 7.6, font="dvm", lh=4)
            if u["sample_answer"]:
                para("Example answer: " + u["sample_answer"], 8.8, color=(107, 106, 99))

    q = onto.quality(c)
    h1("6  Quality check")
    para(f"Quality score {q['score']} / 100. Automatic checks for the common modelling pitfalls; 'low' findings are suggestions.")
    table(["Severity", "Finding", "Count", "Where", "Advice"],
          [[f["severity"], f["title"], f["count"], ", ".join(f["items"][:8]) + (" …" if f["count"] > 8 else ""), f["advice"]] for f in q["findings"]],
          (1.2, 2.8, 0.9, 3.4, 4.2))
    if not q["findings"]:
        para("No findings.")

    if tests:
        h1("7  Test bed results")
        para("Use cases entered in the test bed and how far this ontology addresses them. Scores are computed by the "
             "application from requirement-by-requirement checks; each cited element was verified to exist.")
        table(["Use case", "Version", "Coverage", "Verdict", "Covered / partial / missing"],
              [[t.result.get("title") or t.text[:80], t.version, f"{t.score:.0%}", VERDICT.get(t.verdict, ""),
                "{covered} / {partial} / {missing}".format(**t.result["counts"])] for t in tests], (5, 1, 1.2, 1.8, 2.4))
        for t in tests[:6]:
            r = t.result
            h2(r.get("title") or t.text[:90])
            para(t.text, style="I"); para(r["summary"])
            pdf.image(io.BytesIO(coverage_bar(r["counts"])), w=120); pdf.ln(2)
            table(["Requirement", "Type", "Status", "Evidence in the ontology", "Note"],
                  [[x["text"], x["kind"], x["status"], ", ".join(m["id"] for m in x["mapped"]) or "-", x["check"] or x["note"]] for x in r["requirements"]],
                  (3.4, 1.3, 1.1, 2.4, 4))
            if r["gaps"]:
                para("Gaps", style="B"); bullets([g["text"] + (f" — {g['impact']}" if g["impact"] else "") for g in r["gaps"]])
    return bytes(pdf.output())


# ---- PowerPoint ---------------------------------------------------------------------------------
def build_pptx(o, c: dict, tests: list) -> bytes:
    from pptx import Presentation
    from pptx.dml.color import RGBColor
    from pptx.util import Emu, Inches, Pt

    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
    blank = prs.slide_layouts[6]
    ink, muted, accent = RGBColor(0x16, 0x16, 0x0F), RGBColor(0x6B, 0x6A, 0x63), RGBColor(0x2A, 0x78, 0xD6)
    ix, st, ex = onto.index(c), onto.stats(c), c["explanation"]

    def text(slide, x, y, w, h, content, size=14, bold=False, color=ink, bullet=False, mono=False):
        tb = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
        tf = tb.text_frame; tf.word_wrap = True
        items = content if isinstance(content, list) else [content]
        for i, it in enumerate([x for x in items if x]):
            p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            run = p.add_run(); run.text = ("•  " if bullet else "") + str(it)
            run.font.size, run.font.bold, run.font.color.rgb = Pt(size), bold, color
            if mono:
                run.font.name = "Consolas"
            p.space_after = Pt(6 if bullet else 4)
        return tb

    def slide(title, kicker=""):
        s = prs.slides.add_slide(blank)
        bar = s.shapes.add_shape(1, 0, 0, prs.slide_width, Inches(0.12)); bar.fill.solid(); bar.fill.fore_color.rgb = accent; bar.line.fill.background()
        if kicker:
            text(s, 0.6, 0.35, 12, 0.3, kicker.upper(), 10, True, accent)
        text(s, 0.6, 0.6, 12.1, 0.8, title, 26, True)
        text(s, 0.6, 7.05, 12.1, 0.3, f"{c['meta']['name']}  ·  v{o.version}  ·  {config.APP_NAME}", 9, color=muted)
        return s

    def picture(s, spec, x, y, w, h):
        pw, ph = _size(spec)
        scale = min(w / pw, h / ph, 0.011)                # inches per diagram pixel; small diagrams are not blown up
        iw, ih = pw * scale, ph * scale
        s.shapes.add_picture(io.BytesIO(draw(spec)), Inches(x + (w - iw) / 2), Inches(y + (h - ih) / 2), Inches(iw), Inches(ih))

    def table(s, x, y, w, head, rows, widths, size=10, row_h=0.32):
        shape = s.shapes.add_table(len(rows) + 1, len(head), Inches(x), Inches(y), Inches(w), Inches(row_h * (len(rows) + 1)))
        t = shape.table
        total = sum(widths)
        for i, cw in enumerate(widths):
            t.columns[i].width = Emu(int(Inches(w) * cw / total))
        for r, row in enumerate([head] + rows):
            for i, v in enumerate(row):
                cell = t.cell(r, i); cell.text = str(v)
                for p in cell.text_frame.paragraphs:
                    for run in p.runs:
                        run.font.size, run.font.bold = Pt(size), r == 0
        return t

    def clip(t, n):
        t = " ".join(str(t).split())
        return t if len(t) <= n else t[:n - 1].rsplit(" ", 1)[0] + "…"

    # 1 title
    s = prs.slides.add_slide(blank)
    bg = s.shapes.add_shape(1, 0, 0, prs.slide_width, prs.slide_height); bg.fill.solid(); bg.fill.fore_color.rgb = RGBColor(0x12, 0x2B, 0x4A); bg.line.fill.background()
    white = RGBColor(0xFF, 0xFF, 0xFF)
    text(s, 0.8, 2.3, 11.7, 0.4, "ONTOLOGY OVERVIEW", 14, True, RGBColor(0x9C, 0xC4, 0xF5))
    text(s, 0.8, 2.8, 11.7, 1.6, c["meta"]["name"], 44, True, white)
    text(s, 0.8, 4.6, 11.7, 0.5, f"Domain: {c['meta']['domain']}", 18, color=white)
    text(s, 0.8, 5.2, 11.7, 0.5, f"Version {o.version}  ·  {datetime.now():%d %B %Y}", 14, color=RGBColor(0xC8, 0xD6, 0xE8))
    # 2 purpose & scope
    s = slide("What it is and what it covers", "Purpose and scope")
    text(s, 0.6, 1.6, 6.1, 5.2, [clip(ex.get("summary") or c["meta"]["scope"], 620), clip(ex.get("purpose", ""), 420)], 15)
    text(s, 7.1, 1.6, 5.6, 0.4, "In scope", 14, True, accent)
    text(s, 7.1, 2.0, 5.6, 2.4, [clip(x, 110) for x in (ex.get("scope_in") or [clip(c["meta"]["scope"], 300)])[:6]], 12.5, bullet=True)
    if ex.get("scope_out"):
        text(s, 7.1, 4.5, 5.6, 0.4, "Out of scope", 14, True, muted)
        text(s, 7.1, 4.9, 5.6, 2, [clip(x, 110) for x in ex["scope_out"][:5]], 12.5, color=muted, bullet=True)
    # 3 at a glance
    s = slide("The ontology at a glance", "Size and shape")
    for i, (label, val) in enumerate([("Modules", st["modules"]), ("Classes", st["classes"]), ("Relationships", st["object_properties"]),
                                      ("Attributes", st["data_properties"]), ("Controlled values", st["individuals"]), ("Use cases", st["use_cases"])]):
        x = 0.6 + i * 2.05
        box = s.shapes.add_shape(5, Inches(x), Inches(1.6), Inches(1.9), Inches(1.25)); box.fill.solid(); box.fill.fore_color.rgb = RGBColor(0xE6, 0xF0, 0xFC); box.line.fill.background()
        text(s, x, 1.68, 1.9, 0.7, str(val), 30, True, accent).text_frame.paragraphs[0].alignment = 2
        text(s, x, 2.38, 1.9, 0.4, label, 11, color=muted).text_frame.paragraphs[0].alignment = 2
    table(s, 0.6, 3.2, 12.1, ["Module", "Classes", "What it holds"],
          [[m["name"], sum(k["module"] == m["id"] for k in c["classes"]), clip(m["description"] or ex.get("module_notes", {}).get(m["id"], ""), 150)] for m in c["modules"][:9]],
          (2.5, 1, 8.6), 11, 0.36)
    # 4 standards
    s = slide("Built on industry standards", "Standards research")
    table(s, 0.6, 1.6, 12.1, ["Standard", "Publisher", "Relevance", "How it is used", "Terms reused"],
          [[x["name"], clip(x["publisher"], 40), x["relevance"], clip(x["how_used"], 170), clip(", ".join(x["reused_terms"][:6]), 90)] for x in c["standards"][:7]],
          (2.3, 1.8, 1, 4.4, 2.6), 10, 0.55)
    text(s, 0.6, 6.6, 12.1, 0.4, f"{st['aligned_classes']} of {st['classes']} classes are aligned to a published term. Verify links against the publishers' documentation before publishing.", 10.5, color=muted)
    # 5 hierarchy
    s = slide("Conceptual model: the class hierarchy", "Diagram")
    picture(s, layout.hierarchy(c, max_depth=2 if st["classes"] > 40 else None), 0.5, 1.45, 12.3, 5.2)
    text(s, 0.6, 6.7, 12.1, 0.3, "Colour = module.   " + "   ".join(m["name"] for m in c["modules"][:9]), 9.5, color=muted)
    if ex.get("how_to_read"):
        s = slide("How to read the model", "Walkthrough")
        text(s, 0.6, 1.6, 12.1, 5, clip(ex["how_to_read"], 1500), 16)
    # modules
    for m in c["modules"][:10]:
        own = [k for k in c["classes"] if k["module"] == m["id"]]
        s = slide(m["name"], "Module")
        text(s, 0.6, 1.5, 4.3, 1.9, clip(ex.get("module_notes", {}).get(m["id"]) or m["description"], 430), 12.5)
        text(s, 0.6, 3.5, 4.3, 0.3, "Key classes", 12, True, accent)
        text(s, 0.6, 3.85, 4.3, 3.1, [f"{k['label']} — {clip(k['definition'], 85)}" for k in own[:7]], 10.5, bullet=True)
        spec = layout.module_map(c, m["id"])
        picture(s, spec if spec["edges"] else layout.hierarchy(c, module=m["id"]), 5.1, 1.5, 7.8, 5.3)
    # use cases
    if c["use_cases"]:
        s = slide("Use cases the ontology answers", "Competency questions")
        table(s, 0.6, 1.6, 12.1, ["#", "Use case", "Who asks", "Question"],
              [[u["id"], clip(u["title"], 60), clip(u["actor"], 30), clip(u["question"], 130)] for u in c["use_cases"][:11]], (0.7, 3.2, 2, 6.2), 11, 0.42)
        for u in c["use_cases"][:8]:
            s = slide(u["title"], f"Use case {u['id']}")
            text(s, 0.6, 1.5, 12.1, 0.7, f"“{clip(u['question'], 220)}”" + (f"  — {u['actor']}" if u["actor"] else ""), 15, color=accent)
            text(s, 0.6, 2.3, 4.6, 1.6, clip(u["description"], 330), 12)
            text(s, 0.6, 4.0, 4.6, 0.3, "How the ontology answers it", 12, True)
            text(s, 0.6, 4.35, 4.6, 2.6, [clip(x, 120) for x in u["answer_path"][:5]], 10.5, bullet=True)
            if u["classes"]:
                picture(s, layout.use_case(c, u), 5.4, 2.3, 7.5, 4.5)
    # tests
    if tests:
        s = slide("Test bed: does the ontology address our use cases?", "Validation")
        avg = sum(t.score for t in tests) / len(tests)
        text(s, 0.6, 1.5, 12.1, 0.5, f"{len(tests)} use cases tested  ·  average coverage {avg:.0%}", 16, True, accent)
        table(s, 0.6, 2.2, 12.1, ["Use case", "Coverage", "Verdict", "Covered / partial / missing", "Main gap"],
              [[clip(t.result.get("title") or t.text, 60), f"{t.score:.0%}", VERDICT.get(t.verdict, ""), "{covered} / {partial} / {missing}".format(**t.result["counts"]),
                clip(t.result["gaps"][0]["text"] if t.result["gaps"] else "-", 80)] for t in tests[:9]], (3.6, 1.1, 1.7, 2.3, 3.4), 10.5, 0.42)
        for t in tests[:3]:
            r = t.result
            s = slide(clip(r.get("title") or t.text, 70), f"Test result · {t.score:.0%} coverage · {VERDICT.get(t.verdict, '')}")
            text(s, 0.6, 1.5, 5, 1.9, clip(r["summary"], 430), 12)
            s.shapes.add_picture(io.BytesIO(coverage_bar(r["counts"], 5)), Inches(0.6), Inches(3.5), Inches(5))
            text(s, 0.6, 4.2, 5, 0.3, "Gaps", 12, True)
            text(s, 0.6, 4.55, 5, 2.4, [clip(g["text"], 130) for g in r["gaps"][:5]] or ["None found."], 10.5, bullet=True)
            picture(s, layout.test(c, r), 5.8, 1.5, 7.1, 5.3)
    # quality
    q = onto.quality(c)
    s = slide("Quality check and next steps", "Readiness")
    text(s, 0.6, 1.5, 3, 1, f"{q['score']} / 100", 40, True, accent)
    text(s, 0.6, 2.5, 3, 0.4, "quality score", 12, color=muted)
    table(s, 3.9, 1.6, 8.8, ["Severity", "Finding", "Count"], [[f["severity"], f["title"], f["count"]] for f in q["findings"][:8]] or [["-", "No findings", "0"]],
          (1.2, 6.4, 1), 11, 0.4)
    text(s, 0.6, 5.3, 12.1, 0.3, "Next steps", 13, True)
    text(s, 0.6, 5.65, 12.1, 1.3, ["Confirm definitions and scope with the business owners of each module.",
                                   "Run the remaining use cases through the test bed and close the gaps it reports.",
                                   "Verify standard alignments, then publish the OWL / Turtle export to the systems that will use it."], 11.5, bullet=True)
    buf = io.BytesIO(); prs.save(buf)
    return buf.getvalue()
