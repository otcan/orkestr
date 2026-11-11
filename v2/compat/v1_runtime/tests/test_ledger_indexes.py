"""ORK-772: hot ledger filters read an index, not every input row ever written.

Synthetic ledgers only: fake IDs, no chat content.
"""
import contextlib
import io
import json
from pathlib import Path
import random
import shutil
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import patch

from v2.compat.v1_runtime import ledger_indexes
from v2.compat.v1_runtime.ledger import NOT_STARTED, Ledger
from v2.compat.v1_runtime.ledger_indexes import OPEN_PHASE, OPEN_ROWS

SCOPE = {"public_thread_id": "thread-772", "chat_id": "chat-772", "account_id": "account-772",
         "conversation_id": "conversation-772"}
INDEX_NAMES = sorted(name for name, _ in ledger_indexes.INDEXES)
# The statements as they were before ORK-772.
OLD_NEXT = "SELECT data FROM inputs WHERE json_extract(data,'$.phase') != 'completed' ORDER BY rowid LIMIT 1"
OLD_PENDING = "SELECT data FROM inputs WHERE json_extract(data,'$.phase') != 'completed' ORDER BY rowid LIMIT 64"
OLD_NOT_STARTED = ("SELECT rowid, data FROM inputs WHERE json_extract(data,'$.phase') IN (%s) ORDER BY rowid"
                   % ",".join("?" * len(NOT_STARTED)))
OLD_RUNNING = "SELECT rowid, data FROM inputs WHERE json_extract(data,'$.phase')='running' ORDER BY rowid LIMIT 8"
OLD_STALLED = ("SELECT count(*) FROM inputs WHERE json_extract(data,'$.stalled') IS NOT NULL AND "
               "json_extract(data,'$.phase') != 'completed'")
OLD_UNSETTLED = "SELECT data FROM inputs WHERE json_extract(data,'$.settled') IS NULL ORDER BY rowid"
# Phases in real use plus shapes the JSON filter must treat exactly as before:
# a missing key and JSON null never match `!= 'completed'`, a number does.
PHASES = ("completed",) * 6 + NOT_STARTED + ("running", "digest_ready", None, "<missing>", 7)


def schema(path):
    with sqlite3.connect(path) as db:
        return sorted(db.execute("SELECT type, name, sql FROM sqlite_master").fetchall(), key=repr)


