"""Source-shaped API metadata is discarded, never execution authority."""
import copy
import json
import unittest
import uuid

from protocol import Refused
import test_claude_streaming as fixtures


def entry(kind='thinking_dropped', reason='prefix_binding_mismatch', index=0):
    return {'type': kind, 'path': f'messages.{index}.content.0', 'reason': reason}


class ClaudeInputTransformationTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.ClaudeStreamingTests(); self.case.setUp()
        self.channel, self.frames = self.case.channel, self.case.frames

    def start(self, value):
        frame = self.frames.start()
        frame['event']['message']['input_transformations'] = value
        return frame

    def reject(self, frame):
        with self.assertRaises(Refused): self.channel.provider(frame)
        self.assertTrue(self.channel.poisoned)
        self.assertFalse(self.channel.terminal)

    def test_null_empty_and_documented_entries_emit_nothing(self):
        for value in (None, [], [entry()], [entry('thinking_mismatch_allowed')],
                      [entry(index=i) for i in range(128)]):
            with self.subTest(size=0 if value is None else len(value)):
                self.setUp(); frame = self.start(value); before = copy.deepcopy(frame)
                self.assertIsNone(self.channel.provider(frame))
                self.assertEqual(frame, before)
                self.assertFalse(self.channel.terminal or self.channel.control)
                self.assertEqual(self.channel.stream.text_bytes, 0)
                self.assertNotIn('input_transformations', repr(self.channel.stream.__dict__))
                self.assertNotIn('prefix_binding_mismatch', repr(self.channel.stream.__dict__))

    def test_both_types_and_all_documented_reasons_are_closed_metadata(self):
        for kind in ('thinking_dropped', 'thinking_mismatch_allowed'):
            for reason in ('model_binding_mismatch', 'prefix_binding_mismatch',
                           'organization_binding_mismatch', 'end_user_binding_mismatch'):
                with self.subTest(kind=kind, reason=reason):
                    self.setUp()
                    self.assertIsNone(self.channel.provider(self.start([entry(kind, reason)])))

    def test_full_assistant_and_final_delta_metadata_do_not_duplicate_text(self):
        self.channel.provider(self.start([entry()]))
        self.channel.provider(self.frames.block())
        output = self.channel.provider(self.frames.delta('visible synthetic text'))
        self.assertEqual(output['params']['frame']['message']['content'],
                         [{'type': 'text', 'text': 'visible synthetic text'}])
        full = self.frames.assistant('visible synthetic text')
        full['message']['input_transformations'] = [entry('thinking_mismatch_allowed')]
        self.assertIsNone(self.channel.provider(full))
        self.channel.provider(self.frames.block_stop())
        ending = self.frames.ending(); ending['event']['input_transformations'] = [entry()]
        self.assertIsNone(self.channel.provider(ending))
        self.channel.provider(self.frames.stop())
        terminal = self.channel.provider(self.frames.result('visible synthetic text'))
        self.assertEqual(terminal['params']['frame']['result'], '')
        self.assertNotIn('input_transformations', json.dumps((output, terminal)))
        self.assertNotIn('prefix_binding_mismatch', repr(self.channel.stream.__dict__))

    def test_legacy_complete_assistant_uses_the_same_closed_discard(self):
        frame = self.frames.assistant('visible synthetic text')
        frame['message']['input_transformations'] = [entry()]
        output = self.channel.provider(frame)['params']['frame']
        self.assertEqual(output['message']['content'],
                         [{'type': 'text', 'text': 'visible synthetic text'}])
        self.assertNotIn('input_transformations', json.dumps(output))
        self.assertFalse(self.channel.stream.started or self.channel.terminal)

    def test_metadata_cannot_supply_stop_ack_terminal_or_late_progress(self):
        self.channel.provider(self.start([entry()]))
        self.channel.provider(self.frames.block())
        self.channel.client(self.case.fixture.request())
        self.assertIsNone(self.channel.provider(self.frames.delta('discarded late text')))
        full = self.frames.assistant('discarded late text')
        full['message']['input_transformations'] = [entry()]
        self.assertIsNone(self.channel.provider(full))
        self.assertFalse(self.channel.control.ack or self.channel.terminal)
        self.channel.provider(self.case.fixture.ack())
        self.assertFalse(self.channel.terminal)
        terminal = self.channel.provider(self.case.fixture.terminal())['params']['frame']
        self.assertEqual(terminal['terminal_reason'], 'aborted_streaming')
        self.assertNotIn('input_transformations', json.dumps(terminal))

    def test_foreign_missing_and_replayed_anchors_still_refuse(self):
        for key in ('session_id', 'user_message_uuid', 'api_message_id'):
            self.setUp(); frame = self.start([]); frame[key] = str(uuid.uuid4())
            self.reject(frame)
        self.setUp(); frame = self.start([])
        del frame['user_message_uuid']; del frame['user_message_uuids']; self.reject(frame)
        self.setUp(); frame = self.start([]); self.channel.provider(frame); self.reject(frame)

    def test_malformed_unknown_and_oversized_metadata_refuse(self):
        invalid = [False, {}, '', 0, [None], [entry()] * 129,
                   [dict(entry(), type='tool_use')], [dict(entry(), reason='arbitrary')],
                   [dict(entry(), extra='SYNTHETIC_PRIVATE_VALUE')],
                   [dict(entry(), path='SYNTHETIC_PRIVATE_VALUE')],
                   [dict(entry(), path='messages.1000000.content.0')],
                   [dict(entry(), path='messages.0.content.-1')],
                   [dict(entry(), path='messages.\u0661.content.0')],
                   [dict(entry(), path='messages.0.content.0\n')],
                   [dict(entry(), path='messages.0.content.0\0')],
                   [dict(entry(), reason=['prefix_binding_mismatch'])],
                   [dict(entry(), type={'type': 'thinking_dropped'})]]
        for key in ('type', 'path', 'reason'):
            value = entry(); del value[key]; invalid.append([value])
        for value in invalid:
            with self.subTest(case=invalid.index(value)):
                self.setUp(); self.reject(self.start(value))
        self.setUp(); frame = self.start([])
        frame['event']['message']['arbitrary_header'] = None; self.reject(frame)

    def test_full_frame_validates_metadata_before_returning_any_text(self):
        self.setUp(); frame = self.frames.assistant('must not escape')
        frame['message']['input_transformations'] = [dict(entry(), reason='unknown')]
        self.reject(frame)
        self.assertEqual(self.channel.output_uuids, set())
        self.assertEqual(self.channel.assistant_input.events, set())

    def test_metadata_never_anchors_full_assistant_or_substitutes_terminal(self):
        self.channel.provider(self.start([entry()]))
        self.channel.provider(self.frames.block())
        self.channel.provider(self.frames.delta('text'))
        full = self.frames.assistant('text'); full['message']['input_transformations'] = []
        del full['user_message_uuid']; del full['user_message_uuids']; self.reject(full)
        self.setUp(); self.channel.provider(self.start([entry()]))
        result = self.frames.result(''); result.pop('user_message_uuid'); self.reject(result)

    def test_metadata_bytes_remain_in_shared_wire_budget(self):
        frame = self.start([entry(index=i) for i in range(128)])
        size = len(json.dumps(frame, separators=(',', ':'), ensure_ascii=False).encode()) + 1
        before = self.channel.wire_bytes
        self.channel.provider(frame)
        self.assertEqual(self.channel.wire_bytes - before, size)
        self.assertGreater(size, 10000)


if __name__ == '__main__': unittest.main()
