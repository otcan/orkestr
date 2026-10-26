"""Auto-steer: deliver an owner message into the running Deep turn it answers.

When the owner writes while the serial head input's Deep run is still running
(typically answering a question that run asked), the message goes into that
native turn through Rust's supported `POST /steer` route instead of waiting
behind it as a separate turn. The running turn's single final answers both.

Exactly-once:

* Before any I/O the steer request is frozen on the input (`steer`, phase
  `steering`) in one ledger transaction that also proves the input was never
  admitted. From then on no queue path (serial head, independent Fast intake,
  burst merge, stale-input expiry) may admit it; a restart replays the same
  frozen request, which Rust answers idempotently by its request key.
* Only Rust's own delivery state decides the outcome. `acknowledged` folds the
  input into the head (`absorbed_into` + `steered` audit) atomically, so it
  settles with the head's final and never runs again. `rejected`, an
  unconsumed reservation, a refused request or a run that ended before any
  byte was written return it to the ordinary queue (`steer_fallback` audit).
  A queued (not native) steer admission is retired through the supported owner
  route first, so Core never holds a second copy. Written-but-unacknowledged
  delivery is uncertain: it is closed with a visible owner notice and an
  operator alert, never replayed.

Only verified owner chat input is steered, never timer, post, digest, member,
local-agent or web input, and only into a running, currently steerable Deep run
of the binding's own head chat input.
"""
import re
import sys
import time

from .participants import compose
from .rust_client import ClientError

MODES = ("off", "question", "running")
# Rust's ExecutionSteeringRequest bound, in bytes.
STEER_TEXT_LIMIT = 16384
MAX_STEERS_PER_HEAD = 8
# A reservation without native consumption, seen after the handler answered.
RESERVED_GRACE_S = 30
STEER_NOTE = ("[The owner sent this message while you were still working on this turn. It may answer a "
              "question you asked. Take it into account now and continue the same task; your final reply "
              "for this turn also answers this message.]\n\n")
UNKNOWN_NOTICE = ("Your message was sent to the running task, but Orkestr could not confirm it arrived. "
                  "If the reply does not cover it, please send it again.")
QUEUED_NOTICE = ("Your message was queued in Orkestr but could not be added to the running task or confirmed "
                 "as a separate request. If the reply does not cover it, please send it again.")
KEY = re.compile(r"^[A-Za-z0-9:._-]{1,128}$")
TERMINAL_RUN_PHASES = ("awaiting_acceptance", "completed", "failed", "lost", "cancelled", "blocked", "stopped",
                       "interrupted")
# Row markers that mean "not an ordinary unadmitted chat input any more".
NOT_PLAIN = ("origin", "digest", "blocked", "refused", "requeued", "continued", "burst", "absorbed_into", "intake",
             "attachment_request", "steer", "steer_fallback")


def default_mode(config):
    """`auto_steer` binding setting; unset means on (question mode) for an
    owner-only group and off for a group with listed members."""
    value = config.get("auto_steer")
    if value is None:
        return "question" if not config.get("participants") else "off"
    return value


def log(worker, event, row, alert=False, **fields):
    # Identifiers only, never message text.
    extra = "".join(" %s=%s" % item for item in sorted(fields.items()))
    print("%sorkestr-v2-wa-adapter %s conversation=%s input=%s%s"
          % ("ALERT " if alert else "", event, getattr(worker.client, "conversation", "?"), row["remote_id"], extra),
          file=sys.stderr, flush=True)


def steer_text(row):
    text = STEER_NOTE + compose(row)
    quoted = row.get("reply_to") or {}
    if quoted.get("text"):
        text += "\n\n[Replying to: %s]" % " ".join(quoted["text"].split())[:300]
    return text


def candidate_refusal(mode, head, row, now=None):
    """Why `row` may not be steered into `head`'s turn, or None. Pure."""
    if mode not in MODES or mode == "off":
        return "disabled"
    if row.get("remote_id") == head.get("remote_id"):
        return "same_input"
    if (row.get("author") or {}).get("role") != "owner":
        return "not_owner"
    if row.get("phase") != "queued" or any(row.get(key) for key in NOT_PLAIN):
        return "not_plain_queued_input"
    if row.get("attachments"):
        return "attachments"
    if not (row.get("text") or "").strip():
        return "empty"
    if len(steer_text(row).encode()) > STEER_TEXT_LIMIT:
        return "too_long"
    for key in ("chat_id", "account_id", "public_thread_id"):
        if row.get(key) != head.get(key):
            return "other_chat"
    if head.get("origin") or head.get("digest") or head.get("refused") or head.get("phase") == "completed":
        return "head_not_chat_input"
    if "window" not in head or "intake" not in head or not head.get("matched_runs"):
        return "head_not_running"
    if head.get("deep_final_ready_at") or head.get("deep_accept_request") or "deep" in (head.get("accepted") or {}):
        return "head_final_ready"
    if len(head.get("steered") or []) >= MAX_STEERS_PER_HEAD:
        return "steer_limit"
    return None


