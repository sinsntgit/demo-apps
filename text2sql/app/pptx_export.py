"""A report as a PowerPoint deck (16:9), laid out to fit: title slide with the company logo, a section slide per
main heading, one slide per result (chart beside its key points), tables split over as many slides as needed,
side-by-side results sharing a slide, predictive output as key figures + charts. Uses the same rendered report
as the PDF (so the viewer's access, filters and results-only setting apply), the same server-side charts.

    build_pptx(rendered, company_name, template_path=None) -> bytes

With a company template (.pptx / .potx uploaded under Companies or Settings) the deck is built on the template:
its slide masters, layouts, theme colours and fonts and slide size; the "Title Slide", "Section Header" and
"Title Only" layouts (or the closest ones) are used and any placeholder left empty is removed.
"""
import io
import re

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE, PP_PLACEHOLDER
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Inches, Pt

from .reporting import _fmt_cell, chart_panels, draw_panel, draw_plot, layout_rows

M = Inches(0.55)                                 # side margin
INK, MUTED, LINE, PALE = RGBColor(0x1F, 0x29, 0x37), RGBColor(0x64, 0x6E, 0x7B), RGBColor(0xDD, 0xE1, 0xE6), RGBColor(0xF4, 0xF6, 0xF8)
MAX_COLS, MAX_TABLE_ROWS = 8, 200


def _brand(logo: str | None) -> RGBColor:
    """The accent colour: the logo's strongest colour, else the app's blue."""
    default = RGBColor(0x2A, 0x78, 0xD6)
    if not logo:
        return default
    try:
        from PIL import Image
        im = Image.open(logo).convert("RGBA").resize((64, 64))
        best, score = None, 0.0
        for r, g, b, a in im.getdata():
            if a < 200:
                continue
            mx, mn = max(r, g, b), min(r, g, b)
            sat = (mx - mn) / mx if mx else 0
            s = sat * (1 - abs(mx / 255 - 0.55))          # saturated, neither too light nor too dark
            if s > score:
                best, score = (r, g, b), s
        return RGBColor(*best) if best and score > 0.2 else default
    except Exception:
        return default


def _theme_accent(prs) -> RGBColor | None:
    """The template theme's first accent colour."""
    try:
        from pptx.opc.constants import RELATIONSHIP_TYPE as RT
        theme = prs.slide_master.part.part_related_by(RT.THEME).blob
        m = re.search(rb'<a:accent1>\s*<a:srgbClr val="([0-9A-Fa-f]{6})"', theme)
        return RGBColor.from_string(m.group(1).decode()) if m else None
    except Exception:
        return None


def _layout(prs, names: tuple, fallback_index: int | None):
    """The template layout with one of these names; else the layout at fallback_index (if it has a title)."""
    for lay in prs.slide_layouts:
        if any(n == (lay.name or "").strip().lower() for n in names):
            return lay
    for lay in prs.slide_layouts:
        if any(n in (lay.name or "").strip().lower() for n in names):
            return lay
    if fallback_index is not None and len(prs.slide_layouts) > fallback_index:
        return prs.slide_layouts[fallback_index]
    return None


def _drop_empty_placeholders(slide):
    for ph in list(slide.placeholders):
        if not (ph.has_text_frame and ph.text_frame.text.strip()):
            ph._element.getparent().remove(ph._element)


def _image_size(data: bytes) -> tuple[int, int]:
    from PIL import Image
    with Image.open(io.BytesIO(data)) as im:
        return im.size


