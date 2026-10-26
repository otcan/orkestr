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


class StrandedInputTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.ledger = Ledger(Path(temporary.name) / "ledger.sqlite3", {"test_scope": "gulsah"})
        self.data, _ = self.ledger.enqueue(dict(publicMessageId="member-msg", publicThreadId="thread", chatId="chat",
            accountId="account", text="Merhaba, bu profili bugün güncelleyebilir misin? Teşekkürler"),
            author=dict(role="member", id="synthetic-member", label="Member"))
        self.peer = GulsahPeer()
        self.worker = Worker(self.peer, self.ledger)

    def notices(self):
        return [m for m in self.ledger.messages() if m.get("kind") == "notice"]

    def passes(self, passes=2):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            for _ in range(passes):
                self.worker.run_once(fixture.Stop())
        return err.getvalue()

    def test_started_deep_cancelled_with_closed_window_settles_with_one_localized_notice(self):
        # The live state: the Deep had been seen running before the lease lapsed.
        self.passes(1)
        data = self.ledger.next_input()
        data["activity"] = {"run_id": "deep-run", "phase": "running"}
        self.ledger.save(data)
        log = self.passes(2)
        data = self.ledger.input(self.data["remote_id"])
        self.assertEqual(data["phase"], "completed", "never stranded in running")
        self.assertEqual(data["refused"]["reason"], "deep_run_cancelled")
        self.assertNotIn("readmitted", data, "a started run may have acted: never retried")
        (notice,) = self.notices()
        self.assertEqual(data["notice_language"], "tr")
        self.assertEqual(notice["text"], notices.TEMPLATES["failure"]["tr"])
        self.assertIn("ALERT orkestr-v2-wa-adapter input_refused", log)
        self.assertEqual(len([r for r, _ in self.peer.mutations if r == "/messages"]), 1)

    def test_unstarted_failure_retries_once_silently_then_notices(self):
        log = self.passes(2)
        data = self.ledger.next_input()
        self.assertEqual(data["readmitted"]["trigger"], "automatic")
        self.assertEqual(data["phase"], "queued")
        self.assertEqual(self.notices(), [])
        self.assertIn("input_readmitted", log)
        self.assertNotIn("ALERT", log)
        log = self.passes(3)  # The retry fails the same way.
        self.assertEqual(self.ledger.input(self.data["remote_id"])["phase"], "completed")
        self.assertEqual(len(self.notices()), 1)
        self.assertIn("ALERT orkestr-v2-wa-adapter input_refused", log)
        self.assertEqual(len([r for r, _ in self.peer.mutations if r == "/messages"]), 2)

    def test_unstarted_retry_that_succeeds_sends_no_notice(self):
        self.passes(2)
        self.peer.deep_phase = self.peer.fast_phase = None
        self.peer.current = None
        self.peer.accepted.clear()
        self.passes(2)
        self.assertEqual(self.notices(), [])
        self.assertEqual(self.ledger.messages()[-1]["text"], "deep result")

    def test_older_than_a_day_is_never_retried_or_announced(self):
        self.passes(1)
        data = self.ledger.next_input()
        data["arrived_at"] = time.time() - recovery.MAX_AGE_S - 1
        self.ledger.save(data)
        log = self.passes(2)
        data = self.ledger.input(self.data["remote_id"])
        self.assertEqual(data["phase"], "completed")
        self.assertEqual(data["settled"]["outcome"], "suppressed")
        self.assertNotIn("readmitted", data)
        self.assertEqual(self.notices(), [])
        self.assertIn("ALERT orkestr-v2-wa-adapter input_failed_too_old", log)

    def test_requires_review_is_never_retried_and_says_so_to_the_owner(self):
        self.ledger.owner_only = True
        owner, _ = self.ledger.enqueue(dict(publicMessageId="owner-msg", publicThreadId="thread", chatId="chat",
            accountId="account", text="Send the four drafts now, please"), author=dict(role="owner", id="o", label="O"))
        self.ledger.finish_silently(self.ledger.input(self.data["remote_id"]), "suppressed")
        with quiet():
            message = self.ledger.refuse(self.ledger.input(owner["remote_id"]), "execution_requires_review")
        self.assertEqual(message["text"], notices.render("en", "interrupted_owner", reason="execution_requires_review"))
        self.assertIn("nothing is retried", message["text"])
        self.assertNotIn("readmitted", self.ledger.input(owner["remote_id"]))


