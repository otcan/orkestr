"""P0: immediate per-message Fast, queue-not-refuse, one safe retry, localized notices.

All IDs, texts and peers are synthetic; nothing here reaches a provider or
WhatsApp.
"""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from v2.compat.v1_runtime import ledger as ledger_module
from v2.compat.v1_runtime import notices, recovery
from v2.compat.v1_runtime import worker as worker_module
from v2.compat.v1_runtime.first_response import repeats_fast
from v2.compat.v1_runtime.ledger import Conflict, Ledger
from v2.compat.v1_runtime.worker import Refused, Worker
from v2.compat.v1_runtime.tests import intake_fixture as fixture
from v2.compat.v1_runtime.tests.intake_fixture import identity
from v2.compat.v1_runtime.tests.test_window_continuation import QueuePeer


def quiet():
    return contextlib.redirect_stderr(io.StringIO())


class ParallelFastPeer(fixture.IntakePeer):
    """Core variant that starts every admitted message's Fast at once (the
    adapter must never be the serializing gate); Deep stays serial."""

    def start(self, role):
        if role != "fast":
            return super().start(role)
        for index, intake in enumerate(self.inputs):
            if intake.get("window") and (index, "fast") not in self.runs:
                run = identity(1000 + index * 10)
                self.runs[index, "fast"] = dict(run_id=run, role="fast", phase="awaiting_acceptance",
                    progress=dict(payload_id=run + "-payload"),
                    acceptance_candidate=dict(run_id=run, completion_event_id=run + "-completion"))
                self.event(intake, run)

    def request(self, method, route, body=None, allowed=(200,)):
        if route == "/window" and method == "POST" and not self.capacity and not self.busy:
            status, value = super().request(method, route, body, allowed)
            self.start("fast")
            return status, value
        return super().request(method, route, body, allowed)


class MoteksBurstTests(fixture.IntakeBase):
    def setUp(self):
        super().setUp()
        self.peer = ParallelFastPeer()
        self.worker = self.new_worker()
        self.ledger.max_outstanding = 8  # The live default that refused the burst.

    def ack_fast(self):
        rows = {m["id"]: m for m in self.ledger.messages(500)}
        for message in self.fast():
            parent = rows.get(message["parentMessageId"])
            if parent:
                self.ledger.acknowledge(message["id"], dict(outcome="delivered", outboxJobId="job-" + message["id"][:8],
                    parentPublicMessageId=parent["publicMessageId"], connectorMessageIds=["synthetic"],
                    deliveredAt="2026-01-01T00:00:00Z"))

    def test_nine_owner_messages_get_nine_immediate_fast_replies_and_ordered_deep_finals(self):
        burst = [self.enqueue("m%d" % index) for index in range(9)]
        self.assertTrue(all("capacity_queued" not in row for row in burst[:4]))
        self.assertIn("capacity_queued", burst[-1], "above the soft limit: queued, not refused")
        with quiet():
            started = time.monotonic()
            self.worker.run_once(fixture.Stop())
            elapsed = time.monotonic() - started
        # Every message got its own Fast reply in the very first pass.
        self.assertEqual(sorted(m["sourceInputId"] for m in self.fast()), sorted(r["remote_id"] for r in burst))
        self.assertLess(elapsed, 20, "Fast SLO")
        self.assertEqual(len(self.mutations("/messages")), 9)
        self.assertTrue(all(self.row("m%d" % i)["burst"] == [] for i in range(9)), "no grouping")
        self.assertEqual(len([b for b in self.mutations("/accept") if b["run_id"].startswith(identity(1000)[:8])]), 9)
        self.ack_fast()
        finals = []
        for index in range(9):
            self.peer.runs[index, "deep"]["phase"] = "awaiting_acceptance"
            with quiet():
                for _ in range(3):
                    self.worker.run_once(fixture.Stop())
            finals = [m for m in self.ledger.messages(500)
                      if m.get("role") == "assistant" and m.get("phase") == "final_answer" and not m.get("firstResponse")
                      and m.get("parentMessageId") in {r["remote_id"] for r in burst}]
            self.assertEqual(len(finals), index + 1)
        self.assertEqual([m["parentMessageId"] for m in finals], [r["remote_id"] for r in burst])
        self.assertFalse(any(m.get("kind") == "notice" for m in self.ledger.messages(500)))
        self.assertEqual(self.ledger.health()["refusedInputs"], 0)

    def test_fast_export_timing_does_not_depend_on_journal_position(self):
        """A busy journal (other runs' events between the burst's messages)
        must not delay any Fast export: one shared scan serves every watch."""
        request = self.peer.request
        def noisy(method, route, body=None, allowed=(200,)):
            result = request(method, route, body, allowed)
            if method == "POST" and route == "/messages":
                for _ in range(60):  # Unrelated progress of earlier runs.
                    sequence = max(event["sequence"] for event in self.peer.events) + 1
                    self.peer.events.append(dict(sequence=sequence, owner_id=self.peer.owner,
                                                 aggregate_id=self.peer.conversation))
            return result
        self.peer.request = noisy
        burst = [self.enqueue("n%d" % index) for index in range(9)]
        with quiet():
            self.worker.run_once(fixture.Stop())
        self.assertGreater(len(self.peer.events), 500)
        # Exported in the same pass that saw Core's proposal, for all nine.
        self.assertEqual(sorted(m["sourceInputId"] for m in self.fast()), sorted(r["remote_id"] for r in burst))
        accepted_at = {r["remote_id"]: self.row(r["public_id"])["first_response"]["at"] for r in burst}
        self.assertLess(max(accepted_at.values()) - min(accepted_at.values()), 5)

    def test_hard_bound_still_refuses_real_abuse(self):
        self.ledger.max_outstanding = 2
        with patch.object(ledger_module, "HARD_MAX_OUTSTANDING", 4):
            for index in range(4):
                self.enqueue("a%d" % index)
            with self.assertRaisesRegex(Conflict, "binding_capacity_reached"):
                self.enqueue("a4")
        self.assertEqual(self.ledger.health()["hardMaxOutstandingInputs"], 64)


