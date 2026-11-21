"""Claude Code's own compaction summary; synthetic values only, no provider launch.

A resumed session at its context limit auto-compacts at the start of a turn:
the installed CLI emits `system/compact_boundary`, then its summary as a
synthetic user frame, both before the turn's first assistant frame.
"""
import unittest
import uuid
from test_claude_full_access import INPUT, tool_turn
from protocol import Refused


def boundary(native):
    return {"type": "system", "subtype": "compact_boundary", "session_id": native,
            "uuid": str(uuid.uuid4()), "compact_metadata": {"trigger": "auto", "pre_tokens": 990000}}


def summary(native, **changes):
    frame = {"type": "user", "session_id": native, "parent_tool_use_id": None,
             "uuid": str(uuid.uuid4()), "timestamp": "2026-01-01T00:00:00.000Z",
             "isReplay": False, "isSynthetic": True,
             "message": {"role": "user", "content": "synthetic summary " * 1200}}
    frame.update(changes)
    return frame


class TurnStartCompactionTests(unittest.TestCase):
    def check_turn(self, tools):
        channel, native, frames = tool_turn(tools)
        self.assertIsNone(channel.provider({"type": "system", "subtype": "status",
            "status": "compacting", "session_id": native, "uuid": str(uuid.uuid4())}))
        self.assertIsNone(channel.provider(boundary(native)))
        self.assertIsNone(channel.provider(summary(native)))
        self.assertFalse(channel.joined)
        answer = dict(frames[2], user_message_uuid=INPUT)
        output = channel.provider(answer)
        self.assertEqual(output["params"]["frame"]["message"]["content"],
                         [{"type": "text", "text": "done"}])
        self.assertNotIn("synthetic summary", str(output))
        self.assertTrue(channel.joined)
        result = channel.provider({"type": "result", "subtype": "success", "is_error": False,
            "result": "done", "uuid": str(uuid.uuid4()), "session_id": native,
            "user_message_uuid": INPUT})
        self.assertTrue(channel.terminal)
        self.assertEqual(result["params"]["frame"]["result"], "done")

    def test_full_access_summary_before_join_is_discarded_and_the_turn_completes(self):
        self.check_turn(True)

    def test_contained_summary_before_join_is_discarded_and_the_turn_completes(self):
        self.check_turn(False)

    def test_summary_list_content_is_accepted(self):
        channel, native, _ = tool_turn(True)
        channel.provider(boundary(native))
        self.assertIsNone(channel.provider(summary(native, message={"role": "user",
            "content": [{"type": "text", "text": "synthetic summary"}]})))

    def test_mid_turn_compaction_still_drains(self):
        channel, native, frames = tool_turn(True)
        channel.provider(frames[0])
        channel.provider(frames[1])
        self.assertIsNone(channel.provider(boundary(native)))
        self.assertIsNone(channel.provider(summary(native)))
        self.assertEqual(channel.provider(frames[2])["params"]["frame"]["message"]["content"],
                         [{"type": "text", "text": "done"}])

    def test_contained_mid_turn_compaction_is_discarded(self):
        channel, native, frames = tool_turn(False)
        first = dict(frames[2], user_message_uuid=INPUT)
        self.assertIsNotNone(channel.provider(first))
        self.assertTrue(channel.joined)
        self.assertIsNone(channel.provider(boundary(native)))
        self.assertIsNone(channel.provider(summary(native)))
        later = dict(frames[2], uuid=str(uuid.uuid4()))
        self.assertIsNotNone(channel.provider(later))


class ArmedBoundaryFallThroughTests(unittest.TestCase):
    """An armed boundary consumes only a frame with the summary's exact shape."""

    def joined_turn(self):
        channel, native, frames = tool_turn(True)
        channel.provider(frames[0])
        self.assertTrue(channel.joined)
        self.assertIsNone(channel.provider(boundary(native)))
        return channel, native, frames

    def test_other_synthetic_frames_after_join_take_the_old_path_and_keep_it_armed(self):
        for change in (dict(inbound_origin={"kind": "queued"}), dict(isReplay=True),
                       dict(message={"role": "user", "content": [{"type": "image"}]})):
            channel, native, frames = self.joined_turn()
            self.assertIsNone(channel.provider(summary(native, **change)), msg=str(change))
            self.assertTrue(channel.compaction_pending)
            self.assertEqual(channel.compaction_summaries, 0)
            self.assertIsNone(channel.provider(summary(native)))
            self.assertFalse(channel.compaction_pending)
            self.assertEqual(channel.compaction_summaries, 1)
            self.assertIsNotNone(channel.provider(frames[2]))

    def test_boundary_without_summary_leaves_tool_results_on_the_old_path(self):
        channel, native, frames = self.joined_turn()
        self.assertIsNone(channel.provider(frames[1]))
        self.assertTrue(channel.compaction_pending)
        self.assertEqual(channel.provider(frames[2])["params"]["frame"]["message"]["content"],
                         [{"type": "text", "text": "done"}])

    def test_other_synthetic_frame_before_join_is_still_refused(self):
        channel, native, _ = tool_turn(True)
        channel.provider(boundary(native))
        with self.assertRaises(Refused):
            channel.provider(summary(native, inbound_origin={"kind": "queued"}))
        self.assertTrue(channel.compaction_pending)


class CompactionRefusalTests(unittest.TestCase):
    def test_summary_without_a_boundary_before_join_is_refused(self):
        channel, native, _ = tool_turn(True)
        with self.assertRaises(Refused):
            channel.provider(summary(native))

    def test_one_boundary_arms_one_summary(self):
        channel, native, _ = tool_turn(True)
        channel.provider(boundary(native))
        channel.provider(summary(native))
        with self.assertRaises(Refused):
            channel.provider(summary(native))

    def test_tool_result_before_join_is_still_refused_after_a_boundary(self):
        channel, native, frames = tool_turn(True)
        channel.provider(boundary(native))
        with self.assertRaises(Refused):
            channel.provider(frames[1])

    def test_malformed_summaries_are_refused(self):
        # A synthetic frame with refused_message_id is a policy refusal, handled first.
        variants = [dict(isReplay=True), dict(parent_tool_use_id="toolu_1"),
                    dict(sessionId="x"), dict(extra=1),
                    dict(uuid="invalid"), dict(uuid=INPUT), dict(session_id=str(uuid.uuid4())),
                    dict(message={"role": "assistant", "content": "x"}),
                    dict(message={"role": "user", "content": ""}),
                    dict(message={"role": "user", "content": "x", "id": "m"}),
                    dict(message={"role": "user", "content": [{"type": "image"}]})]
        for change in variants:
            channel, native, _ = tool_turn(True)
            channel.provider(boundary(native))
            with self.assertRaises(Refused, msg=str(change)):
                channel.provider(summary(native, **change))

    def test_summary_after_the_terminal_result_is_refused(self):
        channel, native, frames = tool_turn(True)
        channel.provider(frames[0])
        channel.provider({"type": "result", "subtype": "success", "is_error": False,
            "result": "done", "uuid": str(uuid.uuid4()), "session_id": native,
            "user_message_uuid": INPUT})
        self.assertIsNone(channel.provider(boundary(native)))
        with self.assertRaises(Refused):
            channel.provider(summary(native))

    def test_summary_count_is_bounded(self):
        channel, native, _ = tool_turn(True)
        channel.compaction_summaries = 16
        channel.provider(boundary(native))
        with self.assertRaises(Refused):
            channel.provider(summary(native))


if __name__ == "__main__":
    unittest.main()
