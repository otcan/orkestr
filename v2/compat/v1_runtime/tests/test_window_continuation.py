"""Core-queued windows and the one-time continuation after a deadline stop."""
import copy
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from v2.compat.v1_runtime import recovery
from v2.compat.v1_runtime.ledger import Ledger
from v2.compat.v1_runtime.rust_client import ClientError
from v2.compat.v1_runtime.worker import CONTINUE_NOTICE, CONTINUE_PREFIX, Refused, Worker
from v2.compat.v1_runtime.tests.test_worker import Peer


class QueuePeer(Peer):
    def __init__(self):
        super().__init__()
        self.queue_state = None
        self.deep_phase = None
        self.current = None
        self.provider = "codex"
        self.provider_generation = 0
        self.run_provider = "codex"

    def request(self, method, route, body=None, allowed=(200,)):
        if route == "/settings" and method == "GET":
            return 200, dict(provider=self.provider, provider_generation=self.provider_generation)
        if route == "/window" and method == "GET":
            return (200, self.current) if self.current else (204, None)
        if route == "/window" and method == "POST" and self.queue_state:
            self.mutations.append((route, copy.deepcopy(body)))
            reply = {k: body[k] for k in ("request_key", "input_message_id", "input_event_id", "input_request_key")}
            reply.update(conversation_id=self.conversation, state=self.queue_state, position=1, queued_at_ms=1,
                         window_id="window" if self.queue_state == "dispatched" else None, withdrawal=None)
            return 202, reply
        if route.split("?", 1)[0] == "/execution" and self.deep_phase:
            return 200, dict(run_id="deep-run", revision=10, phase=self.deep_phase,
                             models=dict(provider=self.run_provider))
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

    def settle_terminal(self, data):
        """A terminal Deep is decided only on a pass whose journal read is empty."""
        self.worker.step(data)
        return self.worker.step(self.ledger.next_input())


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
        self.peer.current = dict(window_id="window", state="closed", conversation_id="conversation",
                                 work_deadline_ms=int(time.time() * 1000) - 1000)

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

    def test_quoted_reply_context_reaches_rust_and_survives_the_requeue(self):
        quoted = dict(message_id="true_chat_ABC", author="orkestr", sent_at="2026-01-02T21:50:00Z", text="earlier", is_own_reply=True, unavailable=False)
        self.data["reply_to"] = quoted
        self.stop_by_deadline()
        self.worker.step(self.data)
        resumed = self.ledger.next_input()
        self.peer.deep_phase, self.peer.current = None, None
        self.peer.accepted.clear()
        self.worker.step(resumed)
        messages = [body for route, body in self.peer.mutations if route == "/messages"]
        self.assertEqual([m.get("reply_to") for m in messages], [quoted, quoted])

    def test_second_deadline_stop_refuses_visibly(self):
        self.stop_by_deadline()
        self.worker.step(self.data)
        resumed = self.ledger.next_input()
        self.peer.accepted.clear()
        # The continuation was the one automatic retry: no re-admission now.
        with self.assertRaisesRegex(Refused, "deep_run_cancelled"):
            self.settle_terminal(resumed)
        self.assertEqual(len(self.notices()), 1)
        self.assertNotIn("readmitted", self.ledger.next_input())

    def test_closed_window_before_the_deadline_is_not_a_deadline_stop(self):
        # A lapsed lease / failed reconciliation closes the window early: it is
        # neither "continued" nor retried (the Deep run may have acted).
        self.peer.deep_phase = "cancelled"
        self.peer.current = dict(window_id="window", state="closed", conversation_id="conversation",
                                 work_deadline_ms=int(time.time() * 1000) + 600_000)
        with self.assertRaisesRegex(Refused, "deep_run_cancelled"):
            self.settle_terminal(self.data)
        data = self.ledger.next_input()
        self.assertNotIn("continued", data)
        self.assertNotIn("readmitted", data)
        self.assertEqual(self.notices(), [])

    def test_owner_stop_before_the_deadline_still_refuses(self):
        self.peer.deep_phase = "cancelled"
        self.peer.current = dict(window_id="window", state="active", conversation_id="conversation",
                                 work_deadline_ms=int(time.time() * 1000) + 600_000)
        with self.assertRaisesRegex(Refused, "deep_run_cancelled"):
            self.settle_terminal(self.data)
        self.assertEqual(self.notices(), [])
        self.assertNotIn("readmitted", self.ledger.next_input())

    def test_failed_deep_is_never_continued(self):
        self.peer.deep_phase = "failed"
        self.peer.current = dict(window_id="window", state="closed", conversation_id="conversation")
        with self.assertRaisesRegex(Refused, "deep_run_failed"):
            self.settle_terminal(self.data)
        self.assertNotIn("continued", self.ledger.next_input())


if __name__ == "__main__":
    unittest.main()


