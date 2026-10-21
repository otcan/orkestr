"""Core-queued windows and the one-time continuation after a deadline stop."""
import copy
from pathlib import Path
import tempfile
import time
import unittest

from v2.compat.v1_runtime.ledger import Ledger
from v2.compat.v1_runtime.worker import CONTINUE_NOTICE, CONTINUE_PREFIX, Refused, Worker
from v2.compat.v1_runtime.tests.test_worker import Peer


class QueuePeer(Peer):
    def __init__(self):
        super().__init__()
        self.queue_state = None
        self.deep_phase = None
        self.current = None

    def request(self, method, route, body=None, allowed=(200,)):
        if route == "/window" and method == "GET":
            return (200, self.current) if self.current else (204, None)
        if route == "/window" and method == "POST" and self.queue_state:
            self.mutations.append((route, copy.deepcopy(body)))
            reply = {k: body[k] for k in ("request_key", "input_message_id", "input_event_id", "input_request_key")}
            reply.update(conversation_id=self.conversation, state=self.queue_state, position=1, queued_at_ms=1,
                         window_id="window" if self.queue_state == "dispatched" else None, withdrawal=None)
            return 202, reply
        if route == "/execution" and self.deep_phase:
            return 200, dict(run_id="deep-run", revision=10, phase=self.deep_phase)
        return super().request(method, route, body=body, allowed=allowed)


