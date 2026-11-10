"""Original separate-UID native HTTP MCP. No provider API or real account."""
import json
import os
from pathlib import Path
import select
import subprocess
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from codex_bounded.trust import process
from codex_service.contract import Refused
from codex_service.managed_advertisement import codex_options,claude_options,valid_url
from codex_service.managed_ingress import Ingress,source
from codex_service import managed_control
import test_codex_service_managed_native as native_tests


class AdvertisementTests(unittest.TestCase):
    def test_only_protected_deep_context_has_fixed_http_tools_and_long_timeout(self):
        package=SimpleNamespace(runtime={'managed_operations':True},identity_split=True,beta={'managed_host':{}})
        context={'role':'deep','setup':{'role':'deep'},'managed_mcp_url':'http://127.0.0.1:19345/mcp'}
        with patch('codex_service.identity.launch_context',return_value=context):
            options=codex_options(package);self.assertIn('tool_timeout_sec=330',options[1])
            self.assertIn('required=true',options[1]);self.assertEqual(options[0],'-c')
            self.assertEqual(json.loads(claude_options(package)[1])['mcpServers']['orkestr_managed'],
                {'type':'http','url':context['managed_mcp_url']})
            for role in ('fast','worker-0'):
                context['role']=role;self.assertEqual(codex_options(package),())
            context['role']='claude';context['setup']['role']='fast';self.assertEqual(claude_options(package),())
        for url in ('http://example.invalid:1/mcp','http://127.0.0.1:0/mcp','http://127.0.0.1:65536/mcp',
                    'http://127.0.0.1:1/mcp?owner=other','http://127.0.0.1:1/other','http://127.0.0.1:01/mcp'):
            with self.assertRaises(Refused):valid_url(url)


