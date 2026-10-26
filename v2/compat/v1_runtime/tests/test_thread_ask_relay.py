"""A returned thread-ask answer's follow-up turn is exported to the group once."""
from pathlib import Path

from v2.compat.v1_runtime.ledger import Ledger
from v2.compat.v1_runtime.worker import Worker
from v2.compat.v1_runtime import thread_ask_relay
from v2.compat.v1_runtime.tests.test_timer_relay import SCOPE, Base, _Stop
from v2.compat.v1_runtime.tests.test_web_mirror import WebPeer

REPLY = "b2000000-0000-4000-8000-000000000001"
EVENT = "b2000000-0000-4000-8000-0000000000e1"
ASK = "b2000000-0000-4000-8000-0000000000a1"
LABEL = "\U0001f5a5️ (web)"


def reply_row(sequence=21, message=REPLY, event=EVENT):
    return {"sequence": sequence, "message_id": message, "event_id": event, "ask_id": ASK,
            "target_name": "Hosting", "state": "answered"}


class AskPeer(WebPeer):
    def __init__(self):
        super().__init__()
        self.asks, self.asks_last, self.asks_route = [], 20, True

    def matching_run_ids(self, events, intake):
        if intake.get("event_id") == EVENT:
            return list(self.runs.get(intake["message_id"], []))
        return super().matching_run_ids(events, intake)

    def request(self, method, route, body=None, allowed=(200,)):
        if method == "GET" and route.startswith("/thread-ask-inputs?"):
            self.reads.append((method, route))
            if not self.asks_route:
                return 404, {"code": "not_found"}
            after = int(route.split("after_sequence=")[1].split("&")[0])
            rows = [dict(r) for r in self.asks if r["sequence"] > after]
            return 200, {"inputs": rows[:20], "last_sequence": self.asks_last}
        return super().request(method, route, body, allowed)


class ThreadAskRelayTests(Base):
    def setUp(self):
        super().setUp()
        self.peer = AskPeer()
        self.worker = Worker(self.peer, self.ledger)

    def scan(self):
        self.worker._web_checked = None
        self.worker.run_once(_Stop())

    def replies(self):
        return [m for m in self.ledger.messages() if m["role"] == "assistant"]

    def test_first_scan_records_position_and_older_answers_are_not_replayed(self):
        self.peer.asks = [reply_row(sequence=19)]
        self.scan()
        self.assertEqual(thread_ask_relay._cursor(self.ledger), 20)
        self.assertEqual(self.ledger.web_watches(), [])
        self.assertEqual(self.ledger.messages(), [])

    def test_follow_up_turn_answer_is_exported_once_without_mirroring_the_input(self):
        thread_ask_relay._set_cursor(self.ledger, 20)
        self.peer.asks = [reply_row()]
        self.peer.runs[REPLY] = ["deep-reply"]
        self.peer.deep["deep-reply"] = "running"
        self.scan()
        self.assertEqual(self.ledger.messages(), [], "the other agent's answer itself is not posted")
        watch, = self.ledger.web_watches()
        self.assertEqual((watch["message_id"], watch["event_id"], watch["thread_ask"]), (REPLY, EVENT, ASK))
        self.peer.answer("deep-reply", "Hosting confirmed Bedrock in eu-central-1; continuing.")
        self.scan()
        reply, = self.replies()
        self.assertEqual(reply["text"], "Hosting confirmed Bedrock in eu-central-1; continuing.")
        user = next(m for m in self.ledger.messages() if m["id"] == reply["parentMessageId"])
        self.assertEqual(user["text"], "↩ from Hosting")
        self.assertEqual(self.ledger.web_watches(), [])
        # Replays (lost cursor write, restart) adopt nothing new.
        thread_ask_relay._set_cursor(self.ledger, 20)
        restarted = Worker(self.peer, Ledger(Path(self.temp.name) / "ledger.sqlite3", SCOPE))
        restarted._web_checked = None
        restarted.run_once(_Stop())
        self.assertEqual(len(self.replies()), 1)
        # The adapter never opens a window, accepts a run or posts a message.
        self.assertEqual([r for r, _ in self.peer.mutations if r in ("/window", "/accept", "/messages")], [])

    def test_older_server_and_malformed_rows_change_nothing(self):
        thread_ask_relay._set_cursor(self.ledger, 20)
        self.peer.asks_route = False
        self.scan()
        self.assertEqual(self.ledger.web_watches(), [])
        self.peer.asks_route = True
        self.peer.asks = [dict(reply_row(), message_id="not-a-uuid"), reply_row(sequence=22)]
        self.assertEqual(thread_ask_relay.discover(self.worker), 0)
        self.assertEqual(thread_ask_relay._cursor(self.ledger), 20)


class VerifiedAuthorTests(Base):
    """Core lets only owner-authored turns ask another thread; the adapter
    states the author it verified with each admitted chat input."""

    def test_admitted_inputs_carry_the_verified_author(self):
        from v2.compat.v1_runtime.intake import verified_author
        self.assertEqual(verified_author({"author": {"role": "owner", "id": "o"}}), "owner")
        self.assertEqual(verified_author({"author": {"role": "member", "id": "m"}}), "member")
        self.assertEqual(verified_author({"author": {"role": "v1_agent", "id": "a"}}), "v1_agent")
        self.assertIsNone(verified_author({"origin": "timer", "author": {"role": "owner"}}))
        self.assertIsNone(verified_author({"author": {"role": "someone"}}))
        self.assertIsNone(verified_author({}))

    def post_owner_message(self, features):
        peer = AskPeer()
        if features is not None:
            peer.features = frozenset(features)
        worker = Worker(peer, self.ledger)
        self.ledger.enqueue({"publicThreadId": "v1-thread", "publicMessageId": "wa-1", "chatId": "chat@g.us",
                             "accountId": "account", "text": "ask hosting for the Bedrock region"},
                            author={"role": "owner", "id": "owner@c.us", "label": "Owner"})
        worker.step(self.ledger.next_input())
        return [body for route, body in peer.mutations if route == "/messages"][0]

    def test_owner_message_carries_author_only_where_the_server_accepts_it(self):
        self.assertEqual(self.post_owner_message({"message_author"})["author"], "owner")

    def test_older_server_without_the_feature_gets_no_author_field(self):
        self.assertNotIn("author", self.post_owner_message(set()))

    def test_client_without_features_gets_no_author_field(self):
        self.assertNotIn("author", self.post_owner_message(None))


if __name__ == "__main__":
    import unittest
    unittest.main()
