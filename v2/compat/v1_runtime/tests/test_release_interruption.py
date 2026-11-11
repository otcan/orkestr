"""A Root-recorded release interruption continues the stopped Deep turn once,
like a deadline stop; without a valid record a stop keeps today's meaning."""
import json
import os
from pathlib import Path
import time
import unittest
from unittest.mock import patch

from v2.compat.v1_runtime import config as config_module, notices, release_interruption
from v2.compat.v1_runtime.notices import TEMPLATES
from v2.compat.v1_runtime.worker import CONTINUE_PREFIX, RELEASE_NOTICE, RELEASE_PREFIX, Refused
from v2.compat.v1_runtime.tests.test_window_continuation import Case

SOURCE = "c" * 40


class Recorded(Case):
    def setUp(self):
        super().setUp()
        uid = patch.object(release_interruption, "OWNER_UID", os.geteuid())
        uid.start()
        self.addCleanup(uid.stop)
        self.records = Path(self.temp.name) / "release-interruptions"
        self.records.mkdir(mode=0o700)
        self.worker.release_interruption_dir = str(self.records)

    def record(self, run_id="deep-run", conversation=None, mode=0o400, **change):
        value = dict(format=release_interruption.FORMAT, conversation_id=conversation or self.peer.conversation,
                     run_id=run_id, release_source=SOURCE, interrupted_at_ms=int(time.time() * 1000))
        value.update(change)
        path = self.records / (run_id + ".json")
        path.write_text(json.dumps(value))
        path.chmod(mode)
        return path

    def stop_before_deadline(self):
        # The cut: Deep cancelled while the window still had work time left.
        self.peer.deep_phase = "cancelled"
        self.peer.current = dict(window_id="window", state="active", conversation_id="conversation",
                                 work_deadline_ms=int(time.time() * 1000) + 600_000)

    def assert_todays_refusal(self):
        with self.assertRaisesRegex(Refused, "deep_run_cancelled"):
            self.settle_terminal(self.data)
        self.assertEqual(self.notices(), [])
        self.assertNotIn("continued", self.ledger.next_input())


class ReleaseContinuationTests(Recorded):
    def test_recorded_release_stop_continues_once_with_one_notice_and_no_alert(self):
        self.record()
        self.stop_before_deadline()
        original = dict(self.data["keys"])
        self.worker.step(self.data)  # No Refused: no alert path.
        resumed = self.ledger.next_input()
        self.assertEqual(resumed["phase"], "queued")
        self.assertTrue(resumed["intake_text"].startswith(RELEASE_PREFIX))
        self.assertFalse(resumed["intake_text"].startswith(CONTINUE_PREFIX))
        self.assertTrue(resumed["intake_text"].endswith("request"))
        self.assertEqual(resumed["continued"]["cause"], "release")
        self.assertEqual(resumed["continuation_guard"]["source_run_id"], "deep-run")
        self.assertTrue(all(resumed["keys"][k] != original[k] for k in ("message", "window", "fast", "deep")))
        self.assertEqual([m["text"] for m in self.notices()], [RELEASE_NOTICE])
        # The successor turn is admitted as a fenced continuation and answers normally.
        self.peer.deep_phase, self.peer.current = None, None
        self.peer.accepted.clear()
        self.worker.step(resumed)
        messages = [body for route, body in self.peer.mutations if route == "/messages"]
        self.assertEqual(len(messages), 2)
        self.assertEqual(messages[1]["continuation_source_run_id"], "deep-run")
        self.assertTrue(messages[1]["text"].startswith(RELEASE_PREFIX))
        self.assertEqual(self.ledger.messages()[-1]["text"], "deep result")
        self.assertEqual(len(self.notices()), 1, "one notice, never repeated")

    def test_a_second_stop_after_the_release_continuation_refuses(self):
        self.record()
        self.stop_before_deadline()
        self.worker.step(self.data)
        resumed = self.ledger.next_input()
        self.peer.accepted.clear()
        with self.assertRaisesRegex(Refused, "deep_run_cancelled"):
            self.settle_terminal(resumed)
        self.assertEqual(len(self.notices()), 1)

    def test_grouped_follow_ups_are_folded_into_the_continuation(self):
        follow, _ = self.ledger.enqueue(dict(publicMessageId="public-2", publicThreadId="thread", chatId="chat",
                                             accountId="account", text="follow-up"))
        self.data["deep_group"] = dict(run_id="deep-run", inputs=[follow["remote_id"]], pending=[],
                                       last=follow["remote_id"])
        self.ledger.save(self.data)
        self.record()
        self.stop_before_deadline()
        self.worker.step(self.data)
        text = self.ledger.next_input()["intake_text"]
        self.assertTrue(text.startswith(RELEASE_PREFIX))
        self.assertIn("[2 owner messages were answered together by the stopped turn", text)
        self.assertTrue(text.endswith("\n\n2. follow-up"), text)

    def test_the_notice_is_localized(self):
        self.assertEqual(set(TEMPLATES["release_continue"]), {"en", "tr", "de"})
        for lang in ("tr", "de"):
            self.assertEqual(notices.localize(lang, RELEASE_NOTICE), TEMPLATES["release_continue"][lang])


