"""Immutable original-source Fast follow-up, separate from Deep continuation.

Only currently pending, verified owner inputs create watches. Completed input
history is never scanned. Work per pass is bounded and least-recently-polled
selection lets a new source proceed ahead of an older faulted watch.
"""
import copy
import json

from .first_response_store import add


def initialize(db):
    db.execute("CREATE TABLE IF NOT EXISTS fast_watch (event_id TEXT PRIMARY KEY,input_id TEXT NOT NULL,"
               "data TEXT NOT NULL,last_poll INTEGER NOT NULL DEFAULT 0,closed INTEGER NOT NULL DEFAULT 0)")
    db.execute("CREATE INDEX IF NOT EXISTS fast_watch_pending ON fast_watch(closed,last_poll)")
    db.execute("CREATE INDEX IF NOT EXISTS fast_watch_poll_clock ON fast_watch(last_poll)")


def ensure(ledger, data):
    source = data["intake"]
    watch = {key: copy.deepcopy(data[key]) for key in ("remote_id", "public_id", "author", "intake", "window")}
    watch.update(phase="running", keys={"fast": data["keys"]["fast"]},
                 watch_id=source["event_id"], fast_cursor=source["sequence"] - 1, matched_runs=[])
    for key in ("first_response", "fast_accept_request", "fast_payload"):
        if key in data:
            watch[key] = copy.deepcopy(data[key])
    if "fast_payload" in watch:
        watch["fast_payload"] = {key: watch["fast_payload"][key]
                                 for key in ("run_id", "payload_id") if key in watch["fast_payload"]}
    with ledger.connect() as db:
        db.execute("INSERT OR IGNORE INTO fast_watch(event_id,input_id,data) VALUES (?,?,?)",
                   (watch["watch_id"], data["remote_id"], json.dumps(watch)))


def pending(ledger, limit):
    with ledger.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        rows = db.execute("SELECT event_id,data FROM fast_watch WHERE closed=0 ORDER BY last_poll,rowid LIMIT ?",
                          (limit,)).fetchall()
        for event, _ in rows:
            db.execute("UPDATE fast_watch SET last_poll=(SELECT coalesce(max(last_poll),0)+1 FROM fast_watch) WHERE event_id=?",
                       (event,))
    return [json.loads(raw) for _, raw in rows]


class Ledger:
    """Worker-compatible view that cannot replace the originating Deep row."""
    def __init__(self, original):
        self.original = original

    def __getattr__(self, name):
        return getattr(self.original, name)

    def source(self, watch, db):
        row = db.execute("SELECT data FROM inputs WHERE remote_id=?", (watch["remote_id"],)).fetchone()
        if not row:
            raise ValueError("fast_watch_source_missing")
        return json.loads(row[0])

    def save(self, watch, db=None):
        if db is None:
            with self.connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                return self.save(watch, connection)
        row = db.execute("SELECT data FROM fast_watch WHERE event_id=? AND input_id=?",
                         (watch["watch_id"], watch["remote_id"])).fetchone()
        prior = json.loads(row[0]) if row else None
        if not prior or any(prior.get(key) != watch.get(key)
                            for key in ("intake", "keys", "remote_id", "public_id", "author", "window")):
            raise ValueError("fast_watch_scope_changed")
        if (prior.get("closed") and not watch.get("closed")) or watch["fast_cursor"] < prior["fast_cursor"]:
            raise ValueError("fast_watch_state_regressed")
        original = self.source(watch, db)
        if watch.get("first_response") or original.get("first_response"):
            # Original delivery/timeout evidence is authoritative, including
            # updates made after this watch's last snapshot.
            combined = dict(watch.get("first_response", {}), **original.get("first_response", {}))
            watch["first_response"] = original["first_response"] = combined
        if watch.get("diagnostic"):
            original["fast_reply_diagnostic"] = watch["diagnostic"]
        # Retry needs immutable payload locators, never retained model text.
        if "fast_payload" in watch:
            watch["fast_payload"] = {key: watch["fast_payload"][key]
                                     for key in ("run_id", "payload_id") if key in watch["fast_payload"]}
        if original.get("intake") == watch["intake"]:
            for key in ("fast_accept_request", "fast_payload"):
                if key in watch:
                    original[key] = copy.deepcopy(watch[key])
            if "fast" in watch.get("accepted", {}):
                original.setdefault("accepted", {})["fast"] = watch["accepted"]["fast"]
        self.original.save(original, db)
        db.execute("UPDATE fast_watch SET data=?,closed=? WHERE event_id=? AND input_id=?",
                   (json.dumps(watch), int(bool(watch.get("closed"))), watch["watch_id"], watch["remote_id"]))

    def add_first_response(self, data, payload_id, text, identity=None):
        return add(self, data, payload_id, text, identity)

    def presentation_allowed(self, watch):
        with self.connect() as db:
            original = self.source(watch, db)
        return not original.get("substantive_deep_final_prepared")
