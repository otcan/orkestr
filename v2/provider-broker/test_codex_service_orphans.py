"""Actual kernel orphan adoption in a disposable root actor; no live service."""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest


@unittest.skipUnless(os.geteuid()==0,'explicit root synthetic orphan actor')
class AdoptedKernelTests(unittest.TestCase):
    def test_unobserved_escaped_descendants_reap_globally_without_touching_known_peer(self):
        script=r'''
import ctypes,json,os,subprocess,sys,tempfile,time
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,sys.argv[1])
from codex_service.ownership import Adopted
from codex_bounded.trust import process,exists
assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
with tempfile.TemporaryDirectory(prefix='synthetic-orphan-actor-') as directory:
 root=Path(directory);root.chmod(0o755);marker=root/'markers';marker.mkdir(mode=0o700);os.chown(marker,65534,65534)
 code="""import ctypes,os,sys,time
from pathlib import Path
assert ctypes.CDLL(None).prctl(38,1,0,0,0)==0
marker=Path(sys.argv[1]);child=os.fork()
if child==0:
 os.setsid();grandchild=os.fork()
 (marker/('grandchild' if grandchild==0 else 'child')).write_text(str(os.getpid()))
time.sleep(60)
"""
 env={'PATH':'/usr/bin:/bin','PYTHONDONTWRITEBYTECODE':'1'}
 broker=subprocess.Popen([sys.executable,'-I','-S','-B','-c',code,str(marker)],user=65534,group=65534,extra_groups=[],env=env)
 peer=subprocess.Popen(['/usr/bin/sleep','60'],user=65534,group=65534,extra_groups=[],env=env)
 pool=Adopted(SimpleNamespace(identity_split=True,executor_uid=65534))
 try:
  deadline=time.monotonic()+5
  while not all((marker/name).exists() for name in ('child','grandchild')):
   assert time.monotonic()<deadline;time.sleep(.01)
  originals=[process(int((marker/name).read_text())) for name in ('child','grandchild')]
  assert not pool.records
  peer_identity=process(peer.pid);known={(peer.pid,peer_identity['start'])}
  broker.kill();assert broker.wait(timeout=3)==-9
  assert pool.capture(known)
  assert pool.drain(known,seconds=3)
  assert all(not exists(identity) for identity in originals)
  assert peer.poll() is None
  assert not any(hasattr(record,'role') for record in pool.records.values())
  print(json.dumps({'global_reaped':True,'unassigned':True,'known_peer_preserved':True,'broker_exit':broker.returncode}))
 finally:
  pool.drain({(peer.pid,process(peer.pid)['start'])} if peer.poll() is None else set(),seconds=3);pool.close()
  for child in (broker,peer):
   if child.poll() is None:child.kill()
   child.wait(timeout=3)
'''
        result=subprocess.run([sys.executable,'-I','-S','-B','-c',script,str(Path(__file__).parent)],
            capture_output=True,text=True,timeout=20,
            env={'PATH':'/usr/bin:/bin','PYTHONDONTWRITEBYTECODE':'1'})
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout),dict(global_reaped=True,unassigned=True,
                         known_peer_preserved=True,broker_exit=-9))


if __name__=='__main__':unittest.main()