class GulsahPeer(QueuePeer):
    """Fast and Deep of the input both cancelled; the window closed (failed)."""

    def __init__(self, fast_phase="cancelled"):
        super().__init__()
        self.fast_phase = fast_phase
        self.deep_phase = "cancelled"
        self.current = dict(window_id="window", state="closed", conversation_id="conversation",
                            work_deadline_ms=int(time.time() * 1000) + 600_000)

    def request(self, method, route, body=None, allowed=(200,)):
        if route.split("?", 1)[0] == "/fast/execution" and self.fast_phase:
            return 200, dict(run_id="fast-run", revision=10, phase=self.fast_phase)
        return super().request(method, route, body=body, allowed=allowed)


class Base(unittest.TestCase):
    peer_class = GulsahPeer
    ended_confirm_s = 0  # The two-observation rule has its own tests below.

    def setUp(self):
        self.enterContext(patch.object(recovery, "ENDED_CONFIRM_S", self.ended_confirm_s))
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.ledger = Ledger(Path(temporary.name) / "ledger.sqlite3", {"test_scope": "stranded"})
        self.data, _ = self.ledger.enqueue(dict(publicMessageId="member-msg", publicThreadId="thread", chatId="chat",
            accountId="account", text="Merhaba, bu profili bugün güncelleyebilir misin? Teşekkürler"),
            author=dict(role="member", id="synthetic-member", label="Member"))
        self.peer = self.peer_class()
        self.worker = Worker(self.peer, self.ledger)

    def notices(self):
        return [m for m in self.ledger.messages() if m.get("kind") == "notice"]

    def passes(self, count=2):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            for _ in range(count):
                self.worker.run_once(fixture.Stop())
        return err.getvalue()

    def messages_sent(self):
        return len([r for r, _ in self.peer.mutations if r == "/messages"])

    def retires(self):
        return [r for r, _ in self.peer.mutations if r.endswith("/retire")]


class AnsweredPeer(GulsahPeer):
    """The cancelled Deep's latest payload is the answer already sent as progress."""

    def request(self, method, route, body=None, allowed=(200,)):
        status, value = super().request(method, route, body=body, allowed=allowed)
        if route.split("?", 1)[0] == "/execution" and isinstance(value, dict):
            value = dict(value, progress=dict(payload_id="answer-payload", observed_at_ms=1))
        return status, value


