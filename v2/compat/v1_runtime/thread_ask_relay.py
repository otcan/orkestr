"""Export the turn a returned thread-ask answer starts (V2 TASK-61 follow-up).

When another thread answers this binding's request after the asking turn
ended, Core admits the outcome as an input of this conversation and queues
its own Deep turn. Nothing in the WhatsApp queue knows that input, so the
owner never saw what the agent did with the answer. This adopts each such
input as an awaited web-style answer: the existing `drive_web` watch then
exports the accepted Deep answer of exactly that input to the group, once,
labelled "↩ from <thread name>".

The adapter never opens a window, accepts a run or mirrors the input text
(it is another agent's answer, not an owner message). A server without the
route answers 404 and nothing happens. The first scan only records the
current position, so earlier returned answers are never replayed.
"""
import json
import time
import uuid

CURSOR_KEY = "thread_ask_cursor"
PAGE = 20
ROUTE = "/thread-ask-inputs?after_sequence=%d&limit=%d"


def _cursor(ledger):
    with ledger.connect() as db:
        row = db.execute("SELECT value FROM ledger_meta WHERE key=?", (CURSOR_KEY,)).fetchone()
    return int(row[0]) if row else None


def _set_cursor(ledger, sequence):
    with ledger.connect() as db:
        db.execute("INSERT INTO ledger_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                   (CURSOR_KEY, str(int(sequence))))


def _valid(row, after):
    if not isinstance(row, dict) or type(row.get("sequence")) is not int or row["sequence"] <= after:
        return False
    try:
        for key in ("message_id", "event_id", "ask_id"):
            uuid.UUID(row[key])
    except (KeyError, TypeError, ValueError):
        return False
    return isinstance(row.get("target_name"), str) and row.get("state") in ("answered", "failed")


def _adopt(ledger, row):
    """Await the accepted answer of this input; idempotent by Core message ID."""
    label = " ".join(row["target_name"].split())[:60] or "another thread"
    watch = {"message_id": row["message_id"], "event_id": row["event_id"], "sequence": row["sequence"],
             "cursor": row["sequence"], "excerpt": "thread answer from %s" % label, "since": time.time(),
             "runs": [], "progress": [], "thread_ask": row["ask_id"], "thread_name": label}
    with ledger.connect() as db:
        db.execute("INSERT OR IGNORE INTO web_watch VALUES (?,?)", (row["message_id"], json.dumps(watch)))


def discover(worker):
    """One bounded scan. Returns how many inputs were newly adopted."""
    ledger = worker.ledger
    cursor = _cursor(ledger)
    status, value = worker.client.request("GET", ROUTE % (cursor or 0, PAGE), allowed=(200, 404))
    if status == 404:
        return 0
    rows = value.get("inputs") if isinstance(value, dict) else None
    if not isinstance(rows, list) or len(rows) > PAGE or type(value.get("last_sequence")) is not int:
        return 0
    if cursor is None:
        _set_cursor(ledger, value["last_sequence"])
        return 0
    adopted, after = 0, cursor
    for row in rows:
        if not _valid(row, after):
            break
        _adopt(ledger, row)
        adopted += 1
        after = row["sequence"]
    if after != cursor:
        _set_cursor(ledger, after)
    return adopted
