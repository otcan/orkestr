"""Fast failure cannot decide Deep, and each original owner retains its final."""
import contextlib
import copy
import io
import json
from unittest.mock import patch

from v2.compat.v1_runtime.intake_fast import drive
from v2.compat.v1_runtime.rust_client import ClientError
from v2.compat.v1_runtime.tests import intake_fixture as fixture
from v2.compat.v1_runtime.worker import Refused


class IntakeCompletionTests(fixture.IntakeBase):
    def ack_fast(self, public):
        original = self.row(public)["remote_id"]
        fast = next(message for message in self.fast() if message["sourceInputId"] == original)
        pseudo = next(message for message in self.ledger.messages(500) if message["id"] == fast["parentMessageId"])
        self.ledger.acknowledge(fast["id"], dict(outcome="delivered", outboxJobId="synthetic-fast-job",
            parentPublicMessageId=pseudo["publicMessageId"], connectorMessageIds=["synthetic-fast-receipt"],
            deliveredAt="2026-01-01T00:00:00Z"))

    def finals(self):
        with self.ledger.connect() as db:
            rows = db.execute("SELECT message FROM exports ORDER BY rowid").fetchall()
        return [message for (raw,) in rows if (message := json.loads(raw)).get("source") == "rust-v2-pilot"
                and message.get("phase") == "final_answer" and not message.get("firstResponse")]

    def test_independent_observation_failures_only_log_and_deep_can_later_finish(self):
        for error in (Refused("fast_progress_payload_mismatch"), ClientError("unexpected_status", 404),
                      ClientError("transport_outcome_unknown"), RuntimeError("synthetic-private-diagnostic")):
            with self.subTest(error=type(error).__name__):
                self.setUp()
                original = self.enqueue()
                output = io.StringIO()
                with patch("v2.compat.v1_runtime.intake_fast.observe", side_effect=error), \
                        contextlib.redirect_stderr(output):
                    drive(self.worker)
                self.assertIn("fast_observation_deferred", output.getvalue())
                self.assertNotIn(str(error), output.getvalue(), "logs contain no arbitrary diagnostic body")
                pending = self.row("first")
                self.assertNotIn("refused", pending)
                self.assertEqual(pending["phase"], "running")
                self.assertEqual(self.peer.runs[0, "deep"]["phase"], "running")
                self.assertEqual(self.finals(), [])
                self.assertEqual(self.mutations("/accept"), [])
                self.worker = self.new_worker()
                drive(self.worker)
                self.ack_fast("first")
                self.peer.runs[0, "deep"]["phase"] = "awaiting_acceptance"
                self.worker.run_once(fixture.Stop())
                self.assertEqual(self.row("first")["phase"], "completed")
                self.assertNotIn("refused", self.row("first"))
                self.assertEqual([message["parentMessageId"] for message in self.finals()],
                                 [original["remote_id"]])

    def test_real_fast_payload_mismatch_leaves_deep_pending_then_recovers_without_replay(self):
        self.enqueue()
        request = self.peer.request
        def wrong_fast_payload(method, route, **kwargs):
            status, value = request(method, route, **kwargs)
            fast = self.peer.runs.get((0, "fast")) or {}
            if route == "/payloads/" + (fast.get("progress") or {}).get("payload_id", ""):
                value = dict(value, run_id=fixture.identity(9999))
            return status, value
        self.peer.request = wrong_fast_payload
        with contextlib.redirect_stderr(io.StringIO()):
            drive(self.worker)
        self.assertEqual(self.row("first")["phase"], "running")
        self.assertNotIn("refused", self.row("first"))
        self.assertNotIn("first_response", self.row("first"))
        self.assertEqual(self.mutations("/accept"), [])
        self.assertEqual(self.peer.runs[0, "deep"]["phase"], "running")
        self.peer.request = request
        drive(self.worker)
        self.ack_fast("first")
        self.peer.runs[0, "deep"]["phase"] = "awaiting_acceptance"
        self.worker.run_once(fixture.Stop())
        self.assertEqual(len(self.finals()), 1)
        self.assertEqual(len(self.mutations("/messages")), 1)

    def test_two_original_owners_get_two_exact_deep_finals_in_order_across_restarts(self):
        originals = [self.enqueue(public) for public in ("first", "second")]
        with patch("time.time", return_value=100):
            drive(self.worker)
            self.peer.runs[0, "deep"]["phase"] = "awaiting_acceptance"
            self.worker.run_once(fixture.Stop())
        self.assertEqual(len(self.peer.inputs), 2)
        self.assertTrue(all(self.row(public)["burst"] == [] for public in ("first", "second")))
        self.assertEqual(self.finals(), [], "the head still awaits its Fast transport decision")
        self.peer.runs[1, "deep"]["phase"] = "awaiting_acceptance"
        self.worker = self.new_worker()
        with patch("time.time", return_value=101):
            self.worker.run_once(fixture.Stop())
        self.assertEqual(self.finals(), [], "a later ready Deep cannot overtake the head")
        self.assertNotIn("deep", self.row("second").get("accepted", {}))
        self.ack_fast("first")
        self.ack_fast("second")
        with patch("time.time", return_value=102):
            self.worker.run_once(fixture.Stop())
        self.assertEqual([message["parentMessageId"] for message in self.finals()], [originals[0]["remote_id"]])
        self.worker = self.new_worker()
        with patch("time.time", return_value=103):
            self.worker.run_once(fixture.Stop())
        finals = self.finals()
        self.assertEqual([message["parentMessageId"] for message in finals], [data["remote_id"] for data in originals])
        self.assertEqual([message["sourceInputId"] for message in finals], [data["remote_id"] for data in originals])
        self.assertEqual([message["runId"] for message in finals],
                         [self.peer.runs[index, "deep"]["run_id"] for index in (0, 1)])
        before = copy.deepcopy(self.peer.mutations)
        for _ in range(3):
            self.worker = self.new_worker()
            self.worker.run_once(fixture.Stop())
        self.assertEqual(self.peer.mutations, before)
        self.assertEqual(self.finals(), finals, "neither final is duplicated after restart")