class AnsweredByProgressTests(Base):
    """otcanClaw-PA 2026-10-29: the answer reached the chat as progress, then a
    reconciliation cancelled the run; a softened notice, never a cancel notice."""
    peer_class = AnsweredPeer

    def progress(self, payload_id="answer-payload", outcome="delivered"):
        message = self.ledger.add_progress(self.data, payload_id, "Two DocuSign mails arrived today.")
        if outcome:
            self.ledger.acknowledge(message["id"], dict(outcome=outcome, outboxJobId="job-1",
                parentPublicMessageId=self.data["public_id"], connectorMessageIds=["synthetic"],
                deliveredAt="2026-01-01T00:00:00Z"))
        return message

    def test_delivered_answer_progress_gets_a_softened_notice_not_a_cancel_notice(self):
        self.progress()
        log = self.passes(2)
        data = self.ledger.input(self.data["remote_id"])
        self.assertEqual(data["phase"], "completed")
        self.assertEqual(data["refused"]["reason"], "answered_by_progress")
        self.assertNotIn("stalled", data, "an expected close: no stall alert")
        (notice,) = self.notices()
        self.assertEqual(notice["phase"], "final_answer")
        self.assertEqual(notice["text"], notices.TEMPLATES["stopped_after_answer"]["tr"])
        self.assertIn("INFO orkestr-v2-wa-adapter input_refused", log)
        self.assertIn("reason=answered_by_progress", log)
        self.assertNotIn("ALERT orkestr-v2-wa-adapter input_refused", log)
        self.assertIn("input_answered_by_progress", log)
        self.assertIn("reason=deep_run_cancelled", log)
        self.assertEqual(self.retires(), [])

    def test_softened_notice_follows_the_chat_language(self):
        for lang in notices.LANGUAGES:
            text = notices.render(lang, "stopped_after_answer")
            self.assertTrue(text.startswith("\u2139\ufe0f "))
        self.assertEqual(len({notices.render(lang, "stopped_after_answer") for lang in notices.LANGUAGES}), 3)

    def test_answer_progress_still_being_sent_waits_for_its_report(self):
        message = self.progress(outcome=None)
        self.passes(2)
        self.assertNotEqual(self.ledger.input(self.data["remote_id"])["phase"], "completed")
        self.assertEqual(self.notices(), [])
        self.ledger.acknowledge(message["id"], dict(outcome="delivered", outboxJobId="job-1",
            parentPublicMessageId=self.data["public_id"], connectorMessageIds=["synthetic"],
            deliveredAt="2026-01-01T00:00:00Z"))
        self.passes(1)
        self.assertEqual(self.ledger.input(self.data["remote_id"])["refused"]["reason"], "answered_by_progress")
        (notice,) = self.notices()
        self.assertEqual(notice["text"], notices.TEMPLATES["stopped_after_answer"]["tr"])

    def test_unreported_progress_waits_only_a_bounded_time_then_the_notice_goes_out(self):
        # otcanClaw-LinkedIn 2026-10-30: V1 never reported the progress, the
        # input waited forever, the chat got no notice and later inputs queued.
        self.progress(outcome=None)
        with patch.object(worker_module, "PROGRESS_REPORT_WAIT_S", 0):
            log = self.passes(2)
        data = self.ledger.input(self.data["remote_id"])
        self.assertEqual(data["phase"], "completed")
        self.assertEqual(data["refused"]["reason"], "deep_run_cancelled")
        (notice,) = self.notices()
        self.assertEqual(notice["text"], notices.TEMPLATES["failure"]["tr"])
        self.assertIn("ALERT orkestr-v2-wa-adapter input_refused", log)

    def test_timer_input_never_waits_for_progress_v1_does_not_send(self):
        # V1 does not transport a timer input's progress; its export stays
        # unreported until a final supersedes it.
        self.progress(outcome=None)
        timer = dict(self.ledger.input(self.data["remote_id"]), origin="timer")
        deep = dict(run_id="deep-run", phase="failed", progress=dict(payload_id="answer-payload"))
        self.assertFalse(self.worker.answered_by_progress(timer, deep, "deep_run_failed:provider"))
        self.assertNotIn("progress_report_wait_since", timer)
        member = self.ledger.input(self.data["remote_id"])
        self.assertTrue(self.worker.answered_by_progress(member, deep, "deep_run_failed:provider"))

    def test_older_progress_or_uncertain_delivery_keeps_the_notice(self):
        for payload_id, outcome in (("older-payload", "delivered"), ("answer-payload", "uncertain")):
            with self.subTest(payload_id=payload_id, outcome=outcome):
                self.setUp()
                self.progress(payload_id, outcome)
                log = self.passes(2)
                data = self.ledger.input(self.data["remote_id"])
                self.assertEqual(data["refused"]["reason"], "deep_run_cancelled")
                (notice,) = self.notices()
                self.assertEqual(notice["text"], notices.TEMPLATES["failure"]["tr"])
                self.assertIn("ALERT orkestr-v2-wa-adapter input_refused", log)


