"""An unfinished Deep input cannot hold later original owner Fast replies."""
import copy
import unittest
from unittest.mock import patch

from v2.compat.v1_runtime.intake_fast import drive, eligible
from v2.compat.v1_runtime.ledger import Conflict
from v2.compat.v1_runtime.rust_client import ClientError
from v2.compat.v1_runtime.tests import intake_fixture as fixture
from v2.compat.v1_runtime.tests.intake_fixture import identity


class IntakeFastTests(fixture.IntakeBase):
    def test_later_fast_admits_exports_and_accepts_while_head_deep_is_running(self):
        first = self.enqueue()
        self.worker.run_once(fixture.Stop())
        first_run = self.row("first")["first_response"]["run_id"]
        second = self.enqueue("second")
        self.worker.run_once(fixture.Stop())
        self.assertEqual([body["text"] for body in self.mutations("/messages")],
                         ["Request first", "Request second"])
        self.assertEqual([message["sourceInputId"] for message in self.fast()],
                         [first["remote_id"], second["remote_id"]])
        self.assertEqual(len(self.mutations("/accept")), 2)
        self.assertTrue(all(row["run_id"] != self.peer.runs[0, "deep"]["run_id"]
                            for row in self.mutations("/accept")))
        self.assertEqual(self.row("first")["phase"], "running")
        self.assertEqual(self.row("second")["phase"], "running")
        self.assertNotEqual(first_run, self.row("second")["first_response"]["run_id"])
        self.assertEqual(self.peer.runs[0, "deep"]["phase"], "running")
        self.assertNotIn((1, "deep"), self.peer.runs, "Core's Deep remains serialized")

    def test_multiple_original_events_are_not_absorbed_and_restart_exports_each_once(self):
        originals = [self.enqueue(str(index)) for index in range(3)]
        drive(self.worker)
        self.assertEqual(len(self.fast()), 3)
        self.assertEqual([message["sourceInputId"] for message in self.fast()],
                         [data["remote_id"] for data in originals])
        self.assertTrue(all(self.row(str(index))["burst"] == [] for index in range(3)))
        before = copy.deepcopy(self.peer.mutations)
        self.worker = self.new_worker()
        drive(self.worker)
        self.assertEqual(self.peer.mutations, before)
        self.assertEqual(len(self.fast()), 3)

    def test_fifo_intake_admits_a_whole_burst_in_one_pass(self):
        # No per-pass admission throttle: a burst is admitted at once, in order.
        for index in range(12):
            self.enqueue(str(index))
        drive(self.worker)
        self.assertEqual([body["text"] for body in self.mutations("/messages")],
                         ["Request " + str(index) for index in range(12)])
        drive(self.worker)
        self.assertEqual(len(self.fast()), 12)

    def test_no_owner_or_consent_is_inferred_and_unadmitted_local_agent_keeps_fifo(self):
        self.enqueue("first")
        self.enqueue("agent", role="v1_agent")
        self.enqueue("later")
        drive(self.worker)
        self.assertEqual([body["text"] for body in self.mutations("/messages")], ["Request first"])
        for role in (None, "v1_owner", "v1_agent", "v1_external"):
            data = dict(phase="queued", author=dict(role=role))
            self.assertFalse(eligible(self.worker, data))
        self.assertTrue(eligible(self.worker, dict(phase="queued", author=dict(role="member"))))
        self.assertFalse(eligible(self.worker, dict(phase="queued", origin="timer", author=dict(role="member"))))

    def test_member_message_does_not_hold_a_later_owner_fast_behind_running_deep(self):
        # Biofuture 2026-10-27: a member message sent during a running Deep turn
        # waited for that turn on the serial path, and the owner's next message
        # (and its Fast reply) waited behind it for ~60 s.
        head = self.enqueue("head")
        self.worker.run_once(fixture.Stop())
        self.assertEqual(self.peer.runs[0, "deep"]["phase"], "running")
        member = self.enqueue("member", role="member")
        owner = self.enqueue("owner")
        self.worker.run_once(fixture.Stop())
        self.assertEqual([body["text"] for body in self.mutations("/messages")],
                         ["Request head", "Request member", "Request owner"], "arrival order is kept")
        self.assertEqual([message["sourceInputId"] for message in self.fast()],
                         [head["remote_id"], member["remote_id"], owner["remote_id"]])
        self.assertEqual(self.row("member")["burst"], [])
        self.assertEqual(self.peer.runs[0, "deep"]["phase"], "running")
        self.assertNotIn((1, "deep"), self.peer.runs, "Core's Deep remains serialized")
        for policy in ("disabled", "legacy"):
            self.worker.fast_reply_policy = policy
            before = copy.deepcopy(self.peer.mutations)
            drive(self.worker)
            self.assertEqual(self.peer.mutations, before)

    def test_member_owner_member_burst_is_admitted_once_each_in_order_across_restart(self):
        head = self.enqueue("head")
        self.worker.run_once(fixture.Stop())
        burst = [self.enqueue("m1", role="member"), self.enqueue("o1"),
                 self.enqueue("m2", role="member"), self.enqueue("o2")]
        for _ in range(3):
            self.worker.run_once(fixture.Stop())
        texts = ["Request " + name for name in ("head", "m1", "o1", "m2", "o2")]
        self.assertEqual([body["text"] for body in self.mutations("/messages")], texts)
        self.assertEqual([message["sourceInputId"] for message in self.fast()],
                         [data["remote_id"] for data in [head] + burst], "one Fast each, none skipped")
        self.assertTrue(all(self.row(name)["burst"] == [] for name in ("m1", "o1", "m2", "o2")))
        self.assertEqual([key for key in self.peer.runs if key[1] == "deep"], [(0, "deep")],
                         "Core's Deep remains serialized")
        before = copy.deepcopy(self.peer.mutations)
        self.worker = self.new_worker()  # Stop and restart: nothing is admitted or exported twice.
        for _ in range(2):
            self.worker.run_once(fixture.Stop())
        self.assertEqual(self.mutations("/messages"), [body for path, body in before if path == "/messages"])
        self.assertEqual(len(self.fast()), 5)

    def test_member_is_not_admitted_ahead_of_an_unadmitted_local_agent_input(self):
        self.enqueue("first")
        self.enqueue("agent", role="v1_agent")
        self.enqueue("member", role="member")
        drive(self.worker)
        self.assertEqual([body["text"] for body in self.mutations("/messages")], ["Request first"])
        self.assertNotIn("intake", self.row("member"))

    def test_member_message_during_a_timer_turn_is_admitted_after_the_timer(self):
        timer, _ = self.ledger.enqueue_timer(dict(message_id=identity(7), event_id=identity(8), sequence=1,
                                                  request_key="timer-key", namespace="ns", claim_id="claim"))
        self.enqueue("member", role="member")
        self.enqueue("owner")
        drive(self.worker)
        self.assertEqual([body["text"] for body in self.mutations("/messages")],
                         ["Request member", "Request owner"], "the adopted timer is never re-posted")
        self.assertNotIn("burst", self.row(timer["public_id"]))

    def test_ledger_and_server_capacity_are_preserved_without_bypassing_a_queued_window(self):
        self.ledger.max_outstanding = 2
        self.enqueue("first")
        self.enqueue("second")
        # Above the soft limit the message is queued, not refused.
        self.assertIn("capacity_queued", self.enqueue("third"))
        self.peer.capacity = True
        drive(self.worker)
        self.assertEqual(len(self.peer.inputs), 3, "immutable messages are admitted in FIFO order")
        self.assertEqual(self.row("first")["phase"], "waiting_for_window_dispatch")
        self.assertNotIn("window", self.row("second"))
        self.assertEqual(self.fast(), [])
        self.assertEqual(self.mutations("/accept"), [])
        frozen = self.row("first")["window_request"]
        drive(self.worker)
        self.assertEqual(self.row("first")["window_request"], frozen)
        self.assertEqual(len(self.mutations("/messages")), 3)

    def test_busy_window_does_not_delay_admission_of_later_original_inputs(self):
        self.peer.busy = True
        self.enqueue("first")
        self.enqueue("second")
        drive(self.worker)
        self.assertEqual(len(self.peer.inputs), 2)
        self.assertEqual(self.row("first")["phase"], "waiting_for_window")
        self.assertEqual(self.fast(), [])
        frozen = self.row("first")["window_request"]
        self.peer.busy = False
        drive(self.worker)
        self.assertEqual(self.row("first")["window_request"], frozen)
        self.assertEqual(len(self.fast()), 2)

    def test_unknown_intake_keeps_fifo_and_retries_only_its_frozen_source(self):
        self.enqueue("first")
        self.enqueue("second")
        request = self.peer.request
        lost = [False]
        def lose_after_commit(method, route, **kwargs):
            result = request(method, route, **kwargs)
            if route == "/messages" and not lost[0]:
                lost[0] = True
                raise ClientError("transport_outcome_unknown")
            return result
        self.peer.request = lose_after_commit
        drive(self.worker)
        self.assertEqual(len(self.peer.inputs), 1)
        self.assertNotIn("intake", self.row("first"))
        self.assertNotIn("intake", self.row("second"))
        self.assertEqual(self.fast(), [])
        drive(self.worker)
        self.assertEqual(self.mutations("/messages")[0], self.mutations("/messages")[1])
        self.assertEqual(len(self.peer.inputs), 2)
        self.assertEqual(len(self.fast()), 2)

    def test_definite_intake_refusal_is_terminal_only_for_that_input(self):
        self.enqueue("first")
        self.enqueue("second")
        request = self.peer.request
        def refuse(method, route, **kwargs):
            if route == "/messages":
                self.peer.request = request
                raise ClientError("unexpected_status", 403)
            return request(method, route, **kwargs)
        self.peer.request = refuse
        drive(self.worker)
        self.assertEqual(self.row("first")["refused"]["reason"], "upstream_refused:403")
        self.assertNotIn("intake", self.row("second"))
        drive(self.worker)
        self.assertEqual([body["text"] for body in self.mutations("/messages")], ["Request second"])
        self.assertEqual(len(self.fast()), 1)

    def test_foreign_message_event_and_role_cannot_be_used_for_early_fast(self):
        self.enqueue()
        event = self.peer.event
        def foreign(intake, run, **kwargs):
            fast = self.peer.runs.get((0, "fast")) or {}
            if run == fast.get("run_id"):
                event(dict(intake, message_id=identity(9999)), run, **kwargs)
                event(dict(intake, event_id=identity(9998)), run, **kwargs)
                return
            event(intake, run, **kwargs)
        self.peer.event = foreign
        drive(self.worker)
        with self.ledger.connect() as db:
            import json
            watch = json.loads(db.execute("SELECT data FROM fast_watch").fetchone()[0])
        self.assertNotIn(self.peer.runs[0, "fast"]["run_id"], watch["matched_runs"])
        self.assertNotIn("first_response", self.row("first"))
        self.assertEqual(self.mutations("/accept"), [])

    def test_fast_cursor_cannot_consume_deep_events_before_the_serial_observer(self):
        self.enqueue()
        drive(self.worker)
        data = self.row("first")
        initial_cursor = data["cursor"]
        with self.ledger.connect() as db:
            import json
            watch = json.loads(db.execute("SELECT data FROM fast_watch").fetchone()[0])
        self.assertGreater(watch["fast_cursor"], initial_cursor)
        self.assertEqual(data["cursor"], initial_cursor)
        deep = self.peer.runs[0, "deep"]["run_id"]
        self.assertIn(deep, watch["matched_runs"])
        with patch.object(self.worker, "capture_questions", wraps=self.worker.capture_questions) as capture:
            self.worker.observe(data)
        self.assertTrue(any((event.get("payload_ref_or_safe_payload") or {}).get("run_id") == deep
                            for event in capture.call_args.args[1]))

    def test_independent_fast_keeps_unknown_send_and_fifteen_second_final_fence(self):
        self.enqueue()
        with patch("time.time", return_value=100):
            drive(self.worker)
        fast = self.fast()[0]
        pseudo = next(message for message in self.ledger.messages() if message["id"] == fast["parentMessageId"])
        self.ledger.acknowledge(fast["id"], dict(outcome="uncertain", outboxJobId="unknown-job",
            parentPublicMessageId=pseudo["publicMessageId"], connectorMessageIds=[]))
        self.peer.runs[0, "deep"]["phase"] = "awaiting_acceptance"
        with patch("time.time", return_value=102):
            self.worker.step(self.ledger.next_input())
        self.assertEqual(self.row("first")["phase"], "running")
        self.assertEqual(self.row("first")["first_response"]["delivery_blocker"], "unverified_uncertain")
        self.worker = self.new_worker()
        with patch("time.time", return_value=117):
            self.worker.step(self.ledger.next_input())
        self.assertEqual(self.row("first")["phase"], "completed")
        with self.ledger.connect() as db:
            outcome = db.execute("SELECT outcome FROM exports WHERE export_id=?", (fast["id"],)).fetchone()[0]
        self.assertEqual(outcome, "superseded")
        self.assertEqual(len(self.mutations("/messages")), 1)


if __name__ == "__main__":
    unittest.main()
