"""One guarded re-admission of a failed or stranded chat input.

An input whose own runs all ended without an accepted Deep answer (both
cancelled after a lapsed lease, a failed Deep, a window that closed before
its Deep started) used to stay `running` forever or be refused with a notice
asking the person to resend. Now the adapter itself retries it, exactly once
and silently, as a fresh turn of the same conversation:

* only an input younger than MAX_AGE_S, measured from its original arrival
  (a continuation or re-admission never resets that clock);
* only when the input has no final export and no uncertain delivery, its
  Deep was never accepted, and its own window is over;
* the original public and remote IDs stay; the previous Core message, window
  and runs are kept as an audit record (`readmitted.previous`), and their
  message IDs stay in `own_messages`, so nothing is mirrored back as web input;
* a timer occurrence is retried as an ordinary owner message carrying the
  occurrence's own Core prompt text (read back from the conversation by its
  exact message ID) under a retry note; its answer still goes through Core's
  timer outcome rules for the original claim;
* only when the failed attempt provably never started executing (no Deep run,
  or a Deep run with no start/progress/question evidence in a fully read
  journal). A run that started may already have sent mail or posted, so it is
  never retried: the notice says nothing is retried automatically, and the
  owner can ask for it. `execution_requires_review` is never retried either;
* never twice, and not
  after a deadline continuation (that already was the one automatic retry);
* never while the input's own window is still live: a cancelled Deep in a
  live window is an owner stop (or a provider failure), refused as before.

Only when that one retry also fails does the input close with one notice in
the chat's language (see notices.py) plus an operator ALERT. An input older
than MAX_AGE_S is never retried or announced: it is settled silently (no
export) with an ALERT, following the no-historic-replay rule.

The same re-admission is available to an operator (`main` below). The command
only records a request row in the binding's ledger; the live binding worker
performs every check and the mutation in-process on its own thread, so it is
serialized with all other work on that input and its exports reach V1's
change feed like any other.
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
# Own window still awaiting Core's reconciliation: wait this long for it to close.
RECONCILIATION_WAIT_S = 600
# An operator request that cannot be decided within this time is refused.
REQUEST_MAX_PENDING_S = 600
REQUESTS_PER_PASS = 4
RUN_TERMINAL = ("failed", "lost", "cancelled", "blocked", "stopped", "interrupted")


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
    for key in RESET_KEYS + ("deep_missing_since", "unstarted_since", "terminal_since", "closed"):
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


# Journal observations that prove a provider run actually began executing.
# There is no tool-call evidence in Core's journal, so any of these means the
# run may already have acted (sent mail, posted, applied) and is never retried.
STARTED_OBSERVATIONS = ("started", "progress_ref", "approval_requested", "completed_proposal")
STARTED_LIMIT = 32


def note_started(data, events, ids):
    """Record own runs whose journal shows they began executing."""
    seen = data.get("started_runs") or []
    for event in events:
        payload = event.get("payload_ref_or_safe_payload") or {}
        observation = payload.get("observation") or {}
        run = payload.get("run_id")
        if (payload.get("kind") == "provider_observed" and run in ids and run not in seen and
                observation.get("kind") in STARTED_OBSERVATIONS and len(seen) < STARTED_LIMIT):
            seen.append(run)
    if seen:
        data["started_runs"] = seen


def run_started(data, deep):
    """Whether this Deep run may have acted: any start evidence, or unknown."""
    if not isinstance(deep, dict):
        return True
    return bool(deep.get("run_id") in (data.get("started_runs") or []) or deep.get("progress") or
                (data.get("activity") or {}).get("run_id") == deep.get("run_id"))


def recover(worker, data, reason, started=False):
    """The input's own attempt failed for good. Retry it once, or close it.

    `started` says the failed Deep run may have acted; such an input is never
    retried (one notice saying so, plus an ALERT). Returns True when handled
    (retried, waiting for Core's reconciliation, or settled); raises the
    worker's Refused otherwise."""
    from .worker import Refused
    now = time.time()
    if too_old(data, now):
        worker.ledger.finish_silently(data, "suppressed")
        log(worker, "input_failed_too_old", data, alert=True, reason=reason)
        return True
    if started:
        data["retry_withheld"] = "run_started"  # Side effects possible: a human decides.
        raise Refused(reason)
    if data.get("readmitted") or data.get("continued"):
        raise Refused(reason)  # The one automatic retry also failed.
    if blocking_export(worker.ledger, data):
        raise Refused(reason)
    state = own_window_state(worker, data)
    if state == "reconciliation_required":
        since = data.setdefault("terminal_since", now)
        if since == now:
            worker.ledger.save(data)
        if now - since < RECONCILIATION_WAIT_S:
            return True
        raise Refused(reason)
    if state != "ended":
        raise Refused(reason)
    if data.get("origin") == "timer":
        text = timer_text(worker, data)
        if text is None:
            raise Refused(reason)
        label = (data.get("timer") or {}).get("label") or "Scheduled task"
        data["intake_text"] = TIMER_RETRY_NOTE % label + text
    readmit(worker, data, "automatic", reason)
    return True


TIMER_RETRY_NOTE = ("[Automatic retry of the scheduled task \"%s\": its previous run ended without a result "
                    "because of a technical failure. Run the task below once now.]\n\n")


def timer_text(worker, data):
    """The timer occurrence's own prompt, read back from Core by its exact ID."""
    intake = data.get("intake") or {}
    if type(intake.get("sequence")) is not int or not intake.get("message_id"):
        return None
    from .rust_client import ClientError
    try:
        value = worker.call("GET", "?after=%d&limit=1" % (intake["sequence"] - 1))
    except ClientError as error:
        from .worker import transient
        if transient(error):
            raise
        return None  # A definite refusal: the prompt cannot be proven, no retry.
    rows = value.get("messages") if isinstance(value, dict) else None
    if (not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict) or
            rows[0].get("message_id") != intake["message_id"] or not isinstance(rows[0].get("text"), str) or
            not rows[0]["text"].strip()):
        return None
    return rows[0]["text"]


def own_window_state(worker, data):
    """'ended', 'reconciliation_required' or 'live' for the input's own window."""
    window = data.get("window") or {}
    own = (window.get("status") or {}).get("window_id") or window.get("window_id")
    current = worker.call("GET", "/window", allowed=(200, 204))
    if (isinstance(current, dict) and current.get("state") == "reconciliation_required" and
            (own is None or current.get("window_id") == own)):
        return "reconciliation_required"
    return "ended" if worker.window_ended(data) else "live"


# Operator re-admission ------------------------------------------------------
def run_states(worker, runs):
    """Phase of every own run, by run ID, from its own role's status route."""
    phases = {}
    for run in runs:
        for route in ("/execution", "/fast/execution"):
            status, value = worker.client.request("GET", "%s?run_id=%s" % (route, run), allowed=(200, 404))
            if status == 200 and isinstance(value, dict) and value.get("run_id") == run:
                phases[run] = (route, value.get("phase"))
                break
    return phases


def check(worker, data, now):
    """Why the operator re-admission of `data` is refused, or None."""
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
    current = worker.call("GET", "/window", allowed=(200, 204))
    if isinstance(current, dict) and current.get("state") != "closed":
        return "window_live"
    runs = list(data.get("matched_runs") or [])
    phases = run_states(worker, runs)
    if len(phases) != len(runs):
        return "run_state_unknown"
    for route, phase in phases.values():
        if phase not in RUN_TERMINAL and not (route == "/fast/execution" and phase == "completed"):
            return "run_not_terminal"
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
