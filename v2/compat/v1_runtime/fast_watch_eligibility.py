"""Close an unstarted watch only with complete journal and source/window proof."""


def close_if_ineligible(worker, watch):
    # Neither a missing Fast endpoint nor a closed-window observation is a
    # provider terminal. First prove the exact source's Deep was accepted and
    # the journal was read through the current authenticated snapshot.
    with worker.ledger.connect() as db:
        original = worker.ledger.source(watch, db)
    deep = (original.get("accepted") or {}).get("deep") or {}
    if (original.get("intake") != watch["intake"] or deep.get("outcome") != "succeeded" or
            not deep.get("acceptance_event_id") or deep.get("run_id") not in watch["matched_runs"]):
        return
    snapshot = worker.call("GET", "")
    if (not isinstance(snapshot, dict) or snapshot.get("conversation_id") != worker.client.conversation or
            type(snapshot.get("last_sequence")) is not int or snapshot["last_sequence"] > watch["fast_cursor"]):
        return
    old = (watch["window"].get("status") or watch["window"])
    current = worker.call("GET", "/window", allowed=(200, 204))
    if (not isinstance(current, dict) or current.get("conversation_id") != worker.client.conversation or
            not isinstance(current.get("window_id"), str) or not current["window_id"] or
            type(current.get("generation")) is not int or current["generation"] < 1 or
            current.get("state") not in ("opening", "active", "retiring", "closed", "reconciliation_required")):
        return
    same_closed = (current.get("window_id") == old.get("window_id") and current.get("state") == "closed" and
                   current.get("generation") == old.get("generation"))
    successor = (current.get("window_id") != old.get("window_id") and
                 type(current.get("generation")) is int and type(old.get("generation")) is int and
                 current["generation"] > old["generation"])
    if not same_closed and not successor:
        return
    watch.update(closed=True, diagnostic={"reason": "unstarted_source_window_ineligible",
        "acceptance_event_id": deep["acceptance_event_id"], "window_id": old["window_id"],
        "observed_window_id": current.get("window_id"), "observed_generation": current["generation"]})
    worker.ledger.save(watch)