class TodaysBehaviourTests(Recorded):
    def test_no_record_keeps_the_final_stop(self):
        self.stop_before_deadline()
        self.assert_todays_refusal()

    def test_feature_off_ignores_a_record(self):
        self.record()
        self.worker.release_interruption_dir = None
        self.stop_before_deadline()
        self.assert_todays_refusal()

    def test_record_of_another_run_is_ignored(self):
        self.record(run_id="other-run")
        self.stop_before_deadline()
        self.assert_todays_refusal()

    def test_record_of_another_conversation_is_ignored(self):
        self.record(conversation="a1000000-0000-4000-8000-000000000099")
        self.stop_before_deadline()
        self.assert_todays_refusal()

    def test_invalid_records_are_ignored(self):
        cases = [dict(mode=0o600), dict(format="other"), dict(release_source="short"),
                 dict(interrupted_at_ms="1"), dict(extra=True)]
        for change in cases:
            with self.subTest(change=change):
                self.record(**change)
                self.assertFalse(release_interruption.recorded(str(self.records), self.peer.conversation, "deep-run"))
                (self.records / "deep-run.json").unlink()
        # A symlinked record and a group-readable directory never count.
        target = Path(self.temp.name) / "elsewhere.json"
        target.write_text("{}")
        (self.records / "deep-run.json").symlink_to(target)
        self.assertFalse(release_interruption.recorded(str(self.records), self.peer.conversation, "deep-run"))
        (self.records / "deep-run.json").unlink()
        self.record()
        self.assertTrue(release_interruption.recorded(str(self.records), self.peer.conversation, "deep-run"))
        self.records.chmod(0o750)
        self.assertFalse(release_interruption.recorded(str(self.records), self.peer.conversation, "deep-run"))
        self.records.chmod(0o700)
        for run in ("../deep-run", "deep run", "", None):
            self.assertFalse(release_interruption.recorded(str(self.records), self.peer.conversation, run))

    def test_deadline_stop_is_unchanged(self):
        self.peer.deep_phase = "cancelled"
        self.peer.current = dict(window_id="window", state="closed", conversation_id="conversation",
                                 work_deadline_ms=int(time.time() * 1000) - 1000)
        self.worker.step(self.data)
        resumed = self.ledger.next_input()
        self.assertTrue(resumed["intake_text"].startswith(CONTINUE_PREFIX))
        self.assertNotIn("cause", resumed["continued"])


class ConfigTests(unittest.TestCase):
    def service(self, **extra):
        value = dict(origin="https://example.test", loopback_url="http://127.0.0.1:1234",
                     expected_owner="00000000-0000-4000-8000-000000000001", listen_port=1234,
                     token_path="/synthetic/token")
        value.update(extra)
        with patch.object(config_module, "private_json", return_value=dict(token="a" * 64)):
            return config_module._service(value)

    def test_absent_keys_keep_the_feature_off(self):
        self.assertIsNone(release_interruption.configured(self.service()))

    def test_both_keys_enable_and_either_is_the_kill_switch(self):
        with patch.object(release_interruption, "directory", side_effect=lambda path: path):
            on = self.service(release_interruption_dir="/records", release_interruption_enabled=True)
            off = self.service(release_interruption_dir="/records", release_interruption_enabled=False)
            unset = self.service(release_interruption_dir="/records")
        self.assertEqual(release_interruption.configured(on), "/records")
        self.assertIsNone(release_interruption.configured(off))
        self.assertIsNone(release_interruption.configured(unset))

    def test_invalid_configuration_is_refused(self):
        for extra in (dict(release_interruption_enabled=True), dict(release_interruption_enabled="true",
                                                                    release_interruption_dir="/records")):
            with self.subTest(extra=extra), self.assertRaisesRegex(ValueError, "config_release_interruption"):
                self.service(**extra)
        with self.assertRaisesRegex(ValueError, "release_interruption_directory"):
            self.service(release_interruption_dir="relative/records", release_interruption_enabled=True)


if __name__ == "__main__":
    unittest.main()
