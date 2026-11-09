"""FIFO authenticated owner/member intake, independent of companion presentation."""
import sys
from .execution_mode import single
from .intake import admit, window
from .auto_steer import in_rust
from .ledger import LOCAL_ROLES

MAX_ADMISSIONS = 64
MAX_WINDOW_ATTEMPTS = 64
ISOLATED_ROLES = ("owner", "member")


def individual(worker, data):
    return ((single(worker, data) or worker.fast_reply_policy == "owner_only") and
            (data.get("author") or {}).get("role") in ISOLATED_ROLES and not data.get("origin"))


def eligible(worker, data):
    """Explicit binding consent plus the author verified at HTTP intake."""
    return (individual(worker, data) and data.get("phase") != "completed" and not data.get("origin") and
            not any(data.get(key) for key in
                    ("blocked", "digest", "refused", "absorbed_into", "burst", "requeued", "steer")))
# A deadline-continued or re-admitted owner row is an ordinary owner event
# again: it is admitted here at once (its own continuation fence still
# applies in intake.admit) instead of holding every later owner message's
# admission until it reaches the ledger head.


def local_ahead(worker, data):
    """An unadmitted plain V1-local row (local agent, V1 owner or V1 external
    input, e.g. a watcher alert) that drive() may admit ahead of a person's
    later input, exactly as the serial head path would admit it: once, in
    FIFO order, with its own burst. Before, such a row waited for the running
    Deep turn on the serial path and held every later owner message and
    its execution heartbeat."""
    return ((single(worker, data) or worker.fast_reply_policy == "owner_only") and not data.get("origin") and
            (data.get("author") or {}).get("role") in LOCAL_ROLES and
            data.get("phase") in ("queued", "admitted") and "intake" not in data and
            not any(data.get(key) for key in
                    ("blocked", "digest", "refused", "absorbed_into", "requeued", "continued", "steer")))


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


def drive(worker):
    """Admit and queue original inputs once, even while the head is busy."""
    if not single(worker) and worker.fast_reply_policy != "owner_only":
        return False
    rows = worker.ledger.pending_inputs()
    waiting = [index for index, data in enumerate(rows)
               if eligible(worker, data) and "intake" not in data and not in_rust(data)]
    admissions, absorbed = 0, set()
    for index, data in enumerate(rows):
        if "intake" in data or in_rust(data) or data["remote_id"] in absorbed:
            # A steer Rust already holds never needs FIFO admission before a
            # later input: it either joins the running turn or comes back as
            # a fresh message after it. Do not hold later intake on it.
            continue
        if admissions >= MAX_ADMISSIONS:
            break
        if not eligible(worker, data):
            # Never pass an earlier unadmitted input: Core keeps arrival order.
            # A plain V1-local row with a person's input behind it is admitted
            # here in its place, with its own burst (as the serial path would);
            # anything else (a frozen legacy burst, a timer) holds later events.
            if not (local_ahead(worker, data) and any(later > index for later in waiting)):
                break
            if not data.get("fronted"):
                data["fronted"] = True  # Its window is then also requested here, in order.
                worker.ledger.save(data)
            admissions += 1
            try:
                if not admit(worker, data, merge_burst=True):
                    break  # Its burst may still grow; the next pass decides.
            except Exception as error:
                failed(worker, data, error)
                break
            absorbed |= set(data.get("burst") or ())
            continue
        admissions += 1
        try:
            admit(worker, data, merge_burst=False)
        except Exception as error:
            failed(worker, data, error)
            break  # Unknown intake cannot be passed by a later source.
    attempts = 0
    for data in rows:
        if data["remote_id"] in absorbed or data.get("phase") == "completed":
            continue
        if not (eligible(worker, data) or data.get("fronted")) or "intake" not in data or "window" in data:
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
    return any(data.get("phase") != "completed" and (eligible(worker, data) or data.get("fronted")) for data in rows)
