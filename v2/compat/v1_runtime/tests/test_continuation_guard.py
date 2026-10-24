"""A provider decision never authorizes replay of an old automatic turn."""
import copy
import unittest
from unittest.mock import Mock

from v2.compat.v1_runtime import continuation_guard
from v2.compat.v1_runtime.tests.test_window_continuation import Case
from v2.compat.v1_runtime.worker import Refused


class GuardUnitTests(unittest.TestCase):
    def test_missing_run_provider_never_uses_current_settings_as_evidence(self):
        call = Mock(return_value=dict(provider="codex", provider_generation=4))
        with self.assertRaisesRegex(ValueError, "lineage_unknown"):
            continuation_guard.freeze(call, dict(run_id="synthetic"))
        call.assert_not_called()

    def test_malformed_generation_is_not_a_legacy_bypass(self):
        for generation in [None, True, -1, "2", 2.5]:
            with self.subTest(generation=generation):
                call = Mock(return_value=dict(provider="codex", provider_generation=generation))
                with self.assertRaisesRegex(ValueError, "lineage_unknown"):
                    continuation_guard.freeze(call, dict(run_id="synthetic", models=dict(provider="codex")))


class ProviderContinuationTests(Case):
    def closed(self):
        self.peer.deep_phase = "cancelled"
        self.peer.current = dict(window_id="window", state="closed", conversation_id="conversation")

    def test_handoff_refuses_before_keys_fast_acceptance_or_continuation_notice(self):
        self.closed()
        self.peer.run_provider, self.peer.provider = "claude", "codex"
        before = copy.deepcopy(self.data["keys"])
        with self.assertRaisesRegex(Refused, "continuation_provider_changed"):
            self.worker.step(self.data)
        self.assertEqual(self.data["keys"], before)
        self.assertNotIn("continued", self.data)
        self.assertEqual(self.notices(), [])
        self.assertEqual(self.peer.accepted, {})
        self.assertEqual(len([r for r, _ in self.peer.mutations if r == "/messages"]), 1)

    def test_legacy_requeued_input_without_guard_never_reenters_core(self):
        self.data["continued"] = dict(previous_message_id="old", at=1)
        with self.assertRaisesRegex(Refused, "continuation_lineage_unknown"):
            self.worker.step(self.data)
        self.assertEqual([r for r, _ in self.peer.mutations if r == "/messages"], [])

    def test_generation_is_frozen_and_sent_on_the_new_admission(self):
        self.closed()
        self.peer.provider_generation = 7
        self.worker.step(self.data)
        pending = self.ledger.next_input()
        self.assertEqual(pending["continuation_guard"]["provider_generation"], 7)
        self.peer.deep_phase, self.peer.current = None, None
        self.peer.accepted.clear()
        self.worker.step(pending)
        requests = [b for r, b in self.peer.mutations if r == "/messages"]
        self.assertNotIn("expected_provider_generation", requests[0])
        self.assertEqual(requests[1]["expected_provider_generation"], 7)
        self.assertEqual(requests[1]["continuation_source_run_id"], "deep-run")

    def test_handoff_winning_after_freeze_causes_one_definite_refusal(self):
        self.closed()
        self.worker.step(self.data)
        pending = self.ledger.next_input()
        frozen = copy.deepcopy(pending["keys"])
        original = self.peer.request
        def request(method, route, body=None, allowed=(200,)):
            if method == "POST" and route == "/messages":
                self.assertEqual(body["expected_provider_generation"], 0)
                return 409, dict(code="provider_generation_changed")
            return original(method, route, body=body, allowed=allowed)
        self.peer.request = request
        with self.assertRaisesRegex(Refused, "continuation_admission_requires_review"):
            self.worker.step(pending)
        self.assertEqual(pending["keys"], frozen)
        self.assertNotIn("intake", pending)
