"""Timer occurrences settle from their own runs and only genuine stalls alert.

Occurrences of one binding are driven one at a time, so an occurrence is often
driven after later ones already ran: its runs are no longer the conversation's
current Fast/Deep views. It must still settle (silently when its answer is
silent), and an occurrence whose window ended without a Deep run must not hold
every later one behind it. A window still open, a run past its deadline and a
failed run with no answer stay operator alerts.
"""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import time
import unittest

from v2.compat.v1_runtime.ledger import Ledger
from v2.compat.v1_runtime.rust_client import ClientError
from v2.compat.v1_runtime.worker import ORPHAN_GRACE_S, Worker
from v2.compat.v1_runtime.tests.test_timer_relay import SCOPE, TimerPeer, _Stop, occurrence


def status(run_id, phase, payload=None):
    value = dict(run_id=run_id, revision=10, phase=phase, progress=dict(payload_id=payload or run_id + "-payload"))
    if phase == "awaiting_acceptance":
        value["acceptance_candidate"] = dict(run_id=run_id, completion_event_id=run_id + "-completion")
    return value


class OwnRunPeer(TimerPeer):
    """Runs are looked up by ID; the current views show a later, unrelated run."""

    def __init__(self):
        super().__init__()
        self.runs = {}          # message id -> {"fast": status, "deep": status}
        self.texts = {}         # run id -> final payload text
        self.window = dict(window_id="later-window", state="closed", conversation_id=self.conversation, generation=9)
        self.auto_accepted = set()

    def matching_run_ids(self, events, intake):
        roles = self.runs.get(intake["message_id"], {})
        return sorted(value["run_id"] for value in roles.values())

    def lookup(self, role, run_id):
        for roles in self.runs.values():
            value = roles.get(role)
            if value and value["run_id"] == run_id:
                return value
        return None

    def request(self, method, route, body=None, allowed=(200,)):
        self.reads.append((method, route))
        path, _, run_id = route.partition("?run_id=")
        if path in ("/execution", "/fast/execution"):
            if not run_id:
                return 200, status("later-run", "running")
            value = self.lookup("fast" if path.startswith("/fast") else "deep", run_id)
            return (200, dict(value)) if value else (404, {"code": "not_found"})
        if route == "/window" and method == "GET":
            return (200, dict(self.window)) if self.window else (204, None)
        if route.startswith("?after="):
            # Older servers / unproven prompt text: no automatic timer retry.
            raise ClientError("unexpected_status", 404)
        if route.startswith("/payloads/"):
            payload = route.split("/")[2]
            run = payload[:-len("-payload")]
            return 200, dict(run_id=run, payload_id=payload, text=self.texts.get(run, "report"))
        if route.startswith("/accepted-results?"):
            return 200, dict(results=[dict(run_id=run, completion_event_id=run + "-completion",
                                           acceptance_event_id=run + "-accepted", payload_id=run + "-payload",
                                           payload_removed=False, auto_accepted=True)
                                      for run in sorted(self.auto_accepted)], next_after_sequence=None)
        return super().request(method, route, body, allowed)

    def ran(self, sequence, deep="completed", fast="completed", text="report"):
        """Occurrence `sequence` ran; completed runs were accepted by the server."""
        roles = {}
        for role, phase in (("fast", fast), ("deep", deep)):
            if phase:
                run = "%s-%d" % (role, sequence)
                roles[role] = status(run, phase)
                if phase == "completed":
                    self.auto_accepted.add(run)
        self.runs[occurrence(sequence)["message_id"]] = roles
        self.texts["deep-%d" % sequence] = text


