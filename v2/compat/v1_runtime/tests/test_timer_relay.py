"""V2 timer occurrences in a bound conversation are relayed like ordinary replies."""
from pathlib import Path
import tempfile
import unittest

from v2.compat.v1_runtime.ledger import Conflict, Ledger
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
        return super().request(method, route, body, allowed)


class TimerRelayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ledger = Ledger(Path(self.temp.name) / "ledger.sqlite3", SCOPE)
        self.peer = TimerPeer()
        self.worker = Worker(self.peer, self.ledger)

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


class _Stop:
    def wait(self, _):
        return False


if __name__ == "__main__":
    unittest.main()
