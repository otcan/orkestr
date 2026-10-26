"""A refused or stale input is closed with a visible owner notice; the chat keeps moving."""
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from v2.compat.v1_runtime import config as config_module
from v2.compat.v1_runtime.ledger import Ledger
from v2.compat.v1_runtime.rust_client import ClientError
from v2.compat.v1_runtime.tests.test_timer_relay import SCOPE, TimerPeer, occurrence
from v2.compat.v1_runtime.tests.test_worker import Peer
from v2.compat.v1_runtime.worker import Worker


class Stop:
    def __init__(self, passes=1):
        self.passes = passes

    def wait(self, duration):
        self.passes -= 1
        return self.passes < 0


def body(public_id, text="request"):
    return dict(publicMessageId=public_id, publicThreadId="thread", chatId="chat", accountId="account", text=text)


class RefusalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ledger = Ledger(Path(self.temp.name) / "ledger.sqlite3", {"test_scope": "one"}, max_outstanding=2)
        self.peer = Peer()
        self.worker = Worker(self.peer, self.ledger)

    def fail_route(self, failing_route, response=None, error=None, once=True):
        original = self.peer.request
        state = {"done": False}
        def request(method, route, **kwargs):
            if route == failing_route and method == "POST" and not (once and state["done"]):
                state["done"] = True
                self.peer.mutations.append((route, kwargs.get("body")))
                if error:
                    raise error
                return response
            return original(method, route, **kwargs)
        self.peer.request = request

    def assistant(self):
        return [m for m in self.ledger.messages() if m["role"] == "assistant"]

    def test_refused_input_notifies_owner_and_later_input_proceeds(self):
        first, _ = self.ledger.enqueue(body("first"))
        self.fail_route("/window", response=(409, {"error": {"code": "window_stale"}}))
        self.worker.run_once(Stop())
        # Sent after the first went to Rust, so it is not part of its burst.
        self.ledger.enqueue(body("second"))
        notice = self.assistant()
        self.assertEqual([m["parentMessageId"] for m in notice], [first["remote_id"]])
        self.assertEqual(notice[0]["refusal"], "window_refused")
        # A plain chat audience gets an honest notice that does not ask for a resend.
        self.assertIn("technical problem", notice[0]["text"])
        self.assertNotIn("send it again", notice[0]["text"])
        self.worker.run_once(Stop())
        replies = self.assistant()
        self.assertEqual(replies[-1]["text"], "deep result")
        self.assertIsNone(self.ledger.next_input())
        health = self.ledger.health()
        self.assertEqual(health["refusedInputs"], 1)
        self.assertEqual(health["recentRefusals"][0]["publicMessageId"], "first")
        self.assertEqual(health["recentRefusals"][0]["reason"], "window_refused")
        self.assertFalse(health["blocked"])

    def test_notice_acknowledgement_settles_and_frees_capacity(self):
        first, _ = self.ledger.enqueue(body("first"))
        self.ledger.enqueue(body("second"))
        self.fail_route("/messages", error=ClientError("unexpected_status", 422))
        self.worker.run_once(Stop())
        notice = self.assistant()[0]
        self.assertEqual(notice["refusal"], "upstream_refused:422")
        # Above the soft limit an input is queued, never refused.
        third, _ = self.ledger.enqueue(body("third"))
        self.assertEqual(third["capacity_queued"], {"outstanding": 2, "limit": 2})
        self.ledger.acknowledge(notice["id"], {"outcome": "delivered", "parentPublicMessageId": "first", "outboxJobId": "job"})
        self.assertNotIn("capacity_queued", self.ledger.enqueue(body("fourth"))[0])
        self.assertTrue(self.ledger.health()["recentRefusals"][-1]["settled"])

    def test_refusal_is_idempotent_and_never_resent(self):
        data, _ = self.ledger.enqueue(body("first"))
        self.assertIsNotNone(self.ledger.refuse(data, "execution_requires_review"))
        self.assertIsNone(self.ledger.refuse(dict(data), "other"))
        self.assertEqual(len(self.assistant()), 1)
        self.assertEqual(self.peer.mutations, [])

    def test_transient_upstream_failures_retry_the_same_request(self):
        for status in (502, 503, 429):
            with self.subTest(status=status):
                ledger = Ledger(Path(self.temp.name) / ("t%d.sqlite3" % status), {"test_scope": "one"})
                ledger.enqueue(body("first"))
                peer = Peer()
                original = peer.request
                calls = []
                def request(method, route, **kwargs):
                    if route == "/messages" and not calls:
                        calls.append(kwargs.get("body"))
                        raise ClientError("unexpected_status", status)
                    return original(method, route, **kwargs)
                peer.request = request
                worker = Worker(peer, ledger)
                worker.run_once(Stop())
                self.assertNotIn("refused", ledger.next_input())
                worker.run_once(Stop())
                self.assertIsNone(ledger.next_input())
                self.assertEqual(calls[0], [b for r, b in peer.mutations if r == "/messages"][0])

    def test_input_blocked_by_an_earlier_version_is_closed_visibly(self):
        data, _ = self.ledger.enqueue(body("first"))
        self.ledger.enqueue(body("second"))
        data.update(blocked="upstream_refused", phase="blocked")
        self.ledger.save(data)
        self.worker.run_once(Stop())
        self.assertEqual(self.assistant()[0]["refusal"], "upstream_refused")
        self.worker.run_once(Stop())
        self.assertIsNone(self.ledger.next_input())


class ExpiryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ledger = Ledger(Path(self.temp.name) / "ledger.sqlite3", SCOPE)
        self.peer = TimerPeer()
        self.worker = Worker(self.peer, self.ledger, max_input_age_s=600)

    def aged(self, public_id, seconds, **fields):
        data, _ = self.ledger.enqueue(body(public_id))
        data["queued_at"] -= seconds
        data.update(fields)
        self.ledger.save(data)
        return data

    def test_stale_input_is_refused_with_notice_and_never_run(self):
        self.aged("stale", 601)
        fresh = self.aged("fresh", 10)
        expired = self.ledger.expire_stale(600)
        self.assertEqual([d["public_id"] for d in expired], ["stale"])
        notice = [m for m in self.ledger.messages() if m["role"] == "assistant"]
        self.assertEqual(notice[0]["refusal"], "input_expired")
        self.assertEqual(self.ledger.next_input()["remote_id"], fresh["remote_id"])

    def test_paused_binding_still_expires_and_does_not_execute(self):
        self.aged("stale", 601)
        self.worker.run(Stop(passes=1), active=lambda: False)
        self.assertIsNone(self.ledger.next_input())
        self.assertEqual(self.peer.mutations, [])

    def test_busy_window_expires_but_an_unknown_window_request_does_not(self):
        busy = self.aged("busy", 601, phase="waiting_for_window", window_request={"request_key": "k"},
                         intake={"message_id": "m", "event_id": "e", "sequence": 1})
        unknown = self.aged("unknown", 601, phase="admitted", window_request={"request_key": "k2"},
                            intake={"message_id": "m2", "event_id": "e2", "sequence": 2})
        running = self.aged("running", 601, phase="running", window={"request_key": "k3"})
        self.assertEqual([d["remote_id"] for d in self.ledger.expire_stale(600)], [busy["remote_id"]])
        self.assertEqual(self.ledger.next_input()["remote_id"], unknown["remote_id"])
        self.assertNotIn("refused", json.dumps(self.ledger.next_input()))
        del running

    def test_timer_occurrences_follow_core_and_never_expire_here(self):
        self.ledger.set_timer_cursor(0)
        self.peer.timer_rows = [occurrence(1, window="queued")]
        self.worker.discover_timers()
        data = self.ledger.next_input()
        data["admitted_at"] -= 10_000
        self.ledger.save(data)
        self.assertEqual(self.ledger.expire_stale(600), [])

    def test_ledgers_without_a_queue_time_start_the_clock_now(self):
        data, _ = self.ledger.enqueue(body("legacy"))
        data.pop("queued_at")
        self.ledger.save(data)
        self.assertEqual(self.ledger.expire_stale(600, now=1_000_000), [])
        self.assertEqual(self.ledger.next_input()["queued_at"], 1_000_000)
        self.assertEqual(len(self.ledger.expire_stale(600, now=1_000_601)), 1)


class InputAgeConfigTests(unittest.TestCase):
    def doc(self, **changes):
        value = dict(conversation_id="00000000-0000-4000-8000-000000000101", remote_thread_id="00000000-0000-4000-8000-000000000201",
                     public_thread_id="thread", chat_id="chat", account_id="account", allowed_principals=["owner"],
                     excluded_public_ids=[], automatic_accept_roles=["fast", "deep"], outbound_role="deep", enabled=True,
                     revoked=False, progress_updates=False, attachments=False, max_outstanding_inputs=4)
        value.update(changes)
        return value

    def test_optional_input_age_defaults_and_is_bounded(self):
        owner = "00000000-0000-4000-8000-0000000000aa"
        self.assertEqual(config_module.binding(self.doc(), owner)["max_input_age_seconds"], 1800)
        self.assertEqual(config_module.binding(self.doc(max_input_age_seconds=120), owner)["max_input_age_seconds"], 120)
        for bad in (59, 7 * 86400 + 1, "600", True):
            with self.assertRaisesRegex(ValueError, "config_input_age"):
                config_module.binding(self.doc(max_input_age_seconds=bad), owner)
        with self.assertRaisesRegex(ValueError, "binding_fields"):
            config_module.binding(self.doc(unknown=1), owner)


if __name__ == "__main__":
    unittest.main()
