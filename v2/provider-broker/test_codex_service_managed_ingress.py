"""Disposable caller custody tests; no live provider, Root inbox or credentials."""
import array
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from codex_bounded.trust import process
from codex_service.contract import Refused,canonical
from codex_service.managed_ingress import Ingress,Peer,packet,source
from codex_service.ownership import Process
import test_codex_service_identity as identity_tests

REQUEST={'version':1,'request_key':'synthetic-1','operation':'root_request_submit',
         'arguments':{'action':'read','resource':'example.invalid','summary':'Agent-requested summary'}}


@unittest.skipUnless(os.geteuid()==0,'Root-owned split package configuration')
class ManagedPackageTests(identity_tests.SplitPackageTests):
    test_split_loader_binds_authority_paths_but_refuses_unqualified_legacy_launch=None
    test_executor_cannot_read_replace_authority_or_gain_setuid_with_nnp=None
    test_external_server_configurations_require_authority_private_custody=None

    def test_only_explicit_true_split_option_opens_root_owned_observer(self):
        from codex_service.manager import Manager
        from codex_service.package import Package
        self.select_split();service=self.fixture.package/'service.json';manifest=self.fixture.package/'manifest.json'
        def select(flag):
            value=json.loads(service.read_text());value['managed_operations']=flag;service.write_text(json.dumps(value))
            value=json.loads(manifest.read_text());value['files']['service.json']=self.digest(service);manifest.write_text(json.dumps(value))
            return self.digest(manifest)
        expected=select(True);manager=Manager(self.fixture.package,expected)
        try:
            self.assertEqual(manager.managed.socket.socket.type,socket.SOCK_SEQPACKET)
            self.assertEqual(manager.managed.directory.stat().st_mode&0o777,0o700)
            with self.assertRaisesRegex(Refused,'split_launch_unqualified'):manager.start()
        finally:manager.close()
        for flag in (False,1,'true',{}):
            expected=select(flag)
            with self.assertRaisesRegex(Refused,'managed_split_configuration'):Package(self.fixture.package,expected)


class PacketTests(unittest.TestCase):
    def test_closed_fields_and_text_bounds(self):
        self.assertEqual(packet(canonical(REQUEST)),REQUEST)
        for extra in ('owner_id','role','conversation_id','provider','environment','command','decision'):
            with self.assertRaises(Refused):packet(canonical({**REQUEST,extra:'untrusted'}))
        for arguments in ({**REQUEST['arguments'],'role':'deep'},
                          {**REQUEST['arguments'],'summary':'x'*4097},
                          {**REQUEST['arguments'],'summary':'\0'}):
            with self.assertRaises(Refused):packet(canonical({**REQUEST,'arguments':arguments}))
        for operation in ('approve','overrule','execute','root_request_decide'):
            with self.assertRaises(Refused):packet(canonical({**REQUEST,'operation':operation}))

    def test_actual_packet_sender_must_match_original_socket_creator(self):
        listener=socket.socket(socket.AF_UNIX,socket.SOCK_SEQPACKET)
        with tempfile.TemporaryDirectory() as directory:
            listener.bind(directory+'/socket');listener.setsockopt(socket.SOL_SOCKET,socket.SO_PASSCRED,1);listener.listen()
            client=socket.socket(socket.AF_UNIX,socket.SOCK_SEQPACKET);client.connect(directory+'/socket')
            connection,_=listener.accept()
            identity=process(os.getpid())
            scope={'caller_pid':os.getpid(),'caller_uid':os.geteuid()}
            with patch('codex_service.managed_ingress.source',return_value=(scope,Process(identity))):
                peer=Peer(None,connection)
            try:
                client.send(canonical(REQUEST));self.assertEqual(peer.receive(),REQUEST)
                # A fork inherits the connected FD and UID but cannot inherit
                # the kernel's per-message sender PID. No request is accepted.
                child=os.fork()
                if child==0:
                    try:client.send(canonical(REQUEST))
                    finally:os._exit(0)
                os.waitpid(child,0)
                with self.assertRaisesRegex(Refused,'managed_sender_changed'):peer.receive()
            finally:peer.close();client.close();listener.close()

    def test_rejected_descriptor_passing_closes_received_descriptors(self):
        left,right=socket.socketpair(socket.AF_UNIX,socket.SOCK_SEQPACKET)
        left.setsockopt(socket.SOL_SOCKET,socket.SO_PASSCRED,1)
        identity=process(os.getpid())
        with patch('codex_service.managed_ingress.source',return_value=(
                {'caller_pid':os.getpid(),'caller_uid':os.geteuid()},Process(identity))):peer=Peer(None,left)
        fd=os.open('/dev/null',os.O_RDONLY)
        try:
            before=len(list(Path('/proc/self/fd').iterdir()))
            right.sendmsg([canonical(REQUEST)],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[fd]))])
            with self.assertRaises(Refused):peer.receive()
            self.assertEqual(len(list(Path('/proc/self/fd').iterdir())),before)
        finally:os.close(fd);peer.close();right.close()


