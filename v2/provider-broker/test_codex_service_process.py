"""Owned synthetic children only; no account, provider binary or remote network."""
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
import unittest.mock

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

    def test_observation_failure_still_reaps_known_children_without_creating_proof(self):
        self.entry.write_text("import os,signal,time\nos.kill(os.getpid(),signal.SIGSTOP)\ntime.sleep(30)\n")
        child = self.spawn()
        identity = process(child.pid)
        self.assertTrue(self.children.bind(child.pid, identity["start"], time.monotonic() + 2))
        with unittest.mock.patch.object(self.children, "observe", side_effect=Refused("owned_child_metadata")):
            self.assertFalse(self.children.cleanup(0.3))
        child.wait(3)
        self.assertIsNone(process(child.pid))
        self.assertTrue(self.children.uncertain)
        self.assertTrue(self.children.forced)
        self.assertEqual(self.children.uncertainty_reason, "owned_child_metadata")
        self.assertFalse(self.children.released())
        with self.assertRaisesRegex(Refused, "original_cleanup_proof_missing"):
            self.children.proven_gone()

    def test_unreaped_zombie_at_cleanup_deadline_recovers_once_reaped(self):
        # A refused broker is the server's child: it stays a zombie until the
        # server reaps it, which happens only after the manager replied.
        self.entry.write_text("import os,signal,time\nos.kill(os.getpid(),signal.SIGSTOP)\ntime.sleep(30)\n")
        children = Children(self.package, process(os.getpid()))
        self.addCleanup(children.close)
        child = self.spawn()
        identity = process(child.pid)
        self.assertTrue(children.bind(child.pid, identity["start"], time.monotonic() + 2))
        with unittest.mock.patch("codex_service.ownership.os.waitid", side_effect=ChildProcessError):
            self.assertFalse(children.cleanup(0.2))  # Killed, not yet reaped.
        self.assertTrue(children.forced)
        self.assertFalse(children.uncertain)
        self.assertFalse(children.released())
        child.wait(3)  # The server reaps it after the reply.
        self.assertTrue(children.released())
        with self.assertRaisesRegex(Refused, "original_cleanup_proof_missing"):
            children.proven_gone()  # Never graceful retirement proof.

    def host_children(self):
        package = SimpleNamespace(root=self.root, uid=os.getuid(), beta={
            "host_full_access": {"environment": {"HOME": "/synthetic", "PATH": "/usr/bin:/bin"}}})
        children = Children(package, process(os.getpid()))
        self.addCleanup(children.close)
        return children

    def bound_parent(self, children):
        # The bound broker starts one long-lived descendant (a host command).
        self.entry.write_text("import os,signal,subprocess,time\nos.kill(os.getpid(),signal.SIGSTOP)\n"
                              "child=subprocess.Popen(['/usr/bin/sleep','30'])\n"
                              "time.sleep(30)\n")
        child = self.spawn()
        identity = process(child.pid)
        self.assertTrue(children.bind(child.pid, identity["start"], time.monotonic() + 2))
        deadline = time.monotonic() + 2
        while not Path(f"/proc/{child.pid}/task/{child.pid}/children").read_text().split():
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.005)
        return child, int(Path(f"/proc/{child.pid}/task/{child.pid}/children").read_text().split()[0])

    def test_host_descendant_running_as_another_uid_stays_owned(self):
        import codex_service.ownership as ownership
        real = ownership.process
        for host in (False, True):
            children = self.host_children() if host else self.children
            child, grandchild = self.bound_parent(children)

            def setuid_view(pid):
                identity = real(pid)
                if identity is not None and pid == grandchild:
                    identity["uid"] = 0  # As /proc reports a running sudo.
                return identity
            with unittest.mock.patch.object(ownership, "process", setuid_view):
                if not host:
                    with self.assertRaisesRegex(Refused, "owned_child_identity"):
                        children.observe()
                    self.assertTrue(children.uncertain)
                else:
                    children.observe()
                    self.assertIn(grandchild, {key[0] for key in children.records})
                    self.assertFalse(children.uncertain)
                    start = real(grandchild)["start"]
                    # Cleanup reaches the foreign-uid descendant and proves its reap.
                    self.assertTrue(children.cleanup())
                    current = real(grandchild)
                    self.assertTrue(current is None or current["start"] != start)
            child.kill()
            child.wait(3)

    def test_reaped_descendants_do_not_exhaust_the_window_bound(self):
        for children in (self.children, self.host_children()):
            batch = []
            for _ in range(children.bound + 64):
                batch.append(subprocess.Popen(["/usr/bin/true"], env={"PATH": "/usr/bin:/bin"}))
                # Remember while alive or as an unreaped zombie, then reap it.
                identity = process(batch[-1].pid)
                children.remember(identity)
                batch[-1].wait(3)
            self.assertLessEqual(len(children.records), children.bound)
            # Every reaped original remains proven gone; nothing live was dropped.
            self.assertTrue(all(record.gone() for record in children.records.values()))

    def churning_parent(self, children):
        # The bound broker keeps starting and reaping short-lived helpers,
        # like a native CLI probing git/shell at startup.
        self.entry.write_text("import os,signal,subprocess,time\nos.kill(os.getpid(),signal.SIGSTOP)\n"
                              "end=time.monotonic()+30\n"
                              "while time.monotonic()<end:\n"
                              "    subprocess.run(['/usr/bin/true'])\n")
        child = self.spawn()
        identity = process(child.pid)
        self.assertTrue(children.bind(child.pid, identity["start"], time.monotonic() + 2))
        return child

    def test_short_lived_descendants_never_make_cleanup_uncertain(self):
        # Host full access is the deployed mode. (Without it, /proc may briefly
        # report another uid for an exec-ing child; that stays strict.)
        for children in (self.host_children(),):
            child = self.churning_parent(children)
            deadline = time.monotonic() + 1.5
            while time.monotonic() < deadline:
                children.observe()
            self.assertFalse(children.uncertain)
            self.assertIsNone(children.uncertainty_reason)
            self.assertTrue(children.cleanup())
            child.wait(3)
            self.assertTrue(children.released())

    def test_descendant_reaped_while_pinned_is_skipped_not_uncertain(self):
        import codex_bounded.trust as trust
        import codex_service.ownership as ownership
        real_process, real_open = trust.process, ownership.os.pidfd_open
        for host in (False, True):
            for mode in ("before_pin", "pin_refused", "after_pin", "pid_reused"):
                children = self.host_children() if host else Children(self.package, process(os.getpid()))
                self.addCleanup(children.close)
                child, grandchild = self.bound_parent(children)
                state = {"lookups": 0, "pinned": False}

                def view(pid):
                    identity = real_process(pid)
                    if identity is None or pid != grandchild:
                        return identity
                    state["lookups"] += 1
                    if mode == "before_pin" and state["lookups"] > 1:
                        return None
                    if mode == "after_pin" and state["pinned"]:
                        return None
                    if mode == "pid_reused" and state["pinned"]:
                        identity["start"] += 1
                    return identity

                def pin(pid, flags):
                    if pid == grandchild:
                        state["pinned"] = True
                        if mode == "pin_refused":
                            raise ProcessLookupError(3, "No such process")
                    return real_open(pid, flags)
                with unittest.mock.patch.object(ownership, "process", view), \
                        unittest.mock.patch.object(trust, "process", view), \
                        unittest.mock.patch.object(ownership.os, "pidfd_open", pin):
                    children.observe()
                self.assertFalse(children.uncertain, (host, mode))
                self.assertNotIn(grandchild, {key[0] for key in children.records}, (host, mode))
                # The real descendant is found again on the next pass.
                children.observe()
                self.assertIn(grandchild, {key[0] for key in children.records}, (host, mode))
                self.assertTrue(children.cleanup())
                self.assertTrue(children.forced)
                child.wait(3)
                self.assertTrue(children.released(), (host, mode))

    def test_live_identity_change_after_pin_stays_uncertain(self):
        import codex_bounded.trust as trust
        import codex_service.ownership as ownership
        real_process, real_open = trust.process, ownership.os.pidfd_open
        child, grandchild = self.bound_parent(self.children)
        pinned = []

        def view(pid):
            identity = real_process(pid)
            if identity is not None and pid == grandchild and pinned:
                identity["uid"] = 0  # Alive, same start, another uid: not reaped.
            return identity

        def pin(pid, flags):
            if pid == grandchild:
                pinned.append(pid)
            return real_open(pid, flags)
        with unittest.mock.patch.object(ownership, "process", view), \
                unittest.mock.patch.object(trust, "process", view), \
                unittest.mock.patch.object(ownership.os, "pidfd_open", pin):
            with self.assertRaisesRegex(Refused, "owned_process_changed"):
                self.children.observe()
        self.assertTrue(self.children.uncertain)
        self.assertEqual(self.children.uncertainty_reason, "owned_process_changed")
        self.assertFalse(self.children.released())
        child.kill()
        child.wait(3)

    def test_strict_pin_of_reaped_identity_still_refuses(self):
        done = subprocess.Popen(["/usr/bin/true"])
        identity = process(done.pid)
        done.wait(3)
        with self.assertRaisesRegex(Refused, "owned_process_missing"):
            self.children.remember(identity)

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
        manager.windows, manager.egress, manager.guard = {}, None, threading.RLock()
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
        manager.windows, manager.egress, manager.guard = {}, None, threading.RLock()
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
    suite.addTests(loader.loadTestsFromTestCase(UnreapedChildDiagnosticTests))
    for name in ("test_unexpected_clean_ui_exit_marks_window_and_manager_failed",
                 "test_normal_expiry_keeps_ui_alive_and_metadata_pending"):
        suite.addTest(LifecycleTests(name))
    return suite


