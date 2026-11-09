"""Choose an export identity without replacing a delivered refusal notice.

This does not resume inputs or establish acceptance. The caller already owns
the matched, canonically accepted Deep result; its exact references bind the
additional final identity. Unknown or conflicting exports remain untouched.
"""
import hashlib
import json


def _same_reply(message, reply):
    fields = ("id", "parentMessageId", "role", "state", "phase", "source", "noReply")
    return (all(message.get(key) == reply.get(key) for key in fields)
            and (message.get("pruned") is True or message.get("text") == reply.get("text")))


def _notice(message, data):
    return (message.get("kind") == "notice" and message.get("source") == "rust-v2-adapter"
            and message.get("role") == "assistant" and message.get("state") == "completed"
            and message.get("phase") == "final_answer"
            and message.get("parentMessageId") == data["remote_id"]
            and isinstance(message.get("refusal"), str) and bool(message["refusal"]))


def delivered_notice(message, outcome, ack, data):
    """Typed historical refusal and its definite ACK; no wording inference."""
    return (isinstance(message, dict) and _notice(message, data) and outcome == "delivered"
            and isinstance(ack, dict) and ack.get("outcome") == "delivered"
            and ack.get("parentPublicMessageId") == data["public_id"]
            and isinstance(ack.get("outboxJobId"), str) and bool(ack["outboxJobId"]))


def _accepted_key(data, reply):
    accepted, intake = data.get("accepted"), data.get("intake")
    if not isinstance(accepted, dict) or not isinstance(intake, dict):
        return None
    deep = accepted.get("deep")
    if not isinstance(deep, dict) or not isinstance(data.get("matched_runs"), list):
        return None
    identity = dict(input_id=data.get("remote_id"), public_id=data.get("public_id"),
                    message_id=intake.get("message_id"), event_id=intake.get("event_id"),
                    run_id=deep.get("run_id"), completion_event_id=deep.get("completion_event_id"),
                    acceptance_event_id=deep.get("acceptance_event_id"))
    if (not all(isinstance(value, str) and 0 < len(value) <= 256 for value in identity.values())
            or deep.get("outcome") != "succeeded"
            or deep["run_id"] not in data.get("matched_runs", [])
            or reply.get("id") != deep["acceptance_event_id"]
            or reply.get("parentMessageId") != data["remote_id"]
            or reply.get("source") != "rust-v2-pilot" or reply.get("role") != "assistant"
            or reply.get("state") != "completed" or reply.get("phase") != "final_answer"):
        return None
    raw = json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()
    return "accepted-final:" + hashlib.sha256(raw).hexdigest()


def select(db, data, reply):
    """Return (key, already exported), or None to hold without completing.

    Called under the ledger's existing IMMEDIATE transaction. The legacy key
    and its no-extra-proof behavior remain the ordinary no-notice path.
    """
    remote = data["remote_id"]
    collision = db.execute("SELECT input_id,kind FROM exports WHERE export_id=?", (reply["id"],)).fetchone()
    if collision and collision != (remote, "final"):
        return None
    rows = db.execute("SELECT export_id,source_key,message,outcome,ack FROM exports "
                      "WHERE input_id=? AND kind='final'", (remote,)).fetchall()
    notices, business = [], []
    try:
        for export_id, key, raw, outcome, ack_raw in rows:
            message = json.loads(raw)
            if not isinstance(message, dict) or message.get("id") != export_id or outcome == "uncertain":
                return None
            if _notice(message, data):
                ack = json.loads(ack_raw) if ack_raw else {}
                if not delivered_notice(message, outcome, ack, data):
                    return None
                notices.append(message)
            else:
                business.append((key, message))
    except (ValueError, TypeError):
        return None
    key = _accepted_key(data, reply) if notices else "final:" + remote
    if key is None or len(business) > 1:
        return None
    occupied = db.execute("SELECT input_id,export_id,kind FROM exports WHERE source_key=?", (key,)).fetchone()
    if occupied and occupied != (remote, reply["id"], "final"):
        return None
    if business:
        old_key, message = business[0]
        return (key, True) if old_key == key and _same_reply(message, reply) else None
    return key, False
