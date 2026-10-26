"""Owner messages typed in the V2 web UI are mirrored to the group with their answer."""
from pathlib import Path
import unittest

from v2.compat.v1_runtime import worker as worker_module
from v2.compat.v1_runtime.ledger import Ledger
from v2.compat.v1_runtime.worker import Worker
from v2.compat.v1_runtime.tests.test_timer_relay import SCOPE, Base, TimerPeer, _Stop
from v2.compat.v1_runtime.tests.test_worker import Peer

WEB = "a1000000-0000-4000-8000-000000000001"
WEB2 = "a1000000-0000-4000-8000-000000000002"
LABEL = "\U0001f5a5️ (web)"


def row(message_id=WEB, sequence=11, text="Deploy the window change", origin="web"):
    value = {"message_id": message_id, "sequence": sequence, "actor_kind": "owner", "text": text}
    if origin is not None:
        value["origin"] = origin
    return value


class WebPeer(TimerPeer):
    def __init__(self):
        super().__init__()
        self.snapshot, self.last_sequence = [], 10
        self.deep = {}          # run id -> phase
        self.runs = {}          # message id -> run ids
        self.results = []       # accepted-results rows
        self.payloads = {}
        self.window_state = "active"

    def read_events(self, after, maximum):
        if maximum == 1:
            for item in self.snapshot:
                if item["sequence"] == after + 1:
                    return [{"sequence": item["sequence"], "event_id": "ev-" + item["message_id"],
                             "payload_ref_or_safe_payload": {"kind": "message_accepted", "message_id": item["message_id"]}}]
            return []
        return [{"sequence": after + 1}]

    def matching_run_ids(self, events, intake):
        if "event_id" in intake and intake["event_id"].startswith("ev-"):
            return list(self.runs.get(intake["message_id"], []))
        return super().matching_run_ids(events, intake)

    def request(self, method, route, body=None, allowed=(200,)):
        if method == "GET" and (route == "" or route.startswith("?after=")):
            self.reads.append((method, route))
            after = int(route.split("after=")[1].split("&")[0]) if route else 0
            rows = [dict(r) for r in self.snapshot if r["sequence"] > after]
            return 200, {"conversation_id": self.conversation, "messages": rows[:50],
                         "last_sequence": self.last_sequence, "next_cursor": None}
        if route.startswith("/execution?run_id=") and route.split("=")[1] in self.deep:
            run = route.split("=")[1]
            self.reads.append((method, route))
            return 200, {"run_id": run, "phase": self.deep[run], "progress": {"payload_id": "p-" + run}}
        if route.startswith("/accepted-results?") and self.results:
            return 200, {"results": list(self.results), "next_after_sequence": None}
        if route.startswith("/payloads/") and route[10:] in self.payloads:
            return 200, self.payloads[route[10:]]
        if route == "/window" and method == "GET":
            return 200, {"state": self.window_state}
        if route == "/messages":
            return Peer.request(self, method, route, body, allowed)
        return super().request(method, route, body, allowed)

    def answer(self, run, text):
        self.deep[run] = "completed"
        self.results.append({"run_id": run, "completion_event_id": "c-" + run, "acceptance_event_id": "a-" + run,
                             "payload_id": "pay-" + run, "payload_removed": False})
        self.payloads["pay-" + run] = {"run_id": run, "payload_id": "pay-" + run, "text": text}