class Deck:
    def __init__(self, rendered: dict, company: str, template: str | None = None):
        self.r, self.company = rendered, company
        self.logo = rendered.get("logo")
        self.template = template
        if template:
            self.prs = Presentation(template)
            for sid in list(self.prs.slides._sldIdLst):                 # keep the masters and layouts, not the sample slides
                self.prs.part.drop_rel(sid.rId)
                self.prs.slides._sldIdLst.remove(sid)
            self.W, self.H = self.prs.slide_width, self.prs.slide_height
            self.font = "+mn-lt"                                         # the template's body font
            self.accent = _theme_accent(self.prs) or _brand(self.logo)
            self.l_title = _layout(self.prs, ("title slide",), 1)
            self.l_section = _layout(self.prs, ("section header", "section"), None)
            self.l_content = _layout(self.prs, ("title only",), 2) or _layout(self.prs, ("title and content",), 2)
            ph = next((p for p in self.l_content.placeholders if p.placeholder_format.type in (PP_PLACEHOLDER.TITLE, PP_PLACEHOLDER.CENTER_TITLE)), None)
            title_bottom = (ph.top + ph.height) if ph is not None and ph.top is not None else Inches(1.2)
            self.TOP = int(min(title_bottom + Inches(0.4), self.H * 0.35))
        else:
            self.prs = Presentation()
            self.W, self.H = Inches(13.333), Inches(7.5)
            self.prs.slide_width, self.prs.slide_height = self.W, self.H
            self.font = "Calibri"
            self.accent = _brand(self.logo)
            self.TOP = Inches(1.35)
        # templates usually carry their own footer band at the bottom: keep clear of it
        self.BOTTOM = self.H - (Inches(0.9) if template else Inches(0.55))
        self.blank = self.prs.slide_layouts[6] if len(self.prs.slide_layouts) > 6 else self.prs.slide_layouts[-1]
        self.kicker = ""                         # a level-2 heading shown above the next slide's title

    # ---- primitives -------------------------------------------------------------------------------
    def text(self, slide, x, y, w, h, text, size=14, bold=False, color=INK, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, wrap=True):
        box = slide.shapes.add_textbox(x, y, w, h)
        tf = box.text_frame
        tf.word_wrap, tf.vertical_anchor = wrap, anchor
        tf.margin_left = tf.margin_right = Inches(0.04)
        tf.margin_top = tf.margin_bottom = Inches(0.02)
        lines = text if isinstance(text, list) else [text]
        for i, line in enumerate(lines):
            p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            p.alignment = align
            run = p.add_run()
            run.text = str(line)
            run.font.size, run.font.bold, run.font.name = Pt(size), bold, self.font
            run.font.color.rgb = color
        return box

    def bullets(self, slide, x, y, w, h, items, size=14, color=INK, headline=None):
        """Bullet points sized to fit the box (fewer, longer points get a larger font)."""
        items = [str(i) for i in items if str(i).strip()]
        total = sum(len(i) for i in items) + len(headline or "")
        area = (w / Inches(1)) * (h / Inches(1))
        size = max(10, min(size, int((area * 2600 / max(total, 1)) ** 0.5)))
        box = slide.shapes.add_textbox(x, y, w, h)
        tf = box.text_frame
        tf.word_wrap = True
        first = True
        if headline:
            p = tf.paragraphs[0]
            run = p.add_run()
            run.text, run.font.size, run.font.bold, run.font.name = headline, Pt(size + 1), True, self.font
            run.font.color.rgb = color
            p.space_after = Pt(8)
            first = False
        for item in items:
            p = tf.paragraphs[0] if first else tf.add_paragraph()
            first = False
            p.space_after = Pt(6)
            dot = p.add_run()
            dot.text, dot.font.size, dot.font.name, dot.font.bold = "●  ", Pt(size - 4), self.font, True
            dot.font.color.rgb = self.accent
            run = p.add_run()
            run.text, run.font.size, run.font.name = item, Pt(size), self.font
            run.font.color.rgb = color
        return box

    def rect(self, slide, x, y, w, h, color, shape=MSO_SHAPE.RECTANGLE):
        s = slide.shapes.add_shape(shape, x, y, w, h)
        s.fill.solid()
        s.fill.fore_color.rgb = color
        s.line.fill.background()
        s.shadow.inherit = False
        return s

    def picture(self, slide, data: bytes, x, y, w, h):
        """An image fitted inside the box, centred, aspect ratio kept."""
        iw, ih = _image_size(data)
        scale = min(w / iw, h / ih)
        pw, ph = int(iw * scale), int(ih * scale)
        return slide.shapes.add_picture(io.BytesIO(data), x + (w - pw) // 2, y + (h - ph) // 2, pw, ph)

    def logo_at(self, slide, x, y, w, h, right=False):
        if not self.logo:
            return
        with open(self.logo, "rb") as f:
            data = f.read()
        iw, ih = _image_size(data)
        scale = min(w / iw, h / ih)
        pw, ph = int(iw * scale), int(ih * scale)
        slide.shapes.add_picture(io.BytesIO(data), x + (w - pw if right else 0), y + (h - ph) // 2, pw, ph)

    # ---- slides -----------------------------------------------------------------------------------
    def _templated(self, layout, title: str, sub: str = "", sub_ph: bool = False):
        s = self.prs.slides.add_slide(layout)
        for ph in s.placeholders:
            t = ph.placeholder_format.type
            if t in (PP_PLACEHOLDER.TITLE, PP_PLACEHOLDER.CENTER_TITLE):
                ph.text_frame.text = title
                if len(title) > 60:
                    for r in ph.text_frame.paragraphs[0].runs:
                        r.font.size = Pt(22)
            elif sub_ph and sub and t in (PP_PLACEHOLDER.SUBTITLE, PP_PLACEHOLDER.BODY) and not ph.text_frame.text:
                lines = sub.split("\n")
                ph.text_frame.text = lines[0]
                for line in lines[1:]:
                    ph.text_frame.add_paragraph().text = line
        _drop_empty_placeholders(s)
        return s

    def content_slide(self, title: str, subtitle: str = ""):
        if self.template:
            if self.kicker:
                subtitle = self.kicker.upper() + (f"   ·   {subtitle}" if subtitle else "")
                self.kicker = ""
            s = self._templated(self.l_content, title)
            if subtitle:
                self.text(s, M, self.TOP - Inches(0.36), self.W - 2 * M, Inches(0.3), subtitle, 11, color=MUTED)
            foot = " · ".join(x for x in (self.r.get("footer_text"), self.company) if x)
            self.text(s, M, self.H - Inches(0.8), int(self.W * 0.6), Inches(0.3), foot, 9, color=MUTED)
            self.text(s, self.W - M - Inches(1.5), self.H - Inches(0.8), Inches(1.5), Inches(0.3), str(len(self.prs.slides)), 9,
                      color=MUTED, align=PP_ALIGN.RIGHT)
            return s
        s = self.prs.slides.add_slide(self.blank)
        self.rect(s, 0, 0, self.W, Inches(0.09), self.accent)
        if self.r.get("header_text"):
            self.text(s, M, Inches(0.16), Inches(7), Inches(0.3), self.r["header_text"], 10, color=MUTED)
        self.logo_at(s, self.W - M - Inches(1.9), Inches(0.18), Inches(1.9), Inches(0.5), right=True)
        y = Inches(0.42)
        if self.kicker:                                # small label above the title; the subtitle joins it so nothing overlaps
            box = self.text(s, M, y, Inches(11), Inches(0.3), self.kicker.upper(), 11, True, self.accent)
            if subtitle:
                run = box.text_frame.paragraphs[0].add_run()
                run.text, run.font.size, run.font.name = "   ·   " + subtitle, Pt(11), self.font
                run.font.color.rgb = MUTED
            y += Inches(0.3)
            self.kicker, subtitle = "", ""
        self.text(s, M, y, self.W - 2 * M - Inches(2), Inches(0.6), title, 26 if len(title) < 60 else 20, True)
        if subtitle:
            self.text(s, M, y + Inches(0.55), self.W - 2 * M, Inches(0.3), subtitle, 11, color=MUTED)
        # footer
        self.rect(s, M, self.H - Inches(0.42), self.W - 2 * M, Emu(9525), LINE)
        foot = " · ".join(x for x in (self.r.get("footer_text"), self.company) if x)
        self.text(s, M, self.H - Inches(0.38), Inches(9), Inches(0.3), foot, 9, color=MUTED)
        self.text(s, self.W - M - Inches(1.5), self.H - Inches(0.38), Inches(1.5), Inches(0.3), str(len(self.prs.slides)), 9, color=MUTED, align=PP_ALIGN.RIGHT)
        return s

    def title_slide(self):
        if self.template:
            refreshed = re.sub(r"T(\d\d:\d\d).*", r" \1 UTC", self.r.get("refreshed_at") or "")
            info = "   ·   ".join(x for x in (self.company, f"Prepared for {self.r.get('viewer')}" if self.r.get("viewer") else "",
                                              f"Data refreshed {refreshed}") if x)
            sub = "\n".join(x for x in (self.r.get("description"), info) if x)
            s = self._templated(self.l_title, self.r.get("title") or "Report", sub, sub_ph=True)
            if not any(sh.shape_type == 13 for sh in self.l_title.shapes) and self.logo:     # no picture in the layout: add the logo
                self.logo_at(s, self.W - M - Inches(2.6), Inches(0.35), Inches(2.6), Inches(0.9), right=True)
            return
        s = self.prs.slides.add_slide(self.blank)
        self.rect(s, 0, 0, Inches(0.35), self.H, self.accent)
        self.rect(s, Inches(0.35), self.H - Inches(1.25), self.W, Inches(1.25), PALE)
        if self.logo:
            self.logo_at(s, Inches(1.1), Inches(0.8), Inches(3.6), Inches(1.3))
        elif self.company:
            self.text(s, Inches(1.1), Inches(1.0), Inches(8), Inches(0.6), self.company, 22, True, self.accent)
        title = self.r.get("title") or "Report"
        self.text(s, Inches(1.1), Inches(2.55), Inches(11), Inches(1.6), title, 44 if len(title) < 40 else 34, True, anchor=MSO_ANCHOR.BOTTOM)
        if self.r.get("description"):
            self.text(s, Inches(1.1), Inches(4.25), Inches(10.5), Inches(1.0), self.r["description"], 18, color=MUTED)
        refreshed = re.sub(r"T(\d\d:\d\d).*", r" \1 UTC", self.r.get("refreshed_at") or "")
        info = [x for x in (self.company, f"Prepared for {self.r.get('viewer')}" if self.r.get("viewer") else "", f"Data refreshed {refreshed}") if x]
        self.text(s, Inches(1.1), self.H - Inches(1.0), Inches(11), Inches(0.4), "   ·   ".join(info), 13, color=INK)
        if self.r.get("header_text"):
            self.text(s, Inches(1.1), self.H - Inches(0.6), Inches(11), Inches(0.35), self.r["header_text"], 11, color=MUTED)

    def section_slide(self, title: str):
        if self.template and self.l_section is not None:
            self._templated(self.l_section, title, self.company, sub_ph=True)
            return
        s = self.prs.slides.add_slide(self.blank)
        self.rect(s, 0, 0, self.W, self.H, self.accent)
        self.rect(s, M, Inches(3.95), Inches(1.2), Inches(0.08), RGBColor(0xFF, 0xFF, 0xFF))
        self.text(s, M, Inches(2.2), self.W - 2 * M, Inches(1.6), title, 40, True, RGBColor(0xFF, 0xFF, 0xFF), anchor=MSO_ANCHOR.BOTTOM)
        if self.company:
            self.text(s, M, self.H - Inches(0.8), Inches(8), Inches(0.4), self.company, 12, color=RGBColor(0xFF, 0xFF, 0xFF))

    def text_slide(self, text: str):
        blocks = [b.strip() for b in re.split(r"\n\s*\n", text.strip()) if b.strip()]
        title, self.kicker = self.kicker or "Notes", ""
        s = self.content_slide(title)
        self.bullets(s, M, self.TOP, self.W - 2 * M, self.BOTTOM - self.TOP, blocks, 20)

    # ---- results ----------------------------------------------------------------------------------
    @staticmethod
    def _sub(c) -> str:
        bits = [c.get("data_model") or ""]
        if c.get("row_count") is not None and c.get("status") == "ok":
            bits.append(f"{c['row_count']:,} row{'s' if c['row_count'] != 1 else ''}")
        if c.get("filtered"):
            bits.append("data filters applied")
        return " · ".join(b for b in bits if b)

    def _chart_pngs(self, c) -> list[tuple[str, bytes]]:
        if not c.get("show_chart", True) or not c.get("rows"):
            return []
        panels = chart_panels(c["columns"], c["rows"], c.get("chart") or {})
        out = []
        for p in panels:
            png = draw_panel(p, tall=len(panels) == 1)
            if png:
                out.append((p.get("y_title", "") if len(panels) > 1 else "", png))
        return out

    def result(self, c):
        title = c.get("title") or c.get("question") or "Result"
        if c.get("status") != "ok":
            s = self.content_slide(title)
            self.text(s, M, self.TOP, self.W - 2 * M, Inches(1), c.get("message") or "This result is not available.", 16, color=MUTED)
            return
        pa = c.get("analysis") or {}
        if pa.get("result") or pa.get("error"):
            self.predictive(c, title, pa)
        predictive = bool(pa.get("result"))
        charts = self._chart_pngs(c) if not predictive else []
        summary = c.get("summary") or {}
        points = summary.get("bullets", [])[:6] if c.get("show_summary", True) and not predictive else []
        headline = summary.get("headline") if c.get("show_summary", True) and not predictive else None
        rows = c.get("rows") or []
        small = c.get("show_table", True) and 0 < len(rows) <= 6 and len(c["columns"]) <= 4     # fits beside the chart
        table_inline = False
        if charts and small:                               # chart left; key points and the small table on the right
            s = self.content_slide(title, self._sub(c))
            cw = (self.W - 2 * M) * 0.56
            rx, rw = M + cw + Inches(0.4), self.W - 2 * M - cw - Inches(0.4)
            self._charts(s, charts, M, self.TOP, cw, self.BOTTOM - self.TOP)
            th = Inches(0.36) * (len(rows) + 1)
            if points or headline:
                self.bullets(s, int(rx), self.TOP, int(rw), int(self.BOTTOM - self.TOP - th - Inches(0.3)), points[:3], 15, headline=headline)
            self.table(s, c["columns"], rows, int(rx), int(self.BOTTOM - th - Inches(0.05)), int(rw), int(th))
            table_inline = True
        elif charts or points or headline:
            s = self.content_slide(title, self._sub(c))
            if charts and (points or headline):            # chart left (60%), key points right
                cw = (self.W - 2 * M) * 0.6
                self._charts(s, charts, M, self.TOP, cw, self.BOTTOM - self.TOP)
                self.rect(s, M + cw + Inches(0.25), self.TOP, Emu(19050), self.BOTTOM - self.TOP - Inches(0.1), LINE)
                self.text(s, M + cw + Inches(0.45), self.TOP, Inches(3), Inches(0.35), "KEY POINTS", 11, True, self.accent)
                self.bullets(s, M + cw + Inches(0.45), self.TOP + Inches(0.4), self.W - 2 * M - cw - Inches(0.45), self.BOTTOM - self.TOP - Inches(0.5),
                             points, 16, headline=headline)
            elif charts:
                self._charts(s, charts, M, self.TOP, self.W - 2 * M, self.BOTTOM - self.TOP)
            else:                                           # no chart: points on top, a short table below if it fits
                rows = c.get("rows") or []
                fits = c.get("show_table", True) and 0 < len(rows) <= 8 and len(c["columns"]) <= MAX_COLS
                bh = Inches(1.9) if fits else self.BOTTOM - self.TOP
                self.bullets(s, M, self.TOP, self.W - 2 * M, bh, points, 16, headline=headline)
                if fits:
                    self.table(s, c["columns"], rows, M, self.TOP + bh + Inches(0.15), self.W - 2 * M, self.BOTTOM - self.TOP - bh - Inches(0.15))
                    table_inline = True
        if c.get("show_table", True) and c.get("rows") and not table_inline:
            if predictive:
                self.kicker = title
            self.table_slides("Data used" if predictive else title, c, "" if predictive else " — data")

    def _charts(self, s, charts, x, y, w, h):
        n = len(charts)
        cols = 1 if n == 1 else 2
        rows = (n + cols - 1) // cols
        cw, ch = w / cols, h / rows
        for i, (label, png) in enumerate(charts[:4]):
            cx, cy = x + (i % cols) * cw, y + (i // cols) * ch
            if label:
                self.text(s, int(cx), int(cy), int(cw), Inches(0.3), label, 11, True, MUTED)
                self.picture(s, png, int(cx), int(cy + Inches(0.3)), int(cw - Inches(0.1)), int(ch - Inches(0.35)))
            else:
                self.picture(s, png, int(cx), int(cy), int(cw - Inches(0.1)), int(ch))

    def predictive(self, c, title, pa):
        hide = set(c.get("hide") or [])
        if pa.get("error"):
            s = self.content_slide(title, "Predictive analysis")
            self.text(s, M, self.TOP, self.W - 2 * M, Inches(1), "The predictive analysis could not be run: " + pa["error"], 16, color=MUTED)
            return
        r = pa["result"]
        s = self.content_slide(title, f"{r['title']} — {r['method']}")
        y = self.TOP
        if "explain" not in hide and r.get("metrics"):              # key figures as cards
            ms = r["metrics"][:5]
            gap = Inches(0.2)
            cw = (self.W - 2 * M - gap * (len(ms) - 1)) / len(ms)
            for i, m in enumerate(ms):
                cx = int(M + i * (cw + gap))
                card = self.rect(s, cx, int(y), int(cw), Inches(1.2), PALE, MSO_SHAPE.ROUNDED_RECTANGLE)
                card.adjustments[0] = 0.08
                self.text(s, cx + Inches(0.15), int(y + Inches(0.1)), int(cw - Inches(0.3)), Inches(0.3), m["label"], 11, color=MUTED)
                self.text(s, cx + Inches(0.15), int(y + Inches(0.38)), int(cw - Inches(0.3)), Inches(0.5), str(m["value"]), 24, True, self.accent)
                if m.get("note"):
                    self.text(s, cx + Inches(0.15), int(y + Inches(0.85)), int(cw - Inches(0.3)), Inches(0.3), m["note"], 9, color=MUTED)
            y += Inches(1.45)
        plots = [p for p in r.get("plots", [])] if "chart" not in hide else []
        narrative = (r.get("narrative") or [])[:5] if "explain" not in hide else []
        if plots:
            first = plots[0]
            if narrative:
                cw = (self.W - 2 * M) * 0.6
                self.picture(s, draw_plot(first), M, int(y), int(cw), int(self.BOTTOM - y))
                self.bullets(s, int(M + cw + Inches(0.35)), int(y), int(self.W - 2 * M - cw - Inches(0.35)), int(self.BOTTOM - y), narrative, 15)
            else:
                self.picture(s, draw_plot(first), M, int(y), int(self.W - 2 * M), int(self.BOTTOM - y))
            for i in range(1, len(plots), 2):                           # the other charts, two per slide
                s2 = self.content_slide(title, "Predictive analysis — charts")
                pair = plots[i:i + 2]
                cw = (self.W - 2 * M) / len(pair)
                for j, p in enumerate(pair):
                    self.text(s2, int(M + j * cw), self.TOP, int(cw), Inches(0.3), p.get("title", ""), 12, True, MUTED)
                    self.picture(s2, draw_plot(p), int(M + j * cw), int(self.TOP + Inches(0.35)), int(cw - Inches(0.15)), int(self.BOTTOM - self.TOP - Inches(0.35)))
        elif narrative:
            self.bullets(s, M, int(y), self.W - 2 * M, int(self.BOTTOM - y), narrative, 18)
        for key, group in (("table", r.get("tables") or []), ("stats", r.get("stats") or [])):
            if key not in hide:
                for t in group:                         # the analysis' own tables, titled by what they are
                    self.kicker = title
                    self.table_slides(t["title"], {"columns": t["columns"], "rows": t["rows"], "row_count": t.get("row_count", len(t["rows"])),
                                                   "table_rows": 40}, suffix="")

    # ---- tables -----------------------------------------------------------------------------------
    def table(self, s, columns, rows, x, y, w, h, note=""):
        cols = columns[:MAX_COLS]
        n = len(rows) + 1
        row_h = min(Inches(0.42), int(h / n))
        size = 12 if row_h >= Inches(0.36) else 11 if row_h >= Inches(0.3) else 10
        shape = s.shapes.add_table(n, len(cols), int(x), int(y), int(w), int(row_h * n))
        tbl = shape.table
        tbl.first_row, tbl.horz_banding = True, True
        widths = [max(4, min(30, max([len(str(c["name"]))] + [len(_fmt_cell(r[i], c["type"] == "number")) for r in rows[:40]]))) for i, c in enumerate(cols)]
        for i, wd in enumerate(widths):
            tbl.columns[i].width = int(w * wd / sum(widths))
        for i in range(n):
            tbl.rows[i].height = int(row_h)

        def put(cell, value, bold=False, color=INK, right=False, fill=None):
            cell.margin_left = cell.margin_right = Inches(0.06)
            cell.margin_top = cell.margin_bottom = Inches(0.02)
            cell.vertical_anchor = MSO_ANCHOR.MIDDLE
            tf = cell.text_frame
            tf.word_wrap = False
            p = tf.paragraphs[0]
            p.alignment = PP_ALIGN.RIGHT if right else PP_ALIGN.LEFT
            run = p.add_run()
            run.text = value
            run.font.size, run.font.bold, run.font.name = Pt(size), bold, self.font
            run.font.color.rgb = color
            if fill is not None:
                cell.fill.solid()
                cell.fill.fore_color.rgb = fill
        for j, c in enumerate(cols):
            put(tbl.cell(0, j), str(c["name"])[:30], True, RGBColor(0xFF, 0xFF, 0xFF), c["type"] == "number", self.accent)
        for i, r in enumerate(rows, start=1):
            for j, c in enumerate(cols):
                num = c["type"] == "number"
                put(tbl.cell(i, j), _fmt_cell(r[j] if j < len(r) else None, num)[:40], right=num,
                    fill=PALE if i % 2 == 0 else RGBColor(0xFF, 0xFF, 0xFF))
        if note:
            self.text(s, int(x), int(y + row_h * n + Inches(0.08)), int(w), Inches(0.3), note, 10, color=MUTED)

    def table_slides(self, title, c, suffix=" — data"):
        rows = (c.get("rows") or [])[:min(c.get("table_rows") or 25, MAX_TABLE_ROWS)]
        if not rows:
            return
        n = -(-len(rows) // 16)                                        # at most 16 rows a slide, spread evenly
        per = -(-len(rows) // n)
        pages = [rows[i:i + per] for i in range(0, len(rows), per)]
        notes = []
        if c.get("row_count", len(rows)) > len(rows):
            notes.append(f"First {len(rows):,} of {c['row_count']:,} rows.")
        if len(c["columns"]) > MAX_COLS:
            notes.append(f"First {MAX_COLS} of {len(c['columns'])} columns.")
        for k, page in enumerate(pages):
            s = self.content_slide(title + (suffix if k == 0 else f"{suffix} (continued {k + 1}/{len(pages)})"), self._sub(c) if k == 0 else "")
            self.table(s, c["columns"], page, M, self.TOP, self.W - 2 * M, self.BOTTOM - self.TOP - Inches(0.4), " ".join(notes) if k == len(pages) - 1 else "")

    def side_by_side(self, row):
        """Two or three narrower results on one slide: each a chart (or its key points) under its title."""
        s = self.content_slide(self.kicker or " · ".join((c.get("title") or "Result") for c in row)[:90])
        gap = Inches(0.3)
        cw = (self.W - 2 * M - gap * (len(row) - 1)) / len(row)
        for i, c in enumerate(row):
            x = int(M + i * (cw + gap))
            self.text(s, x, self.TOP, int(cw), Inches(0.4), c.get("title") or "Result", 15, True)
            self.text(s, x, self.TOP + Inches(0.38), int(cw), Inches(0.3), self._sub(c), 10, color=MUTED)
            body_y = self.TOP + Inches(0.75)
            if c.get("status") != "ok":
                self.text(s, x, body_y, int(cw), Inches(1), c.get("message") or "Not available.", 13, color=MUTED)
                continue
            charts = self._chart_pngs(c)
            summary = c.get("summary") or {}
            if charts:
                ch = (self.BOTTOM - body_y) * (0.68 if c.get("show_summary", True) else 1)
                self._charts(s, charts[:2], x, body_y, int(cw), int(ch))
                if c.get("show_summary", True):
                    self.bullets(s, x, int(body_y + ch + Inches(0.1)), int(cw), int(self.BOTTOM - body_y - ch - Inches(0.1)),
                                 summary.get("bullets", [])[:2], 12, headline=summary.get("headline"))
            elif c.get("show_summary", True):
                self.bullets(s, x, body_y, int(cw), int(self.BOTTOM - body_y), summary.get("bullets", [])[:5], 14, headline=summary.get("headline"))
        tables = [c for c in row if c.get("status") == "ok" and c.get("show_table", True) and c.get("rows")
                  and not (c.get("analysis") or {}).get("result")]
        if tables and all(len(c["rows"]) <= 16 and len(c["columns"]) <= 4 for c in tables):   # small: side by side on one slide
            s = self.content_slide(" · ".join((c.get("title") or "Result") for c in tables)[:90] + " — data")
            cw = (self.W - 2 * M - gap * (len(tables) - 1)) / len(tables)
            for i, c in enumerate(tables):
                x = int(M + i * (cw + gap))
                self.text(s, x, self.TOP, int(cw), Inches(0.35), c.get("title") or "Result", 13, True, MUTED)
                n = len(c["rows"][:c.get("table_rows") or 25]) + 1
                self.table(s, c["columns"], c["rows"][:c.get("table_rows") or 25], x, self.TOP + Inches(0.42), int(cw),
                           min(int(self.BOTTOM - self.TOP - Inches(0.5)), int(Inches(0.38) * n)))
        else:
            for c in tables:                                       # larger tables follow, one after another
                self.table_slides(c.get("title") or "Result", c)

    def build(self) -> bytes:
        self.title_slide()
        for row in layout_rows(self.r.get("components") or []):
            first = row[0]
            if first["type"] in ("pagebreak", "divider"):
                continue
            results = [c for c in row if c["type"] == "result"]
            if len(results) > 1 and len(results) == len(row) and not any((c.get("analysis") or {}).get("result") for c in results):
                self.side_by_side(results)
                continue
            for c in row:
                if c["type"] == "heading":
                    if c.get("level") == 1:
                        self.section_slide(c["text"])
                    else:
                        self.kicker = c["text"]
                elif c["type"] == "text":
                    self.text_slide(c["text"])
                elif c["type"] == "result":
                    self.result(c)
        buf = io.BytesIO()
        self.prs.save(buf)
        return buf.getvalue()


def build_pptx(rendered: dict, company: str = "", template: str | None = None) -> bytes:
    return Deck(rendered, company, template).build()
