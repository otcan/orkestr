"""One-use SCM_RIGHTS launch, root-owned broker startup and quarantine tests.

All paths, accounts and ELF files are disposable synthetic fixture state. No
live service, credential, real provider or host sudo policy is touched.
"""
import array
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

from codex_service.channel import receive_control
from codex_service.contract import Refused,encode
from codex_bounded.trust import process


def request():
    return dict(version=1,operation='launch_child',request_id='synthetic-launch',
                owner_id='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
                conversation_id='11111111-1111-4111-8111-111111111111',
                window_id='22222222-2222-4222-8222-222222222222',generation=1,
                role='deep',mode='fresh',preferences=dict(model=None,effort=None),setup=dict(session_id='33333333-3333-4333-8333-333333333333',
                    owner_id='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',conversation_id='11111111-1111-4111-8111-111111111111',
                    generation=1,incarnation='synthetic-setup',role='deep',provider='codex'),
                proxy_pid=123,proxy_start=456,bind_deadline_ms=int(time.time()*1000)+4000)


class LaunchTransportTests(unittest.TestCase):
    def test_workspace_marker_is_optional_closed_and_worker_fresh_only(self):
        from codex_service.contract import decode, HEADER
        value=request();value['workspace_worker']=True
        with self.assertRaisesRegex(Refused,'workspace_worker_launch'):decode(encode(value)[HEADER.size:])
        value['role']='worker-0';value['setup']['role']='worker'
        self.assertTrue(decode(encode(value)[HEADER.size:])['workspace_worker'])
        for invalid in (1,'true',None):
            value['workspace_worker']=invalid
            with self.assertRaisesRegex(Refused,'workspace_worker_launch'):decode(encode(value)[HEADER.size:])

    def test_preferences_are_closed_provider_scoped_and_never_an_environment(self):
        from codex_service.contract import decode,HEADER
        value=request();value['role']='claude';value['setup']['provider']='claude'
        value['preferences']={'model':'synthetic-model','effort':'low'}
        self.assertEqual(decode(encode(value)[HEADER.size:])['preferences'],value['preferences'])
        for preferences in ({'HOME':'/other'}, {'model':True,'effort':None},
                            {'model':'--config=/other','effort':None},
                            {'model':'123','effort':None}, {'model':None,'effort':'unbounded'},
                            {'model':None,'effort':None,'ANTHROPIC_API_KEY':'synthetic'}):
            value['preferences']=preferences
            with self.assertRaises(Refused):decode(encode(value)[HEADER.size:])
        value=request();value['preferences']['model']='synthetic-model'
        with self.assertRaises(Refused):decode(encode(value)[HEADER.size:])

    def test_setup_fence_rejects_cross_owner_conversation_and_launcher_role(self):
        from codex_service.contract import decode,HEADER
        for field,value in [('owner_id','bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'),
                            ('conversation_id','44444444-4444-4444-8444-444444444444'),
                            ('role','worker'),('provider','claude')]:
            item=request();item['setup'][field]=value
            with self.assertRaises(Refused):decode(encode(item)[HEADER.size:])

    def test_rights_are_explicit_and_nonlaunch_cannot_smuggle_descriptors(self):
        for launch in (True,False):
            a,b=socket.socketpair();read,write=os.pipe()
            original=len(list(Path('/proc/self/fd').iterdir()))
            received=[]
            try:
                value=request()
                if not launch:
                    value={k:v for k,v in value.items() if k not in ('window_id','generation','role','mode','setup','preferences','proxy_pid','proxy_start','bind_deadline_ms')}
                    value['operation']='status'
                rights=array.array('i',[read,write,read,write])
                a.sendmsg([encode(value)],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,rights)])
                a.shutdown(socket.SHUT_WR)
                if launch:
                    decoded,received=receive_control(b,time.monotonic()+1)
                    self.assertEqual(decoded['role'],'deep');self.assertEqual(len(received),4)
                else:
                    with self.assertRaisesRegex(Refused,'descriptor_count'):
                        receive_control(b,time.monotonic()+1)
            finally:
                for fd in received:os.close(fd)
                self.assertEqual(len(list(Path('/proc/self/fd').iterdir())),original)
                os.close(read);os.close(write);a.close();b.close()


