"""Synthetic native notices only; no model calls, accounts or private text."""
import unittest
from protocol import Refused
import test_claude_protocol as fixtures


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.ClaudeProtocolTests()
        self.fixture.setUp()
        self.fixture.init()
        self.channel = self.fixture.channel
        self.channel.client(self.fixture.request(2))
        self.channel.provider({"type": "system", "subtype": "init",
            "session_id": self.fixture.native, "model": "selected-model"})

    def synthetic(self):
        return {"type": "user", "session_id": self.fixture.native,
                "uuid": "77777777-7777-4777-8777-777777777777", "isSynthetic": True,
                "refused_message_id": "msg_synthetic_refusal", "parent_tool_use_id": None,
                "message": {"role": "user", "content": "private synthetic retry instruction"}}

    def test_refusal_retry_is_not_owner_input_and_is_not_a_terminal_result(self):
        result = self.channel.provider(self.synthetic())
        frame = result["params"]["frame"]
        self.assertEqual(frame, {"type": "system", "subtype": "provider_policy_refusal",
            "session_id": self.fixture.native, "model": "selected-model",
            "user_message_uuid": "33333333-3333-4333-8333-333333333333"})
        self.assertNotIn("retry instruction", str(result))
        self.assertFalse(self.channel.terminal)
        self.assertIsNone(self.channel.provider({"type": "assistant", "session_id": self.fixture.native,
            "message": {"role": "assistant", "model": "replacement-model",
                        "content": [{"type": "text", "text": "replacement answer"}]}}))
        with self.assertRaises(Refused):
            self.channel.client(self.fixture.request(3, "new-input"))

    def test_explicit_model_refusal_without_retry_is_also_a_scoped_refusal(self):
        result = self.channel.provider({"type": "system", "subtype": "model_refusal_fallback",
            "session_id": self.fixture.native,
            "refused_user_message_uuid": "33333333-3333-4333-8333-333333333333",
            "original_model": "selected-model", "fallback_model": "replacement-model",
            "api_refusal_explanation": "private explanation"})
        self.assertEqual(result["params"]["frame"]["subtype"], "provider_policy_refusal")
        self.assertNotIn("replacement-model", str(result))
        self.assertNotIn("private explanation", str(result))

    def test_prior_input_or_foreign_session_refusal_cannot_affect_this_turn(self):
        frame = self.synthetic()
        frame["session_id"] = "88888888-8888-4888-8888-888888888888"
        with self.assertRaises(Refused):
            self.channel.provider(frame)

    def test_actual_assistant_model_is_preserved_as_bounded_metadata(self):
        frame = self.channel.provider({"type": "assistant", "session_id": self.fixture.native,
            "user_message_uuid": "33333333-3333-4333-8333-333333333333",
            "message": {"role": "assistant", "model": "answer-model",
                        "content": [{"type": "text", "text": "synthetic answer"}]}})
        self.assertEqual(frame["params"]["frame"]["message"]["model"], "answer-model")


if __name__ == "__main__":
    unittest.main()
