"""ORK-772: a binding worker keeps one ledger connection for its passes, and
each block still behaves as if it had its own. Synthetic ledgers only."""
import gc
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest

from v2.compat.v1_runtime.ledger import Ledger
from v2.compat.v1_runtime.worker import Worker


def open_fds():
    return len(os.listdir("/proc/self/fd"))


class KeptConnectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "ledger.sqlite3"
        self.exports = []
        self.ledger = Ledger(self.path, {"test_scope": "kept"}, on_export=lambda: self.exports.append(1))
        kept = self.ledger.keep_connection()
        kept.__enter__()
        self.addCleanup(kept.__exit__, None, None, None)

    def keys(self):
        with sqlite3.connect(self.path) as db:
            return {row[0] for row in db.execute("SELECT key FROM ledger_meta")}

    def test_blocks_reuse_one_connection(self):
        with self.ledger.connect() as first:
            first.execute("SELECT 1").fetchone()
        with self.ledger.connect() as second:
            self.assertEqual(second.execute("SELECT 1").fetchone(), (1,))
        self.assertIs(second, first)
        self.assertFalse(first.in_transaction)

    def test_a_block_leaves_no_statement_open(self):
        with self.ledger.connect() as db:
            for n in range(3):
                db.execute("INSERT INTO ledger_meta VALUES (?,'1')", ("k%d" % n,))
        with self.ledger.connect() as db:
            unfinished = db.execute("SELECT key FROM ledger_meta")
            unfinished.fetchone()
        with self.assertRaises(sqlite3.ProgrammingError):
            unfinished.fetchone()
        # An unfinished SELECT would still hold the shared lock: "database is locked".
        other = sqlite3.connect(self.path, timeout=0)
        self.addCleanup(other.close)
        other.execute("INSERT INTO ledger_meta VALUES ('other','1')")
        other.commit()
        with self.ledger.connect() as again:
            self.assertIs(again, db)
            self.assertIsNotNone(again.execute("SELECT 1 FROM ledger_meta WHERE key='other'").fetchone())

    def test_a_nested_block_has_its_own_connection_and_never_commits_the_outer_one(self):
        with self.assertRaises(RuntimeError):
            with self.ledger.connect() as outer:
                outer.execute("BEGIN IMMEDIATE")
                outer.execute("INSERT INTO ledger_meta VALUES ('outer','1')")
                with self.ledger.connect() as inner:
                    self.assertIsNot(inner, outer)
                    # A separate connection: the outer write is not visible yet.
                    self.assertIsNone(inner.execute("SELECT 1 FROM ledger_meta WHERE key='outer'").fetchone())
                self.assertTrue(outer.in_transaction)
                raise RuntimeError("synthetic")
        self.assertNotIn("outer", self.keys())
        with self.assertRaises(sqlite3.ProgrammingError):
            inner.execute("SELECT 1")

    def test_an_error_closes_the_connection_and_the_next_block_opens_a_new_one(self):
        with self.ledger.connect() as before:
            pass
        with self.assertRaises(sqlite3.IntegrityError):
            with self.ledger.connect() as failed:
                failed.execute("INSERT INTO ledger_meta VALUES ('dup','1')")
                failed.execute("INSERT INTO ledger_meta VALUES ('dup','2')")
        self.assertIs(failed, before)
        with self.assertRaises(sqlite3.ProgrammingError):
            failed.execute("SELECT 1")
        self.assertNotIn("dup", self.keys())
        with self.ledger.connect() as after:
            self.assertIsNot(after, failed)

    def test_export_wakeups_fire_after_commit_only_and_never_carry_over(self):
        with self.ledger.connect() as db:
            db.exported = True
        with self.ledger.connect() as db:
            db.execute("INSERT INTO ledger_meta VALUES ('quiet','1')")
        self.assertEqual(self.exports, [1])
        with self.assertRaises(RuntimeError):
            with self.ledger.connect() as db:
                db.exported = True
                raise RuntimeError("synthetic")
        with self.ledger.connect() as db:
            pass
        self.assertEqual(self.exports, [1])

    def test_other_threads_still_get_one_connection_per_block(self):
        with self.ledger.connect() as mine:
            pass
        seen = []

        def other():
            for _ in range(2):
                with self.ledger.connect() as db:
                    db.execute("INSERT OR REPLACE INTO ledger_meta VALUES ('thread','1')")
                    seen.append(db)
        thread = threading.Thread(target=other)
        thread.start()
        thread.join()
        self.assertIsNot(seen[0], seen[1])
        self.assertNotIn(mine, seen)
        with self.assertRaises(sqlite3.ProgrammingError):
            seen[0].execute("SELECT 1")
        with self.ledger.connect() as db:
            self.assertIs(db, mine)
            self.assertIsNotNone(db.execute("SELECT 1 FROM ledger_meta WHERE key='thread'").fetchone())

    def test_a_replaced_ledger_file_is_opened_again(self):
        with self.ledger.connect() as db:
            db.execute("INSERT INTO ledger_meta VALUES ('original','1')")
        replacement = self.path.with_name("replacement.sqlite3")
        source, target = sqlite3.connect(self.path), sqlite3.connect(replacement)
        source.backup(target)
        target.execute("INSERT INTO ledger_meta VALUES ('replacement','1')")
        target.commit()
        source.close()
        target.close()
        os.replace(replacement, self.path)
        with self.ledger.connect() as db:
            self.assertIsNotNone(db.execute("SELECT 1 FROM ledger_meta WHERE key='replacement'").fetchone())
        self.ledger.revoke()
        self.assertIn("revoked_ms", self.keys())  # Written to the file now at the path.


class KeepLifetimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def test_without_keep_every_block_still_closes_its_connection(self):
        ledger = Ledger(Path(self.temp.name) / "ledger.sqlite3", {"test_scope": "plain"})
        with ledger.connect() as first:
            pass
        with ledger.connect() as second:
            pass
        self.assertIsNot(first, second)
        with self.assertRaises(sqlite3.ProgrammingError):
            first.execute("SELECT 1")

    @unittest.skipUnless(os.path.isdir("/proc/self/fd"), "needs /proc")
    def test_kept_connections_stay_bounded_and_close_when_the_keep_ends(self):
        ledgers = [Ledger(Path(self.temp.name) / ("l%d.sqlite3" % n), {"test_scope": n}) for n in range(20)]
        # Closing must not depend on garbage collection (2026-10-29).
        gc.disable()
        self.addCleanup(gc.enable)
        before = open_fds()
        with ledgers[0].keep_connection():
            with ledgers[0].keep_connection():  # Nested keep: still one connection.
                for _ in range(25):
                    for ledger in ledgers:
                        ledger.next_input()
                        ledger.health()
            self.assertLessEqual(open_fds() - before, 1)
            with ledgers[0].connect() as db:
                pass
        with self.assertRaises(sqlite3.ProgrammingError):
            db.execute("SELECT 1")
        self.assertLessEqual(open_fds() - before, 0)

    def test_the_worker_run_loop_keeps_one_connection_and_closes_it(self):
        ledger = Ledger(Path(self.temp.name) / "ledger.sqlite3", {"test_scope": "worker"})
        worker = Worker(None, ledger, legacy_companions=True)
        seen = []

        class Stop:
            calls = 0

            def wait(self, _):
                Stop.calls += 1
                return Stop.calls > 3

        def run_once(_stop):
            with ledger.connect() as db:
                seen.append(db)
            return False
        worker.run_once = run_once
        worker.expire_stale = lambda: None
        worker.run(Stop())
        self.assertEqual(len(seen), 3)
        self.assertTrue(all(db is seen[0] for db in seen))
        with self.assertRaises(sqlite3.ProgrammingError):
            seen[0].execute("SELECT 1")


if __name__ == "__main__":
    unittest.main()
