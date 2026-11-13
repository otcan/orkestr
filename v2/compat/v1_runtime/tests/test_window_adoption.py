"""A continuation Core admitted under its own intent is watched, never frozen.

Release continuations are admitted with their source run; Core queues its own
window intent for exactly that input and can dispatch it before the adapter's
own request arrives, which Core then refuses (409 window_fenced). The input
must settle from Core's run instead of holding the chat's queue for good.
"""
import copy
import json
import unittest

from v2.compat.v1_runtime import window_adoption
from v2.compat.v1_runtime.rust_client import ClientError
from v2.compat.v1_runtime.tests import test_refusals as fixture


class WindowAdoptionTests(unittest.TestCase):
    def setUp(self):
        self.f = fixture.RefusalTests("run")
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.f.ledger.enqueue(fixture.body("first"))
        self.mode, self.current, self.posts = "unknown", None, []
        original = self.f.peer.request

        def request(method, route, body=None, allowed=(200,)):
            if route == "/window" and method == "GET" and self.current is not None:
                return 200, copy.deepcopy(self.current)
            if method == "POST" and route == "/window":
                self.posts.append(copy.deepcopy(body))
                if self.mode == "unknown":
                    raise ClientError("unexpected_status", 503)
                if self.mode == "window_fenced":
                    return 409, {"error": {"code": "window_fenced"}}
            return original(method, route, body=body, allowed=allowed)

        self.f.peer.request = request
        # The first pass admits the input and freezes its window request.
        self.f.worker.run_once(fixture.Stop())
        self.frozen = self.row("first")["window_request"]

    def row(self, public):
        with self.f.ledger.connect() as db:
            return json.loads(db.execute("SELECT data FROM inputs WHERE public_id=?", (public,)).fetchone()[0])

    def continued(self, public="first"):
        data = self.row(public)
        data["continued"] = {"previous_message_id": "previous", "at": 1.0, "cause": "release"}
        self.f.ledger.save(data)

    def core_window(self, message="message", event="event"):
        # Core's current window, opened for one exact input.
        self.current = dict(window_id="core-window", conversation_id=self.f.peer.conversation, generation=2,
                            state="active", input_message_id=message, input_event_id=event,
                            predecessor_window_id="old-window", work_deadline_ms=2**52)

    def messages(self):
        return [body for route, body in self.f.peer.mutations if route == "/messages"]

    def test_continuation_in_cores_own_window_is_watched_and_settles(self):
        self.continued()
        self.core_window()
        self.f.peer.foreign = True  # Proof from the window alone, no journal run yet.
        self.mode = "window_fenced"
        self.f.worker.run_once(fixture.Stop())
        row = self.row("first")
        self.assertNotIn("window_refusal", row)
        self.assertEqual(row["window"], {"dispatched_by": window_adoption.DISPATCHED_BY, "window_id": "core-window"})
        self.assertEqual(row["window_adopted"]["evidence"], "window")
        # The frozen request is kept as it was; nothing new was minted or retired.
        self.assertEqual(row["window_request"], self.frozen)
        self.assertEqual(len(self.messages()), 1)
        self.assertFalse(any(route.endswith("/retire") for route, _ in self.f.peer.mutations))
        # Core's run of exactly this input then settles it the ordinary way.
        self.f.peer.foreign = False
        self.f.worker.run_once(fixture.Stop())
        self.assertEqual(self.row("first")["phase"], "completed")
        self.assertEqual(self.f.ledger.messages()[-1]["text"], "deep result")

    def test_continuation_with_a_run_in_cores_journal_is_watched(self):
        # Core already ran it and moved on: its journal shows the input's run.
        self.continued()
        self.mode = "window_fenced"
        self.f.worker.run_once(fixture.Stop())
        row = self.row("first")
        self.assertNotIn("window_refusal", row)
        self.assertEqual(row["window_adopted"]["evidence"], "run")
        self.assertIsNone(row["window"]["window_id"])
        self.assertEqual(self.posts, [self.frozen] * 2)

    def test_continuation_without_cores_proof_stays_frozen(self):
        self.continued()
        self.core_window(message="another-message", event="another-event")
        self.f.peer.foreign = True
        self.mode = "window_fenced"
        for _ in range(2):
            self.f.worker.run_once(fixture.Stop())
        row = self.row("first")
        self.assertEqual(row["phase"], "admitted")
        self.assertEqual(row["window_refusal"]["code"], "window_fenced")
        self.assertNotIn("window", row)
        self.assertEqual(self.posts, [self.frozen] * 3)

    def test_ordinary_input_keeps_the_stale_request_meaning(self):
        # Only continuations get a Core-owned intent; for any other input a
        # matching window is no proof that this request was the admitted one.
        self.core_window()
        self.mode = "window_fenced"
        self.f.worker.run_once(fixture.Stop())
        row = self.row("first")
        self.assertEqual(row["phase"], "admitted")
        self.assertIn("window_refusal", row)
        self.assertNotIn("window", row)


if __name__ == "__main__":
    unittest.main()
