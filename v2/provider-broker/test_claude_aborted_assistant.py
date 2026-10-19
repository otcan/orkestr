"""Pinned native abort shape; synthetic input only, never Stop authority."""
import copy
import unittest
import uuid

from protocol import Refused
import test_claude_control as control
from test_claude_streaming import Frames


class ClaudeAbortedAssistantTests(unittest.TestCase):
    def setUp(self):
        self.fixture = control.ClaudeControlTests()
        self.fixture.setUp()
        self.channel = self.fixture.channel
        self.frames = Frames(self.channel.native, self.channel.input_uuid)

    def ready(self, cancel=True, thinking_prefix=True):
        self.channel.provider(self.frames.start())
        index = 0
        if thinking_prefix:
            self.channel.provider(self.frames.block(kind='thinking'))
            self.channel.provider(self.frames.delta('synthetic thought', kind='thinking'))
            self.channel.provider(self.frames.assistant('synthetic thought', kind='thinking'))
            self.channel.provider(self.frames.block_stop())
            index = 1
        self.channel.provider(self.frames.block(index))
        output = self.channel.provider(self.frames.delta('partial text', index))
        self.assertEqual(output['params']['frame']['message']['content'],
                         [{'type': 'text', 'text': 'partial text'}])
        if cancel:
            self.channel.client(self.fixture.request())
        frame = self.frames.assistant('partial text')
        frame['aborted'] = True
        return frame

    def refused(self, frame):
        with self.assertRaises(Refused):
            self.channel.provider(frame)
        self.assertTrue(self.channel.poisoned)
        self.assertFalse(self.channel.terminal)
        if self.channel.control is not None:
            self.assertFalse(self.channel.control.ack)
            self.assertIsNone(self.channel.control.terminal)
        with self.assertRaises(Refused):
            self.channel.provider(self.fixture.terminal())

    def test_cancelled_partial_full_block_is_discard_only_until_genuine_terminal(self):
        for thinking_prefix, has_stop_reason in ((False, False), (True, False), (False, True), (True, True)):
            with self.subTest(thinking_prefix=thinking_prefix, has_stop_reason=has_stop_reason):
                self.setUp()
                frame = self.ready(thinking_prefix=thinking_prefix)
                if not has_stop_reason:
                    frame['message'].pop('stop_reason')
                original = copy.deepcopy(frame)
                self.assertEqual('user_message_uuid' in frame, not thinking_prefix)
                self.assertIsNone(self.channel.provider(frame))
                self.assertEqual(frame, original)
                self.assertFalse(self.channel.control.ack or self.channel.terminal)
                self.assertIsNone(self.channel.control.terminal)
                self.assertTrue(self.channel.stream.blocks[-1]['verified'])
                # A real ACK remains separate and still supplies no terminal/reap.
                self.channel.provider(self.fixture.ack())
                self.assertFalse(self.channel.terminal)
                terminal = self.channel.provider(self.fixture.terminal())['params']['frame']
                self.assertEqual(terminal['terminal_reason'], 'aborted_streaming')
                self.assertNotIn('partial text', str(terminal))
                self.assertNotIn('aborted', terminal)

    def test_abort_requires_already_issued_current_input_cancellation(self):
        self.refused(self.ready(cancel=False))
        self.setUp()
        frame = self.ready(cancel=False)
        request = self.fixture.request()
        request['params']['frame']['request']['for_user_message_uuids'] = [str(uuid.uuid4())]
        with self.assertRaises(Refused):
            self.channel.client(request)
        self.assertIsNone(self.channel.control)
        self.refused(frame)

    def test_only_literal_true_is_accepted(self):
        for value in (False, None, 0, 1, 'true', [], {}):
            with self.subTest(value=repr(value)):
                self.setUp()
                frame = self.ready()
                frame['aborted'] = value
                self.refused(frame)

    def test_unanchored_or_legacy_assistant_cannot_borrow_abort_flag(self):
        for cancelled in (False, True):
            for echoed in (False, True):
                with self.subTest(cancelled=cancelled, echoed=echoed):
                    self.setUp()
                    if cancelled:
                        self.channel.client(self.fixture.request())
                    frame = self.frames.assistant('partial text')
                    if not echoed:
                        frame.pop('user_message_uuid')
                        frame.pop('user_message_uuids')
                    frame['aborted'] = True
                    self.refused(frame)

    def test_foreign_scope_response_request_and_event_are_still_refused(self):
        for mutation in (
            lambda f: f.update(session_id=str(uuid.uuid4())),
            lambda f: f.update(user_message_uuid=str(uuid.uuid4())),
            lambda f: f.update(user_message_uuids=[str(uuid.uuid4())]),
            lambda f: f.update(parent_tool_use_id='synthetic-foreign-tool'),
            lambda f: f['message'].update(id='synthetic-foreign-response'),
            lambda f: f['message'].update(model='synthetic-foreign-model'),
            lambda f: f.update(request_id='synthetic-foreign-request'),
            lambda f: f.update(uuid=self.channel.input_uuid),
        ):
            self.setUp()
            frame = self.ready()
            mutation(frame)
            self.refused(frame)

    def test_api_error_history_tools_unknown_and_nested_metadata_stay_closed(self):
        for mutation in (
            lambda f: f.update(error='synthetic-error'),
            lambda f: f.update(is_api_error_message=True),
            lambda f: f.update(api_error='no_response'),
            lambda f: f.update(isReplay=True),
            lambda f: f.update(is_meta=True),
            lambda f: f.update(agent_id='synthetic-agent'),
            lambda f: f.update(supersedes=[str(uuid.uuid4())]),
            lambda f: f.update(resumed_from_incomplete_thinking=True),
            lambda f: f.update(unknown={'synthetic': {'deep': ['metadata']}}),
            lambda f: f['message'].update(diagnostics={'synthetic': {'deep': ['metadata']}}),
            lambda f: f['message']['content'].append({'type': 'text', 'text': 'extra'}),
            lambda f: f['message']['content'][0].update(type='tool_use'),
            lambda f: f['message']['content'][0].update(citations=[{'synthetic': True}]),
        ):
            self.setUp()
            frame = self.ready()
            mutation(frame)
            self.refused(frame)

    def test_aborted_block_must_be_text_without_received_stop_reason(self):
        for reason in ('end_turn', 'max_tokens', 'stop_sequence', 'refusal'):
            self.setUp()
            frame = self.ready()
            frame['message']['stop_reason'] = reason
            self.refused(frame)
        self.setUp()
        self.channel.provider(self.frames.start())
        self.channel.provider(self.frames.block(kind='thinking'))
        self.channel.provider(self.frames.delta('synthetic thought', kind='thinking'))
        self.channel.client(self.fixture.request())
        frame = self.frames.assistant('synthetic thought', kind='thinking')
        frame['aborted'] = True
        self.refused(frame)

    def test_existing_hash_order_replay_and_budgets_still_apply(self):
        for mutation in ('text', 'after_block_stop', 'replay', 'frame_budget', 'wire_budget'):
            with self.subTest(mutation=mutation):
                self.setUp()
                frame = self.ready()
                if mutation == 'text':
                    frame['message']['content'][0]['text'] = 'substitution'
                elif mutation == 'after_block_stop':
                    self.channel.provider(self.frames.block_stop(1))
                elif mutation == 'replay':
                    self.assertIsNone(self.channel.provider(frame))
                elif mutation == 'frame_budget':
                    frame['message']['content'][0]['text'] = 'x' * 65536
                else:
                    self.channel.wire_bytes = 1048576
                self.refused(frame)

    def test_abort_does_not_admit_success_or_post_terminal_output(self):
        self.assertIsNone(self.channel.provider(self.ready()))
        self.refused(self.frames.result('partial text'))
        self.setUp()
        frame = self.ready()
        self.assertIsNone(self.channel.provider(frame))
        self.channel.provider(self.fixture.terminal())
        with self.assertRaises(Refused):
            self.channel.provider(dict(frame, uuid=str(uuid.uuid4())))
        self.assertTrue(self.channel.poisoned)


if __name__ == '__main__':
    unittest.main()