@unittest.skipUnless(os.geteuid()==0,'root-owned synthetic manager launch fixture')
class RootLaunchTests(unittest.TestCase):
    def setUp(self):
        from codex_service_fixture import ServiceFixture,UID,GID
        from codex_bounded.trust import digest
        from test_codex_service_identity import SplitPackageTests
        self.uid=UID;self.gid=GID;self.digest=digest
        self.fixture=ServiceFixture();self.addCleanup(self.fixture.close);self.fixture.prepare()
        self.package=SplitPackageTests.select_split(self)
        egress=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        egress.bind(str(self.package.endpoint));egress.listen(1)
        os.chown(self.package.endpoint,0,self.gid);self.package.endpoint.chmod(0o660)
        self.addCleanup(egress.close)
        self.control,child_socket=socket.socketpair()
        # Source-created provider socket credentials must name the authority
        # process, not this root fixture process.
        script='''import array,json,os,socket,subprocess,sys,time
c=socket.socket(fileno=int(sys.argv[1]));r,w=os.pipe();ro,wo=os.pipe();a,b=socket.socketpair();life,proxy=socket.socketpair()
def inherit():
 os.dup2(b.fileno(),3);os.dup2(proxy.fileno(),6)
 for fd in (b.fileno(),proxy.fileno()):
  if fd not in (3,6):os.close(fd)
p=subprocess.Popen([os.path.realpath(sys.executable),"-I","-S","-B",sys.argv[2]+"/codex_service/entry.py","broker","open-owned-session","--protocol","orkestr-v2-provider-broker-v1"],stdin=r,stdout=wo,stderr=subprocess.PIPE,pass_fds=(3,6,b.fileno(),proxy.fileno()),preexec_fn=inherit,cwd="/",env={"PATH":"/usr/bin:/bin","PYTHONDONTWRITEBYTECODE":"1"})
deadline=time.monotonic()+4
while True:
 if p.poll() is not None:raise RuntimeError(p.stderr.read().decode())
 state=open("/proc/%s/stat"%p.pid).read().rsplit(")",1)[1].split()
 if state[0]=="T":break
 assert time.monotonic()<deadline
 time.sleep(.002)
c.sendmsg([json.dumps({"proxy_pid":p.pid,"proxy_start":int(state[19])}).encode()],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array("i",[r,wo,b.fileno(),life.fileno()]))])
for fd in (r,wo):os.close(fd)
b.close();life.close();proxy.close()
c.recv(1)
if p.poll() is None:p.kill()
p.wait()
'''
        self.source=subprocess.Popen([sys.executable,'-I','-S','-B','-c',script,str(child_socket.fileno()),str(self.fixture.package)],
            pass_fds=(child_socket.fileno(),),user=self.package.authority_uid,group=self.gid,extra_groups=[],
            env={'PATH':'/usr/bin:/bin','PYTHONDONTWRITEBYTECODE':'1'},stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE)
        child_socket.close()
        payload,ancillary,_,_=self.control.recvmsg(1024,socket.CMSG_SPACE(16))
        self.proxy=json.loads(payload)
        self.fds=[]
        for _,_,data in ancillary:
            values=array.array('i');values.frombytes(data);self.fds.extend(values)
        self.server=process(self.source.pid)
        self.addCleanup(self.close_source)
        from codex_service.launch import Launcher
        self.launcher=Launcher(self.package,self.server)
        self.addCleanup(self.close_launches)

    def close_launches(self):
        # Every native continuation is held by the mock in these tests; only
        # the trusted stopped fixture broker exists, so no descendant can hide.
        for handle in self.launcher.children.values():
            if handle.child.poll() is None:handle.child.kill()
            handle.child.wait(timeout=2)
        self.launcher.poll(lambda *_:True)
        self.launcher.close()

    def close_source(self):
        try:self.control.send(b'x')
        except BrokenPipeError:pass
        self.control.close();self.source.wait(timeout=2)
        if self.source.stderr:self.source.stderr.close()
        for fd in self.fds:os.close(fd)

    def test_actual_dropped_broker_is_root_parented_nnp_and_registered_once(self):
        from codex_service.ownership import Children,Process
        children=Children(self.package,self.server);self.addCleanup(children.close)
        value=request();value.update(self.proxy)
        # Hold the actual broker stopped to inspect the boundary before any
        # synthetic native could start. All pidfd/window registration is real.
        with patch.object(Process,'send') as signal_call:
            result=self.launcher.launch(value,self.fds,
                lambda receipt:children.bind_managed(receipt,value['window_id'],value['generation']),time.monotonic()+4)
        identity=process(result['broker_pid'])
        self.assertEqual(identity['uid'],self.uid);self.assertEqual(identity['ppid'],os.getpid())
        self.assertEqual(signal_call.call_count,2)
        self.assertIn((identity['pid'],identity['start']),children.brokers)
        status=Path('/proc',str(identity['pid']),'status').read_text()
        self.assertIn('NoNewPrivs:\t1',status)
        self.assertTrue(all(int(line.split()[1],16)==0 for line in status.splitlines() if line.split(':',1)[0] in ('CapInh','CapPrm','CapEff','CapAmb')))
        value['request_id']='invented-retry-id'
        with self.assertRaisesRegex(Refused,'already_claimed'):
            self.launcher.launch(value,self.fds,lambda _:self.fail(),time.monotonic()+4)
        value['setup']['generation']+=1
        with self.assertRaisesRegex(Refused,'proxy_already_claimed'):
            self.launcher.launch(value,self.fds,lambda _:self.fail(),time.monotonic()+4)
        handle=next(iter(self.launcher.children.values()))
        children.cleanup(seconds=.05)
        self.launcher.poll(lambda *_:True)
        record=json.loads(handle.path.read_text())
        self.assertEqual(record['exit_code'],-9,'Launcher must retain the original Child exit status')
        self.assertEqual(record['state'],'quarantined')
        self.launcher.close()
        self.assertIsNone(process(identity['pid']))

    def test_registration_failure_is_unknown_durable_and_reaped_without_replay(self):
        value=request();value.update(self.proxy)
        def failed(_):raise ValueError('synthetic registration loss')
        with self.assertRaises(ValueError):
            self.launcher.launch(value,self.fds,failed,time.monotonic()+4)
        records=[json.loads(p.read_text()) for p in self.launcher.directory.glob('*.json')]
        self.assertEqual(len(records),1);self.assertEqual(records[0]['state'],'unknown')
        self.assertGreater(records[0]['original_child']['start'],0)
        self.assertEqual(records[0]['failure']['exception_class'],'ValueError')
        self.assertIsNone(records[0]['original_child']['wait_status'])
        self.assertEqual(records[0]['cleanup_wait_status'],-9)
        self.assertNotIn('synthetic registration loss',json.dumps(records[0]))
        value['request_id']='different-id-same-launch'
        with self.assertRaisesRegex(Refused,'already_claimed'):
            self.launcher.launch(value,self.fds,lambda _:self.fail(),time.monotonic()+4)

    def test_proxy_exit_quarantines_but_does_not_release_a_live_real_broker(self):
        import signal
        from codex_service.ownership import Children,Process
        children=Children(self.package,self.server);self.addCleanup(children.close)
        value=request();value.update(self.proxy)
        with patch.object(Process,'send'):
            self.launcher.launch(value,self.fds,
                lambda receipt:children.bind_managed(receipt,value['window_id'],value['generation']),time.monotonic()+4)
        handle=next(iter(self.launcher.children.values()))
        signal.pidfd_send_signal(handle.proxy.fd,signal.SIGKILL)
        deadline=time.monotonic()+1
        while not handle.proxy.exited():
            self.assertLess(time.monotonic(),deadline);time.sleep(.002)
        cancelled=self.launcher.poll(lambda *_:False)
        self.assertEqual(cancelled,[(value['window_id'],value['generation'])])
        self.assertEqual(len(self.launcher.children),1)
        with self.assertRaisesRegex(Refused,'not_reaped'):self.launcher.close()
        children.cleanup(seconds=1)
        self.launcher.poll(lambda *_:children.released())
        self.assertEqual(self.launcher.children,{})
        record=json.loads(handle.path.read_text())
        self.assertEqual(record['state'],'quarantined')

    def test_foreign_server_incarnation_and_regular_file_descriptor_are_rejected(self):
        self.launcher.server['start']+=1
        with self.assertRaisesRegex(Refused,'server_changed'):
            self.launcher.launch(dict(request(),**self.proxy),self.fds,lambda _:self.fail(),time.monotonic()+4)
        self.launcher.server=self.server
        fd=os.open(self.fixture.package/'service.json',os.O_RDONLY)
        try:
            with self.assertRaisesRegex(Refused,'stdio_type'):
                self.launcher.launch(dict(request(),**self.proxy),[fd,*self.fds[1:]],lambda _:self.fail(),time.monotonic()+4)
        finally:os.close(fd)
        self.assertEqual(list(self.launcher.directory.glob('*.json')),[])


if __name__=='__main__':unittest.main()
