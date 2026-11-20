"""Foreground head stepping, before independent adapter discovery work."""
import sys
import time
from contextlib import nullcontext
from . import failure_cause
from .peer_observation import before_send_refused, alert_held


def drive(worker, data, stop):
    # Imported at call time: Worker owns the refusal/transport contracts.
    from .worker import Refused, transient, refusal_reason
    if data.get("blocked"):
        # Written by an earlier adapter version: close it visibly so the
        # inputs behind it proceed.
        worker.ledger.refuse(data, data["blocked"])
        return True
    try:
        gate = getattr(getattr(getattr(worker, "client", None), "session", None), "outbound_gate", None)
        with gate.foreground() if gate is not None else nullcontext():
            worker.step(data)
        reconciling_cleared(worker, data)
    except Refused as error:
        # A definite refusal is terminal for this input only: the owner gets
        # a notice and later inputs proceed. Health keeps it for review.
        # A timer occurrence has no sender who could resend it, so its
        # refusal (a failed, lost or never started run) also alerts the operator.
        timer = data.get("origin") == "timer"
        if worker.ledger.refuse(data, str(error), alert=timer) and timer:
            cause = failure_cause.cause(data, data["refused"]["reason"])
            print("ALERT orkestr-v2-wa-adapter input_failed conversation=%s input=%s phase=%s reason=%s%s"
                  % (getattr(worker.client, "conversation", "?"), data["remote_id"],
                     data["refused"].get("phase"), data["refused"]["reason"], " cause=" + cause if cause else ""),
                  file=sys.stderr, flush=True)
    except Exception as error:
        # Transient failures retry the same frozen request (bounded by the
        # input age limit until a window is open). Definite upstream
        # refusals are terminal like any other refusal.
        if not transient(error):
            worker.ledger.refuse(data, refusal_reason(error), alert=data.get("origin") == "timer")
        elif before_send_refused(error):
            alert_held(worker, data, error)
        elif getattr(error, "code", None) == "session_revoked" and not worker._revoked_alerted:
            # Retried, but never silently: nothing reaches Rust until an
            # operator restores the owner session.
            worker._revoked_alerted = True
            print("ALERT orkestr-v2-wa-adapter session_revoked conversation=%s input=%s"
                  % (getattr(worker.client, "conversation", "?"), data["remote_id"]),
                  file=sys.stderr, flush=True)
        elif getattr(error, "code", None) == "window_reconciling":
            reconciling_wait(worker, data)
        stop.wait(4)
    return True


# GET /window answers 409 while Core reconciles a pausing window. The input
# waits (it is the window's state, not the input's), but never silently: one
# operator alert per input still waiting on it after this long.
RECONCILING_ALERT_S = 120


def reconciling_wait(worker, data, now=None):
    now = time.time() if now is None else now
    since = worker.__dict__.setdefault("_reconciling_since", {})
    alerted = worker.__dict__.setdefault("_reconciling_alerted", set())
    first = since.setdefault(data["remote_id"], now)
    if now - first >= RECONCILING_ALERT_S and data["remote_id"] not in alerted:
        alerted.add(data["remote_id"])
        print("ALERT orkestr-v2-wa-adapter window_reconciling conversation=%s input=%s waiting_s=%d"
              % (getattr(worker.client, "conversation", "?"), data["remote_id"], now - first),
              file=sys.stderr, flush=True)


def reconciling_cleared(worker, data):
    """A step that went through ends that input's wait; a later 409 starts a new one."""
    since = worker.__dict__.get("_reconciling_since")
    if since:
        since.pop(data.get("remote_id"), None)
