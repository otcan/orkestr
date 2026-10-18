"""Run subreaper checks in disposable subprocesses, never adopt test-runner children."""
import subprocess
import sys
import unittest
from pathlib import Path


class ReapingTests(unittest.TestCase):
    def check_case(self, escape):
        source = '''import os,subprocess,sys,time
from reaping import become_subreaper,reap_owned
become_subreaper()
code = "import os,time;pid=os.fork();" + ("os.setsid() if pid==0 else None;" if ESCAPE else "") + "time.sleep(0.4)"
child=subprocess.Popen([sys.executable,'-c',code],process_group=0)
time.sleep(.1)
result=reap_owned(child,timeout=.05)
assert result is (not ESCAPE),result
if ESCAPE:
 time.sleep(.5)
 while True:
  try: os.waitpid(-1,0)
  except ChildProcessError: break
'''.replace('ESCAPE', repr(escape))
        result = subprocess.run([sys.executable, '-c', source],
                                cwd=Path(__file__).parent, capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_abrupt_broker_death_closes_escaped_native_tree(self):
        source = r'''import os,subprocess,sys,select,signal
from reaping import become_subreaper
become_subreaper()
# The broker starts its lifetime wrapper, then waits without a cleanup handler.
broker_code = """import subprocess,sys
from reaping import contained_command
native = "import os,time;os.fork();os.setsid();print('ready',flush=True);time.sleep(60)"
child=subprocess.Popen(contained_command([sys.executable,'-c',native]),process_group=0)
child.wait()
"""
broker=subprocess.Popen([sys.executable,'-c',broker_code],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
assert select.select([broker.stdout],[],[],3)[0]
assert os.read(broker.stdout.fileno(),128).startswith(b'ready')
os.kill(broker.pid,signal.SIGKILL)
assert broker.wait(timeout=3)==-signal.SIGKILL
# Every descendant inherited stdout. EOF proves no escaped writer remains.
end=__import__('time').monotonic()+3
while True:
 assert select.select([broker.stdout],[],[],max(0,end-__import__('time').monotonic()))[0]
 if not os.read(broker.stdout.fileno(),128):break
while True:
 try:
  pid,status=os.waitpid(-1,os.WNOHANG)
 except ChildProcessError:break
 if pid==0:
  assert __import__('time').monotonic()<end
  __import__('time').sleep(.005)
broker.stdout.close();broker.stderr.close()
'''
        result=subprocess.run([sys.executable,'-c',source],cwd=Path(__file__).parent,
                              capture_output=True,timeout=8)
        self.assertEqual(result.returncode,0,result.stderr)

    def test_native_group_and_adopted_descendant_reaped(self):
        self.check_case(False)

    def test_escaped_living_descendant_refuses_proof(self):
        self.check_case(True)
