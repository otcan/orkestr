"""One guarded re-admission of a stranded chat input, or one honest notice.

An input whose attempt ended for good (a terminal Deep, or a window that ended
before its Deep started) settles instead of staying `running`. It is retried
automatically, once and silently, only when Core itself proves that nothing of
the original ran or can still run: the adapter first retires the original Core
input through the owner route `POST /inputs/<message>/retire`. Core allows that
only while the inbox row is still queued, no run (Fast or Deep) references
the message, it is in no open window and no window intent is queued for it
(store-sqlite `retired_inputs.rs`). That one gate also covers an input Core
handed to a successor window, an input an owner stop moved to the held
inputs, and a run that never emitted a journal observation. Only after a
successful retirement is the input admitted again under fresh keys:

* younger than MAX_AGE_S from its original `arrived_at` (rows written before
  this field existed are treated as possibly started and never retried);
* no final or uncertain export, no accepted Deep, never retried before, not a
  deadline continuation, and the journal read through Core's current head
  (a non-streaming snapshot read, not a bounded stream read);
* never a timer occurrence: Core owns timer retries (`stranded_open.rs`), so
  the adapter only reports a failed occurrence;
* the original public and remote IDs stay; the retired Core message, window
  and runs are kept in `readmitted.previous` and in `own_messages`.

When Core refuses the retirement it still owns the input (for example in a
successor window): the adapter keeps matching and waiting, at most
RETIRE_WAIT_S, then closes it as before this change. A terminal Deep always
has a run, so it is never retried: the input closes with one notice in the
chat's language plus an operator ALERT. Older than MAX_AGE_S: settled
silently (no export) with an ALERT (no historic replay).

The same retirement-gated re-admission is available to an operator (`main`):
the command records a request row; the live binding worker decides and
performs it in-process on its own thread.
"""
import argparse
import json
import os
import sqlite3
import sys
import time
import uuid

MAX_AGE_S = 24 * 3600
# A continued row from an adapter that did not record `arrived_at` may have
# arrived up to one window ceiling before its continuation.
LEGACY_CONTINUED_MARGIN_S = 5 * 3600
# An operator request that cannot be decided within this time is refused.
REQUEST_MAX_PENDING_S = 600
REQUESTS_PER_PASS = 4


def initialize(db):
    db.execute("CREATE TABLE IF NOT EXISTS readmit_requests (request_key TEXT PRIMARY KEY, "
               "public_id TEXT UNIQUE NOT NULL, data TEXT NOT NULL)")


def arrival(data):
    """Original arrival time (seconds), conservative for legacy rows."""
    if isinstance(data.get("arrived_at"), (int, float)):
        return data["arrived_at"]
    times = [data.get(k) for k in ("queued_at", "admitted_at")]
    times.append((data.get("continued") or {}).get("at"))
    times = [t for t in times if isinstance(t, (int, float))]
    if not times:
        return None
    return min(times) - (LEGACY_CONTINUED_MARGIN_S if data.get("continued") else 0)


def too_old(data, now):
    since = arrival(data)
    return since is None or now - since >= MAX_AGE_S


def log(worker, event, data, alert=False, **fields):
    # Identifiers only, never message text.
    extra = "".join(" %s=%s" % item for item in sorted(fields.items()))
    print("%sorkestr-v2-wa-adapter %s conversation=%s input=%s%s"
          % ("ALERT " if alert else "", event, getattr(worker.client, "conversation", "?"), data["remote_id"], extra),
          file=sys.stderr, flush=True)


def blocking_export(ledger, data):
    """A final reply or an uncertain delivery already exists for this input."""
    with ledger.connect() as db:
        return db.execute("SELECT 1 FROM exports WHERE input_id=? AND (kind='final' OR outcome='uncertain') LIMIT 1",
                          (data["remote_id"],)).fetchone() is not None


