"""Bounded owner intake and Fast observation, independent of head Deep work.

Only existing authenticated intake/window/acceptance APIs are used. Core still
owns capacity, input eligibility, Fast uniqueness and the original child tree.
Deep observation and final export remain on the ledger's serial head path.
"""
import copy
import sys

from .first_response import capture
from .intake import admit, window
from . import fast_watch

MAX_ADMISSIONS = 8
MAX_WINDOW_ATTEMPTS = 8
MAX_FAST_OBSERVATIONS = 8
# A caught-up SSE stream otherwise holds the binding worker for five seconds
# per pending source, delaying the next intake pass behind unrelated Deep work.
EVENT_WAIT_S = 0.15


def isolated(worker, data):
    return (worker.fast_reply_policy == "owner_only" and
            (data.get("author") or {}).get("role") == "owner" and not data.get("origin"))


def eligible(worker, data):
    """Explicit binding consent plus the author verified at HTTP intake."""
    return (isolated(worker, data) and data.get("phase") != "completed" and not data.get("origin") and
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
    if fast is None and not events:
        from .fast_watch_eligibility import close_if_ineligible
        close_if_ineligible(worker, data)
        if data.get("closed"):
            return
    fast_ids = {fast["run_id"]} if isinstance(fast, dict) else set()
    if worker.ledger.presentation_allowed(data):
        worker.capture_questions(data, events, fast_ids)
        capture(worker, data, {"fast": fast}, ids)
    elif not data.get("first_response"):
        data["diagnostic"] = {"reason": "substantive_deep_final_prepared", "presentation": "skipped"}
        worker.ledger.save(data)
    if isinstance(fast, dict) and fast.get("phase") in ("failed", "lost", "cancelled", "blocked", "stopped", "interrupted"):
        data.update(closed=True, diagnostic={"reason": "observed_fast_unavailable", "phase": fast["phase"], "run_id": fast["run_id"]})
        worker.ledger.save(data)
        return
    if (isinstance(fast, dict) and fast.get("run_id") in ids and
            fast.get("phase") in ("awaiting_acceptance", "completed") and
            "fast" not in data.get("accepted", {})):
        # The same owner-authenticated acceptance path releases this binding
        # for the next original event without waiting for its sibling Deep.
        worker.accept_role(data, "fast", ids)
    if "fast" in data.get("accepted", {}):
        data["closed"] = True
        worker.ledger.save(data)


def drive(worker):
    if worker.fast_reply_policy != "owner_only":
        return False
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
    try:
        for data in rows:
            if isolated(worker, data) and data.get("phase") != "completed" and "intake" in data and "window" in data:
                fast_watch.ensure(worker.ledger, data)
        watches = fast_watch.pending(worker.ledger, MAX_FAST_OBSERVATIONS)
    except Exception:
        print("ALERT orkestr-v2-wa-adapter fast_watch_deferred", file=sys.stderr, flush=True)
        return True
    fast_worker = copy.copy(worker)
    fast_worker.ledger = fast_watch.Ledger(worker.ledger)
    for data in watches:
        try:
            observe(fast_worker, data)
        except Exception:
            data["diagnostic"] = {"reason": "fast_observation_deferred"}
            try:
                fast_worker.ledger.save(data)
            except Exception:
                pass  # Fast diagnostics cannot decide or block Deep.
            print("ALERT orkestr-v2-wa-adapter fast_observation_deferred conversation=%s input=%s"
                  % (getattr(worker.client, "conversation", "?"), data["remote_id"]),
                  file=sys.stderr, flush=True)
    try:
        return fast_watch.active(worker.ledger)
    except Exception:
        return True  # Unknown retained work keeps its existing busy retry cadence.
