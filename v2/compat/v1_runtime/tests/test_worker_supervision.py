"""Binding workers survive crashes and ledger outages; ledger connections close.

Incident 2026-10-29: on an adapter start, the soft RLIMIT_NOFILE (1024) was
exceeded and a random subset of the binding worker threads died of
`sqlite3.OperationalError: unable to open database file`. Nothing restarted
them and nothing reported them dead. Synthetic bindings only: no Rust, no
WhatsApp peer.
"""
import contextlib
import gc
import io
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from v2.compat.v1_runtime import registry as registry_module, worker as worker_module
from v2.compat.v1_runtime.ledger import Ledger
from v2.compat.v1_runtime.registry import Registry
from v2.compat.v1_runtime.worker import Signal, Worker
from v2.compat.v1_runtime.tests.test_ledger_server import OWNER, binding_doc, private_write


def open_fds():
    return len(os.listdir("/proc/self/fd"))


def wait_until(predicate, seconds=5):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


class LedgerConnectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.exports = []
        self.ledger = Ledger(Path(self.temp.name) / "ledger.sqlite3", {"test_scope": "one"},
                             on_export=lambda: self.exports.append(1))

    def test_connection_is_closed_after_the_block(self):
        with self.ledger.connect() as db:
            db.execute("SELECT 1").fetchone()
        with self.assertRaises(sqlite3.ProgrammingError):
            db.execute("SELECT 1")

    def test_commits_on_success_and_rolls_back_and_closes_on_error(self):
        with self.ledger.connect() as db:
            db.execute("INSERT INTO ledger_meta VALUES ('kept','1')")
        with self.assertRaises(RuntimeError):
            with self.ledger.connect() as failed:
                failed.execute("INSERT INTO ledger_meta VALUES ('dropped','1')")
                raise RuntimeError("synthetic")
        with self.assertRaises(sqlite3.ProgrammingError):
            failed.execute("SELECT 1")
        with self.ledger.connect() as db:
            keys = {row[0] for row in db.execute("SELECT key FROM ledger_meta")}
        self.assertIn("kept", keys)
        self.assertNotIn("dropped", keys)

    def test_export_wakeup_still_fires_after_commit_only(self):
        with self.ledger.connect() as db:
            db.exported = True
        self.assertEqual(self.exports, [1])
        with self.assertRaises(RuntimeError):
            with self.ledger.connect() as db:
                db.exported = True
                raise RuntimeError("synthetic")
        self.assertEqual(self.exports, [1])

    @unittest.skipUnless(os.path.isdir("/proc/self/fd"), "needs /proc")
    def test_open_file_descriptors_stay_bounded(self):
        ledgers = [Ledger(Path(self.temp.name) / ("l%d.sqlite3" % n), {"test_scope": n}) for n in range(20)]
        enqueued = ledgers[0].enqueue(dict(publicMessageId="p", publicThreadId="t", chatId="c", accountId="a", text="x"))
        self.assertTrue(enqueued)
        # Garbage collection must not be what closes connections.
        gc.disable()
        self.addCleanup(gc.enable)
        before = open_fds()
        held = []
        for _ in range(25):
            for ledger in ledgers:
                ledger.next_input()
                ledger.health()
                with ledger.connect() as db:
                    held.append(db)  # A live reference must not keep the fd open.
        self.assertLessEqual(open_fds() - before, 2)


class WorkerLedgerOutageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ledger = Ledger(Path(self.temp.name) / "ledger.sqlite3", {"test_scope": "one"})

    def test_unopenable_ledger_is_retried_not_fatal(self):
        worker = Worker(None, self.ledger)
        stop, calls = Signal(), []

        def run_once(_stop):
            calls.append(1)
            if len(calls) <= 6:
                raise sqlite3.OperationalError("unable to open database file")
            stop.set()
            return False

        worker.run_once = run_once
        stderr = io.StringIO()
        with patch.object(worker_module, "PASS_S", 0.01), \
                patch.object(worker_module, "ledger_retry_s", lambda attempt: 0.01), \
                contextlib.redirect_stderr(stderr):
            worker.run(stop)
        self.assertEqual(len(calls), 7)
        lines = stderr.getvalue().splitlines()
        self.assertEqual(len(lines), 2, lines)
        self.assertTrue(lines[0].startswith("WARN orkestr-v2-wa-adapter ledger_unavailable"))
        self.assertIn("error=OperationalError attempts=1", lines[0])
        self.assertTrue(lines[1].startswith("ALERT orkestr-v2-wa-adapter ledger_unavailable"))
        self.assertIn("attempts=%d" % worker_module.LEDGER_ALERT_AFTER, lines[1])
        self.assertNotIn("unable to open", stderr.getvalue())

    def test_retry_backoff_is_bounded(self):
        self.assertEqual([worker_module.ledger_retry_s(n) for n in range(1, 8)], [1, 2, 4, 8, 16, 30, 30])


