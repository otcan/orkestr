"""Real worker-thread fork ownership; no provider account or live runtime."""
import json
from pathlib import Path
import subprocess
import sys
import unittest


@unittest.skipUnless(sys.platform == 'linux', 'Linux original pidfd custody')
class ThreadChildrenTests(unittest.TestCase):
    def test_worker_thread_child_retains_original_broker_family_and_is_reaped(self):
        script = r'''
import ctypes,json,os,signal,subprocess,sys,tempfile,time
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,sys.argv[1])
from codex_service.ownership import Children,Process,Adopted
from codex_bounded.trust import process
assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
with tempfile.TemporaryDirectory(prefix='synthetic-thread-child-') as directory:
 root=Path(directory);(root/'codex_service').mkdir();marker=root/'marker.json'
 entry=root/'codex_service/entry.py'
 entry.write_text("import os,signal,subprocess,threading,time,json\nfrom pathlib import Path\n"
  "os.kill(os.getpid(),signal.SIGSTOP)\n"
  "def worker():\n"
  " child=subprocess.Popen(['/usr/bin/sleep','60'])\n"
  " Path("+repr(str(marker))+").write_text(json.dumps({'pid':child.pid,'tid':threading.get_native_id()}))\n"
  " child.wait()\n"
  "threading.Thread(target=worker).start()\ntime.sleep(60)\n")
 package=SimpleNamespace(root=root,uid=os.geteuid())
 owned=Children(package,process(os.getpid()));broker=None;child_proof=None
 peer=subprocess.Popen(['/usr/bin/sleep','60']);peer_identity=process(peer.pid)
 try:
  broker=subprocess.Popen([str(Path('/usr/bin/python3').resolve()),'-I','-S','-B',str(entry),
   'broker','open-owned-session','--protocol','orkestr-v2-provider-broker-v1'],
   stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
   env={'PATH':'/usr/bin:/bin','PYTHONDONTWRITEBYTECODE':'1'})
  identity=process(broker.pid);owned.bind(broker.pid,identity['start'],time.monotonic()+3)
  until=time.monotonic()+3
  while not marker.exists():
   assert time.monotonic()<until;time.sleep(.005)
  data=json.loads(marker.read_text());child=process(data['pid']);child_proof=Process(child)
  leader=Path('/proc',str(broker.pid),'task',str(broker.pid),'children').read_text().split()
  worker=Path('/proc',str(broker.pid),'task',str(data['tid']),'children').read_text().split()
  assert str(child['pid']) not in leader and str(child['pid']) in worker
  owned.observe()
  key=(child['pid'],child['start']);root_key=(identity['pid'],identity['start'])
  assert key in owned.records,'worker-thread child was invisible to custody'
  assert owned.families[key]=={root_key}
  assert (peer.pid,peer_identity['start']) not in owned.records
  assert not owned.uncertain and not owned.forced
  # No new role or inference is inferred. Cleanup must reach this exact child.
  assert owned.cleanup(seconds=2)
  broker.wait(timeout=3)
  assert child_proof.gone()
  assert owned.forced and owned.released()
  assert peer.poll() is None
  # Its original identity was already owned: global orphan discovery is empty.
  pool=Adopted(SimpleNamespace(identity_split=True,executor_uid=65534,
   authority_uid=65533)) if os.geteuid()==0 else None
  if pool is not None:
   try:assert not pool.capture({*owned.records,(peer.pid,peer_identity['start'])})
   finally:pool.close()
  print(json.dumps({'worker_child_owned':True,'original_family_preserved':True,'child_reaped':True}))
 finally:
  if peer.poll() is None:peer.kill()
  peer.wait(timeout=3)
  if child_proof is not None:
   child_proof.send(signal.SIGKILL)
  if broker is not None:
   if broker.poll() is None:broker.kill()
   broker.wait(timeout=3)
  if child_proof is not None:
   until=time.monotonic()+3
   while not child_proof.gone():
    if child_proof.exited():
     try:os.waitid(os.P_PIDFD,child_proof.fd,os.WEXITED|os.WNOHANG)
     except ChildProcessError:pass
    assert time.monotonic()<until;time.sleep(.005)
   child_proof.close()
  owned.close()
'''
        result = subprocess.run(
            [sys.executable, '-I', '-S', '-B', '-c', script, str(Path(__file__).parent)],
            capture_output=True, text=True, timeout=15,
            env={'PATH': '/usr/bin:/bin', 'PYTHONDONTWRITEBYTECODE': '1'},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {
            'worker_child_owned': True, 'original_family_preserved': True, 'child_reaped': True,
        })


if __name__ == '__main__':
    unittest.main()
