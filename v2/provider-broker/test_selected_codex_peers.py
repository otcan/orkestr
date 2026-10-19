"""Real Unix namespace peer identity/source negatives, no native or account."""
import json,os,select,shutil,socket,subprocess,sys,tempfile,time,unittest
from types import SimpleNamespace
from pathlib import Path
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parent))
from codex_bounded.trust import process,exists,belongs
from codex_bounded.configuration import HELPERS
from codex_bounded.peer import authenticate
UID=GID=65534

def endpoint(path):
    listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
    listener.bind(str(path));os.chown(path,0,GID);path.chmod(0o660);listener.listen(4)
    return listener

def descendants(owner):
    result=[]
    for path in Path('/proc').iterdir():
        item=process(int(path.name)) if path.name.isdigit() else None
        if item and item['uid']==UID and belongs(item['pid'],owner):result.append(item)
    return result

def wait_for(operation,reason,seconds):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        if operation():return
        time.sleep(.02)
    raise AssertionError(reason)

def gone(known):
    # A surrounding test runner may itself be a subreaper. Reap only the
    # namespace descendants this fixture recorded before its own child exited.
    for item in known:
        if exists(item):
            try:os.waitpid(item['pid'],os.WNOHANG)
            except ChildProcessError:pass
    return all(not exists(item) for item in known)
RESULTS=[]
PEER="""import socket,sys
print('ready',flush=True)
assert sys.stdin.buffer.read(1)==b'x'
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(2)
s.connect('/run/provider-egress.sock');v=s.recv(1)
assert v in (b'',b'1')
s.close();print('accepted' if v else 'refused',flush=True)
"""

@unittest.skipUnless(os.geteuid()==0, 'explicit root namespace test required')
class PeerTests(unittest.TestCase):
    def exercise(self,case):
        package=Path(tempfile.mkdtemp(prefix='bounded-peer-',dir='/opt'))
        directory=Path(tempfile.mkdtemp(prefix='bounded-peer-',dir='/run'))
        for p in (package,directory):os.chown(p,0,GID);p.chmod(0o750)
        source=package/'isolation';source.mkdir(parents=True,mode=0o750)
        for p in (source,source.parent):os.chown(p,0,GID);p.chmod(0o750)
        for name in ('supervisor.py','authenticated_budget.py',*HELPERS,'different.py'):
            p=source/name;p.write_text(PEER if name in ('supervisor.py','different.py') else '# fixed dummy source\n')
            os.chown(p,0,GID);p.chmod(0o444)
        listener=endpoint(directory/'egress.sock');peer=holder=None;known=[]
        try:
            uid=0 if case=='wrong_uid' else UID
            command=['/usr/bin/bwrap','--unshare-all','--die-with-parent','--ro-bind','/usr','/usr',
                '--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--proc','/proc','--dev','/dev']
            for name in ('supervisor.py','authenticated_budget.py',*HELPERS):
                selected='different.py' if case=='wrong_source' and name=='supervisor.py' or case=='wrong_helper' and name==HELPERS[0] else name
                command+=['--ro-bind',str(source/selected),'/opt/provider/'+name]
            command+=['--ro-bind',str(directory/'egress.sock'),'/run/provider-egress.sock',
                '--','/usr/bin/python3','-I','-B','/opt/provider/supervisor.py','99','chatgpt.com',
                'codex' if case=='wrong_mode' else 'codex-bounded']
            peer=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
                env={'PATH':'/usr/bin:/bin'},user=uid,group=GID if uid==UID else 0,extra_groups=[])
            self.assertTrue(select.select([peer.stdout],[],[],3)[0]);self.assertEqual(peer.stdout.readline(),b'ready\n')
            owner=process(peer.pid);self.assertIsNotNone(owner)
            known.extend(descendants(owner) if uid==UID else [owner])
            if case=='unrelated':
                holder=subprocess.Popen(['/usr/bin/python3','-I','-B','-c',"import sys;print('ready',flush=True);sys.stdin.read(1)"],
                    stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env={'PATH':'/usr/bin:/bin'},
                    user=UID,group=GID,extra_groups=[])
                self.assertTrue(select.select([holder.stdout],[],[],2)[0]);self.assertEqual(holder.stdout.readline(),b'ready\n')
                owner=process(holder.pid);known.append(owner)
                self.assertFalse(belongs(peer.pid,owner))
            if case=='stale_owner':owner=dict(owner);owner['start']+=1;self.assertFalse(exists(owner))
            peer.stdin.write(b'x');peer.stdin.flush()
            listener.settimeout(2);connection,_=listener.accept()
            try:
                actual=authenticate(connection,SimpleNamespace(root=package,uid=UID),owner)
                if actual:connection.sendall(b'1')
            finally:connection.close()
            out,_=peer.communicate(timeout=3);self.assertEqual(peer.returncode,0)
            accepted=case=='accepted';self.assertEqual(bool(actual),accepted)
            self.assertEqual(out,b'accepted\n' if accepted else b'refused\n')
            if holder:holder.communicate(b'x',timeout=2);self.assertEqual(holder.returncode,0)
            wait_for(lambda:gone(known),'owned_namespace_cleanup',2)
            RESULTS.append({'case':case,'namespace_executed':True,'accepted':accepted,'known_processes_gone':len(known)})
        finally:
            for child in (peer,holder):
                if child:
                    if child.poll() is None:child.kill()
                    child.communicate(timeout=3)
            listener.close();shutil.rmtree(package);shutil.rmtree(directory)
    def test_exact_owned_peer(self):self.exercise('accepted')
    def test_unrelated_same_uid(self):self.exercise('unrelated')
    def test_stale_owner(self):self.exercise('stale_owner')
    def test_wrong_uid(self):self.exercise('wrong_uid')
    def test_wrong_mounted_source(self):self.exercise('wrong_source')
    def test_wrong_mounted_helper(self):self.exercise('wrong_helper')
    def test_wrong_mode(self):self.exercise('wrong_mode')

if __name__=='__main__':
    output=Path(sys.argv.pop()) if len(sys.argv)==2 else None
    suite=unittest.main(exit=False)
    if output:
        with output.open('x') as stream:stream.write(json.dumps({'ok':suite.result.wasSuccessful(),'tests':suite.result.testsRun,'cases':RESULTS},indent=2)+'\n')
        output.chmod(0o600)
    raise SystemExit(0 if suite.result.wasSuccessful() else 1)