def indexes(path):
    with sqlite3.connect(path) as db:
        return sorted(row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'ledger_%'"))


def drop_indexes(path):
    db = sqlite3.connect(path)
    for name in INDEX_NAMES:
        db.execute("DROP INDEX IF EXISTS %s" % name)
    db.commit()
    db.close()


def contents(path):
    with sqlite3.connect(path) as db:
        return {table: db.execute("SELECT * FROM %s ORDER BY rowid" % table).fetchall()
                for table in ("inputs", "exports", "ledger_meta")}


def fill(ledger, count, seed=772, now=None):
    """`count` synthetic inputs with varied phases, settlement and exports."""
    now = time.time() if now is None else now
    rng = random.Random(seed)
    with ledger.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        for n in range(count):
            remote = "remote-%05d" % n
            data = {"remote_id": remote, "public_id": "public-%05d" % n, "public_thread_id": SCOPE["public_thread_id"],
                    "chat_id": SCOPE["chat_id"], "account_id": SCOPE["account_id"], "text": "synthetic %d" % n,
                    "queued_at": now - rng.choice((5, 600, 7200)), "keys": {}}
            phase = rng.choice(PHASES)
            if phase != "<missing>":
                data["phase"] = phase
            if phase == "completed" and rng.random() < 0.9:
                data["settled"] = {"outcome": "delivered", "atMs": 1}
                data.pop("text")
            if rng.random() < 0.1:
                data["stalled"] = {"at": now, "phase": phase, "since": now}
            if rng.random() < 0.05:
                data["refused"] = {"reason": "synthetic", "phase": phase, "atMs": n}
            if rng.random() < 0.1:
                data.update(origin="timer", timer={"namespace": "ns", "source_timer_id": "t", "label": "Timer"},
                            created_at="2026-01-01T00:00:00Z")
            if phase == "running":
                data["transport_activity"] = {"observed_at_ms": int(now * 1000) - rng.choice((1000, 600_000)),
                                              "deep_running": rng.random() < 0.7}
            db.execute("INSERT INTO inputs VALUES (?,?,?,?)", (data["public_id"], "digest", remote, json.dumps(data)))
            for k in range(rng.choice((0, 1, 2))):
                outcome = rng.choice((None, "uncertain", "delivered", "superseded", "failed"))
                export = "export-%05d-%d" % (n, k)
                db.execute("INSERT INTO exports(export_id,input_id,kind,source_key,message,outcome) VALUES (?,?,?,?,?,?)",
                           (export, remote, "final" if k == 0 else "progress", "final:%s:%d" % (remote, k),
                            json.dumps({"id": export, "role": "assistant", "parentMessageId": remote, "text": "r"}), outcome))


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "ledger.sqlite3"

    def test_a_ledger_without_indexes_gets_them_once_and_keeps_its_rows(self):
        fill(Ledger(self.path, SCOPE), 300)
        drop_indexes(self.path)  # A ledger written before ORK-772.
        before = contents(self.path)
        self.assertEqual(indexes(self.path), [])
        Ledger(self.path, SCOPE)
        self.assertEqual(indexes(self.path), INDEX_NAMES)
        self.assertEqual(contents(self.path), before)
        migrated = schema(self.path)
        Ledger(self.path, SCOPE)  # A restart changes nothing.
        self.assertEqual(schema(self.path), migrated)
        with sqlite3.connect(self.path) as db:
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone(), ("ok",))

    def test_an_adapter_without_the_indexes_still_reads_and_writes_the_same_rows(self):
        ledger = Ledger(self.path, SCOPE)
        fill(ledger, 50)
        # What a rolled-back adapter does: plain row writes, unaware of the indexes.
        with sqlite3.connect(self.path) as db:
            raw = db.execute("SELECT data FROM inputs WHERE public_id='public-00003'").fetchone()[0]
            db.execute("UPDATE inputs SET data=? WHERE public_id='public-00003'",
                       (json.dumps(dict(json.loads(raw), phase="queued")),))
            db.execute("INSERT INTO inputs VALUES ('old-writer','d','old-remote',?)",
                       (json.dumps({"remote_id": "old-remote", "public_id": "old-writer", "phase": "queued"}),))
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone(), ("ok",))
        with sqlite3.connect(self.path) as db:
            expected = [json.loads(raw) for (raw,) in db.execute(OLD_PENDING)]
        self.assertIn("old-remote", [row["remote_id"] for row in expected])
        self.assertEqual(ledger.pending_inputs(), expected)

    def test_a_pilot_ledger_is_still_adopted_and_indexed(self):
        db = sqlite3.connect(self.path)
        db.execute("CREATE TABLE ledger_scope (singleton INTEGER PRIMARY KEY CHECK(singleton=1), identity TEXT NOT NULL)")
        db.execute("INSERT INTO ledger_scope VALUES (1,?)",
                   (json.dumps({"schema": 1, "scope": SCOPE}, sort_keys=True, separators=(",", ":")),))
        db.execute("CREATE TABLE inputs (public_id TEXT PRIMARY KEY, digest TEXT NOT NULL, remote_id TEXT UNIQUE NOT NULL, data TEXT NOT NULL)")
        db.execute("INSERT INTO inputs VALUES ('p','d','r',?)", (json.dumps({"remote_id": "r", "phase": "queued"}),))
        db.commit()
        db.close()
        self.path.chmod(0o600)
        ledger = Ledger(self.path, SCOPE)
        self.assertEqual(indexes(self.path), INDEX_NAMES)
        self.assertEqual(ledger.next_input()["remote_id"], "r")

    def test_a_failed_index_build_never_stops_the_binding(self):
        fill(Ledger(self.path, SCOPE), 30)
        drop_indexes(self.path)
        stderr = io.StringIO()

        def full_disk(db):
            db.execute("CREATE INDEX ledger_inputs_open ON inputs(public_id)")  # Rolled back below.
            raise sqlite3.OperationalError("database or disk is full")
        with patch("v2.compat.v1_runtime.ledger.initialize_indexes", full_disk), contextlib.redirect_stderr(stderr):
            ledger = Ledger(self.path, SCOPE)
        self.assertEqual(stderr.getvalue().strip(), "WARN orkestr-v2-wa-adapter ledger_indexes_unavailable "
                         "thread=? error=OperationalError")
        self.assertEqual(indexes(self.path), [])  # Nothing half-built is left behind.
        with sqlite3.connect(self.path) as db:
            expected = [json.loads(raw) for (raw,) in db.execute(OLD_PENDING)]
        self.assertEqual(ledger.pending_inputs(), expected)
        Ledger(self.path, SCOPE)  # The next start builds them.
        self.assertEqual(indexes(self.path), INDEX_NAMES)