class WebMirrorTests(Base):
    def setUp(self):
        super().setUp()
        self.peer = WebPeer()
        self.worker = Worker(self.peer, self.ledger)

    def scan(self):
        self.worker._web_checked = None
        self.worker.run_once(_Stop())

    def users(self):
        return [m for m in self.ledger.messages() if m["role"] == "user"]

    def replies(self):
        return [m for m in self.ledger.messages() if m["role"] == "assistant"]

    def test_first_scan_records_position_without_backfill(self):
        self.peer.snapshot = [row(sequence=9)]
        self.scan()
        self.assertEqual(self.ledger.web_cursor(), 10)
        self.assertEqual(self.ledger.messages(), [])

    def test_message_is_mirrored_at_once_and_answer_follows(self):
        self.ledger.set_web_cursor(10)
        self.peer.snapshot = [row()]
        self.peer.runs[WEB] = ["web-deep"]
        self.peer.deep["web-deep"] = "running"
        self.scan()
        user, = self.users()
        mirror, = self.replies()
        # V1's existing timer-parent shape: "[Timer: 🖥️ (web)]" then the owner's text.
        self.assertEqual((user["origin"], user["source"], user["timerSourceId"], user["text"]),
                         ("timer", "orkestr-v2-timer", "web", LABEL))
        self.assertEqual(user["publicMessageId"], "v2timer-" + user["id"])
        self.assertEqual(mirror["text"], "Deploy the window change")
        self.assertEqual(mirror["parentMessageId"], user["id"])
        self.assertEqual(self.ledger.health()["webAnswersAwaited"], 1)
        self.assertIsNone(self.ledger.next_input(), "never in the serial WhatsApp queue")
        self.assertNotIn("/messages", [r for r, _ in self.peer.mutations])
        self.peer.answer("web-deep", "Deployed.")
        self.scan()
        users, replies = self.users(), self.replies()
        self.assertEqual(len(users), 2)
        self.assertEqual(users[1]["text"], LABEL + " ↩ Deploy the window change")
        self.assertEqual(replies[-1]["text"], "Deployed.")
        self.assertEqual(replies[-1]["parentMessageId"], users[1]["id"])
        self.assertEqual(self.ledger.health()["webAnswersAwaited"], 0)
        # The adapter never opens a window or accepts a run for web input.
        self.assertEqual([r for r, _ in self.peer.mutations if r in ("/window", "/accept", "/messages")], [])
        for message in replies:
            parent = next(u for u in users if u["id"] == message["parentMessageId"])
            done = self.ledger.acknowledge(message["id"], {"outcome": "delivered", "outboxJobId": "job",
                                                           "parentPublicMessageId": parent["publicMessageId"]})
            self.assertTrue(done["settled"])
        self.assertEqual(self.ledger.messages(), [])

    def test_replay_and_restart_adopt_nothing_new(self):
        self.ledger.set_web_cursor(10)
        self.peer.snapshot = [row()]
        self.scan()
        first = self.ledger.messages()
        self.ledger.set_web_cursor(10)  # lost cursor write: the same rows are read again
        restarted = Worker(self.peer, Ledger(Path(self.temp.name) / "ledger.sqlite3", SCOPE))
        restarted._web_checked = None
        restarted.run_once(_Stop())
        self.assertEqual(self.ledger.messages(), first)
        self.assertEqual(self.ledger.health()["webAnswersAwaited"], 1)

    def test_whatsapp_and_unmarked_messages_never_echo(self):
        # The adapter's own WhatsApp input (admitted as Core message "message")
        # is never mirrored back, even if a server marked it web.
        self.ledger.enqueue({"publicThreadId": "v1-thread", "publicMessageId": "wa-1", "chatId": "chat@g.us",
                             "accountId": "account", "text": "from WhatsApp"})
        self.worker.step(self.ledger.next_input())
        self.ledger.set_web_cursor(10)
        own = row(message_id="message", sequence=11, text="from WhatsApp")
        self.peer.snapshot = [own, row(message_id=WEB2, sequence=12, origin=None, text="timer or API"),
                              row(message_id=WEB2, sequence=13, origin="timer", text="timer")]
        before = self.ledger.messages()
        self.scan()
        self.assertEqual(self.ledger.messages(), before)
        self.assertEqual(self.ledger.web_cursor(), 13)

    def test_no_reply_answer_and_failed_run_settle_silently(self):
        self.ledger.set_web_cursor(10)
        self.peer.snapshot = [row(), row(message_id=WEB2, sequence=12, text="second")]
        self.peer.runs = {WEB: ["deep-a"], WEB2: ["deep-b"]}
        self.peer.answer("deep-a", "NO_REPLY")
        self.peer.deep["deep-b"] = "failed"
        self.scan()
        self.assertEqual([m["text"] for m in self.replies()], ["Deploy the window change", "second"])
        self.assertEqual(self.ledger.health()["webAnswersAwaited"], 0)

    def test_message_without_run_is_dropped_once_windows_close(self):
        self.ledger.set_web_cursor(10)
        self.peer.snapshot = [row()]
        self.scan()
        watch, = self.ledger.web_watches()
        watch["since"] -= worker_module.WEB_NO_RUN_GRACE_S + 1
        self.ledger.save_web_watch(watch)
        self.scan()
        self.assertEqual(len(self.ledger.web_watches()), 1, "a window is still open")
        self.peer.window_state = "closed"
        self.scan()
        self.assertEqual(self.ledger.web_watches(), [])

    def test_answer_wait_is_bounded(self):
        self.ledger.set_web_cursor(10)
        self.peer.snapshot = [row()]
        self.peer.runs[WEB] = ["deep-a"]
        self.peer.deep["deep-a"] = "awaiting_acceptance"
        self.scan()
        watch, = self.ledger.web_watches()
        watch["since"] -= worker_module.WEB_ANSWER_MAX_S + 1
        self.ledger.save_web_watch(watch)
        self.scan()
        self.assertEqual(self.ledger.web_watches(), [])

    def test_two_messages_in_one_window_each_get_their_own_answer(self):
        self.ledger.set_web_cursor(10)
        self.peer.snapshot = [row(), row(message_id=WEB2, sequence=12, text="and also this")]
        self.peer.runs = {WEB: ["deep-a"], WEB2: ["deep-b"]}
        self.peer.answer("deep-a", "first answer")
        self.peer.answer("deep-b", "second answer")
        self.scan()
        texts = [m["text"] for m in self.replies()]
        self.assertEqual(texts.count("first answer"), 1)
        self.assertEqual(texts.count("second answer"), 1)

    def test_progress_only_with_the_binding_flag(self):
        self.ledger.set_web_cursor(10)
        self.peer.snapshot = [row()]
        self.peer.runs[WEB] = ["deep-a"]
        self.peer.deep["deep-a"] = "running"
        self.peer.payloads["p-deep-a"] = {"run_id": "deep-a", "payload_id": "p-deep-a", "text": "halfway."}
        self.scan()
        watch, = self.ledger.web_watches()
        watch["since"] -= 120
        self.ledger.save_web_watch(watch)
        self.scan()
        self.assertNotIn("halfway.", [m["text"] for m in self.replies()])
        self.worker.progress_updates = True
        self.scan()
        self.assertIn("halfway.", [m["text"] for m in self.replies()])
        self.scan()
        self.assertEqual([m["text"] for m in self.replies()].count("halfway."), 1)

    def test_app_attachment_notes_become_names_or_a_count(self):
        text = ("see these\n\n[Files attached in the Orkestr app, stored in this conversation's attachment store, "
                "manifest 1:\n- plan.pdf (application/pdf, 10 bytes, reference r1, local file /x/y)\n"
                "- shot.png (image/png, 5 bytes, reference r2)]")
        self.assertEqual(self.worker.web_text(text), "see these\n\n\U0001f4ce 2 file(s) attached in the app")
        self.worker.attachments = True
        self.assertEqual(self.worker.web_text(text), "see these\n\n\U0001f4ce plan.pdf, shot.png")
        self.assertTrue(self.worker.web_text("x" * 5000).endswith("…"))

    def test_paused_binding_does_not_poll(self):
        self.ledger.set_web_cursor(10)
        self.peer.snapshot = [row()]
        stops = iter([False, True])

        class Once:
            def wait(self, _):
                return next(stops)
        self.worker.run(Once(), active=lambda: False)
        self.assertEqual(self.ledger.messages(), [])


if __name__ == "__main__":
    unittest.main()
