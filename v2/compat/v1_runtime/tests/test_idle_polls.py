"""Idle bindings leave out the Core polls that cannot find anything (ORK-782).

Synthetic conversations, a synthetic Core peer and a fake conversation watch
only: no Core, no WhatsApp.
"""
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from v2.compat.v1_runtime import conversation_watch as watch_module, idle_polls, worker as worker_module
from v2.compat.v1_runtime.conversation_watch import ConversationWatch
from v2.compat.v1_runtime.idle_polls import Polls
from v2.compat.v1_runtime.ledger import Ledger
from v2.compat.v1_runtime.worker import Signal, Worker
from v2.compat.v1_runtime.tests.test_timer_relay import SCOPE, _Stop, occurrence
from v2.compat.v1_runtime.tests.test_web_mirror import WebPeer, row

CONVERSATION = "conversation"  # The synthetic peer's conversation.
A = "00000000-0000-4000-8000-00000000000a"
B = "00000000-0000-4000-8000-00000000000b"
C = "00000000-0000-4000-8000-00000000000c"
SEQUENCED = ("?after=", "/thread-ask-inputs?", "/timer-inputs?")


class FakeWatch:
    """A fresh watch for the synthetic conversation; `value=None` is stale."""

    def __init__(self, value=7):
        self.value = value

    def sequence(self, conversation, now=None):
        return self.value if conversation == CONVERSATION else None


class DiscoveryPeer(WebPeer):
    """Core with web messages, thread-ask answers, timers, posts and digests."""

    def __init__(self):
        super().__init__()
        self.asks = []

    def request(self, method, route, body=None, allowed=(200,)):
        if route.startswith("/thread-ask-inputs?"):
            self.reads.append((method, route))
            after = int(route.split("after_sequence=")[1].split("&")[0])
            return 200, {"inputs": [dict(r) for r in self.asks if r["sequence"] > after][:20],
                         "last_sequence": self.last_sequence}
        return super().request(method, route, body, allowed)

    def count(self, prefix):
        return len([route for _, route in self.reads if route.startswith(prefix)])


class Clock:
    """Simulated monotonic and wall time for the worker and idle_polls."""

    def __init__(self):
        self.now = 1000.0

    def monotonic(self):
        return self.now

    def time(self):
        return 1_800_000_000.0 + self.now

    def sleep(self, seconds):
        self.now += seconds


class Until:
    """A stop whose waits advance the simulated clock; stops at `end`."""

    def __init__(self, clock, end):
        self.clock, self.end, self.pauses = clock, end, []

    def wait(self, pause):
        self.pauses.append(pause)
        self.clock.now += pause
        return self.clock.now >= self.end

    def is_set(self):
        return self.clock.now >= self.end


