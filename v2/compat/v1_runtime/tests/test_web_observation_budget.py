"""Caught-up web watches must not stall the accepted foreground reply."""
import contextlib
import unittest
from unittest.mock import patch

from v2.compat.v1_runtime import worker as worker_module
from v2.compat.v1_runtime.tests.test_timer_relay import Base, _Stop
from v2.compat.v1_runtime.tests.test_web_mirror import WebPeer, row
from v2.compat.v1_runtime.tests.test_worker import Peer
from v2.compat.v1_runtime.worker import Worker


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class WaitingPeer(WebPeer):
    def __init__(self, clock):
        super().__init__()
        self.clock, self.waits = clock, []

    def read_events(self, after, maximum, timeout_s=None):
        # The foreground has already produced its real protocol events. All
        # web cursors are caught up: model the HTTP reader's actual wait.
        if after < 3:
            return Peer.read_events(self, after, maximum)
        wait = 5 if timeout_s is None else timeout_s
        self.waits.append(wait)
        self.clock.now += wait
        return []


class WebObservationBudgetTests(Base):
    def setUp(self):
        super().setUp()
        self.clock = Clock()
        self.peer = WaitingPeer(self.clock)
        self.worker = Worker(self.peer, self.ledger, legacy_companions=True)

    def watches(self, count=8):
        for i in range(count):
            value = row(message_id="web-input-" + str(i), sequence=11 + i)
            self.ledger.await_internal_context(value)
            watch = self.ledger.web_watches(8)[-1]
            watch.update(event_id="ev-" + value["message_id"], cursor=value["sequence"])
            self.ledger.save_web_watch(watch)
        self.ledger.set_web_cursor(18)

    def clocks(self):
        stack = contextlib.ExitStack()
        stack.enter_context(patch.object(worker_module.time, "monotonic", self.clock))
        stack.enter_context(patch.object(worker_module.time, "time", self.clock))
        return stack

    def test_eight_idle_watches_do_not_hold_the_canonical_head_final(self):
        with self.clocks():
            self.watches()
            self.ledger.enqueue(dict(publicMessageId="owner-input", publicThreadId="v1-thread",
                                     chatId="chat@g.us", accountId="account", text="Current task"))
            started = self.clock.now
            self.worker.run_once(_Stop())
            self.assertLess(self.clock.now - started, 15)
            replies = [m for m in self.ledger.messages() if m["role"] == "assistant"]
            self.assertEqual([(m["id"], m["text"]) for m in replies], [("deep-accepted", "deep result")])
            self.assertEqual(set(self.peer.accepted), {"fast", "deep"})
            self.worker.run_once(_Stop())
            self.assertEqual(len([m for m in self.ledger.messages() if m["role"] == "assistant"]), 1)
            self.assertEqual(len(self.ledger.web_watches(8)), 8)

    def test_one_bounded_scan_serves_all_caught_up_watches(self):
        with self.clocks():
            self.watches()
            self.worker.drive_web()
            self.assertEqual(self.peer.waits, [worker_module.EVENT_WAIT_S])
            self.assertEqual(self.ledger.messages(), [], "tool context never becomes an input echo")
            self.assertEqual(self.peer.mutations, [], "observation cannot dispatch or accept")

    def test_partial_scan_does_not_discard_an_older_source(self):
        with self.clocks():
            self.watches(1)
            watch = self.ledger.web_watches()[0]
            watch["since"] = self.clock.now - 200
            self.ledger.save_web_watch(watch)
            self.peer.window_state = "closed"
            with patch.object(self.worker.journal, "page", return_value=([{"sequence": 20}], False)):
                self.worker.drive_web()
            self.assertEqual(len(self.ledger.web_watches()), 1)

    def test_shared_scan_matches_later_pages_and_exports_the_accepted_final_once(self):
        with self.clocks():
            self.watches(1)
            events = [{"sequence": sequence} for sequence in range(12, 217)]
            self.peer.read_events = lambda after, maximum, **_: [
                event for event in events if event["sequence"] > after][:maximum]

            def matching(batch, intake):
                self.assertLessEqual(len(batch), 100)
                self.assertEqual(intake, {"message_id": "web-input-0", "event_id": "ev-web-input-0"})
                return ["deep-web"] if any(event["sequence"] == 216 for event in batch) else []

            self.peer.matching_run_ids = matching
            self.peer.answer("deep-web", "The task is finished.")
            self.worker.drive_web()
            self.worker.drive_web()
            self.assertEqual([m["text"] for m in self.ledger.messages() if m["role"] == "assistant"],
                             ["The task is finished."])
            self.assertEqual(self.ledger.web_watches(), [])
            self.assertFalse([route for route, _ in self.peer.mutations
                              if route in ("/messages", "/window", "/accept")])

    def test_source_event_mismatch_still_refuses_delivery(self):
        with self.clocks():
            self.ledger.await_internal_context(row(message_id="web-input-0"))
            self.peer.read_events = lambda after, maximum, **_: ([{
                "sequence": 11, "event_id": "wrong-event",
                "payload_ref_or_safe_payload": {"message_id": "another-source"}}] if after < 11 else [])
            self.worker.drive_web()
            self.assertEqual(self.ledger.web_watches(), [])
            self.assertEqual(self.ledger.messages(), [])
            self.assertEqual(self.peer.mutations, [])

    def test_failed_background_scan_keeps_watches_and_foreground_final(self):
        with self.clocks():
            self.watches()
            before = self.ledger.web_watches(8)
            self.ledger.enqueue(dict(publicMessageId="owner-input", publicThreadId="v1-thread",
                                     chatId="chat@g.us", accountId="account", text="Current task"))
            page = self.worker.journal.page

            def scan(client, after, *args, **kwargs):
                if after >= 10:
                    raise RuntimeError("read failed")
                return page(client, after, *args, **kwargs)

            with patch.object(self.worker.journal, "page", side_effect=scan):
                self.worker.run_once(_Stop())
            self.assertEqual(self.ledger.web_watches(8), before)
            self.assertEqual([m["text"] for m in self.ledger.messages() if m["role"] == "assistant"],
                             ["deep result"])


if __name__ == "__main__":
    unittest.main()
