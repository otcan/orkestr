"""Synthetic source-shaped streaming; no native account or network access."""
from pathlib import Path
import tempfile
import unittest
import uuid

from claude_connector import ClaudeConfiguration
import test_claude_control as control


class Frames:
    def __init__(self, native, message):
        self.native, self.message = native, message
        self.api = 'synthetic-api-message'
        self.first_assistant = True

    def event(self, event, first=False, **extra):
        frame = {'type': 'stream_event', 'session_id': self.native,
                 'parent_tool_use_id': None, 'uuid': str(uuid.uuid4()),
                 'api_message_id': self.api, 'event': event, **extra}
        if first:
            frame.update(user_message_uuid=self.message, user_message_uuids=[self.message])
        return frame

    def start(self):
        return self.event({'type': 'message_start', 'message': {
            'id': self.api, 'type': 'message', 'role': 'assistant', 'model': 'synthetic-model',
            'content': [], 'stop_reason': None, 'stop_sequence': None,
            'usage': {'input_tokens': 1, 'output_tokens': 0}}}, first=True)

    def block(self, index=0, kind='text'):
        fields = {'text': ''} if kind == 'text' else {'thinking': '', 'signature': ''}
        return self.event({'type': 'content_block_start', 'index': index,
                           'content_block': {'type': kind, **fields}})

    def delta(self, text, index=0, kind='text'):
        return self.event({'type': 'content_block_delta', 'index': index,
                           'delta': {'type': kind + '_delta', kind: text}})

    def assistant(self, text, kind='text'):
        block = {'type': kind, kind: text}
        if kind == 'thinking': block['signature'] = 'synthetic-signature'
        else: block['citations'] = None
        frame = {'type': 'assistant', 'session_id': self.native,
                 'parent_tool_use_id': None, 'uuid': str(uuid.uuid4()),
                 'request_id': 'synthetic-request', 'message': {
                     'id': self.api, 'type': 'message', 'role': 'assistant',
                     'model': 'synthetic-model', 'content': [block], 'stop_reason': None}}
        if self.first_assistant:
            frame.update(user_message_uuid=self.message, user_message_uuids=[self.message])
            self.first_assistant = False
        return frame

    def block_stop(self, index=0):
        return self.event({'type': 'content_block_stop', 'index': index})

    def ending(self):
        return self.event({'type': 'message_delta', 'delta': {
            'stop_reason': 'end_turn', 'stop_sequence': None}, 'usage': {'output_tokens': 1}})

    def stop(self):
        return self.event({'type': 'message_stop'})

    def result(self, text):
        return {'type': 'result', 'session_id': self.native, 'uuid': str(uuid.uuid4()),
                'user_message_uuid': self.message, 'user_message_uuids': [self.message],
                'subtype': 'success', 'is_error': False, 'result': text}


class ClaudeStreamingTests(unittest.TestCase):
    def setUp(self):
        self.fixture = control.ClaudeControlTests(); self.fixture.setUp()
        self.channel = self.fixture.channel
        self.frames = Frames(self.channel.native, self.channel.input_uuid)

    def begin(self):
        self.assertIsNone(self.channel.provider(self.frames.start()))
        self.assertIsNone(self.channel.provider(self.frames.block()))

    def test_partial_text_precedes_full_block_without_duplicate_output(self):
        self.begin()
        pieces = ['synthetic text ' * 400] * 4  # 24 KiB, larger than old full-block cap.
        outputs = []
        for piece in pieces:
            output = self.channel.provider(self.frames.delta(piece))
            outputs.extend(b['text'] for b in output['params']['frame']['message']['content'])
            self.assertFalse(self.channel.terminal)
        self.assertEqual(outputs, pieces)
        text = ''.join(pieces)
        # Native emits this complete block BEFORE content_block_stop.
        self.assertIsNone(self.channel.provider(self.frames.assistant(text)))
        for frame in (self.frames.block_stop(), self.frames.ending(), self.frames.stop()):
            self.assertIsNone(self.channel.provider(frame))
        terminal = self.channel.provider(self.frames.result(text))['params']['frame']
        self.assertEqual(terminal['result'], '')  # Already delivered byte-for-byte as Progress.
        self.assertTrue(self.channel.terminal)

    def test_selected_launcher_explicitly_requests_partial_messages(self):
        with tempfile.TemporaryDirectory(prefix='claude-partial-argv-') as directory:
            root = Path(directory).resolve(); executable = root / 'native'
            executable.write_text('synthetic specification only')
            session = ClaudeConfiguration(executable, root, root, root, root).new_session()
            self.assertEqual(session.command().count('--include-partial-messages'), 1)

    def test_multiple_unicode_blocks_verify_only_last_result_without_duplication(self):
        self.channel.provider(self.frames.start())
        pieces = ['\u00fc' * 4096, '\U0001f642' * 2048]
        output = []
        for index, piece in enumerate(pieces):
            self.channel.provider(self.frames.block(index))
            frame = self.channel.provider(self.frames.delta(piece, index))['params']['frame']
            output.extend(block['text'] for block in frame['message']['content'])
            self.assertIsNone(self.channel.provider(self.frames.assistant(piece)))
            self.channel.provider(self.frames.block_stop(index))
        self.channel.provider(self.frames.ending()); self.channel.provider(self.frames.stop())
        self.assertEqual(self.channel.provider(self.frames.result(pieces[-1]))['params']['frame']['result'], '')
        self.assertEqual(output, pieces)
        self.assertEqual(self.channel.stream.text_bytes, 16384)


if __name__ == '__main__':
    unittest.main()
