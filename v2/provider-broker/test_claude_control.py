"""No-tools Stop evidence is separate from Core authority and owned cleanup."""
import uuid
import unittest
import test_claude_protocol as fixtures
from protocol import Refused

INPUT='33333333-3333-4333-8333-333333333333'
EVENT='55555555-5555-4555-8555-555555555555'


class ClaudeControlTests(unittest.TestCase):
    def setUp(self):
        fixture=fixtures.ClaudeProtocolTests();fixture.setUp();fixture.init()
        self.fixture=fixture;self.channel=fixture.channel
        self.channel.client(fixture.request(2))
        self.channel.provider({'type':'system','subtype':'init','session_id':fixture.native})

    def request(self):
        return {'id':3,'method':'CancelExecution','params':{'owned_handle':self.fixture.handle,
            'frame':{'type':'control_request','request_id':'interrupt:synthetic',
                'request':{'subtype':'interrupt','cancel_queued':False,
                    'for_user_message_uuids':[INPUT]}}}}

    def ack(self):
        return {'type':'control_response','response':{'subtype':'success',
            'request_id':'interrupt:synthetic','response':{'turn':'stopped'}}}

    def terminal(self):
        return {'type':'result','uuid':EVENT,'session_id':self.fixture.native,
            'user_message_uuid':INPUT,'user_message_uuids':[INPUT],
            'subtype':'error_during_execution','is_error':True,
            'terminal_reason':'aborted_streaming','errors':['synthetic private error'],
            'result':'synthetic private payload'}

    def test_both_orders_separate_evidence_and_sanitization(self):
        for first in ('ack','terminal'):
            self.setUp();request=self.request()
            self.assertEqual(self.channel.client(request),(request['params']['frame'],None))
            ordered=[self.ack(),self.terminal()] if first=='ack' else [self.terminal(),self.ack()]
            result=self.channel.provider(ordered[0])
            self.assertEqual(self.channel.terminal,first=='terminal')
            self.assertEqual(self.channel.control.ack,first=='ack')
            other=self.channel.provider(ordered[1])
            self.assertTrue(self.channel.terminal and self.channel.control.ack)
            self.assertNotIn('synthetic private',str((result,other)))
            self.assertEqual({result['params']['request_id'],other['params']['request_id']},{2,3})

    def test_ack_only_and_preparation_replay_do_not_complete(self):
        self.channel.client(self.request());self.channel.provider(self.ack())
        self.assertFalse(self.channel.terminal)
        with self.assertRaises(Refused):self.channel.client(dict(self.request(),id=4))
        with self.assertRaises(Refused):self.channel.provider(self.ack())

    def test_terminal_only_and_replayed_or_competing_terminal(self):
        self.channel.client(self.request());self.channel.provider(self.terminal())
        self.assertFalse(self.channel.control.ack)
        with self.assertRaises(Refused):self.channel.provider(self.terminal())
        self.assertEqual(self.channel.terminal_uuid,EVENT)

    def test_foreign_or_nonstopped_ack_refused(self):
        for value in ('idle','spared','unknown',None):
            self.setUp();self.channel.client(self.request());frame=self.ack()
            frame['response']['response']['turn']=value
            with self.assertRaises(Refused):self.channel.provider(frame)
            self.assertFalse(self.channel.control.ack or self.channel.terminal)
        for update in ({'request_id':'foreign'},{'subtype':'error'},{'pending_permission_requests':[{}]}):
            self.setUp();self.channel.client(self.request());frame=self.ack();frame['response'].update(update)
            with self.assertRaises(Refused):self.channel.provider(frame)

    def test_foreign_competing_or_tool_terminal_refused(self):
        for field,value in (('session_id','foreign'),('user_message_uuid','foreign'),
            ('user_message_uuids',[]),('terminal_reason','aborted_tools'),
            ('subtype','success'),('is_error',False),('uuid',INPUT),('uuid','bad')):
            self.setUp();self.channel.client(self.request());frame=self.terminal();frame[field]=value
            with self.assertRaises(Refused):self.channel.provider(frame)
            self.assertFalse(self.channel.terminal)

    def test_closed_control_and_active_readiness(self):
        for key,value in (('cancel_queued',True),('for_user_message_uuids',['foreign']),
                          ('subtype','other'),('extra',True)):
            self.setUp();frame=self.request();frame['params']['frame']['request'][key]=value
            with self.assertRaises(Refused):self.channel.client(frame)
        for state in ('system_seen','initialized'):
            self.setUp();setattr(self.channel,state,False)
            with self.assertRaises(Refused):self.channel.client(self.request())
        self.setUp();frame=self.request();frame['method']='BrokerMetadata'
        with self.assertRaises(Refused):self.channel.client(frame)
        self.setUp();self.channel.terminal=True
        with self.assertRaises(Refused):self.channel.client(self.request())

    def test_first_input_and_positive_output_require_consumed_uuid(self):
        fixture=fixtures.ClaudeProtocolTests();fixture.setUp();fixture.init()
        frame=fixture.request(2);del frame['params']['frame']['uuid']
        with self.assertRaises(Refused):fixture.channel.client(frame)
        for kind in ('assistant','result'):
            self.setUp();frame=self.terminal();frame['type']=kind;frame.pop('user_message_uuid')
            with self.assertRaises(Refused):self.channel.provider(frame)

    def test_bounded_notices_do_not_hide_terminal_or_forward_payload(self):
        self.channel.client(self.request())
        for _ in range(64):
            notice={'type':'user','session_id':self.fixture.native,'uuid':str(uuid.uuid4()),
                'message':{'role':'user','content':'synthetic private notice'}}
            self.assertIsNone(self.channel.provider(notice))
        self.channel.provider(self.terminal());self.channel.provider(self.ack())
        self.assertTrue(self.channel.terminal)
        self.setUp();self.channel.client(self.request())
        frame={'type':'user','session_id':self.fixture.native,'uuid':EVENT,
            'message':{'role':'user','content':[{'type':'tool_result','content':'bad'}]}}
        with self.assertRaises(Refused):self.channel.provider(frame)
        self.setUp();self.channel.client(self.request())
        notice['session_id']=self.fixture.native
        for _ in range(128):
            notice['uuid']=str(uuid.uuid4());self.channel.provider(notice)
        with self.assertRaises(Refused):self.channel.provider(notice)

    def test_terminal_metadata_is_bounded_and_closed(self):
        for key,value in (('errors','raw'),('result',{}),('duration_ms',True),
                ('duration_api_ms',-1),('usage',[]),('permission_denials',[{}]),
                ('unknown_control',True),('fast_mode_state',{})):
            self.setUp();self.channel.client(self.request());frame=self.terminal();frame[key]=value
            with self.assertRaises(Refused):self.channel.provider(frame)
            self.assertFalse(self.channel.terminal)
        for field in ('uuid','session_id','user_message_uuid','subtype','is_error','terminal_reason'):
            self.setUp();self.channel.client(self.request());frame=self.terminal();del frame[field]
            with self.assertRaises(Refused):self.channel.provider(frame)

    def test_text_stream_notices_and_identity_replay_refusal(self):
        self.channel.client(self.request())
        for _ in range(32):
            frame={'type':'stream_event','session_id':self.fixture.native,
                'uuid':str(uuid.uuid4()),'parent_tool_use_id':None,
                'event':{'type':'content_block_delta','index':0,
                         'delta':{'type':'text_delta','text':'synthetic'}}}
            self.assertIsNone(self.channel.provider(frame))
        with self.assertRaises(Refused):self.channel.provider(frame)
        self.setUp();self.channel.client(self.request());frame['session_id']=self.fixture.native
        frame['event']['delta']={'type':'input_json_delta','partial_json':'{}'}
        with self.assertRaises(Refused):self.channel.provider(frame)

    def test_manifest_only_import_has_closed_control_dependency(self):
        import hashlib
        import json
        from pathlib import Path
        import shutil
        import subprocess
        import sys
        import tempfile
        root=Path(__file__).parent
        manifest=json.loads((root/'claude-package.json').read_text())
        with tempfile.TemporaryDirectory(prefix='claude-control-inventory-') as directory:
            stage=Path(directory)
            for name,digest in manifest['files'].items():
                self.assertEqual(hashlib.sha256((root/name).read_bytes()).hexdigest(),digest)
                shutil.copyfile(root/name,stage/name)
            script="import sys;sys.path.insert(0,sys.argv[1]);from claude_protocol import ClaudeChannel;from claude_control import ClaudeControl;print('closed-import-ok')"
            result=subprocess.run([sys.executable,'-I','-B','-c',script,str(stage)],
                cwd=stage,env={},capture_output=True,timeout=5)
            self.assertEqual((result.returncode,result.stdout,result.stderr),(0,b'closed-import-ok\n',b''))

    def test_fd3_prepares_control_without_native_queue(self):
        from transport import Pump
        import json
        pump=Pump(None,self.channel,incoming=100,outgoing=101,handoff=object())
        pump.child=object()  # already handed sole writer away
        try:
            pump.line(100,json.dumps(self.request()).encode())
            self.assertEqual(set(pump.queues),{101})
            reply=json.loads(pump.queues[101][0])
            self.assertEqual(reply,{'method':'BrokerPrepared','params':{
                'owned_handle':self.fixture.handle,'request_id':3}})
        finally:pump.selector.close()
