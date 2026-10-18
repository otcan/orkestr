"""Adversarial acceptance-oracle checks; no server, provider or credentials."""
import copy
from pathlib import Path
import unittest
from unittest.mock import patch

from codex_recovery import replay_without_mutation
from recovery_state import exact_run, held_input, normal_retirement, public_hold
from verify_package import Refused


class RecoveryOracleTests(unittest.TestCase):
    def setUp(self):
        self.intake = {"message_id": "held-message", "event_id": "held-event", "sequence": 7}
        self.state = {"held": [{"message_id": "held-message", "event_id": "held-event",
            "reason": "stop_boundary", "boundary_run_id": "stopped-run", "boundary_event_id": "stop-event",
            "scope_sequence": 7, "through_scope_sequence": 8, "state": "queued", "admitted_run_id": None,
            "boundary_request_key": "original-stop"}],
            "pending": [{"message_id": "held-message", "event_id": "held-event"}], "runs": []}

    def test_exact_hold_provenance_is_required(self):
        self.assertEqual(held_input(self.state, self.intake, "stopped-run", "original-stop"), self.state["held"][0])
        for key, value in (("event_id", "another-event"), ("boundary_run_id", "successor"),
                           ("through_scope_sequence", 6), ("state", "consumed"),
                           ("admitted_run_id", "hidden-dispatch"), ("boundary_request_key", "later-stop"),
                           ("scope_sequence", 6)):
            changed = copy.deepcopy(self.state)
            changed["held"][0][key] = value
            with self.subTest(key=key), self.assertRaises(Refused):
                held_input(changed, self.intake, "stopped-run", "original-stop")

    def test_preserved_hold_row_cannot_hide_a_dispatch(self):
        self.state["runs"] = [{"message_id": "held-message"}]
        with self.assertRaisesRegex(Refused, "held_input_was_dispatched"):
            held_input(self.state, self.intake, "stopped-run", "original-stop")

    def test_authenticated_hold_projection_must_match_durable_boundary(self):
        held = self.state["held"][0]
        expected = {key: held[key] for key in ("message_id", "scope_sequence", "reason", "boundary_run_id",
                                              "boundary_event_id", "through_scope_sequence")}
        expected["source_event_id"] = held["event_id"]
        page = {"schema_version": 1, "conversation_id": "conversation", "held": [expected],
                "eligible_input_available": False, "next_after_sequence": None}
        class Candidate:
            def browser(self, path):
                return 200, page, {"Cache-Control": "no-store"}
        public_hold(Candidate(), "/conversation", held)
        expected["boundary_event_id"] = "another-cancellation"
        with self.assertRaisesRegex(Refused, "held_input_public_provenance_mismatch"):
            public_hold(Candidate(), "/conversation", held)

    def test_fresh_run_must_match_both_source_identifiers_and_one_attempt(self):
        good = {"id": "fresh-run", "message_id": "fresh-message", "event_id": "fresh-event",
                "attempt": 1, "role": "deep"}
        intake = {"message_id": "fresh-message", "event_id": "fresh-event"}
        self.assertEqual(exact_run({"runs": [good]}, "fresh-run", intake), good)
        for key, value in (("event_id", "held-event"), ("message_id", "held-message"),
                           ("attempt", 2), ("role", "worker")):
            with self.subTest(key=key), self.assertRaises(Refused):
                exact_run({"runs": [{**good, key: value}]}, "fresh-run", intake)

    def test_lease_expiry_or_unrelated_retirement_cannot_prove_clean_restart(self):
        run = {"id": "accepted-run", "context_id": "context", "incarnation_id": "old-incarnation",
               "session_id": "native-session", "binding_generation": 2}
        row = {"prior_run_id": "accepted-run", "context_id": "context", "incarnation_id": "old-incarnation",
               "session_id": "native-session", "binding_generation": 2, "supervisor_generation": 1,
               "acceptance_event_id": "owner-acceptance", "retired_at_ms": 123}
        state = {"retirements": [row], "supervisors": [{"context_id": "context",
                 "incarnation_id": "old-incarnation", "generation": 1}]}
        receipt = {"acceptance_event_id": "owner-acceptance"}
        normal_retirement(state, run, receipt, 1)
        with self.assertRaisesRegex(Refused, "graceful_retirement_missing"):
            normal_retirement({**state, "retirements": []}, run, receipt, 1)
        for key, value in (("acceptance_event_id", "other-acceptance"), ("binding_generation", 3),
                           ("incarnation_id", "successor"), ("retired_at_ms", 0)):
            with self.subTest(key=key), self.assertRaisesRegex(Refused, "graceful_retirement_provenance_mismatch"):
                normal_retirement({**state, "retirements": [{**row, key: value}]}, run, receipt, 1)

    def replay(self, after, status_after=None):
        status = {"phase": "awaiting_acceptance", "run_id": "successor", "revision": 9,
                  "acceptance_candidate": {"run_id": "successor", "completion_event_id": "done"}}
        receipt = {"outcome": "requested_unknown", "run_id": "historical-run"}
        calls = []
        class Candidate:
            def browser(self, path, **kwargs):
                calls.append((path, kwargs))
                return (200, receipt if kwargs.get("method") == "POST" else (status_after or status), {})
        with patch("codex_recovery.snapshot", side_effect=[{"immutable": 1}, after]):
            replay_without_mutation(Candidate(), "/conversation", "/stop", {"request_key": "original"},
                                    receipt, status, Path("/unused"))
        return calls

    def test_identical_historical_receipt_and_successor_pass_without_new_intent(self):
        calls = self.replay({"immutable": 1})
        self.assertEqual(calls, [("/conversation/stop", {"method": "POST", "body": {"request_key": "original"}}),
                                 ("/conversation/execution", {})])

    def test_identical_receipt_cannot_hide_durable_successor_mutation(self):
        with self.assertRaisesRegex(Refused, "recovery_historical_receipt_mutated_successor"):
            self.replay({"immutable": 2})

    def test_identical_receipt_cannot_hide_changed_visible_successor(self):
        with self.assertRaisesRegex(Refused, "recovery_historical_receipt_mutated_successor"):
            self.replay({"immutable": 1}, {"phase": "cancelled", "run_id": "successor", "revision": 10})


if __name__ == "__main__":
    unittest.main()
