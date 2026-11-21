"""The owner's terminal holds the chat: one notice per hold, and no ageing."""
from pathlib import Path
import tempfile
import unittest

from v2.compat.v1_runtime import native_attach
from v2.compat.v1_runtime.ledger import Ledger
from v2.compat.v1_runtime.rust_client import ClientError


class Client:
    conversation = "conversation"


class FakeWorker:
    """Just what native_attach reads: the ledger, Core's hold route, labels."""

    def __init__(self, ledger, hold=None):
        self.ledger, self.client, self.hold, self.reads = ledger, Client(), hold, 0
        self.deep_heartbeat, self.owner_label = True, None

    def call(self, method, route, body=None, allowed=(200,)):
        assert (method, route) == ("GET", "/native-attach")
        self.reads += 1
        if self.hold == "missing":
            raise ClientError("not_found", 404)  # An older or unconfigured Core.
        if self.hold == "down":
            raise ClientError("unavailable", 503)
        return self.hold or {"conversation_id": "conversation", "held": False}


HOLD = {"conversation_id": "conversation", "held": True, "native_session_id": "native-1", "acquired_at_ms": 1000}


class NativeAttachTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.ledger = Ledger(Path(temp.name) / "ledger.sqlite3", dict(public_thread_id="thread", chat_id="chat", account_id="account"))

    def enqueue(self, message_id, phase="waiting_for_window_dispatch", **extra):
        data = self.ledger.enqueue(dict(publicMessageId=message_id, publicThreadId="thread", chatId="chat",
                                        accountId="account", text="hello there"))[0]
        data.update(author={"role": "owner", "id": "owner", "label": "Owner"}, phase=phase, queued_at=1, **extra)
        self.ledger.save(data)
        return data

    def notices(self):
        return [m for m in self.ledger.messages() if m.get("activityNotice")]

    def test_one_notice_per_hold_never_one_per_message(self):
        worker = FakeWorker(self.ledger, HOLD)
        self.enqueue("m1")
        self.assertTrue(native_attach.drive(worker, now=100))
        self.enqueue("m2", phase="queued")
        self.assertFalse(native_attach.drive(worker, now=200))
        self.assertFalse(native_attach.drive(worker, now=300))
        self.assertEqual(len(self.notices()), 1)
        self.assertIn("The owner is working in this chat's terminal", self.notices()[0]["text"])
        # A later hold (a new terminal session) gets its own single line.
        worker.hold = dict(HOLD, acquired_at_ms=5000)
        self.assertTrue(native_attach.drive(worker, now=400))
        self.assertEqual(len(self.notices()), 2)

    def test_named_owner_and_no_notice_without_a_hold_or_a_waiting_person(self):
        worker = FakeWorker(self.ledger, None)
        self.enqueue("m1")
        self.assertFalse(native_attach.drive(worker, now=100))
        worker.hold = "missing"
        self.assertFalse(native_attach.drive(worker, now=200))
        self.assertEqual(self.notices(), [])
        other = FakeWorker(self.ledger, HOLD)
        other.owner_label = "Can"
        timer = self.enqueue("t1", origin="timer")
        self.assertIsNotNone(timer)
        self.assertTrue(native_attach.drive(other, now=300))
        self.assertTrue(self.notices()[0]["text"].endswith("as soon as they are done."))
        self.assertIn("Can is working in this chat's terminal", self.notices()[0]["text"])

    def test_a_failed_read_is_unknown_never_ages_inputs_and_posts_nothing(self):
        worker = FakeWorker(self.ledger, "down")
        self.enqueue("m1")
        self.assertIs(native_attach.read_hold(worker, now=100), native_attach.UNKNOWN)
        self.assertTrue(native_attach.held(worker, now=100), "unknown counts as held for ageing")
        self.assertFalse(native_attach.drive(worker, now=100))
        self.assertEqual(self.notices(), [])
        worker.hold = "missing"
        self.assertFalse(native_attach.held(worker, now=100 + native_attach.CHECK_S), "404 is not held")

    def test_the_hold_read_is_cached(self):
        worker = FakeWorker(self.ledger, HOLD)
        self.assertTrue(native_attach.held(worker, now=100))
        self.assertTrue(native_attach.held(worker, now=110))
        self.assertEqual(worker.reads, 1)
        worker.hold = None
        self.assertFalse(native_attach.held(worker, now=100 + native_attach.CHECK_S))
        self.assertEqual(worker.reads, 2)

    def test_inputs_do_not_age_while_held_and_their_clock_restarts_afterwards(self):
        data = self.enqueue("m1", phase="queued")
        self.assertEqual(self.ledger.expire_stale(60, now=1000, held=True), [])
        self.assertEqual(self.ledger.expire_stale(60, now=2000, held=True), [])
        # Released at 2000: the full max age runs from the last held stamp.
        self.assertEqual(self.ledger.expire_stale(60, now=2050), [])
        expired = self.ledger.expire_stale(60, now=2061)
        self.assertEqual([row["remote_id"] for row in expired], [data["remote_id"]])


if __name__ == "__main__":
    unittest.main()