class Base(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ledger = Ledger(Path(self.temp.name) / "ledger.sqlite3", SCOPE)
        self.peer = OwnRunPeer()
        self.worker = Worker(self.peer, self.ledger)
        self.ledger.set_timer_cursor(0)

    def drive(self, passes=1):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            for _ in range(passes):
                self.worker.run_once(_Stop())
        return err.getvalue()

    def row(self, sequence):
        with self.ledger.connect() as db:
            for (raw,) in db.execute("SELECT data FROM inputs ORDER BY rowid"):
                data = json.loads(raw)
                if data.get("intake", {}).get("sequence") == sequence:
                    return data
        raise AssertionError("no input %d" % sequence)

    def expire_grace(self, sequence):
        data = self.row(sequence)
        data["deep_missing_since"] -= ORPHAN_GRACE_S + 1
        self.ledger.save(data)

    def replies(self):
        return [m for m in self.ledger.messages(500) if m["role"] == "assistant"]


class SilentTerminalTimerTests(Base):
    def test_old_occurrence_with_silent_outcome_completes_silently_and_never_stalls(self):
        self.peer.outcome = lambda body: {"outcome": "silent", "deliver": False, "summary": "x", "replay": False}
        self.peer.ran(2)
        self.peer.timer_rows = [occurrence(2)]
        self.drive()
        data = self.row(2)
        self.assertEqual(data["phase"], "completed")
        self.assertEqual(self.peer.mutations, [], "server auto-accepted both runs; nothing is re-accepted")
        self.assertEqual(self.peer.outcomes, [{"claim_id": occurrence(2)["claim_id"], "text": "report"}])
        (reply,) = self.replies()
        self.assertTrue(reply["noReply"])
        user = [m for m in self.ledger.messages() if m["role"] == "user"][0]
        done = self.ledger.acknowledge(reply["id"], {"outcome": "no_reply", "parentPublicMessageId": user["publicMessageId"]})
        self.assertTrue(done["settled"])

    def test_no_reply_answer_without_outcome_route_is_silent(self):
        self.peer.ran(2, text="NO_REPLY")
        self.peer.timer_rows = [occurrence(2)]
        self.drive()
        self.assertEqual(self.row(2)["phase"], "completed")
        (reply,) = self.replies()
        self.assertTrue(reply["noReply"])

    def test_answer_with_news_is_still_delivered(self):
        self.peer.outcome = lambda body: {"outcome": "delivered", "deliver": True, "summary": "x", "replay": False}
        self.peer.ran(2, text="Two new job signals")
        self.peer.timer_rows = [occurrence(2)]
        self.drive()
        (reply,) = self.replies()
        self.assertEqual(reply["text"], "Two new job signals")

    def test_occurrences_queued_behind_a_dead_one_settle_in_order(self):
        """A window that ended without running the first occurrence alerts once
        and no longer holds the later ones, whose runs already finished."""
        self.peer.outcome = lambda body: {"outcome": "silent", "deliver": False, "summary": "x", "replay": False}
        self.peer.ran(3)
        self.peer.ran(4)
        self.peer.timer_rows = [occurrence(2), occurrence(3), occurrence(4)]
        self.drive()
        self.assertEqual(self.row(2)["phase"], "running", "within the grace period it waits")
        self.expire_grace(2)
        log = self.drive(3)
        first = self.row(2)
        self.assertEqual(first["refused"]["reason"], "timer_window_ended_without_run")
        self.assertEqual(first["stalled"]["failed"], "timer_window_ended_without_run")
        self.assertIn("ALERT orkestr-v2-wa-adapter input_failed", log)
        self.assertEqual(log.count("ALERT"), 1)
        self.assertEqual([self.row(s)["phase"] for s in (3, 4)], ["completed", "completed"])
        self.assertTrue(all(r.get("noReply") for r in self.replies() if r.get("kind") != "notice"))
        self.assertIsNone(self.ledger.next_input())


class GenuineStallTests(Base):
    def test_failed_deep_run_without_an_answer_alerts(self):
        self.peer.ran(2, deep="failed", fast="completed")
        self.peer.timer_rows = [occurrence(2)]
        log = self.drive(2)
        data = self.row(2)
        self.assertEqual(data["phase"], "completed")
        self.assertEqual(data["refused"]["reason"], "deep_run_failed")
        self.assertEqual(data["stalled"]["failed"], "deep_run_failed")
        (notice,) = [r for r in self.replies() if r.get("kind") == "notice"]
        self.assertTrue(notice["text"].startswith("\u23f0 "))
        self.assertNotIn("send it again", notice["text"])
        self.assertEqual(data["stalled"]["since"], data["admitted_at"])
        self.assertIn("ALERT orkestr-v2-wa-adapter input_failed", log)

    def test_fast_only_turn_whose_deep_never_ran_alerts_once_the_window_closed(self):
        self.peer.ran(2, deep=None, fast="completed")
        self.peer.timer_rows = [occurrence(2)]
        self.drive()
        self.expire_grace(2)
        log = self.drive()
        self.assertEqual(self.row(2)["refused"]["reason"], "timer_window_ended_without_run")
        self.assertIn("input_failed", log)


class RetriedOpenTests(Base):
    """Core queues an occurrence again once when its window failed to open."""

    def wait_for_retry(self):
        self.peer.timer_rows = [occurrence(2)]
        self.drive()
        self.expire_grace(2)
        # The failed window is closed, but Core put the occurrence back in line.
        self.peer.timer_rows = [occurrence(2, window="queued")]
        log = self.drive()
        data = self.row(2)
        self.assertNotIn("refused", data)
        self.assertEqual(data["phase"], "waiting_for_timer_retry")
        self.assertNotIn("ALERT", log)
        self.peer.timer_rows = [occurrence(2)]

    def test_requeued_occurrence_waits_and_delivers_its_retry_answer(self):
        self.wait_for_retry()
        self.peer.outcome = lambda body: {"outcome": "delivered", "deliver": True, "summary": "x", "replay": False}
        self.peer.ran(2, text="Two new job signals")
        self.drive()
        self.assertEqual(self.row(2)["phase"], "completed")
        (reply,) = self.replies()
        self.assertEqual(reply["text"], "Two new job signals")

    def test_failed_retry_is_refused_with_one_operator_alert(self):
        self.wait_for_retry()
        self.drive()
        self.assertNotIn("refused", self.row(2), "the retry gets its own grace period")
        self.expire_grace(2)
        log = self.drive()
        data = self.row(2)
        self.assertEqual(data["refused"]["reason"], "timer_window_ended_without_run")
        self.assertIn("ALERT orkestr-v2-wa-adapter input_failed", log)
        self.assertEqual(log.count("ALERT"), 1)


if __name__ == "__main__":
    unittest.main()
