"""Live three-UID Fast observer, exact-input join and historical uncertainty."""
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
from types import SimpleNamespace
import unittest
from codex_bounded.trust import process
from codex_service.fast_sampler import capture,verify
import test_codex_service_managed_native as native_tests


def core_fact():
    return dict(schema_version=1,owner_id='11111111-1111-4111-8111-111111111111',
        conversation_id='22222222-2222-4222-8222-222222222222',session_id='33333333-3333-4333-8333-333333333333',
        run_id='44444444-4444-4444-8444-444444444444',window_id='55555555-5555-4555-8555-555555555555',
        input_message_id='66666666-6666-4666-8666-666666666666',input_event_id='77777777-7777-4777-8777-777777777777',
        native_session_id='synthetic-native',provider='codex',binding_generation=2,context_id='synthetic-context',
        incarnation_id='88888888-8888-4888-8888-888888888888',window_generation=1,
        state='running',dispatch_state='reserved',acceptance_event_id=None)


@unittest.skipUnless(os.geteuid()==0,'actual protected Root/authority/executor fixture')
class FastSamplerTests(native_tests.ManagedNativeTests):
    test_only_original_broker_can_register_its_original_child_and_actor_is_pinned=None
    test_a_different_root_pipe_pair_or_bounded_profile_cannot_register=None

    def prepare_sampler(self):
        broker,native=self.start_native('import sys;sys.stdin.buffer.read(1)')
        server_path=self.root/'server';shutil.copyfile('/usr/bin/python3',server_path);server_path.chmod(0o555)
        manifest=self.root/'manifest.json';manifest.write_text('{"format":"synthetic-kernel-fixture"}');manifest.chmod(0o600)
        server_code='''import ctypes,json,socket,subprocess,sys
assert ctypes.CDLL(None).prctl(38,1,0,0,0)==0
listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen()
proxy=subprocess.Popen(['/usr/bin/python3','-I','-S','-B','-c','import time;time.sleep(30)'])
print(json.dumps({'proxy':proxy.pid,'port':listener.getsockname()[1]}),flush=True)
try:sys.stdin.read()
finally:proxy.kill();proxy.wait()
'''
        server=subprocess.Popen([str(server_path),'-I','-S','-B','-c',server_code],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
            user=65533,group=65534,extra_groups=[],env={'PATH':'/usr/bin:/bin','PYTHONDONTWRITEBYTECODE':'1'})
        self.children.append(server)
        def close_server():
            if server.poll() is None:server.stdin.close();server.wait(timeout=3)
        self.addCleanup(close_server)
        server_ready=json.loads(server.stdout.readline());proxy=server_ready['proxy'];fact=core_fact()
        package=SimpleNamespace(root=self.root,ledger_directory=self.directory,identity_split=True,
            authority_uid=65533,executor_uid=65534,owner=fact['owner_id'],runtime={'port':server_ready['port']})
        launches=self.directory/'launches';launches.mkdir(mode=0o700)
        output=self.root/'fast-proofs';output.mkdir(mode=0o700)
        original=next(iter(self.manager.launcher.children.values()))
        claim=dict(state='spawned',request_id='bind:synthetic-fast',server=process(server.pid),manager_pid=os.getpid(),
            proxy_pid=proxy,proxy_start=process(proxy)['start'],broker_pid=broker.pid,broker_start=process(broker.pid)['start'],
            role='fast',mode='fresh',window_id=fact['window_id'],generation=fact['window_generation'],
            native_io=original.native_io,setup=dict(owner_id=fact['owner_id'],conversation_id=fact['conversation_id'],
                session_id=fact['session_id'],generation=1,provider='codex',role='fast',incarnation=fact['incarnation_id']))
        path=launches/'synthetic.json';path.write_text(json.dumps(claim));path.chmod(0o600)
        return package,fact,path,output,broker,native

    def complete(self,fact):
        return dict(fact,state='succeeded',acceptance_event_id='99999999-9999-4999-8999-999999999999')

    def test_live_tree_and_root_io_can_join_later_exact_core_acceptance_after_exit(self):
        package,fact,path,output,broker,native=self.prepare_sampler()
        result=capture(package,fact,output);self.assertEqual(result['status'],'observed',result)
        snapshot=json.loads(Path(result['receipt_path']).read_text())
        self.assertEqual(snapshot['observed_native_process']['pid'],native)
        self.assertTrue(snapshot['observed_native_process']['metadata_only'])
        self.assertFalse(snapshot['original_native_pid_registered']);self.assertIsNone(snapshot['native_pid_claim'])
        self.assertEqual(verify(result['receipt_path'],fact)['status'],'unknown')
        self.close_broker(broker)
        claim=json.loads(path.read_text());claim['state']='exited';path.write_text(json.dumps(claim))
        self.assertEqual(capture(package,self.complete(fact),output)['status'],'unknown')
        self.assertEqual(verify(result['receipt_path'],self.complete(fact))['status'],'diagnostic')
        accepted=verify(result['receipt_path'],self.complete(fact),package=package)
        self.assertEqual(accepted['status'],'accepted',accepted)
        self.assertFalse(accepted['external_effects_proven'])
        self.assertIsNone(accepted['native_pid_claim'])

    def test_current_package_manifest_root_and_original_service_are_required(self):
        package,fact,_,output,_,_=self.prepare_sampler()
        result=capture(package,fact,output);self.assertEqual(result['status'],'observed',result)
        completed=self.complete(fact)
        self.assertEqual(verify(result['receipt_path'],completed,package=package)['status'],'accepted')
        manifest=package.root/'manifest.json';original=manifest.read_bytes();manifest.write_text('{"changed":true}')
        self.assertEqual(verify(result['receipt_path'],completed,package=package)['status'],'unknown')
        manifest.write_bytes(original)
        foreign=copy.copy(package);foreign.root=self.root/'foreign';foreign.root.mkdir(mode=0o700)
        self.assertEqual(verify(result['receipt_path'],completed,package=foreign)['status'],'unknown')
        server=self.children[-1];server.stdin.close();server.wait(timeout=3)
        self.assertEqual(verify(result['receipt_path'],completed,package=package)['status'],'unknown')
        self.assertEqual(verify(result['receipt_path'],completed)['status'],'diagnostic')

    def test_no_foreign_input_provider_scope_or_mutable_snapshot_can_be_promoted(self):
        package,fact,path,output,_,_=self.prepare_sampler()
        result=capture(package,fact,output);self.assertEqual(result['status'],'observed',result)
        for field in ('input_message_id','input_event_id','run_id','session_id','window_id','owner_id','conversation_id'):
            changed=dict(self.complete(fact));changed[field]='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
            self.assertEqual(verify(result['receipt_path'],changed)['status'],'unknown',field)
        for field in ('native_session_id','context_id','incarnation_id'):
            self.assertEqual(verify(result['receipt_path'],dict(self.complete(fact),**{field:'other'}))['status'],'unknown',field)
        for field in ('binding_generation','window_generation'):
            self.assertEqual(verify(result['receipt_path'],dict(self.complete(fact),**{field:3}))['status'],'unknown',field)
        self.assertEqual(verify(result['receipt_path'],dict(self.complete(fact),provider='claude'))['status'],'unknown')
        receipt=Path(result['receipt_path']);os.chown(receipt,65534,65534)
        self.assertEqual(verify(receipt,self.complete(fact))['status'],'unknown')
        os.chown(receipt,0,65534);receipt.chmod(0o640)
        self.assertEqual(verify(receipt,self.complete(fact))['status'],'unknown')

    def test_stale_pid_changed_root_io_deep_role_and_historical_journal_are_unknown(self):
        package,fact,path,output,_,_=self.prepare_sampler();original=json.loads(path.read_text())
        variants=[]
        for key in ('broker_start','proxy_start'):
            changed=copy.deepcopy(original);changed[key]+=1;variants.append(changed)
        changed=copy.deepcopy(original);changed['setup']['role']='deep';variants.append(changed)
        changed=copy.deepcopy(original);changed['role']='claude';variants.append(changed)
        changed=copy.deepcopy(original);changed['native_io']['input']['inode']+=1;variants.append(changed)
        changed=copy.deepcopy(original);changed['state']='exited';variants.append(changed)
        for changed in variants:
            path.write_text(json.dumps(changed))
            self.assertEqual(capture(package,fact,output)['status'],'unknown')
        self.assertFalse(list(output.iterdir()))


if __name__=='__main__':unittest.main()
