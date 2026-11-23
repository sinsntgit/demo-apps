import pathlib, re

CARDS = (pathlib.Path(__file__).resolve().parent.parent / "cie" / "cards.py").read_text(encoding="utf-8")


def test_unchanged_cards_restore_cleared_evidence():
    # --rebuild clears evidence_ref but keeps cards; an unchanged card must get its quotes back or it fails the governance gate
    kept = CARDS.split("kept += 1", 1)[1][:600]
    assert "evidence_ref" in kept and "INSERT INTO evidence_ref" in kept
