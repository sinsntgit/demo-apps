import sys
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


@pytest.fixture(scope="session")
def built_db(tmp_path_factory):
    """Fixtures-only DB built through the real pipeline (independent of the git-ignored Verizon sample)."""
    from cie import db, ingest, signals, episodes
    from cie.config import FIXTURES
    from cie.taxonomy import Taxonomy
    path = tmp_path_factory.mktemp("db") / "t.sqlite"
    con = db.connect(path); db.init(con)
    ingest.ingest_file(con, FIXTURES, "fixtures")
    tax = Taxonomy()
    signals.run(con, tax); episodes.run(con, tax)
    return path
