"""Bounded owner intake and Fast observation, independent of head Deep work.

Only existing authenticated intake/window/acceptance APIs are used. Core still
owns capacity, input eligibility, Fast uniqueness and the original child tree.
Deep observation and final export remain on the ledger's serial head path.
"""
import sys

from .first_response import capture
from .intake import admit, window

MAX_ADMISSIONS = 8
MAX_WINDOW_ATTEMPTS = 8
MAX_FAST_OBSERVATIONS = 8
# A caught-up SSE stream otherwise holds the binding worker for five seconds
# per pending source, delaying the next intake pass behind unrelated Deep work.
EVENT_WAIT_S = 0.15


def eligible(worker, data):
    """Explicit binding consent plus the author verified at HTTP intake."""
    return (worker.fast_reply_policy == "owner_only" and
            (data.get("author") or {}).get("role") == "owner" and
            data.get("phase") != "completed" and not data.get("origin") and
            not any(data.get(key) for key in
                    ("blocked", "digest", "refused", "absorbed_into", "burst", "requeued", "continued")))


def failed(worker, data, error):
    """Use normal per-input refusal semantics; uncertainty keeps frozen I/O."""
    from .worker import Refused, refusal_reason, transient
    if isinstance(error, Refused):
        worker.ledger.refuse(data, str(error))
    elif not transient(error):
        worker.ledger.refuse(data, refusal_reason(error))
    elif getattr(error, "code", None) == "session_revoked" and not worker._revoked_alerted:
        worker._revoked_alerted = True
        print("ALERT orkestr-v2-wa-adapter session_revoked conversation=%s input=%s"
              % (getattr(worker.client, "conversation", "?"), data["remote_id"]),
              file=sys.stderr, flush=True)


def observe(worker, data):
    """Observe only exact-source Fast; do not advance Deep's event cursor."""
    from .worker import Refused
    if "window" not in data:
        return
    cursor = data.get("fast_cursor", data["intake"]["sequence"] - 1)
    events = worker.client.read_events(after=cursor, maximum=100, timeout_s=EVENT_WAIT_S)
    ids = set(data.get("matched_runs", [])) | set(worker.client.matching_run_ids(events, data["intake"]))
    if len(ids) > 128:
        raise Refused("too_many_runs")
    data["matched_runs"] = sorted(ids)
    data["fast_cursor"] = max([cursor] + [event["sequence"] for event in events])
    worker.ledger.save(data)
    fast = worker.own_statuses(ids, roles=("fast",))["fast"]
    fast_ids = {fast["run_id"]} if isinstance(fast, dict) else set()
    worker.capture_questions(data, events, fast_ids)
    capture(worker, data, {"fast": fast}, ids)
    if (isinstance(fast, dict) and fast.get("run_id") in ids and
            fast.get("phase") in ("awaiting_acceptance", "completed") and
            "fast" not in data.get("accepted", {})):
        # The same owner-authenticated acceptance path releases this binding
        # for the next original event without waiting for its sibling Deep.
        worker.accept_role(data, "fast", ids)


def drive(worker):
    if worker.fast_reply_policy != "owner_only":
        return
    rows = worker.ledger.pending_inputs()
    admissions = 0
    for data in rows:
        if "intake" in data:
            continue
        # Do not admit an owner event ahead of an earlier, unadmitted member,
        # local-agent input or frozen legacy burst. The serial path owns it.
        if not eligible(worker, data) or admissions >= MAX_ADMISSIONS:
            break
        admissions += 1
        try:
            admit(worker, data, merge_burst=False)
        except Exception as error:
            failed(worker, data, error)
            break  # Unknown intake cannot be passed by a later source.
    attempts = 0
    for data in rows:
        if not eligible(worker, data) or "intake" not in data or "window" in data:
            continue
        if attempts >= MAX_WINDOW_ATTEMPTS:
            break
        attempts += 1
        try:
            if not window(worker, data):
                break  # Keep ordinary window admission/queue order.
        except Exception as error:
            failed(worker, data, error)
            break
    observations = 0
    for data in rows:
        if (not eligible(worker, data) or "intake" not in data or
                (data.get("first_response") and "fast" in data.get("accepted", {}))):
            continue
        if observations >= MAX_FAST_OBSERVATIONS:
            break
        observations += 1
        try:
            observe(worker, data)
        except Exception:
            # Presentation/read/acceptance failure is not a decision about the
            # originating Deep input. Keep its state and frozen requests for
            # the next pass; only the existing serial path may finish it.
            print("ALERT orkestr-v2-wa-adapter fast_observation_deferred conversation=%s input=%s"
                  % (getattr(worker.client, "conversation", "?"), data["remote_id"]),
                  file=sys.stderr, flush=True)
