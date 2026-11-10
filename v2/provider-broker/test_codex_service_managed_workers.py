"""Bounded Native task data and durable reply boundaries, without provider use."""
import copy
import json
from pathlib import Path
import tempfile
import socket
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from codex_service.contract import Refused,canonical
from codex_service.managed_ingress import Ingress,packet
from codex_service.managed_workers import advertisements,validate
from codex_service.managed_http import Peer,tools
from codex_service.managed_capabilities import manifest
from codex_service.managed_worker_reply import bind,reply
from codex_service.managed_runs import Runs,key
UUID='11111111-1111-4111-8111-111111111111'

class WorkerDataTests(unittest.TestCase):
    def test_provider_can_supply_only_bounded_task_data(self):
        arguments={'title':'Synthetic task','instructions':'Count 1, 2, 3.'}
        self.assertEqual(validate('worker_submit',arguments),arguments)
        for field in ('owner_id','parent_run_id','run_id','session_id','provider','workspace','execution_budget_ms'):
            with self.assertRaises(Refused):validate('worker_submit',{**arguments,field:'untrusted'})
        for args in ({**arguments,'instructions':'x'*4097},{**arguments,'title':'x'*161},
                     {**arguments,'title':'bad\ncontrol'},{**arguments,'instructions':'\0'},
                     {**arguments,'instructions':'ü'*3000}):
            with self.assertRaises(Refused):validate('worker_submit',args)
        for operation in ('worker_status','worker_wait'):
            self.assertEqual(validate(operation,{'task_id':UUID}),{'task_id':UUID})
            for args in ({'task_id':UUID,'parent_run_id':UUID},{'task_id':'invalid'},{'task_id':None}):
                with self.assertRaises(Refused):validate(operation,args)
        with self.assertRaises(Refused):validate('worker_capability',{'owner_id':UUID})
        wire={'version':1,'request_key':'mcp:synthetic','operation':'worker_submit','arguments':arguments}
        self.assertEqual(packet(canonical(wire)),wire)
        with self.assertRaises(Refused):packet(canonical({**wire,'owner_id':UUID}))

    def test_tools_explain_queue_wait_and_unknown_outcomes(self):
        tools=advertisements();self.assertEqual(len(tools),4)
        submit=tools[1];self.assertEqual(set(submit['inputSchema']['properties']),{'title','instructions'})
        self.assertTrue(submit['annotations']['openWorldHint'])
        self.assertIn('queued receipt is not a running Worker',submit['description'])
        self.assertIn('never resubmit an unknown outcome',submit['description'])

    def test_registration_never_claims_core_scheduler_readiness(self):
        ingress=SimpleNamespace(manager=SimpleNamespace(desk=None,package=SimpleNamespace(runtime={'managed_workers':True})))
        scope={'conversation_id':UUID,'provider':'codex'}
        value=manifest(scope,tools(ingress,scope))
        self.assertIn('orkestr_worker_submit',value['registered_tools'])
        self.assertIn('delegated_workers',value['uncovered'])
        self.assertFalse(any(row['tool']=='orkestr_worker_submit' and row['status']=='ready'
            for row in value['capabilities']))
        ingress.manager.package.runtime={}
        self.assertNotIn('orkestr_worker_submit',[tool['name'] for tool in tools(ingress,scope)])
        self.assertIn('orkestr_worker_capability',[tool['name'] for tool in tools(ingress,scope)])

