"""Atomic ledger transitions of an auto-steered input (see auto_steer.py).

`begin` freezes the decision on a never-admitted input; `steered` folds an
acknowledged input into the running head; `unsteer` returns it to the queue.
Each is one SQLite transaction, so no queue path can see a half state.
"""
import json
import time

from .ledger import Conflict


def _current(db, remote_id):
    row = db.execute("SELECT data FROM inputs WHERE remote_id=?", (remote_id,)).fetchone()
    if not row:
        raise Conflict("missing_input")
    return json.loads(row[0])


def begin(ledger, row, record):
    """Freeze a steer decision before any I/O. Only a never-admitted queued
    input qualifies; from now on no queue path admits it. False if it changed."""
    with ledger.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        current = _current(db, row["remote_id"])
        from .auto_steer import admission_started
        if current.get("phase") != "queued" or current.get("settled") or admission_started(current):
            return False
        current.update(steer=record, phase="steering")
        ledger.save(current, db)
    row.clear()
    row.update(current)
    return True


def steered(ledger, row, head_id, audit):
    """The running turn acknowledged this input: fold it into `head_id` in
    one transaction. It settles with the head's final and never runs."""
    with ledger.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        current = _current(db, row["remote_id"])
        if not current.get("steer") or current.get("phase") != "steering":
            raise Conflict("steer_changed")
        head = _current(db, head_id)
        record = dict(current.pop("steer"), **audit)
        current.update(phase="completed", absorbed_into=head_id, steered=record)
        ledger.save(current, db)
        if head.get("settled"):
            # The head's final was already transported; this input is answered with it.
            ledger._settle(db, current, head["settled"].get("outcome", "delivered"))
        else:
            head.setdefault("steered", []).append(current["remote_id"])
            ledger.save(head, db)
    row.clear()
    row.update(current)


def unsteer(ledger, row, reason, audit=None):
    """Return a steer-held input to the ordinary queue (nothing of it ran).
    Its age restarts so the wait for the turn does not expire it."""
    with ledger.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        current = _current(db, row["remote_id"])
        if not current.get("steer") or current.get("phase") != "steering":
            raise Conflict("steer_changed")
        record = dict(current.pop("steer"), reason=str(reason)[:200], at=time.time())
        if audit:
            record["audit"] = audit
        current.update(steer_fallback=record, phase="queued", queued_at=time.time())
        ledger.save(current, db)
    row.clear()
    row.update(current)

