#!/usr/bin/python3
"""Fixed native error shape, no provider/account/network activity."""
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
deadline = time.monotonic() + 10
while not Path('release-error').exists():
    assert time.monotonic() < deadline
    time.sleep(.005)
emit({'type': 'system', 'subtype': 'init', 'session_id': native})
result = {'type': 'result', 'subtype': 'error_during_execution', 'duration_ms': 0,
    'duration_api_ms': 0, 'is_error': True, 'num_turns': 0, 'stop_reason': None,
    'session_id': native, 'total_cost_usd': 0, 'usage': {}, 'modelUsage': {},
    'permission_denials': [], 'uuid': str(uuid.uuid4()),
    'errors': ['synthetic-private-error-must-not-persist'], 'user_message_uuid': message}
mode = Path('claude-mode').read_text()
if mode == 'foreign-error':
    result['user_message_uuid'] = str(uuid.uuid4())
elif mode == 'malformed-error':
    result['errors'] = {'unexpected': 'synthetic-private-error-must-not-persist'}
else:
    assert mode == 'error'
emit(result)
record('error-result')
assert not sys.stdin.read(), 'error must never admit a successor on this native'
