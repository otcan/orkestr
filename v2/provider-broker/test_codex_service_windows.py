"""Manager custody for concurrent windows; synthetic ledgers and fakes only.

No server, broker, socket or provider runs. Fakes record which window's custody
each manager transition touched, proving one window never closes, spends or
retires another window's children, relay or budget.
"""
import threading
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from pathlib import Path
import tempfile

import codex_service.manager as module
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
        manager.package = SimpleNamespace(endpoint="/synthetic/egress.sock", gid=1)
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

if __name__ == "__main__":
    unittest.main()
