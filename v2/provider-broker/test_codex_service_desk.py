"""Disposable fixed Root helper boundary; never live desks, Vault or accounts."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from codex_bounded.trust import digest,process,exists
from codex_service.contract import Refused
from codex_service.desk_operations import Operations
import test_codex_service_identity as identity_tests


@unittest.skipUnless(os.geteuid()==0,'root-owned synthetic helper and UID split')
class DeskOperationTests(identity_tests.SplitPackageTests):
    # Inherit fixture construction, not parent test cases.
    test_split_loader_binds_authority_paths_but_refuses_unqualified_legacy_launch=None
    test_executor_cannot_read_replace_authority_or_gain_setuid_with_nnp=None
    test_external_server_configurations_require_authority_private_custody=None

    def prepare(self,mode='complete'):
        self.package=self.select_split();root=self.fixture.root
        self.marker=root/'helper-proof.json'
        helper=root/'fixed-helper'
        helper.write_text('''#!/usr/bin/python3
import json,os,subprocess,sys,time
from pathlib import Path
assert os.geteuid()==0
assert sys.argv[1:]==['--conversation',%r,'--desk','synthetic-desk','example.invalid']
assert set(os.environ)<=set(['PATH','LANG','PYTHONDONTWRITEBYTECODE','LC_CTYPE'])
first=subprocess.Popen(['/usr/bin/python3','-I','-S','-B','-c','import os,time;os.fork();time.sleep(30)'],start_new_session=True)
p=Path(%r);p.write_text(json.dumps({'helper':os.getpid(),'escaped':first.pid}));p.chmod(0o600)
%s
'''%(self.package.conversation,str(self.marker),'time.sleep(30)' if mode=='wait' else ''))
        helper.chmod(0o550)
        definition=root/'desk-definitions.json'
        definition.write_text(json.dumps({'format':'orkestr-desk-operations-v1','operations':{'synthetic-login':{
            'helper':str(helper),'sha256':digest(helper),'conversation_id':self.package.conversation,
            'desk':'synthetic-desk','site':'example.invalid','duration_ms':30000}}}))
        definition.chmod(0o440)
        runtime=self.package.root/'service.json';value=json.loads(runtime.read_text())
        value['desk_login']={'path':str(definition),'sha256':digest(definition)};runtime.write_text(json.dumps(value))
        manifest=self.package.root/'manifest.json';value=json.loads(manifest.read_text());value['files']['service.json']=digest(runtime);manifest.write_text(json.dumps(value))
        from codex_service.package import Package
        self.package=Package(self.package.root,digest(manifest))
        self.operations=Operations(self.package);self.addCleanup(self.operations.close)
        self.broker=subprocess.Popen(['/usr/bin/sleep','30'],user=self.package.executor_uid,
            group=self.package.executor_gid,extra_groups=[])
        self.addCleanup(self.stop_broker)
        window='22222222-2222-4222-8222-222222222222'
        setup=dict(owner_id=self.package.owner,conversation_id=self.package.conversation,role='deep',provider='codex',
            session_id='33333333-3333-4333-8333-333333333333',generation=1,incarnation='synthetic-core')
        journal=self.package.ledger_directory/'synthetic-launch.json';journal.write_text(json.dumps({'state':'spawned','setup':setup}));journal.chmod(0o600)
        handle=SimpleNamespace(path=journal,window=window,generation=1,child=self.broker,broker=process(self.broker.pid))
        self.launcher=SimpleNamespace(children={self.broker.pid:handle})
        self.request=dict(owner_id=self.package.owner,conversation_id=self.package.conversation,window_id=window,generation=1,
            capability=dict(operation_id='44444444-4444-4444-8444-444444444444',resource_id='synthetic-login',
                run_id='55555555-5555-4555-8555-555555555555',session_id=setup['session_id'],binding_generation=2,setup_generation=1,
                lease_generation=1,dispatch_fence=1,incarnation=setup['incarnation'],correlation_sha256='a'*64,expires_at_ms=int(time.time()*1000)+30000))
        return helper,journal

    def stop_broker(self):
        if self.broker.poll() is None:self.broker.kill()
        self.broker.wait(timeout=2)

    def finish(self):
        deadline=time.monotonic()+6
        while self.operations.active:
            self.assertLess(time.monotonic(),deadline)
            self.operations.tick(lambda *_:True);time.sleep(.01)
        return self.operations.receipt(self.operations.directory/(self.request['capability']['operation_id']+'.json'))

    def test_fixed_helper_reaps_detached_tree_and_never_replays(self):
        self.prepare();first=self.operations.start(self.request,self.launcher)
        self.assertEqual(first['state'],'running');self.assertFalse(first['cleanup'])
        self.assertEqual(self.operations.start(self.request,self.launcher)['operation_id'],first['operation_id'])
        result=self.finish();self.assertEqual(result['state'],'helper_completed');self.assertTrue(result['cleanup'])
        proof=json.loads(self.marker.read_text())
        self.assertIsNone(process(proof['helper']));self.assertIsNone(process(proof['escaped']))
        with patch('subprocess.Popen',side_effect=AssertionError('must not replay')):
            self.assertEqual(self.operations.start(self.request,self.launcher),result)

    def test_cancellation_reaps_actual_root_and_detached_children(self):
        self.prepare('wait');self.operations.start(self.request,self.launcher)
        until=time.monotonic()+4
        while not self.marker.exists():
            self.assertLess(time.monotonic(),until);time.sleep(.01)
        self.operations.cancel(self.request['capability']['operation_id'])
        result=self.finish();self.assertEqual(result['state'],'cancelled');self.assertTrue(result['cleanup'])
        proof=json.loads(self.marker.read_text())
        self.assertIsNone(process(proof['helper']));self.assertIsNone(process(proof['escaped']))

    def test_other_conversation_role_and_smuggled_environment_cannot_start(self):
        _,journal=self.prepare()
        for field,value in [('conversation_id','99999999-9999-4999-8999-999999999999'),('owner_id','99999999-9999-4999-8999-999999999999')]:
            request={**self.request,field:value}
            with self.assertRaises(Refused):self.operations.start(request,self.launcher)
        for role in ('fast','worker'):
            value=json.loads(journal.read_text());value['setup']['role']=role;journal.write_text(json.dumps(value))
            with self.assertRaises(Refused):self.operations.start(self.request,self.launcher)
        self.request['capability']['environment']={'PATH':'/other'}
        with self.assertRaises(Refused):self.operations.start(self.request,self.launcher)
        self.assertFalse(self.marker.exists());self.assertFalse(list(self.operations.directory.glob('*.json')))

    def test_lost_anchor_receipt_is_unknown_and_window_remains_fenced(self):
        self.prepare('wait');self.operations.start(self.request,self.launcher)
        handle=next(iter(self.operations.active.values()))
        # Cancel through the owned channel, then discard its proof: physical
        # exit alone never upgrades an unknown receipt to helper completion.
        self.operations.cancel(self.request['capability']['operation_id'])
        while handle['child'].poll() is None:time.sleep(.01)
        handle['socket'].recv(1024)
        result=self.finish();self.assertEqual(result['state'],'unknown');self.assertFalse(result['cleanup'])
        self.assertFalse(self.operations.window_clean(self.request['window_id']))
        self.assertFalse(self.operations.close())

    def test_dead_anchor_root_orphans_are_kernel_owned_reaped_and_never_reassigned(self):
        import ctypes
        from codex_service.ownership import Adopted
        libc=ctypes.CDLL(None);previous=ctypes.c_int()
        self.assertEqual(libc.prctl(37,ctypes.byref(previous),0,0,0),0)
        self.assertEqual(libc.prctl(36,1,0,0,0),0)
        self.addCleanup(lambda:libc.prctl(36,previous.value,0,0,0))
        self.prepare('wait');self.operations.start(self.request,self.launcher)
        until=time.monotonic()+4
        while not self.marker.exists():
            self.assertLess(time.monotonic(),until);time.sleep(.01)
        proof=json.loads(self.marker.read_text())
        original={name:process(proof[name]) for name in ('helper','escaped')}
        known_peer=subprocess.Popen(['/usr/bin/sleep','30'])
        try:
            handle=next(iter(self.operations.active.values()));handle['child'].kill();handle['child'].wait(timeout=2)
            self.operations.tick(lambda *_:True);self.operations.fault()
            adopted=Adopted(self.package)
            try:
                known={(self.broker.pid,process(self.broker.pid)['start']),(known_peer.pid,process(known_peer.pid)['start'])}
                self.assertTrue(adopted.capture(known))
                self.assertTrue(adopted.drain(known,seconds=3))
                self.assertTrue(all(not exists(identity) for identity in original.values()))
                self.assertIsNone(known_peer.poll(),'known Root peer must not be killed by UID')
                self.assertTrue(all(record.identity['uid']==0 for record in adopted.records.values()))
            finally:adopted.close()
            result=self.operations.receipt(handle['path'])
            self.assertEqual(result['state'],'unknown');self.assertFalse(result['cleanup'])
            self.assertFalse(self.operations.window_clean(self.request['window_id']))
            with self.assertRaises(Refused):self.operations.start(self.request,self.launcher)
        finally:known_peer.kill();known_peer.wait(timeout=2)
