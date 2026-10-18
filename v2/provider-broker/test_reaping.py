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

    def test_native_group_and_adopted_descendant_reaped(self):
        self.check_case(False)

    def test_escaped_living_descendant_refuses_proof(self):
        self.check_case(True)
