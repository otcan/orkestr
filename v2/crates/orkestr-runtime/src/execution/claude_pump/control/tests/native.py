#!/usr/bin/python3
"""Fixed synthetic peer for actual FD/cancellation tests. No provider access."""
import json
import os
from pathlib import Path
import sys
import uuid

root = Path.cwd()
mode = (root / 'mode').read_text()
native = sys.argv[sys.argv.index('--session-id') + 1]
active = None


def emit(frame):
    print(json.dumps(frame), flush=True)


def consume(frame):
    global active
    if frame.get('type') == 'control_request' and frame['request']['subtype'] == 'initialize':
        emit({'type':'control_response', 'response':{'subtype':'success',
              'request_id':frame['request_id'], 'response':{}}})
        return
    if frame.get('type') == 'user':
        assert active is None and frame['session_id'] == native
        active = str(uuid.UUID(frame['uuid']))
        emit({'type':'system', 'subtype':'init', 'session_id':native})
        emit({'type':'assistant', 'session_id':native, 'user_message_uuid':active,
              'uuid':str(uuid.uuid4()), 'message':{'role':'assistant',
              'content':[{'type':'text', 'text':'synthetic progress'}]}})
        return
    assert frame == {'type':'control_request', 'request_id':'interrupt:4',
        'request':{'subtype':'interrupt', 'cancel_queued':False,
                   'for_user_message_uuids':[active]}}
    with (root / 'interrupts').open('ab') as stream:
        stream.write(b'one\n')
    ack = {'type':'control_response', 'response':{'subtype':'success',
           'request_id':'interrupt:4', 'response':{'turn':'stopped'}}}
    terminal = {'type':'result', 'uuid':str(uuid.uuid4()), 'session_id':native,
        'user_message_uuid':active, 'subtype':'error_during_execution',
        'is_error':True, 'terminal_reason':'aborted_streaming'}
    if mode != 'terminal-first':
        emit(ack)
    if mode == 'ack-only':
        return
    if mode == 'exit-only':
        raise SystemExit(0)
    if mode == 'burst':
        for _ in range(64):
            emit({'type':'assistant', 'session_id':native, 'user_message_uuid':active,
                  'uuid':str(uuid.uuid4()), 'message':{'role':'assistant',
                  'content':[{'type':'text','text':'buffered synthetic notice'}]}})
    if mode == 'foreign':
        terminal['user_message_uuid'] = str(uuid.uuid4())
    emit(terminal)
    if mode == 'terminal-first':
        emit(ack)
    if mode == 'duplicate':
        emit(terminal)
    if mode == 'burst':
        emit({'type':'command_lifecycle','uuid':str(uuid.uuid4()),'session_id':native,
              'command_uuid':active,'state':'cancelled'})


buffer = b''
while True:
    data = os.read(0, 4096)
    if not data:
        break
    with (root / 'native-inputs').open('ab') as stream:
        stream.write(data)
    buffer += data
    while b'\n' in buffer:
        line, buffer = buffer.split(b'\n', 1)
        consume(json.loads(line))
