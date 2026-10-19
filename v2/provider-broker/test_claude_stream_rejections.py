"""Immutable refusal boundaries for the selected single-input stream."""
import json
import unittest
import uuid

from claude_pump import ClaudePump
from claude_stream_schema import MAX_RAW
from protocol import Refused
import test_claude_streaming as fixtures


class ClaudeStreamRejections(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.ClaudeStreamingTests(); self.case.setUp()
        self.channel, self.frames = self.case.channel, self.case.frames

    def begin(self):
        self.case.begin()

    def reject(self, frame):
        with self.assertRaises((Refused, ValueError, TypeError)):
            self.channel.provider(frame)
        self.assertTrue(self.channel.poisoned)
        self.assertFalse(self.channel.terminal)
        with self.assertRaises(Refused):
            self.channel.provider(self.frames.delta('valid bytes cannot revive a poisoned channel'))

    def finish_text(self, text='synthetic text'):
        self.begin(); self.channel.provider(self.frames.delta(text))
        self.channel.provider(self.frames.assistant(text))
        for frame in (self.frames.block_stop(), self.frames.ending(), self.frames.stop()):
            self.channel.provider(frame)

    def test_first_stream_cannot_borrow_assistant_echo_or_status(self):
        status = {'type': 'system', 'subtype': 'status', 'status': 'requesting',
                  'session_id': self.channel.native, 'uuid': str(uuid.uuid4()),
                  'user_message_uuids': [self.channel.input_uuid]}
        self.assertIsNone(self.channel.provider(status))
        start = self.frames.start(); start.pop('user_message_uuid'); start.pop('user_message_uuids')
        self.reject(start)
        self.setUp()
        self.channel.provider(self.frames.assistant('legacy explicitly correlated text'))
        self.reject(self.frames.start())

    def test_independent_first_assistant_echo_required(self):
        self.begin(); self.channel.provider(self.frames.delta('text'))
        frame = self.frames.assistant('text')
        frame.pop('user_message_uuid'); frame.pop('user_message_uuids')
        self.reject(frame)

    def test_foreign_scope_history_and_unknown_envelope_refuse(self):
        changes = [lambda f: f.update(session_id=str(uuid.uuid4())),
                   lambda f: f.update(user_message_uuid=str(uuid.uuid4())),
                   lambda f: f.update(user_message_uuids=[str(uuid.uuid4())]),
                   lambda f: f.update(parent_tool_use_id='foreign-tool'),
                   lambda f: f.update(api_message_id='foreign-response'),
                   lambda f: f.update(sessionId=self.channel.native),
                   lambda f: f.update(historical=True), lambda f: f.update(isReplay=True),
                   lambda f: f.update(agent_id='other'), lambda f: f.update(unknown=None)]
        for change in changes:
            with self.subTest(change=changes.index(change)):
                self.setUp(); self.begin(); frame = self.frames.delta('text'); change(frame)
                self.reject(frame)

    def test_missing_api_identity_and_second_response_refuse(self):
        self.begin(); frame = self.frames.delta('text'); frame.pop('api_message_id'); self.reject(frame)
        self.setUp(); self.begin(); self.reject(self.frames.start())
        self.setUp(); start = self.frames.start(); start['event']['message']['id'] = 'different'
        self.reject(start)

    def test_out_of_order_structural_events_refuse(self):
        for kind in ('delta', 'start-index', 'stop-index', 'message-stop', 'message-delta'):
            with self.subTest(kind=kind):
                self.setUp()
                if kind == 'delta': frame = self.frames.delta('text')
                else:
                    self.channel.provider(self.frames.start())
                    if kind == 'start-index': frame = self.frames.block(1)
                    elif kind == 'stop-index': frame = self.frames.block_stop()
                    elif kind == 'message-stop': frame = self.frames.stop()
                    else:
                        self.channel.provider(self.frames.block()); frame = self.frames.ending()
                self.reject(frame)
        self.setUp(); self.begin(); frame = self.frames.delta('text'); frame['event']['index'] = False
        self.reject(frame)
        self.setUp(); self.begin(); self.channel.provider(self.frames.block_stop())
        self.reject(self.frames.block_stop())

    def test_no_tool_unknown_or_nonfinite_structures(self):
        invalid = [
            {'type': 'content_block_start', 'index': 0, 'content_block': {
                'type': 'tool_use', 'id': 'tool', 'name': 'shell', 'input': {}}},
            {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': 'hidden prefix'}},
            {'type': 'message_start', 'message': {'id': 'api', 'role': 'assistant', 'content': []}},
            {'type': 'unknown'},
        ]
        for event in invalid:
            self.setUp(); self.channel.provider(self.frames.start()); self.reject(self.frames.event(event))
        for delta in ({'type': 'input_json_delta', 'partial_json': '{}'},
                      {'type': 'citations_delta', 'citation': {}},
                      {'type': 'text_delta', 'text': 'visible', 'extra': None},
                      {'type': 'text_delta', 'text': float('nan')}):
            self.setUp(); self.begin()
            self.reject(self.frames.event({'type': 'content_block_delta', 'index': 0, 'delta': delta}))
        self.setUp(); start = self.frames.start(); start['event']['message']['usage']['output_tokens'] = True
        self.reject(start)

    def test_full_block_and_terminal_mismatches_poison(self):
        self.begin(); self.channel.provider(self.frames.delta('original'))
        self.reject(self.frames.assistant('substitution'))
        self.setUp(); self.finish_text('original'); self.reject(self.frames.result('substitution'))
        self.setUp(); self.begin(); self.channel.provider(self.frames.delta('text'))
        full = self.frames.assistant('text'); full['message']['model'] = 'foreign-model'
        self.reject(full)

    def test_unfinished_or_missing_full_blocks_cannot_succeed(self):
        for phase in ('open', 'no-full', 'no-stop'):
            self.setUp(); self.begin(); self.channel.provider(self.frames.delta('text'))
            if phase != 'no-full': self.channel.provider(self.frames.assistant('text'))
            if phase != 'open': self.channel.provider(self.frames.block_stop())
            if phase == 'no-full':
                self.channel.provider(self.frames.ending()); self.channel.provider(self.frames.stop())
            self.reject(self.frames.result('text'))

    def test_uuid_replay_and_cross_kind_reuse_cannot_succeed(self):
        self.begin(); delta = self.frames.delta('text'); self.channel.provider(delta)
        self.reject(delta)
        self.setUp(); self.begin(); delta = self.frames.delta('text'); self.channel.provider(delta)
        full = self.frames.assistant('text'); full['uuid'] = delta['uuid']; self.reject(full)
        self.setUp(); self.finish_text(); result = self.frames.result('synthetic text')
        result['uuid'] = next(iter(self.channel.stream.events)); self.reject(result)

    def test_full_block_replay_and_delta_after_verification_refuse(self):
        self.begin(); self.channel.provider(self.frames.delta('text'))
        full = self.frames.assistant('text'); self.channel.provider(full)
        self.reject(dict(full, uuid=str(uuid.uuid4())))
        self.setUp(); self.begin(); self.channel.provider(self.frames.delta('text'))
        self.channel.provider(self.frames.assistant('text')); self.reject(self.frames.delta('late'))

    def test_full_assistant_must_precede_its_own_block_stop(self):
        self.begin(); self.channel.provider(self.frames.delta('text'))
        self.channel.provider(self.frames.block_stop())
        self.reject(self.frames.assistant('text'))

    def test_cancelled_stream_cannot_change_terminal_input_or_reopen_legacy_notices(self):
        self.begin(); self.channel.provider(self.frames.delta('partial'))
        self.channel.client(self.case.fixture.request())
        terminal = self.case.fixture.terminal(); terminal['user_message_uuid'] = str(uuid.uuid4())
        self.reject(terminal)
        self.setUp(); self.channel.client(self.case.fixture.request())
        notice = self.frames.delta('discard only'); notice.pop('api_message_id')
        self.assertIsNone(self.channel.provider(notice))
        self.assertFalse(self.channel.stream.started or self.channel.control.ack or self.channel.terminal)
        self.reject(self.frames.start())

    def test_all_partial_and_full_output_after_terminal_refuses(self):
        for make in ('delta', 'assistant', 'start'):
            self.setUp(); self.finish_text(); self.channel.provider(self.frames.result('synthetic text'))
            frame = getattr(self.frames, make)('late') if make != 'start' else self.frames.start()
            with self.assertRaises(Refused): self.channel.provider(frame)
            self.assertTrue(self.channel.poisoned)

    def test_text_caps_count_utf8_and_stay_enforced_after_cancel(self):
        self.begin(); self.reject(self.frames.delta('x' * 8193))
        self.setUp(); self.begin()
        piece = '\u00fc' * 2048  # 4096 UTF-8 bytes.
        for _ in range(8): self.channel.provider(self.frames.delta(piece))
        self.assertEqual(self.channel.stream.text_bytes, 32768)
        self.channel.client(self.case.fixture.request())
        self.reject(self.frames.delta('x'))

    def test_block_and_discarded_thinking_budgets_are_finite(self):
        self.channel.provider(self.frames.start())
        for index in range(128):
            self.channel.provider(self.frames.block(index))
            self.channel.provider(self.frames.block_stop(index))
        self.reject(self.frames.block(128))
        self.setUp(); self.channel.provider(self.frames.start())
        self.channel.provider(self.frames.block(kind='thinking'))
        for _ in range(32): self.channel.provider(self.frames.delta('x' * 8192, kind='thinking'))
        self.assertEqual(self.channel.stream.thinking_bytes, 262144)
        self.reject(self.frames.delta('x', kind='thinking'))

    def test_redacted_thinking_is_validated_without_storage_or_progress(self):
        self.channel.provider(self.frames.start())
        marker = 'SYNTHETIC_REDACTED_MUST_NOT_REMAIN'
        self.assertIsNone(self.channel.provider(self.frames.event({
            'type': 'content_block_start', 'index': 0,
            'content_block': {'type': 'redacted_thinking', 'data': marker}})))
        full = self.frames.assistant('unused')
        full['message']['content'] = [{'type': 'redacted_thinking', 'data': marker}]
        self.assertIsNone(self.channel.provider(full))
        self.assertNotIn(marker, repr(self.channel.stream.__dict__))
        self.channel.provider(self.frames.block_stop())
        self.channel.provider(self.frames.block(1))
        self.channel.provider(self.frames.delta('visible', 1))
        self.channel.provider(self.frames.assistant('visible'))
        self.channel.provider(self.frames.block_stop(1)); self.channel.provider(self.frames.ending())
        self.channel.provider(self.frames.stop()); self.channel.provider(self.frames.result('visible'))

    def test_event_budget_and_whitespace_count_actual_wire_bytes(self):
        def ping():
            frame = self.frames.event({'type': 'ping'}); frame.pop('api_message_id'); return frame
        for _ in range(1024): self.channel.provider(ping())
        self.reject(ping())
        self.setUp()
        pump = ClaudePump(None, self.channel, incoming=100, outgoing=101)
        before = self.channel.wire_bytes  # Current input's system/init is also counted.
        try:
            for _ in range(16):
                raw = json.dumps(ping(), separators=(',', ':')).encode().ljust(65500, b' ')
                pump.line(102, raw)
            self.assertEqual(self.channel.wire_bytes, before + 16 * 65501)
            self.assertLess(self.channel.wire_bytes, MAX_RAW)
            with self.assertRaises(Refused): pump.line(102, json.dumps(ping()).encode().ljust(65500, b' '))
            self.assertTrue(self.channel.poisoned)
        finally:
            pump.selector.close()

    def test_thinking_is_discard_only_and_full_echo_is_independent(self):
        marker = 'SYNTHETIC_THINKING_MUST_NOT_LEAVE'
        self.channel.provider(self.frames.start())
        self.assertIsNone(self.channel.provider(self.frames.block(kind='thinking')))
        self.assertIsNone(self.channel.provider(self.frames.delta(marker, kind='thinking')))
        self.assertIsNone(self.channel.provider(self.frames.assistant(marker, kind='thinking')))
        self.channel.provider(self.frames.block_stop())
        self.channel.provider(self.frames.block(1))
        output = self.channel.provider(self.frames.delta('visible text', 1))
        self.assertNotIn(marker, str(output))
        self.assertNotIn(marker, repr(self.channel.stream.__dict__))
        self.assertIsNone(self.channel.provider(self.frames.assistant('visible text')))
        self.channel.provider(self.frames.block_stop(1)); self.channel.provider(self.frames.ending())
        self.channel.provider(self.frames.stop()); self.channel.provider(self.frames.result('visible text'))

    def test_cancel_discards_late_text_and_ack_alone_is_never_terminal(self):
        self.begin(); self.channel.provider(self.frames.delta('before'))
        self.channel.client(self.case.fixture.request())
        self.assertIsNone(self.channel.provider(self.frames.delta(' after')))
        self.assertIsNone(self.channel.provider(self.frames.assistant('before after')))
        self.channel.provider(self.frames.block_stop())
        self.channel.provider(self.frames.event({'type': 'message_stop'}, abandoned_blocks={
            'api_message_id': self.frames.api, 'from_block_index': 1}))
        self.channel.provider(self.case.fixture.ack())
        self.assertFalse(self.channel.terminal)
        terminal = self.channel.provider(self.case.fixture.terminal())['params']['frame']
        self.assertEqual(terminal['terminal_reason'], 'aborted_streaming')
        self.assertNotIn('before', str(terminal)); self.assertTrue(self.channel.terminal)

    def test_interrupted_terminal_can_close_unfinished_stream_but_success_cannot(self):
        self.begin(); self.channel.provider(self.frames.delta('partial'))
        self.channel.client(self.case.fixture.request())
        self.channel.provider(self.case.fixture.terminal())
        self.assertTrue(self.channel.terminal); self.assertFalse(self.channel.control.ack)
        self.setUp(); self.begin(); self.channel.provider(self.frames.delta('partial'))
        self.channel.client(self.case.fixture.request()); self.reject(self.frames.result('partial'))
        self.setUp(); self.begin(); self.channel.client(self.case.fixture.request())
        late = self.frames.delta('not an anchored event'); late.pop('api_message_id')
        self.reject(late)


if __name__ == '__main__':
    unittest.main()