class StrandedInputTests(Base):
    def test_cancelled_fast_and_deep_in_a_closed_window_settle_with_one_localized_notice(self):
        log = self.passes(2)
        data = self.ledger.input(self.data["remote_id"])
        self.assertEqual(data["phase"], "completed", "never stranded in running")
        self.assertEqual(data["refused"]["reason"], "deep_run_cancelled")
        self.assertNotIn("readmitted", data, "a Deep run existed: never retried")
        (notice,) = self.notices()
        self.assertEqual(data["notice_language"], "tr")
        self.assertEqual(notice["text"], notices.TEMPLATES["failure"]["tr"])
        self.assertIn("ALERT orkestr-v2-wa-adapter input_refused", log)
        self.assertEqual(self.messages_sent(), 1)
        self.assertEqual(self.retires(), [])

    def test_owner_stop_is_never_retried(self):
        # An owner stop cancels the Deep and Core holds the input: no retry.
        self.peer.retire_state = "retired"  # Even if Core would allow it.
        self.passes(2)
        data = self.ledger.input(self.data["remote_id"])
        self.assertEqual(data["phase"], "completed")
        self.assertNotIn("readmitted", data)
        self.assertEqual(self.messages_sent(), 1)

    def test_requires_review_is_never_retried_and_says_so_to_the_owner(self):
        owner, _ = self.ledger.enqueue(dict(publicMessageId="owner-msg", publicThreadId="thread", chatId="chat",
            accountId="account", text="Send the four drafts now, please"), author=dict(role="owner", id="o", label="O"))
        self.ledger.finish_silently(self.ledger.input(self.data["remote_id"]), "suppressed")
        with quiet():
            message = self.ledger.refuse(self.ledger.input(owner["remote_id"]), "execution_requires_review")
        self.assertEqual(message["text"], notices.render("en", "interrupted_owner", reason="execution_requires_review"))
        self.assertIn("nothing is retried", message["text"])


class NoRunPeer(QueuePeer):
    """An admitted input with no run of its own; its window has closed."""

    def __init__(self):
        super().__init__()
        self.foreign = True
        self.current = dict(window_id="window", state="closed", conversation_id="conversation")


