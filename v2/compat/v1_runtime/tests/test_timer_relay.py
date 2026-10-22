"""V2 timer occurrences in a bound conversation are relayed like ordinary replies."""
from pathlib import Path
import tempfile
import unittest

from v2.compat.v1_runtime.ledger import Conflict, Ledger
from v2.compat.v1_runtime.rust_client import ClientError
from v2.compat.v1_runtime.worker import Refused, Worker
from v2.compat.v1_runtime.tests.test_worker import Peer

SCOPE = {"public_thread_id": "v1-thread", "chat_id": "chat@g.us", "account_id": "account", "conversation_id": "conversation"}


def occurrence(sequence, window="dispatched", held=False, label="Morning brief"):
    return {"namespace": "11111111-1111-4111-8111-111111111111", "claim_id": "c%07d-0000-4000-8000-000000000000" % sequence,
            "generation": 1, "due_ms": 1_800_000_000_000, "message_id": "m%07d-0000-4000-8000-000000000000" % sequence,
            "event_id": "e%07d-0000-4000-8000-000000000000" % sequence, "sequence": sequence,
            "request_key": "timer:c%07d-0000-4000-8000-000000000000" % sequence, "label": label,
            "source_timer_id": "305d54e89718", "held": held, "window": window}


class TimerPeer(Peer):
    def __init__(self):
        super().__init__()
        self.timer_rows, self.reads = [], []
        self.digests, self.acked = [], []
        self.posts, self.posts_acked = [], []

    def matching_run_ids(self, events, intake):
        return ["fast-run", "deep-run"]

    def request(self, method, route, body=None, allowed=(200,)):
        self.reads.append((method, route))
        if route.startswith("/timer-inputs?"):
            query = dict(part.split("=") for part in route.split("?", 1)[1].split("&"))
            after, limit = int(query["after_sequence"]), int(query["limit"])
            rows = [dict(r) for r in self.timer_rows if r["sequence"] > after][:limit]
            return 200, {"conversation_id": self.conversation, "inputs": rows}
        if route == "/messages":
            raise AssertionError("a timer occurrence is already admitted; it is never re-sent")
        if route.startswith("/timer-digests?"):
            return 200, {"conversation_id": self.conversation, "digests": [dict(d) for d in self.digests if d["id"] not in self.acked]}
        if route.startswith("/posts?"):
            return 200, {"conversation_id": self.conversation, "posts": [dict(p) for p in self.posts if p["id"] not in self.posts_acked]}
        if route.startswith("/posts/"):
            self.posts_acked.append(route.split("/")[2])
            return 200, {"id": route.split("/")[2], "delivered_ms": 1}
        if route.startswith("/timer-digests/"):
            self.acked.append(route.split("/")[2])
            return 200, {"delivered": True}
        return super().request(method, route, body, allowed)


