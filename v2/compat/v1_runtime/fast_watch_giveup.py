"""Local follow-up limit after a proven Deep final, never native settlement."""
import copy
import math
import sys
import time

GIVE_UP_AFTER_MS = 600_000


def stamp_final(data, reply):
    """Called only inside the transaction that commits the accepted final."""
    deep = (data.get("accepted") or {}).get("deep") or {}
    source = data.get("intake") or {}
    if (data.get("deep_final_completion") or data.get("phase") == "completed" or data.get("refused") or
            (data.get("author") or {}).get("role") != "owner" or data.get("origin") or
            deep.get("outcome") != "succeeded" or not deep.get("acceptance_event_id") or
            deep.get("run_id") not in data.get("matched_runs", []) or
            not source.get("message_id") or not source.get("event_id") or
            reply.get("id") != deep["acceptance_event_id"] or
            reply.get("role") != "assistant" or reply.get("phase") != "final_answer" or
            reply.get("parentMessageId") != data["remote_id"] or reply.get("source") != "rust-v2-pilot"):
        return
    now = time.time()
    if not math.isfinite(now) or now < 0:
        return
    data["deep_final_completion"] = dict(at_ms=int(now * 1000), input_id=data["remote_id"],
        run_id=deep["run_id"], acceptance_event_id=deep["acceptance_event_id"],
        message_id=source["message_id"], event_id=source["event_id"])


def give_up(worker, watch):
    """An observation failed: stop local polling only after the proved limit."""
    with worker.ledger.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT closed FROM fast_watch WHERE event_id=? AND input_id=?",
                         (watch["watch_id"], watch["remote_id"])).fetchone()
        if not row or row[0]:
            return bool(row)
        original = worker.ledger.source(watch, db)
        proof = original.get("deep_final_completion") or {}
        deep = (original.get("accepted") or {}).get("deep") or {}
        source = original.get("intake") or {}
        at = proof.get("at_ms")
        if (original.get("phase") != "completed" or original.get("refused") or
                type(at) is not int or at < 0 or proof.get("input_id") != watch["remote_id"] or
                deep.get("outcome") != "succeeded" or not proof.get("acceptance_event_id") or
                proof.get("run_id") != deep.get("run_id") or
                proof.get("acceptance_event_id") != deep.get("acceptance_event_id") or
                proof.get("message_id") != source.get("message_id") or proof.get("event_id") != source.get("event_id")):
            return False
        exported = db.execute("SELECT 1 FROM exports WHERE input_id=? AND kind='final' AND source_key=? AND export_id=?",
                              (watch["remote_id"], "final:" + watch["remote_id"], proof["acceptance_event_id"])).fetchone()
        now = time.time()
        if not exported or not math.isfinite(now) or int(now * 1000) - at < GIVE_UP_AFTER_MS:
            return False
        watch.update(closed=True, diagnostic={"reason": "fast_watch_gave_up", "at_ms": int(now * 1000),
            "deep_final_completion": copy.deepcopy(proof)})
        worker.ledger.save(watch, db)
    # The durable close prevents a restart or another poll from repeating this
    # static diagnostic. No owner/transport/native outcome is recorded here.
    print("ALERT orkestr-v2-wa-adapter fast_watch_gave_up conversation=%s input=%s event=%s"
          % (getattr(worker.client, "conversation", "?"), watch["remote_id"], watch["watch_id"]),
          file=sys.stderr, flush=True)
    return True