def readmit(worker, data, trigger, reason, request_key=None, operator=None):
    """Turn `data` into a fresh, unadmitted turn of the same input. Ledger only."""
    from .worker import RESET_KEYS
    from .participants import compose
    from .auto_steer import carry
    window = data.get("window") or {}
    previous = {"message_id": (data.get("intake") or {}).get("message_id"),
                "event_id": (data.get("intake") or {}).get("event_id"),
                "window_id": (window.get("status") or {}).get("window_id") or window.get("window_id"),
                "runs": list(data.get("matched_runs") or []),
                "phase": data.get("phase")}
    record = {"at": time.time(), "trigger": trigger, "reason": reason, "previous": previous}
    if request_key:
        record.update(request_key=request_key, operator=operator)
    if data.get("continued"):
        record["continued"] = data.pop("continued")
    data.pop("continuation_guard", None)
    if data.get("steered"):
        # Messages steered into the failed turn ride along; they settle with it.
        data["intake_text"] = carry(worker.ledger, data, data.get("intake_text") or compose(data))
    if "arrived_at" not in data and arrival(data) is not None:
        data["arrived_at"] = arrival(data)
    for key in RESET_KEYS + ("deep_missing_since", "unstarted_since", "terminal_since", "retry_wait_since", "ended_seen_at", "closed"):
        data.pop(key, None)
    for key in ("message", "window", "fast", "deep"):
        data["keys"][key] = str(uuid.uuid4())
    data.update(phase="queued", queued_at=time.time(), readmitted=record)
    with worker.ledger.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        worker.ledger.save(data, db)
        # The previous attempt's Fast follow-up is over; its exports stay.
        db.execute("UPDATE fast_watch SET closed=1 WHERE input_id=? AND closed=0", (data["remote_id"],))
    log(worker, "input_readmitted", data, trigger=trigger, reason=reason,
        previous_message=previous["message_id"] or "none")


def recover(worker, data, reason, started=False):
    """The input's attempt ended for good. Retry it once, or close it.

    `started`: a Deep run of this input exists or may have acted. Returns True
    when handled (retried, briefly waiting, or settled); raises the worker's
    Refused (one notice + ALERT) otherwise. The serial queue waits only while
    Core may still run the input itself, at most RETIRE_WAIT_S."""
    from .worker import Refused
    now = time.time()
    if too_old(data, now):
        worker.ledger.finish_silently(data, "suppressed")
        log(worker, "input_failed_too_old", data, alert=True, reason=reason)
        return True
    timer = data.get("origin") == "timer"
    if not timer and held(worker, data) == "held":
        # An owner stop moved it to Core's held inputs: honour the stop. Core
        # would still retire a held queued row, so the adapter itself refuses.
        worker.ledger.finish_silently(data, "held")
        log(worker, "input_closed_owner_stop", data, reason=reason)
        return True
    if started or ("arrived_at" not in data and not timer):
        data["retry_withheld"] = "run_started" if started else "pre_upgrade_row"
        raise Refused(reason)
    if timer:
        raise Refused(reason)  # Core retries timer occurrences itself.
    if data.get("readmitted") or data.get("continued") or blocking_export(worker.ledger, data):
        raise Refused(reason)
    if not journal_caught_up(worker, data):
        return wait_or_close(worker, data, now, reason, "journal_behind")
    state = own_window_state(worker, data)
    if state in ("successor_open", "successor_queued", "reconciliation_required"):
        # Core may hand the joined-but-unrun input to that window and run it.
        data.pop("ended_seen_at", None)
        return wait_or_close(worker, data, now, reason, state)
    if state != "ended":
        raise Refused(reason)
    # "Ended, no successor" must hold on two observations ENDED_CONFIRM_S
    # apart: a requeue can precede the dispatcher's next poll.
    seen = data.setdefault("ended_seen_at", now)
    if seen == now:
        worker.ledger.save(data)
    if now - seen < ENDED_CONFIRM_S:
        return True
    if data.get("matched_runs") or held(worker, data) != "not_held":
        # A run references the message (often its Fast), so Core will never
        # retire it: close now instead of holding the chat's queue.
        data["retry_withheld"] = "run_exists" if data.get("matched_runs") else "hold_unknown"
        raise Refused(reason)
    if retire_original(worker, data) != "retired":
        return wait_or_close(worker, data, now, reason, "retire_refused")
    readmit(worker, data, "automatic", reason)
    return True


# Core may still run the input itself (a newer open window, a queued window
# intent, reconciliation): the serial queue waits at most this long, with one
# operator ALERT when the wait starts, then the input is closed.
RETIRE_WAIT_S = 600
ENDED_CONFIRM_S = 30


