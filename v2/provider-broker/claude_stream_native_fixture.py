#!/usr/bin/python3
"""Owned synthetic process for partial-output tests. Never an account launcher."""
import json
from pathlib import Path
import sys
import time
import uuid


def emit(value):
    print(json.dumps(value, separators=(',', ':')), flush=True)


def main():
    assert sys.argv.count('--include-partial-messages') == 1
    native = sys.argv[sys.argv.index('--session-id') + 1]
    setup = json.loads(sys.stdin.readline())
    assert setup['request'] == {'subtype': 'initialize', 'hooks': None}
    emit({'type': 'control_response', 'response': {'subtype': 'success',
          'request_id': setup['request_id'], 'response': {}}})
    submitted = json.loads(sys.stdin.readline())
    assert submitted['type'] == 'user' and submitted['session_id'] == native
    current = submitted['uuid']; api = 'synthetic-streamed-response'
    mode = submitted['message']['content']; assert mode in ('complete', 'cancel')

    def event(value, first=False):
        frame = {'type': 'stream_event', 'session_id': native, 'uuid': str(uuid.uuid4()),
                 'api_message_id': api, 'parent_tool_use_id': None, 'event': value}
        if first: frame.update(user_message_uuid=current, user_message_uuids=[current])
        emit(frame)

    emit({'type': 'system', 'subtype': 'init', 'session_id': native})
    event({'type': 'message_start', 'message': {'id': api, 'type': 'message', 'role': 'assistant',
          'content': [], 'model': 'synthetic-model', 'stop_reason': None,
          'usage': {'input_tokens': 1, 'output_tokens': 0}}}, first=True)
    event({'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}})
    piece = 'synthetic chunk ' * 400
    event({'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': piece}})
    if mode == 'cancel':
        control = json.loads(sys.stdin.readline())
        assert control['request'] == {'subtype': 'interrupt', 'cancel_queued': False,
                                      'for_user_message_uuids': [current]}
        emit({'type': 'control_response', 'response': {'subtype': 'success',
              'request_id': control['request_id'], 'response': {'turn': 'stopped'}}})
        event({'type': 'content_block_delta', 'index': 0,
               'delta': {'type': 'text_delta', 'text': 'late text must be discarded'}})
    deadline = time.monotonic() + 5
    while not Path('release-synthetic-stream').exists():
        assert time.monotonic() < deadline
        time.sleep(.01)
    if mode == 'complete':
        for _ in range(3):
            event({'type': 'content_block_delta', 'index': 0,
                   'delta': {'type': 'text_delta', 'text': piece}})
        emit({'type': 'assistant', 'session_id': native, 'uuid': str(uuid.uuid4()),
              'parent_tool_use_id': None, 'user_message_uuid': current, 'user_message_uuids': [current],
              'request_id': 'synthetic-request', 'message': {'id': api, 'type': 'message',
              'role': 'assistant', 'model': 'synthetic-model', 'content': [{'type': 'text', 'text': piece * 4}]}})
        event({'type': 'content_block_stop', 'index': 0})
        event({'type': 'message_delta', 'delta': {'stop_reason': 'end_turn', 'stop_sequence': None},
               'usage': {'output_tokens': 1}})
        event({'type': 'message_stop'})
        emit({'type': 'result', 'session_id': native, 'uuid': str(uuid.uuid4()),
              'user_message_uuid': current, 'subtype': 'success', 'is_error': False, 'result': piece * 4})
    else:
        emit({'type': 'result', 'session_id': native, 'uuid': str(uuid.uuid4()),
              'user_message_uuid': current, 'subtype': 'error_during_execution', 'is_error': True,
              'terminal_reason': 'aborted_streaming', 'errors': ['synthetic interruption']})
    assert sys.stdin.read() == ''


if __name__ == '__main__': main()
