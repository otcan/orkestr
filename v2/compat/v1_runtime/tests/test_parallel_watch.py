"""Read-only parallel Deep finals settle out of order, quoted; a defer waits."""
import contextlib
import io
import json
import time

from v2.compat.v1_runtime import parallel_watch
from v2.compat.v1_runtime.tests import intake_fixture as fixture


class ParallelWatchTests(fixture.IntakeBase):
    def setUp(self):
        super().setUp()
        self.worker._parallel_deep = (time.monotonic(), True)

    def passes(self, passes=1):
        """Run worker passes; the adapter's stderr log of them."""
        log = io.StringIO()
        with contextlib.redirect_stderr(log):
            for _ in range(passes):
                self.worker.run_once(fixture.Stop())
        return log.getvalue()

    def assertHandback(self, log, event, run):
        lines = [line for line in log.splitlines() if " parallel_deep_" in line]
        self.assertEqual(len(lines), 1, log)
        self.assertIn("orkestr-v2-wa-adapter %s " % event, lines[0])
        self.assertIn("run=%s" % run, lines[0])

    def finals(self):
        with self.ledger.connect() as db:
            rows = db.execute("SELECT message FROM exports ORDER BY rowid").fetchall()
        return [message for (raw,) in rows if (message := json.loads(raw)).get("source") == "rust-v2-pilot"
                and message.get("phase") == "final_answer" and not message.get("firstResponse")]

    def ack_fast(self, public):
        original = self.row(public)["remote_id"]
        fast = next(message for message in self.fast() if message["sourceInputId"] == original)
        pseudo = next(message for message in self.ledger.messages(500) if message["id"] == fast["parentMessageId"])
        self.ledger.acknowledge(fast["id"], dict(outcome="delivered", outboxJobId="synthetic-fast-job",
            parentPublicMessageId=pseudo["publicMessageId"], connectorMessageIds=["synthetic-fast-receipt"],
            deliveredAt="2026-01-01T00:00:00Z"))

    def slot(self, index):
        """Core answers input `index` with a read-only parallel Deep slot run."""
        intake = self.peer.inputs[index]
        run = fixture.identity(5000 + index)
        self.peer.runs[index, "deep"] = dict(run_id=run, role="deep", phase="running",
            parallel_deep=True, concurrent_deep=True, progress=dict(payload_id=run + "-payload"),
            acceptance_candidate=dict(run_id=run, completion_event_id=run + "-completion"))
        self.peer.event(intake, run)
        return self.peer.runs[index, "deep"]

    def burst(self):
        self.enqueue("head")
        self.passes()
        b = self.enqueue("b")
        self.passes(2)
        self.assertEqual(len(self.peer.inputs), 2)
        return b

    def test_a_parallel_answer_settles_before_the_head_and_quotes_its_source(self):
        b = self.burst()
        slot = self.slot(1)
        self.passes()
        self.assertEqual(self.row("b")["parallel_run"], slot["run_id"])
        self.ack_fast("b")
        slot["phase"] = "awaiting_acceptance"
        self.passes(2)
        finals = self.finals()
        self.assertEqual(len(finals), 1, finals)
        self.assertEqual(finals[0]["parentMessageId"], b["remote_id"])
        self.assertIs(finals[0]["quoteSource"], True)
        self.assertEqual(finals[0]["sourceInputId"], b["remote_id"])
        self.assertEqual(self.row("b")["phase"], "completed")
        self.assertEqual(self.row("head")["phase"], "running", "the writer's turn is still running")
        # The writer's final follows, as before, and stays unquoted.
        self.ack_fast("head")
        self.peer.runs[0, "deep"]["phase"] = "awaiting_acceptance"
        self.passes(2)
        finals = self.finals()
        self.assertEqual(len(finals), 2)
        self.assertNotIn("quoteSource", finals[1])
        self.passes(2)
        self.assertEqual(len(self.finals()), 2, "nothing is exported twice")

    def test_a_deferred_answer_is_never_exported_and_waits_for_the_writer(self):
        self.burst()
        slot = self.slot(1)
        self.peer.texts[slot["run_id"]] = "  PARALLEL_DEFER\n"
        self.ack_fast("b")
        slot["phase"] = "awaiting_acceptance"
        log = self.passes(3)
        self.assertHandback(log, "parallel_deep_deferred", slot["run_id"])
        self.assertEqual(self.finals(), [], "the defer marker is never sent")
        row = self.row("b")
        self.assertEqual(row["parallel_deferred"], [slot["run_id"]])
        self.assertNotIn("parallel_run", row)
        self.assertNotEqual(row["phase"], "completed")
        # The writer answers the head, then takes the deferred input itself.
        self.ack_fast("head")
        self.peer.runs[0, "deep"]["phase"] = "awaiting_acceptance"
        self.passes(2)
        writer = fixture.identity(7001)
        self.peer.runs[2, "deep"] = dict(run_id=writer, role="deep", phase="awaiting_acceptance",
            progress=dict(payload_id=writer + "-payload"),
            acceptance_candidate=dict(run_id=writer, completion_event_id=writer + "-completion"))
        self.peer.event(self.peer.inputs[1], writer)
        self.passes(3)
        finals = self.finals()
        self.assertEqual(len(finals), 2, finals)
        self.assertEqual(finals[1]["parentMessageId"], row["remote_id"])
        self.assertNotIn("PARALLEL_DEFER", finals[1]["text"])

    def test_switch_off_reads_and_writes_nothing(self):
        self.worker._parallel_deep = (time.monotonic(), False)
        self.burst()
        self.slot(1)
        before = len(self.peer.mutations)
        self.passes(2)
        self.assertNotIn("parallel_run", self.row("b"))
        self.assertNotIn("parallel_cursor", self.row("b"))
        self.assertEqual(self.finals(), [])
        self.assertEqual(len(self.peer.mutations), before)

    def test_quote_only_for_a_burst_final(self):
        reply = {}
        parallel_watch.quote(dict(remote_id="r"), dict(concurrent_deep=True), reply)
        self.assertEqual(reply, dict(quoteSource=True, sourceInputId="r"))
        reply = {}
        parallel_watch.quote(dict(remote_id="r"), dict(), reply)
        self.assertEqual(reply, {})
        grouped = dict(quoteSource=True, sourceInputId="last")
        parallel_watch.quote(dict(remote_id="r"), dict(concurrent_deep=True), grouped)
        self.assertEqual(grouped["sourceInputId"], "last", "a grouped quote is kept")

    def test_a_failed_slot_never_sends_a_notice_and_waits_for_the_writer(self):
        self.burst()
        slot = self.slot(1)
        self.passes()
        slot["phase"] = "failed"
        log = self.passes(2)
        self.assertHandback(log, "parallel_deep_failed", slot["run_id"])
        row = self.row("b")
        self.assertEqual(row["parallel_deferred"], [slot["run_id"]])
        self.assertNotIn("refused", row)
        self.assertNotEqual(row["phase"], "completed")
        self.assertEqual(self.finals(), [])

    def head_slot(self):
        """Input b's slot run is first seen at the ledger head: the watch never
        recorded it (switch read off), and the writer's head final went first."""
        self.worker._parallel_deep = (time.monotonic(), False)
        self.burst()
        slot = self.slot(1)
        self.ack_fast("head")
        self.peer.runs[0, "deep"]["phase"] = "awaiting_acceptance"
        self.passes(2)
        self.assertEqual(len(self.finals()), 1)
        self.assertNotIn("parallel_run", self.row("b"))
        return slot

    def test_a_deferred_answer_at_the_head_is_never_exported(self):
        slot = self.head_slot()
        self.peer.texts[slot["run_id"]] = "PARALLEL_DEFER"
        self.ack_fast("b")
        slot["phase"] = "awaiting_acceptance"
        self.passes(3)
        self.assertEqual(len(self.finals()), 1, "the defer marker is never sent")
        row = self.row("b")
        self.assertEqual(row["parallel_deferred"], [slot["run_id"]])
        self.assertNotEqual(row["phase"], "completed")

    def test_a_failed_slot_at_the_head_sends_no_notice(self):
        slot = self.head_slot()
        slot["phase"] = "failed"
        log = self.passes(2)
        self.assertHandback(log, "parallel_deep_failed", slot["run_id"])
        row = self.row("b")
        self.assertEqual(row["parallel_deferred"], [slot["run_id"]])
        self.assertNotIn("refused", row)
        self.assertNotEqual(row["phase"], "completed")
        self.assertEqual(len(self.finals()), 1)

    def test_a_slot_handed_back_after_a_crash_sends_no_notice(self):
        self.burst()
        slot = self.slot(1)
        self.passes()
        # Recovery abandoned the slot proposal and handed its input back.
        slot.update(phase="cancelled", parallel_deferred=True)
        log = self.passes(2)
        self.assertHandback(log, "parallel_deep_withdrawn", slot["run_id"])
        row = self.row("b")
        self.assertEqual(row["parallel_deferred"], [slot["run_id"]])
        self.assertNotIn("refused", row)
        self.assertEqual(self.finals(), [])

    def test_a_completed_defer_handed_back_by_core_logs_a_defer_not_a_failure(self):
        """Production: Core already returned the input (deferral row) when the
        watch reads the slot's exact-run status: completed + parallel_deferred."""
        self.burst()
        slot = self.slot(1)
        self.passes()
        slot.update(phase="completed", parallel_deferred=True)
        log = self.passes(2)
        self.assertHandback(log, "parallel_deep_deferred", slot["run_id"])
        self.assertNotIn("parallel_deep_failed", log)
        row = self.row("b")
        self.assertEqual(row["parallel_deferred"], [slot["run_id"]])
        self.assertNotEqual(row["phase"], "completed")
        self.assertEqual(self.finals(), [])

    def test_a_completed_defer_at_the_head_logs_a_defer_not_a_failure(self):
        slot = self.head_slot()
        slot.update(phase="completed", parallel_deferred=True)
        log = self.passes(2)
        self.assertHandback(log, "parallel_deep_deferred", slot["run_id"])
        self.assertNotIn("parallel_deep_failed", log)
        self.assertEqual(self.row("b")["parallel_deferred"], [slot["run_id"]])
        self.assertEqual(len(self.finals()), 1)

    def test_handback_event_names_only_a_failed_turn_a_failure(self):
        event = parallel_watch.handback_event
        self.assertEqual(event(dict(phase="failed", parallel_deferred=True)), "parallel_deep_failed")
        self.assertEqual(event(dict(phase="blocked")), "parallel_deep_failed")
        self.assertEqual(event(dict(phase="completed", parallel_deferred=True)), "parallel_deep_deferred")
        self.assertEqual(event(dict(phase="cancelled", parallel_deferred=True)), "parallel_deep_withdrawn")