@unittest.skipUnless(os.geteuid()==0,'Root/original native socket kernel proof')
class HttpNativeTests(native_tests.ManagedNativeTests):
    test_only_original_broker_can_register_its_original_child_and_actor_is_pinned=None
    test_a_different_root_pipe_pair_or_bounded_profile_cannot_register=None

    def prepare_http(self,request):
        self.manager.package.runtime={'managed_operations':True}
        ingress=Ingress(self.manager);self.addCleanup(ingress.close)
        port=ingress.http.socket.getsockname()[1]
        code='''import http.client,json,sys
assert sys.stdin.buffer.read(1)==b'!'
connection=http.client.HTTPConnection('127.0.0.1',%r,timeout=4)
try:
 connection.request('POST','/mcp',body=%r,headers={'Content-Type':'application/json'})
 response=connection.getresponse();print(json.dumps({'status':response.status,'body':response.read().decode()}),flush=True)
except Exception as error:print(json.dumps({'error':type(error).__name__}),flush=True)
finally:connection.close()
sys.stdin.buffer.read(1)
'''%(port,json.dumps(request))
        broker,native=self.start_native(code)
        scope,proof=source(self.manager,broker.pid,65534);proof.close()
        ingress.natives.register(SimpleNamespace(source=scope),{'arguments':{'pid':native,'start':process(native)['start']}})
        os.write(self.native_descriptors[1],b'!')
        return ingress,broker,native

    def read_reply(self,ingress):
        deadline=time.monotonic()+5;raw=bytearray();fd=self.native_descriptors[2]
        while b'\n' not in raw:
            self.assertLess(time.monotonic(),deadline)
            ingress.tick()
            if select.select([fd],[],[],.01)[0]:raw.extend(os.read(fd,16384))
        return json.loads(raw.split(b'\n')[0])

    def test_kernel_owned_original_native_can_initialize_without_business_authority(self):
        ingress,_,native=self.prepare_http({'jsonrpc':'2.0','id':1,'method':'initialize',
            'params':{'protocolVersion':'2025-03-26','clientInfo':{'name':'synthetic','version':'1'},'capabilities':{}}})
        response=self.read_reply(ingress);self.assertEqual(response['status'],200)
        value=json.loads(response['body']);self.assertEqual(value['id'],1)
        self.assertEqual(value['result']['serverInfo']['name'],'orkestr-managed')
        context=json.loads(value['result']['instructions'])
        self.assertEqual(context['application_instructions']['schema_version'],1)
        self.assertEqual(context['conversation_id'],'22222222-2222-4222-8222-222222222222')
        self.assertIn('orkestr_capabilities',context['registered_tools'])
        self.assertFalse(list(ingress.directory.glob('*.json')))
        self.assertEqual(ingress.natives.actor(native)['proof'].identity['pid'],native)

    def test_same_uid_nnp_sibling_cannot_clone_socket_or_write_native_memory(self):
        ingress,_,native=self.prepare_http({'jsonrpc':'2.0','id':1,'method':'initialize',
            'params':{'protocolVersion':'2025-03-26'}})
        deadline=time.monotonic()+3
        while True:
            try:connection,_=ingress.http.socket.accept();break
            except BlockingIOError:
                self.assertLess(time.monotonic(),deadline);time.sleep(.005)
        self.addCleanup(connection.close)
        from codex_service.managed_socket_owner import socket_owner
        self.assertEqual(socket_owner(ingress,connection)['pid'],native)
        links=[]
        for path in Path('/proc',str(native),'fd').iterdir():
            if os.readlink(path).startswith('socket:'):links.append(int(path.name))
        self.assertTrue(links)
        script='''import ctypes,errno,json,os,sys
libc=ctypes.CDLL(None,use_errno=True);assert libc.prctl(38,1,0,0,0)==0
pid,fd=map(int,sys.argv[1:]);report={}
try:f=os.open('/proc/'+str(pid)+'/fd/'+str(fd),os.O_RDWR|os.O_NONBLOCK);os.close(f);report['proc_socket_opened']=True
except OSError as error:report['proc_socket_errno']=error.errno
pidfd=os.pidfd_open(pid,0);ctypes.set_errno(0)
result=libc.syscall(438,pidfd,fd,0);report['pidfd_getfd_result']=result;report['pidfd_getfd_errno']=ctypes.get_errno();os.close(pidfd)
if result>=0:os.close(result)
class Vec(ctypes.Structure):_fields_=[('base',ctypes.c_void_p),('length',ctypes.c_size_t)]
buffer=ctypes.create_string_buffer(b'x');local=Vec(ctypes.addressof(buffer),1);remote=Vec(1,1)
libc.process_vm_writev.argtypes=[ctypes.c_int,ctypes.POINTER(Vec),ctypes.c_ulong,ctypes.POINTER(Vec),ctypes.c_ulong,ctypes.c_ulong]
ctypes.set_errno(0);result=libc.process_vm_writev(pid,ctypes.byref(local),1,ctypes.byref(remote),1,0)
report['memory_result']=result;report['memory_errno']=ctypes.get_errno();print(json.dumps(report))
'''
        result=subprocess.run(['/usr/bin/python3','-I','-S','-B','-c',script,str(native),str(links[0])],
            user=65534,group=65534,extra_groups=[],check=True,capture_output=True,text=True,
            env={'PATH':'/usr/bin:/bin','PYTHONDONTWRITEBYTECODE':'1'})
        report=json.loads(result.stdout)
        self.assertEqual(report.get('proc_socket_errno'),6)
        self.assertEqual(report['pidfd_getfd_result'],-1);self.assertIn(report['pidfd_getfd_errno'],(1,13,38))
        # Remote address1 is deliberately invalid: EFAULT would indicate access
        # was allowed. EPERM/EACCES proves the actual sibling boundary; no byte
        # can be written even if a host accidentally permits access.
        self.assertEqual(report['memory_result'],-1);self.assertIn(report['memory_errno'],(1,13,38))

    def test_tools_metadata_is_scoped(self):
        ingress,_,_=self.prepare_http({'jsonrpc':'2.0','id':2,'method':'tools/list','params':{'_meta':{'progressToken':'synthetic'}}})
        response=self.read_reply(ingress);names=[t['name'] for t in json.loads(response['body'])['result']['tools']]
        self.assertEqual(names,['orkestr_root_request_submit','orkestr_capabilities','orkestr_worker_capability'])
        self.assertFalse(list(ingress.directory.glob('*.json')))
        self.close_broker(self.children[-1])

    def test_business_cannot_queue_before_consumed_run(self):
        ingress,_,_=self.prepare_http({'jsonrpc':'2.0','id':3,'method':'tools/call','params':{
            'name':'orkestr_root_request_submit','arguments':{'action':'read','resource':'example.invalid','summary':'Synthetic summary'}}})
        response=self.read_reply(ingress);self.assertIn('error',response)
        self.assertFalse(list(ingress.directory.glob('*.json')))

    def test_actual_native_can_read_manifest_without_queueing_business_work(self):
        ingress,_,_=self.prepare_http({'jsonrpc':'2.0','id':8,'method':'tools/call','params':{
            'name':'orkestr_capabilities','arguments':{}}})
        response=self.read_reply(ingress);self.assertEqual(response['status'],200)
        value=json.loads(response['body'])['result']['structuredContent']
        self.assertEqual(value['conversation_id'],'22222222-2222-4222-8222-222222222222')
        self.assertEqual(value['surface'],'managed_mcp')
        self.assertIn('orkestr_capabilities',value['registered_tools'])
        self.assertFalse(list(ingress.directory.glob('*.json')))

    def test_actual_native_call_roundtrip_preserves_rpc_id_and_never_asserts_owner_approval(self):
        ingress,_,native=self.prepare_http({'jsonrpc':'2.0','id':'native-rpc-4','method':'tools/call','params':{
            'name':'orkestr_root_request_submit','arguments':{'action':'read','resource':'example.invalid','summary':'Synthetic summary'}}})
        scope,proof=source(self.manager,native,65534);proof.close();self.open_run(ingress,scope)
        deadline=time.monotonic()+4
        while not ingress.pending('synthetic-window',1):
            self.assertLess(time.monotonic(),deadline);ingress.tick();time.sleep(.005)
        record=ingress.pending('synthetic-window',1)[0]
        self.assertTrue(record['request']['request_key'].startswith('mcp:'))
        cap={'operation_id':record['request_id'],'run_id':scope.get('run_id','44444444-4444-4444-8444-444444444444'),
            'source_message_id':'55555555-5555-4555-8555-555555555555','source_event_id':'66666666-6666-4666-8666-666666666666',
            'binding_generation':2,'lease_generation':1,'dispatch_fence':1,'expires_at_ms':int(time.time()*1000)+25000,
            'hard_deadline_ms':int(time.time()*1000)+120000,
            'evidence':{'source':managed_control.normalize_source(record['source']),'request':record['request']}}
        # This boundary test supplies the authority grant. Real Core issuance
        # and live writer/renewal fences are independently exercised in Rust.
        result=managed_control.consume(ingress,cap)
        ingress.tick();self.assertFalse(select.select([self.native_descriptors[2]],[],[],.05)[0])
        self.release_result(ingress,result)
        response=self.read_reply(ingress);value=json.loads(response['body'])
        self.assertEqual(value['id'],'native-rpc-4');self.assertFalse(value['result']['isError'])
        result=json.loads(value['result']['content'][0]['text'])
        self.assertFalse(result['result']['owner_approval']);self.assertEqual(result['result']['owner_delivery'],'unconfirmed')

    def test_native_worker_reply_returns_actual_scoped_receipt_and_preserves_rpc_id(self):
        from codex_service.managed_worker_reply import reply
        ingress,_,native=self.prepare_http({'jsonrpc':'2.0','id':'native-worker-rpc','method':'tools/call','params':{
            'name':'orkestr_worker_submit','arguments':{'title':'Synthetic bounded task','instructions':'Count 1, 2, 3.'}}})
        self.manager.package.runtime['managed_workers']=True
        scope,proof=source(self.manager,native,65534);proof.close();self.open_run(ingress,scope)
        deadline=time.monotonic()+4
        while not ingress.pending('synthetic-window',1):
            self.assertLess(time.monotonic(),deadline);ingress.tick();time.sleep(.005)
        record=ingress.pending('synthetic-window',1)[0]
        actual={'kind':'native_worker_task','task_id':'77777777-7777-4777-8777-777777777777',
            'parent_run_id':record['source']['run_id'],'phase':'queued','run_id':None,'provider':None,'result':None}
        reply(ingress,{'window_id':'synthetic-window','generation':1,'owner_id':record['source']['owner_id'],
            'conversation_id':record['source']['conversation_id'],'result':{'operation_id':record['request_id'],
                'run_id':record['source']['run_id'],'source':managed_control.normalize_source(record['source']),
                'request_sha256':record['payload_sha256'],'expires_at_ms':int(time.time()*1000)+25000,'result':actual}})
        response=self.read_reply(ingress);value=json.loads(response['body'])
        self.assertEqual(value['id'],'native-worker-rpc');self.assertFalse(value['result']['isError'])
        self.assertEqual(value['result']['structuredContent'],actual)
        self.assertEqual(value['result']['structuredContent']['phase'],'queued')
        self.assertIsNone(value['result']['structuredContent']['run_id'])

    def _worker_reply_expiry(self,name,arguments):
        from codex_service.managed_worker_reply import reply
        ingress,broker,native=self.prepare_http({'jsonrpc':'2.0','id':name,'method':'tools/call',
            'params':{'name':name,'arguments':arguments}})
        self.manager.package.runtime['managed_workers']=True
        scope,proof=source(self.manager,native,65534);proof.close();self.open_run(ingress,scope)
        deadline=time.monotonic()+4
        while not ingress.pending('synthetic-window',1):
            self.assertLess(time.monotonic(),deadline);ingress.tick();time.sleep(.005)
        record=ingress.pending('synthetic-window',1)[0];now=int(time.time()*1000)
        actual=({'kind':'native_worker_capability','state':'ready'} if name.endswith('_capability') else
            {'kind':'native_worker_task','task_id':'77777777-7777-4777-8777-777777777777',
             'parent_run_id':record['source']['run_id'],'phase':'completed'})
        value={'operation_id':record['request_id'],'run_id':record['source']['run_id'],
            'source':managed_control.normalize_source(record['source']),'request_sha256':record['payload_sha256'],
            'expires_at_ms':now+60000,'result':actual}
        request={'window_id':'synthetic-window','generation':1,'owner_id':record['source']['owner_id'],
            'conversation_id':record['source']['conversation_id'],'result':value}
        with self.assertRaisesRegex(Refused,'managed_worker_reply_expired'):reply(ingress,request)
        self.assertEqual(json.loads((ingress.directory/(record['request_id']+'.json')).read_text())['state'],'pending')
        value['expires_at_ms']=min(value['expires_at_ms'],now+25000)
        reply(ingress,request)
        response=json.loads(self.read_reply(ingress)['body'])
        self.assertEqual(response['id'],name);self.assertFalse(response['result']['isError'])
        self.assertEqual(response['result']['structuredContent'],actual)
        self.close_broker(broker)


    def test_native_capability_reply_keeps_root_expiry_ceiling(self):
        self._worker_reply_expiry('orkestr_worker_capability',{})

    def test_native_submit_reply_keeps_root_expiry_ceiling(self):
        self._worker_reply_expiry('orkestr_worker_submit',{'title':'Synthetic task','instructions':'Count 1, 2, 3.'})

    def test_native_wait_reply_keeps_root_expiry_ceiling(self):
        self._worker_reply_expiry('orkestr_worker_wait',{'task_id':'77777777-7777-4777-8777-777777777777'})

    def test_unrelated_same_uid_connection_cannot_claim_native_role_in_http_body(self):
        self.manager.package.runtime={'managed_operations':True};ingress=Ingress(self.manager);self.addCleanup(ingress.close)
        script='''import ctypes,socket,sys
assert ctypes.CDLL(None).prctl(38,1,0,0,0)==0
s=socket.create_connection(('127.0.0.1',int(sys.argv[1])))
s.sendall(b'POST /mcp HTTP/1.1\\r\\nHost: localhost\\r\\nContent-Length: 2\\r\\n\\r\\n{}')
print('ready',flush=True);sys.stdin.read()
'''
        outsider=subprocess.Popen([str(self.native),'-I','-S','-B','-c',script,str(ingress.http.socket.getsockname()[1])],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,user=65534,group=65534,extra_groups=[],
            env={'PATH':'/usr/bin:/bin','PYTHONDONTWRITEBYTECODE':'1'})
        self.children.append(outsider);self.assertEqual(outsider.stdout.readline(),b'ready\n');self.bind(outsider)
        # Root sees no original registered native owning this actual socket;
        # role/owner JSON cannot affect that kernel proof.
        ingress.tick();self.assertEqual(len(ingress.peers),1)
        ingress.peers[0].registration_deadline=0;ingress.tick()
        self.assertFalse(ingress.peers);self.assertFalse(list(ingress.directory.glob('*.json')))


if __name__=='__main__':unittest.main()