def wait_or_close(worker, data, now, reason, why):
    from .worker import Refused
    since = data.get("retry_wait_since")
    if since is None:
        data["retry_wait_since"] = since = now
        worker.ledger.save(data)
        log(worker, "input_waiting_for_core", data, alert=True, reason=reason, wait=why)
    if now - since < RETIRE_WAIT_S:
        return True
    raise Refused(reason)


def held(worker, data):
    """'held' / 'not_held' / 'unknown' from Core's held-input page."""
    message = (data.get("intake") or {}).get("message_id")
    if not message:
        return "not_held"
    try:
        page = worker.call("GET", "/held-inputs")
    except Exception as error:
        from .worker import transient
        if transient(error):
            raise
        return "unknown"
    rows = page.get("held") if isinstance(page, dict) else None
    if not isinstance(rows, list):
        return "unknown"
    if any(isinstance(row, dict) and row.get("message_id") == message for row in rows):
        return "held"
    return "not_held" if page.get("next_after_sequence") is None else "unknown"


def journal_caught_up(worker, data):
    """Core's current journal head (a non-streaming snapshot read) is no
    later than this input's own cursor: no unread run evidence remains."""
    snapshot = worker.call("GET", "")
    head = snapshot.get("last_sequence") if isinstance(snapshot, dict) else None
    cursor = data.get("cursor")
    return type(head) is int and type(cursor) is int and head <= cursor


def retire_original(worker, data):
    """'retired' when Core retired the original input, else 'conflict'."""
    from .rust_client import ClientError
    from .worker import transient
    message = (data.get("intake") or {}).get("message_id")
    if not message:
        return "retired" if "intake" not in data and "window" not in data else "conflict"
    body = {"request_key": ("adapter-readmit:" + message)[:128], "reason": "adapter_readmit"}
    try:
        status, value = worker.client.request("POST", "/inputs/%s/retire" % message, body=body, allowed=(200, 201))
    except ClientError as error:
        if transient(error):
            raise
        return "conflict"  # 409 (still queued elsewhere, held, run, open window) or 404.
    if not isinstance(value, dict) or value.get("message_id") != message or value.get("state") != "retired":
        return "conflict"
    data["retired_original"] = {k: value.get(k) for k in ("retirement_id", "message_id", "event_id", "retired_at_ms")}
    return "retired"


def own_window_state(worker, data):
    """'ended', 'reconciliation_required' or 'live' for the input's own window."""
    window = data.get("window") or {}
    own = (window.get("status") or {}).get("window_id") or window.get("window_id")
    current = worker.call("GET", "/window", allowed=(200, 204))
    if (isinstance(current, dict) and current.get("state") == "reconciliation_required" and
            (own is None or current.get("window_id") == own)):
        return "reconciliation_required"
    if not worker.window_ended(data):
        return "live"
    if (isinstance(current, dict) and own is not None and current.get("window_id") != own and
            current.get("state") in ("opening", "active")):
        return "successor_open"
    if queued_for(worker, data) != "not_queued":
        # Core requeued the joined-but-unrun input for a successor window the
        # dispatcher has not opened yet: the old window already reads closed.
        return "successor_queued"
    return "ended"


def queued_for(worker, data):
    """'queued' / 'not_queued' / 'unknown': a window request for this input's
    own event waits in Core's window queue."""
    from .rust_client import ClientError
    event = (data.get("intake") or {}).get("event_id")
    if not event:
        return "not_queued"
    try:
        value = worker.call("GET", "/window/queue")
    except ClientError as error:
        from .worker import transient
        if transient(error):
            raise
        return "not_queued" if error.status == 404 else "unknown"  # 404: no window queue configured.
    entries = value.get("entries") if isinstance(value, dict) else None
    if not isinstance(entries, list):
        return "unknown"
    return "queued" if any(isinstance(e, dict) and e.get("input_event_id") == event and
                           e.get("state") == "queued" for e in entries) else "not_queued"


# Operator re-admission ------------------------------------------------------
def check(worker, data, now):
    """Why the operator re-admission of `data` is refused before Core's
    retirement gate, or None."""
    if data.get("origin"):
        return "not_chat_input"
    if data.get("phase") == "completed" or data.get("settled"):
        return "input_completed"
    if too_old(data, now):
        return "older_than_24h"
    if data.get("readmitted"):
        return "already_readmitted"
    if data.get("steer") or data.get("absorbed_into"):
        return "input_held"
    if "deep" in (data.get("accepted") or {}) or "deep_accept_request" in data:
        return "deep_accepted"
    if blocking_export(worker.ledger, data):
        return "final_or_uncertain_export"
    if own_window_state(worker, data) != "ended":
        return "window_live"
    if held(worker, data) != "not_held":
        return "input_held"  # An owner stop is never undone.
    return None


