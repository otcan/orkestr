import copy
from pathlib import Path
import tempfile
import unittest

from v2.compat.v1_runtime.ledger import Ledger
from v2.compat.v1_runtime.worker import Refused, Worker
from v2.compat.v1_runtime.rust_client import ClientError


class Peer:
    conversation = "conversation"

    def __init__(self):
        self.accepted, self.mutations = {}, []
        self.lose_deep_response = False
        self.foreign = False
        self.busy = False
        self.saved_window = None

    def window_request(self, intake, input_key, request_key, current):
        return dict(request_key=request_key, input_message_id=intake["message_id"], input_event_id=intake["event_id"],
                    input_request_key=input_key, expected_generation=0, window_id=None, predecessor_window_id=None)

    def read_events(self, after, maximum):
        return [{"sequence": 2, "run_id": "fast-run"}, {"sequence": 3, "run_id": "deep-run"}]

    def matching_run_ids(self, events, intake):
        return [] if self.foreign else ["fast-run", "deep-run"]

    def request(self, method, route, body=None, allowed=(200,)):
        if method == "POST":
            self.mutations.append((route, copy.deepcopy(body)))
        if route == "/messages":
            return 202, dict(status="accepted", message_id="message", event_id="event", sequence=1)
        if route == "/window" and method == "GET":
            return 204, None
        if route == "/window":
            if self.busy:
                return 409, {"error": "window_busy"}
            self.saved_window = dict(body, status=dict(conversation_id=self.conversation, state="active", generation=1,
                                                       window_id="window", predecessor_window_id=None))
            return 201, self.saved_window
        if route in ("/execution", "/fast/execution"):
            role = "fast" if route.startswith("/fast") else "deep"
            return 200, dict(run_id=role + "-run", revision=len(self.accepted) + 10,
                phase="completed" if role in self.accepted else "awaiting_acceptance",
                acceptance_candidate=dict(run_id=role + "-run", completion_event_id=role + "-completion"),
                progress=dict(payload_id=role + "-payload"))
        if route.startswith("/payloads/"):
            role = "fast" if "fast" in route else "deep"
            return 200, dict(run_id=role + "-run", payload_id=role + "-payload", text=role + " result")
        if route == "/accept":
            role = body["run_id"].split("-")[0]
            receipt = self.accepted.setdefault(role, dict(body, requested_revision=body["expected_revision"],
                revision=body["expected_revision"] + 1, outcome="succeeded", acceptance_event_id=role + "-accepted"))
            if role == "deep" and self.lose_deep_response:
                self.lose_deep_response = False
                raise ConnectionError("synthetic lost commit response")
            return 200, receipt
        if route.startswith("/accepted-results?"):
            return 200, dict(results=[dict(run_id=role + "-run", completion_event_id=role + "-completion",
                acceptance_event_id=role + "-accepted", payload_id=role + "-payload", payload_removed=False)
                for role in self.accepted], next_after_sequence=None)
        raise AssertionError(route)


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ledger = Ledger(Path(self.temp.name) / "ledger.sqlite3", {"test_scope": "one"})
        self.data, _ = self.ledger.enqueue(dict(publicMessageId="public", publicThreadId="thread", chatId="chat", accountId="account", text="request"))
        self.peer = Peer()
        self.worker = Worker(self.peer, self.ledger)

    def test_only_accepted_deep_is_exported(self):
        self.worker.step(self.data)
        self.assertEqual(self.data["phase"], "completed")
        messages = self.ledger.messages()
        self.assertEqual(messages[-1]["text"], "deep result")
        self.assertEqual(messages[-1]["id"], "deep-accepted")
        self.assertEqual(messages[-1]["parentMessageId"], self.data["remote_id"])
        self.assertEqual(len(self.peer.accepted), 2)
        self.assertNotIn("fast result", str(messages))

    def test_lost_acceptance_response_replays_exact_persisted_key(self):
        self.peer.lose_deep_response = True
        with self.assertRaises(ConnectionError):
            self.worker.step(self.data)
        resumed = self.ledger.next_input()
        self.assertNotIn("reply", resumed)
        self.worker.step(resumed)
        deep_calls = [body for route, body in self.peer.mutations if route == "/accept" and body["run_id"] == "deep-run"]
        self.assertEqual(len(deep_calls), 2)
        self.assertEqual(deep_calls[0], deep_calls[1])
        self.assertEqual(len(self.peer.accepted), 2)
        self.assertEqual(len([m for m in self.ledger.messages() if m["role"] == "assistant"]), 1)

    def test_active_second_generation_retains_original_predecessor(self):
        current = dict(conversation_id="conversation", state="active", generation=2,
                       window_id="second-window", predecessor_window_id="first-window")
        original = self.peer.request
        def request(method, route, **kwargs):
            if route == "/window" and method == "GET":
                return 200, current
            if route == "/window" and method == "POST":
                self.peer.mutations.append((route, copy.deepcopy(kwargs["body"])))
                return 200, dict(kwargs["body"], status=current)
            return original(method, route, **kwargs)
        self.peer.request = request
        def window_request(intake, input_key, request_key, observed):
            self.assertEqual(observed, current)
            return dict(request_key=request_key, input_message_id=intake["message_id"], input_event_id=intake["event_id"],
                        input_request_key=input_key, expected_generation=2, window_id="second-window", predecessor_window_id=None)
        self.peer.window_request = window_request
        self.worker.step(self.data)
        self.assertEqual(self.data["phase"], "completed")

    def test_foreign_status_without_source_evidence_never_accepts(self):
        self.peer.foreign = True
        self.worker.step(self.data)
        self.assertEqual(self.peer.accepted, {})
        self.assertNotIn("reply", self.data)

    def test_busy_window_is_retained_and_retried_without_forced_stop(self):
        self.peer.busy = True
        self.worker.step(self.data)
        self.assertEqual(self.data["phase"], "waiting_for_window")
        self.peer.busy = False
        self.worker.step(self.ledger.next_input())
        attempts = [body for route, body in self.peer.mutations if route == "/window"]
        self.assertEqual(attempts[0], attempts[1])
        self.assertFalse(any("stop" in route for route, _ in self.peer.mutations))

    def test_lost_intake_and_window_responses_keep_exact_mutation_keys(self):
        for dropped in ("/messages", "/window"):
            with self.subTest(route=dropped):
                data, _ = self.ledger.enqueue(dict(publicMessageId=dropped, publicThreadId="thread", chatId="chat", accountId="account", text="request"))
                peer = Peer()
                worker = Worker(peer, self.ledger)
                original = peer.request
                lost = [False]
                def request(method, route, **kwargs):
                    response = original(method, route, **kwargs)
                    if method == "POST" and route == dropped and not lost[0]:
                        lost[0] = True
                        raise ConnectionError("synthetic lost response")
                    return response
                peer.request = request
                with self.assertRaises(ConnectionError):
                    worker.step(data)
                # Read that exact row through a new SQLite connection, as on restart.
                import json
                with self.ledger.connect() as db:
                    resumed = json.loads(db.execute("SELECT data FROM inputs WHERE remote_id=?", (data["remote_id"],)).fetchone()[0])
                worker.step(resumed)
                attempts = [body for route, body in peer.mutations if route == dropped]
                self.assertEqual(len(attempts), 2)
                self.assertEqual(attempts[0], attempts[1])
                self.assertEqual(resumed["phase"], "completed")

    def test_terminal_and_definite_upstream_refusals_are_visible_and_do_not_retry(self):
        class Stop:
            def __init__(self):
                self.calls = 0
            def wait(self, duration):
                self.calls += 1
                return self.calls > 2
        for failure in ("cancelled", "blocked", "session_revoked"):
            with self.subTest(failure=failure):
                # Each subtest uses a separate ledger so the first blocked row
                # intentionally cannot hide a later test's input.
                ledger = Ledger(Path(self.temp.name) / (failure + ".sqlite3"), {"test_scope": "one"})
                ledger.enqueue(dict(publicMessageId="public", publicThreadId="thread", chatId="chat", accountId="account", text="request"))
                peer = Peer()
                original = peer.request
                def request(method, route, **kwargs):
                    if route == "/execution":
                        if failure == "session_revoked":
                            raise ClientError("session_revoked", 401)
                        return 200, dict(run_id="deep-run", phase=failure)
                    return original(method, route, **kwargs)
                peer.request = request
                Worker(peer, ledger).run(Stop())
                blocked = ledger.next_input()
                self.assertEqual(blocked["phase"], "blocked")
                self.assertTrue(blocked["blocked"])
                self.assertNotIn("reply", blocked)
                self.assertFalse(any(route == "/accept" for route, _ in peer.mutations))

    def test_mismatched_canonical_history_cannot_be_mirrored(self):
        original = self.peer.request
        def corrupt(method, route, **kwargs):
            if route.startswith("/accepted-results?"):
                return 200, {"results": [], "next_after_sequence": None}
            return original(method, route, **kwargs)
        self.peer.request = corrupt
        with self.assertRaisesRegex(Refused, "accepted_history_mismatch"):
            self.worker.step(self.data)
        self.assertNotIn("reply", self.ledger.next_input())


if __name__ == "__main__":
    unittest.main()
