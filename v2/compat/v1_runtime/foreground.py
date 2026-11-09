"""Foreground head stepping, before independent adapter discovery work."""
import sys
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
        worker.step(data)
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
        stop.wait(4)
    return True
