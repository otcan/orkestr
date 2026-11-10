"""A busy ledger delays custody housekeeping; it no longer stops the service.

2026-11-03: under host CPU/IO starvation one housekeeping pass failed, main()
swallowed the cause, close() interrupted the server and the whole service
exited 2 with only "timer controller failed during shutdown" in the log.
Synthetic objects only; no account, provider or network.
"""
import contextlib
import io
import os
import sqlite3
import tempfile
import unittest
import unittest.mock

from codex_service import manager as manager_module
from codex_service.contract import Refused
from codex_service.ledger import Ledger
from codex_service.manager import Manager, TICK_BUSY_GRACE_S
from test_codex_service_ledger import Clock, uid


def busy():
    return sqlite3.OperationalError("database is locked")


class GuardedTickTests(unittest.TestCase):
    def manager(self, *outcomes):
        manager = Manager.__new__(Manager)
        calls = iter(outcomes)

        def tick():
            outcome = next(calls)
            if outcome is not None:
                raise outcome
        manager.tick = tick
        return manager

    def run_tick(self, manager, now):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            manager.guarded_tick(now)
        return stderr.getvalue()

    def test_busy_ledger_is_deferred_logged_once_and_recovers(self):
        manager = self.manager(busy(), busy(), None)
        first = self.run_tick(manager, 100.0)
        self.assertIn("manager tick deferred (ledger busy): OperationalError: database is locked", first)
        self.assertIn("Traceback", first)
        self.assertEqual(self.run_tick(manager, 100.25), "", "a continuing busy spell is logged once")
        recovered = self.run_tick(manager, 100.5)
        self.assertIn("manager tick recovered: ledger busy for 0.5s over 2 passes", recovered)
        self.assertIsNone(manager.tick_busy_since)

    def test_busy_ledger_past_the_grace_stops_as_before(self):
        manager = self.manager(busy(), busy())
        self.run_tick(manager, 100.0)
        with self.assertRaises(sqlite3.OperationalError):
            self.run_tick(manager, 100.0 + TICK_BUSY_GRACE_S)

    def test_a_new_busy_spell_gets_a_fresh_grace(self):
        manager = self.manager(busy(), None, busy(), None)
        self.run_tick(manager, 100.0)
        self.run_tick(manager, 101.0)
        self.run_tick(manager, 100.0 + TICK_BUSY_GRACE_S + 5)  # Not 35 s since the first spell's start.
        self.run_tick(manager, 100.0 + TICK_BUSY_GRACE_S + 6)

    def test_unexpected_server_exit_is_never_tolerated(self):
        manager = self.manager(Refused("unexpected_server_exit"))
        with self.assertRaisesRegex(Refused, "unexpected_server_exit"):
            self.run_tick(manager, 100.0)

    def test_other_errors_are_never_tolerated(self):
        manager = self.manager(OSError("proc walk"))
        with self.assertRaises(OSError):
            self.run_tick(manager, 100.0)


class MainReportsTheCauseTests(unittest.TestCase):
    def test_an_unplanned_stop_logs_the_exception_and_exits_2(self):
        class Failing:
            def __init__(self, root, expected):
                pass

            def start(self):
                pass

            def once(self):
                raise sqlite3.OperationalError("database is locked")

            def close(self):
                return False

        stderr, stdout = io.StringIO(), io.StringIO()
        with unittest.mock.patch.object(manager_module, "Manager", Failing), \
                contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(stdout):
            self.assertEqual(manager_module.main("root", "expected"), 2)
        self.assertIn("manager stopping after: OperationalError: database is locked", stderr.getvalue())
        self.assertIn("Traceback", stderr.getvalue())
        self.assertIn('"clean_shutdown": false', stdout.getvalue())


class LedgerCommitFailureTests(unittest.TestCase):
    def test_a_failed_commit_ends_the_transaction(self):
        temp = tempfile.TemporaryDirectory(prefix="synthetic-ledger-commit-")
        self.addCleanup(temp.cleanup)
        ledger = Ledger(os.path.join(temp.name, "ledger.sqlite3"), uid(), uid(), clock=Clock())
        self.addCleanup(ledger.close)
        real = ledger.db

        class CommitFails:
            """Delegates to the real connection; its first COMMIT fails busy."""
            failed = False

            def execute(self, sql, *args):
                if sql == "COMMIT" and not self.failed:
                    self.failed = True
                    raise sqlite3.OperationalError("database is locked")
                return real.execute(sql, *args)

            def __getattr__(self, name):
                return getattr(real, name)

        ledger.db = CommitFails()
        with self.assertRaises(sqlite3.OperationalError):
            with ledger.transaction():
                real.execute("CREATE TABLE synthetic_probe (x INTEGER)")
        self.assertFalse(real.in_transaction)
        with ledger.transaction():  # The next pass starts normally.
            pass
        names = {row[0] for row in real.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertNotIn("synthetic_probe", names, "the failed commit's change is rolled back")


if __name__ == "__main__":
    unittest.main()
