"""Frame shapes emitted by the installed Claude Code CLI (2.1.x), synthetic values only.

Each case reproduces a refusal observed when the closed codec first met the real
CLI: reasoning blocks, later blocks without the input join key, UI/system
notices, interrupt ACK queue reports, result telemetry and provider error classes.
"""
import unittest
import uuid
import test_claude_protocol as fixtures
from protocol import Refused

INPUT = "33333333-3333-4333-8333-333333333333"


def frame_uuid():
    return str(uuid.uuid4())


class InstalledFrameTests(unittest.TestCase):
    def setUp(self):
        fixture = fixtures.ClaudeProtocolTests()
        fixture.setUp()
        self.native = fixture.native
        self.fixture, self.channel = fixture, fixture.channel

    def start(self):
        self.fixture.init()
        self.channel.client(self.fixture.request(2))
        self.channel.provider({"type": "system", "subtype": "init", "session_id": self.native,
                               "uuid": frame_uuid(), "tools": [], "model": "synthetic"})

    def assistant(self, content, joined=True, **extra):
        frame = {"type": "assistant", "session_id": self.native, "uuid": frame_uuid(),
                 "parent_tool_use_id": None, "timestamp": "2026-01-01T00:00:00.000Z",
                 "request_id": "req_synthetic", "message": {"id": "msg_synthetic",
                 "type": "message", "role": "assistant", "model": "synthetic",
                 "content": content, "stop_reason": None, "stop_details": None,
                 "input_transformations": [], "diagnostics": None}}
        if joined:
            frame.update(user_message_uuid=INPUT, user_message_uuids=[INPUT])
        frame.update(extra)
        return frame

    def result(self, **extra):
        frame = {"type": "result", "subtype": "success", "is_error": False, "result": "done",
                 "session_id": self.native, "uuid": frame_uuid(), "user_message_uuid": INPUT,
                 "user_message_uuids": [INPUT], "terminal_reason": "completed"}
        frame.update(extra)
        return frame

    def test_reasoning_block_is_dropped_and_later_text_block_joins_the_turn(self):
        self.start()
        thinking = [{"type": "thinking", "thinking": "synthetic private reasoning",
                     "signature": "synthetic"}]
        self.assertIsNone(self.channel.provider(self.assistant(thinking)))
        output = self.channel.provider(self.assistant([{"type": "text", "text": "answer"}],
                                                      joined=False))
        frame = output["params"]["frame"]
        self.assertEqual(frame["message"]["content"], [{"type": "text", "text": "answer"}])
        self.assertEqual(frame["user_message_uuid"], INPUT)
        self.assertNotIn("synthetic private reasoning", str(output))
        self.assertEqual(self.channel.provider(self.result())["params"]["frame"]["result"], "done")

    def test_uncorrelated_assistant_before_this_turn_joined_is_refused(self):
        self.start()
        with self.assertRaises(Refused):
            self.channel.provider(self.assistant([{"type": "text", "text": "historical"}],
                                                 joined=False))

    def test_foreign_join_key_and_unknown_block_still_refused(self):
        self.start()
        with self.assertRaises(Refused):
            self.channel.provider(self.assistant([{"type": "text", "text": "x"}],
                                                 user_message_uuid=frame_uuid()))
        self.setUp()
        self.start()
        with self.assertRaises(Refused):
            self.channel.provider(self.assistant([{"type": "tool_use", "id": "t", "name": "Bash",
                                                   "input": {}}]))

    def test_system_notices_are_bounded_discards_even_before_setup(self):
        notice = {"type": "system", "subtype": "ui_invalidate", "event": "ui.render",
                  "uuid": frame_uuid(), "session_id": self.native}
        self.assertIsNone(self.channel.provider(notice))
        self.start()
        self.assertFalse(self.channel.terminal)
        for _ in range(255):
            self.channel.provider(dict(notice, subtype="api_retry"))
        with self.assertRaises(Refused):
            self.channel.provider(notice)

    def test_second_init_and_foreign_notice_session_refused(self):
        self.start()
        with self.assertRaises(Refused):
            self.channel.provider({"type": "system", "subtype": "init", "session_id": self.native})
        self.setUp()
        with self.assertRaises(Refused):
            self.channel.provider({"type": "system", "subtype": "status", "session_id": "foreign"})

    def test_provider_error_class_is_forwarded_closed_for_truthful_failure(self):
        for native, forwarded in (("authentication_failed", "authentication_failed"),
                                  ("rate_limit", "rate_limit"), ("novel_failure", "unknown")):
            self.setUp()
            self.start()
            output = self.channel.provider(self.assistant(
                [{"type": "text", "text": "Not logged in"}], error=native,
                is_api_error_message=True))
            self.assertEqual(output["params"]["frame"]["error"], forwarded)
            terminal = self.channel.provider(self.result(is_error=True, result="Not logged in",
                                                         terminal_reason="api_error"))
            self.assertIs(terminal["params"]["frame"]["is_error"], True)
        self.setUp()
        self.start()
        with self.assertRaises(Refused):
            self.channel.provider(self.assistant([{"type": "text", "text": "x"}], error={}))


class InstalledStopTests(unittest.TestCase):
    def setUp(self):
        import test_claude_control
        self.control = test_claude_control.ClaudeControlTests()
        self.control.setUp()
        self.channel = self.control.channel
        self.channel.client(self.control.request())

    def test_ack_reports_empty_still_queued(self):
        ack = self.control.ack()
        ack["response"]["response"]["still_queued"] = []
        output = self.channel.provider(ack)
        self.assertEqual(output["params"]["frame"]["response"]["response"], {"turn": "stopped"})
        self.assertTrue(self.channel.control.ack)

    def test_nonempty_still_queued_refused(self):
        ack = self.control.ack()
        ack["response"]["response"]["still_queued"] = [INPUT]
        with self.assertRaises(Refused):
            self.channel.provider(ack)

    def test_interrupt_notice_and_terminal_telemetry_accepted_but_not_forwarded(self):
        native = self.control.fixture.native
        notice = {"type": "user", "session_id": native, "uuid": frame_uuid(),
                  "parent_tool_use_id": None, "timestamp": "2026-01-01T00:00:00.000Z",
                  "message": {"role": "user", "content": [{"type": "text",
                              "text": "[Request interrupted by user]"}]}}
        self.assertIsNone(self.channel.provider(notice))
        terminal = self.control.terminal()
        terminal.update(fast_mode_disabled_reason="synthetic", queued_turn_count=0,
                        result_index=0, safety_stops=0, subagent_stats={"spawned": 0})
        output = self.channel.provider(terminal)
        self.assertNotIn("subagent_stats", str(output))
        self.assertTrue(self.channel.terminal)


if __name__ == "__main__":
    unittest.main()
