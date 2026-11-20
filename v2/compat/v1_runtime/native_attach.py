"""The owner's terminal holds the chat's native session (`orkestr attach`).

While a native-attach hold is active, Core queues every input for the
conversation instead of running it (GET /native-attach says `held`). Two
things follow here:

- A person's WhatsApp input would otherwise wait in silence: the first one
  that waits during a hold gets ONE short status line, through the same status
  path as the heartbeats (activity.post_status). Never one per message: the
  hold (native session id + acquisition time) is remembered in `ledger_meta`.
- Waiting for the owner's terminal is not staleness: while held, inputs queued
  in this ledger do not age (ledger.expire_stale `held`); their clock restarts
  when the hold ends.

A Core without the route (404) or any read failure counts as "not held".
"""
import json
import time

from . import notices
from .activity import heartbeat_applies, post_status

CHECK_S = 15
META_KEY = "native_attach_notice"
WAITING_PHASES = ("queued", "admitted", "waiting_for_window", "waiting_for_window_dispatch")
WAITING_ROWS = 64


def read_hold(worker, now=None):
    """Core's hold for this conversation, cached for CHECK_S. None when not held."""
    now = time.time() if now is None else now
    cached = getattr(worker, "_native_attach_hold", None)
    if cached is not None and 0 <= now - cached[0] < CHECK_S:
        return cached[1]
    hold = None
    try:
        value = worker.call("GET", "/native-attach", allowed=(200,))
        if isinstance(value, dict) and value.get("held") is True:
            hold = value
    except Exception:
        hold = None  # An older Core (no route) or a failed read: not held.
    worker._native_attach_hold = (now, hold)
    return hold


def held(worker, now=None):
    return read_hold(worker, now) is not None


def drive(worker, now=None):
    """One status line per hold for the first person's input that waits in it."""
    now = time.time() if now is None else now
    ledger = worker.ledger
    with ledger.connect() as db:
        rows = db.execute("SELECT data FROM inputs WHERE json_extract(data,'$.phase') IN (%s) ORDER BY rowid LIMIT ?"
                          % ",".join("?" * len(WAITING_PHASES)), (*WAITING_PHASES, WAITING_ROWS)).fetchall()
    waiting = [json.loads(raw) for (raw,) in rows]
    waiting = [data for data in waiting if heartbeat_applies(worker, data)
               and not any(data.get(key) for key in ("refused", "absorbed_into", "blocked", "steer"))]
    if not waiting:
        return False
    hold = read_hold(worker, now)
    if hold is None:
        return False
    key = "%s:%s" % (hold.get("native_session_id"), hold.get("acquired_at_ms"))
    with ledger.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        prior = db.execute("SELECT value FROM ledger_meta WHERE key=?", (META_KEY,)).fetchone()
        if prior and json.loads(prior[0]).get("hold") == key:
            return False
        data = waiting[0]
        # A binding that names its owner (owner_label) says who; the default
        # label ("Owner") reads better as "the owner".
        label = getattr(worker, "owner_label", None)
        lang = notices.language_for(db, data)
        text = (notices.render(lang, "native_attach_held", owner=label) if label and label != "Owner"
                else notices.render(lang, "native_attach_held_unnamed"))
        post_status(ledger, db, data, text, now, native_attach=True)
        db.execute("INSERT INTO ledger_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                   (META_KEY, json.dumps(dict(hold=key, at=now, input_id=data["remote_id"]))))
    print("orkestr-v2-wa-adapter native_attach_notice conversation=%s input=%s"
          % (getattr(worker.client, "conversation", "?"), data["remote_id"]), flush=True)
    return True
