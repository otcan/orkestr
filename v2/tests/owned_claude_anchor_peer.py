#!/usr/bin/python3
"""Fixed same-response input-omission stream, no provider/account/network activity."""
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
event = str(uuid.uuid4())
notice = {'type':'assistant','session_id':native,'uuid':event,
          'request_id':'synthetic-request','timestamp':'2026-01-01T00:00:00Z',
          'message':{'role':'assistant','id':'synthetic-api-message',
                     'content':[{'type':'thinking','thinking':'synthetic-private-thought','signature':''}]}}
if mode != 'missing-first': notice['user_message_uuid'] = message
record('metadata_attempt')
emit(notice)
if mode != 'missing-first':
    while not Path('release-text').exists():
        assert time.monotonic() < deadline
        time.sleep(.005)
    output = {'type':'assistant','session_id':native,'uuid':str(uuid.uuid4()),
              'request_id':'synthetic-request','timestamp':'2026-01-01T00:00:00Z',
              'message':{'role':'assistant','id':'synthetic-api-message',
                        'content':[{'type':'text','text':'Synthetic actual text','citations':None}]}}
    if mode == 'foreign-response': output['message']['id'] = 'different-api-message'
    elif mode == 'replayed-event': output['uuid'] = event
    else: assert mode == 'same-response'
    emit(output)
    if mode == 'same-response':
        emit({'type':'result','subtype':'success','is_error':False,'session_id':native,
              'uuid':str(uuid.uuid4()),'user_message_uuid':message,'result':'Synthetic actual text'})
assert not sys.stdin.read(), 'one native input only'