class Case(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ledger = Ledger(Path(self.temp.name) / "ledger.sqlite3", {"test_scope": "one"})
        self.data, _ = self.ledger.enqueue(dict(publicMessageId="public", publicThreadId="thread", chatId="chat",
                                                accountId="account", text="request"))
        self.peer = QueuePeer()
        self.worker = Worker(self.peer, self.ledger)

    def notices(self):
        return [m for m in self.ledger.messages() if m.get("kind") == "progress"]


class QueuedWindowTests(Case):
    def test_queued_request_waits_without_expiring_then_runs_once_dispatched(self):
        self.peer.queue_state = "queued"
        self.worker.step(self.data)
        self.assertEqual(self.data["phase"], "waiting_for_window_dispatch")
        self.assertNotIn("window", self.data)
        # Core owns a queued intent: the adapter never expires it underneath.
        self.assertEqual(self.ledger.expire_stale(0, now=time.time() + 86400), [])
        frozen = self.data["window_request"]
        self.peer.queue_state = "dispatched"
        self.worker.step(self.ledger.next_input())
        posts = [body for route, body in self.peer.mutations if route == "/window"]
        self.assertEqual(posts, [frozen, frozen])
        self.assertEqual(self.ledger.messages()[-1]["text"], "deep result")

    def test_withdrawn_queue_row_refuses(self):
        self.peer.queue_state = "withdrawn"
        with self.assertRaisesRegex(Refused, "window_withdrawn"):
            self.worker.step(self.data)


class DeadlineContinuationTests(Case):
    def stop_by_deadline(self):
        self.peer.deep_phase = "cancelled"
        self.peer.current = dict(window_id="window", state="closed", conversation_id="conversation")

    def test_deadline_stop_requeues_once_and_tells_the_owner(self):
        original = dict(self.data["keys"])
        self.stop_by_deadline()
        self.worker.step(self.data)
        resumed = self.ledger.next_input()
        self.assertEqual(resumed["phase"], "queued")
        self.assertTrue(resumed["intake_text"].startswith(CONTINUE_PREFIX))
        self.assertTrue(resumed["intake_text"].endswith("request"))
        self.assertNotIn("window", resumed)
        self.assertTrue(all(resumed["keys"][k] != original[k] for k in ("message", "window", "fast", "deep")))
        self.assertEqual([m["text"] for m in self.notices()], [CONTINUE_NOTICE])
        # This input's own Fast proposal is settled so its window can close.
        self.assertIn("fast", self.peer.accepted)
        # The successor turn completes normally and is mirrored as the reply.
        self.peer.deep_phase, self.peer.current = None, None
        self.peer.accepted.clear()  # The synthetic peer reuses run IDs per turn.
        self.worker.step(resumed)
        messages = [body for route, body in self.peer.mutations if route == "/messages"]
        self.assertEqual(len(messages), 2)
        self.assertNotEqual(messages[0]["client_message_id"], messages[1]["client_message_id"])
        self.assertTrue(messages[1]["text"].startswith(CONTINUE_PREFIX))
        self.assertEqual(self.ledger.messages()[-1]["text"], "deep result")

    def test_second_deadline_stop_refuses_visibly(self):
        self.stop_by_deadline()
        self.worker.step(self.data)
        resumed = self.ledger.next_input()
        self.peer.accepted.clear()
        with self.assertRaisesRegex(Refused, "execution_requires_review"):
            self.worker.step(resumed)
        self.assertEqual(len(self.notices()), 1)

    def test_owner_stop_before_the_deadline_still_refuses(self):
        self.peer.deep_phase = "cancelled"
        self.peer.current = dict(window_id="window", state="active", conversation_id="conversation",
                                 work_deadline_ms=int(time.time() * 1000) + 600_000)
        with self.assertRaisesRegex(Refused, "execution_requires_review"):
            self.worker.step(self.data)
        self.assertEqual(self.notices(), [])

    def test_failed_deep_is_never_continued(self):
        self.peer.deep_phase = "failed"
        self.peer.current = dict(window_id="window", state="closed", conversation_id="conversation")
        with self.assertRaisesRegex(Refused, "execution_requires_review"):
            self.worker.step(self.data)


if __name__ == "__main__":
    unittest.main()


class StrandedFastPeer(QueuePeer):
    def __init__(self):
        super().__init__()
        self.fast = None  # None: Fast status 204 (no live Fast handle)

    def request(self, method, route, body=None, allowed=(200,)):
        if route == "/fast/execution" and method == "GET":
            return (200, self.fast) if self.fast else (204, None)
        return super().request(method, route, body=body, allowed=allowed)


class StrandedFastTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ledger = Ledger(Path(self.temp.name) / "ledger.sqlite3", {"test_scope": "one"})
        self.data, _ = self.ledger.enqueue(dict(publicMessageId="public", publicThreadId="thread", chatId="chat",
                                                accountId="account", text="request"))
        self.peer = StrandedFastPeer()
        self.worker = Worker(self.peer, self.ledger)

    def test_missing_fast_never_holds_the_deep_reply(self):
        self.worker.step(self.data)
        data = self.ledger.next_input()
        self.assertIn("fast_unusable_since", data)
        self.assertEqual(self.peer.accepted, {})  # Within the grace: still waiting.
        data["fast_unusable_since"] -= 61
        self.ledger.save(data)
        self.worker.step(self.ledger.next_input())
        self.assertEqual(set(self.peer.accepted), {"deep"})
        self.assertEqual(self.ledger.messages()[-1]["text"], "deep result")

    def test_failed_fast_waits_for_deep_instead_of_refusing(self):
        self.peer.fast = dict(run_id="fast-run", phase="failed")
        self.peer.deep_phase = "running"
        self.worker.step(self.data)
        data = self.ledger.next_input()
        self.assertEqual(data["phase"], "running")
        self.assertNotIn("fast_unusable_since", data)
        self.peer.deep_phase = None
        data["fast_unusable_since"] = time.time() - 61
        self.ledger.save(data)
        self.worker.step(self.ledger.next_input())
        self.assertEqual(self.ledger.messages()[-1]["text"], "deep result")


class SettlingWindowTests(Case):
    def test_closing_or_unreconciled_window_waits_without_freezing(self):
        for state in ("retiring", "reconciliation_required"):
            self.peer.current = dict(window_id="window", state=state, conversation_id="conversation", generation=8)
            self.worker.step(self.data)
            self.assertEqual(self.data["phase"], "waiting_for_window")
            self.assertNotIn("window_request", self.data)
        self.assertEqual([r for r, _ in self.peer.mutations if r == "/window"], [])
        self.peer.current = None
        self.worker.step(self.ledger.next_input())
        self.assertEqual(self.ledger.messages()[-1]["text"], "deep result")


class StallNoticeTests(Case):
    def test_unanswered_input_gets_one_notice_and_counts_as_stalled(self):
        from v2.compat.v1_runtime.worker import STALL_NOTICE, STALL_NOTICE_AFTER_S
        self.assertEqual(self.ledger.mark_stalled(STALL_NOTICE_AFTER_S, STALL_NOTICE), [])
        later = time.time() + STALL_NOTICE_AFTER_S + 1
        marked = self.ledger.mark_stalled(STALL_NOTICE_AFTER_S, STALL_NOTICE, now=later)
        self.assertEqual([d["remote_id"] for d in marked], [self.data["remote_id"]])
        self.assertEqual(self.ledger.mark_stalled(STALL_NOTICE_AFTER_S, STALL_NOTICE, now=later + 600), [])
        self.assertEqual([m["text"] for m in self.notices()], [STALL_NOTICE])
        self.assertEqual(self.ledger.health()["stalledInputs"], 1)
        # The input still runs to its reply; it then no longer counts.
        self.worker.step(self.ledger.next_input())
        self.assertEqual(self.ledger.messages()[-1]["text"], "deep result")
        self.assertEqual(self.ledger.health()["stalledInputs"], 0)


class OrphanedFollowUpTests(Case):
    def test_follow_up_whose_window_ended_unstarted_is_sent_again_once(self):
        self.peer.foreign = True  # No run of this input ever starts.
        self.worker.step(self.data)
        data = self.ledger.next_input()
        self.assertEqual(data["phase"], "running")
        self.assertIn("unstarted_since", data)
        # Still inside the grace period, or the window still open: wait.
        self.peer.current = dict(window_id="window", state="closed", conversation_id="conversation")
        self.worker.step(data)
        data = self.ledger.next_input()
        self.assertEqual(data["phase"], "running")
        data["unstarted_since"] -= 61
        self.ledger.save(data)
        self.worker.step(self.ledger.next_input())
        data = self.ledger.next_input()
        self.assertEqual(data["phase"], "queued")
        self.assertIn("requeued", data)
        self.assertFalse(data["intake_text"].startswith("[The previous turn"))
        self.assertEqual(self.notices(), [])
        # The new turn runs normally.
        self.peer.foreign, self.peer.current = False, None
        self.worker.step(data)
        self.assertEqual(self.ledger.messages()[-1]["text"], "deep result")
        messages = [body for route, body in self.peer.mutations if route == "/messages"]
        self.assertEqual(len(messages), 2)

    def test_open_window_keeps_waiting(self):
        self.peer.foreign = True
        self.worker.step(self.data)
        data = self.ledger.next_input()
        data["unstarted_since"] -= 61
        self.ledger.save(data)
        self.peer.current = dict(window_id="window", state="active", conversation_id="conversation",
                                 work_deadline_ms=int(time.time() * 1000) + 600_000)
        self.worker.step(self.ledger.next_input())
        self.assertEqual(self.ledger.next_input()["phase"], "running")


class RefusalSettlesFastTests(Case):
    def test_failed_deep_refusal_accepts_its_own_pending_fast(self):
        self.peer.deep_phase = "failed"
        with self.assertRaisesRegex(Refused, "execution_requires_review"):
            self.worker.step(self.data)
        self.assertIn("fast", self.peer.accepted)
        self.assertNotIn("deep", self.peer.accepted)
