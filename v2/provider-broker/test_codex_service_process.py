"""Owned synthetic children only; no account, provider binary or remote network."""
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest

from codex_bounded.trust import process
from codex_service.channel import receive, respond, ServerPeer
from codex_service.contract import Refused, encode
from codex_service.manager import Manager
from codex_service.ownership import Children
from test_codex_service_ledger import LedgerTests, uid


class ProcessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="synthetic-service-process-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "codex_service").mkdir()
        self.entry = self.root / "codex_service/entry.py"
        self.entry.write_text("import os,signal,time\nos.kill(os.getpid(),signal.SIGSTOP)\ntime.sleep(0.02)\n")
        self.package = SimpleNamespace(root=self.root, uid=os.getuid())
        self.children = Children(self.package, process(os.getpid()))
        self.addCleanup(self.children.close)
        self.owned = []
        self.addCleanup(self.cleanup)

    def cleanup(self):
        for child in self.owned:
            if child.poll() is None:
                child.kill()
            child.wait(3)

    def spawn(self, extra=None):
        argv = [str(Path("/usr/bin/python3").resolve()), "-I", "-S", "-B", str(self.entry),
                "broker", "open-owned-session", "--protocol", "orkestr-v2-provider-broker-v1"]
        child = subprocess.Popen(argv + (extra or []), env={"PATH": "/usr/bin:/bin"},
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.owned.append(child)
        return child

    def test_original_paused_child_is_bound_before_continue_and_must_be_reaped(self):
        child = self.spawn()
        identity = process(child.pid)
        self.assertTrue(self.children.bind(child.pid, identity["start"], time.monotonic() + 2))
        self.assertFalse(self.children.bind(child.pid, identity["start"], time.monotonic() + 2))
        with self.assertRaises(Refused):
            self.children.proven_gone()
        child.wait(3)
        self.assertTrue(self.children.proven_gone())
        self.assertFalse(self.children.forced)

    def test_wrong_start_extra_argument_and_empty_tree_never_create_proof(self):
        with self.assertRaisesRegex(Refused, "original_cleanup_proof_missing"):
            self.children.proven_gone()
        child = self.spawn(["untrusted"])
        identity = process(child.pid)
        with self.assertRaisesRegex(Refused, "broker_owner"):
            self.children.bind(child.pid, identity["start"] + 1, time.monotonic() + 1)
        # Wait for exec so this tests exact closed argv rather than a pre-exec race.
        deadline = time.monotonic() + 2
        while b"untrusted" not in Path(f"/proc/{child.pid}/cmdline").read_bytes():
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.005)
        with self.assertRaisesRegex(Refused, "broker_source"):
            self.children.bind(child.pid, identity["start"], time.monotonic() + 1)
        self.assertFalse(self.children.brokers)

    def test_forced_cleanup_is_permanently_uncertain_for_retirement(self):
        self.entry.write_text("import os,signal,time\nos.kill(os.getpid(),signal.SIGSTOP)\ntime.sleep(30)\n")
        child = self.spawn()
        identity = process(child.pid)
        self.children.bind(child.pid, identity["start"], time.monotonic() + 2)
        self.assertTrue(self.children.cleanup())
        self.assertTrue(self.children.forced)
        with self.assertRaisesRegex(Refused, "original_cleanup_proof_missing"):
            self.children.proven_gone()

    def test_frame_deadline_truncation_and_extra_bytes_are_bounded(self):
        request = {"version": 1, "operation": "status", "request_id": "synthetic",
                   "owner_id": uid(), "conversation_id": uid()}
        for payload in (encode(request), encode(request) + b"extra", encode(request)[:-2], b"\x00"):
            with self.subTest(size=len(payload)), self.pair() as pair:
                left, right = pair
                right.sendall(payload)
                if payload == encode(request):
                    self.assertEqual(receive(left, time.monotonic() + 0.1), request)
                    respond(left, {"ok": True}, time.monotonic() + 0.1)
                    self.assertTrue(right.recv(128))
                else:
                    before = time.monotonic()
                    with self.assertRaises(Refused):
                        receive(left, time.monotonic() + 0.05)
                    self.assertLess(time.monotonic() - before, 0.2)

    @staticmethod
    def pair():
        from contextlib import contextmanager
        @contextmanager
        def sockets():
            left, right = socket.socketpair()
            try:
                yield left, right
            finally:
                left.close()
                right.close()
        return sockets()

    def test_same_uid_unrelated_process_cannot_parse_control(self):
        child = self.spawn()
        peer = ServerPeer(process(child.pid), Path(sys.executable).resolve())
        with self.pair() as (left, _right):
            self.assertFalse(peer.accepts(left))


class LifecycleTests(LedgerTests):
    # Use the existing disposable ledger fixture without copying its tests.
    def test_unexpected_clean_ui_exit_marks_window_and_manager_failed(self):
        self.admit()
        child = subprocess.Popen(["/usr/bin/true"], env={"PATH": "/usr/bin:/bin"})
        child.wait(2)
        manager = Manager.__new__(Manager)
        manager.child, manager.ledger = child, self.ledger
        manager.failed = manager.closed = False
        with self.assertRaisesRegex(Refused, "unexpected_server_exit"):
            manager.tick()
        self.assertTrue(manager.failed)
        self.assertEqual(self.ledger.status()["state"], "reconciliation")
        self.assertEqual(self.ledger.status()["reason"], "server_lost")

    def test_normal_expiry_keeps_ui_alive_and_metadata_pending(self):
        request = self.admit()
        child = subprocess.Popen(["/usr/bin/sleep", "10"], env={"PATH": "/usr/bin:/bin"})
        self.addCleanup(lambda: (child.kill(), child.wait(2)) if child.poll() is None else None)
        manager = Manager.__new__(Manager)
        manager.child, manager.ledger = child, self.ledger
        manager.failed = manager.closed = False
        manager.children = manager.egress = manager.budget = None
        self.clock.advance(901)
        manager.tick()
        self.assertIsNone(child.poll())
        self.assertEqual(self.ledger.status()["state"], "expired")
        retirement = {**self.retirement(request), "operation": "retire"}
        with self.assertRaisesRegex(Refused, "original_cleanup_proof_missing"):
            manager.dispatch(retirement)
        manager.tick()
        self.assertEqual(self.ledger.status()["state"], "expired")


# Load only these two lifecycle cases; the inherited ledger cases have their
# own authoritative suite, and are not counted twice as independent coverage.
def load_tests(loader, _tests, _pattern):
    suite = loader.loadTestsFromTestCase(ProcessTests)
    for name in ("test_unexpected_clean_ui_exit_marks_window_and_manager_failed",
                 "test_normal_expiry_keeps_ui_alive_and_metadata_pending"):
        suite.addTest(LifecycleTests(name))
    return suite


if __name__ == "__main__":
    unittest.main()