class IdenticalResultTests(unittest.TestCase):
    """Old statements, new statements, with and without indexes: same rows."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "ledger.sqlite3"
        self.now = 1_800_000_000.0
        self.ledger = Ledger(self.path, SCOPE)
        self.ledger.owner_only = True
        fill(self.ledger, 1200, now=self.now)

    def old(self, sql, parameters=()):
        with sqlite3.connect(self.path) as db:
            return db.execute(sql, parameters).fetchall()

    def test_the_rewritten_filters_select_exactly_the_old_rows(self):
        pairs = (
            (OLD_NEXT, "SELECT data FROM inputs WHERE %s ORDER BY rowid LIMIT 1" % OPEN_ROWS, ()),
            (OLD_PENDING, "SELECT data FROM inputs WHERE %s ORDER BY rowid LIMIT 64" % OPEN_ROWS, ()),
            ("SELECT rowid FROM inputs WHERE " + OPEN_PHASE + " ORDER BY rowid", "SELECT rowid FROM inputs WHERE %s ORDER BY rowid" % OPEN_ROWS, ()),
            (OLD_NOT_STARTED, "SELECT rowid, data FROM inputs WHERE %s AND json_extract(data,'$.phase') IN (%s) ORDER BY rowid"
             % (OPEN_PHASE, ",".join("?" * len(NOT_STARTED))), NOT_STARTED),
            (OLD_RUNNING, "SELECT rowid, data FROM inputs WHERE %s AND json_extract(data,'$.phase')='running' "
             "ORDER BY rowid LIMIT 8" % OPEN_PHASE, ()),
            (OLD_STALLED, "SELECT count(*) FROM inputs WHERE %s AND json_extract(data,'$.stalled') IS NOT NULL" % OPEN_ROWS, ()),
        )
        for old, new, parameters in pairs:
            expected = self.old(old, parameters)
            self.assertTrue(expected, old)
            self.assertEqual(self.old(new, parameters), expected, new)
            with self.ledger.connect() as db:  # The migrated ledger, through its indexes.
                self.assertEqual(db.execute(new, parameters).fetchall(), expected, new)

    def test_ledger_reads_match_the_old_statements(self):
        self.assertEqual(self.ledger.next_input(), json.loads(self.old(OLD_NEXT)[0][0]))
        self.assertEqual(self.ledger.pending_inputs(), [json.loads(raw) for (raw,) in self.old(OLD_PENDING)])
        unsettled = [json.loads(raw)["remote_id"] for (raw,) in self.old(OLD_UNSETTLED)]
        listing = self.ledger.listing(100_000)
        self.assertFalse(listing["truncated"])
        self.assertEqual([m["id"] for m in listing["messages"] if m["role"] == "user"], unsettled)
        unreported = self.old("SELECT e.seq FROM exports e JOIN inputs i ON i.remote_id=e.input_id WHERE "
                              "json_extract(i.data,'$.settled') IS NULL AND (e.outcome IS NULL OR e.outcome='uncertain') "
                              "ORDER BY i.rowid, e.seq")
        self.assertEqual([m["exportSequence"] for m in listing["messages"] if "exportSequence" in m],
                         [seq for (seq,) in unreported])
        self.assertEqual(listing["mirrorAck"]["outstandingInputs"], len(unsettled))
        acked = self.old("SELECT min(seq) FROM exports WHERE outcome IS NULL OR outcome='uncertain'")[0][0] - 1
        self.assertEqual(listing["mirrorAck"]["ackedThrough"], acked)
        health = self.ledger.health()
        self.assertEqual(health["outstandingInputs"], len(unsettled))
        self.assertEqual(health["stalledInputs"], self.old(OLD_STALLED)[0][0])
        with self.ledger.connect() as db:
            live = self.ledger._live_head_rowid(db, self.now)
        # The same proof check, applied to the rows the old statement selected.
        def proven(data):
            activity = data.get("transport_activity") or {}
            observed = activity.get("observed_at_ms")
            return (type(observed) is int and activity.get("deep_running") is True and not data.get("refused")
                    and 0 <= self.now * 1000 - observed <= 120_000)
        running = [(rowid, json.loads(raw)) for rowid, raw in self.old(OLD_RUNNING)]
        self.assertEqual(live, next((rowid for rowid, data in running if proven(data)), None))

    def snapshot(self, ledger):
        with ledger.connect() as db:
            live = ledger._live_head_rowid(db, self.now)
        return {"next": ledger.next_input(), "pending": ledger.pending_inputs(), "listing": ledger.listing(500),
                "health": ledger.health(), "live": live}

    def test_results_and_expiry_are_identical_with_and_without_the_indexes(self):
        copy = Path(self.temp.name) / "copy.sqlite3"
        shutil.copyfile(self.path, copy)
        copy.chmod(0o600)
        unindexed = Ledger(copy, SCOPE)
        unindexed.owner_only = True
        drop_indexes(copy)
        self.assertEqual(indexes(copy), [])
        self.assertEqual(self.snapshot(unindexed), self.snapshot(self.ledger))

        def expired(ledger):
            with contextlib.redirect_stderr(io.StringIO()):
                return sorted(d["remote_id"] for d in ledger.expire_stale(1800, now=self.now))
        first = expired(self.ledger)
        self.assertTrue(first)
        self.assertEqual(expired(unindexed), first)
        with sqlite3.connect(self.path) as a, sqlite3.connect(copy) as b:
            phases = "SELECT remote_id, json_extract(data,'$.phase'), json_extract(data,'$.refused.reason') FROM inputs ORDER BY rowid"
            self.assertEqual(a.execute(phases).fetchall(), b.execute(phases).fetchall())


class IdleCostTests(unittest.TestCase):
    """An idle chat's hot reads cost the same with 20 or 2000 finished inputs."""

    def steps(self, history):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        ledger = Ledger(Path(temp.name) / "ledger.sqlite3", SCOPE)
        ledger.owner_only = True
        with ledger.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            for n in range(history):
                data = {"remote_id": "r%d" % n, "public_id": "p%d" % n, "phase": "completed",
                        "settled": {"outcome": "delivered", "atMs": n}, "padding": "x" * 2000}
                db.execute("INSERT INTO inputs VALUES (?,?,?,?)", ("p%d" % n, "d", "r%d" % n, json.dumps(data)))
                db.execute("INSERT INTO exports(export_id,input_id,kind,source_key,message,outcome) VALUES (?,?,?,?,?,?)",
                           ("e%d" % n, "r%d" % n, "final", "final:r%d" % n, "{}", "delivered"))
        counted = [0]
        real_connect = sqlite3.connect

        def connect(*args, **kwargs):
            db = real_connect(*args, **kwargs)
            db.set_progress_handler(lambda: counted.__setitem__(0, counted[0] + 1), 1)
            return db
        with patch.object(sqlite3, "connect", connect):
            # Every new connection counts its VM steps, and so does the one
            # this thread already holds (before ORK-772 every block was new).
            with ledger.connect() as db:
                db.set_progress_handler(lambda: counted.__setitem__(0, counted[0] + 1), 1)
            counted[0] = 0
            with ledger.connect() as db:
                ledger._live_head_rowid(db, time.time())
            for _ in range(3):
                ledger.expire_stale(1800)
                ledger.next_input()
                ledger.pending_inputs()
                ledger.listing(100)
        return counted[0]

    def test_finished_history_is_not_rescanned(self):
        small, large = self.steps(20), self.steps(2000)
        # Before ORK-772 each of these calls stepped through every row (well
        # over 100,000 VM steps here); now only index pages and open rows.
        self.assertLess(large, small + 2000, (small, large))


if __name__ == "__main__":
    unittest.main()
