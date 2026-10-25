"""Atomic Fast notification storage and causal Fast-before-final delivery fence."""
import json
import time
import uuid
from .ledger import LOCAL_ROLES
from .layer_identity import IDENTITY_FIELDS

FIRST_RESPONSE_NAMESPACE = uuid.UUID("e1cc360c-9c08-4cc5-8798-817864e93f23")
FINAL_ORDERING_LIMIT_S = 15


def add(ledger, data, payload_id, text, identity=None):
    """One durable Fast reply, independently linked to its originating input."""
    source = data["remote_id"] + ":" + payload_id
    remote = str(uuid.uuid5(FIRST_RESPONSE_NAMESPACE, "input:" + source))
    message = dict(id=str(uuid.uuid5(FIRST_RESPONSE_NAMESPACE, "reply:" + source)), role="assistant",
                   state="completed", phase="final_answer", source="rust-v2-adapter",
                   parentMessageId=remote, text=text, firstResponse=True, layer="fast", sourceInputId=data["remote_id"])
    message.update({k:v for k,v in (identity or {}).items() if k in IDENTITY_FIELDS and v})
    with ledger.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        data["first_response"].update(remote_id=remote, export_id=message["id"])
        ledger.save(data, db)
        if (data.get("author") or {}).get("role") in LOCAL_ROLES:
            # No group notification for a local-only request.
            message.update(parentMessageId=data["remote_id"], phase="commentary", kind="progress")
            ledger._export(db, data, "progress", "first-response:" + source, message)
        else:
            ledger._pseudo_timer(db, remote, "Quick reply", int(data["first_response"]["at"] * 1000),
                {"first_response_for": dict(input_id=data["remote_id"], run_id=data["first_response"]["run_id"],
                                            payload_id=payload_id)}, message, source_id="fast")
    return message


def final_ready(ledger, db, data):
    """A final can leave only after Fast has a definite transport decision."""
    fast = data.get("first_response") or {}
    if fast.get("remote_id") and not (data.get("author") or {}).get("role") in LOCAL_ROLES:
        row = db.execute("SELECT e.outcome,e.ack,i.data FROM exports e JOIN inputs i ON i.remote_id=e.input_id "
                         "WHERE e.input_id=? AND e.export_id=?", (fast["remote_id"],fast.get("export_id"))).fetchone()
        valid = row and (json.loads(row[2]).get("first_response_for") or {}).get("input_id") == data["remote_id"]
        outcome = row[0] if valid else None
        ack = json.loads(row[1]) if valid and row[1] else {}
        confirmed = (outcome == "delivered" and ack.get("outcome") == "delivered"
                     and ack.get("connectorMessageIds") and ack.get("outboxJobId")
                     and ack.get("deliveredAt"))
        if not confirmed and outcome not in ("suppressed", "failed"):
            now = time.time()
            fast["delivery_wait_since"] = fast.get("delivery_wait_since", now)
            if not valid or outcome in ("uncertain", "delivered"):
                fast["delivery_blocker"] = "missing_reference" if not valid else "unverified_" + outcome
            since = data.get("deep_final_ready_at", fast["delivery_wait_since"])
            if now - since < FINAL_ORDERING_LIMIT_S:
                ledger.save(data, db)
                return False
            # Final delivery has priority at the deadline, even when a Fast
            # send is hanging or uncertain. Withdraw it from future snapshots;
            # retain reconciliation evidence and any late real ACK, never replay.
            fast.update(superseded_at=now, delivery_blocker=fast.get("delivery_blocker") or "fast_transport_timeout")
            if valid:
                db.execute("UPDATE exports SET outcome='superseded' WHERE export_id=?", (fast["export_id"],))
                ledger._settle(db, json.loads(row[2]), "superseded")
            return True
        fast.pop("delivery_blocker", None)
        fast["delivery_outcome"] = outcome
    return True
