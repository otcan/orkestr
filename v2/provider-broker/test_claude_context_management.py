"""Synthetic typed metadata; no native process, account, tool, or network use."""
import copy
import unittest
import uuid

from claude_stream_schema import MAX_EVENTS, MAX_RAW
from protocol import Refused
import test_claude_control as control
from test_claude_streaming import Frames


TOOL = {'type': 'clear_tool_uses_20250919', 'cleared_input_tokens': 3,
        'cleared_tool_uses': 1}
THINKING = {'type': 'clear_thinking_20251015', 'cleared_input_tokens': 5,
            'cleared_thinking_turns': 2}
METADATA = {'applied_edits': [TOOL, THINKING]}


class ClaudeContextManagementTests(unittest.TestCase):
    def fixture(self):
        fixture = control.ClaudeControlTests(); fixture.setUp()
        channel = fixture.channel
        return fixture, channel, Frames(channel.native, channel.input_uuid)

    def prepare(self, site, metadata):
        fixture, channel, frames = self.fixture()
        if site == 'start':
            frame = frames.start()
            frame['event']['message']['context_management'] = copy.deepcopy(metadata)
        else:
            channel.provider(frames.start()); channel.provider(frames.block())
            channel.provider(frames.delta('synthetic'))
            if site == 'assistant':
                frame = frames.assistant('synthetic')
                frame['message']['context_management'] = copy.deepcopy(metadata)
            else:
                channel.provider(frames.assistant('synthetic'))
                channel.provider(frames.block_stop())
                frame = frames.ending()
                frame['event']['context_management'] = copy.deepcopy(metadata)
        return fixture, channel, frames, frame

    def refused(self, channel, frame):
        with self.assertRaises(Refused): channel.provider(frame)
        self.assertFalse(channel.terminal)
        self.assertFalse(channel.control and channel.control.ack)

    def test_null_empty_and_both_edits_are_discarded_at_both_headers_and_delta(self):
        for metadata in (None, {'applied_edits': []}, {'applied_edits': [TOOL]},
                         {'applied_edits': [THINKING]}, METADATA):
            with self.subTest(metadata=metadata):
                _, channel, frames = self.fixture()
                first = frames.start()
                first['event']['message']['context_management'] = copy.deepcopy(metadata)
                self.assertIsNone(channel.provider(first))
                self.assertIsNone(channel.provider(frames.block()))
                progress = channel.provider(frames.delta('synthetic'))
                self.assertNotIn('context_management', str(progress))
                full = frames.assistant('synthetic')
                full['message']['context_management'] = copy.deepcopy(metadata)
                self.assertIsNone(channel.provider(full))
                self.assertIsNone(channel.provider(frames.block_stop()))
                end = frames.ending(); end['event']['context_management'] = copy.deepcopy(metadata)
                self.assertIsNone(channel.provider(end))
                self.assertIsNone(channel.provider(frames.stop()))
                self.assertFalse(channel.terminal or channel.control)
                result = channel.provider(frames.result('synthetic'))
                self.assertTrue(channel.terminal)
                self.assertNotIn('context_management', str(result))
                self.assertNotIn('applied_edits', str(vars(channel.stream)))

    def test_metadata_never_substitutes_for_cancel_ack_or_interrupted_result(self):
        fixture, channel, frames, end = self.prepare('delta', METADATA)
        channel.client(fixture.request())
        self.assertIsNone(channel.provider(end))
        self.assertIsNone(channel.provider(frames.stop()))
        self.assertFalse(channel.control.ack or channel.terminal)
        channel.provider(fixture.ack())
        self.assertTrue(channel.control.ack)
        self.assertFalse(channel.terminal)
        channel.provider(fixture.terminal())
        self.assertTrue(channel.terminal)

    def test_exact_container_edit_keys_and_enum_required(self):
        bad = [False, [], '', 0, {}, {'applied_edits': None}, {'applied_edits': {}},
               {'applied_edits': [], 'extra': None}, {'applied_edits': [None]},
               {'applied_edits': [[]]}, {'applied_edits': [{}]},
               {'applied_edits': [dict(TOOL, type='unknown')]},
               {'applied_edits': [dict(TOOL, type=True)]},
               {'applied_edits': [dict(TOOL, type=[])]},
               {'applied_edits': [dict(TOOL, command='synthetic')]},
               {'applied_edits': [dict(THINKING, tool={'input': 'synthetic'})]},
               {'applied_edits': [{k: v for k, v in TOOL.items() if k != 'cleared_tool_uses'}]},
               {'applied_edits': [dict(THINKING, cleared_tool_uses=0)]}]
        for site in ('start', 'assistant', 'delta'):
            for value in bad:
                with self.subTest(site=site, value=value):
                    _, channel, _, frame = self.prepare(site, value)
                    self.refused(channel, frame)

    def test_all_counters_are_finite_non_bool_safe_integers(self):
        for edit in (TOOL, THINKING):
            for counter in set(edit) - {'type'}:
                for value in (-1, True, False, 1.0, float('inf'), float('nan'),
                              2**53, '1', None, [], {'deep': {'value': 1}}):
                    for site in ('assistant', 'delta'):
                        with self.subTest(kind=edit['type'], counter=counter, value=value, site=site):
                            metadata = {'applied_edits': [dict(edit, **{counter: value})]}
                            _, channel, _, frame = self.prepare(site, metadata)
                            # Invalid JSON numbers can be refused by the existing wire encoder.
                            with self.assertRaises((Refused, ValueError)): channel.provider(frame)
                            self.assertFalse(channel.terminal)
        for value in (0, 2**53 - 1):
            metadata = {'applied_edits': [dict(TOOL, cleared_input_tokens=value, cleared_tool_uses=value)]}
            _, channel, _, frame = self.prepare('delta', metadata)
            self.assertIsNone(channel.provider(frame))
            self.assertFalse(channel.terminal)

    def test_edit_count_and_existing_event_byte_budgets_remain_bounded(self):
        for site in ('start', 'assistant', 'delta'):
            for count in (16, 17):
                _, channel, _, frame = self.prepare(site, {'applied_edits': [TOOL] * count})
                if count == 16: self.assertIsNone(channel.provider(frame))
                else: self.refused(channel, frame)
        for budget in ('wire', 'events'):
            _, channel, _, frame = self.prepare('delta', METADATA)
            if budget == 'wire': channel.stream.raw_bytes = MAX_RAW - 1
            else: channel.stream.events = {str(uuid.uuid4()) for _ in range(MAX_EVENTS)}
            self.refused(channel, frame)

    def test_metadata_does_not_relax_input_session_api_or_tool_parent_correlation(self):
        for update in ({'session_id': str(uuid.uuid4())}, {'user_message_uuid': str(uuid.uuid4())},
                       {'user_message_uuids': []}, {'api_message_id': 'foreign-api'},
                       {'parent_tool_use_id': 'synthetic-tool'}, {'uuid': 'not-a-uuid'}):
            for site in ('start', 'assistant', 'delta'):
                with self.subTest(site=site, update=update):
                    _, channel, _, frame = self.prepare(site, METADATA)
                    if site == 'assistant' and 'api_message_id' in update:
                        frame['message']['id'] = update['api_message_id']
                    else: frame.update(update)
                    self.refused(channel, frame)

    def test_unanchored_replayed_and_unverified_sequences_still_refuse(self):
        _, channel, frames = self.fixture()
        end = frames.ending(); end['event']['context_management'] = METADATA
        self.refused(channel, end)
        _, channel, _, end = self.prepare('delta', METADATA)
        self.assertIsNone(channel.provider(end)); self.refused(channel, end)
        _, channel, frames = self.fixture()
        channel.provider(frames.start()); channel.provider(frames.block())
        channel.provider(frames.delta('synthetic')); channel.provider(frames.block_stop())
        end = frames.ending(); end['event']['context_management'] = METADATA
        channel.provider(end); channel.provider(frames.stop())
        self.refused(channel, frames.result('synthetic'))

    def test_other_message_metadata_usage_and_stop_shapes_stay_closed(self):
        for site in ('assistant', 'delta'):
            for key in ('container', 'stop_details', 'unexpected'):
                _, channel, _, frame = self.prepare(site, METADATA)
                target = frame['message'] if site == 'assistant' else frame['event']['delta']
                target[key] = {'synthetic': 'untrusted'}
                self.refused(channel, frame)
        _, channel, _, frame = self.prepare('delta', METADATA)
        frame['event']['usage']['server_tool_use'] = {'web_search_requests': 1}
        self.refused(channel, frame)
        _, channel, _, frame = self.prepare('assistant', METADATA)
        frame['message']['content'] = [{'type': 'tool_use', 'id': 'tool', 'name': 'tool', 'input': {}}]
        self.refused(channel, frame)

    def test_metadata_does_not_make_null_stop_reason_ordinary_completion(self):
        _, channel, _, frame = self.prepare('delta', METADATA)
        frame['event']['delta']['stop_reason'] = None
        self.refused(channel, frame)


if __name__ == '__main__':
    unittest.main()