class StrandedFastPeer(QueuePeer):
    def __init__(self):
        super().__init__()
        self.fast = None  # None: Fast status 204 (no live Fast handle)

    def request(self, method, route, body=None, allowed=(200,)):
        if route.split("?", 1)[0] == "/fast/execution" and method == "GET":
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


class OrphanedFollowUpTests(Case):
    def setUp(self):
        super().setUp()
        self.enterContext(patch.object(recovery, "ENDED_CONFIRM_S", 0))

    def orphan(self):
        self.peer.foreign = True  # No run of this input ever starts.
        self.worker.step(self.data)
        data = self.ledger.next_input()
        self.assertEqual(data["phase"], "running")
        return data

    def end_window(self, data):
        data["unstarted_since"] -= 61
        self.ledger.save(data)
        self.peer.current = dict(window_id="window", state="closed", conversation_id="conversation")

    def test_unstarted_follow_up_refuses_without_creating_another_message(self):
        data = self.orphan()
        original = copy.deepcopy(data)
        self.peer.current = dict(window_id="window", state="closed", conversation_id="conversation")
        self.worker.step(data)  # Still inside the grace period.
        self.end_window(data)
        # Core refuses to retire it (it may hand it to a successor window):
        # keep matching and waiting, bounded, then the pre-change refusal.
        self.worker.step(self.ledger.next_input())
        data = self.ledger.next_input()
        self.assertEqual(data["phase"], "running")
        self.assertNotIn("readmitted", data)
        data["retry_wait_since"] -= recovery.RETIRE_WAIT_S + 1
        self.ledger.save(data)
        for _ in range(2):
            with self.assertRaisesRegex(Refused, "window_setup_failed"):
                self.worker.step(self.ledger.next_input())
        data = self.ledger.next_input()
        self.assertEqual(data["keys"], original["keys"])
        self.assertEqual(data["intake"], original["intake"])
        self.assertNotIn("requeued", data)
        self.assertEqual(len([r for r, _ in self.peer.mutations if r == "/messages"]), 1)

    def test_retired_unstarted_follow_up_is_readmitted_once_under_the_same_identity(self):
        data = self.orphan()
        original = copy.deepcopy(data)
        self.end_window(data)
        self.peer.retire_state = "retired"
        self.worker.step(self.ledger.next_input())
        data = self.ledger.next_input()
        self.assertEqual(data["readmitted"]["previous"]["message_id"], original["intake"]["message_id"])
        self.assertEqual(data["retired_original"]["message_id"], original["intake"]["message_id"])
        self.assertEqual((data["public_id"], data["remote_id"]), (original["public_id"], original["remote_id"]))
        self.assertNotEqual(data["keys"]["message"], original["keys"]["message"])
        self.assertEqual([m for m in self.ledger.messages() if m.get("kind") == "notice"], [])

    def test_open_window_keeps_waiting(self):
        data = self.orphan()
        data["unstarted_since"] -= 61
        self.ledger.save(data)
        self.peer.current = dict(window_id="window", state="active", conversation_id="conversation",
                                 work_deadline_ms=int(time.time() * 1000) + 600_000)
        self.worker.step(self.ledger.next_input())
        self.assertEqual(self.ledger.next_input()["phase"], "running")

    def test_failure_notice_settles_once_and_later_input_proceeds(self):
        data = self.orphan()
        later, _ = self.ledger.enqueue(dict(publicMessageId="later", publicThreadId="thread", chatId="chat",
                                            accountId="account", text="next"))
        data["readmitted"] = {"at": time.time(), "trigger": "automatic"}  # Its one retry was used.
        self.end_window(data)
        self.worker.run_once(_Stop())
        self.worker.run_once(_Stop())
        notices = [m for m in self.ledger.messages() if m.get("kind") == "notice"]
        self.assertEqual([m["refusal"] for m in notices], ["window_setup_failed"])
        acked = self.ledger.acknowledge(notices[0]["id"], {"outcome": "delivered", "outboxJobId": "job",
                                                       "parentPublicMessageId": "public"})
        self.assertTrue(acked["settled"])
        self.assertEqual(self.ledger.next_input()["public_id"], later["public_id"])
        messages = [body for route, body in self.peer.mutations if route == "/messages"]
        self.assertEqual(sum(body["client_message_id"] == self.data["keys"]["message"] for body in messages), 1)
        self.assertEqual(len(messages), 2)

    def test_legacy_requeued_input_is_not_cloned_again_after_restart(self):
        data = self.orphan()
        data["requeued"] = {"previous_message_id": "legacy", "at": 1}
        data["readmitted"] = {"at": time.time(), "trigger": "automatic"}
        self.end_window(data)
        restarted = Worker(self.peer, Ledger(Path(self.temp.name) / "ledger.sqlite3", {"test_scope": "one"}))
        with self.assertRaisesRegex(Refused, "window_setup_failed"):
            restarted.step(restarted.ledger.next_input())
        self.assertEqual(len([r for r, _ in self.peer.mutations if r == "/messages"]), 1)

    def test_missing_window_refuses_after_grace(self):
        data = self.orphan()
        data["readmitted"] = {"at": time.time(), "trigger": "automatic"}
        self.end_window(data)
        self.peer.current = None
        with self.assertRaisesRegex(Refused, "window_setup_failed"):
            self.worker.step(self.ledger.next_input())


