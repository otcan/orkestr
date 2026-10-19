#!/usr/bin/python3
"""Fixed assistant thinking metadata, no provider/account/network activity."""
import json
import os
from pathlib import Path
import sys
import time
import uuid

prefix = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
          '--verbose', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
          '--safe-mode', '--restricted', '--disable-slash-commands', '--no-chrome',
          '--prompt-suggestions', 'false', '--tools', '', '--strict-mcp-config',
          '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--session-id']
assert sys.argv[1:-1] == prefix
native = str(uuid.UUID(sys.argv[-1]))
assert set(os.environ) == {'PATH', 'LANG', 'LC_ALL', 'HOME', 'TMPDIR', 'CLAUDE_CONFIG_DIR', 'PWD'}
assert os.environ['PWD'] == os.getcwd()
assert not list(Path(os.environ['CLAUDE_CONFIG_DIR']).iterdir())


def record(kind):
    with Path('synthetic-peer.jsonl').open('a') as stream:
        stream.write(json.dumps({'kind': kind, 'pid': os.getpid(), 'native': native,
            'pid_namespace': Path('/proc/self/ns/pid').stat().st_ino,
            'process_start': int(Path('/proc/self/stat').read_text().rsplit(') ', 1)[1].split()[19])}) + '\n')


def emit(frame):
    print(json.dumps(frame), flush=True)


record('spawn')
frame = json.loads(sys.stdin.readline())
assert frame == {'type': 'control_request', 'request_id': 'initialize:2',
                 'request': {'subtype': 'initialize', 'hooks': None}}
emit({'type': 'control_response', 'response': {
    'subtype': 'success', 'request_id': frame['request_id'], 'response': {}}})
record('initialized')
frame = json.loads(sys.stdin.readline())
message = str(uuid.UUID(frame.pop('uuid')))
assert frame == {'type': 'user', 'session_id': native, 'parent_tool_use_id': None,
                 'message': {'role': 'user', 'content': 'synthetic ordinary HTTP input'}}
record('turn')
emit({'type': 'system', 'subtype': 'init', 'session_id': native})
mode = Path('claude-mode').read_text()
deadline = time.monotonic() + 10
while not Path('release-metadata').exists():
    assert time.monotonic() < deadline
    time.sleep(.005)
thinking = {'type': 'thinking', 'thinking': 'synthetic-private-thought',
            'signature': 'synthetic-private-signature'}
redacted = {'type': 'redacted_thinking', 'data': 'synthetic-private-data'}
blocks = [redacted] if mode == 'redacted' else [thinking]
if mode in ('mixed', 'tool-after-text'):
    blocks.append({'type': 'text', 'text': 'Synthetic actual text', 'citations': None})
if mode == 'tool-after-text':
    blocks.append({'type': 'tool_use', 'id': 'synthetic-tool', 'name': 'must-not-run', 'input': {}})
notice = {'type': 'assistant', 'session_id': native, 'uuid': str(uuid.uuid4()),
          'user_message_uuid': message, 'parent_tool_use_id': None,
          'message': {'role': 'assistant', 'content': blocks}}
record('metadata_attempt')
emit(notice)
if mode != 'tool-after-text':
    while not Path('release-text').exists():
        assert time.monotonic() < deadline
        time.sleep(.005)
    if mode != 'mixed':
        output = {'type': 'assistant', 'session_id': native, 'uuid': str(uuid.uuid4()),
                  'message': {'role': 'assistant',
                  'content': [{'type': 'text', 'text': 'Synthetic actual text'}]}}
        if mode != 'unstamped-text': output['user_message_uuid'] = message
        emit(output)
    if mode != 'unstamped-text':
        emit({'type': 'result', 'subtype': 'success', 'is_error': False,
              'session_id': native, 'uuid': str(uuid.uuid4()), 'user_message_uuid': message,
              'result': 'Synthetic actual text'})
assert not sys.stdin.read(), 'one native input only'
