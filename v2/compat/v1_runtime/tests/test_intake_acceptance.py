"""Intake may advance revision; only proven unchanged proposals can refresh."""
import copy
from unittest.mock import patch

from v2.compat.v1_runtime.intake_fast import drive
from v2.compat.v1_runtime.rust_client import ClientError
from v2.compat.v1_runtime.tests import intake_fixture as fixture


class AcceptanceRaceTests(fixture.IntakeBase):

    def conflict_once(self, change=None):
        def conflict(body):
            self.peer.before_accept = None
            self.peer.revision += 1
            if change:
                change(body)
            raise ClientError("unexpected_status", 409)
        self.peer.before_accept = conflict

    def test_definite_revision_conflict_refreshes_only_same_exact_proposal(self):
        self.enqueue()
        self.conflict_once()
        drive(self.worker)
        original = self.mutations("/accept")[0]
        refreshed = self.row("first")["fast_accept_request"]
        self.assertEqual(refreshed, dict(original, expected_revision=original["expected_revision"] + 1))
        self.assertNotIn("refused", self.row("first"))
        self.assertNotIn("fast", self.row("first").get("accepted", {}))
        self.worker = self.new_worker()
        drive(self.worker)
        self.assertIn("fast", self.row("first")["accepted"])
        self.assertEqual(self.mutations("/accept")[1], refreshed)
        self.assertEqual(len(self.fast()), 1)
        self.assertEqual(len(self.peer.runs), 2, "revision retry cannot create another provider run")

    def test_transport_unknown_retains_frozen_request_even_if_revision_changed(self):
        self.enqueue()
        def unknown(body):
            self.peer.before_accept = None
            self.peer.revision += 1
            raise ClientError("transport_outcome_unknown")
        self.peer.before_accept = unknown
        drive(self.worker)
        original = self.mutations("/accept")[0]
        self.assertEqual(self.row("first")["fast_accept_request"], original)
        self.assertNotIn("refused", self.row("first"))
        self.assertNotIn("fast", self.row("first").get("accepted", {}))
        drive(self.worker)
        self.assertEqual(self.mutations("/accept")[1], original,
                         "the frozen request is tried before any definite conflict refresh")
        self.assertEqual(self.row("first")["fast_accept_request"]["expected_revision"], self.peer.revision)

    def test_lost_acceptance_receipt_is_recovered_without_changing_frozen_request(self):
        self.enqueue()
        original_request = self.peer.request
        lost = [False]
        def request(method, route, **kwargs):
            result = original_request(method, route, **kwargs)
            if route == "/accept" and not lost[0]:
                lost[0] = True
                raise ClientError("transport_outcome_unknown")
            return result
        self.peer.request = request
        drive(self.worker)
        frozen = copy.deepcopy(self.row("first")["fast_accept_request"])
        drive(self.worker)
        self.assertEqual(self.row("first")["accepted"]["fast"]["outcome"], "succeeded")
        self.assertEqual(self.row("first")["fast_accept_request"], frozen)
        self.assertEqual(len(self.peer.receipts), 1)
        self.assertEqual(len(self.fast()), 1)

    def test_changed_completion_payload_role_or_phase_keeps_input_pending_without_refreshing(self):
        for field in ("completion", "payload", "phase", "run"):
            with self.subTest(field=field):
                self.setUp()
                self.enqueue()
                def change(body):
                    value = self.peer.runs[0, "fast"]
                    if field == "completion":
                        value["acceptance_candidate"]["completion_event_id"] = "another-completion"
                    elif field == "payload":
                        value["progress"]["payload_id"] = "another-payload"
                    elif field == "phase":
                        value["phase"] = "failed"
                    else:
                        value["run_id"] = "another-run"
                self.conflict_once(change)
                drive(self.worker)
                self.assertNotIn("refused", self.row("first"))
                self.assertNotEqual(self.row("first")["phase"], "completed")
                self.assertEqual(self.peer.receipts, {})
                self.assertEqual(self.row("first")["fast_accept_request"], self.mutations("/accept")[0])

    def test_non_revision_conflict_cannot_refresh_same_revision(self):
        self.enqueue()
        def conflict(body):
            self.peer.before_accept = None
            raise ClientError("unexpected_status", 409)
        self.peer.before_accept = conflict
        drive(self.worker)
        self.assertNotIn("refused", self.row("first"))
        self.assertNotEqual(self.row("first")["phase"], "completed")
        self.assertEqual(self.peer.receipts, {})

    def test_head_deep_refresh_after_new_intake_preserves_original_final_run(self):
        self.enqueue()
        drive(self.worker)
        self.peer.runs[0, "deep"]["phase"] = "awaiting_acceptance"
        def unknown(body):
            self.peer.before_accept = None
            raise ClientError("transport_outcome_unknown")
        self.peer.before_accept = unknown
        with self.assertRaises(ClientError):
            self.worker.step(self.ledger.next_input())
        old = copy.deepcopy(self.row("first")["deep_accept_request"])
        self.enqueue("second")
        drive(self.worker)
        self.worker.step(self.ledger.next_input())
        refreshed = self.row("first")["deep_accept_request"]
        self.assertEqual({key: value for key, value in refreshed.items() if key != "expected_revision"},
                         {key: value for key, value in old.items() if key != "expected_revision"})
        self.assertGreater(refreshed["expected_revision"], old["expected_revision"])
        with patch("time.time", return_value=10**10):
            self.worker.step(self.ledger.next_input())
        self.assertEqual(self.row("first")["phase"], "completed")
        self.assertEqual(self.row("first")["accepted"]["deep"]["run_id"], old["run_id"])
        self.assertNotEqual(self.row("second")["phase"], "completed")