@unittest.skipUnless(os.geteuid()==0,'Root-owned disposable kernel lineage fixture')
class RootCallerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='ork-managed-ingress-',dir='/')
        self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.root.chmod(0o750);os.chown(self.root,0,65534)
        self.directory=self.root/'ledger';self.directory.mkdir(mode=0o700)
        self.manager=SimpleNamespace(package=SimpleNamespace(executor_uid=65534,gid=65534,identity_split=True,
            control=self.root/'control.sock',ledger_directory=self.directory),ledger=SimpleNamespace(
                endpoint=lambda _:None,set_endpoint=lambda *_:None,clear_endpoint=lambda *_:None),
            _desk_window_active=lambda *_:True)
        self.children=[];self.addCleanup(self.stop_children)

    def stop_children(self):
        for child in self.children:
            if child.poll() is None:child.kill()
            child.wait(timeout=3)

    def caller(self,nnp=True):
        code='import ctypes,sys;ctypes.CDLL(None).prctl(38,1,0,0,0);print("ready",flush=True);sys.stdin.read()'
        if not nnp:code='import sys;print("ready",flush=True);sys.stdin.read()'
        child=subprocess.Popen([sys.executable,'-I','-S','-B','-c',code],stdin=subprocess.PIPE,stdout=subprocess.PIPE,
            user=65534,group=65534,extra_groups=[],env={'PATH':'/usr/bin:/bin','PYTHONDONTWRITEBYTECODE':'1'})
        self.children.append(child);self.assertEqual(child.stdout.readline(),b'ready\n');return child

    def bind(self,child,role='deep',setup_role='deep'):
        identity=process(child.pid);key=(child.pid,identity['start'])
        setup=dict(owner_id='11111111-1111-4111-8111-111111111111',
            conversation_id='22222222-2222-4222-8222-222222222222',
            session_id='33333333-3333-4333-8333-333333333333',generation=1,
            incarnation='synthetic-core',role=setup_role,provider='codex',
            native_session_id='synthetic-native',resume_setup_id='synthetic-setup')
        path=self.directory/'launch.json';path.write_text(json.dumps({'state':'spawned','role':role,'setup':setup}));path.chmod(0o600)
        handle=SimpleNamespace(child=child,broker=identity,window='synthetic-window',generation=1,path=path)
        self.manager.launcher=SimpleNamespace(children={child.pid:handle})
        self.manager.windows={'synthetic-window':SimpleNamespace(children=SimpleNamespace(
            observe=lambda:None,records={key:True},families={key:{key}}))}

    def test_original_live_nnp_deep_caller_retains_root_source_including_resume(self):
        child=self.caller();self.bind(child)
        value,proof=source(self.manager,child.pid,65534)
        try:
            self.assertEqual(value['conversation_id'],'22222222-2222-4222-8222-222222222222')
            self.assertEqual(value['resume_setup_id'],'synthetic-setup')
            self.assertEqual(value['caller_pid'],child.pid)
        finally:proof.close()
        stranger=self.caller()
        with self.assertRaisesRegex(Refused,'managed_caller_lineage'):source(self.manager,stranger.pid,65534)

    def test_fast_worker_standalone_or_nnp_disabled_cannot_borrow_deep_authority(self):
        child=self.caller()
        for role,setup_role in [('fast','deep'),('worker-0','worker'),('claude','fast')]:
            self.bind(child,role,setup_role)
            with self.assertRaisesRegex(Refused,'managed_caller_role'):source(self.manager,child.pid,65534)
        uncontained=self.caller(nnp=False);self.bind(uncontained)
        with self.assertRaisesRegex(Refused,'managed_caller_nnp'):source(self.manager,uncontained.pid,65534)

    def test_journal_idempotency_bound_and_restart_never_reconstruct_authority(self):
        child=self.caller();self.bind(child)
        ingress=Ingress(self.manager)
        try:
            value,proof=source(self.manager,child.pid,65534)
            peer=SimpleNamespace(source=value,path=None,request=None)
            ingress._record(peer,REQUEST);path=peer.path
            ingress._record(peer,REQUEST);self.assertEqual(peer.path,path)
            borrowed=SimpleNamespace(source={**value,'caller_pid':value['caller_pid']+1},path=None,request=None)
            with self.assertRaisesRegex(Refused,'managed_original_caller_required'):ingress._record(borrowed,REQUEST)
            with self.assertRaisesRegex(Refused,'managed_replay_conflict'):
                ingress._record(peer,{**REQUEST,'arguments':{**REQUEST['arguments'],'summary':'changed'}})
            with patch('codex_service.managed_ingress.MAX_WINDOW_REQUESTS',1):
                with self.assertRaisesRegex(Refused,'managed_window_bound'):
                    ingress._record(peer,{**REQUEST,'request_key':'synthetic-2'})
            proof.close()
        finally:ingress.close()

        ingress=Ingress(self.manager)
        try:
            self.assertEqual(json.loads(path.read_text())['state'],'unknown')
            self.assertEqual(ingress.pending('synthetic-window',1),[])
        finally:ingress.close()

    def pending_request(self):
        child=self.caller();self.bind(child);ingress=Ingress(self.manager)
        self.addCleanup(ingress.close)
        value,proof=source(self.manager,child.pid,65534)
        peer=SimpleNamespace(source=value,path=None,request=None,proof=proof,
            deadline=time.monotonic()+30,close=proof.close)
        ingress._record(peer,REQUEST);ingress.peers.append(peer)
        from codex_service.managed_control import normalize_source
        cap={'operation_id':peer.request,'run_id':'44444444-4444-4444-8444-444444444444',
            'source_message_id':'55555555-5555-4555-8555-555555555555','source_event_id':'66666666-6666-4666-8666-666666666666',
            'binding_generation':2,'lease_generation':1,'dispatch_fence':1,'expires_at_ms':int(time.time()*1000)+25000,
            'evidence':{'source':normalize_source(value),'request':REQUEST}}
        return ingress,peer,cap

    def test_fixed_protected_submit_is_agent_summary_without_owner_approval_or_replay(self):
        from codex_service.managed_control import consume
        ingress,peer,cap=self.pending_request()
        result=consume(ingress,cap)
        self.assertEqual(result['state'],'completed')
        directory=self.directory/'root-request-submissions';path=directory/(peer.request+'.json')
        value=json.loads(path.read_text())
        self.assertEqual(value['agent_requested_summary'],REQUEST['arguments']['summary'])
        self.assertFalse(value['owner_approved']);self.assertIsNone(value['owner_instruction_reference'])
        self.assertEqual(directory.stat().st_mode&0o777,0o700);self.assertEqual(path.stat().st_mode&0o777,0o600)
        with patch('codex_service.managed_control.publish',side_effect=AssertionError('cannot republish')):
            self.assertEqual(consume(ingress,cap),result)
        changed=json.loads(json.dumps(cap));changed['evidence']['source']['conversation_id']='99999999-9999-4999-8999-999999999999'
        with self.assertRaisesRegex(Refused,'managed_evidence_changed'):consume(ingress,changed)

    def test_publication_receipt_failure_preserves_unknown_claim_and_cannot_republish(self):
        from codex_service import managed_control
        ingress,peer,cap=self.pending_request();original=managed_control.atomic
        def fail_final(path,value):
            if value.get('state')=='completed':raise OSError('synthetic receipt failure')
            original(path,value)
        with patch('codex_service.managed_control.atomic',side_effect=fail_final):
            with self.assertRaises(OSError):managed_control.consume(ingress,cap)
        self.assertEqual(json.loads(peer.path.read_text())['state'],'unknown')
        published=self.directory/'root-request-submissions'/(peer.request+'.json');self.assertTrue(published.exists())
        with patch('codex_service.managed_control.publish',side_effect=AssertionError('cannot republish')):
            self.assertEqual(managed_control.consume(ingress,cap)['state'],'unknown')

    def test_actual_separate_uid_nnp_cli_roundtrip_to_protected_intake(self):
        from codex_service import managed_client,managed_control
        client=self.root/'client.py';client.write_bytes(Path(managed_client.__file__).read_bytes());client.chmod(0o644)
        ingress=Ingress(self.manager);self.addCleanup(ingress.close)
        script='''import ctypes,runpy,sys
assert ctypes.CDLL(None).prctl(38,1,0,0,0)==0
print('ready',flush=True)
assert sys.stdin.buffer.read(1)==b'!'
path,endpoint=sys.argv[1:];sys.argv=[path,endpoint];runpy.run_path(path,run_name='__main__')
'''
        child=subprocess.Popen([sys.executable,'-I','-S','-B','-c',script,str(client),str(ingress.socket.path)],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,user=65534,group=65534,extra_groups=[],
            env={'PATH':'/usr/bin:/bin','PYTHONDONTWRITEBYTECODE':'1'})
        self.children.append(child);self.assertEqual(child.stdout.readline(),b'ready\n');self.bind(child)
        child.stdin.write(b'!'+canonical(REQUEST));child.stdin.close();deadline=time.monotonic()+4
        while not ingress.pending('synthetic-window',1):
            self.assertLess(time.monotonic(),deadline);ingress.tick();time.sleep(.005)
        record=ingress.pending('synthetic-window',1)[0]
        cap={'operation_id':record['request_id'],'run_id':'44444444-4444-4444-8444-444444444444',
            'source_message_id':'55555555-5555-4555-8555-555555555555','source_event_id':'66666666-6666-4666-8666-666666666666',
            'binding_generation':2,'lease_generation':1,'dispatch_fence':1,'expires_at_ms':int(time.time()*1000)+25000,
            'evidence':{'source':managed_control.normalize_source(record['source']),'request':REQUEST}}
        # This unit test supplies the trusted authority port's grant. Real Core
        # issuance/fences have separate tests; no owner decision is synthesized.
        managed_control.consume(ingress,cap);ingress.tick();child.wait(timeout=3)
        self.assertEqual(child.returncode,0,child.stderr.read().decode())
        reply=json.loads(child.stdout.readline());self.assertEqual(reply['state'],'completed')
        self.assertFalse(reply['result']['owner_approval']);self.assertEqual(reply['result']['owner_delivery'],'unconfirmed')


if __name__=='__main__':unittest.main()
