"""Nullable display estimates never become text, identity, or Stop evidence."""
import json
import unittest
import uuid

from protocol import Refused
import test_claude_streaming as fixtures


class ClaudeThinkingEstimateTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.ClaudeStreamingTests(); self.case.setUp()
        self.channel, self.frames = self.case.channel, self.case.frames

    def begin(self):
        self.assertIsNone(self.channel.provider(self.frames.start()))
        self.assertIsNone(self.channel.provider(self.frames.block(kind='thinking')))

    def delta(self, estimate=None, text='SYNTHETIC_THOUGHT_MUST_NOT_LEAVE'):
        frame = self.frames.delta(text, kind='thinking')
        frame['event']['delta']['estimated_tokens'] = estimate
        return frame

    def reject(self, frame):
        with self.assertRaises((Refused, ValueError, TypeError)):
            self.channel.provider(frame)
        self.assertTrue(self.channel.poisoned)
        self.assertFalse(self.channel.terminal)

    def test_native_nullable_estimate_is_discarded_before_genuine_text(self):
        self.begin(); marker = 'SYNTHETIC_THOUGHT_MUST_NOT_LEAVE'
        frame = self.delta(text=marker); before = self.channel.wire_bytes
        self.assertIsNone(self.channel.provider(frame))
        self.assertEqual(self.channel.wire_bytes - before,
            len(json.dumps(frame, ensure_ascii=False, separators=(',', ':')).encode()) + 1)
        self.assertEqual(self.channel.stream.text_bytes, 0)
        self.assertEqual(self.channel.stream.thinking_bytes, len(marker))
        self.assertNotIn(marker, repr(self.channel.stream.__dict__))
        self.assertFalse(self.channel.terminal)
        self.assertIsNone(self.channel.control)
        self.assertIsNone(self.channel.provider(self.frames.assistant(marker, kind='thinking')))
        self.assertIsNone(self.channel.provider(self.frames.block_stop()))
        self.assertIsNone(self.channel.provider(self.frames.block(1)))
        output = self.channel.provider(self.frames.delta('visible text', 1))
        self.assertEqual(output['params']['frame']['message']['content'],
                         [{'type': 'text', 'text': 'visible text'}])
        self.assertNotIn(marker, str(output))
        self.channel.provider(self.frames.assistant('visible text'))
        self.channel.provider(self.frames.block_stop(1))
        self.channel.provider(self.frames.ending()); self.channel.provider(self.frames.stop())
        self.assertEqual(self.channel.provider(self.frames.result('visible text'))
                         ['params']['frame']['result'], '')

    def test_estimate_absence_and_bounded_integer_remain_valid(self):
        for estimate in ('absent', 0, 16, 2**53 - 1):
            with self.subTest(estimate=estimate):
                self.setUp(); self.begin(); frame = self.delta(estimate, '')
                if estimate == 'absent': del frame['event']['delta']['estimated_tokens']
                self.assertIsNone(self.channel.provider(frame))
                self.assertFalse(self.channel.terminal)
                self.assertEqual(self.channel.stream.text_bytes, 0)

    def test_other_estimate_types_ranges_and_unknown_fields_refuse(self):
        for estimate in (True, False, -1, 0.5, 2**53, '0', [], {}, float('inf'), float('nan')):
            with self.subTest(estimate=estimate):
                self.setUp(); self.begin(); self.reject(self.delta(estimate))
        for change in ('missing-text', 'bad-text', 'unknown', 'text-delta'):
            with self.subTest(change=change):
                self.setUp(); self.begin(); frame = self.delta(); delta = frame['event']['delta']
                if change == 'missing-text': del delta['thinking']
                elif change == 'bad-text': delta['thinking'] = None
                elif change == 'unknown': delta['extra'] = None
                else: delta['type'] = 'text_delta'
                self.reject(frame)

    def test_nullable_metadata_cannot_supply_a_missing_or_foreign_anchor(self):
        self.reject(self.delta())
        for field in ('session_id', 'api_message_id', 'user_message_uuid'):
            with self.subTest(field=field):
                self.setUp(); self.begin(); frame = self.delta(); frame[field] = str(uuid.uuid4())
                self.reject(frame)
        self.setUp(); start = self.frames.start()
        del start['user_message_uuid']; del start['user_message_uuids']
        self.reject(start)

    def test_nullable_estimate_replay_and_postterminal_frames_refuse(self):
        self.begin(); frame = self.delta(); self.channel.provider(frame); self.reject(frame)
        self.setUp(); self.begin(); self.channel.client(self.case.fixture.request())
        self.channel.provider(self.case.fixture.terminal())
        with self.assertRaises(Refused): self.channel.provider(self.delta())
        self.assertTrue(self.channel.poisoned)

    def test_cancelled_nullable_metadata_never_acknowledges_or_stops(self):
        self.begin(); self.channel.client(self.case.fixture.request())
        self.assertIsNone(self.channel.provider(self.delta()))
        self.assertFalse(self.channel.terminal or self.channel.control.ack)
        self.channel.provider(self.case.fixture.ack())
        self.assertFalse(self.channel.terminal)
        self.assertIsNone(self.channel.provider(self.delta(text='late discarded text')))
        terminal = self.channel.provider(self.case.fixture.terminal())['params']['frame']
        self.assertEqual(terminal['terminal_reason'], 'aborted_streaming')
        self.assertNotIn('late discarded', str(terminal))

    def test_nullable_metadata_still_consumes_event_and_thinking_budgets(self):
        self.begin()
        for _ in range(1022): self.channel.provider(self.delta(text=''))
        self.reject(self.delta(text=''))
        self.setUp(); self.begin()
        for _ in range(32): self.channel.provider(self.delta(text='x' * 8192))
        self.assertEqual(self.channel.stream.thinking_bytes, 262144)
        self.reject(self.delta(text='x'))


if __name__ == '__main__': unittest.main()