def run_refusal(mode, head, row, deep):
    """Why the head's Deep status is not a steerable target for `row`, or None. Pure."""
    if not isinstance(deep, dict) or deep.get("run_id") not in (head.get("matched_runs") or []):
        return "no_own_deep_run"
    if deep.get("phase") != "running":
        return "run_not_running"
    if (deep.get("capabilities") or {}).get("steer") is not True:
        return "run_not_steerable"
    if type(deep.get("revision")) is not int or type(deep.get("control_revision")) is not int or deep["control_revision"] < 1:
        return "run_revision_unknown"
    if mode == "question":
        arrived = row.get("queued_at")
        asked = [q for q in head.get("questions_asked") or []
                 if q.get("run_id") == deep["run_id"] and isinstance(q.get("at"), (int, float))]
        if not asked or not isinstance(arrived, (int, float)) or min(q["at"] for q in asked) > arrived:
            return "no_open_question"
    return None


def decide(mode, head, row, deep):
    """(steer?, reason) for one candidate behind the head. Pure."""
    reason = candidate_refusal(mode, head, row) or run_refusal(mode, head, row, deep)
    return (reason is None, reason or "steerable")


def holds(row):
    """Whether a steer decision owns this row (no queue path may admit it)."""
    return bool(row.get("steer"))


def drive(worker):
    """One bounded pass: settle pending steers, then consider one new one.

    Runs before independent Fast intake so a fresh owner message is decided
    before anything admits it. Never raises: failures retry next pass."""
    mode = getattr(worker, "auto_steer", "off")
    try:
        rows = worker.ledger.pending_inputs()
    except Exception:
        return False
    busy = False
    for row in rows:
        if holds(row):
            busy = True
            try:
                resolve(worker, row)
            except Exception as error:
                transient_failure(worker, row, error)
    if mode == "off" or len(rows) < 2 or busy:
        return busy
    head, row = rows[0], rows[1]
    if holds(head) or candidate_refusal(mode, head, row):
        return busy
    try:
        deep = worker.own_statuses(set(head["matched_runs"]), roles=("deep",))["deep"]
        steer, reason = decide(mode, head, row, deep)
        if not steer:
            return busy
        request = {"control": {"run_id": deep["run_id"], "expected_revision": deep["revision"],
                               "expected_control_revision": deep["control_revision"],
                               "request_key": "auto-steer:" + row["remote_id"]},
                   "text": steer_text(row)}
        record = {"request": request, "head": head["remote_id"], "run_id": deep["run_id"], "mode": mode,
                  "decided_at": time.time()}
        if not worker.ledger.begin_steer(row, record):
            return busy
        log(worker, "auto_steer_started", row, head=head["remote_id"], run=deep["run_id"], mode=mode)
        submit(worker, row)
    except Exception as error:
        if holds(row):
            transient_failure(worker, row, error)
    return True


def transient_failure(worker, row, error):
    from .worker import transient
    if not holds(row):
        return
    if transient(error) or "receipt" in row["steer"]:
        # Once Rust admitted the steer, only its own delivery state may decide:
        # an unexpected error never re-queues (that could run it twice).
        # Retried every pass with the same frozen request; logged once per input.
        seen = worker.__dict__.setdefault("_steer_retry_logged", set())
        if row["remote_id"] not in seen:
            seen.add(row["remote_id"])
            log(worker, "auto_steer_retry", row, alert=not transient(error),
                code=getattr(error, "code", None) or type(error).__name__)
    else:
        fallback(worker, row, "steer_error:%s" % getattr(error, "status", getattr(error, "code", "error")))


def submit(worker, row):
    """Send the frozen request once more (idempotent) and record its receipt."""
    steer = row["steer"]
    request = steer["request"]
    try:
        receipt = worker.call("POST", "/steer", request)
    except ClientError as error:
        from .worker import transient
        if transient(error):
            raise
        # A definite 4xx refusal commits nothing: no Core message exists.
        return fallback(worker, row, "steer_refused:%s" % error.status)
    control = request["control"]
    if (not isinstance(receipt, dict) or receipt.get("run_id") != control["run_id"] or
            receipt.get("request_key") != control["request_key"] or
            not all(isinstance(receipt.get(k), str) and receipt[k] for k in ("message_id", "event_id")) or
            receipt.get("disposition") not in ("reserved", "queued_unsupported", "queued_ordered")):
        raise ValueError("steer_receipt_shape")
    steer["receipt"] = receipt
    steer["receipt_at"] = time.time()
    worker.ledger.save(row)
    if receipt["disposition"] != "reserved":
        return retire_queued(worker, row)
    return resolve(worker, row)