class UnstartedInputTests(Base):
    peer_class = NoRunPeer

    def stranded(self):
        self.passes(1)
        data = self.ledger.next_input()
        data["unstarted_since"] -= 61
        self.ledger.save(data)
        return data

    def test_successor_window_handoff_never_duplicates_the_run(self):
        """Core moved the joined-but-unrun input to a successor window: its
        retirement is refused, so the adapter keeps matching the original."""
        self.stranded()
        self.passes(2)
        data = self.ledger.next_input()
        self.assertEqual(data["phase"], "running")
        self.assertNotIn("readmitted", data)
        self.assertEqual(len(self.retires()), 2, "asked Core each pass, refused each time")
        self.peer.foreign, self.peer.current = False, None  # The successor runs it.
        self.passes(2)
        self.assertEqual(self.messages_sent(), 1, "exactly one Core message, one run")
        self.assertEqual(self.ledger.messages()[-1]["text"], "deep result")
        self.assertEqual(self.notices(), [])

    def test_held_or_owned_input_closes_after_the_bound_without_a_retry(self):
        self.stranded()
        self.passes(1)
        data = self.ledger.next_input()
        data["retry_wait_since"] -= recovery.RETIRE_WAIT_S + 1
        self.ledger.save(data)
        log = self.passes(1)
        data = self.ledger.input(self.data["remote_id"])
        self.assertEqual(data["refused"]["reason"], "window_setup_failed")
        self.assertNotIn("readmitted", data)
        self.assertEqual(len(self.notices()), 1)
        self.assertIn("ALERT orkestr-v2-wa-adapter input_refused", log)
        self.assertEqual(self.messages_sent(), 1)

    def test_retired_original_is_readmitted_once_silently_and_its_retry_answers(self):
        self.stranded()
        self.peer.retire_state = "retired"
        log = self.passes(1)
        data = self.ledger.next_input()
        self.assertEqual(data["readmitted"]["trigger"], "automatic")
        self.assertEqual(data["retired_original"]["message_id"], "message")
        self.assertIn("input_readmitted", log)
        self.assertNotIn("ALERT", log)
        self.assertEqual(self.notices(), [])
        self.peer.foreign, self.peer.current = False, None
        self.passes(2)
        self.assertEqual(self.ledger.messages()[-1]["text"], "deep result")
        self.assertEqual(self.notices(), [])
        self.assertEqual(self.messages_sent(), 2)

    def test_a_timed_out_stream_read_is_not_proof_of_the_journal_head(self):
        self.stranded()
        self.peer.retire_state = "retired"
        self.peer.head = 99  # Core's snapshot is ahead of everything read.
        self.passes(2)
        self.assertNotIn("readmitted", self.ledger.next_input())
        self.assertEqual(self.retires(), [], "never asks Core to retire before catching up")

    def test_pre_upgrade_row_without_arrival_is_never_retried(self):
        data = self.stranded()
        data.pop("arrived_at")
        self.ledger.save(data)
        self.peer.retire_state = "retired"
        self.passes(1)
        data = self.ledger.input(self.data["remote_id"])
        self.assertEqual(data["phase"], "completed")
        self.assertEqual(data["retry_withheld"], "pre_upgrade_row")
        self.assertEqual(self.retires(), [])
        self.assertEqual(len(self.notices()), 1)

    def test_older_than_a_day_is_never_retried_or_announced(self):
        data = self.stranded()
        data["arrived_at"] = time.time() - recovery.MAX_AGE_S - 1
        self.ledger.save(data)
        self.peer.retire_state = "retired"
        log = self.passes(1)
        data = self.ledger.input(self.data["remote_id"])
        self.assertEqual(data["settled"]["outcome"], "suppressed")
        self.assertNotIn("readmitted", data)
        self.assertEqual(self.notices(), [])
        self.assertIn("ALERT orkestr-v2-wa-adapter input_failed_too_old", log)


class FastOnlyPeer(QueuePeer):
    """The input's Fast ran; its Deep never started; its window closed."""

    def __init__(self):
        super().__init__()
        self.current = dict(window_id="window", state="closed", conversation_id="conversation")
        self.no_deep = True

    def request(self, method, route, body=None, allowed=(200,)):
        if route.split("?", 1)[0] == "/execution" and self.no_deep:
            return 404, {"code": "not_found"}
        return super().request(method, route, body=body, allowed=allowed)


class StuckQueueTests(Base):
    peer_class = FastOnlyPeer

    def test_input_with_a_fast_run_closes_in_one_pass_and_later_finals_are_not_held(self):
        self.passes(1)
        data = self.ledger.next_input()
        data["deep_missing_since"] -= 61
        self.ledger.save(data)
        later, _ = self.ledger.enqueue(dict(publicMessageId="later", publicThreadId="thread", chatId="chat",
                                            accountId="account", text="Next question"),
                                       author=dict(role="member", id="synthetic-member", label="Member"))
        self.peer.retire_state = "retired"  # Never even asked: a run references it.
        log = self.passes(1)
        first = self.ledger.input(self.data["remote_id"])
        self.assertEqual(first["phase"], "completed", "closed within one pass")
        self.assertEqual(first["refused"]["reason"], "window_ended_without_deep")
        self.assertEqual(first["retry_withheld"], "run_exists")
        self.assertEqual(self.retires(), [])
        self.assertIn("ALERT orkestr-v2-wa-adapter input_refused", log)
        self.assertNotIn("input_waiting_for_core", log)
        (notice,) = self.notices()
        self.ledger.acknowledge(notice["id"], dict(outcome="delivered", outboxJobId="job",
                                                   parentPublicMessageId="member-msg"))
        self.peer.no_deep, self.peer.current = False, None
        self.peer.accepted.clear()
        self.passes(2)
        self.assertEqual(self.ledger.messages()[-1]["text"], "deep result")
        self.assertEqual(self.ledger.messages()[-1]["parentMessageId"], later["remote_id"])