def drive(worker):
    """Decide pending operator requests of this binding (worker thread only)."""
    with worker.ledger.connect() as db:
        rows = db.execute("SELECT request_key,public_id,data FROM readmit_requests "
                          "WHERE json_extract(data,'$.state')='requested' ORDER BY rowid LIMIT ?",
                          (REQUESTS_PER_PASS,)).fetchall()
    for key, public_id, raw in rows:
        request = json.loads(raw)
        now = time.time()
        with worker.ledger.connect() as db:
            row = db.execute("SELECT data FROM inputs WHERE public_id=?", (public_id,)).fetchone()
        data = json.loads(row[0]) if row else None
        try:
            reason = "unknown_input" if data is None else check(worker, data, now)
        except Exception as error:
            # Unknown outcome: decide again next pass, bounded by the request age.
            if now - request.get("requested_at", now) < REQUEST_MAX_PENDING_S:
                continue
            reason = "stale_request:" + type(error).__name__
        if reason is None:
            try:
                retired = retire_original(worker, data)
            except Exception:
                if now - request.get("requested_at", now) < REQUEST_MAX_PENDING_S:
                    continue
                retired = "conflict"
            reason = None if retired == "retired" else "core_still_owns_input"
        if reason is None:
            readmit(worker, data, "operator", "operator_request", key, request.get("operator"))
            request.update(state="readmitted", input_id=data["remote_id"])
        else:
            request.update(state="refused", reason=reason)
            if data is not None:
                log(worker, "readmit_refused", data, reason=reason)
        request["decided_at"] = now
        with worker.ledger.connect() as db:
            db.execute("UPDATE readmit_requests SET data=? WHERE request_key=?", (json.dumps(request), key))


def request(path, public_id, request_key, operator):
    """Record one operator request (idempotent by request key). Returns its row."""
    if os.path.islink(path) or not os.path.isfile(path):
        raise ValueError("ledger_path")
    if os.stat(path).st_uid != os.geteuid():
        # Run as the adapter service user: a SQLite journal created by another
        # user (for example root through sudo) would lock the service out.
        raise ValueError("run_as_ledger_owner")
    db = sqlite3.connect(path, timeout=5)
    try:
        with db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ledger_scope'").fetchone():
                raise ValueError("not_a_ledger")
            initialize(db)
            row = db.execute("SELECT public_id,data FROM readmit_requests WHERE request_key=?", (request_key,)).fetchone()
            if row:
                if row[0] != public_id:
                    raise ValueError("request_key_reused")
                return dict(json.loads(row[1]), duplicate=True)
            if db.execute("SELECT 1 FROM readmit_requests WHERE public_id=?", (public_id,)).fetchone():
                raise ValueError("recovery_already_requested")
            found = db.execute("SELECT data FROM inputs WHERE public_id=?", (public_id,)).fetchone()
            if not found:
                raise ValueError("unknown_input")
            if too_old(json.loads(found[0]), time.time()):
                raise ValueError("older_than_24h")
            value = {"state": "requested", "public_id": public_id, "operator": operator, "requested_at": time.time()}
            db.execute("INSERT INTO readmit_requests VALUES (?,?,?)", (request_key, public_id, json.dumps(value)))
            return value
    finally:
        db.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Request one guarded re-admission of a stranded input. "
                                     "The running adapter decides and performs it; this only records the request.")
    parser.add_argument("--ledger", required=True, help="the binding's ledger file")
    parser.add_argument("--public-id", required=True, help="the input's public message ID")
    parser.add_argument("--request-key", required=True, help="stable key; repeating it is idempotent")
    parser.add_argument("--operator", required=True, help="who asked (audit)")
    args = parser.parse_args(argv)
    try:
        value = request(args.ledger, args.public_id, args.request_key, args.operator)
    except (ValueError, sqlite3.Error) as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 1
    print(json.dumps(dict(value, ok=True)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