class _Stop:
    def wait(self, _):
        return False


class RefusalSettlesFastTests(Case):
    def test_failed_deep_refusal_accepts_its_own_pending_fast(self):
        self.peer.deep_phase = "failed"
        self.peer.current = dict(window_id="window", state="active", conversation_id="conversation",
                                 work_deadline_ms=int(time.time() * 1000) + 600_000)
        with self.assertRaisesRegex(Refused, "deep_run_failed"):
            self.settle_terminal(self.data)
        self.assertIn("fast", self.peer.accepted)
        self.assertNotIn("deep", self.peer.accepted)


class ServerAcceptedPeer(Peer):
    """The server's owner auto-accept settles proposals before the adapter."""

    def __init__(self, roles, *, before_freeze=True):
        super().__init__()
        self.server_roles, self.before_freeze = set(roles), before_freeze

    def server_accept(self, role):
        self.accepted.setdefault(role, dict(run_id=role + "-run", completion_event_id=role + "-completion",
                                            request_key="auto-accept:" + role + "-run", outcome="succeeded",
                                            acceptance_event_id=role + "-auto-accepted"))

    def request(self, method, route, body=None, allowed=(200,)):
        if route.split("?", 1)[0] in ("/execution", "/fast/execution") and self.before_freeze:
            role = "fast" if route.startswith("/fast") else "deep"
            if role in self.server_roles:
                self.server_accept(role)
        if route == "/accept" and body["run_id"].split("-")[0] in self.server_roles:
            self.mutations.append((route, copy.deepcopy(body)))
            self.server_accept(body["run_id"].split("-")[0])
            raise ClientError("unexpected_status", 409)
        if route.startswith("/accepted-results?"):
            return 200, dict(results=[dict(run_id=role + "-run", completion_event_id=role + "-completion",
                acceptance_event_id=receipt["acceptance_event_id"], payload_id=role + "-payload",
                payload_removed=False) for role, receipt in self.accepted.items()], next_after_sequence=None)
        return super().request(method, route, body=body, allowed=allowed)


class ServerAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ledger = Ledger(Path(self.temp.name) / "ledger.sqlite3", {"test_scope": "one"})
        self.data, _ = self.ledger.enqueue(dict(publicMessageId="public", publicThreadId="thread", chatId="chat",
                                                accountId="account", text="request"))

    def assert_mirrored(self, peer):
        self.assertEqual(self.data["phase"], "completed")
        reply = [m for m in self.ledger.messages() if m["role"] == "assistant"]
        self.assertEqual(len(reply), 1)
        self.assertEqual(reply[0]["text"], "deep result")
        self.assertEqual(reply[0]["id"], "deep-auto-accepted")
        deep = self.data["accepted"]["deep"]
        self.assertEqual((deep["run_id"], deep["completion_event_id"], deep["acceptance_event_id"]),
                         ("deep-run", "deep-completion", "deep-auto-accepted"))

    def test_already_completed_runs_are_adopted_and_mirrored(self):
        peer = ServerAcceptedPeer({"fast", "deep"})
        Worker(peer, self.ledger).step(self.data)
        self.assert_mirrored(peer)
        self.assertFalse([route for route, _ in peer.mutations if route == "/accept"])

    def test_conflicting_accept_adopts_the_server_acceptance(self):
        peer = ServerAcceptedPeer({"deep"}, before_freeze=False)
        Worker(peer, self.ledger).step(self.data)
        self.assert_mirrored(peer)
        self.assertEqual([body["run_id"] for route, body in peer.mutations if route == "/accept"], ["fast-run", "deep-run"])
        self.assertEqual(self.data["accepted"]["fast"]["acceptance_event_id"], "fast-accepted")

    def test_completed_run_without_acceptance_still_refuses(self):
        peer = ServerAcceptedPeer(set())
        original = peer.request
        def request(method, route, body=None, allowed=(200,)):
            if route.split("?", 1)[0] == "/execution":
                return 200, dict(run_id="deep-run", revision=10, phase="completed")
            return original(method, route, body=body, allowed=allowed)
        peer.request = request
        with self.assertRaisesRegex(Refused, "execution_requires_review"):
            Worker(peer, self.ledger).step(self.data)
        self.assertNotIn("reply", self.data)

    def test_foreign_completed_run_is_never_adopted(self):
        peer = ServerAcceptedPeer({"fast", "deep"})
        peer.foreign = True
        Worker(peer, self.ledger).step(self.data)
        self.assertFalse(self.data.get("accepted"))
        self.assertNotIn("reply", self.data)
