"""Bounded owner intake and Fast observation, independent of head Deep work.

Only existing authenticated intake/window/acceptance APIs are used. Core still
owns capacity, input eligibility, Fast uniqueness and the original child tree.
Deep observation and final export remain on the ledger's serial head path.
"""
import copy
import sys

from .first_response import capture
from . import fast_watch, journal
from .execution_mode import single
from .intake_ahead import individual, eligible as intake_eligible, drive as drive_admission

MAX_FAST_OBSERVATIONS = 24
# A caught-up SSE stream otherwise holds the binding worker for five seconds
# per pending source, delaying the next intake pass behind unrelated Deep work.
EVENT_WAIT_S = 0.15
# One shared journal scan per pass serves every pending Fast watch. Before,
# each watch crawled the journal from its own cursor (one bounded read per
# watch per pass, eight watches per pass), so in a burst a finished Fast reply
# waited minutes for its watch to reach the run's events (live p95 ~13 min
# between Core acceptance and export). Bounded by pages and wall time.
SCAN_PAGES = 20
SCAN_BUDGET_S = 3.0


def isolated(worker, data):
    return not single(worker, data) and individual(worker, data)


def eligible(worker, data):
    return not single(worker, data) and intake_eligible(worker, data)


def scan(worker, watches):
    """Read the journal once, from the oldest watch cursor, for all watches.

    Returns (events, complete): `complete` means an empty read proved the scan
    reached the end of the journal."""
    cursors = [w.get("fast_cursor", w["intake"]["sequence"] - 1) for w in watches if "window" in w]
    if not cursors:
        return [], True
    # Through the binding's shared journal: events the serial Deep path (or
    # an earlier pass) already read come from memory, not from Core again.
    return journal.shared(worker).page(worker.client, min(cursors), SCAN_PAGES, SCAN_BUDGET_S,
                                       timeout_s=EVENT_WAIT_S)


def observe(worker, data, shared=None):
    """Observe only exact-source Fast; do not advance Deep's event cursor.

    `shared` is this pass's shared journal scan (see `scan`); without it the
    watch reads the journal itself as before."""
    from .worker import Refused
    if "window" not in data:
        return
    cursor = data.get("fast_cursor", data["intake"]["sequence"] - 1)
    if shared is None:
        events = journal.shared(worker).read(worker.client, cursor, 100, timeout_s=EVENT_WAIT_S)
    else:
        scanned, complete = shared
        events = [event for event in scanned if event["sequence"] > cursor]
        if complete:
            # Events written during this pass (an accepted Fast lets Core start
            # the next message's Fast at once) are read from the scan's end.
            tail = max([cursor] + [event["sequence"] for event in scanned])
            events += journal.shared(worker).read(worker.client, tail, 100, timeout_s=EVENT_WAIT_S)
        elif not events:
            return  # The bounded scan did not reach this watch yet.
    ids = set(data.get("matched_runs", []))
    for start in range(0, len(events), 100):  # The matcher takes pages of 100.
        ids |= set(worker.client.matching_run_ids(events[start:start + 100], data["intake"]))
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
    if single(worker):
        return False
    drive_admission(worker)
    rows = worker.ledger.pending_inputs()
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
    try:
        shared = scan(worker, watches)
    except Exception:
        shared = None  # Each watch falls back to its own bounded read.
    for data in watches:
        try:
            observe(fast_worker, data, shared)
        except Exception:
            try:
                from .fast_watch_giveup import give_up
                if give_up(fast_worker, data):
                    continue
            except Exception:
                pass  # Failed local give-up cannot imply a native outcome.
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
