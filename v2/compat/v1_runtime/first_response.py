"""One durable interactive Fast reply, independent of ordinary progress or Deep readiness."""
import time

from .ledger import no_reply

MAX_CHARS = 3500
QUESTION_PREFIX = "\u2753 Question while I keep working:\n\n"


def capture(worker, data, statuses, own_runs):
    # Operational timers keep their separate digest/reply rules. Interactive
    # Fast is a reply of its own, independent of the ordinary progress setting.
    if data.get("origin") == "timer" or data.get("first_response"):
        return
    fast, deep = statuses.get("fast"), statuses.get("deep")
    if (not isinstance(fast, dict) or fast.get("run_id") not in own_runs or
            fast.get("phase") not in ("awaiting_acceptance", "completed")):
        return
    now = time.time()
    payload_id = (fast.get("progress") or {}).get("payload_id")
    if not payload_id:
        return
    payload = worker.call("GET", "/payloads/" + payload_id)
    if payload.get("run_id") != fast["run_id"] or payload.get("payload_id") != payload_id:
        # Use the worker's existing definite-refusal path; never export a
        # foreign payload or change the frozen intake to make it match.
        from .worker import Refused
        raise Refused("fast_progress_payload_mismatch")
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip() or text.startswith(QUESTION_PREFIX):
        return
    evidence = {"run_id": fast["run_id"], "payload_id": payload_id}
    if no_reply(text):
        data["first_response"] = {**evidence, "outcome": "no_reply"}
        worker.ledger.save(data)
        return
    if len(text) > MAX_CHARS:
        text = text[:MAX_CHARS].rstrip() + " \u2026"
    # Persist the one-shot marker, spacing clock and export in the same ledger
    # transaction. A restart or lost transport acknowledgement cannot re-export.
    data["first_response"] = {**evidence, "outcome": "exported", "at": now}
    data["progress_at"] = now
    identity = worker.provider_identity(run_id=fast["run_id"], status=fast, fast=True)
    worker.ledger.add_first_response(data, payload_id, text, identity)
