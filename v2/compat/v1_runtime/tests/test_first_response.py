"""Interactive Fast delivery through the real input/export ledger; no sends."""
from unittest.mock import patch
import unittest

from v2.compat.v1_runtime.tests import test_worker as fixture
from v2.compat.v1_runtime.worker import Worker


class FirstResponseTests(unittest.TestCase):
    setUp = fixture.WorkerTests.setUp

    def configure(self, fast="I am checking the request.", deep="running", final="Here is the result."):
        self.state = {"fast": fast, "deep": deep, "final": final, "payload": "deep-progress"}
        self.data["queued_at"] = 100
        self.ledger.save(self.data)
        original = self.peer.request
        def request(method, route, **kwargs):
            if route == "/execution" and self.state["deep"] == "running":
                return 200, {"run_id": "deep-run", "phase": "running", "revision": 1,
                             "progress": {"payload_id": self.state["payload"]}}
            if route == "/payloads/fast-payload":
                return 200, {"run_id": "fast-run", "payload_id": "fast-payload", "text": self.state["fast"]}
            if route == "/payloads/deep-payload":
                return 200, {"run_id": "deep-run", "payload_id": "deep-payload", "text": self.state["final"]}
            if route.startswith("/payloads/deep-progress"):
                return 200, {"run_id": "deep-run", "payload_id": self.state["payload"], "text": "Still checking."}
            return original(method, route, **kwargs)
        self.peer.request = request
        self.worker = Worker(self.peer, self.ledger, progress_updates=True)

    def step_at(self, seconds):
        with patch("time.time", return_value=100 + seconds):
            self.worker.step(self.ledger.next_input() or self.data)

    def replies(self):
        return [r for r in self.ledger.messages() if r["role"] == "assistant"]

    def test_fast_only_reply_is_exported_at_five_seconds_and_survives_restart_once(self):
        self.configure()
        self.step_at(1)
        self.assertEqual(self.replies(), [])
        self.step_at(5)
        first = self.replies()
        self.assertEqual([r["text"] for r in first], [self.state["fast"]])
        self.assertEqual(first[0]["kind"], "progress")
        self.worker = Worker(self.peer, self.ledger, progress_updates=True)
        self.step_at(6)
        self.assertEqual(self.replies(), first)
        self.assertNotIn("deep", self.peer.accepted)

    def test_ack_then_final_and_later_progress_are_spaced_by_a_minute(self):
        self.configure()
        self.step_at(5)
        self.step_at(64)
        self.assertEqual(len(self.replies()), 1)
        self.step_at(65)
        self.assertEqual([r["text"] for r in self.replies()], [self.state["fast"], "Still checking."])
        self.state["deep"] = "ready"
        self.step_at(66)
        self.assertEqual([r["text"] for r in self.replies()],
                         [self.state["fast"], "Still checking.", self.state["final"]])

    def test_final_ready_within_five_seconds_suppresses_the_ack(self):
        self.configure()
        self.step_at(1)
        self.state["deep"] = "ready"
        self.step_at(4)
        self.assertEqual([r["text"] for r in self.replies()], [self.state["final"]])

    def test_final_no_reply_within_five_seconds_suppresses_a_substantive_fast_ack(self):
        self.configure(final="NO_REPLY")
        self.step_at(1)
        self.state["deep"] = "ready"
        self.step_at(4)
        self.assertEqual(len(self.replies()), 1)
        self.assertTrue(self.replies()[0]["noReply"])

    def test_first_available_fast_after_the_coalescing_window_has_no_extra_delay(self):
        self.configure()
        self.step_at(8)
        self.assertEqual([r["text"] for r in self.replies()], [self.state["fast"]])

    def test_foreign_fast_run_is_ignored(self):
        self.configure()
        original = self.peer.request
        def request(method, route, **kwargs):
            status, value = original(method, route, **kwargs)
            if route == "/fast/execution":
                value = {**value, "run_id": "foreign-fast-run"}
            return status, value
        self.peer.request = request
        self.step_at(8)
        self.assertEqual(self.replies(), [])

    def test_no_reply_fast_never_creates_an_ack_and_final_no_reply_stays_silent(self):
        self.configure(fast="NO_REPLY", final="NO_REPLY")
        self.step_at(5)
        self.assertEqual(self.replies(), [])
        self.state["deep"] = "ready"
        self.step_at(6)
        self.assertEqual(len(self.replies()), 1)
        self.assertTrue(self.replies()[0]["noReply"])
        self.assertEqual(self.replies()[0]["text"], "NO_REPLY")

    def test_disabled_preference_and_timers_do_not_emit_interactive_acks(self):
        self.configure()
        self.worker.progress_updates = False
        self.step_at(5)
        self.assertEqual(self.replies(), [])
        self.worker.progress_updates = True
        current = self.ledger.next_input()
        current["origin"] = "timer"
        self.ledger.save(current)
        # Exercise the helper directly: timer intake has its separate run lookup.
        from v2.compat.v1_runtime.first_response import capture
        capture(self.worker, current, {"fast": {"run_id": "fast-run", "phase": "completed"}}, {"fast-run"})
        self.assertEqual(self.replies(), [])


if __name__ == "__main__":
    unittest.main()
