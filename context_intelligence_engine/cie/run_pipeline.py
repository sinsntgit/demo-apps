"""Pipeline orchestrator (WP12).

Stages: ingest -> signals -> episodes -> clusters -> patterns -> scoring -> cards -> facts -> index

  python -m cie.run_pipeline --rebuild                 # real sample (located copy) + 100K synthetic (+ fixtures if no synthetic)
  python -m cie.run_pipeline --from-stage patterns     # rerun downstream stages only
  python -m cie.run_pipeline --only cards
  python -m cie.run_pipeline --daily --inbox landing_inbox/    # overnight batch: ingest new files, then everything downstream
  python -m cie.run_pipeline --refit                   # weekly cluster refit (stable ids preserved)
"""
import argparse, hashlib, json, time
from pathlib import Path
from . import db, ingest, signals, episodes, locate_sample
from .config import SAMPLE, SAMPLE_LOCATED, FIXTURES, DB_PATH
from .lexicon import CITIES
from .taxonomy import Taxonomy

STAGES = ["ingest", "signals", "episodes", "clusters", "patterns", "scoring", "cards", "facts", "index"]


def stage_fn(name, con, tax):
    from . import cluster, patterns, scoring, cards, facts, retrieval
    return {"signals": lambda: signals.run(con, tax), "episodes": lambda: episodes.run(con, tax), "clusters": lambda: cluster.run(con, tax),
            "patterns": lambda: patterns.run(con, tax), "scoring": lambda: scoring.run(con), "cards": lambda: cards.run(con),
            "facts": lambda: facts.run(con, tax), "index": lambda: retrieval.build_index(con)}[name]


def _sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--rebuild", action="store_true", help="clear derived tables and load sample + synthetic")
    ap.add_argument("--ingest", action="append", default=[], help="path:source (repeatable)")
    ap.add_argument("--with-fixtures", action="store_true", help="also load the 77 scripted fixtures (tests/demo only)")
    ap.add_argument("--reset-cards", action="store_true", help="drop card history (otherwise review status and versions persist)")
    ap.add_argument("--from-stage", choices=STAGES[1:]); ap.add_argument("--only", choices=STAGES[1:])
    ap.add_argument("--daily", action="store_true"); ap.add_argument("--inbox", default="landing_inbox")
    ap.add_argument("--refit", action="store_true", help="refit clusters, then downstream stages")
    ap.add_argument("--db", default=str(DB_PATH))
    a = ap.parse_args(argv)
    con = db.connect(a.db); db.init(con)
    t0 = time.time()
    inputs = list(a.ingest)
    if a.rebuild:
        for tb in db.DERIVED:
            con.execute(f"DELETE FROM {tb}")
        if a.reset_cards:
            con.execute("DELETE FROM evidence_card"); con.execute("DELETE FROM cluster_master")
        con.execute("DELETE FROM dim_geography")
        con.executemany("INSERT INTO dim_geography VALUES(?,?,?,?,?,?)", [(c[0], c[1], c[2], c[3], c[4], c[5]) for c in CITIES])
        con.commit()
        if SAMPLE.exists():
            locate_sample.run(); inputs.insert(0, f"{SAMPLE_LOCATED}:verizon_sample")
        else:
            print(f"! real sample not found at {SAMPLE} (git-ignored); continuing without it")
        from .synth import SYNTH_PATH
        if SYNTH_PATH.exists():
            inputs.append(f"{SYNTH_PATH}:synthetic")
        if a.with_fixtures or not SYNTH_PATH.exists():
            inputs.append(f"{FIXTURES}:fixtures")
    if a.daily:                                              # overnight mode: only files not processed before (by sha256)
        for p in sorted(Path(a.inbox).glob("*.jsonl*")):
            sha = _sha(p)
            if con.execute("SELECT 1 FROM processed_day WHERE sha256=?", (sha,)).fetchone():
                print("skip (already processed)", p.name); continue
            inputs.append(f"{p}:daily")
    for spec in inputs:
        path, source = spec.rsplit(":", 1)
        st = ingest.ingest_file(con, path, source)
        print("ingest", source, json.dumps(st))
        if source == "daily":
            con.execute("INSERT OR REPLACE INTO processed_day VALUES(?,?,?,?,?,datetime('now'))", (source, time.strftime("%Y-%m-%d"), Path(path).name, _sha(path), st["sessions"]))
            con.commit()
    tax = Taxonomy()
    if a.only:
        todo = [a.only]
    elif a.from_stage:
        todo = STAGES[STAGES.index(a.from_stage):]
    elif a.refit:
        todo = STAGES[STAGES.index("clusters"):]
    else:
        todo = STAGES[1:]
    for s in todo:
        ts = time.time()
        print(f"... {s} started", flush=True)
        res = stage_fn(s, con, tax)()
        print(f"{s:9s} {time.time() - ts:6.1f}s {json.dumps(res, default=str)[:300]}")
    print("... analyse (query planner statistics)", flush=True)
    con.execute("ANALYZE"); con.commit()
    print(f"done in {time.time() - t0:.1f}s -> {a.db}")


if __name__ == "__main__":
    main()
