"""Manager custody for concurrent windows; synthetic ledgers and fakes only.

No server, broker, socket or provider runs. Fakes record which window's custody
each manager transition touched, proving one window never closes, spends or
retires another window's children, relay or budget.
"""
import threading
import io
import json
import os
import subprocess
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from pathlib import Path
import tempfile

from codex_bounded.trust import process
import codex_service.manager as module
import codex_service.manager_uncertain as uncertain
import codex_service.ownership as ownership
from codex_service.contract import Refused
from codex_service.ledger import Ledger
from codex_service.manager import Manager
from test_codex_service_ledger import Clock, uid


class FakeChildren:
    def __init__(self):
        self.cleaned = self.closed = self.proved = False
        self.forced = False

    def observe(self):
        pass

    def proven_gone(self):
        self.proved = True
        return True

    def cleanup(self, seconds=2):
        self.cleaned = True
        return True

    def close(self):
        self.closed = True


class FakeWindow:
    def __init__(self, _package, _server, _ledger, window, generation):
        self.window, self.generation = window, generation
        self.children = FakeChildren()
        self.egress_closed = False

    def close_egress(self):
        self.egress_closed = True


class FakeEndpoint:
    opened = []

    def __init__(self, _package, _owned, windows, lock):
        self.windows, self.lock = windows, lock
        self.failed = self.closed = False
        self.thread = SimpleNamespace(start=lambda: None)
        FakeEndpoint.opened.append(self)

    def close(self):
        self.closed = True


