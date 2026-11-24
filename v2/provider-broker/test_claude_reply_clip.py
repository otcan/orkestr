"""A Claude reply over the 8 KiB progress bound is cut with a note, never refused.

Synthetic values only, no provider launch. Runtime forwards Claude text blocks
unchanged and bounds every string to 8 KiB, so the broker cuts the reply and
its `result` and appends the note itself.
"""
import unittest
import uuid
from protocol import CLIPPED_NOTE, MAX_FRAME, MAX_REPLY_BYTES, encode
from test_claude_full_access import INPUT, tool_turn
from test_codex_output_items import turkish_reply


def answer(native, text):
    return {"type": "assistant", "session_id": native, "uuid": str(uuid.uuid4()),
            "parent_tool_use_id": None, "user_message_uuid": INPUT,
            "message": {"id": "msg_2", "role": "assistant",
                        "content": [{"type": "text", "text": text}]}}


def result(native, text):
    return {"type": "result", "subtype": "success", "is_error": False, "result": text,
            "uuid": str(uuid.uuid4()), "session_id": native, "user_message_uuid": INPUT}


class ClaudeReplyClipTests(unittest.TestCase):
    def assert_cut(self, full, delivered):
        self.assertLessEqual(len(delivered.encode()), MAX_REPLY_BYTES)
        self.assertTrue(delivered.endswith(CLIPPED_NOTE))
        kept = delivered[:-len(CLIPPED_NOTE)]
        self.assertTrue(full.startswith(kept))
        self.assertGreater(len(kept.encode()), MAX_REPLY_BYTES - len(CLIPPED_NOTE) - 4)

    def check_turn(self, tools):
        full = turkish_reply()
        channel, native, _ = tool_turn(tools)
        output = channel.provider(answer(native, full))
        self.assertLessEqual(len(encode(output)), MAX_FRAME + 1)
        blocks = output["params"]["frame"]["message"]["content"]
        self.assertEqual(len(blocks), 1)
        self.assertEqual(blocks[0]["type"], "text")
        self.assert_cut(full, blocks[0]["text"])
        self.assertFalse(channel.terminal)
        terminal = channel.provider(result(native, full))
        self.assertTrue(channel.terminal)
        self.assert_cut(full, terminal["params"]["frame"]["result"])

    def test_contained_reply_and_result_over_the_bound_are_cut_with_the_note(self):
        self.check_turn(False)

    def test_full_access_reply_and_result_over_the_bound_are_cut_with_the_note(self):
        self.check_turn(True)

    def test_reply_within_the_bound_is_unchanged(self):
        text = "ş" * (MAX_REPLY_BYTES // 2)
        channel, native, _ = tool_turn(False)
        output = channel.provider(answer(native, text))
        self.assertEqual(output["params"]["frame"]["message"]["content"],
                         [{"type": "text", "text": text}])
        terminal = channel.provider(result(native, text))
        self.assertEqual(terminal["params"]["frame"]["result"], text)


if __name__ == "__main__":
    unittest.main()