class FakeWorker:
    """Raises `crashes` times (one RuntimeError per run), then steps until stopped."""
    plan = {}

    def __init__(self, client, ledger, **_):
        self.ledger, self.runs = ledger, 0

    def run(self, stop, active=lambda: True):
        self.runs += 1
        failures = self.plan.get(self.ledger.path, 0)
        if self.runs <= failures:
            raise RuntimeError("synthetic crash quoting private chat text")
        while not stop.wait(0.01):
            pass


class RegistrySupervisionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.bindings_dir, self.ledger_dir = root / "bindings", root / "ledgers"
        for directory in (self.bindings_dir, self.ledger_dir):
            directory.mkdir(mode=0o700)
        self.config = dict(listen_port=0, token="a" * 48, expected_owner=OWNER,
                           bindings_dir=str(self.bindings_dir), ledger_dir=str(self.ledger_dir))
        for n in (1, 2, 3):
            value = binding_doc(n)
            private_write(self.bindings_dir / (value["remote_thread_id"] + ".json"), value)
        self.remote = {n: binding_doc(n)["remote_thread_id"] for n in (1, 2, 3)}
        FakeWorker.plan = {}
        for target, value in ((registry_module, "Worker"),):
            patcher = patch.object(target, value, FakeWorker)
            patcher.start()
            self.addCleanup(patcher.stop)

    def start(self, delays=(0.01, 0.02, 0.03, 0.04)):
        FakeWorker.plan = {str(self.ledger_dir / (self.remote[n] + ".sqlite3")): count for n, count in self.crashes.items()}
        self.stderr = io.StringIO()
        redirect = contextlib.redirect_stderr(self.stderr)
        redirect.__enter__()
        self.addCleanup(redirect.__exit__, None, None, None)
        patcher = patch.object(registry_module, "WORKER_RESTART_S", delays)
        patcher.start()
        self.addCleanup(patcher.stop)
        registry = Registry(self.config, lambda conversation: None)
        registry.reload()
        self.addCleanup(registry.shutdown)
        return registry

    def test_crashed_worker_is_alerted_and_restarted_with_backoff(self):
        self.crashes = {2: 5}
        registry = self.start()
        self.assertTrue(wait_until(lambda: registry.status()["workers"]["alive"] == 3))
        status = registry.status()["workers"]
        self.assertEqual((status["expected"], status["alive"], status["enabledAlive"], status["crashes"], status["notAlive"]),
                         (3, 3, 3, 5, []))
        alerts = [line for line in self.stderr.getvalue().splitlines() if line.startswith("ALERT")]
        self.assertEqual(len(alerts), 5)
        for line in alerts:
            self.assertTrue(line.startswith("ALERT orkestr-v2-wa-adapter worker_crashed binding=%s error=RuntimeError"
                                            % self.remote[2]), line)
        self.assertEqual([re.search(r"restart_in_s=(\S+)", line).group(1) for line in alerts],
                         ["0.01", "0.02", "0.03", "0.04", "0.04"])
        # The exception message may quote chat text; only its class is logged.
        self.assertNotIn("private chat text", self.stderr.getvalue())
        worker = registry.get(self.remote[2]).worker_status()
        self.assertEqual(worker, {"alive": True, "state": "running", "crashes": 5, "lastError": "RuntimeError"})

    def test_backing_off_worker_is_reported_not_alive(self):
        self.crashes = {1: 1}
        registry = self.start(delays=(30,))
        binding = registry.get(self.remote[1])
        self.assertTrue(wait_until(lambda: binding.worker_status()["state"] == "restarting"))
        self.assertTrue(wait_until(lambda: registry.status()["workers"]["alive"] == 2))
        status = registry.status()["workers"]
        self.assertEqual((status["alive"], status["notAlive"]), (2, [self.remote[1]]))
        self.assertFalse(binding.worker_status()["alive"])
        # A new input must not cut the backoff short; stopping ends it at once.
        binding.stop.wake()
        time.sleep(0.05)
        self.assertEqual(binding.worker_status()["state"], "restarting")
        started = time.monotonic()
        registry.shutdown()
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(binding.worker_status()["state"], "stopped")

    def test_default_restart_ladder(self):
        self.assertEqual(registry_module.WORKER_RESTART_S, (1, 5, 30, 60))


class HealthSurfaceTests(unittest.TestCase):
    def test_worker_liveness_is_in_status_without_workers(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "b").mkdir(mode=0o700)
            (root / "l").mkdir(mode=0o700)
            value = binding_doc(1)
            private_write(root / "b" / (value["remote_thread_id"] + ".json"), value)
            registry = Registry(dict(expected_owner=OWNER, bindings_dir=str(root / "b"), ledger_dir=str(root / "l")),
                                lambda conversation: None, workers=False)
            status = registry.reload()
            self.assertEqual(status["workers"], {"expected": 0, "alive": 0, "enabledAlive": 0, "crashes": 0, "notAlive": []})
            self.assertEqual(registry.get(value["remote_thread_id"]).worker_status()["state"], "absent")


if __name__ == "__main__":
    unittest.main()
