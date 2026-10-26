"""Idle bindings poll Rust rarely; a new input is still stepped at once."""
import contextlib
import io
from pathlib import Path
import tempfile
import threading
import time
import unittest

from v2.compat.v1_runtime import worker as worker_module
from v2.compat.v1_runtime.ledger import Ledger
from v2.compat.v1_runtime.tests.test_worker import Peer
from v2.compat.v1_runtime.worker import BURST_NOTE, Signal, Worker
from v2.compat.v1_runtime.tests.test_ledger_server import Harness
from v2.compat.v1_runtime.tests.test_timer_relay import Base


class Recording:
    """A stop that records each pause and stops after `passes` waits."""

    def __init__(self, passes):
        self.passes, self.pauses = passes, []

    def wait(self, duration):
        self.pauses.append(duration)
        return len(self.pauses) > self.passes


class SignalTests(unittest.TestCase):
    def test_wake_ends_a_sleep_without_stopping(self):
        signal = Signal()
        threading.Timer(0.05, signal.wake).start()
        started = time.monotonic()
        self.assertFalse(signal.wait(5))
        self.assertLess(time.monotonic() - started, 2)
        self.assertFalse(signal.is_set())

    def test_a_wake_before_the_sleep_is_not_lost_and_is_consumed_once(self):
        signal = Signal()
        signal.wake()
        self.assertFalse(signal.wait(5))
        started = time.monotonic()
        self.assertFalse(signal.wait(0.05))
        self.assertGreaterEqual(time.monotonic() - started, 0.04)

    def test_stop_ends_every_sleep(self):
        signal = Signal()
        threading.Timer(0.05, signal.set).start()
        self.assertTrue(signal.wait(5))
        self.assertTrue(signal.wait(5))
        self.assertTrue(signal.is_set())


class CadenceTests(Base):
    def reads(self, prefix):
        return len([r for r in self.peer.reads if r[1].startswith(prefix)])

    def test_idle_pause_waits_for_the_next_due_poll_within_bounds(self):
        now = 1000.0
        self.assertEqual(self.worker.idle_pause(now), worker_module.IDLE_PASS_S)
        self.worker._timers_checked = self.worker._posts_checked = now
        self.worker._digest_checked = now
        self.assertEqual(self.worker.idle_pause(now), min(worker_module.TIMER_POLL_S, worker_module.POST_POLL_S,
                                                          worker_module.IDLE_PASS_S))
        self.worker._posts_checked = now - worker_module.POST_POLL_S + 2.5
        self.assertEqual(self.worker.idle_pause(now), 2.5)
        self.worker._timers_checked = now - 60
        self.assertEqual(self.worker.idle_pause(now), worker_module.PASS_S)

    def test_an_idle_binding_sleeps_longer_than_one_pass(self):
        stop = Recording(passes=3)
        self.worker.run(stop)
        self.assertEqual(stop.pauses[0], worker_module.PASS_S)
        self.assertTrue(all(pause > worker_module.PASS_S for pause in stop.pauses[1:]), stop.pauses)
        # Three passes inside one poll interval reach Rust only once.
        self.assertEqual(self.reads("/timer-inputs?"), 1)
        self.assertEqual(self.reads("/posts?"), 1)

    def test_web_mirroring_keeps_its_poll_deadline_while_idle(self):
        now = 1000.0
        self.worker._timers_checked = self.worker._posts_checked = now
        self.worker._digest_checked = self.worker._web_checked = now
        self.assertEqual(self.worker.idle_pause(now), worker_module.WEB_POLL_S)
        self.worker._web_checked = now - worker_module.WEB_POLL_S + 1.5
        self.assertEqual(self.worker.idle_pause(now), 1.5)
        self.worker.web_mirror = False
        self.assertEqual(self.worker.idle_pause(now), worker_module.IDLE_PASS_S)

    def test_a_pending_input_is_stepped_every_pass(self):
        self.peer.busy = True  # The window stays busy: the input remains pending and retried.
        self.ledger.enqueue({"publicThreadId": "v1-thread", "publicMessageId": "wa-1", "chatId": "chat@g.us",
                             "accountId": "account", "text": "hello"})
        stop = Recording(passes=4)
        self.worker.run(stop)
        # Between passes only PASS_S (or the existing 4 s transient retry), never the idle pause.
        self.assertEqual(set(stop.pauses), {worker_module.PASS_S, 4})

    def test_a_paused_binding_only_expires_at_the_idle_pace(self):
        stop = Recording(passes=2)
        self.worker.run(stop, active=lambda: False)
        self.assertEqual(stop.pauses, [worker_module.PASS_S, worker_module.IDLE_PASS_S, worker_module.IDLE_PASS_S])
        self.assertEqual(self.peer.reads, [])

    def test_timers_are_polled_every_timer_interval_and_at_once_after_a_trigger(self):
        self.worker.run_once(Recording(0))
        self.worker.run_once(Recording(0))
        self.assertEqual(self.reads("/timer-inputs?"), 1)
        self.worker._timers_checked -= worker_module.TIMER_POLL_S
        self.worker.run_once(Recording(0))
        self.assertEqual(self.reads("/timer-inputs?"), 2)
        data = self.ledger.enqueue({"publicThreadId": "v1-thread", "publicMessageId": "wa-2", "chatId": "chat@g.us",
                                    "accountId": "account", "text": "hello"})[0]
        self.worker.fire_trigger(data)
        self.assertIsNone(self.worker._timers_checked)


