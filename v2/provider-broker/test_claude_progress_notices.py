"""Per-request turn progress from the installed Claude CLI (2.1.x); synthetic ids only.

During every model request the CLI streams one `system/status` "requesting"
notice and, with adaptive thinking shown as "updates", one
`system/thinking_tokens` estimate per thinking delta. A long tool-heavy turn
emits hundreds of them, so they cannot share the 256-notice budget of rare
system notices: the 257th notice used to kill the turn as a protocol refusal
(broker exit 123, failure class 8, a 251-byte last provider frame).
"""
import json
import unittest
import uuid
import test_claude_protocol as fixtures
from claude_telemetry import PROGRESS_LIMIT
from protocol import Refused

INPUT = "33333333-3333-4333-8333-333333333333"


def frame_uuid():
    return str(uuid.uuid4())


class ProgressNoticeTests(unittest.TestCase):
    def setUp(self):
        fixture = fixtures.ClaudeProtocolTests()
        fixture.setUp()
        self.native = fixture.native
        self.fixture, self.channel = fixture, fixture.channel
        self.channel.tools = True  # Operator full-access Deep, as installed.

    def start(self):
        self.fixture.init()
        self.channel.client(self.fixture.request(2))
        self.channel.provider({"type": "system", "subtype": "init", "session_id": self.native,
                               "uuid": frame_uuid(), "tools": [], "model": "synthetic"})

    def thinking(self, estimated=42, delta=7, **changes):
        # Installed shape: engine fields, then session_id/uuid, then the turn join key.
        frame = {"type": "system", "subtype": "thinking_tokens", "estimated_tokens": estimated,
                 "estimated_tokens_delta": delta, "session_id": self.native,
                 "uuid": frame_uuid(), "user_message_uuid": INPUT}
        frame.update(changes)
        return frame

    def requesting(self, **changes):
        frame = {"type": "system", "subtype": "status", "status": "requesting",
                 "session_id": self.native, "uuid": frame_uuid(), "user_message_uuids": [INPUT]}
        frame.update(changes)
        return frame

    def assistant(self, content):
        return {"type": "assistant", "session_id": self.native, "uuid": frame_uuid(),
                "parent_tool_use_id": None, "user_message_uuid": INPUT,
                "message": {"role": "assistant", "model": "synthetic", "content": content}}

    def test_observed_frame_shape_is_251_bytes(self):
        raw = json.dumps(self.thinking(), separators=(",", ":"))
        self.assertEqual(len(raw), 251)

    def test_long_thinking_turn_outlives_the_rare_notice_budget_and_completes(self):
        self.start()
        self.channel.provider(self.assistant([{"type": "text", "text": "working"}]))
        # 40 model requests with about six thinking updates each: over 256 notices.
        for request in range(40):
            self.assertIsNone(self.channel.provider(self.requesting()))
            estimate = 0
            for delta in (12, 9, 30, 7, 55, 4):
                estimate += delta
                self.assertIsNone(self.channel.provider(self.thinking(estimate, delta)))
        self.assertGreater(self.channel.progress_notices, 256)
        output = self.channel.provider(self.assistant([{"type": "text", "text": "done"}]))
        self.assertEqual(output["params"]["frame"]["message"]["content"][0]["text"], "done")
        result = {"type": "result", "subtype": "success", "is_error": False, "result": "done",
                  "session_id": self.native, "uuid": frame_uuid(), "user_message_uuid": INPUT}
        self.assertEqual(self.channel.provider(result)["params"]["frame"]["result"], "done")

    def test_progress_is_never_forwarded_and_keeps_the_rare_notice_budget(self):
        self.start()
        for _ in range(300):
            self.assertIsNone(self.channel.provider(self.thinking()))
        self.assertEqual(self.channel.system_notices, 0)
        notice = {"type": "system", "subtype": "api_retry", "session_id": self.native,
                  "uuid": frame_uuid()}
        for _ in range(256):
            self.assertIsNone(self.channel.provider(dict(notice, uuid=frame_uuid())))
        with self.assertRaises(Refused):
            self.channel.provider(dict(notice, uuid=frame_uuid()))

    def test_other_status_values_stay_rare_notices(self):
        self.start()
        self.assertIsNone(self.channel.provider(self.requesting(status="compacting")))
        self.assertEqual((self.channel.system_notices, self.channel.progress_notices), (1, 0))

    def test_uncorrelated_progress_is_accepted_like_before(self):
        self.start()
        frame = self.thinking()
        del frame["user_message_uuid"]
        self.assertIsNone(self.channel.provider(frame))
        frame = self.requesting()
        del frame["user_message_uuids"]
        self.assertIsNone(self.channel.provider(frame))

    def test_progress_shape_stays_closed(self):
        variants = [
            self.thinking(user_message_uuid=frame_uuid()),
            self.thinking(estimated=-1), self.thinking(delta=True), self.thinking(estimated="42"),
            self.thinking(estimated=2 ** 60, delta=1),
            self.thinking(uuid="not-a-uuid"), self.thinking(extra="unexpected"),
            self.thinking(parent_tool_use_id="toolu_synthetic"),
            self.requesting(user_message_uuids=[frame_uuid()]),
            self.requesting(user_message_uuids=[INPUT, frame_uuid()]),
            self.requesting(extra="unexpected"), self.requesting(uuid=None),
            self.thinking(session_id=frame_uuid()),
        ]
        for frame in variants:
            self.setUp()
            self.start()
            with self.assertRaises(Refused, msg=sorted(frame)):
                self.channel.provider(frame)

    def test_correlated_progress_before_any_input_is_refused(self):
        self.fixture.init()
        with self.assertRaises(Refused):
            self.channel.provider(self.thinking())

    def test_progress_budget_is_bounded(self):
        self.start()
        self.channel.progress_notices = PROGRESS_LIMIT - 1
        self.assertIsNone(self.channel.provider(self.thinking()))
        with self.assertRaises(Refused):
            self.channel.provider(self.thinking())


if __name__ == "__main__":
    unittest.main()