class UnreapedChildDiagnosticTests(__import__("unittest").TestCase):
    def test_live_owned_child_is_named_by_pid_and_comm_only(self):
        import io
        from contextlib import redirect_stderr
        from codex_service.ownership import Children
        children = object.__new__(Children)
        live = SimpleNamespace(identity={"pid": os.getpid()}, gone=lambda: False)
        dead = SimpleNamespace(identity={"pid": 1}, gone=lambda: True)
        children.records = {(os.getpid(), 1): live, (1, 1): dead}
        err = io.StringIO()
        with redirect_stderr(err):
            self.assertEqual(Children._log_live(children), [live])
        comm = Path(f"/proc/{os.getpid()}/comm").read_text().strip()[:15]
        self.assertEqual(err.getvalue(), "manager owned child not reaped: %d:%s\n" % (os.getpid(), comm))
        children.records = {(1, 1): dead}
        err = io.StringIO()
        with redirect_stderr(err):
            self.assertEqual(Children._log_live(children), [])
        self.assertEqual(err.getvalue(), "")

    def test_window_diagnostic_distinguishes_uncertainty_and_deduplicates(self):
        import io
        from contextlib import redirect_stderr
        window = SimpleNamespace(window="11111111-1111-4111-8111-111111111111", generation=3,
                                 children=SimpleNamespace(uncertain=True, forced=True,
                                                          uncertainty_reason="owned_child_bound"))
        err = io.StringIO()
        with redirect_stderr(err):
            Manager._cleanup_notice(window)
            Manager._cleanup_notice(window)
        self.assertEqual(err.getvalue(), "manager window cleanup refused: window=11111111-1111-4111-8111-111111111111 generation=3 reason=owned_child_bound forced=1\n")


if __name__ == "__main__":
    unittest.main()
