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

REQUEST={'version':1,'request_key':'synthetic-1','operation':'root_request_submit',
         'arguments':{'action':'read','resource':'example.invalid','summary':'Agent-requested summary'}}


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


if __name__=='__main__':unittest.main()
