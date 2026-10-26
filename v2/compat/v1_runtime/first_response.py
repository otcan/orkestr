"""One durable interactive Fast reply, independent of ordinary progress or Deep readiness."""
import re
import time

from .ledger import no_reply
from .legacy_first_response import capture_legacy

MAX_CHARS = 3500
ECHO_MAX_CHARS = 600


def echo_key(text):
    """Lowercased words only, for short replies; None for long ones."""
    if not isinstance(text, str) or len(text) > ECHO_MAX_CHARS:
        return None
    return " ".join(re.findall(r"[^\W_]+", text.lower())) or None


def repeats_fast(data, final_text):
    """Whether a short Deep final is exactly the exported Fast reply after
    normalization. Similar is not enough: "10:00" vs "11:00", "1,250" vs
    "1,520" or "B12" vs "B14" are corrections, so any digit disables it, and
    a turn that took steered messages always gets its own final."""
    echo = (data.get("first_response") or {}).get("echo")
    final = echo_key(final_text)
    if not echo or not final or data.get("steered"):
        return False
    if any(c.isdigit() for c in final_text) or any(c.isdigit() for c in echo):
        return False
    return final == echo
QUESTION_PREFIX = "\u2753 Question while I keep working:\n\n"


def capture(worker, data, statuses, own_runs):
    policy = worker.fast_reply_policy
    if policy == "disabled":
        return
    if policy == "legacy":
        return capture_legacy(worker, data, statuses, own_runs)
    # Operational timers keep their separate digest/reply rules. Interactive
    # Fast is a reply of its own, independent of the ordinary progress setting.
    if data.get("origin") == "timer" or data.get("first_response"):
        return
    fast = statuses.get("fast")
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
    echo = echo_key(text)
    if echo:
        # Bounded normalized copy (pruned at settlement) so a Deep final that
        # only repeats this Fast reply is not sent a second time.
        data["first_response"]["echo"] = echo
    data["progress_at"] = now
    identity = worker.provider_identity(run_id=fast["run_id"], status=fast, fast=True)
    worker.ledger.add_first_response(data, payload_id, text, identity)
