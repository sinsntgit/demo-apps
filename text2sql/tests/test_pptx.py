"""Reports as PowerPoint: built-in design with the company logo, or the company's own template."""
import copy
import io
import zipfile

from pptx import Presentation
from pptx.util import Inches

from tests.conftest import H
from tests.test_platform import ask
from tests.test_tenancy import _png


def _deck(client, report_id) -> Presentation:
    r = client.get(f"/api/reports/{report_id}/pptx")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("application/vnd.openxmlformats-officedocument.presentationml")
    return Presentation(io.BytesIO(r.content))


def _texts(prs) -> list[str]:
    return [" ".join(sh.text_frame.text for sh in s.shapes if sh.has_text_frame) for s in prs.slides]


def _template(potx: bool) -> bytes:
    """A 4:3 corporate template with a branded shape on its master and one sample slide."""
    prs = Presentation()
    tmp = prs.slides.add_slide(prs.slide_layouts[6])
    tb = tmp.shapes.add_textbox(Inches(0.3), Inches(7.1), Inches(4), Inches(0.3))
    tb.text_frame.text = "CORPORATE MASTER BAND"
    prs.slide_master.shapes._spTree.append(copy.deepcopy(tb._element))
    sid = prs.slides._sldIdLst[0]
    prs.part.drop_rel(sid.rId)
    prs.slides._sldIdLst.remove(sid)
    prs.slides.add_slide(prs.slide_layouts[0]).shapes.title.text = "SAMPLE SLIDE IN THE TEMPLATE"
    buf = io.BytesIO()
    prs.save(buf)
    if not potx:
        return buf.getvalue()
    out = io.BytesIO()
    with zipfile.ZipFile(buf) as zin, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for i in zin.infolist():
            b = zin.read(i.filename)
            if i.filename == "[Content_Types].xml":
                b = b.replace(b"presentationml.presentation.main+xml", b"presentationml.template.main+xml")
            z.writestr(i, b)
    return out.getvalue()


def test_report_as_powerpoint(admin):
    client, conn, model = admin
    r1 = ask(client, conn, model, "revenue and orders by region")["run"]
    r2 = ask(client, conn, model, "revenue by category")["run"]
    r3 = ask(client, conn, model, "Who are our top customers?")["run"]
    rep = client.post("/api/reports", headers=H, json={"title": "Board pack", "description": "For the board", "footer_text": "Internal",
                                                       "components": [{"type": "heading", "text": "Sales", "level": 1},
                                                                      {"type": "text", "text": "Two paragraphs.\n\nSecond one."},
                                                                      {"type": "result", "run_id": r1["id"], "title": "By region"},
                                                                      {"type": "result", "run_id": r2["id"], "title": "Left", "width": 3},
                                                                      {"type": "result", "run_id": r3["id"], "title": "Right", "width": 3}]}).json()
    prs = _deck(client, rep["id"])
    assert prs.slide_width == Inches(13.333) and len(prs.slides) >= 5
    texts = _texts(prs)
    assert "Board pack" in texts[0] and "For the board" in texts[0]
    assert "Sales" in texts[1]                                                    # a section slide for the main heading
    assert any("By region" in t and "KEY POINTS" not in t and "South" in t for t in texts)   # small table beside the chart
    assert any("Left · Right" in t for t in texts)                               # side-by-side results share a slide
    assert all("SELECT" not in t.upper() for t in texts)
    assert any(sh.shape_type == 13 for s in prs.slides for sh in s.shapes)        # charts are pictures

    # the company logo appears on the title slide and on content slides
    client.post("/api/company/logo", headers=H, files={"upload": ("l.png", _png(), "image/png")})
    with_logo = _deck(client, rep["id"])
    pics = lambda s: sum(sh.shape_type == 13 for sh in s.shapes)                 # noqa: E731
    assert pics(with_logo.slides[0]) == 1 and pics(with_logo.slides[2]) >= 1

    # a corporate template: bad files refused; .potx accepted; its size, master and layouts are used, its sample slide is not
    assert client.post("/api/company/template", headers=H, files={"upload": ("x.pptx", b"not a deck", "application/octet-stream")}).status_code == 400
    fake = io.BytesIO()
    with zipfile.ZipFile(fake, "w") as z:
        z.writestr("hello.txt", "zip but not PowerPoint")
    assert client.post("/api/company/template", headers=H, files={"upload": ("x.pptx", fake.getvalue(), "application/zip")}).status_code == 400
    ok = client.post("/api/company/template", headers=H, files={"upload": ("Corporate.potx", _template(True), "application/octet-stream")}).json()
    assert ok["pptx_template"] == "Corporate.potx" and client.get("/api/auth/me").json()["company"]["pptx_template"] == "Corporate.potx"
    branded = _deck(client, rep["id"])
    assert branded.slide_width == Inches(10)                                      # the template's 4:3
    assert "CORPORATE MASTER BAND" in " ".join(sh.text_frame.text for sh in branded.slide_master.shapes if sh.has_text_frame)
    texts = _texts(branded)
    assert "SAMPLE SLIDE IN THE TEMPLATE" not in " ".join(texts) and "Board pack" in texts[0]
    assert branded.slides[0].slide_layout.name == "Title Slide" and branded.slides[1].slide_layout.name == "Section Header"
    assert all("Click to add" not in t for t in texts)                            # no empty placeholders left behind
    client.post("/api/company/template", headers=H, files={"upload": ("c.pptx", _template(False), "application/octet-stream")})
    assert _deck(client, rep["id"]).slide_width == Inches(10)
    client.delete("/api/company/template", headers=H)
    client.delete("/api/company/logo", headers=H)
    assert _deck(client, rep["id"]).slide_width == Inches(13.333)

    # access: same rules as the PDF
    from tests.test_reports import _login
    other, _ = _login(client, "pptx.viewer@test.local")
    assert other.get(f"/api/reports/{rep['id']}/pptx").status_code == 404
    client.delete(f"/api/reports/{rep['id']}", headers=H)