class Base(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ledger = Ledger(Path(self.temp.name) / "ledger.sqlite3", SCOPE)
        self.peer = TimerPeer()
        self.worker = Worker(self.peer, self.ledger)


class TimerRelayTests(Base):

    def test_first_scan_records_position_without_backfill(self):
        self.peer.timer_rows = [occurrence(3), occurrence(5)]
        self.worker.discover_timers()
        self.assertEqual(self.ledger.timer_cursor(), 5)
        self.assertIsNone(self.ledger.next_input())
        self.peer.timer_rows += [occurrence(8, held=True), occurrence(9)]
        self.worker.discover_timers()
        self.worker.discover_timers()
        self.assertEqual(self.ledger.timer_cursor(), 9)
        rows = [m for m in self.ledger.messages() if m["role"] == "user"]
        self.assertEqual(len(rows), 1, "held occurrence skipped, replay idempotent")
        self.assertEqual(rows[0]["publicMessageId"], "v2timer-" + rows[0]["id"])
        self.assertEqual(rows[0]["source"], "orkestr-v2-timer")
        self.assertEqual(rows[0]["origin"], "timer")
        self.assertEqual((rows[0]["publicThreadId"], rows[0]["chatId"], rows[0]["accountId"]),
                         ("v1-thread", "chat@g.us", "account"))
        self.assertEqual(rows[0]["timerSourceId"], "305d54e89718")
        self.assertNotIn("postAuthor", rows[0])
        self.assertEqual(rows[0]["text"], "Scheduled timer: Morning brief")

    def test_changed_occurrence_identity_conflicts(self):
        self.ledger.enqueue_timer(occurrence(4))
        changed = occurrence(4)
        changed["event_id"] = "e9999999-0000-4000-8000-000000000000"
        with self.assertRaises(Conflict):
            self.ledger.enqueue_timer(changed)

    def test_server_dispatched_turn_is_accepted_exported_and_settled_by_v1_ack(self):
        self.ledger.set_timer_cursor(0)
        self.peer.timer_rows = [occurrence(2)]
        self.worker.run_once(_Stop())
        data = self.ledger.next_input()
        self.assertIsNone(data, "completed in one pass")
        posted = [route for route, _ in self.peer.mutations]
        self.assertNotIn("/window", posted, "server already dispatched the window")
        self.assertEqual(posted.count("/accept"), 2)
        messages = self.ledger.messages()
        user, reply = messages[0], messages[-1]
        self.assertEqual(reply["parentMessageId"], user["id"])
        self.assertEqual(reply["text"], "deep result")
        result = self.ledger.acknowledge(reply["id"], {"outcome": "delivered", "outboxJobId": "job",
                                                       "parentPublicMessageId": user["publicMessageId"]})
        self.assertTrue(result["settled"])
        self.assertEqual(self.ledger.messages(), [])

    def test_queued_turn_waits_and_keeps_dispatcher_session_fresh(self):
        self.ledger.set_timer_cursor(0)
        self.peer.timer_rows = [occurrence(2, window="queued")]
        self.worker.run_once(_Stop())
        data = self.ledger.next_input()
        self.assertEqual(data["phase"], "waiting_for_timer_dispatch")
        self.assertIn(("GET", "/window"), self.peer.reads)
        self.assertEqual(self.peer.mutations, [])
        self.peer.timer_rows[0]["window"] = "dispatched"
        self.worker.run_once(_Stop())
        self.assertIsNone(self.ledger.next_input())

    def test_withdrawn_turn_opens_its_window_with_the_timer_input_key(self):
        self.ledger.set_timer_cursor(0)
        self.peer.timer_rows = [occurrence(2, window="withdrawn")]
        self.worker.run_once(_Stop())
        windows = [body for route, body in self.peer.mutations if route == "/window"]
        self.assertEqual(len(windows), 1)
        self.assertEqual(windows[0]["input_request_key"], occurrence(2)["request_key"])
        self.assertEqual(windows[0]["input_message_id"], occurrence(2)["message_id"])
        self.assertIsNone(self.ledger.next_input())

    def test_held_before_running_finishes_without_any_export(self):
        self.ledger.set_timer_cursor(0)
        self.peer.timer_rows = [occurrence(2, window="queued")]
        self.worker.run_once(_Stop())
        self.peer.timer_rows[0]["held"] = True
        self.worker.run_once(_Stop())
        self.assertIsNone(self.ledger.next_input())
        self.assertEqual(self.ledger.messages(), [])
        self.assertEqual(self.peer.mutations, [])

    def test_mismatched_server_record_blocks_for_review(self):
        self.ledger.set_timer_cursor(0)
        self.peer.timer_rows = [occurrence(2)]
        self.worker.discover_timers()
        self.peer.timer_rows[0]["event_id"] = "e8888888-0000-4000-8000-000000000000"
        data = self.ledger.next_input()
        with self.assertRaises(Refused):
            self.worker.step(data)


class SilentTimerTests(Base):
    """Rust classifies each timer answer; silent ones are acknowledged as no_reply."""

    def run_occurrence(self, deliver, summary="x"):
        self.peer.outcome = lambda body: {"outcome": "delivered" if deliver else "silent", "deliver": deliver,
                                          "summary": summary, "replay": False}
        self.ledger.set_timer_cursor(0)
        self.peer.timer_rows = [occurrence(2)]
        self.worker.run_once(_Stop())
        return [m for m in self.ledger.messages() if m["role"] == "assistant"]

    def test_silent_answer_is_exported_as_no_reply_and_reports_the_raw_text(self):
        replies = self.run_occurrence(False)
        self.assertEqual(len(replies), 1)
        self.assertTrue(replies[0]["noReply"])
        self.assertEqual(replies[0]["text"], "NO_REPLY")
        self.assertEqual(self.peer.outcomes, [{"claim_id": occurrence(2)["claim_id"], "text": "deep result"}])
        user = [m for m in self.ledger.messages() if m["role"] == "user"][0]
        result = self.ledger.acknowledge(replies[0]["id"], {"outcome": "no_reply", "parentPublicMessageId": user["publicMessageId"]})
        self.assertTrue(result["settled"])

    def test_answer_with_news_is_delivered_normally(self):
        replies = self.run_occurrence(True)
        self.assertEqual(replies[0]["text"], "deep result")
        self.assertNotIn("noReply", replies[0])

    def test_server_without_the_route_keeps_the_ordinary_reply_rules(self):
        self.ledger.set_timer_cursor(0)
        self.peer.timer_rows = [occurrence(2)]
        self.worker.run_once(_Stop())
        replies = [m for m in self.ledger.messages() if m["role"] == "assistant"]
        self.assertEqual(replies[0]["text"], "deep result")

    def test_malformed_outcome_is_refused_not_guessed(self):
        self.peer.outcome = lambda body: {"deliver": "yes"}
        self.ledger.set_timer_cursor(0)
        self.peer.timer_rows = [occurrence(2)]
        self.worker.run_once(_Stop())
        replies = [m for m in self.ledger.messages() if m["role"] == "assistant"]
        self.assertEqual(replies[0]["kind"], "notice")


class DigestTests(Base):
    def digest(self, text="Digest: Jobs - 3 quiet runs since the last digest."):
        return {"id": "d0000000-0000-4000-8000-000000000001", "namespace": occurrence(1)["namespace"],
                "slot_ms": 1_800_000_000_000, "text": text, "item_count": 3}

    def test_digest_is_adopted_acknowledged_and_exported_once(self):
        self.peer.digests = [self.digest()]
        self.worker.run_once(_Stop())
        self.assertEqual(self.peer.acked, ["d0000000-0000-4000-8000-000000000001"])
        messages = self.ledger.messages()
        user, reply = messages[0], messages[-1]
        self.assertEqual((user["role"], user["origin"]), ("user", "timer"))
        self.assertEqual(reply["text"], "Digest: Jobs - 3 quiet runs since the last digest.")
        self.assertEqual(reply["parentMessageId"], user["id"])
        # A replay (lost acknowledgement) adopts nothing new.
        self.peer.acked.clear()
        self.worker.run_once(_Stop())
        self.assertEqual(len([m for m in self.ledger.messages() if m["role"] == "assistant"]), 1)
        done = self.ledger.acknowledge(reply["id"], {"outcome": "delivered", "outboxJobId": "job",
                                                     "parentPublicMessageId": user["publicMessageId"]})
        self.assertTrue(done["settled"])
        self.assertEqual(self.ledger.messages(), [])

    def test_digests_are_polled_every_fifteen_seconds_not_every_pass(self):
        self.worker.run_once(_Stop())
        self.worker.run_once(_Stop())
        polls = [r for r in self.peer.reads if r[1].startswith("/timer-digests?")]
        self.assertEqual(len(polls), 1)
        self.worker._digest_checked -= 16
        self.worker.run_once(_Stop())
        self.assertEqual(len([r for r in self.peer.reads if r[1].startswith("/timer-digests?")]), 2)

    def test_changed_digest_identity_conflicts(self):
        self.ledger.enqueue_digest(self.digest())
        with self.assertRaises(Conflict):
            self.ledger.enqueue_digest(self.digest("Something else"))

    def test_digest_honours_reply_settings(self):
        self.peer.reply_settings = dict(prefix="[Orkestr]", footer=None, honor_no_reply=True)
        self.peer.digests = [self.digest()]
        self.worker.run_once(_Stop())
        reply = self.ledger.messages()[-1]
        self.assertTrue(reply["text"].startswith("[Orkestr] Digest"))


class TriggerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ledger = Ledger(Path(self.temp.name) / "ledger.sqlite3", SCOPE)
        self.peer = Peer()
        self.worker = Worker(self.peer, self.ledger)

    def inbound(self, public_id="wa-msg-1"):
        return self.ledger.enqueue({"publicThreadId": "v1-thread", "publicMessageId": public_id, "chatId": "chat@g.us",
                                    "accountId": "account", "text": "hello"})[0]

    def test_inbound_message_fires_one_idempotent_trigger(self):
        data = self.inbound()
        self.worker.fire_trigger(data)
        self.worker.fire_trigger(data)
        self.assertEqual(self.peer.triggers, [{"source": "message", "event_key": "wa-msg-1"}])

    def test_a_normal_step_fires_it_before_running(self):
        data = self.inbound()
        self.worker.step(data)
        self.assertEqual(self.peer.triggers, [{"source": "message", "event_key": "wa-msg-1"}])

    def test_trigger_failure_never_blocks_the_input_and_is_retried(self):
        data = self.inbound()
        original = self.peer.request
        failures = [True]

        def flaky(method, route, body=None, allowed=(200,)):
            if route == "/timer-triggers" and failures:
                failures.pop()
                raise ClientError("unreachable")
            return original(method, route, body, allowed)
        self.peer.request = flaky
        self.worker.fire_trigger(data)
        self.assertFalse(data.get("trigger_sent"))
        self.worker.fire_trigger(data)
        self.assertTrue(data["trigger_sent"])
        self.assertEqual(len(self.peer.triggers), 1)

    def test_timer_and_agent_inputs_do_not_trigger(self):
        timer = self.ledger.enqueue_timer(occurrence(2))[0]
        self.worker.fire_trigger(timer)
        data = self.inbound("agent-1")
        data["author"] = {"role": "v1_agent", "id": "a", "label": "agent"}
        self.worker.fire_trigger(data)
        self.assertEqual(self.peer.triggers, [])


class _Stop:
    def wait(self, _):
        return False


if __name__ == "__main__":
    unittest.main()
