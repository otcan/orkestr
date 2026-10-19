#!/usr/bin/python3
"""Fixed no-tools native fixture for ordinary HTTP Stop and held-input recovery."""
import json
import os
from pathlib import Path
import select
import sys
import time
import uuid

prefix = ['-p','--input-format','stream-json','--output-format','stream-json',
          '--verbose','--permission-mode','dontAsk','--permission-prompts','none',
          '--safe-mode','--restricted','--disable-slash-commands','--no-chrome',
          '--prompt-suggestions','false','--tools','','--strict-mcp-config',
          '--mcp-config','{"mcpServers":{}}','--setting-sources','']
assert sys.argv[1:-2] == prefix and sys.argv[-2] in ('--session-id','--resume')
native = str(uuid.UUID(sys.argv[-1]))
resumed = sys.argv[-2] == '--resume'
assert set(os.environ) == {'PATH','LANG','LC_ALL','HOME','TMPDIR','CLAUDE_CONFIG_DIR','PWD'}
assert os.environ['PWD'] == os.getcwd()
transcript = Path(os.environ['CLAUDE_CONFIG_DIR']) / 'synthetic-transcript.json'
prior = json.loads(transcript.read_text()) if resumed else []
assert bool(prior) == resumed and all(row['native'] == native for row in prior)
number = len(prior) + 1
mode = Path('claude-mode').read_text()


def record(kind, **fields):
    with Path('synthetic-peer.jsonl').open('a') as stream:
        stream.write(json.dumps({'kind':kind,'pid':os.getpid(),'native':native,
            'number':number,'resumed':resumed,
            'pid_namespace':Path('/proc/self/ns/pid').stat().st_ino,
            'process_start':int(Path('/proc/self/stat').read_text().rsplit(') ',1)[1].split()[19]),
            **fields})+'\n')


def barrier(name):
    deadline = time.monotonic()+20
    while not Path(f'{name}-{number}').exists():
        assert time.monotonic()<deadline
        time.sleep(0.005)


def emit(frame):
    print(json.dumps(frame),flush=True)


record('spawn')
barrier('host-observed')
frame = json.loads(sys.stdin.readline())
assert frame == {'type':'control_request','request_id':'initialize:2',
                 'request':{'subtype':'initialize','hooks':None}}
emit({'type':'control_response','response':{'subtype':'success','request_id':'initialize:2','response':{}}})
record('initialized')
frame = json.loads(sys.stdin.readline())
active = str(uuid.UUID(frame['uuid']))
assert frame['type']=='user' and frame['session_id']==native and frame['parent_tool_use_id'] is None
assert frame['message']['role']=='user' and frame['message']['content'].startswith('synthetic ordinary HTTP input')
record('turn',input_uuid=active,prior_count=len(prior))
transcript.write_text(json.dumps(prior+[{'native':native,'input':active}]))
barrier('release-init')
emit({'type':'system','subtype':'init','session_id':native})
record('init-emitted')


def progress():
    emit({'type':'assistant','session_id':native,'uuid':str(uuid.uuid4()),
          'user_message_uuid':active,'message':{'role':'assistant',
          'content':[{'type':'text','text':'Synthetic Claude progress'}]}})


progress()
interrupted = completed = advanced = False
while True:
    if not completed and not interrupted and Path(f'release-result-{number}').exists():
        emit({'type':'result','session_id':native,'uuid':str(uuid.uuid4()),
              'user_message_uuid':active,'subtype':'success','is_error':False,
              'result':'Synthetic Claude progress'})
        record('result'); completed = True
    if not advanced and not completed and not interrupted and Path('advance-progress').exists():
        progress(); record('advanced-progress'); advanced = True
    if not select.select([sys.stdin],[],[],0.01)[0]:
        continue
    line = sys.stdin.readline()
    if not line:
        break
    assert not interrupted and not completed
    control = json.loads(line)
    assert control == {'type':'control_request','request_id':'interrupt:4',
        'request':{'subtype':'interrupt','cancel_queued':False,'for_user_message_uuids':[active]}}
    interrupted = True; record('interrupt',input_uuid=active)
    ack = {'type':'control_response','response':{'subtype':'success','request_id':'interrupt:4','response':{'turn':'stopped'}}}
    terminal = {'type':'result','session_id':native,'uuid':str(uuid.uuid4()),
        'user_message_uuid':active,'subtype':'error_during_execution','is_error':True,
        'terminal_reason':'aborted_streaming'}
    if mode != 'terminal-first':
        emit(ack); record('interrupt-ack')
    if mode in ('ack-only','revoke-after-ack','shutdown-after-ack'):
        continue
    barrier('release-terminal')
    if mode == 'burst':
        for _ in range(64):
            progress()
    if mode == 'foreign':
        terminal['user_message_uuid'] = str(uuid.uuid4())
    emit(terminal); record('interrupted-terminal')
    if mode == 'terminal-first':
        emit(ack); record('interrupt-ack')
    if mode == 'burst':
        emit({'type':'command_lifecycle','uuid':str(uuid.uuid4()),'session_id':native,
              'command_uuid':active,'state':'cancelled'})
