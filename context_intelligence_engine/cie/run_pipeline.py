"""Pipeline orchestrator (WP12). Week-1 stages: init -> ingest -> signals+intents -> episodes+features.

  python -m cie.run_pipeline --rebuild             # real sample (located copy) + scenario fixtures
  python -m cie.run_pipeline --ingest path:source  # add a file
"""
import argparse, json, time
from . import db, ingest, signals, episodes, locate_sample
from .config import SAMPLE, SAMPLE_LOCATED, FIXTURES, DB_PATH
from .lexicon import CITIES
from .taxonomy import Taxonomy


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--rebuild", action="store_true", help="drop derived tables and load sample + fixtures")
    ap.add_argument("--ingest", action="append", default=[], help="path:source (repeatable)")
    ap.add_argument("--db", default=str(DB_PATH))
    ap.add_argument("--with-fixtures", action="store_true", help="also load the 77 scripted fixtures (tests/demo only)")
    a = ap.parse_args(argv)
    con = db.connect(a.db)
    db.init(con)
    t0 = time.time()
    inputs = list(a.ingest)
    if a.rebuild:
        for tb in db.DERIVED:
            con.execute(f"DELETE FROM {tb}")
        con.execute("DELETE FROM dim_geography")
        con.executemany("INSERT INTO dim_geography VALUES(?,?,?,?,?,?)", [(c[0], c[1], c[2], c[3], c[4], c[5]) for c in CITIES])
        con.commit()
        if SAMPLE.exists():
            locate_sample.run()
            inputs.insert(0, f"{SAMPLE_LOCATED}:verizon_sample")
        else:
            print(f"! real sample not found at {SAMPLE} (git-ignored); continuing with fixtures only")
        from .synth import SYNTH_PATH
        if SYNTH_PATH.exists():
            inputs.append(f"{SYNTH_PATH}:synthetic")
        if a.with_fixtures or not SYNTH_PATH.exists():
            inputs.append(f"{FIXTURES}:fixtures")
    for spec in inputs:
        path, source = spec.rsplit(":", 1)
        print("ingest", source, json.dumps(ingest.ingest_file(con, path, source)))
    tax = Taxonomy()
    print("signals", json.dumps(signals.run(con, tax)))
    print("episodes", json.dumps(episodes.run(con, tax)))
    print(f"done in {time.time() - t0:.1f}s -> {a.db}")


if __name__ == "__main__":
    main()