class WorkerHttpFramingTests(unittest.TestCase):
    def peer(self,arguments):
        server,client=socket.socketpair();self.addCleanup(server.close);self.addCleanup(client.close)
        peer=Peer(None,server);peer.authenticate=lambda:None
        body=canonical({'jsonrpc':'2.0','id':'worker-rpc','method':'tools/call',
            'params':{'name':'orkestr_worker_submit','arguments':arguments}})
        client.sendall(b'POST /mcp HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: '+
            str(len(body)).encode()+b'\r\n\r\n'+body)
        return peer,client

    def test_actual_framing_preserves_rpc_and_returns_structured_receipt(self):
        peer,client=self.peer({'title':'Synthetic task','instructions':'Count 1, 2, 3.'})
        request=peer.receive();self.assertEqual(request['operation'],'worker_submit')
        self.assertEqual(set(request['arguments']),{'title','instructions'})
        self.assertTrue(request['request_key'].startswith('mcp:'))
        result={'kind':'native_worker_task','task_id':UUID,'parent_run_id':UUID,'phase':'queued',
            'run_id':None,'provider':None,'result':None}
        peer.reply({'state':'completed','result':result})
        frame=client.recv(16384);value=json.loads(frame.split(b'\r\n\r\n',1)[1])
        self.assertEqual(value['id'],'worker-rpc');self.assertEqual(value['result']['structuredContent'],result)
        self.assertFalse(value['result']['isError']);self.assertIn(b'Cache-Control: no-store',frame)

    def test_invalid_authority_arguments_refuse_structurally_before_a_journal_or_task(self):
        peer,client=self.peer({'title':'Synthetic task','instructions':'Count','owner_id':UUID})
        self.assertIsNone(peer.receive());self.assertTrue(peer.metadata_done)
        value=json.loads(client.recv(16384).split(b'\r\n\r\n',1)[1])
        self.assertTrue(value['result']['isError'])
        self.assertEqual(value['result']['structuredContent'],{'kind':'native_worker_refusal','reason':'invalid_task_data','created':False})
        self.assertIsNone(peer.path);self.assertIsNone(peer.request)

class WorkerReplyTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.directory=Path(self.temp.name)
        self.source={'window_id':UUID,'window_generation':1,'owner_id':UUID,'conversation_id':UUID,
            'broker_pid':10001,'broker_start':10001,'run_id':UUID,'native_session_id':None,'resume_setup_id':None}
        self.record={'request_id':UUID,'source':self.source,'state':'pending',
            'request':{'operation':'worker_status'},'payload_sha256':'a'*64}
        self.path=self.directory/(UUID+'.json');self.path.write_text(json.dumps(self.record))
        self.ingress=SimpleNamespace(directory=self.directory,
            runs=SimpleNamespace(contexts={key(self.source):{'run_id':UUID}}),
            manager=SimpleNamespace(_desk_window_active=lambda *_:True),pending=lambda *_:[self.record])
        self.request={'window_id':UUID,'generation':1,'owner_id':UUID,'conversation_id':UUID,
            'result':{'operation_id':UUID,'run_id':UUID,'source':self.source,'request_sha256':'a'*64,
                'expires_at_ms':int(time.time()*1000)+20000,
                'result':{'kind':'native_worker_task','task_id':UUID,'phase':'queued','run_id':None,'provider':None,'result':None}}}
        # Portable tests replace only filesystem UID custody. Actual Root and
        # original Native actor checks run in the disposable Linux fixtures.
        self.addCleanup(patch.stopall)
        patch('codex_service.managed_worker_reply.protected',side_effect=lambda p:p).start()
        patch('codex_service.managed_worker_reply.metadata',side_effect=lambda p,_:json.loads(p.read_text())).start()

    def test_durable_reply_precedes_delivery_and_lost_ack_never_recreates(self):
        result=reply(self.ingress,self.request);durable=json.loads(self.path.read_text())
        self.assertEqual(result,durable);self.assertEqual(durable['state'],'completed')
        self.assertTrue(durable['result_authorization']);self.assertNotIn('result_sent',durable)
        self.assertEqual(reply(self.ingress,self.request),durable)
        changed=copy.deepcopy(self.request);changed['result']['result']['phase']='running'
        with self.assertRaisesRegex(Refused,'conflict'):reply(self.ingress,changed)
        self.assertEqual(json.loads(self.path.read_text()),durable)

    def test_cross_scope_changed_request_closed_run_and_unknown_are_refused(self):
        for field in ('owner_id','conversation_id','window_id'):
            changed=copy.deepcopy(self.request);changed[field]='22222222-2222-4222-8222-222222222222'
            with self.assertRaises(Refused):reply(self.ingress,changed)
        changed=copy.deepcopy(self.request);changed['result']['request_sha256']='b'*64
        with self.assertRaises(Refused):reply(self.ingress,changed)
        changed=copy.deepcopy(self.request);changed['result']['source']['broker_start']=999
        with self.assertRaises(Refused):reply(self.ingress,changed)
        self.ingress.runs.contexts={}
        with self.assertRaisesRegex(Refused,'run_closed'):reply(self.ingress,self.request)
        self.ingress.runs.contexts={key(self.source):{'run_id':UUID}}
        self.record['state']='unknown';self.path.write_text(json.dumps(self.record))
        with self.assertRaisesRegex(Refused,'caller_not_live'):reply(self.ingress,self.request)

    def test_four_bound_calls_leave_the_pending_queue_and_cannot_retarget_results(self):
        self.path.unlink();requests=[]
        self.ingress.pending=lambda *_: [json.loads(p.read_text()) for p in sorted(self.directory.glob('*.json'))
            if json.loads(p.read_text())['state']=='pending'][:1]
        for n in range(1,6):
            operation=f'{n:08x}-1111-4111-8111-111111111111'
            record=copy.deepcopy(self.record);record['request_id']=operation;record['request']['operation']='worker_wait'
            (self.directory/(operation+'.json')).write_text(json.dumps(record))
            request=copy.deepcopy(self.request);request['result'].update(operation_id=operation)
            request['result'].pop('result');request['result']['task_id']=operation;requests.append(request)
        for request in requests[:4]:
            self.assertEqual(bind(self.ingress,request)['state'],'worker_waiting')
        self.assertEqual(len(self.ingress.pending(UUID,1)),1)
        with self.assertRaisesRegex(Refused,'waiter_bound'):bind(self.ingress,requests[4])
        result=copy.deepcopy(self.request);result['result']['operation_id']=requests[0]['result']['operation_id']
        result['result']['result'].update(task_id=requests[1]['result']['task_id'],parent_run_id=UUID)
        with self.assertRaisesRegex(Refused,'bound_task_changed'):reply(self.ingress,result)
        result['result']['result']['task_id']=requests[0]['result']['task_id']
        reply(self.ingress,result)
        self.assertEqual(bind(self.ingress,requests[4])['state'],'worker_waiting')
        self.assertFalse(self.ingress.pending(UUID,1))

    def test_bound_native_retry_cannot_transfer_original_caller_identity(self):
        ingress=Ingress.__new__(Ingress);ingress.directory=self.directory
        ingress.runs=SimpleNamespace(attach=lambda peer:None)
        caller=SimpleNamespace(source={**self.source,'caller_pid':10002,'caller_start':10002,'caller_uid':10003})
        request={'version':1,'request_key':'mcp:original-native','operation':'worker_wait','arguments':{'task_id':UUID}}
        with patch('codex_service.managed_ingress.metadata',side_effect=lambda p,_:json.loads(p.read_text())):
            ingress._record(caller,request)
            record=json.loads(caller.path.read_text());record['state']='worker_waiting';caller.path.write_text(json.dumps(record))
            ingress._record(SimpleNamespace(source=dict(caller.source)),request)
            borrowed=SimpleNamespace(source={**caller.source,'caller_pid':10004,'caller_start':10004})
            with self.assertRaisesRegex(Refused,'worker_original_caller_required'):ingress._record(borrowed,request)
        self.assertEqual(json.loads(caller.path.read_text())['source'],caller.source)

    def test_parent_close_cancels_bound_wait_and_prevents_positive_delivery(self):
        self.record['request']['operation']='worker_wait';self.path.write_text(json.dumps(self.record))
        bound=copy.deepcopy(self.request);bound['result'].pop('result');bound['result']['task_id']=UUID
        bind(self.ingress,bound)
        runs=Runs.__new__(Runs);runs.ingress=self.ingress;runs.contexts=self.ingress.runs.contexts
        runs.directory=self.directory/'runs';runs.directory.mkdir()
        (runs.directory/(UUID+'.json')).write_text(json.dumps({'scope':self.source,'state':'open'}))
        self.ingress.runs=runs
        with patch('codex_service.managed_runs.protected',side_effect=lambda p:p), \
             patch('codex_service.managed_runs.metadata',side_effect=lambda p,_:json.loads(p.read_text())):
            runs.close(UUID,1,UUID)
        self.assertEqual(json.loads(self.path.read_text())['state'],'cancelled')
        self.assertNotIn(key(self.source),runs.contexts)
        with self.assertRaisesRegex(Refused,'run_closed'):reply(self.ingress,self.request)
        self.assertNotIn('result_authorization',json.loads(self.path.read_text()))

    def test_expired_and_oversized_reply_never_mutates_journal(self):
        for change in ({'expires_at_ms':1},{'result':{'kind':'native_worker_task','text':'x'*4097}}):
            request=copy.deepcopy(self.request);request['result'].update(change)
            with self.assertRaises(Refused):reply(self.ingress,request)
        self.assertEqual(json.loads(self.path.read_text())['state'],'pending')

if __name__=='__main__':unittest.main()
