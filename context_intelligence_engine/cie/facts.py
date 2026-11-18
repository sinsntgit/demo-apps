"""Persistent context: facts keep the dates they were true; superseded facts stay on record (PDF: "Persistent context").

Scope = a contact thread (previous_session_id chain). Attributes:
  primary_intent  value = L3 intent of the latest contact (each new contact supersedes the previous one)
  last_outcome    value = outcome proxy of the latest contact
  open_issue      value = L2 need still open (contact ended escalated/abandoned); superseded by issue_resolved when a later
                  contact on the same L2 ends resolved-proxy
  issue_resolved  value = L2 need closed
  stated_interest value = buying/value signal type the customer expressed (kept; never superseded)
  price_sensitive value = 'yes' once price-sensitivity language appears
facts_as_of(thread, ts) reconstructs what was known at any point in time.
"""
import datetime as dt
from collections import defaultdict
from . import db
from .config import VERSIONS
from .taxonomy import Taxonomy


def run(con, tax=None):
    tax = tax or Taxonomy()
    rec = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    with db.stage(con, "facts", VERSIONS) as (run_id, stats):
        con.execute("DELETE FROM fact")
        sig = defaultdict(set)
        for sid, t in con.execute("SELECT session_id, type FROM session_signal WHERE family IN ('buying','value')"):
            sig[sid].add(t)
        rows = con.execute("""SELECT s.thread_id, s.session_id, s.created_at, s.outcome, si.intent_id FROM conversation_session s
                              LEFT JOIN session_intent si ON si.session_id=s.session_id AND si.role='primary' ORDER BY s.thread_id, s.created_at""").fetchall()
        threads = defaultdict(list)
        for r in rows:
            threads[r["thread_id"]].append(r)
        n = 0
        cur = con.cursor()

        def add(thread, attr, val, frm, sid):
            cur.execute("INSERT INTO fact(scope_type,scope_id,attribute,value,valid_from,recorded_at,source_session) VALUES('thread',?,?,?,?,?,?)",
                        (thread, attr, val, frm, rec, sid))
            return cur.lastrowid

        def close(fid, at, by):
            cur.execute("UPDATE fact SET valid_to=?, superseded_by=? WHERE fact_id=?", (at, by, fid))
        for thread, ss in threads.items():
            live = {}                                   # attr(+key) -> fact_id
            for s in ss:
                at, sid, l2 = s["created_at"], s["session_id"], tax.l2(s["intent_id"] or "UNKNOWN")
                for attr, val in (("primary_intent", s["intent_id"]), ("last_outcome", s["outcome"])):
                    fid = add(thread, attr, val, at, sid); n += 1
                    if attr in live:
                        close(live[attr], at, fid)
                    live[attr] = fid
                key = ("open_issue", l2)
                if s["outcome"] in ("escalated", "abandoned") and l2 not in ("UNKNOWN", "ESCALATION.REP"):
                    if key not in live:
                        live[key] = add(thread, "open_issue", l2, at, sid); n += 1
                elif s["outcome"] == "resolved_proxy" and key in live:
                    fid = add(thread, "issue_resolved", l2, at, sid); n += 1
                    close(live.pop(key), at, fid)
                for t in sorted(sig.get(sid, ())):
                    if ("interest", t) not in live:
                        live[("interest", t)] = add(thread, "stated_interest", t, at, sid); n += 1
                    if t == "price_sensitivity" and "price" not in live:
                        live["price"] = add(thread, "price_sensitive", "yes", at, sid); n += 1
        stats.update(threads=len(threads), facts=n)
    return stats


def facts_as_of(con, thread_id, ts):
    return [dict(r) for r in con.execute("""SELECT attribute, value, valid_from, valid_to, source_session FROM fact
                                            WHERE scope_type='thread' AND scope_id=? AND valid_from<=? AND (valid_to IS NULL OR valid_to>?)
                                            ORDER BY attribute, valid_from""", (thread_id, ts, ts))]


def history(con, thread_id):
    return [dict(r) for r in con.execute("SELECT * FROM fact WHERE scope_type='thread' AND scope_id=? ORDER BY valid_from, fact_id", (thread_id,))]