class OwnerStopTests(Base):
    peer_class = NoRunPeer

    def stranded(self):
        self.passes(1)
        data = self.ledger.next_input()
        data["unstarted_since"] -= 61
        self.ledger.save(data)

    def test_held_input_is_closed_silently_and_never_retired_even_if_core_would(self):
        self.stranded()
        self.peer.held = ["message"]       # The owner pressed Stop.
        self.peer.retire_state = "retired"  # Real Core would still retire it.
        log = self.passes(1)
        data = self.ledger.input(self.data["remote_id"])
        self.assertEqual(data["phase"], "completed")
        self.assertEqual(data["settled"]["outcome"], "held")
        self.assertNotIn("readmitted", data)
        self.assertEqual(self.retires(), [])
        self.assertEqual(self.notices(), [])
        self.assertIn("input_closed_owner_stop", log)
        self.assertEqual(self.messages_sent(), 1)

    def test_successor_window_wait_is_bounded_and_alerted_once(self):
        self.stranded()
        self.peer.current = dict(window_id="successor", state="active", conversation_id="conversation")
        self.peer.retire_state = "retired"
        log = self.passes(2)
        data = self.ledger.next_input()
        self.assertEqual(data["phase"], "running")
        self.assertEqual(self.retires(), [], "Core may still run it there")
        self.assertEqual(log.count("input_waiting_for_core"), 1)
        data["retry_wait_since"] -= recovery.RETIRE_WAIT_S + 1
        self.ledger.save(data)
        self.passes(1)
        self.assertEqual(self.ledger.input(self.data["remote_id"])["phase"], "completed")
        self.assertNotIn("readmitted", self.ledger.input(self.data["remote_id"]))


class RequeueGapTests(Base):
    """Core requeued the joined-but-unrun input for a successor window, but
    the dispatcher (1 s poll) has not opened it: /window reads the old window
    closed. The input (with its Fast run) must not be refused."""
    peer_class = FastOnlyPeer
    ended_confirm_s = recovery.ENDED_CONFIRM_S

    def stuck(self):
        self.passes(1)
        data = self.ledger.next_input()
        data["deep_missing_since"] -= 61
        self.ledger.save(data)

    def test_a_queued_successor_request_keeps_the_input_waiting(self):
        self.stuck()
        self.peer.window_queue = [dict(input_event_id="event", input_message_id="message", state="queued")]
        log = self.passes(2)
        self.assertEqual(self.ledger.next_input()["phase"], "running")
        self.assertEqual(self.notices(), [])
        self.assertIn("wait=successor_queued", log)
        # The dispatcher opens the successor and Core runs the same input there.
        self.peer.window_queue, self.peer.no_deep, self.peer.current = [], False, None
        self.peer.accepted.clear()
        self.passes(2)
        self.assertEqual(self.ledger.messages()[-1]["text"], "deep result")
        self.assertEqual(self.notices(), [])
        self.assertEqual(self.messages_sent(), 1)

    def test_ended_must_be_seen_twice_thirty_seconds_apart(self):
        self.stuck()
        self.passes(2)
        data = self.ledger.next_input()
        self.assertEqual(data["phase"], "running", "first 'ended' observation only starts the clock")
        self.assertEqual(self.notices(), [])
        data["ended_seen_at"] -= recovery.ENDED_CONFIRM_S + 1
        self.ledger.save(data)
        self.passes(1)
        self.assertEqual(self.ledger.input(self.data["remote_id"])["refused"]["reason"], "window_ended_without_deep")
        self.assertEqual(len(self.notices()), 1)


