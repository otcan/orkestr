"""Keep a frozen turn pending when its next transport sent no HTTP bytes."""
import sys


def before_send_refused(error):
    return (getattr(error, "code", None) in ("peer_identity_refused", "peer_connection_refused")
            and getattr(error, "outcome", None) == "refused")


def alert_held(worker, data, error):
    # An unavailable or foreign peer receives nothing. Preserve the original
    # intake/window/acceptance keys until the pinned peer can be proved again.
    # Never apply this to a request with bytes offered and an unknown outcome.
    signature = (data["remote_id"], error.code)
    if getattr(worker, "_peer_refusal_alert", None) != signature:
        worker._peer_refusal_alert = signature
        print("ALERT orkestr-v2-wa-adapter peer_transport_held conversation=%s input=%s code=%s"
              % (getattr(worker.client, "conversation", "?"), data["remote_id"], error.code),
              file=sys.stderr, flush=True)