class Windows(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.clock = Clock()
        self.owner, self.home = uid(), uid()
        self.ledger = Ledger(str(Path(temp.name) / "ledger.sqlite3"), self.owner, self.home,
                             clock=self.clock, live_windows=2)
        self.addCleanup(self.ledger.close)
        manager = Manager.__new__(Manager)
        manager.package = SimpleNamespace(endpoint="/synthetic/egress.sock", gid=1,
                                          verify_inventory=lambda: None)
        manager.ledger, manager.identity, manager.child = self.ledger, {"pid": 1}, None
        manager.windows, manager.egress, manager.guard = {}, None, threading.RLock()
        manager.failed = manager.closed = False
        self.manager = manager
        FakeEndpoint.opened = []
        for name, value in (("Window", FakeWindow), ("Endpoint", FakeEndpoint),
                            ("OwnedSocket", lambda *_args: object())):
            patcher = patch.object(module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def admit(self, conversation, key="first"):
        now = self.clock.wall // 1_000_000
        request = dict(version=1, operation="admit", owner_id=self.owner,
                       conversation_id=conversation, request_id=key, window_id=uid(),
                       generation=1, expected_generation=0, input_message_id=uid(),
                       input_event_id=uid(), input_request_key=uid(),
                       predecessor_window_id=None, opened_at_ms=now,
                       work_deadline_ms=now + 870000, expires_at_ms=now + 900000)
        answer = self.manager.dispatch(request)
        self.assertTrue(answer["ok"] and answer["fresh_window"])
        return request

    def retire(self, request):
        return self.manager.dispatch({**request, "operation": "retire", "request_id": uid(),
                                      "outcome": "accepted", "run_id": uid(),
                                      "terminal_event_id": uid()})

    def test_two_conversations_hold_separate_custody_behind_one_listener(self):
        other = uid()
        a, b = self.admit(self.home), self.admit(other)
        first, second = (self.manager.windows[r["window_id"]] for r in (a, b))
        self.assertIsNot(first.children, second.children)
        self.assertEqual(len(FakeEndpoint.opened), 1)
        with self.assertRaisesRegex(Refused, "window_capacity"):
            self.admit(uid())
        self.retire(a)
        self.assertTrue(first.children.proved and first.children.closed and first.egress_closed)
        self.assertFalse(second.egress_closed or second.children.cleaned)
        self.assertNotIn(a["window_id"], self.manager.windows)
        self.assertFalse(FakeEndpoint.opened[0].closed)
        self.retire(b)
        self.assertTrue(FakeEndpoint.opened[0].closed)
        self.assertIsNone(self.manager.egress)
        # A later window gets a fresh listener epoch and its own custody.
        self.admit(uid(), "later")
        self.assertEqual(len(FakeEndpoint.opened), 2)

    def test_invalid_package_refuses_before_admission_and_alerts_once_until_recovered(self):
        def invalid():
            raise Refused("unexpected_package_file")
        self.manager.package.verify_inventory = invalid
        with patch.object(module.sys, "stderr", io.StringIO()) as output:
            for _ in range(2):
                with self.assertRaisesRegex(Refused, "^package_inventory$"):
                    self.admit(self.home)
            self.assertEqual(output.getvalue(),
                             "ALERT orkestr-v2-manager package_inventory_invalid\n")
            self.assertEqual(self.manager.windows, {})
            self.assertEqual(FakeEndpoint.opened, [])
            self.manager.package.verify_inventory = lambda: None
            self.admit(self.home)
            self.manager.package.verify_inventory = invalid
            with self.assertRaisesRegex(Refused, "^package_inventory$"):
                self.admit(uid())
            self.assertEqual(output.getvalue().count("package_inventory_invalid"), 2)

    def test_uncertainty_terminates_only_the_reported_window(self):
        a, b = self.admit(self.home), self.admit(uid())
        self.manager.dispatch({**a, "operation": "uncertain", "reason": "runtime_refused"})
        first, second = (self.manager.windows[r["window_id"]] for r in (a, b))
        self.assertTrue(first.egress_closed and first.children.cleaned)
        self.assertFalse(second.egress_closed or second.children.cleaned)
        self.assertEqual(self.ledger.status(self.home)["state"], "reconciliation")
        self.assertEqual(self.ledger.status(b["conversation_id"])["state"], "active")
        with self.assertRaisesRegex(Refused, "original_cleanup_proof_missing|window_reconciliation_required"):
            self.retire(a)
        self.retire(b)

    def test_expiry_and_shutdown_cover_every_live_window(self):
        a = self.admit(self.home)
        self.clock.advance(400)
        b = self.admit(uid())
        self.manager.child = SimpleNamespace(poll=lambda: None)
        self.clock.advance(501)
        self.manager.tick()
        first, second = (self.manager.windows[r["window_id"]] for r in (a, b))
        self.assertEqual(self.ledger.status(self.home)["state"], "expired")
        self.assertTrue(first.egress_closed and first.children.cleaned)
        self.assertFalse(second.egress_closed)
        self.manager._uncertain_all("manager_stopped")
        self.assertTrue(self.manager._terminate_all())
        self.assertTrue(second.egress_closed and second.children.cleaned)
        for request in (a, b):
            self.assertEqual(self.ledger.status(request["conversation_id"])["state"], "reconciliation")
        self.assertTrue(FakeEndpoint.opened[0].closed)

    def test_untraceable_descendants_close_only_their_window(self):
        a, b = self.admit(self.home), self.admit(uid())
        first, second = (self.manager.windows[r["window_id"]] for r in (a, b))

        def overflow():
            raise Refused("owned_child_bound")
        first.children.observe = overflow
        self.manager.child = SimpleNamespace(poll=lambda: None)
        self.manager.tick()  # Never raises: the shared manager keeps serving.
        self.assertTrue(first.egress_closed and first.children.cleaned)
        receipt = self.ledger.status(self.home)
        self.assertEqual((receipt["state"], receipt["reason"]), ("reconciliation", "cleanup_unknown"))
        self.assertFalse(second.egress_closed or second.children.cleaned)
        self.assertEqual(self.ledger.status(b["conversation_id"])["state"], "active")
        self.assertFalse(self.manager.failed)
        self.retire(b)

    def test_extend_needs_live_custody_of_that_window(self):
        a = self.admit(self.home)
        extend = {**{k: a[k] for k in ("version", "owner_id", "conversation_id", "window_id", "generation")},
                  "operation": "extend", "request_id": uid(), "expires_at_ms": a["opened_at_ms"] + 1_800_000}
        answer = self.manager.dispatch(extend)
        self.assertEqual(answer["receipt"]["expires_at_ms"], a["opened_at_ms"] + 1_800_000)
        self.manager.windows[a["window_id"]].egress_closed = True
        with self.assertRaisesRegex(Refused, "window_not_extendable"):
            self.manager.dispatch({**extend, "request_id": uid(), "expires_at_ms": a["opened_at_ms"] + 2_700_000})

    def test_server_loss_marks_every_live_window(self):
        a, b = self.admit(self.home), self.admit(uid())
        self.manager.child = SimpleNamespace(poll=lambda: 0)
        with self.assertRaisesRegex(Refused, "unexpected_server_exit"):
            self.manager.tick()
        for request in (a, b):
            receipt = self.ledger.status(request["conversation_id"])
            self.assertEqual((receipt["state"], receipt["reason"]), ("reconciliation", "server_lost"))


class TickPaceTests(unittest.TestCase):
    """Custody housekeeping is paced; a waiting control request never is."""

    def manager(self, accepts):
        manager = Manager.__new__(Manager)
        manager.ticks = 0
        manager.tick = lambda: setattr(manager, "ticks", manager.ticks + 1)
        def accept():
            accepts.append(1)
            raise module.socket.timeout()
        manager.control = SimpleNamespace(socket=SimpleNamespace(accept=accept))
        return manager

    def test_housekeeping_runs_at_most_once_per_tick_interval(self):
        accepts = []
        manager = self.manager(accepts)
        clock = [100.0]
        with patch.object(module.time, "monotonic", lambda: clock[0]):
            for _ in range(5):
                manager.once()
            self.assertEqual((manager.ticks, len(accepts)), (1, 5))
            clock[0] += module.TICK_S
            manager.once()
            self.assertEqual(manager.ticks, 2)
            clock[0] -= 10  # A clock step backwards never stalls housekeeping.
            manager.once()
            self.assertEqual(manager.ticks, 3)

def wait_for(condition, seconds=5):
    deadline = module.time.monotonic() + seconds
    while not condition():
        if module.time.monotonic() > deadline:
            raise AssertionError("condition not reached")
        module.time.sleep(0.01)


class OperatorReleaseTests(unittest.TestCase):
    """ORK-781: an uncertain window's custody is released only after its
    recorded tree, and what its failed walk could not record, are gone by pid
    and start time; then the same manager reconciles it without a restart.
    Real processes of this test's own uid; the manager parts are fakes."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.directory = Path(temp.name)
        self.owner, self.home = uid(), uid()
        self.ledger = Ledger(str(self.directory / "ledger.sqlite3"), self.owner, self.home, clock=Clock())
        self.addCleanup(self.ledger.close)
        now = Clock().wall // 1_000_000
        self.request = dict(version=1, operation="admit", owner_id=self.owner, conversation_id=self.home,
                            request_id=uid(), window_id=uid(), generation=1, expected_generation=0,
                            input_message_id=uid(), input_event_id=uid(), input_request_key=uid(),
                            predecessor_window_id=None, opened_at_ms=now, work_deadline_ms=now + 870000,
                            expires_at_ms=now + 900000)
        self.ledger.admit(self.request)
        package = SimpleNamespace(identity_split=True, uid=os.geteuid(), beta={}, ledger_directory=self.directory)
        self.children = ownership.Children(package, process(os.getpid()))
        self.processes = []
        # A broker tree (shell and its command) and an unrelated process that
        # stands for a descendant the walk met but could not record (another
        # uid in production: ownership.py owned_child_identity).
        self.broker = self.spawn(["/bin/sh", "-c", "/bin/sleep 60 & wait"])
        broker = process(self.broker.pid)
        key = (broker["pid"], broker["start"])
        self.children.remember(broker)
        self.children.brokers.add(key)
        self.children.managed_brokers.add(key)
        self.children.families[key] = {key}
        wait_for(lambda: self.children._children(broker))
        self.children.observe()
        self.assertEqual(len(self.children.records), 2)
        self.stray = self.spawn(["/bin/sleep", "60"])
        with patch.object(ownership.sys, "stderr", io.StringIO()):
            self.children._unrecorded(process(self.stray.pid))
        self.children._observation_failed(Refused("owned_child_identity"))
        self.ledger.uncertain(self.request["window_id"], 1, "cleanup_unknown")
        manager = Manager.__new__(Manager)
        manager.package, manager.identity, manager.ledger = package, process(os.getpid()), self.ledger
        manager.guard, manager.egress, manager.custody_fault = threading.RLock(), None, False
        manager.adopted = SimpleNamespace(records={})
        manager._capture_orphans = lambda: None  # Kernel adoption: test_codex_service_orphans.
        self.window = SimpleNamespace(window=self.request["window_id"], generation=1, egress_closed=True,
                                      children=self.children)
        manager.windows = {self.request["window_id"]: self.window}
        self.manager = manager
        self.reconcile = {**{k: self.request[k] for k in ("version", "owner_id", "conversation_id",
                                                          "window_id", "generation")},
                          "operation": "reconcile", "request_id": uid(), "outcome": "abandoned",
                          "run_id": uid(), "terminal_event_id": uid()}

    def spawn(self, command):
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
        self.processes.append(child)
        self.addCleanup(lambda: (child.poll() is None and child.kill(), child.wait(timeout=5)))
        return child

    def prove(self):
        return uncertain.prove(self.manager, self.request["window_id"], 1)

    def kill_tree(self):
        self.children.cleanup(2)
        self.broker.wait(timeout=5)  # The launcher reaps its broker.
        wait_for(lambda: not any(ownership.same(r.identity, True) for r in self.children.records.values()))

    def test_custody_is_released_only_after_the_whole_tree_is_gone(self):
        with patch.object(module.sys, "stderr", io.StringIO()):
            with self.assertRaisesRegex(Refused, "owned_cleanup_uncertain"):
                self.manager.dispatch(self.reconcile)
            with self.assertRaisesRegex(Refused, "^owned_child_not_reaped$"):
                self.prove()
            self.kill_tree()
            with self.assertRaisesRegex(Refused, "^operator_release_unrecorded_alive$"):
                self.prove()
            with self.assertRaisesRegex(Refused, "owned_cleanup_uncertain"):
                self.manager.dispatch(self.reconcile)
            self.assertFalse(self.children.operator_released)
            self.stray.kill()
            self.stray.wait(timeout=5)
            self.prove()
            self.assertTrue(self.children.operator_released and self.children.released())
            receipt = self.manager.dispatch(self.reconcile)["receipt"]
        self.assertEqual((receipt["state"], receipt["outcome"]), ("retired", "abandoned"))
        self.assertEqual(self.manager.windows, {})
        # Graceful retirement never accepts uncertain cleanup.
        with self.assertRaisesRegex(Refused, "original_cleanup_proof_missing"):
            self.children.proven_gone()

    def test_every_unproven_condition_refuses_and_changes_nothing(self):
        self.kill_tree()
        self.stray.kill()
        self.stray.wait(timeout=5)
        cases = (
            ("operator_release_unsupported", lambda: setattr(self.manager.package, "identity_split", False)),
            ("manager_custody_fault", lambda: setattr(self.manager, "custody_fault", True)),
            ("operator_release_window_unknown", lambda: setattr(self.window, "generation", 2)),
            ("window_egress_owned", lambda: setattr(self.window, "egress_closed", False)),
            ("operator_release_not_uncertain", lambda: setattr(self.children, "uncertain", False)),
            ("operator_release_unmanaged_broker", lambda: self.children.managed_brokers.clear()),
            ("operator_release_unrecorded_overflow", lambda: setattr(self.children, "unrecorded_overflow", True)),
            ("adopted_children_not_reaped", lambda: self.manager.adopted.records.update(orphan=None)),
        )
        for code, change in cases:
            with self.subTest(code=code):
                saved = (dict(vars(self.manager.package)), self.manager.custody_fault, self.window.generation,
                         self.window.egress_closed, self.children.uncertain, set(self.children.managed_brokers),
                         self.children.unrecorded_overflow, dict(self.manager.adopted.records))
                change()
                with self.assertRaisesRegex(Refused, "^%s$" % code):
                    self.prove()
                self.assertFalse(self.children.operator_released)
                (package, self.manager.custody_fault, self.window.generation, self.window.egress_closed,
                 self.children.uncertain, brokers, self.children.unrecorded_overflow, adopted) = saved
                vars(self.manager.package).update(package)
                self.children.managed_brokers.update(brokers)
                self.manager.adopted.records = adopted
        self.prove()
        self.assertTrue(self.children.operator_released)

    def test_an_operator_request_file_is_answered_once_with_a_receipt(self):
        self.kill_tree()
        self.stray.kill()
        self.stray.wait(timeout=5)
        with patch.object(uncertain, "protected", side_effect=lambda path, directory=False: path):
            requests = self.directory / uncertain.DIRECTORY
            uncertain.release_requests(self.manager, now=100.0)  # Creates the Root-only directory.
            self.assertEqual(requests.stat().st_mode & 0o777, 0o700)
            (requests / ("%s.2" % self.request["window_id"])).write_text("")
            (requests / "not-a-window").write_text("")
            with patch.object(uncertain.sys, "stderr", io.StringIO()) as output:
                uncertain.release_requests(self.manager, now=100.5)  # Checked at most once per second.
                self.assertEqual(output.getvalue(), "")
                uncertain.release_requests(self.manager, now=101.0)
                (requests / ("%s.1" % self.request["window_id"])).write_text("")
                uncertain.release_requests(self.manager, now=102.0)
        lines = output.getvalue().splitlines()
        window = self.request["window_id"]
        self.assertEqual(sorted(lines[:2]), [
            "ALERT orkestr-v2-manager operator_window_release window=- generation=0 outcome=refused reason=operator_release_request_name",
            "ALERT orkestr-v2-manager operator_window_release window=%s generation=2 outcome=refused reason=operator_release_window_unknown" % window,
        ])
        self.assertEqual(lines[2:], [
            "ALERT orkestr-v2-manager operator_window_release window=%s generation=1 outcome=released reason=-" % window,
        ])
        receipts = {path.name: json.loads(path.read_text()) for path in requests.glob("*.receipt")}
        self.assertEqual({name: (r["outcome"], r["reason"]) for name, r in receipts.items()}, {
            "invalid-request.receipt": ("refused", "operator_release_request_name"),
            "%s.2.receipt" % window: ("refused", "operator_release_window_unknown"),
            "%s.1.receipt" % window: ("released", None),
        })
        self.assertEqual(sorted(path.name for path in requests.iterdir()), sorted(receipts))
        self.assertTrue(self.children.operator_released)

    def test_reconcile_itself_releases_a_uid_refusal_once_everything_is_gone(self):
        """2026-11-14: no operator file. Each reconcile attempt runs the same proof."""
        alert = ("ALERT orkestr-v2-manager window_release_proven window=%s generation=1 "
                 "reason=owned_child_identity" % self.request["window_id"])
        with patch.object(module.sys, "stderr", io.StringIO()) as output:
            with self.assertRaisesRegex(Refused, "owned_cleanup_uncertain"):
                self.manager.dispatch(self.reconcile)  # Its tree still runs.
            self.kill_tree()
            with self.assertRaisesRegex(Refused, "owned_cleanup_uncertain"):
                self.manager.dispatch(self.reconcile)  # The refused stray still runs.
            self.assertFalse(self.children.operator_released)
            self.assertNotIn(alert, output.getvalue())
            self.stray.kill()
            self.stray.wait(timeout=5)
            receipt = self.manager.dispatch(self.reconcile)["receipt"]
        self.assertEqual((receipt["state"], receipt["outcome"]), ("retired", "abandoned"))
        self.assertEqual(self.manager.windows, {})
        self.assertEqual([line for line in output.getvalue().splitlines() if line.startswith("ALERT")], [alert])
        with self.assertRaisesRegex(Refused, "original_cleanup_proof_missing"):
            self.children.proven_gone()  # Graceful retirement still never accepts it.

    def test_any_other_uncertainty_still_waits_for_the_operator(self):
        self.kill_tree()
        self.stray.kill()
        self.stray.wait(timeout=5)
        with patch.object(module.sys, "stderr", io.StringIO()) as output:
            for reason in ("owned_child_metadata", "owned_child_family_changed", "owned_process_changed",
                           "owned_child_disappeared", "owned_child_observation"):
                with self.subTest(reason=reason):
                    self.children.uncertainty_reason = reason
                    with self.assertRaisesRegex(Refused, "owned_cleanup_uncertain"):
                        self.manager.dispatch(self.reconcile)
                    self.assertFalse(self.children.operator_released)
            self.prove()  # The operator request.
            receipt = self.manager.dispatch(self.reconcile)["receipt"]
        self.assertEqual(receipt["state"], "retired")
        self.assertNotIn("window_release_proven", output.getvalue())

    def test_a_descendant_refused_for_its_uid_is_named_once(self):
        stray = process(self.spawn(["/bin/sleep", "60"]).pid)
        with patch.object(ownership.sys, "stderr", io.StringIO()) as output:
            self.children._unrecorded(stray)
            self.children._unrecorded(stray)
        self.assertEqual(output.getvalue(), "manager descendant refused for its uid: pid=%d uid=%d comm=sleep\n"
                         % (stray["pid"], stray["uid"]))
        self.assertIn((stray["pid"], stray["start"]), self.children.unrecorded)


class RefusalNoticeTests(unittest.TestCase):
    def test_the_manager_logs_one_line_for_a_retried_refused_reconcile(self):
        request = dict(operation="reconcile", window_id=uid(), generation=1, owner_id=uid(),
                       conversation_id=uid())
        manager = Manager.__new__(Manager)
        manager.ledger = SimpleNamespace(status=lambda *_: {})
        manager.peer = SimpleNamespace(accepts=lambda _: True)
        manager.due = lambda: False
        manager.dispatch = lambda *_: (_ for _ in ()).throw(Refused("owned_cleanup_uncertain"))
        with patch.object(module.sys, "stderr", io.StringIO()) as output, \
                patch.object(module, "receive_control", lambda *_: (request, [])):
            for _ in range(50):  # 2026-11-10: 2309 such lines in 50 minutes.
                server, client = module.socket.socketpair()
                manager.control = SimpleNamespace(socket=SimpleNamespace(accept=lambda: (server, None)))
                manager.once()
                client.close()
        self.assertEqual(output.getvalue(), "manager refused reconcile: owned_cleanup_uncertain\n")

    def test_a_retried_refusal_logs_once_per_window_and_period(self):
        manager = SimpleNamespace()
        request = {"window_id": uid(), "generation": 3}
        with patch.object(uncertain.sys, "stderr", io.StringIO()) as output:
            for second in range(0, 600, 2):  # The 2026-11-10 retry rate, and more.
                uncertain.refusal_notice(manager, "reconcile", request, Refused("owned_cleanup_uncertain"), now=second)
            uncertain.refusal_notice(manager, "reconcile", {**request, "window_id": uid()},
                                     Refused("owned_cleanup_uncertain"), now=10)
            uncertain.refusal_notice(manager, "reconcile", request, Refused("owned_child_not_reaped"), now=10)
            uncertain.refusal_notice(manager, "reconcile", request, Refused("owned_cleanup_uncertain"), now=600)
        self.assertEqual(output.getvalue().splitlines(), [
            "manager refused reconcile: owned_cleanup_uncertain",
            "manager refused reconcile: owned_cleanup_uncertain",
            "manager refused reconcile: owned_child_not_reaped",
            "manager refused reconcile: owned_cleanup_uncertain repeated=299",
        ])


if __name__ == "__main__":
    unittest.main()
