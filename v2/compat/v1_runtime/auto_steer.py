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
  operator alert, never replayed, as is a hold that finds no definite outcome
  within STEER_MAX_HOLD_S. `written_bytes == 0` is strong evidence that
  nothing reached the provider, not strict proof (see README).

Only verified owner chat input is steered, never timer, post, digest, member,
local-agent or web input, and only into a running, currently steerable Deep run
of the binding's own head chat input.
"""
import sys
import time

from .notices import TEMPLATES
from .participants import compose
from .rust_client import ClientError

MODES = ("off", "question", "running")
# Rust's ExecutionSteeringRequest bound, in bytes.
STEER_TEXT_LIMIT = 16384
MAX_STEERS_PER_HEAD = 8
# A reservation without native consumption, seen after the handler answered.
RESERVED_GRACE_S = 30
# A held input never waits longer than this for a definite outcome: it is then
# closed with a visible notice and an operator alert (never replayed).
STEER_MAX_HOLD_S = 20 * 60
STEER_NOTE = ("[The owner sent this message while you were still working on this turn. It may answer a "
              "question you asked. Take it into account now and continue the same task; your final reply "
              "for this turn also answers this message.]\n\n")
# English renderings; the ledger sends them in the chat's language.
UNKNOWN_NOTICE = TEMPLATES["steer_unknown"]["en"]
QUEUED_NOTICE = TEMPLATES["steer_queued"]["en"]
TERMINAL_RUN_PHASES = ("awaiting_acceptance", "completed", "failed", "lost", "cancelled", "blocked", "stopped",
                       "interrupted")
# Row markers that mean "not an ordinary unadmitted chat input any more".
# Admission state counts by key presence: intake saves `burst: []` (and a
# window request) before its POST, whose outcome may be unknown.
ADMISSION_KEYS = ("intake", "burst", "window", "window_request", "attachment_request", "steer", "steer_fallback")
NOT_PLAIN = ("origin", "digest", "blocked", "refused", "requeued", "continued", "absorbed_into")


def admission_started(row):
    return any(key in row for key in ADMISSION_KEYS) or any(row.get(key) for key in NOT_PLAIN)


def default_mode(config):
    """`auto_steer` binding setting; unset means off (enable per binding)."""
    return config.get("auto_steer") or "off"


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


def candidate_refusal(mode, head, row):
    """Why `row` may not be steered into `head`'s turn, or None. Pure."""
    if mode not in MODES or mode == "off":
        return "disabled"
    if row.get("remote_id") == head.get("remote_id"):
        return "same_input"
    if (row.get("author") or {}).get("role") != "owner":
        return "not_owner"
    if row.get("phase") != "queued" or admission_started(row):
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
    if mode == "question" and not question_before(head, row):
        # Checked again for the exact run; this only spares status reads.
        return "no_open_question"
    return None


def question_before(head, row, run_id=None):
    arrived = row.get("queued_at")
    asked = [q["at"] for q in head.get("questions_asked") or []
             if isinstance(q, dict) and isinstance(q.get("at"), (int, float)) and
             (run_id is None or q.get("run_id") == run_id)]
    return bool(asked) and isinstance(arrived, (int, float)) and min(asked) <= arrived


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
    if mode == "question" and not question_before(head, row, deep["run_id"]):
        return "no_open_question"
    return None


def decide(mode, head, row, deep):
    """(steer?, reason) for one candidate behind the head. Pure."""
    reason = candidate_refusal(mode, head, row) or run_refusal(mode, head, row, deep)
    return (reason is None, reason or "steerable")


def holds(row):
    """Whether a steer decision owns this row (no queue path may admit it)."""
    return bool(row.get("steer"))


def in_rust(row):
    """A held row whose steer Rust already admitted: it can never need ordinary
    FIFO admission again before a later input (its fallback is a new message)."""
    return holds(row) and "receipt" in row["steer"]


