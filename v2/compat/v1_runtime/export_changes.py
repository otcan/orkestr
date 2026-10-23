"""Restart-safe export wakeups. Notifications carry route IDs, never message text.

The epoch changes on restart. A new/stale cursor gets a full route snapshot;
otherwise a condition wakes the client as soon as an export commits. SQLite
remains the source of truth: a notification is only an instruction to re-read.
"""
import sqlite3
import threading
import uuid


class ExportChanges:
    def __init__(self):
        self.epoch = uuid.uuid4().hex
        self.version = 0
        self.routes = {}
        self.condition = threading.Condition()
        self.closed = False

    def publish(self, route):
        with self.condition:
            self.version += 1
            self.routes[route] = self.version
            self.condition.notify_all()

    def read(self, cursor="", wait_ms=25000):
        with self.condition:
            prefix, _, raw = cursor.partition(":")
            after = int(raw) if prefix == self.epoch and raw.isdecimal() else -1
            if after > self.version:
                after = -1
            self.condition.wait_for(lambda: self.closed or after != self.version, wait_ms / 1000)
            return {"cursor": "%s:%d" % (self.epoch, self.version),
                    "threads": [route for route, version in self.routes.items() if version > after],
                    "reset": after < 0}

    def close(self):
        with self.condition:
            self.closed = True
            self.condition.notify_all()


class ExportConnection(sqlite3.Connection):
    """Wake only after a successful commit, never from inside the transaction."""
    exported = False
    on_export = None

    def __exit__(self, *error):
        result = super().__exit__(*error)
        if error[0] is None and self.exported and self.on_export:
            self.on_export()
        self.exported = False
        return result
