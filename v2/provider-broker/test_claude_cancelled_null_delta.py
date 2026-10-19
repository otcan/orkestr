"""Native turn-close metadata cannot acknowledge or complete cancellation."""
import copy
import unittest
import uuid

from protocol import Refused
from claude_stream_schema import MAX_EVENTS, MAX_RAW, STOP_REASONS
import test_claude_control as control
from test_claude_streaming import Frames


class ClaudeCancelledNullDeltaTests(unittest.TestCase):
    def setUp(self):
        self.fixture = control.ClaudeControlTests()
        self.fixture.setUp()
        self.channel = self.fixture.channel
        self.frames = Frames(self.channel.native, self.channel.input_uuid)

    def ready(self, cancel=True, close_block=True):
        self.channel.provider(self.frames.start())
        self.channel.provider(self.frames.block())
        output = self.channel.provider(self.frames.delta('synthetic partial text'))
        self.assertEqual(output['params']['frame']['message']['content'],
                         [{'type': 'text', 'text': 'synthetic partial text'}])
        if cancel:
            self.channel.client(self.fixture.request())
        full = self.frames.assistant('synthetic partial text')
        if cancel:
            full['aborted'] = True
        self.assertIsNone(self.channel.provider(full))
        if close_block:
            self.channel.provider(self.frames.block_stop())
        return self.closing()

    def closing(self):
        frame = self.frames.ending()
        frame['event']['context_management'] = None
        frame['event']['delta'].update(stop_reason=None, stop_sequence=None,
                                       stop_details=None, container=None)
        return frame

    def refused(self, frame):
        with self.assertRaises(Refused):
            self.channel.provider(frame)
        self.assertTrue(self.channel.poisoned)
        self.assertFalse(self.channel.terminal)
        if self.channel.control is not None:
            self.assertFalse(self.channel.control.ack)
            self.assertIsNone(self.channel.control.terminal)

    def test_current_cancelled_closing_metadata_needs_separate_ack_and_terminal(self):
        for ack_first in (False, True):
            with self.subTest(ack_first=ack_first):
                self.setUp()
                frame = self.ready()
                original = copy.deepcopy(frame)
                if ack_first:
                    self.channel.provider(self.fixture.ack())
                self.assertIsNone(self.channel.provider(frame))
                self.assertEqual(frame, original)
                self.assertEqual(self.channel.stream.state, 'ending')
                self.assertFalse(self.channel.terminal)
                self.assertIsNone(self.channel.control.terminal)
                self.assertEqual(self.channel.control.ack, ack_first)
                self.assertIsNone(self.channel.provider(self.frames.stop()))
                self.assertEqual(self.channel.stream.state, 'stopped')
                self.assertFalse(self.channel.terminal)
                self.assertIsNone(self.channel.control.terminal)
                if not ack_first:
                    self.channel.provider(self.fixture.ack())
                self.assertFalse(self.channel.terminal)
                clean = self.channel.provider(self.fixture.terminal())['params']['frame']
                self.assertEqual(clean['terminal_reason'], 'aborted_streaming')
                self.assertNotIn('synthetic partial text', str(clean))

    def test_no_cancel_or_wrong_input_cancellation_cannot_admit_null(self):
        self.refused(self.ready(cancel=False))
        self.setUp()
        frame = self.ready(cancel=False)
        request = self.fixture.request()
        request['params']['frame']['request']['for_user_message_uuids'] = [str(uuid.uuid4())]
        with self.assertRaises(Refused):
            self.channel.client(request)
        self.assertIsNone(self.channel.control)
        self.refused(frame)
        self.assertNotIn(None, STOP_REASONS)

    def test_only_null_with_null_sequence_details_and_container_is_new(self):
        for key, value in (
            ('stop_reason', False), ('stop_reason', 0), ('stop_reason', ''),
            ('stop_reason', 'aborted_streaming'), ('stop_reason', 'tool_use'),
            ('stop_reason', 'pause_turn'), ('stop_reason', []), ('stop_reason', {}),
            ('stop_sequence', ''), ('stop_sequence', 'synthetic'),
            ('stop_sequence', False), ('stop_sequence', 0),
            ('stop_details', {}), ('stop_details', {'type': 'refusal'}),
            ('container', {}), ('container', 'synthetic-container'),
            ('unknown', None),
        ):
            with self.subTest(key=key, value=repr(value)):
                self.setUp()
                frame = self.ready()
                frame['event']['delta'][key] = value
                self.refused(frame)
        self.setUp()
        frame = self.ready()
        del frame['event']['delta']['stop_reason']
        self.refused(frame)

    def test_current_native_api_input_parent_and_uuid_are_still_required(self):
        for change in (
            lambda f: f.update(session_id=str(uuid.uuid4())),
            lambda f: f.update(api_message_id='synthetic-foreign-api'),
            lambda f: f.update(user_message_uuid=str(uuid.uuid4())),
            lambda f: f.update(user_message_uuids=[str(uuid.uuid4())]),
            lambda f: f.update(parent_tool_use_id='synthetic-tool'),
            lambda f: f.update(uuid=self.channel.input_uuid),
            lambda f: f.update(uuid='invalid'),
        ):
            self.setUp()
            frame = self.ready()
            change(frame)
            self.refused(frame)

    def test_anchor_closed_block_order_replay_and_terminal_cannot_be_bypassed(self):
        self.channel.client(self.fixture.request())
        self.refused(self.closing())
        self.setUp()
        self.refused(self.ready(close_block=False))
        for mode in ('replay', 'second_delta', 'after_message_stop'):
            with self.subTest(mode=mode):
                self.setUp()
                frame = self.ready()
                self.channel.provider(frame)
                if mode == 'after_message_stop':
                    self.channel.provider(self.frames.stop())
                self.refused(frame if mode == 'replay' else self.closing())

    def test_original_frame_wire_event_usage_and_unknown_metadata_limits_remain(self):
        for mode in ('frame', 'wire', 'event', 'negative_usage', 'tool_usage',
                     'context', 'unknown', 'details'):
            with self.subTest(mode=mode):
                self.setUp()
                frame = self.ready()
                if mode == 'frame':
                    frame['event']['delta']['stop_sequence'] = 'x' * 65536
                elif mode == 'wire':
                    self.channel.wire_bytes = MAX_RAW
                elif mode == 'event':
                    self.channel.stream.events = {str(uuid.uuid4()) for _ in range(MAX_EVENTS)}
                elif mode == 'negative_usage':
                    frame['event']['usage']['output_tokens'] = -1
                elif mode == 'tool_usage':
                    frame['event']['usage']['server_tool_use'] = {'web_search_requests': 1}
                elif mode == 'context':
                    frame['event']['context_management'] = {'synthetic': True}
                elif mode == 'unknown':
                    frame['event']['extra'] = {'synthetic': True}
                else:
                    frame['event']['delta']['stop_details'] = {'synthetic': {'deep': ['metadata']}}
                self.refused(frame)

    def test_closing_frames_cannot_turn_cancel_into_success_or_accept_post_terminal_output(self):
        self.channel.provider(self.ready())
        self.channel.provider(self.frames.stop())
        self.refused(self.frames.result('synthetic partial text'))
        self.setUp()
        self.channel.provider(self.ready())
        self.channel.provider(self.frames.stop())
        self.channel.provider(self.fixture.terminal())
        with self.assertRaises(Refused):
            self.channel.provider(self.closing())
        self.assertTrue(self.channel.poisoned)

    def test_ordinary_nonnull_stop_reasons_are_unchanged(self):
        for reason in STOP_REASONS:
            self.setUp()
            frame = self.ready(cancel=False)
            frame['event']['delta']['stop_reason'] = reason
            self.assertIsNone(self.channel.provider(frame))
            self.channel.provider(self.frames.stop())
            self.assertFalse(self.channel.terminal)
            self.assertIsNone(self.channel.control)


if __name__ == '__main__':
    unittest.main()