class TimerFailureTests(unittest.TestCase):
    """Nobody resends a timer and Core owns its retry: one timer notice."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.ledger = Ledger(Path(temporary.name) / "ledger.sqlite3", {"test_scope": "timer"})
        self.data, _ = self.ledger.enqueue_timer(dict(message_id=identity(7), event_id=identity(8), sequence=5,
            request_key="timer:synthetic", namespace="ns", claim_id="claim", label="Morning pass"))
        self.worker = object()  # recover() must not touch Core for a timer.

    def test_unstarted_timer_is_not_resent_by_the_adapter(self):
        with self.assertRaises(Refused):
            recovery.recover(self.worker, self.data, "timer_window_ended_without_run")
        with quiet():
            message = self.ledger.refuse(self.data, "timer_window_ended_without_run", alert=True)
        self.assertTrue(message["text"].startswith("\u23f0 Morning pass failed"))
        self.assertNotIn("send it again", message["text"])
        self.assertNotIn("readmitted", self.ledger.input(self.data["remote_id"]))

    def test_started_timer_says_it_is_not_retried(self):
        with self.assertRaises(Refused):
            recovery.recover(self.worker, self.data, "deep_run_cancelled", started=True)
        with quiet():
            message = self.ledger.refuse(self.data, "deep_run_cancelled", alert=True)
        self.assertIn("not retried automatically", message["text"])
        self.assertNotIn("readmitted", self.ledger.input(self.data["remote_id"]))


class OperatorReadmitTests(fixture.IntakeBase):
    def stranded(self, age_s=60):
        data = self.enqueue("stranded")
        data.update(phase="running", intake=dict(message_id=identity(50), event_id=identity(51), sequence=9),
                    window=dict(status=dict(window_id="w1")), matched_runs=[identity(52)],
                    arrived_at=time.time() - age_s)
        self.ledger.save(data)
        self.peer.runs["x", "deep"] = dict(run_id=identity(52), role="deep", phase="cancelled")
        return data

    def test_readmits_once_refuses_older_and_is_idempotent(self):
        data = self.stranded()
        self.peer.retire_state = "retired"  # Core proves nothing of it ran.
        first = recovery.request(self.ledger.path, "stranded", "op-1", "operator")
        self.assertEqual(first["state"], "requested")
        self.assertTrue(recovery.request(self.ledger.path, "stranded", "op-1", "operator")["duplicate"])
        with self.assertRaisesRegex(ValueError, "recovery_already_requested"):
            recovery.request(self.ledger.path, "stranded", "op-2", "operator")
        with quiet():
            recovery.drive(self.worker)
        row = self.row("stranded")
        self.assertEqual(row["readmitted"]["trigger"], "operator")
        self.assertEqual(row["readmitted"]["request_key"], "op-1")
        self.assertEqual(row["readmitted"]["previous"]["message_id"], identity(50))
        self.assertEqual((row["public_id"], row["remote_id"]), ("stranded", data["remote_id"]))
        self.assertEqual(row["phase"], "queued")
        with quiet():
            recovery.drive(self.worker)  # Decided requests are never repeated.
        self.assertEqual(self.row("stranded")["keys"], row["keys"])
        repeated = recovery.request(self.ledger.path, "stranded", "op-1", "operator")
        self.assertEqual((repeated["state"], repeated["duplicate"]), ("readmitted", True))

    def test_older_than_a_day_is_refused_at_request_time(self):
        self.stranded(age_s=recovery.MAX_AGE_S + 5)
        with self.assertRaisesRegex(ValueError, "older_than_24h"):
            recovery.request(self.ledger.path, "stranded", "op-old", "operator")
        self.assertNotIn("readmitted", self.row("stranded"))

    def test_core_refusing_retirement_refuses_the_operator_request(self):
        self.stranded()  # A cancelled run references it: Core keeps it.
        recovery.request(self.ledger.path, "stranded", "op-run", "operator")
        with quiet():
            recovery.drive(self.worker)
        self.assertNotIn("readmitted", self.row("stranded"))
        with self.ledger.connect() as db:
            state = json.loads(db.execute("SELECT data FROM readmit_requests").fetchone()[0])
        self.assertEqual((state["state"], state["reason"]), ("refused", "core_still_owns_input"))

    def test_owner_stop_hold_refuses_the_operator_request(self):
        self.stranded()
        self.peer.retire_state = "retired"
        self.peer.held = [identity(50)]
        recovery.request(self.ledger.path, "stranded", "op-held", "operator")
        with quiet():
            recovery.drive(self.worker)
        self.assertNotIn("readmitted", self.row("stranded"))
        with self.ledger.connect() as db:
            state = json.loads(db.execute("SELECT data FROM readmit_requests").fetchone()[0])
        self.assertEqual((state["state"], state["reason"]), ("refused", "input_held"))
        self.assertFalse(any(r.endswith("/retire") for r, _ in self.peer.mutations))

    def test_live_window_or_final_refuses_in_the_worker(self):
        self.stranded()
        recovery.request(self.ledger.path, "stranded", "op-live", "operator")
        get = self.peer.request
        self.peer.request = lambda method, route, body=None, allowed=(200,): (
            (200, dict(window_id="w1", state="active")) if route == "/window" and method == "GET"
            else get(method, route, body, allowed))
        with quiet():
            recovery.drive(self.worker)
        self.assertNotIn("readmitted", self.row("stranded"))
        with self.ledger.connect() as db:
            state = json.loads(db.execute("SELECT data FROM readmit_requests").fetchone()[0])
        self.assertEqual((state["state"], state["reason"]), ("refused", "window_live"))


class LanguageTests(unittest.TestCase):
    def test_detection(self):
        self.assertEqual(notices.detect("model rengini de revize edemiyorum, bakar mısın?"), "tr")
        self.assertEqual(notices.detect("Kannst du das bitte noch einmal prüfen? Danke"), "de")
        self.assertEqual(notices.detect("Can you check this again please?"), "en")
        self.assertIsNone(notices.detect("ok"))
        self.assertIsNone(notices.detect("RDB~RDB 12345"))

    def test_chat_language_follows_recent_messages_and_falls_back_to_english(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = Ledger(Path(directory) / "l.sqlite3", {"test_scope": "lang"})
            with ledger.connect() as db:
                self.assertEqual(notices.chat_language(db), "en")
            for index, text in enumerate(["Merhaba, bunu yapar mısın?", "Teşekkürler, çok iyi", "ok"]):
                ledger.enqueue(dict(publicMessageId="p%d" % index, publicThreadId="t", chatId="c", accountId="a",
                                    text=text), author=dict(role="owner", id="o", label="O"))
            with ledger.connect() as db:
                self.assertEqual(notices.chat_language(db), "tr")
            data = ledger.next_input()
            with quiet():
                message = ledger.refuse(dict(data, text="ok"), "window_refused")
            # The owner gets the technical notice on every binding policy.
            self.assertEqual(message["text"], notices.render("tr", "failure_owner", reason="window_refused"))
            ledger.owner_only = True
            second = ledger.input(ledger.enqueue(dict(publicMessageId="de", publicThreadId="t", chatId="c",
                accountId="a", text="Bitte prüfe das noch einmal, danke"), author=dict(role="owner", id="o",
                label="O"))[0]["remote_id"])
            with quiet():
                message = ledger.refuse(second, "window_refused")
            self.assertEqual(message["text"], notices.render("de", "failure_owner", reason="window_refused"))

    def test_a_continuation_core_did_not_accept_is_reported_as_interrupted(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = Ledger(Path(directory) / "l.sqlite3", {"test_scope": "cont"})
            data, _ = ledger.enqueue(dict(publicMessageId="p", publicThreadId="t", chatId="c", accountId="a",
                                          text="Please finish the report"), author=dict(role="owner", id="o", label="O"))
            data["continued"] = {"previous_message_id": "m", "at": 1}
            with quiet():
                message = ledger.refuse(data, "continuation_admission_requires_review")
            self.assertIn("nothing is retried", message["text"])

    def test_every_template_has_all_languages(self):
        for key, table in notices.TEMPLATES.items():
            self.assertEqual(set(table), set(notices.LANGUAGES), key)
            for lang in notices.LANGUAGES:
                self.assertNotIn("send it again", table[lang], key)


class DuplicateAndStatusTests(unittest.TestCase):
    def test_only_an_exact_digit_free_repeat_of_fast_is_suppressed(self):
        def fast(text):
            from v2.compat.v1_runtime.first_response import echo_key
            return {"first_response": {"echo": echo_key(text)}}
        self.assertTrue(repeats_fast(fast("You're welcome, happy to help!"), "You're welcome, happy to help."))
        for before, after in (("See you at 10:00.", "See you at 11:00."), ("Total 1,250 EUR", "Total 1,520 EUR"),
                              ("Meet on Monday at gate B12", "Meet on Monday at gate B14"),
                              ("We meet on Monday", "We meet on Tuesday")):
            with self.subTest(after=after):
                self.assertFalse(repeats_fast(fast(before), after))
        steered = dict(fast("Thanks, noted."), steered=["other"])
        self.assertFalse(repeats_fast(steered, "Thanks, noted."))
        self.assertFalse(repeats_fast({}, "You're welcome!"))

    def test_missing_run_notice_only_waits_while_this_inputs_match_lags(self):
        from v2.compat.v1_runtime import activity
        def worker(head):
            value = type("W", (), {})()
            value.call = lambda method, route, body=None, allowed=(200,): dict(last_sequence=head)
            return value
        self.assertTrue(activity.match_lagging(worker(10), {"cursor": 4}))
        self.assertFalse(activity.match_lagging(worker(4), {"cursor": 4}))


if __name__ == "__main__":
    unittest.main()
