"""Conversation posts are adopted, exported verbatim under a V1-accepted timer parent, and acknowledged."""
from pathlib import Path
import unittest

from v2.compat.v1_runtime.ledger import Conflict, Ledger
from v2.compat.v1_runtime.worker import Refused, Worker
from v2.compat.v1_runtime.tests.test_timer_relay import SCOPE, Base, _Stop

POST_ID = "a0000000-0000-4000-8000-000000000001"


def post(text="Deploy finished.\n\nAll checks green.", provider="claude", model="synthetic-model", **extra):
    row = {"id": POST_ID, "conversation_id": "conversation", "request_key": "coord-1", "author": "coordinator",
           "label": "Coordinator", "provider": provider, "model": model, "text": text, "after_sequence": 4,
           "created_ms": 1_800_000_000_000, "delivered_ms": None}
    row.update(extra)
    return row


class PostTests(Base):
    def test_replayed_post_keeps_its_first_footer_when_model_metadata_changes(self):
        first, existed = self.ledger.enqueue_post(post(), {"provider": "claude", "model": "unreported"})
        self.assertFalse(existed)
        again, existed = self.ledger.enqueue_post(post(), {"provider": "claude", "model": "later-model"})
        self.assertTrue(existed)
        self.assertEqual(first, again)
        self.assertEqual(again["model"], "synthetic-model")
    def test_post_is_adopted_exported_verbatim_and_acknowledged(self):
        self.peer.reply_settings = dict(prefix="[Orkestr]", footer="dbg", honor_no_reply=True)
        self.peer.posts = [post()]
        self.worker.run_once(_Stop())
        self.assertEqual(self.peer.posts_acked, [POST_ID])
        user, reply = self.ledger.messages()
        # The parent is the exact timer shape V1 already materializes.
        self.assertEqual((user["role"], user["origin"], user["source"], user["connector"]),
                         ("user", "timer", "orkestr-v2-timer", "orkestr-v2-timer"))
        self.assertEqual(user["publicMessageId"], "v2timer-" + user["id"])
        self.assertEqual((user["publicThreadId"], user["chatId"], user["accountId"]), ("v1-thread", "chat@g.us", "account"))
        self.assertEqual((user["text"], user["timerSourceId"]), ("Coordinator", "post"))
        # V1 labels the post by its author, not as a timer.
        self.assertEqual(user["postAuthor"], "coordinator")
        # The reply is the post text unchanged (no Rust prefix/footer), with the post's footer fields.
        self.assertEqual(reply["text"], "Deploy finished.\n\nAll checks green.")
        self.assertEqual((reply["role"], reply["phase"], reply["state"]), ("assistant", "final_answer", "completed"))
        self.assertEqual(reply["parentMessageId"], user["id"])
        self.assertEqual((reply["provider"], reply["model"]), ("claude", "synthetic-model"))
        self.assertNotIn(("POST", "/settings/render"), self.peer.reads)
        self.assertIsNone(self.ledger.next_input(), "nothing is queued for Rust")
        done = self.ledger.acknowledge(reply["id"], {"outcome": "delivered", "outboxJobId": "job",
                                                     "parentPublicMessageId": user["publicMessageId"]})
        self.assertTrue(done["settled"])
        self.assertEqual(self.ledger.messages(), [])

    def test_lost_acknowledgement_and_restart_adopt_nothing_new(self):
        self.peer.posts = [post()]
        original = self.peer.request

        def lose_ack(method, route, body=None, allowed=(200,)):
            if route.startswith("/posts/"):
                raise ConnectionError("synthetic lost acknowledgement")
            return original(method, route, body, allowed)
        self.peer.request = lose_ack
        self.worker.run_once(_Stop())
        self.assertEqual(self.peer.posts_acked, [])
        first = self.ledger.messages()
        self.peer.request = original
        restarted = Worker(self.peer, Ledger(Path(self.temp.name) / "ledger.sqlite3", SCOPE))
        restarted.run_once(_Stop())
        self.assertEqual(self.peer.posts_acked, [POST_ID])
        self.assertEqual(self.ledger.messages(), first, "same deterministic ids, one export")

    def test_changed_post_identity_conflicts(self):
        self.ledger.enqueue_post(post())
        with self.assertRaises(Conflict):
            self.ledger.enqueue_post(post(text="Something else"))

    def test_missing_post_identity_never_borrows_the_conversation_provider(self):
        self.peer.settings = {"provider": "codex", "model": "gpt-synthetic"}
        self.peer.posts = [post(provider=None, model=None, author="operator", label="Ops alert")]
        self.worker.run_once(_Stop())
        user, reply = self.ledger.messages()
        self.assertNotIn("provider", reply)
        self.assertNotIn("model", reply)
        self.assertEqual(user["text"], "Ops alert")

    def test_post_waits_for_nothing_behind_a_running_input(self):
        self.ledger.enqueue({"publicThreadId": "v1-thread", "publicMessageId": "wa-1", "chatId": "chat@g.us",
                             "accountId": "account", "text": "long task"})
        self.ledger.enqueue_post(post())
        replies = [m for m in self.ledger.messages() if m["role"] == "assistant"]
        self.assertEqual([r["text"] for r in replies], ["Deploy finished.\n\nAll checks green."])

    def test_bad_shapes_are_refused_and_nothing_is_acknowledged(self):
        for bad in (post(author="owner"), post(text="  "), post(model="bad model"), post(conversation_id="other")):
            self.peer.posts = [bad]
            with self.assertRaises(Refused):
                self.worker.discover_posts()
        self.assertEqual(self.peer.posts_acked, [])
        self.assertEqual(self.ledger.messages(), [])

    def test_posts_are_polled_every_five_seconds_and_not_while_paused(self):
        self.worker.run_once(_Stop())
        self.worker.run_once(_Stop())
        polls = lambda: len([r for r in self.peer.reads if r[1].startswith("/posts?")])
        self.assertEqual(polls(), 1)
        self.worker._posts_checked -= 6
        self.worker.run_once(_Stop())
        self.assertEqual(polls(), 2)
        self.peer.posts = [post()]
        stops = iter([False, False, True])

        class Once:
            def wait(self, _):
                return next(stops)
        self.worker._posts_checked = None
        self.worker.run(Once(), active=lambda: False)
        self.assertEqual(polls(), 2, "a paused binding leaves posts pending in Rust")
        self.assertEqual(self.peer.posts_acked, [])


if __name__ == "__main__":
    unittest.main()