class Base(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ledger = Ledger(Path(self.temp.name) / "ledger.sqlite3", SCOPE)
        self.peer = DiscoveryPeer()
        self.worker = Worker(self.peer, self.ledger, legacy_companions=True)
        self.worker.polls.spread = 1.0
        self.ledger.set_web_cursor(10)
        self.watch = FakeWatch()

    def idle_minutes(self, minutes, watch):
        """Requests per minute of one idle enabled binding over simulated time."""
        clock = Clock()
        with patch.object(worker_module, "time", clock), patch.object(idle_polls, "time", clock):
            self.worker.polls.watch = watch
            self.worker.run(Until(clock, clock.now + minutes * 60))
        return len(self.peer.reads) / minutes


class IdleRateTests(Base):
    """The before/after request rate of an idle enabled binding (ORK-782)."""

    def test_an_idle_binding_without_a_watch_keeps_every_old_cadence(self):
        rate = self.idle_minutes(30, None)
        # Web and thread-ask every 3 s, timers and posts every 5 s, digests every 30 s.
        self.assertGreaterEqual(rate, 64)
        self.assertEqual(self.peer.count("/posts?"), 30 * 60 // worker_module.POST_POLL_S)

    def test_an_idle_binding_with_an_unchanged_conversation_asks_core_about_ten_times_less(self):
        rate = self.idle_minutes(30, self.watch)
        self.assertLessEqual(rate, 7)
        # Posts and digests change no sequence: polled at the idle cadence.
        self.assertEqual(self.peer.count("/posts?"), 30 * 60 // idle_polls.POST_IDLE_POLL_S)
        self.assertEqual(self.peer.count("/timer-digests?"), 30 * 60 // idle_polls.DIGEST_IDLE_POLL_S)
        # Sequenced sources: once at start, then only the safety net.
        for prefix in SEQUENCED:
            with self.subTest(prefix=prefix):
                self.assertEqual(self.peer.count(prefix), 30 * 60 // idle_polls.FALLBACK_S)

    def test_a_stale_watch_restores_the_old_cadence(self):
        rate = self.idle_minutes(10, FakeWatch(None))
        self.assertGreaterEqual(rate, 64)


class WakeTests(Base):
    def test_a_new_web_message_wakes_an_idle_worker_at_once(self):
        """The watch's wake ends the idle pause and the left-out poll runs."""
        self.worker.polls.watch = self.watch
        stop = Signal()
        thread = threading.Thread(target=self.worker.run, args=(stop,), daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(stop.set)
        # The first look (pass 1 at PASS_S), then a left-out web poll 3 s later.
        deadline = time.monotonic() + 10
        while "web" not in self.worker.polls._skipped and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertIn("web", self.worker.polls._skipped)
        polled = self.peer.count("?after=")
        # The owner types in the web UI: Core advances the sequence, the watch
        # sees it and wakes the binding (Registry.wake_conversations).
        self.peer.snapshot = [row(sequence=11)]
        self.peer.last_sequence = 11
        self.watch.value = 11
        woken = time.monotonic()
        stop.wake()
        while self.peer.count("?after=") == polled and time.monotonic() < woken + 5:
            time.sleep(0.005)
        latency = time.monotonic() - woken
        self.assertGreater(self.peer.count("?after="), polled)
        self.assertLess(latency, 0.5, "found within the wake, not after the 3 s web cadence")
        deadline = time.monotonic() + 5
        while not self.ledger.messages() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(self.ledger.messages()[-1]["text"], "Deploy the window change")

    def test_a_changed_sequence_makes_a_left_out_source_due_before_its_cadence(self):
        polls = self.worker.polls
        polls.watch = self.watch
        self.worker.run_once(_Stop())  # The first look at every source.
        self.worker._web_checked -= worker_module.WEB_POLL_S
        self.worker._timers_checked -= worker_module.TIMER_POLL_S
        self.worker.run_once(_Stop())  # Due, but nothing can be new: left out.
        self.assertEqual(self.peer.count("/timer-inputs?"), 1)
        self.assertEqual(self.peer.count("?after="), 1)
        self.assertEqual(polls._skipped, {"web", "thread_ask", "timers"})
        self.worker.run_once(_Stop())  # Not due yet, nothing changed.
        self.assertEqual(self.peer.count("/timer-inputs?"), 1)
        # A timer occurrence is admitted: the sequence moves before the cadence.
        self.peer.timer_rows = [occurrence(8)]
        self.watch.value = 8
        self.worker.run_once(_Stop())
        self.assertEqual(self.peer.count("?after="), 2)
        self.assertEqual(self.ledger.timer_cursor(), 8)
        user, = [m for m in self.ledger.messages() if m["role"] == "user"]
        self.assertEqual(user["origin"], "timer")
        # Discovery read it at once (the foreground's own window check reads too).
        self.assertGreaterEqual(self.peer.count("/timer-inputs?"), 2)

    def test_found_rows_are_followed_by_another_poll_even_without_a_change(self):
        """A full page may have more behind it; only an empty poll is trusted."""
        self.worker.polls.watch = self.watch
        self.ledger.set_timer_cursor(0)
        # Held: listed but not run, so only discovery reads timer inputs.
        self.peer.timer_rows = [occurrence(3, held=True)]
        self.worker.run_once(_Stop())
        self.assertEqual(self.peer.count("/timer-inputs?"), 1)
        self.worker._timers_checked -= worker_module.TIMER_POLL_S
        self.worker.run_once(_Stop())
        self.assertEqual(self.peer.count("/timer-inputs?"), 2, "found rows: polled again")
        self.worker._timers_checked -= worker_module.TIMER_POLL_S
        self.worker.run_once(_Stop())
        self.assertEqual(self.peer.count("/timer-inputs?"), 2, "an empty poll: left out")

    def test_a_fired_trigger_always_looks_for_its_timer(self):
        self.worker.polls.watch = self.watch
        self.worker.run_once(_Stop())
        self.worker._timers_checked = None  # fire_trigger: look at the next pass.
        self.worker.run_once(_Stop())
        self.assertEqual(self.peer.count("/timer-inputs?"), 2)

    def test_a_failed_poll_is_retried_at_its_cadence(self):
        self.worker.polls.watch = self.watch
        original = self.peer.request

        def failing(method, route, body=None, allowed=(200,)):
            if route.startswith("/thread-ask-inputs?"):
                self.peer.reads.append((method, route))
                raise worker_module.ClientError("transport_failed")
            return original(method, route, body, allowed)
        self.peer.request = failing
        self.worker.run_once(_Stop())
        self.worker._web_checked -= worker_module.WEB_POLL_S
        self.worker.run_once(_Stop())
        self.assertEqual(self.peer.count("/thread-ask-inputs?"), 2)
        self.assertEqual(self.peer.count("?after="), 1, "the web poll succeeded and is left out")

    def test_the_safety_net_polls_an_unchanged_conversation_now_and_then(self):
        polls = Polls(CONVERSATION, spread=1.0)
        polls.watch = self.watch
        self.assertTrue(polls.begin("web", now=0))
        polls.done("web", False)
        self.assertFalse(polls.begin("web", now=idle_polls.FALLBACK_S - 1))
        self.assertTrue(polls.begin("web", now=idle_polls.FALLBACK_S))


class ActivityTests(Base):
    def test_posts_keep_their_cadence_while_the_binding_is_active(self):
        polls = self.worker.polls
        polls.watch = self.watch
        now = 5000.0
        self.assertEqual(polls.interval(5, 15, now), 15, "idle from the start")
        polls.touch(now)
        self.assertEqual(polls.interval(5, 15, now + idle_polls.ACTIVE_S - 1), 5)
        self.assertEqual(polls.interval(5, 15, now + idle_polls.ACTIVE_S), 15)
        # Any change in the conversation (a Deep turn, a web message) is activity.
        self.watch.value = 8
        self.assertEqual(polls.interval(5, 15, now + idle_polls.ACTIVE_S + 1), 5)
        # Without a fresh watch the old cadence holds.
        polls.watch = FakeWatch(None)
        self.assertEqual(polls.interval(5, 15, now + 10 * idle_polls.ACTIVE_S), 5)

    def test_a_busy_pass_or_an_adopted_post_makes_the_binding_active(self):
        self.worker.polls.watch = self.watch
        self.worker.run_once(_Stop())
        self.assertFalse(self.worker.polls.active())
        self.peer.posts = [{"id": "00000000-0000-4000-8000-0000000000f1", "conversation_id": CONVERSATION,
                            "author": "operator", "label": "Ops", "text": "Synthetic alert", "provider": None,
                            "model": None}]
        self.worker._posts_checked = None
        self.worker.run_once(_Stop())
        self.assertTrue(self.worker.polls.active())
        self.assertEqual(self.worker.polls.interval(worker_module.POST_POLL_S, idle_polls.POST_IDLE_POLL_S),
                         worker_module.POST_POLL_S)

    def test_idle_pause_follows_the_idle_post_and_digest_cadence(self):
        now = 1000.0
        self.worker.polls.watch = self.watch
        self.worker._timers_checked = self.worker._web_checked = now + 3600
        self.worker._posts_checked = self.worker._digest_checked = now
        self.assertEqual(self.worker.idle_pause(now), worker_module.IDLE_PASS_S)
        self.worker._posts_checked = now - idle_polls.POST_IDLE_POLL_S + 2
        self.assertEqual(self.worker.idle_pause(now), 2)


class PausedTests(Base):
    def test_a_disabled_worker_never_polls_core(self):
        self.worker.polls.watch = self.watch
        clock = Clock()
        stop = Until(clock, clock.now + 3600)
        with patch.object(worker_module, "time", clock), patch.object(idle_polls, "time", clock):
            self.worker.run(stop, active=lambda: False)
        self.assertEqual(self.peer.reads, [])
        self.assertEqual(self.peer.mutations, [])
        self.assertTrue(all(pause == worker_module.IDLE_PASS_S for pause in stop.pauses[1:]))


class ConversationWatchTests(unittest.TestCase):
    def setUp(self):
        self.pages = {0: {"conversations": [{"conversation_id": A, "name": "x", "scope": {"kind": "global"},
                                             "last_sequence": 4}], "next_cursor": 9},
                      9: {"conversations": [{"conversation_id": B, "name": "y", "scope": {"kind": "global"},
                                             "last_sequence": 0}], "next_cursor": None}}
        self.reads = []
        self.watch = ConversationWatch(self.read)

    def read(self, after, limit):
        self.reads.append((after, limit))
        return self.pages[after]

    def test_pages_through_the_directory_and_reports_only_changes(self):
        self.assertEqual(self.watch.poll(), set(), "the first listing wakes nobody")
        self.assertEqual(self.reads, [(0, 100), (9, 100)])
        self.assertEqual((self.watch.sequence(A), self.watch.sequence(B), self.watch.sequence(C)), (4, 0, None))
        self.pages[0]["conversations"][0]["last_sequence"] = 5
        self.pages[9]["conversations"].append({"conversation_id": C, "name": "z", "scope": {"kind": "global"},
                                               "last_sequence": 1})
        self.assertEqual(self.watch.poll(), {A, C})
        self.assertEqual(self.watch.poll(), set())

    def test_a_stale_listing_serves_nothing(self):
        self.assertEqual(self.watch.status(), {"enabled": True, "fresh": False, "ageS": None, "conversations": 0})
        self.watch.poll()
        self.assertTrue(self.watch.status()["fresh"])
        self.assertEqual(self.watch.status()["conversations"], 2)
        later = time.monotonic() + watch_module.STALE_S + 1
        self.assertIsNone(self.watch.sequence(A, later))
        self.assertFalse(self.watch.status(later)["fresh"])

    def test_a_malformed_page_leaves_the_last_listing_to_go_stale(self):
        self.watch.poll()
        for broken in ({"conversations": "x", "next_cursor": None},
                       {"conversations": [{"conversation_id": "A", "last_sequence": 1}], "next_cursor": None},
                       {"conversations": [{"conversation_id": A, "last_sequence": "1"}], "next_cursor": None},
                       {"conversations": [], "next_cursor": 0}, []):
            with self.subTest(broken=broken):
                self.pages[0] = broken
                with self.assertRaises(ValueError):
                    self.watch.poll()
                self.assertEqual(self.watch.sequence(A), 4)

    def test_run_wakes_the_changed_conversations_and_backs_off_on_failure(self):
        stop, woken, calls = threading.Event(), [], []

        def read(after, limit):
            calls.append(after)
            if len(calls) == 3:
                raise RuntimeError("synthetic outage")
            if len(calls) >= 6:
                stop.set()
            return {"conversations": [{"conversation_id": A, "name": "x", "scope": {"kind": "global"},
                                       "last_sequence": len(calls)}], "next_cursor": None}
        watch = ConversationWatch(read, interval=0.01)
        with patch("sys.stderr"):
            watch.run(stop, woken.append)
        # Listings 2, 4, 5 and 6 changed; the first wakes nobody, the third failed.
        self.assertEqual(woken, [{A}] * 4)

    def test_failures_are_retried_at_pace_then_back_off(self):
        watch = ConversationWatch(self.read, interval=2)
        pauses = [watch.pause(n) for n in range(0, 10)]
        self.assertEqual(pauses[:watch_module.RETRY_AT_PACE + 1], [2] * (watch_module.RETRY_AT_PACE + 1))
        self.assertEqual(pauses[watch_module.RETRY_AT_PACE + 1:], [4, 8, 16, 30, 30])


class ConfigTests(unittest.TestCase):
    def service(self, **extra):
        from v2.compat.v1_runtime import config as config_module
        value = dict(origin="https://example.test", loopback_url="http://127.0.0.1:1234",
                     expected_owner="00000000-0000-4000-8000-000000000001", listen_port=1234,
                     token_path="/synthetic/token")
        value.update(extra)
        with patch.object(config_module, "private_json", return_value=dict(token="a" * 64)):
            return config_module._service(value)

    def test_the_watch_is_on_by_default_and_false_is_the_kill_switch(self):
        self.assertIs(self.service()["conversation_watch"], True)
        self.assertIs(self.service(conversation_watch=False)["conversation_watch"], False)
        with self.assertRaisesRegex(ValueError, "config_conversation_watch"):
            self.service(conversation_watch="false")

    def test_a_service_file_may_carry_the_switch(self):
        import json
        import os
        from v2.compat.v1_runtime import config as config_module
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        for name in ("bindings", "ledgers"):
            (root / name).mkdir(mode=0o700)
        token = root / "token.json"
        token.write_text(json.dumps({"token": "a" * 64}))
        service = root / "service.json"
        service.write_text(json.dumps(dict(
            origin="https://example.test", loopback_url="http://127.0.0.1:1234", credentials_path=str(root / "c.json"),
            expected_owner="00000000-0000-4000-8000-000000000001", expected_source="a" * 40,
            token_path=str(token), listen_port=1234, bindings_dir=str(root / "bindings"),
            ledger_dir=str(root / "ledgers"), conversation_watch=False)))
        for path in (token, service):
            os.chmod(path, 0o600)
        loaded, static = config_module.load(service)
        self.assertIs(loaded["conversation_watch"], False)
        self.assertEqual(static, [])


class RegistryWiringTests(unittest.TestCase):
    def test_every_binding_worker_reads_the_registry_watch(self):
        from types import SimpleNamespace
        from v2.compat.v1_runtime.registry import Registry
        from v2.compat.v1_runtime.tests.test_ledger_server import OWNER, binding_doc, private_write
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        for name in ("bindings", "ledgers"):
            (root / name).mkdir(mode=0o700)
        docs = [binding_doc(1), binding_doc(2, enabled=False)]
        for doc in docs:
            private_write(root / "bindings" / (doc["remote_thread_id"] + ".json"), doc)
        watch = ConversationWatch(lambda after, limit: {"conversations": [], "next_cursor": None})
        registry = Registry(dict(expected_owner=OWNER, bindings_dir=str(root / "bindings"),
                                 ledger_dir=str(root / "ledgers")),
                            lambda conversation: SimpleNamespace(conversation=conversation), workers=False, watch=watch)
        registry.reload()
        self.assertEqual(registry.status()["conversationWatch"]["enabled"], True)
        for doc in docs:
            polls = registry.get(doc["remote_thread_id"]).worker.polls
            self.assertIs(polls.watch, watch)
            self.assertEqual(polls.conversation, doc["conversation_id"])
        woken = []
        for doc in docs:
            registry.get(doc["remote_thread_id"]).stop.wake = (lambda r: lambda: woken.append(r))(doc["remote_thread_id"])
        registry.wake_conversations({doc["conversation_id"] for doc in docs})
        self.assertEqual(woken, [docs[0]["remote_thread_id"]], "a paused binding is never woken")


class RegistryWakeTests(unittest.TestCase):
    def test_only_enabled_bindings_of_changed_conversations_are_woken(self):
        from v2.compat.v1_runtime.registry import Binding, Registry
        registry = Registry({}, None, workers=False)
        for name, conversation, enabled, revoked in (("one", A, True, False), ("two", B, False, False),
                                                     ("three", C, True, True), ("four", B, True, False)):
            binding = Binding("synthetic:" + name, {"conversation_id": conversation, "enabled": enabled,
                                                    "revoked": revoked, "remote_thread_id": name}, None)
            registry.bindings[name] = binding
        woken = []
        for name, binding in registry.bindings.items():
            binding.stop.wake = (lambda n: lambda: woken.append(n))(name)
        self.assertEqual(registry.wake_conversations({A, B, C}), 2)
        self.assertEqual(sorted(woken), ["four", "one"])
        self.assertEqual(registry.status()["conversationWatch"], {"enabled": False})


if __name__ == "__main__":
    unittest.main()
