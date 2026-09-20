#!/usr/bin/env python3
"""Receipt-bound evidence export and conservative, explicit local retention.

The sink adapter is an authenticated operator integration, never arbitrary
receipt JSON supplied by an application. No network transport is auto-selected.
"""
import hashlib
import json
import math

from service_audit import token


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def timestamp(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError("invalid evidence time")
    return value


class Archive:
    def __init__(self, store, sink_id, retention_seconds=604800):
        if not token(sink_id) or type(retention_seconds) is not int or retention_seconds < 86400:
            raise ValueError("explicit sink identity and at least one day local retention required")
        self.store, self.sink_id, self.retention_seconds = store, sink_id, retention_seconds
        with store.db:
            store.db.execute("""CREATE TABLE IF NOT EXISTS exports (
                id TEXT PRIMARY KEY, payload TEXT, receipt TEXT, created REAL NOT NULL)""")
            store.db.execute("""CREATE TABLE IF NOT EXISTS exported_versions (
                id TEXT PRIMARY KEY, digest TEXT NOT NULL)""")
            policy = canonical({"sink_id": sink_id, "retention_seconds": retention_seconds})
            store.db.execute("INSERT OR IGNORE INTO state VALUES('archive_policy',?)", (policy,))
            if store.db.execute("SELECT value FROM state WHERE key='archive_policy'").fetchone()[0] != policy:
                raise ValueError("archive policy changed; reconcile retained evidence before changing sinks")

    def prepare(self, now, limit=1000):
        """Persist exact retry bytes before any off-host I/O; one batch at a time."""
        timestamp(now)
        if type(limit) is not int or not 1 <= limit <= 1000:
            raise ValueError("bounded export batch required")
        db = self.store.db
        db.execute("BEGIN IMMEDIATE")
        try:
            existing = db.execute("SELECT id,payload FROM exports WHERE payload IS NOT NULL").fetchone()
            if existing:
                db.commit()
                return {"bundle_id": existing["id"], "bundle": json.loads(existing["payload"])}
            # Unresolved incidents need off-host evidence too. Export changed
            # versions fairly; old pending rows cannot starve later incidents.
            versions = dict(db.execute("SELECT id,digest FROM exported_versions"))
            rows = []
            for row in db.execute("SELECT * FROM events ORDER BY created,id"):
                event = dict(row)
                due_for_retention = ((event["delivered"] == 1 or event["attribution"] is not None)
                                     and event["created"] <= now - self.retention_seconds)
                if versions.get(event["id"]) != digest(event) or due_for_retention:
                    rows.append(event)
                    if len(rows) == limit:
                        break
            if not rows:
                db.commit()
                return None
            state = dict(db.execute("SELECT key,value FROM state WHERE key IN ('kind','units','cursor')"))
            bundle = {"version": 1, "sink_id": self.sink_id, "created": now, "state": state, "events": rows}
            identity = digest(bundle)
            db.execute("INSERT INTO exports VALUES(?,?,NULL,?)", (identity, canonical(bundle), now))
            db.commit()
            return {"bundle_id": identity, "bundle": bundle}
        except BaseException:
            db.rollback()
            raise

    def deliver(self, bundle_id, sink):
        """sink(request) must independently authenticate/idempotently retain bytes.

        Lost receipts retry the identical bundle identity. An acknowledgement
        asserts retention until a timestamp, not merely HTTP acceptance.
        """
        row = self.store.db.execute("SELECT * FROM exports WHERE id=?", (bundle_id,)).fetchone()
        if not row:
            raise ValueError("unknown export")
        if row["receipt"]:
            return json.loads(row["receipt"])
        if not row["payload"]:
            raise ValueError("missing export payload")
        bundle = json.loads(row["payload"])
        if digest(bundle) != bundle_id:
            raise ValueError("export bytes changed")
        response = sink({"bundle_id": bundle_id, "bundle": bundle})
        if (not isinstance(response, dict) or response.get("bundle_id") != bundle_id
                or response.get("sink_id") != self.sink_id or response.get("state") != "retained"
                or response.get("immutable") is not True or not token(response.get("receipt_id"))):
            raise ValueError("export receipt missing, unbound or not immutable")
        until = timestamp(response.get("retained_until"))
        if until < row["created"] + self.retention_seconds:
            raise ValueError("off-host retention is shorter than local policy")
        receipt = {key: response[key] for key in
                   ("bundle_id", "sink_id", "state", "immutable", "receipt_id", "retained_until")}
        with self.store.db:
            self.store.db.execute("UPDATE exports SET receipt=? WHERE id=? AND receipt IS NULL", (canonical(receipt), bundle_id))
            for event in bundle["events"]:
                self.store.db.execute("INSERT OR REPLACE INTO exported_versions VALUES(?,?)", (event["id"], digest(event)))
        return receipt

    def prune(self, bundle_id, now):
        """Remove only unchanged, settled rows backed by an unexpired receipt.

        Event identities remain as compact tombstones so a replayed journal
        cursor cannot recreate previously archived alert obligations. Control
        operation identities, monitor sequences and cursors are never removed.
        """
        timestamp(now)
        db = self.store.db
        db.execute("BEGIN IMMEDIATE")
        try:
            export = db.execute("SELECT * FROM exports WHERE id=?", (bundle_id,)).fetchone()
            if not export or not export["receipt"]:
                raise ValueError("acknowledged immutable export required before pruning")
            receipt = json.loads(export["receipt"])
            if receipt["retained_until"] <= now or now < export["created"]:
                raise ValueError("export retention expired or clock moved backwards")
            if export["payload"] is None:
                db.commit()
                return 0
            bundle = json.loads(export["payload"])
            if digest(bundle) != bundle_id:
                raise ValueError("export bytes changed")
            removed = 0
            for saved in bundle["events"]:
                current = db.execute("SELECT * FROM events WHERE id=?", (saved["id"],)).fetchone()
                if current is None or dict(current) != saved:
                    continue
                if (not (saved["delivered"] == 1 or saved["attribution"] is not None)
                        or saved["created"] > now - self.retention_seconds):
                    continue
                db.execute("INSERT INTO archived_events VALUES(?,?)", (saved["id"], bundle_id))
                db.execute("DELETE FROM events WHERE id=?", (saved["id"],))
                db.execute("DELETE FROM exported_versions WHERE id=?", (saved["id"],))
                removed += 1
            # Keep receipt and digest permanently; snapshot bytes live at sink.
            db.execute("UPDATE exports SET payload=NULL WHERE id=?", (bundle_id,))
            db.commit()
            return removed
        except BaseException:
            db.rollback()
            raise
