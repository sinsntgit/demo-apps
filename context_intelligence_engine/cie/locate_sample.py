"""Write a git-ignored copy of the real sample with an ASSUMED service location (AGENTS.md §2.7).

Temporary: delete once Verizon supplies the real location field. The original file is never modified.
Assignment is deterministic (hash of session_id) and flagged via user_metadata.geo_level='assumed_sample'.
"""
import hashlib, json
from .config import SAMPLE, SAMPLE_LOCATED
from .lexicon import CITIES

ZIP3 = {"FL": "327", "TX": "770", "GA": "303", "AZ": "850", "NY": "100", "IL": "606", "CA": "900", "PA": "191", "NC": "282", "OH": "432"}


def run(src=SAMPLE, dst=SAMPLE_LOCATED):
    dst.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with open(src, encoding="utf-8") as f, open(dst, "w", encoding="utf-8") as out:
        for line in f:
            if not line.strip():
                continue
            rec = json.loads(line)
            c = CITIES[int(hashlib.sha256(rec["session_id"].encode()).hexdigest(), 16) % len(CITIES)]
            um = rec.get("user_metadata") or {}
            um.update({"svc_city": c[0], "svc_state": c[1], "svc_zip3": ZIP3.get(c[1], "999"), "svc_market": c[3],
                       "svc_region": c[2], "geo_level": "assumed_sample", "geo_asof": rec.get("created_at", "")[:10]})
            rec["user_metadata"] = um
            out.write(json.dumps(rec) + "\n"); n += 1
    print(f"located sample: {n} sessions -> {dst}")
    return dst


if __name__ == "__main__":
    run()