class BurstWakeTests(unittest.TestCase):
    """Wake-on-arrival never bypasses the burst debounce, and the head is sent
    as soon as the burst went quiet rather than up to a whole pass later."""

    def test_woken_worker_still_debounces_and_sends_one_input_once_quiet(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        ledger = Ledger(Path(temp.name) / "ledger.sqlite3", {"test_scope": "one"})
        peer, signal = Peer(), Signal()
        worker = Worker(peer, ledger, burst_quiet_s=0.6)
        def message(public_id, text):
            data, _ = ledger.enqueue(dict(publicMessageId=public_id, publicThreadId="thread", chatId="chat",
                                          accountId="account", text=text))
            signal.wake()  # What the intake handler does.
            return data["queued_at"]
        sent = []
        intakes = lambda: list(sent)
        original = peer.request
        def request(method, route, body=None, allowed=(200,)):
            if method == "POST" and route == "/messages":
                sent.append((time.time(), body["text"]))
            return original(method, route, body=body, allowed=allowed)
        peer.request = request
        thread = threading.Thread(target=worker.run, args=(signal,), daemon=True)
        with contextlib.redirect_stderr(io.StringIO()):
            message("a", "first")
            message("b", "second")
            thread.start()
            time.sleep(0.3)
            # The debounce runs from the arrival stamp the ledger gives the last
            # input (wall clock, taken inside the enqueue transaction), not from
            # when enqueue() returned: the commit and wake-up can take tens of
            # milliseconds under load, which made a "time since return" bound flaky.
            last = message("c", "third")
            deadline = time.monotonic() + 5
            while not intakes() and time.monotonic() < deadline:
                time.sleep(0.01)
            signal.set()
            thread.join(5)
        (at, text), = intakes()
        self.assertEqual(text, "\n\n".join([BURST_NOTE % 3, "first", "second", "third"]))
        # Exact: the worker re-checks the wall clock and never sends before the
        # full quiet period since the last arrival has passed.
        self.assertGreaterEqual(at - last, 0.6, "the quiet period is kept")
        self.assertLess(at - last, 0.6 + 0.5, "sent when quiet, not a whole pass later")

    def test_busy_pause_is_one_pass_or_until_the_burst_is_due(self):
        worker = Worker(Peer(), None)
        self.assertEqual(worker.busy_pause(), worker_module.PASS_S)
        worker._burst_due = 100.3
        self.assertAlmostEqual(worker.busy_pause(now=100.0), 0.3)
        self.assertIsNone(worker._burst_due)
        worker._burst_due = 99.0
        self.assertEqual(worker.busy_pause(now=100.0), 0.05)
        worker._burst_due = 105.0
        self.assertEqual(worker.busy_pause(now=100.0), worker_module.PASS_S)

class IntakeWakeTests(Harness):
    def test_new_input_wakes_only_its_binding_and_a_duplicate_does_not(self):
        self.assertEqual(self.post(1)[0], 202)
        started = time.monotonic()
        self.assertFalse(self.binding(1).stop.wait(5))
        self.assertLess(time.monotonic() - started, 2)
        self.assertFalse(self.binding(2).stop._woken)
        self.assertEqual(self.post(1)[0], 200)
        self.assertFalse(self.binding(1).stop._woken)


if __name__ == "__main__":
    unittest.main()