def hold_expired(worker, row, now=None):
    """Close a held input that found no definite outcome in time."""
    now = time.time() if now is None else now
    decided = row["steer"].get("decided_at")
    if not isinstance(decided, (int, float)) or now - decided < STEER_MAX_HOLD_S:
        return False
    worker.ledger.refuse(dict(row, steered_uncertain={"reason": "hold_expired", "receipt": row["steer"].get("receipt")}),
                         "steer_hold_expired", alert=True, notice={"text": UNKNOWN_NOTICE})
    log(worker, "auto_steer_hold_expired", row, alert=True, receipt="receipt" in row["steer"])
    return True


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
            try:
                current = worker.ledger.input(row["remote_id"])
                if holds(current) and current.get("phase") == "steering":
                    hold_expired(worker, current)
            except Exception as error:
                log(worker, "auto_steer_expiry_failed", row, alert=True, code=type(error).__name__)
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
    client = isinstance(error, ClientError)
    if (client and transient(error)) or not client or "receipt" in row["steer"]:
        # Once Rust admitted the steer, only its own delivery state may decide:
        # an unexpected error never re-queues (that could run it twice). A
        # shape/ledger error is not a transport hiccup: it alerts. Retried
        # every pass (bounded by STEER_MAX_HOLD_S); logged once per input and
        # error class so a later, different failure is still reported.
        code = getattr(error, "code", None) if client else None
        kind = "%s:%s:%s" % (type(error).__name__, code, getattr(error, "status", None))
        seen = worker.__dict__.setdefault("_steer_retry_logged", set())
        if (row["remote_id"], kind) not in seen:
            seen.add((row["remote_id"], kind))
            log(worker, "auto_steer_retry", row, alert=not (client and transient(error)),
                error=type(error).__name__, code=code or getattr(error, "status", None) or str(error)[:64])
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
        # A refusal before Rust's admission transaction commits nothing, but the
        # handler can also refuse after it (for example while consuming the
        # reservation), leaving a consumed Core message. Rust's steering record
        # tells the two apart: no record means nothing was admitted.
        value = status(worker, row)
        if value is None:
            return fallback(worker, row, "steer_refused:%s" % error.status)
        return adopt(worker, row, value["receipt"])
    control = request["control"]
    if (not isinstance(receipt, dict) or receipt.get("run_id") != control["run_id"] or
            receipt.get("request_key") != control["request_key"] or
            not all(isinstance(receipt.get(k), str) and receipt[k] for k in ("message_id", "event_id")) or
            receipt.get("disposition") not in ("reserved", "queued_unsupported", "queued_ordered")):
        raise ValueError("steer_receipt_shape")
    return adopt(worker, row, receipt)


def adopt(worker, row, receipt):
    """Record Rust's receipt; its Core message is this adapter's own (never mirrored)."""
    steer = row["steer"]
    steer["receipt"] = receipt
    steer["receipt_at"] = time.time()
    own = row.setdefault("own_messages", [])
    if isinstance(receipt.get("message_id"), str) and receipt["message_id"] not in own:
        own.append(receipt["message_id"])
    worker.ledger.save(row)
    if receipt.get("disposition") != "reserved":
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
        return adopt(worker, row, value["receipt"])
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


CARRY_NOTE = "[Messages the owner added to the previous turn while it was running:]"


def carry(ledger, head, text):
    """A continuation of a turn that took steered messages carries their text,
    so a stopped turn's new attempt cannot drop them. They still settle with it."""
    texts = []
    for remote_id in head.get("steered") or ():
        row = ledger.input(remote_id)
        if row and isinstance(row.get("text"), str) and row["text"].strip():
            texts.append(compose(row))
    return text + "\n\n" + CARRY_NOTE + "\n\n" + "\n\n".join(texts) if texts else text


def fallback(worker, row, reason, audit=None):
    worker.ledger.unsteer(row, reason, audit)
    log(worker, "auto_steer_fallback", row, reason=reason)