class TimerRetryTests(unittest.TestCase):
    """Nobody resends a timer: an unstarted one is retried once; otherwise a timer notice."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.ledger = Ledger(Path(temporary.name) / "ledger.sqlite3", {"test_scope": "timer"})
        self.data, _ = self.ledger.enqueue_timer(dict(message_id=identity(7), event_id=identity(8), sequence=5,
            request_key="timer:synthetic", namespace="ns", claim_id="claim", label="Morning pass"))
        self.data.update(phase="running", window={"dispatched_by": "server_timer_queue"}, matched_runs=[])
        self.ledger.save(self.data)
        self.calls = []
        worker = self

        class FakeWorker:
            ledger = self.ledger
            client = type("C", (), {"conversation": "synthetic"})()

            def call(self, method, route, body=None, allowed=(200,)):
                worker.calls.append(route)
                if route == "/window":
                    return None  # 204: no live window
                if route.startswith("?after="):
                    return dict(messages=[dict(message_id=identity(7), text="Run the morning pass.", sequence=5)])
                raise AssertionError(route)

            def window_ended(self, data):
                return True
        self.worker = FakeWorker()

    def test_unstarted_timer_is_retried_once_with_its_own_prompt(self):
        with quiet():
            self.assertTrue(recovery.recover(self.worker, self.data, "timer_window_ended_without_run"))
        data = self.ledger.input(self.data["remote_id"])
        self.assertEqual(data["origin"], "timer")
        self.assertEqual(data["phase"], "queued")
        self.assertTrue(data["intake_text"].endswith("Run the morning pass."))
        self.assertIn("Morning pass", data["intake_text"])
        self.assertNotIn("intake", data)
        with self.assertRaises(Refused):
            recovery.recover(self.worker, data, "timer_window_ended_without_run")
        with quiet():
            message = self.ledger.refuse(data, "timer_window_ended_without_run", alert=True)
        self.assertTrue(message["text"].startswith("⏰ Morning pass failed twice"))
        self.assertNotIn("send it again", message["text"])

    def test_started_timer_is_not_retried_and_says_so(self):
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
            self.assertEqual(message["text"], notices.TEMPLATES["failure"]["tr"])
            ledger.owner_only = True
            second = ledger.input(ledger.enqueue(dict(publicMessageId="de", publicThreadId="t", chatId="c",
                accountId="a", text="Bitte prüfe das noch einmal, danke"), author=dict(role="owner", id="o",
                label="O"))[0]["remote_id"])
            with quiet():
                message = ledger.refuse(second, "window_refused")
            self.assertEqual(message["text"], notices.render("de", "failure_owner", reason="window_refused"))

    def test_every_template_has_all_languages(self):
        for key, table in notices.TEMPLATES.items():
            self.assertEqual(set(table), set(notices.LANGUAGES), key)
            for lang in notices.LANGUAGES:
                self.assertNotIn("send it again", table[lang], key)


class DuplicateAndStatusTests(unittest.TestCase):
    def test_deep_final_that_repeats_fast_is_detected(self):
        data = {"first_response": {"echo": "you re welcome happy to help"}}
        self.assertTrue(repeats_fast(data, "You're welcome! Happy to help."))
        self.assertFalse(repeats_fast(data, "The RDB value is a system bug; I fixed the mapping and redeployed."))
        self.assertFalse(repeats_fast({}, "You're welcome!"))

    def test_missing_run_notice_is_not_sent_while_core_runs_a_deep(self):
        from v2.compat.v1_runtime import activity
        busy = type("W", (), {})()
        busy.client = type("C", (), {"request": staticmethod(
            lambda method, route, allowed=(200,): (200, dict(phase="running", run_id="synthetic")))})()
        self.assertTrue(activity.conversation_busy(busy))
        idle = type("W", (), {})()
        idle.client = type("C", (), {"request": staticmethod(lambda method, route, allowed=(200,): (204, None))})()
        self.assertFalse(activity.conversation_busy(idle))


if __name__ == "__main__":
    unittest.main()
