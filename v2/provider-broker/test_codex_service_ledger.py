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
r={'version':1,'operation':'admit','request_id':str(uuid.uuid4()),'owner_id':owner,'conversation_id':conversation,'window_id':str(uuid.uuid4()),'input_message_id':str(uuid.uuid4()),'input_event_id':str(uuid.uuid4()),'input_request_key':'synthetic-input','generation':1,'expected_generation':0,'predecessor_window_id':None,'opened_at_ms':int(time.time()*1000),'work_deadline_ms':int(time.time()*1000)+870000,'expires_at_ms':int(time.time()*1000)+900000}
l.admit(r)
l.reserve(r['window_id'],1,str(uuid.uuid4()),'bytes',16384)
os._exit(0)
"""
        result = subprocess.run([sys.executable, "-B", "-c", code, self.path, self.owner, self.conversation],
            cwd=Path(__file__).resolve().parent, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
            stdin=subprocess.DEVNULL, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0)
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
