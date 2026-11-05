"""Original broker/native identity using actual separate UID and Root pipes."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
from types import SimpleNamespace
import unittest

from codex_bounded.trust import process
from codex_service.contract import Refused
from codex_service.managed_ingress import Ingress,source
from codex_service.native_io import create
import test_codex_service_managed_ingress as ingress_tests


@unittest.skipUnless(os.geteuid()==0,'Root/native kernel custody fixture')
class ManagedNativeTests(ingress_tests.RootCallerTests):
    # Reuse only the protected disposable fixture and caller binding helpers.
    test_original_live_nnp_deep_caller_retains_root_source_including_resume=None
    test_fast_worker_standalone_or_nnp_disabled_cannot_borrow_deep_authority=None
    test_journal_idempotency_bound_and_restart_never_reconstruct_authority=None
    test_fixed_protected_submit_is_agent_summary_without_owner_approval_or_replay=None
    test_publication_receipt_failure_preserves_unknown_claim_and_cannot_republish=None
    test_actual_separate_uid_nnp_cli_roundtrip_to_protected_intake=None

    def setUp(self):
        super().setUp()
        self.manager.package.root=self.root;self.manager.package.beta={'managed_host':{'environment':{}}}
        native=self.root/'native';shutil.copyfile(sys.executable,native);native.chmod(0o755)
        self.native=native

    def start_native(self):
        descriptors=create();self.addCleanup(lambda:[os.close(fd) for fd in descriptors])
        script='''import ctypes,os,subprocess,sys
assert ctypes.CDLL(None).prctl(38,1,0,0,0)==0
native=subprocess.Popen([sys.argv[1],'-I','-S','-B','-c','import time;time.sleep(30)'],
    stdin=int(sys.argv[2]),stdout=int(sys.argv[3]),stderr=subprocess.DEVNULL,close_fds=True)
print(native.pid,flush=True)
try:sys.stdin.read()
finally:native.kill();native.wait()
'''
        broker=subprocess.Popen([sys.executable,'-I','-S','-B','-c',script,str(self.native),str(descriptors[0]),str(descriptors[3])],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,user=65534,group=65534,extra_groups=[],
            pass_fds=(descriptors[0],descriptors[3]),env={'PATH':'/usr/bin:/bin','PYTHONDONTWRITEBYTECODE':'1'})
        self.children.append(broker);native=int(broker.stdout.readline());self.bind(broker)
        self.addCleanup(self.close_broker,broker)
        handle=next(iter(self.manager.launcher.children.values()))
        handle.native_io={name:{'device':os.fstat(fd).st_dev,'inode':os.fstat(fd).st_ino}
                          for name,fd in zip(('input','output'),(descriptors[0],descriptors[2]))}
        return broker,native

    def close_broker(self,broker):
        if broker.poll() is None:
            broker.stdin.close()
            try:broker.wait(timeout=3)
            except subprocess.TimeoutExpired:broker.kill();broker.wait(timeout=2)

    def test_only_original_broker_can_register_its_original_child_and_actor_is_pinned(self):
        broker,native=self.start_native();ingress=Ingress(self.manager);self.addCleanup(ingress.close)
        scope,proof=source(self.manager,broker.pid,65534);self.addCleanup(proof.close)
        peer=SimpleNamespace(source=scope)
        request={'arguments':{'pid':native,'start':process(native)['start']}}
        identifier=ingress.natives.register(peer,request)
        self.assertEqual(ingress.natives.register(peer,request),identifier)
        record=ingress.natives.actor(native);self.assertEqual(record['proof'].identity['pid'],native)
        with self.assertRaisesRegex(Refused,'managed_native_not_registered'):ingress.natives.actor(broker.pid)
        borrowed=SimpleNamespace(source={**scope,'caller_pid':native,'caller_start':process(native)['start']})
        with self.assertRaisesRegex(Refused,'managed_native_original_broker'):ingress.natives.register(borrowed,request)
        altered={'arguments':{'pid':broker.pid,'start':scope['broker_start']}}
        with self.assertRaisesRegex(Refused,'managed_native_original_child'):ingress.natives.register(peer,altered)
        self.close_broker(broker)
        with self.assertRaises(Refused):ingress.natives.actor(native)
        ingress.natives.prune();self.assertFalse(ingress.natives.records)

    def test_a_different_root_pipe_pair_or_bounded_profile_cannot_register(self):
        broker,native=self.start_native();ingress=Ingress(self.manager);self.addCleanup(ingress.close)
        scope,proof=source(self.manager,broker.pid,65534);self.addCleanup(proof.close)
        request={'arguments':{'pid':native,'start':process(native)['start']}}
        handle=next(iter(self.manager.launcher.children.values()));handle.native_io['input']['inode']+=1
        with self.assertRaisesRegex(Refused,'managed_native_pipe_identity'):
            ingress.natives.register(SimpleNamespace(source=scope),request)
        self.manager.package.beta={}
        with self.assertRaisesRegex(Refused,'managed_native_host_required'):
            ingress.natives.register(SimpleNamespace(source=scope),request)


if __name__=='__main__':unittest.main()
