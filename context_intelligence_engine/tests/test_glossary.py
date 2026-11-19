import re, pathlib
from cie import glossary, config

UI = pathlib.Path(__file__).resolve().parent.parent / "ui"


def test_every_score_dimension_documented():
    keys = {d["key"] for d in glossary.SCORE_DIMENSIONS}
    assert set(config.SCORE_WEIGHTS) <= keys
    assert set(glossary.payload()["score_labels"]) >= keys


def test_ui_terms_and_help_exist():
    p = glossary.payload()
    known = set(p["terms"]) | set(p["kpis"])
    for f in UI.glob("*.js"):
        s = f.read_text(encoding="utf-8")
        for k in re.findall(r"\bT\(\"([a-z_0-9]+)\"", s):
            assert k in known, (f.name, k)
        for k in re.findall(r"HELP\(\"([a-z_]+)\"\)", s):
            assert k in p["pages"], (f.name, k)