def status(worker, row):
    """Rust's delivery state for this steer, or None when none was admitted."""
    key = row["steer"]["request"]["control"]["request_key"]
    code, value = worker.client.request("GET", "/steering/" + key, allowed=(200, 404))
    if code == 404:
        return None
    if (not isinstance(value, dict) or (value.get("receipt") or {}).get("request_key") != key or
            value.get("state") not in ("queued", "reserved", "delivery_unknown", "acknowledged", "rejected") or
            type(value.get("written_bytes")) is not int):
        raise ValueError("steer_status_shape")
    return value


def run_running(worker, row):
    run = row["steer"]["run_id"]
    deep = worker.own_statuses({run}, roles=("deep",))["deep"]
    return isinstance(deep, dict) and deep.get("run_id") == run and deep.get("phase") not in TERMINAL_RUN_PHASES


def resolve(worker, row):
    """Advance one pending steer to consumed, fallback or uncertain."""
    steer = row["steer"]
    if "receipt" not in steer:
        value = status(worker, row)
        if value is None:
            # Nothing was admitted: send again while the run is steerable.
            if run_running(worker, row):
                return submit(worker, row)
            return fallback(worker, row, "run_ended_before_steer")
        steer["receipt"] = value["receipt"]
        steer["receipt_at"] = time.time()
        worker.ledger.save(row)
        if value["receipt"].get("disposition") != "reserved":
            return retire_queued(worker, row)
    if steer.get("retire"):
        return retire_queued(worker, row)
    value = status(worker, row)
    if value is None:
        raise ValueError("steer_status_missing")
    state, written = value["state"], value["written_bytes"]
    audit = {"state": state, "written_bytes": written, "receipt": steer["receipt"], "run_id": steer["run_id"],
             "mode": steer.get("mode"), "decided_at": steer.get("decided_at"), "resolved_at": time.time()}
    if state == "acknowledged":
        worker.ledger.steered(row, steer["head"], audit)
        return log(worker, "auto_steer_consumed", row, head=steer["head"], run=steer["run_id"])
    if state == "rejected":
        # Rust keeps a natively rejected steer consumed: it never runs on its own.
        return fallback(worker, row, "steer_rejected", audit)
    if state == "queued":
        return retire_queued(worker, row)
    running = run_running(worker, row)
    if state == "reserved":
        if running and time.time() - steer.get("receipt_at", 0) < RESERVED_GRACE_S:
            return None
        # Never consumed by a write grant: no byte reached the provider.
        return fallback(worker, row, "steer_not_consumed", audit)
    # delivery_unknown
    if running:
        return None  # The native turn may still write and acknowledge it.
    if written == 0:
        return fallback(worker, row, "steer_not_written", audit)
    worker.ledger.refuse(dict(row, steered_uncertain=audit), "steer_delivery_unknown", alert=True,
                         notice={"text": UNKNOWN_NOTICE})
    log(worker, "auto_steer_delivery_unknown", row, alert=True, run=steer["run_id"])


def retire_queued(worker, row):
    """A queued (not native) steer admission is an ordinary Core message no
    window will run: retire it, then queue the input the ordinary way."""
    steer = row["steer"]
    receipt = steer["receipt"]
    if not steer.get("retire"):
        steer["retire"] = {"request_key": "auto-steer-retire:" + row["remote_id"],
                           "reason": "auto_steer_not_native"}
        worker.ledger.save(row)
    try:
        code, value = worker.client.request("POST", "/inputs/%s/retire" % receipt["message_id"],
                                            body=steer["retire"], allowed=(200, 201))
    except ClientError as error:
        from .worker import transient
        if transient(error):
            raise
        # It may already be running somewhere: never send a second copy.
        worker.ledger.refuse(dict(row, steered_uncertain={"receipt": receipt, "retire_status": error.status}),
                             "steer_queued_unretired", alert=True, notice={"text": QUEUED_NOTICE})
        return log(worker, "auto_steer_queued_unretired", row, alert=True, status=error.status)
    if not isinstance(value, dict) or value.get("message_id") != receipt["message_id"] or value.get("state") != "retired":
        raise ValueError("retire_receipt_shape")
    return fallback(worker, row, "steer_queued_%s" % receipt["disposition"], {"receipt": receipt, "retired": value})


def fallback(worker, row, reason, audit=None):
    worker.ledger.unsteer(row, reason, audit)
    log(worker, "auto_steer_fallback", row, reason=reason)
