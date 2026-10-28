import contextlib
import copy
import io
from pathlib import Path
import tempfile
import unittest

import hashlib
from unittest.mock import patch

from v2.compat.v1_runtime import worker as worker_module
from v2.compat.v1_runtime.ledger import Ledger
from v2.compat.v1_runtime.worker import Refused, Worker
from v2.compat.v1_runtime.rust_client import ClientError


class Peer:
    conversation = "conversation"
    owner = "owner"

    def __init__(self):
        self.accepted, self.mutations = {}, []
        self.lose_deep_response = False
        self.foreign = False
        self.busy = False
        self.saved_window = None
        self.reply_settings = dict(prefix=None, footer=None, honor_no_reply=True)
        self.render_missing = False
        self.triggers, self.outcome = [], None
        # Core's owner retire route: None answers 409 (Core still owns the
        # input: a run, an open window or a queued intent references it).
        self.retire_state = None
        # Core's held inputs (an owner stop). Like real Core, retiring a held
        # queued row is still allowed: the adapter itself must refuse.
        self.held = []
        self.window_queue = []  # Core's queued window requests (entries).

    def window_request(self, intake, input_key, request_key, current):
        return dict(request_key=request_key, input_message_id=intake["message_id"], input_event_id=intake["event_id"],
                    input_request_key=input_key, expected_generation=0, window_id=None, predecessor_window_id=None)

    def read_events(self, after, maximum):
        return [event for event in [{"sequence": 2, "run_id": "fast-run"},
                                    {"sequence": 3, "run_id": "deep-run"}] if event["sequence"] > after][:maximum]

    def matching_run_ids(self, events, intake):
        return [] if self.foreign else ["fast-run", "deep-run"]

    def request(self, method, route, body=None, allowed=(200,)):
        if route == "/timer-triggers":
            self.triggers.append(copy.deepcopy(body))
            return 200, {"accepted": 0}
        if route == "/timer-outcomes":
            self.outcomes = getattr(self, "outcomes", []) + [copy.deepcopy(body)]
            if self.outcome is None:
                raise ClientError("unexpected_status", 404)
            return 200, self.outcome(body)
        if method == "POST":
            self.mutations.append((route, copy.deepcopy(body)))
        if method == "POST" and route.startswith("/inputs/") and route.endswith("/retire"):
            if self.retire_state is None:
                raise ClientError("unexpected_status", 409)
            return 200, dict(message_id=route.split("/")[2], state=self.retire_state, retirement_id="retirement")
        if method == "GET" and route == "/window/queue":
            return 200, dict(conversation_id=self.conversation, capacity=4, active=1,
                             queued_total=len(self.window_queue), entries=list(self.window_queue))
        if method == "GET" and route == "/held-inputs":
            return 200, dict(schema_version=1, conversation_id=self.conversation, revision=1, observed_at_ms=1,
                             held=[dict(message_id=m) for m in self.held], next_after_sequence=None,
                             eligible_input_available=False)
        if method == "GET" and route == "":
            return 200, dict(conversation_id=self.conversation, last_sequence=getattr(self, "head", 3))
        if route == "/messages":
            return 202, dict(status="accepted", message_id="message", event_id="event", sequence=1)
        if route == "/window" and method == "GET":
            return 204, None
        if route == "/window":
            if self.busy:
                return 409, {"error": "window_busy"}
            self.saved_window = dict(body, status=dict(conversation_id=self.conversation, state="active", generation=1,
                                                       window_id="window", predecessor_window_id=None))
            return 201, self.saved_window
        path, _, query = route.partition("?run_id=")
        if path in ("/execution", "/fast/execution"):
            role = "fast" if route.startswith("/fast") else "deep"
            if query and query != role + "-run":
                return 404, {"code": "not_found"}
            status = dict(run_id=role + "-run", revision=len(self.accepted) + 10,
                phase="completed" if role in self.accepted else "awaiting_acceptance",
                acceptance_candidate=dict(run_id=role + "-run", completion_event_id=role + "-completion"),
                progress=dict(payload_id=role + "-payload"))
            if role in getattr(self, "models", {}):
                status["models"] = self.models[role]
            return 200, status
        if route.startswith("/payloads/"):
            role = "fast" if "fast" in route else "deep"
            return 200, dict(run_id=role + "-run", payload_id=role + "-payload", text="NO_REPLY" if role == "fast" else role + " result")
        if route == "/accept":
            role = body["run_id"].split("-")[0]
            receipt = self.accepted.setdefault(role, dict(body, requested_revision=body["expected_revision"],
                revision=body["expected_revision"] + 1, outcome="succeeded", acceptance_event_id=role + "-accepted"))
            if role == "deep" and self.lose_deep_response:
                self.lose_deep_response = False
                raise ConnectionError("synthetic lost commit response")
            return 200, receipt
        if route == "/settings" and method == "GET" and getattr(self, "settings", None):
            return 200, self.settings
        if route == "/settings/render":
            if self.render_missing:
                raise ClientError("unexpected_status", 404)
            text, rules = body["text"], self.reply_settings
            if rules["honor_no_reply"] and text.strip() == "NO_REPLY":
                return 200, dict(settings_revision=1, outcome="suppressed", reason="no_reply")
            if rules["prefix"] and not text.lower().startswith(rules["prefix"].lower()):
                text = rules["prefix"] + " " + text
            if rules["footer"]:
                text += "\n\n" + rules["footer"]
            return 200, dict(settings_revision=1, outcome="deliver", text=text)
        if route.startswith("/accepted-results?"):
            return 200, dict(results=[dict(run_id=role + "-run", completion_event_id=role + "-completion",
                acceptance_event_id=role + "-accepted", payload_id=role + "-payload", payload_removed=False)
                for role in self.accepted], next_after_sequence=None)
        raise AssertionError(route)


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ledger = Ledger(Path(self.temp.name) / "ledger.sqlite3", {"test_scope": "one"})
        self.data, _ = self.ledger.enqueue(dict(publicMessageId="public", publicThreadId="thread", chatId="chat", accountId="account", text="request"))
        self.peer = Peer()
        self.worker = Worker(self.peer, self.ledger)

    def test_only_accepted_deep_is_exported(self):
        self.worker.step(self.data)
        self.assertEqual(self.data["phase"], "completed")
        messages = self.ledger.messages()
        self.assertEqual(messages[-1]["text"], "deep result")
        self.assertEqual(messages[-1]["id"], "deep-accepted")
        self.assertEqual(messages[-1]["parentMessageId"], self.data["remote_id"])
        self.assertEqual(len(self.peer.accepted), 2)
        self.assertNotIn("fast result", str(messages))

    def test_lost_acceptance_response_replays_exact_persisted_key(self):
        self.peer.lose_deep_response = True
        with self.assertRaises(ConnectionError):
            self.worker.step(self.data)
        resumed = self.ledger.next_input()
        self.assertNotIn("reply", resumed)
        self.worker.step(resumed)
        deep_calls = [body for route, body in self.peer.mutations if route == "/accept" and body["run_id"] == "deep-run"]
        self.assertEqual(len(deep_calls), 2)
        self.assertEqual(deep_calls[0], deep_calls[1])
        self.assertEqual(len(self.peer.accepted), 2)
        self.assertEqual(len([m for m in self.ledger.messages() if m["role"] == "assistant"]), 1)

    def test_active_second_generation_retains_original_predecessor(self):
        current = dict(conversation_id="conversation", state="active", generation=2,
                       window_id="second-window", predecessor_window_id="first-window")
        original = self.peer.request
        def request(method, route, **kwargs):
            if route == "/window" and method == "GET":
                return 200, current
            if route == "/window" and method == "POST":
                self.peer.mutations.append((route, copy.deepcopy(kwargs["body"])))
                return 200, dict(kwargs["body"], status=current)
            return original(method, route, **kwargs)
        self.peer.request = request
        def window_request(intake, input_key, request_key, observed):
            self.assertEqual(observed, current)
            return dict(request_key=request_key, input_message_id=intake["message_id"], input_event_id=intake["event_id"],
                        input_request_key=input_key, expected_generation=2, window_id="second-window", predecessor_window_id=None)
        self.peer.window_request = window_request
        self.worker.step(self.data)
        self.assertEqual(self.data["phase"], "completed")

    def test_foreign_status_without_source_evidence_never_accepts(self):
        self.peer.foreign = True
        self.worker.step(self.data)
        self.assertEqual(self.peer.accepted, {})
        self.assertNotIn("reply", self.data)

    def test_busy_window_is_retained_and_retried_without_forced_stop(self):
        self.peer.busy = True
        self.worker.step(self.data)
        self.assertEqual(self.data["phase"], "waiting_for_window")
        self.peer.busy = False
        self.worker.step(self.ledger.next_input())
        attempts = [body for route, body in self.peer.mutations if route == "/window"]
        self.assertEqual(attempts[0], attempts[1])
        self.assertFalse(any("stop" in route for route, _ in self.peer.mutations))

    def test_lost_intake_and_window_responses_keep_exact_mutation_keys(self):
        for dropped in ("/messages", "/window"):
            with self.subTest(route=dropped):
                data, _ = self.ledger.enqueue(dict(publicMessageId=dropped, publicThreadId="thread", chatId="chat", accountId="account", text="request"))
                peer = Peer()
                worker = Worker(peer, self.ledger)
                original = peer.request
                lost = [False]
                def request(method, route, **kwargs):
                    response = original(method, route, **kwargs)
                    if method == "POST" and route == dropped and not lost[0]:
                        lost[0] = True
                        raise ConnectionError("synthetic lost response")
                    return response
                peer.request = request
                with self.assertRaises(ConnectionError):
                    worker.step(data)
                # Read that exact row through a new SQLite connection, as on restart.
                import json
                with self.ledger.connect() as db:
                    resumed = json.loads(db.execute("SELECT data FROM inputs WHERE remote_id=?", (data["remote_id"],)).fetchone()[0])
                worker.step(resumed)
                attempts = [body for route, body in peer.mutations if route == dropped]
                self.assertEqual(len(attempts), 2)
                self.assertEqual(attempts[0], attempts[1])
                self.assertEqual(resumed["phase"], "completed")

    def test_terminal_and_definite_upstream_refusals_are_visible_and_do_not_retry(self):
        class Stop:
            def __init__(self):
                self.calls = 0
            def wait(self, duration):
                self.calls += 1
                return self.calls > 6
        for failure in ("cancelled", "blocked", "session_revoked"):
            with self.subTest(failure=failure):
                ledger = Ledger(Path(self.temp.name) / (failure + ".sqlite3"), {"test_scope": "one"})
                ledger.enqueue(dict(publicMessageId="public", publicThreadId="thread", chatId="chat", accountId="account", text="request"))
                peer = Peer()
                original = peer.request
                def request(method, route, **kwargs):
                    if route.split("?", 1)[0] == "/execution":
                        if failure == "session_revoked":
                            raise ClientError("session_revoked", 401)
                        return 200, dict(run_id="deep-run", phase=failure)
                    return original(method, route, **kwargs)
                peer.request = request
                stderr = io.StringIO()
                with contextlib.redirect_stderr(stderr):
                    Worker(peer, ledger).run(Stop())
                # Only this input's own Fast may be settled; a refused Deep never is.
                self.assertFalse(any(route == "/accept" and body["run_id"] == "deep-run"
                                     for route, body in peer.mutations))
                if failure == "session_revoked":
                    # A revoked owner session is not the input's fault: it waits
                    # for the restarted service instead of being refused.
                    pending = ledger.next_input()
                    self.assertEqual(pending["phase"], "running")
                    self.assertNotIn("refused", pending)
                    # ...but never silently: the operator is alerted once.
                    self.assertEqual(stderr.getvalue().count("ALERT orkestr-v2-wa-adapter session_revoked"), 1)
                    continue
                self.assertIsNone(ledger.next_input())
                notice = [m for m in ledger.messages() if m["role"] == "assistant"]
                self.assertEqual(len(notice), 1)
                self.assertEqual(notice[0]["kind"], "notice")
                # One silent automatic retry, then one honest notice (no resend request).
                self.assertEqual(notice[0]["refusal"], "deep_run_" + failure)
                self.assertNotIn("send it again", notice[0]["text"])
                self.assertIn("technical problem", notice[0]["text"])  # No author: member-safe.
                self.assertEqual(len([r for r, _ in peer.mutations if r == "/messages"]), 1)
                self.assertEqual(stderr.getvalue().count("ALERT orkestr-v2-wa-adapter input_refused"), 1)

    def test_mismatched_canonical_history_cannot_be_mirrored(self):
        original = self.peer.request
        def corrupt(method, route, **kwargs):
            if route.startswith("/accepted-results?"):
                return 200, {"results": [], "next_after_sequence": None}
            return original(method, route, **kwargs)
        self.peer.request = corrupt
        with self.assertRaisesRegex(Refused, "accepted_history_mismatch"):
            self.worker.step(self.data)
        self.assertNotIn("reply", self.ledger.next_input())


class ExtensionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ledger = Ledger(Path(self.temp.name) / "ledger.sqlite3", {"test_scope": "one"})
        self.peer = Peer()

    def enqueue(self, **body):
        base = dict(publicMessageId="public", publicThreadId="thread", chatId="chat", accountId="account", text="request")
        return self.ledger.enqueue(dict(base, **body))[0]

    def test_final_reply_uses_conversation_reply_settings(self):
        self.peer.reply_settings = dict(prefix="orkestr:", footer="-- v2", honor_no_reply=True)
        Worker(self.peer, self.ledger).step(self.enqueue())
        final = self.ledger.messages()[-1]
        self.assertEqual(final["text"], "orkestr: deep result\n\n-- v2")
        self.assertNotIn("noReply", final)
        self.assertIn(("/settings/render", {"text": "deep result"}), self.peer.mutations)

    def test_render_route_absent_keeps_v1_no_reply_rule(self):
        self.peer.render_missing = True
        Worker(self.peer, self.ledger).step(self.enqueue())
        self.assertEqual(self.ledger.messages()[-1]["text"], "deep result")
        peer = Peer()
        peer.render_missing = True
        original = peer.request
        def request(method, route, **kwargs):
            status, value = original(method, route, **kwargs)
            if route == "/payloads/deep-payload":
                value = dict(value, text="NO_REPLY")
            return status, value
        peer.request = request
        ledger = Ledger(Path(self.temp.name) / "fallback.sqlite3", {"test_scope": "one"})
        data = ledger.enqueue(dict(publicMessageId="public", publicThreadId="thread", chatId="chat",
                                   accountId="account", text="request"))[0]
        Worker(peer, ledger).step(data)
        final = ledger.messages()[-1]
        self.assertEqual((final["text"], final["noReply"]), ("NO_REPLY", True))

    def test_exact_no_reply_final_is_exported_as_silent(self):
        original = self.peer.request
        def request(method, route, **kwargs):
            status, value = original(method, route, **kwargs)
            if route == "/payloads/deep-payload":
                value = dict(value, text="  NO_REPLY\n")
            return status, value
        self.peer.request = request
        data = self.enqueue()
        Worker(self.peer, self.ledger).step(data)
        final = self.ledger.messages()[-1]
        self.assertEqual((final["text"], final["noReply"]), ("NO_REPLY", True))

    def test_progress_is_exported_only_when_enabled_for_the_matched_running_deep_run(self):
        for enabled in (False, True):
            with self.subTest(enabled=enabled):
                ledger = Ledger(Path(self.temp.name) / ("p%s.sqlite3" % enabled), {"test_scope": "one"})
                data = ledger.enqueue(dict(publicMessageId="public", publicThreadId="thread", chatId="chat",
                                           accountId="account", text="request"))[0]
                peer, phase = Peer(), ["running:p1"]
                original = peer.request
                def request(method, route, **kwargs):
                    if route.split("?", 1)[0] == "/execution" and phase[0].startswith("running"):
                        return 200, dict(run_id="deep-run", revision=1, phase="running",
                                         progress=dict(payload_id=phase[0].split(":")[1]))
                    if route in ("/payloads/p1", "/payloads/p2", "/payloads/p3"):
                        payload = route.rsplit("/", 1)[1]
                        return 200, dict(run_id="deep-run", payload_id=payload,
                                         text="NO_REPLY" if payload == "p2" else "working on " + payload + ".")
                    return original(method, route, **kwargs)
                peer.request = request
                worker = Worker(peer, ledger, progress_updates=enabled)
                with patch.object(worker_module, "PROGRESS_INTERVAL_S", 0):
                    for step in ("running:p1", "running:p1", "running:p2", "running:p3", "done"):
                        phase[0] = step
                        worker.step(ledger.next_input() or data)
                rows = ledger.messages()
                progress = [r["text"] for r in rows if r.get("kind") == "progress"]
                self.assertEqual(progress, ["working on p1.", "working on p3."] if enabled else [])
                self.assertEqual(rows[-1]["text"], "deep result")
                self.assertTrue(all(r["parentMessageId"] == data["remote_id"] for r in rows[1:]))

    def test_async_questions_are_sent_at_once_as_their_own_messages_never_as_the_final(self):
        # PA gen 22: two `request_user_input_async` questions, then the final.
        q1, q2, plain, foreign = ("b0000000-0000-4000-8000-00000000000%d" % n for n in range(1, 5))
        def ref(sequence, run, payload):
            return {"sequence": sequence, "schema_version": 8, "payload_ref_or_safe_payload": {
                "kind": "provider_observed", "run_id": run, "observation": {"kind": "progress_ref", "payload_id": payload}}}
        self.peer.read_events = lambda after, maximum: [
            ref(2, "deep-run", q1), ref(3, "deep-run", plain), ref(4, "other-run", foreign), ref(5, "deep-run", q2)]
        texts = {q1: worker_module.QUESTION_PREFIX + "Where is the German passport scan?",
                 q2: worker_module.QUESTION_PREFIX + "Did you show both passports?",
                 plain: "Searching Gmail.", foreign: worker_module.QUESTION_PREFIX + "Not this input."}
        fetched, original = [], self.peer.request
        def request(method, route, **kwargs):
            payload = route.rsplit("/", 1)[1]
            if route.startswith("/payloads/") and payload in texts:
                fetched.append(payload)
                return 200, dict(run_id="other-run" if payload == foreign else "deep-run", payload_id=payload,
                                 text=texts[payload])
            return original(method, route, **kwargs)
        self.peer.request = request
        data = self.enqueue()
        worker = Worker(self.peer, self.ledger)  # progress_updates off: questions still go out
        worker.step(data)
        worker.step(self.ledger.next_input() or data)
        rows = self.ledger.messages()
        replies = [r for r in rows if r["role"] == "assistant"]
        bare = {q: texts[q][len(worker_module.QUESTION_PREFIX):] for q in (q1, q2)}
        questions = [r["text"] for r in replies if r["text"] in bare.values()]
        self.assertEqual(questions, [bare[q1], bare[q2]])
        self.assertFalse(any(worker_module.QUESTION_PREFIX in r["text"] for r in replies),
                         "V1 renders the question header; the post text must not repeat it")
        # Each question has its own pseudo parent; only the Deep result answers the input.
        finals = [r for r in replies if r["parentMessageId"] == data["remote_id"]]
        self.assertEqual([r["text"] for r in finals], ["deep result"])
        self.assertTrue(all(r["parentMessageId"] != data["remote_id"] for r in replies if r["text"] in questions))
        self.assertEqual(sorted(fetched), sorted([q1, plain, q2]), "each payload once, foreign runs never")
        self.assertNotIn(texts[foreign], str(rows))

    def test_progress_from_a_foreign_run_is_ignored(self):
        data = self.enqueue()
        worker = Worker(self.peer, self.ledger, progress_updates=True)
        with patch.object(worker_module, "PROGRESS_INTERVAL_S", 0):
            worker.capture_progress(data, dict(run_id="other-run", phase="running", progress=dict(payload_id="x")),
                                    {"deep-run"})
        self.assertEqual(len(self.ledger.messages()), 1)

    def test_attachments_are_imported_once_with_a_frozen_request_before_intake(self):
        content = b"synthetic bytes"
        digest = hashlib.sha256(content).hexdigest()
        upload, _ = self.ledger.stage_upload("public", "note.txt", "text/plain", content, digest)
        data = self.enqueue(text="see file", attachments=[{"uploadId": upload, "sha256": digest}])
        imports, lost = [], [True]
        def import_attachments(request):
            imports.append(copy.deepcopy(request))
            if lost[0]:
                lost[0] = False
                raise ConnectionError("synthetic lost import response")
            return {"import_id": "import", "manifest": request["target_manifest"], "mapping": request["mapping"],
                    "source_manifest_id": request["source"]["manifest"]["manifest_id"]}
        self.peer.import_attachments = import_attachments
        worker = Worker(self.peer, self.ledger)
        with self.assertRaises(ConnectionError):
            worker.step(data)
        worker.step(self.ledger.next_input())
        self.assertEqual(len(imports), 2)
        self.assertEqual(imports[0], imports[1])
        self.assertEqual(bytes(imports[0]["source"]["contents"][0]["bytes"]), content)
        target = imports[0]["target_manifest"]
        self.assertEqual((target["owner_id"], target["conversation_id"]), ("owner", "conversation"))
        self.assertIsNone(target["references"][0]["message_id"])
        intake = [body for route, body in self.peer.mutations if route == "/messages"][0]
        self.assertTrue(intake["text"].startswith("see file\n\n[WhatsApp attachments"))
        self.assertIn(target["references"][0]["reference_id"], intake["text"])
        self.assertIsNone(self.ledger.upload_bytes(upload))

    def test_missing_attachment_bytes_block_instead_of_dropping_the_file(self):
        content = b"x"
        digest = hashlib.sha256(content).hexdigest()
        upload, _ = self.ledger.stage_upload("public", "a.bin", "application/octet-stream", content, digest)
        data = self.enqueue(attachments=[{"uploadId": upload, "sha256": digest}])
        self.ledger.release_uploads([upload])
        with self.assertRaisesRegex(Refused, "attachment_bytes_missing"):
            Worker(self.peer, self.ledger).step(data)
        self.assertFalse(any(route == "/messages" for route, _ in self.peer.mutations))

    def test_final_reply_does_not_infer_the_actual_model_from_settings(self):
        self.peer.settings = dict(provider="codex", model="gpt-6-astra", revision=3)
        Worker(self.peer, self.ledger).step(self.enqueue())
        final = self.ledger.messages()[-1]
        self.assertNotIn("provider", final)
        self.assertEqual(final["model"], "unreported")

    def test_deep_final_carries_its_inputs_quick_identity_for_the_footer(self):
        # The fixture's run ids are not exact-run UUIDs, so the identity itself
        # is covered in test_model_identity; here: the final carries it.
        from unittest import mock
        from v2.compat.v1_runtime import worker as worker_module
        seen = []
        def quick(call, data, fast_status=None):
            seen.append((data["remote_id"], (fast_status or {}).get("run_id")))
            return {"quickProvider": "codex", "quickModel": "quick-model"}
        with mock.patch.object(worker_module, "quick_identity", quick):
            data = self.enqueue()
            Worker(self.peer, self.ledger).step(data)
        final = self.ledger.messages()[-1]
        self.assertEqual(final["phase"], "final_answer")
        self.assertEqual((final["quickProvider"], final["quickModel"]), ("codex", "quick-model"))
        self.assertEqual(seen, [(data["remote_id"], "fast-run")])
        # A failing lookup never holds up the final.
        def broken(*_args, **_kwargs):
            raise RuntimeError("synthetic")
        ledger = Ledger(Path(self.temp.name) / "second.sqlite3", {"test_scope": "one"})
        second, _ = ledger.enqueue(dict(publicMessageId="public", publicThreadId="thread", chatId="chat", accountId="account", text="request"))
        with mock.patch.object(worker_module, "quick_identity", broken):
            Worker(Peer(), ledger).step(second)
        self.assertEqual(ledger.messages()[-1]["phase"], "final_answer")
        self.assertNotIn("quickModel", ledger.messages()[-1])

    def test_final_reply_without_settings_route_omits_provider(self):
        Worker(self.peer, self.ledger).step(self.enqueue())
        self.assertNotIn("provider", self.ledger.messages()[-1])

    def test_attachments_are_exported_as_files_named_in_the_intake_note(self):
        content = b"\x89PNG synthetic"
        digest = hashlib.sha256(content).hexdigest()
        upload, _ = self.ledger.stage_upload("public", "photo.png", "image/png", content, digest)
        data = self.enqueue(text="what is this", attachments=[{"uploadId": upload, "sha256": digest}])
        self.peer.import_attachments = lambda request: {"import_id": "import"}
        export = Path(self.temp.name) / "media"
        Worker(self.peer, self.ledger, attachment_dir=str(export)).step(data)
        path = export / "conversation" / (digest + ".png")
        self.assertEqual(path.read_bytes(), content)
        self.assertEqual(path.stat().st_mode & 0o777, 0o640)
        intake = [body for route, body in self.peer.mutations if route == "/messages"][0]
        self.assertIn("local file %s)" % path, intake["text"])
        self.assertIsNone(self.ledger.upload_bytes(upload))

    def test_unwritable_export_directory_keeps_the_reference_only_note(self):
        content = b"x"
        digest = hashlib.sha256(content).hexdigest()
        upload, _ = self.ledger.stage_upload("public", "a.png", "image/png", content, digest)
        data = self.enqueue(attachments=[{"uploadId": upload, "sha256": digest}])
        self.peer.import_attachments = lambda request: {"import_id": "import"}
        blocker = Path(self.temp.name) / "file"
        blocker.write_text("not a directory")
        Worker(self.peer, self.ledger, attachment_dir=str(blocker)).step(data)
        intake = [body for route, body in self.peer.mutations if route == "/messages"][0]
        self.assertNotIn("local file", intake["text"])
        self.assertIn("reference", intake["text"])


if __name__ == "__main__":
    unittest.main()
