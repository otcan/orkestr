"""Authenticated machine input stays internal; its real business answer sends."""
import hashlib
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from v2.compat.v1_runtime import internal_context
from v2.compat.v1_runtime.worker import Worker
from v2.compat.v1_runtime.tests.test_timer_relay import Base, _Stop
from v2.compat.v1_runtime.tests.test_web_mirror import WebPeer, WEB, row


@unittest.skipUnless(os.geteuid() == 0, "Root-owned context registry")
class InternalContextTests(Base):
    def setUp(self):
        super().setUp()
        self.peer = WebPeer()
        self.peer.conversation = "a1000000-0000-4000-8000-000000000008"
        self.worker = Worker(self.peer, self.ledger, legacy_companions=True)
        self.registry = Path(self.temp.name) / "internal-contexts"
        self.registry.mkdir(mode=0o700)
        self.worker.internal_context_dir = str(self.registry)
        self.ledger.set_web_cursor(10)
        self.message = row(text="Result artifact for operation a1000000-0000-4000-8000-000000000009")
        self.peer.snapshot = [self.message]
        self.peer.runs[WEB] = ["callback-deep"]
        self.peer.deep["callback-deep"] = "running"

    def register(self, conversation=None):
        digest = hashlib.sha256(self.message["text"].encode()).hexdigest()
        value = {"format": internal_context.FORMAT, "conversation_id": conversation or self.peer.conversation,
                 "text_sha256": digest, "operation_id": "a1000000-0000-4000-8000-000000000009",
                 "artifact_sha256": "a" * 64}
        path = self.registry / (digest + ".json")
        path.write_text(json.dumps(value))
        path.chmod(0o400)
        return path

    def scan(self):
        self.worker._web_checked = None
        self.worker.run_once(_Stop())

    def test_registered_context_is_not_exported_but_accepted_business_answer_is_delivered(self):
        self.register()
        self.scan()
        self.assertEqual(self.ledger.messages(), [], "neither input echo nor synthetic parent is visible")
        self.assertEqual(self.ledger.health()["webAnswersAwaited"], 1)
        self.peer.answer("callback-deep", "The reference is ready; the existing budget is unchanged.")
        self.scan()
        messages = self.ledger.messages()
        answer, = [m for m in messages if m["role"] == "assistant"]
        parent, = [m for m in messages if m["role"] == "user"]
        self.assertEqual(answer["text"], "The reference is ready; the existing budget is unchanged.")
        self.assertEqual(parent["text"], "Task update")
        self.assertEqual(parent["timerSourceId"], "task-update")
        self.assertNotIn("artifact", json.dumps(messages))
        self.assertNotIn("operation", json.dumps(messages))
        self.assertTrue(self.ledger.acknowledge(answer["id"], {
            "outcome": "delivered", "outboxJobId": "normal-delivery", "parentPublicMessageId": parent["publicMessageId"]})["settled"])
        self.assertEqual(self.ledger.messages(), [])
        self.assertEqual(self.ledger.health()["webAnswersAwaited"], 0)
        self.assertFalse([r for r, _ in self.peer.mutations if r in ("/window", "/messages", "/accept")],
                         "delivery watch never admits or accepts execution")

    def test_restart_and_cursor_replay_do_not_duplicate_business_reply(self):
        self.register()
        self.peer.answer("callback-deep", "Finished.")
        self.scan()
        before = self.ledger.messages()
        self.ledger.set_web_cursor(10)
        self.worker = Worker(self.peer, self.ledger, legacy_companions=True)
        self.worker.internal_context_dir = str(self.registry)
        self.scan()
        self.assertEqual(self.ledger.messages(), before)

    def test_useful_deep_progress_and_final_are_exported_once_without_tool_input(self):
        self.register()
        self.worker.progress_updates = True
        self.peer.payloads['p-callback-deep'] = {'run_id': 'callback-deep', 'payload_id': 'p-callback-deep',
                                                'text': 'The reference is rendering.'}
        with patch('v2.compat.v1_runtime.worker.PROGRESS_INTERVAL_S', 0), patch('v2.compat.v1_runtime.outbound_text.PROGRESS_SETTLE_S', 0):
            self.scan()
            self.assertEqual(self.ledger.messages(), [], 'input and unsettled progress stay internal')
            self.scan()
            self.scan()
        replies = [m for m in self.ledger.messages() if m['role'] == 'assistant']
        self.assertEqual([m['text'] for m in replies], ['The reference is rendering.'])
        self.peer.answer('callback-deep', 'The reference is ready.')
        self.scan()
        self.scan()
        messages = self.ledger.messages()
        self.assertEqual([m['text'] for m in messages if m['role'] == 'assistant'],
                         ['The reference is rendering.', 'The reference is ready.'])
        self.assertTrue(all(m['timerSourceId'] == 'task-update' for m in messages if m['role'] == 'user'))
        self.assertNotIn(self.message['text'], [m['text'] for m in messages])

    def test_unregistered_json_or_matching_english_text_is_an_ordinary_message(self):
        text = self.message["text"] + '\n{"status":"verified","result":"business data"}'
        self.message["text"] = text
        self.worker.discover_web()
        self.assertTrue(any(m.get("text") == text for m in self.ledger.messages()))

    def test_other_conversation_record_does_not_hide_owner_message(self):
        self.register("a1000000-0000-4000-8000-000000000099")
        self.worker.discover_web()
        self.assertTrue(any(m.get("text") == self.message["text"] for m in self.ledger.messages()))

    def test_writable_symlink_and_corrupt_records_fail_before_echo_or_cursor_advance(self):
        path = self.register()
        path.chmod(0o600)
        with self.assertRaises(ValueError):
            self.worker.discover_web()
        path.chmod(0o400)
        original = path.with_suffix(".original")
        path.rename(original)
        path.symlink_to(original)
        with self.assertRaises(OSError):
            self.worker.discover_web()
        path.unlink()
        path.write_text("{}")
        path.chmod(0o400)
        with self.assertRaises(ValueError):
            self.worker.discover_web()
        self.assertEqual(self.ledger.messages(), [])
        self.assertEqual(self.ledger.web_cursor(), 10)

    def test_non_root_or_writable_registry_is_not_a_presentation_authority(self):
        self.register()
        self.registry.chmod(0o777)
        with self.assertRaises(ValueError):
            self.worker.discover_web()
        self.registry.chmod(0o700)
        os.chown(self.registry, 65534, 65534)
        try:
            with self.assertRaises(ValueError):
                self.worker.discover_web()
        finally:
            os.chown(self.registry, 0, 0)
        self.assertEqual(self.ledger.messages(), [])

    def test_no_accepted_deep_payload_never_manufactures_business_result(self):
        self.register()
        self.peer.deep["callback-deep"] = "completed"
        self.scan()
        self.assertEqual(self.ledger.messages(), [])

    def test_no_registry_configuration_preserves_current_behavior(self):
        self.register()
        self.worker.internal_context_dir = None
        self.scan()
        self.assertTrue(any(m.get("text") == self.message["text"] for m in self.ledger.messages()))
