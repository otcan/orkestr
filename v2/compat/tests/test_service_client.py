"""Disposable pinned runtime + loopback peer; no live config or credentials."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import threading
import unittest
import os
import uuid

ROOT=Path(__file__).parents[1]
spec=importlib.util.spec_from_file_location('service_client_fixture',ROOT/'service_client.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
OWNER='00000000-0000-4000-8000-000000000001';CONVERSATION='00000000-0000-4000-8000-000000000002'
PREFIX='/api/v2/conversations/'+CONVERSATION;TOKEN='d'*64

class Peer(BaseHTTPRequestHandler):
    def log_message(self,*_):pass
    def do_GET(self):self.dispatch()
    def do_POST(self):self.dispatch()
    def dispatch(self):
        raw=self.rfile.read(int(self.headers.get('Content-Length','0')))
        self.server.calls.append((self.command,self.path,json.loads(raw) if raw else None))
        status=200;headers={}
        if self.path=='/api/v2/health':
            value=dict(status='ok',product='orkestr-v2',fixture_mode=False,build=dict(format='orkestr-v2-build-identity-v1',component='server',source_commit=self.server.source))
        elif self.path in ('/api/v2/machine/service-session','/api/v2/browser/session'):
            value=dict(owner_id=self.server.owner,csrf_token=hashlib.sha256(('orkestr-v2-browser-csrf-v1:'+TOKEN).encode()).hexdigest())
            if self.command=='POST':headers['Set-Cookie']='orkestr_v2_session='+TOKEN+'; Path=/api/v2; HttpOnly; SameSite=Strict; Secure'
            elif self.server.revoked:status=401
        elif self.path==PREFIX:value=dict(conversation_id=self.server.conversation)
        elif self.path==PREFIX+'/posts':
            __import__('time').sleep(getattr(self.server,'post_delay',0))
            status=self.server.post_status;value={'post':{'id':CONVERSATION}}
        else:status=404;value={}
        body=json.dumps(value).encode();self.send_response(status)
        for key,value in headers.items():self.send_header(key,value)
        self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers()
        try:self.wfile.write(body)
        except BrokenPipeError:pass  # A timed-out client must not resend the effect.

@unittest.skipUnless(os.geteuid()==0,"Root-published peer fixture required")
class ServiceOnlyTests(unittest.TestCase):
    def setUp(self):
        self.root=Path("/orkestr-service-client-test-"+str(uuid.uuid4()));self.root.mkdir(mode=0o755)
        self.addCleanup(shutil.rmtree,self.root)
        self.runtime=self.root/'runtime';self.runtime.mkdir(mode=0o700);pins={}
        for name in m.RUNTIME_FILES:
            target=self.runtime/name;shutil.copyfile(ROOT/'v1_runtime'/name,target);target.chmod(0o400)
            pins[name]=hashlib.sha256(target.read_bytes()).hexdigest()
        self.key=self.root/'key';self.key.write_text(json.dumps({'service_token':'c'*64}));self.key.chmod(0o600)
        from peer_test_fixture import CorePeer
        self.peer=CorePeer(self.root,Peer);self.addCleanup(self.peer.close)
        descriptor=self.peer.publish()
        self.cache_dir=self.root/'sessions';self.cache_dir.mkdir(mode=0o700)
        self.config=self.root/'config';self.settings=dict(runtime_directory=str(self.runtime),runtime_files=pins,
            credentials_path=str(self.key),cache_path=str(self.cache_dir/'cache'),origin='https://example.invalid',
            loopback_url='http://127.0.0.1:'+str(self.peer.server_port),expected_owner=OWNER,expected_source='a'*40,peer_descriptor_path=str(descriptor))
        self.save()
    def save(self):self.config.write_text(json.dumps(self.settings));self.config.chmod(0o600)
    def client(self):return m.ServiceClient(self.config,routes=[('POST',PREFIX+'/posts')])
    def send(self):return self.client().request('POST',PREFIX+'/posts',{'request_key':'synthetic','text':'synthetic'},allowed=(200,201))

    def test_five_independent_clients_share_one_service_exchange(self):
        for _ in range(5):self.assertEqual(self.send()[0],201)
        self.assertEqual(sum(method=='POST' and path=='/api/v2/machine/service-session' for method,path,_ in self.peer.calls),1)
        self.assertFalse(any(method=='POST' and path=='/api/v2/browser/session' for method,path,_ in self.peer.calls))
        self.assertFalse(list(self.runtime.rglob('__pycache__')))

    def test_missing_config_or_human_credential_is_never_a_password_login(self):
        self.config.unlink()
        with self.assertRaises(m.ServiceError):self.send()
        self.save();self.key.write_text(json.dumps({'username':'synthetic','password':'synthetic-password-0000'}))
        with self.assertRaises(m.ServiceError):self.send()
        self.assertEqual(self.peer.calls,[])

    def test_full_runtime_pin_and_closed_route_refuse_before_business_request(self):
        self.settings['runtime_files']['__init__.py']='0'*64;self.save()
        with self.assertRaisesRegex(m.ServiceError,'pin_refused'):self.send()
        self.assertEqual(self.peer.calls,[])
        self.settings['runtime_files']['__init__.py']=hashlib.sha256((self.runtime/'__init__.py').read_bytes()).hexdigest();self.save()
        with self.assertRaisesRegex(m.ServiceError,'route_refused'):self.client().request('POST',PREFIX+'/messages',{})
        self.assertEqual(self.peer.calls,[])

    def test_owner_source_and_conversation_drift_prevent_posts(self):
        for field,bad in [('source','b'*40),('owner',CONVERSATION),('conversation',OWNER)]:
            original=getattr(self.peer,field);setattr(self.peer,field,bad)
            with self.subTest(field=field),self.assertRaises(m.ServiceError):self.send()
            setattr(self.peer,field,original)
        self.assertFalse(any(path.endswith('/posts') for _,path,_ in self.peer.calls))

    def test_attempted_post_timeout_5xx_redirect_or_unexpected_success_is_unknown(self):
        for status in (408,500,503,202,302):
            self.peer.post_status=status
            with self.subTest(status=status),self.assertRaises(m.ServiceError) as failed:self.send()
            self.assertEqual(failed.exception.outcome,'unknown')
        self.assertEqual(sum(path.endswith('/posts') for _,path,_ in self.peer.calls),5)

    def test_revocation_survives_new_clients_until_key_replacement(self):
        self.send();self.peer.revoked=True
        for _ in range(2):
            with self.assertRaises(m.ServiceError):self.send()
        self.assertEqual(sum(method=='POST' and path=='/api/v2/machine/service-session' for method,path,_ in self.peer.calls),1)
        self.assertTrue(json.loads((self.cache_dir/'cache').read_text())['revoked'])

    def test_operation_deadline_can_cover_a_slow_single_effect(self):
        client=self.client();client.options['timeout_s']=0.5
        self.peer.command({'set':{'post_delay':1.0}})
        status,_=client.request('POST',PREFIX+'/posts',{'request_key':'slow'},
                                allowed=(201,),timeout_s=2)
        self.assertEqual(status,201)
        self.assertEqual(sum(path.endswith('/posts') for _,path,_ in self.peer.calls),1)
        # The override belongs to this operation, not the shared session options.
        self.assertEqual(client.options['timeout_s'],0.5)

    def test_default_deadline_timeout_remains_unknown_without_retry(self):
        client=self.client();client.options['timeout_s']=0.5
        self.peer.command({'set':{'post_delay':1.0}})
        with self.assertRaises(m.ServiceError) as failed:
            client.request('POST',PREFIX+'/posts',{},allowed=(201,))
        self.assertEqual(failed.exception.outcome,'unknown')
        self.assertEqual(sum(path.endswith('/posts') for _,path,_ in self.peer.calls),1)

    def test_shorter_operation_deadline_does_not_inherit_the_session_budget(self):
        client=self.client();client.options['timeout_s']=2
        self.peer.command({'set':{'post_delay':1.0}})
        with self.assertRaises(m.ServiceError) as failed:
            client.request('POST',PREFIX+'/posts',{},allowed=(201,),timeout_s=0.5)
        self.assertEqual(failed.exception.outcome,'unknown')
        self.assertEqual(sum(path.endswith('/posts') for _,path,_ in self.peer.calls),1)
        self.assertEqual(client.options['timeout_s'],2)

    def test_invalid_operation_deadline_refuses_before_network(self):
        for timeout in (True,False,0,-1,120.001,121,float('nan'),float('inf'),float('-inf'),'110'):
            with self.subTest(timeout=timeout),self.assertRaisesRegex(m.ServiceError,'deadline_refused'):
                self.client().request('POST',PREFIX+'/posts',{},timeout_s=timeout)
        self.assertEqual(self.peer.calls,[])

if __name__=='__main__':unittest.main()
