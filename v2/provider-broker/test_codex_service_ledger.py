import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid

from codex_service import contract
from codex_service.budget import WindowBudget
from codex_service.contract import Refused
from codex_service.ledger import Ledger
from isolation.bounded_budget import Refused as ProxyRefused


def uid():
    return str(uuid.uuid4())


class Clock:
    def __init__(self):
        self.boot = uid()
        self.wall = 1_800_000_000_000_000_000
        self.mono = 10_000_000_000
        self.sequence = []

    def sample(self):
        if self.sequence:
            delta = self.sequence.pop(0)
            self.wall += delta
            self.mono += delta
        return self.boot, self.wall, self.mono

    def advance(self, seconds):
        self.wall += int(seconds * 1e9)
        self.mono += int(seconds * 1e9)


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = str(Path(self.temp.name) / "ledger.sqlite3")
        self.owner, self.conversation = uid(), uid()
        self.clock = Clock()
        self.ledger = Ledger(self.path, self.owner, self.conversation, clock=self.clock)
        self.addCleanup(lambda: self.ledger.close())

    def request(self, number=1):
        return {"version": 1, "operation": "admit", "request_id": uid(),
                "owner_id": self.owner, "conversation_id": self.conversation,
                "window_id": uid(), "generation": number,
                "expected_generation": number - 1, "input_message_id": uid(),
                "input_event_id": uid(), "input_request_key": uid(),
                "predecessor_window_id": self.ledger.status()["window_id"],
                "opened_at_ms": self.clock.wall // 1_000_000,
                "work_deadline_ms": self.clock.wall // 1_000_000 + 870000,
                "expires_at_ms": self.clock.wall // 1_000_000 + 900000}

    def admit(self):
        request = self.request()
        receipt, fresh = self.ledger.admit(request)
        self.assertTrue(fresh)
        self.assertEqual(receipt["state"], "active")
        return request

    def retirement(self, request):
        return {**{key: request[key] for key in ("owner_id", "conversation_id", "window_id", "generation")},
                "outcome": "accepted", "run_id": uid(), "terminal_event_id": uid()}

    def test_active_window_extends_forward_within_the_lifetime_ceiling(self):
        request = self.admit()
        opened = request["opened_at_ms"]
        extend = lambda expires: self.ledger.extend({**{k: request[k] for k in (
            "owner_id", "conversation_id", "window_id", "generation")}, "expires_at_ms": expires})
        receipt = extend(opened + 1_800_000)
        self.assertEqual((receipt["state"], receipt["expires_at_ms"], receipt["work_deadline_ms"]),
                         ("active", opened + 1_800_000, opened + 1_770_000))
        self.assertEqual(extend(opened + 1_800_000)["expires_at_ms"], opened + 1_800_000)  # replay
        for bad in (opened + 900_000, opened + 14_400_001):
            with self.assertRaisesRegex(Refused, "window_extension"):
                extend(bad)
        # The old 15-minute deadline passes without expiry; the extended one holds.
        self.clock.advance(1000)
        self.assertEqual(self.ledger.tick(request["window_id"], 1)["state"], "active")
        # Without a cached sample the opening is derived from the extended
        # deadline minus its lifetime, so the same clocks are never "changed".
        self.ledger.last_clocks.clear()
        self.assertEqual(self.ledger.tick(request["window_id"], 1)["state"], "active")
        self.clock.advance(780)
        self.assertEqual(self.ledger.tick(request["window_id"], 1)["state"], "draining")
        with self.assertRaisesRegex(Refused, "window_not_extendable"):
            extend(opened + 3_600_000)
        self.clock.advance(30)
        self.assertEqual(self.ledger.tick(request["window_id"], 1)["state"], "expired")

    def test_exact_replay_is_read_evidence_never_another_admission(self):
        request = self.admit()
        self.assertFalse(self.ledger.admit(request)[1])
        with self.assertRaisesRegex(contract.Refused, "idempotency_conflict"):
            self.ledger.admit({**request, "input_message_id": uid()})
        self.ledger.retire(self.retirement(request))
        self.ledger.admit(self.request(2))
        replay, fresh = self.ledger.admit(request)
        self.assertFalse(fresh)
        self.assertEqual(replay["state"], "retired")
        self.assertEqual(self.ledger.status()["generation"], 2)

    def test_busy_foreign_scope_generation_and_input_refuse(self):
        request = self.admit()
        for bad in ({**self.request(2), "owner_id": uid()}, self.request(3), self.request(2)):
            with self.assertRaises(contract.Refused):
                self.ledger.admit(bad)
        self.ledger.retire(self.retirement(request))
        with self.assertRaisesRegex(contract.Refused, "input_reused"):
            self.ledger.admit({**self.request(2), "input_message_id": request["input_message_id"]})

    def test_another_input_shares_current_window_without_budget_or_clock_reset(self):
        request = self.admit()
        self.ledger.reserve(request["window_id"], 1, uid(), "attempt", 1)
        self.ledger.reserve(request["window_id"], 1, uid(), "bytes", 16384)
        before = self.ledger.status()
        self.clock.advance(120)
        followup = {**request, "request_id": uid(), "input_message_id": uid(),
                    "input_event_id": uid(), "input_request_key": uid(), "expected_generation": 1}
        receipt, fresh = self.ledger.admit(followup)
        self.assertFalse(fresh)
        self.assertEqual(receipt, before)
        self.assertFalse(self.ledger.admit(followup)[1])
        self.ledger.drain(request["window_id"], 1)
        with self.assertRaisesRegex(contract.Refused, "window_not_accepting_inputs"):
            self.ledger.admit({**followup, "request_id": uid(), "input_message_id": uid(), "input_event_id": uid()})

    def test_live_budget_follows_an_extension_past_the_original_deadline(self):
        request = self.admit()
        budget = WindowBudget(self.ledger, request["window_id"], 1)
        self.ledger.extend({**{k: request[k] for k in ("owner_id", "conversation_id", "window_id", "generation")},
                            "expires_at_ms": request["opened_at_ms"] + 1_800_000})
        self.clock.advance(1000)
        budget.check()  # Past the original deadline: still live, no clock change.
        self.assertEqual(budget._row["deadline_wall_ns"], (request["opened_at_ms"] + 1_800_000) * 1_000_000)
        self.assertEqual(budget.attempt(), 1)
        self.clock.advance(800)
        with self.assertRaises(ProxyRefused):
            budget.check()

    def test_transport_delay_cannot_extend_core_deadline(self):
        request = self.request()
        self.clock.advance(45)
        self.ledger.admit(request)
        self.clock.advance(855)
        self.assertEqual(self.ledger.tick(request["window_id"], 1)["state"], "expired")

    def test_changing_core_deadline_refused_for_active_window(self):
        request = self.admit()
        followup = {**request, "request_id": uid(), "input_message_id": uid(), "input_event_id": uid(),
                    "expected_generation": 1, "expires_at_ms": request["expires_at_ms"] + 1}
        with self.assertRaisesRegex(contract.Refused, "window_not_accepting_inputs"):
            self.ledger.admit(followup)

    def test_attempts_margin_and_duplicate_reservation(self):
        request = self.admit()
        for _ in range(28):
            self.ledger.reserve(request["window_id"], 1, uid(), "attempt", 1)
        self.assertEqual(self.ledger.tick(request["window_id"], 1)["state"], "draining")
        reservation = uid()
        self.ledger.reserve(request["window_id"], 1, reservation, "attempt", 1)
        with self.assertRaisesRegex(contract.Refused, "reservation_replay"):
            self.ledger.reserve(request["window_id"], 1, reservation, "attempt", 1)
        for _ in range(3):
            self.ledger.reserve(request["window_id"], 1, uid(), "attempt", 1)
        with self.assertRaisesRegex(contract.Refused, "attempt_limit"):
            self.ledger.reserve(request["window_id"], 1, uid(), "attempt", 1)
        self.assertEqual(self.ledger.status()["attempts"], 32)

    def test_clock_crosses_between_tick_and_reservation_lock(self):
        request = self.admit()
        self.clock.advance(899)
        self.clock.sequence = [0, 2_000_000_000]
        with self.assertRaisesRegex(contract.Refused, "window_clock"):
            self.ledger.reserve(request["window_id"], 1, uid(), "attempt", 1)
        self.assertEqual(self.ledger.status()["attempts"], 0)

    def test_expiry_is_not_retirement_or_new_window_authority(self):
        request = self.admit()
        self.clock.advance(870)
        self.assertEqual(self.ledger.tick(request["window_id"], 1)["state"], "draining")
        self.clock.advance(30)
        self.assertEqual(self.ledger.tick(request["window_id"], 1)["state"], "expired")
        with self.assertRaises(contract.Refused):
            self.ledger.reserve(request["window_id"], 1, uid(), "attempt", 1)
        with self.assertRaises(contract.Refused):
            self.ledger.admit(self.request(2))
        # Pure storage records only the manager's independently checked exact
        # retained cleanup/Core proof. Expiry itself never calls this operation.
        self.clock.advance(120)
        self.assertEqual(self.ledger.retire(self.retirement(request))["state"], "retired")

    def test_expired_reopen_loses_original_retained_proof(self):
        request = self.admit()
        self.clock.advance(900)
        self.ledger.tick(request["window_id"], 1)
        self.ledger.close()
        self.ledger = Ledger(self.path, self.owner, self.conversation, clock=self.clock)
        self.assertEqual(self.ledger.status()["state"], "reconciliation")
        with self.assertRaises(contract.Refused):
            self.ledger.retire(self.retirement(request))

    def test_cleanup_uncertainty_replaces_normal_margin_reason_and_stays_sticky(self):
        request = self.admit()
        self.clock.advance(870)
        self.ledger.tick(request["window_id"], 1)
        self.assertEqual(self.ledger.status()["reason"], "shutdown_margin")
        self.ledger.uncertain(request["window_id"], 1, "cleanup_unknown")
        self.ledger.uncertain(request["window_id"], 1, "server_lost")
        self.assertEqual(self.ledger.status()["reason"], "cleanup_unknown")

    def test_clock_rollback_and_new_boot_refuse(self):
        request = self.admit()
        self.clock.wall -= 1
        with self.assertRaises(contract.Refused):
            self.ledger.reserve(request["window_id"], 1, uid(), "bytes", 1)
        self.clock.boot = uid()
        self.assertEqual(self.ledger.tick(request["window_id"], 1)["state"], "reconciliation")

    def test_retirement_is_exact_and_unknown_cannot_recover(self):
        request = self.admit()
        terminal = self.retirement(request)
        receipt = self.ledger.retire(terminal)
        self.assertEqual(receipt, self.ledger.retire(terminal))
        with self.assertRaises(contract.Refused):
            self.ledger.retire({**terminal, "run_id": uid()})
        next_request = self.request(2)
        self.ledger.admit(next_request)
        self.ledger.uncertain(next_request["window_id"], 2, "cleanup_unknown")
        with self.assertRaises(contract.Refused):
            self.ledger.retire(self.retirement(next_request))

    def reconciliation(self, request, outcome="abandoned"):
        return {**self.retirement(request), "outcome": outcome}

    def test_stranded_window_reconciles_after_restart_without_clock_or_budget(self):
        request = self.admit()
        self.ledger.reserve(request["window_id"], 1, uid(), "bytes", 16384)
        decision = self.reconciliation(request)
        with self.assertRaisesRegex(contract.Refused, "window_not_stranded"):
            self.ledger.reconcile(decision)
        # Manager stop, host reboot: new boot id and clock. Retire stays refused.
        self.ledger.uncertain(request["window_id"], 1, "manager_stopped")
        self.ledger.close()
        self.clock.boot = uid()
        self.clock.advance(3600)
        self.ledger = Ledger(self.path, self.owner, self.conversation, clock=self.clock)
        with self.assertRaisesRegex(contract.Refused, "window_reconciliation_required"):
            self.ledger.retire(self.retirement(request))
        # The stranded conversation itself cannot open a successor until then.
        blocked = self.request(2)
        with self.assertRaisesRegex(contract.Refused, "previous_window_unretired"):
            self.ledger.admit(blocked)
        receipt = self.ledger.reconcile(decision)
        self.assertEqual((receipt["state"], receipt["reason"], receipt["outcome"]),
                         ("retired", "manager_stopped", "abandoned"))
        self.assertEqual(receipt["reserved_bytes"], 16384)
        self.assertEqual(self.ledger.reconcile(decision), receipt)
        with self.assertRaisesRegex(contract.Refused, "retirement_conflict"):
            self.ledger.reconcile({**decision, "run_id": uid()})
        with self.assertRaises(contract.Refused):
            self.ledger.reserve(request["window_id"], 1, uid(), "attempt", 1)
        self.assertTrue(self.ledger.admit(blocked)[1])
        self.assertEqual(self.ledger.status()["state"], "active")

    def test_expired_window_reconciles_and_outcomes_are_closed(self):
        request = self.admit()
        self.clock.advance(900)
        self.assertEqual(self.ledger.tick(request["window_id"], 1)["state"], "expired")
        with self.assertRaisesRegex(contract.Refused, "terminal_outcome"):
            self.ledger.reconcile(self.reconciliation(request, "succeeded"))
        self.assertEqual(self.ledger.reconcile(self.reconciliation(request, "accepted"))["outcome"],
                         "accepted")
        wire = {**self.reconciliation(request), "version": 1, "operation": "reconcile",
                "request_id": uid()}
        self.assertEqual(contract.decode(contract.canonical(wire)), wire)
        for bad in ({**wire, "outcome": "succeeded"},
                    {**wire, "operation": "retire"},
                    {**wire, "reason": "manager_stopped"}):
            with self.subTest(bad=bad["operation"]), self.assertRaises(contract.Refused):
                contract.decode(contract.canonical(bad))

    def test_failed_open_reconciles_without_a_run_and_unblocks_the_successor(self):
        request = self.admit()
        self.ledger.uncertain(request["window_id"], 1, "runtime_refused")
        failed = {**self.reconciliation(request, "failed"), "run_id": None, "terminal_event_id": None}
        for bad in ({**failed, "terminal_event_id": uid()},
                    {**self.reconciliation(request, "abandoned"), "run_id": None}):
            with self.subTest(bad=bad), self.assertRaisesRegex(contract.Refused, "terminal_run"):
                self.ledger.reconcile(bad)
        self.assertEqual(self.ledger.status()["state"], "reconciliation")
        receipt = self.ledger.reconcile(failed)
        self.assertEqual((receipt["state"], receipt["reason"], receipt["outcome"], receipt["run_id"],
                          receipt["terminal_event_id"]),
                         ("retired", "runtime_refused", "failed", None, None))
        self.assertEqual(self.ledger.reconcile(failed), receipt)
        with self.assertRaisesRegex(contract.Refused, "retirement_conflict"):
            self.ledger.reconcile({**self.reconciliation(request, "abandoned")})
        self.assertTrue(self.ledger.admit(self.request(2))[1])
        wire = {**failed, "version": 1, "operation": "reconcile", "request_id": uid()}
        self.assertEqual(contract.decode(contract.canonical(wire)), wire)
        for bad in ({**wire, "terminal_event_id": uid()},
                    {**wire, "outcome": "abandoned"},
                    {**wire, "operation": "retire"}):
            with self.subTest(wire=bad), self.assertRaises(contract.Refused):
                contract.decode(contract.canonical(bad))

    def test_window_with_a_lapsed_deep_turn_fails_naming_that_turn(self):
        request = self.admit()
        self.ledger.uncertain(request["window_id"], 1, "server_lost")
        lapsed = self.reconciliation(request, "failed")
        self.assertIsNotNone(lapsed["run_id"])
        receipt = self.ledger.reconcile(lapsed)
        self.assertEqual((receipt["state"], receipt["outcome"], receipt["run_id"]),
                         ("retired", "failed", lapsed["run_id"]))
        wire = {**lapsed, "version": 1, "operation": "reconcile", "request_id": uid()}
        self.assertEqual(contract.decode(contract.canonical(wire)), wire)

    def test_manager_reconcile_requires_released_custody(self):
        import threading
        from types import SimpleNamespace
        from codex_service.manager import Manager
        request = self.admit()
        self.ledger.uncertain(request["window_id"], 1, "server_lost")
        manager = Manager.__new__(Manager)
        manager.ledger, manager.guard = self.ledger, threading.Lock()
        closed, cleaned = [], []
        window = SimpleNamespace(window=request["window_id"], generation=1, egress_closed=False,
                                 close_egress=lambda: setattr(window, "egress_closed", True),
                                 children=SimpleNamespace(released=lambda: False,
                                                          forced=True,
                                                          uncertain=False,
                                                          cleanup=lambda seconds=2: cleaned.append(seconds) or True,
                                                          close=lambda: closed.append(1)))
        manager.windows, manager.egress = {request["window_id"]: window}, None
        decision = {**self.reconciliation(request), "operation": "reconcile"}
        # Runtime reconciles a window its task no longer owns (a failed bind):
        # the manager closes the still-open custody itself instead of refusing
        # until a restart, but every original child must still be reaped.
        with self.assertRaisesRegex(contract.Refused, "owned_child_not_reaped"):
            manager.dispatch(decision)
        self.assertTrue(window.egress_closed)
        self.assertEqual(cleaned, [2])
        with self.assertRaisesRegex(contract.Refused, "owned_child_not_reaped"):
            manager.dispatch(decision)
        self.assertEqual(self.ledger.status()["state"], "reconciliation")
        window.children.uncertain = True
        with self.assertRaisesRegex(contract.Refused, "owned_cleanup_uncertain"):
            manager.dispatch(decision)
        self.assertEqual(self.ledger.status()["state"], "reconciliation")
        window.children.uncertain = False
        window.children.released = lambda: True
        self.assertEqual(manager.dispatch(decision)["receipt"]["state"], "retired")
        self.assertEqual((manager.windows, closed), ({}, [1]))
        # A fresh manager holds no custody of a previous life's window, and an
        # exact replay is answered while other windows are live.
        manager.windows = {"other": SimpleNamespace(egress_closed=False)}
        self.assertEqual(manager.dispatch(decision)["receipt"]["outcome"], "abandoned")
        with self.assertRaisesRegex(contract.Refused, "retirement_conflict"):
            manager.dispatch({**decision, "outcome": "accepted"})

    def test_shared_credit_combines_directions_before_forwarding(self):
        request = self.admit()
        budget = WindowBudget(self.ledger, request["window_id"], 1)
        class Context:
            bytes = 0
        left, right = Context(), Context()
        budget.reserve(left, 10)
        self.assertEqual(self.ledger.status()["reserved_bytes"], contract.CREDIT_BYTES)
        budget.reserve(right, contract.CREDIT_BYTES - 10)
        self.assertEqual(self.ledger.status()["reserved_bytes"], contract.CREDIT_BYTES)
        budget.reserve(left, 1)
        self.assertEqual(self.ledger.status()["reserved_bytes"], 2 * contract.CREDIT_BYTES)
        self.assertEqual(left.bytes + right.bytes, contract.CREDIT_BYTES + 1)
        budget.stop()
        with self.assertRaises(ProxyRefused):
            budget.reserve(right, 1)
        self.assertEqual(self.ledger.status()["reserved_bytes"], 2 * contract.CREDIT_BYTES)

    def test_concurrent_reservations_never_exceed_combined_limit(self):
        request = self.admit()
        errors = []
        def reserve():
            try:
                for _ in range(520):
                    try:
                        self.ledger.reserve(request["window_id"], 1, uid(), "bytes", contract.CREDIT_BYTES)
                    except contract.Refused as error:
                        self.assertEqual(str(error), "byte_limit")
                        return
            except BaseException as error:
                errors.append(error)
        threads = [threading.Thread(target=reserve) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(10)
        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertFalse(errors)
        self.assertEqual(self.ledger.status()["reserved_bytes"], contract.MAX_BYTES)

    def test_committed_credit_survives_abrupt_writer_exit_without_reopen(self):
        self.ledger.close()
        code = """from codex_service.ledger import Ledger
import json,os,sys,uuid,time
p,owner,conversation=sys.argv[1:]
l=Ledger(p,owner,conversation)
opened=int(time.time()*1000)
r={'version':1,'operation':'admit','request_id':str(uuid.uuid4()),'owner_id':owner,'conversation_id':conversation,'window_id':str(uuid.uuid4()),'input_message_id':str(uuid.uuid4()),'input_event_id':str(uuid.uuid4()),'input_request_key':'synthetic-input','generation':1,'expected_generation':0,'predecessor_window_id':None,'opened_at_ms':opened,'work_deadline_ms':opened+870000,'expires_at_ms':opened+900000}
l.admit(r)
l.reserve(r['window_id'],1,str(uuid.uuid4()),'bytes',16384)
os._exit(0)
"""
        result = subprocess.run([sys.executable, "-B", "-c", code, self.path, self.owner, self.conversation],
            cwd=Path(__file__).resolve().parent, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
            stdin=subprocess.DEVNULL, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace"))
        self.ledger = Ledger(self.path, self.owner, self.conversation, clock=self.clock)
        self.assertEqual(self.ledger.status()["state"], "reconciliation")
        self.assertEqual(self.ledger.status()["reserved_bytes"], 16384)
        with self.assertRaises(contract.Refused):
            self.ledger.admit(self.request(2))

    def test_protocol_refuses_duplicates_extra_keys_boolean_and_arbitrary_data(self):
        good = self.request()
        self.assertEqual(contract.decode(json.dumps(good).encode()), good)
        bad = [json.dumps({**good, "generation": True}).encode(),
               json.dumps({**good, "program": "/example/untrusted"}).encode(),
               b'{"version":1,"version":1}', b'[]', b'NaN', b'x' * 8193,
               json.dumps({**good, "window_id": "untrusted"}).encode()]
        for raw in bad:
            with self.subTest(size=len(raw)), self.assertRaises(contract.Refused):
                contract.decode(raw)

    def test_strict_utf8_and_canonical_unicode_match_without_surrogates(self):
        good = {**self.request(), "input_request_key": "synthetic-büro-你好"}
        raw = contract.canonical(good)
        self.assertIn("büro-你好".encode(), raw)
        self.assertEqual(contract.decode(raw), good)
        self.assertEqual(contract.canonical(contract.decode(json.dumps(good).encode())), raw)
        for raw in (json.dumps(good).encode("utf-16"), json.dumps(good).encode("utf-32"),
                    b"\xef\xbb\xbf" + contract.canonical(good),
                    json.dumps({**good, "input_request_key": "\ud800"}).encode(),
                    json.dumps({**good, "input_request_key": "text\u0085control"}).encode()):
            with self.assertRaises(contract.Refused):
                contract.decode(raw)

    def test_published_core_js_safe_generation_and_timestamps(self):
        good = {**self.request(), "generation": 2**53 - 1, "expected_generation": 2**53 - 2}
        self.assertEqual(contract.decode(contract.canonical(good)), good)
        for bad in ({**good, "generation": 2**53}, {**good, "generation": True},
                    {**good, "opened_at_ms": 2**53}):
            with self.assertRaises(contract.Refused):
                contract.decode(contract.canonical(bad))


if __name__ == "__main__":
    unittest.main()
