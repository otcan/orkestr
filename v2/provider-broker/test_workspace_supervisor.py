"""Owned synthetic process proof only, not a cgroup or sandbox qualification."""
import json
from pathlib import Path
import subprocess
import sys
import unittest


class WorkspaceSubreaperTests(unittest.TestCase):
    def test_actual_double_fork_is_reaped_before_original_status_returns(self):
        # The isolated supervisor process substitutes only the fixed bwrap
        # launcher with an owned synthetic fork fixture. No provider/auth/config.
        source = r'''
import importlib.util,json,os,sys,tempfile,socket,struct
spec=importlib.util.spec_from_file_location("owned_supervisor",sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
child = """
import json,os,time
print(json.dumps({'pid':os.getpid(),'kind':'launcher'}),flush=True)
pid=os.fork()
if pid==0:
 os.setsid()
 pid=os.fork()
 if pid==0:
  print(json.dumps({'pid':os.getpid(),'kind':'grandchild'}),flush=True)
  time.sleep(.08)
  os._exit(0)
 os._exit(0)
os.waitpid(pid,0)
os._exit(19)
"""
m.arguments=lambda *args:[sys.executable,"-I","-S","-B","-c",child]
with tempfile.TemporaryDirectory(prefix="workspace-subreaper-") as root:
 observe,notify=socket.socketpair()
 fds=[os.open(root+"/policy",os.O_RDWR|os.O_CREAT,0o600),
      os.open(root,os.O_RDONLY|os.O_DIRECTORY),
      os.open(root,os.O_RDONLY|os.O_DIRECTORY),
      os.open(root+"/synthetic-cgroup-procs",os.O_WRONLY|os.O_CREAT,0o600),notify.detach()]
 status=m.run([*(str(fd) for fd in fds),"--","synthetic command"])
 assert status==19
 assert observe.recv(6)==b"RD"+struct.pack("!i",19)
 try: os.waitpid(-1,os.WNOHANG)
 except ChildProcessError: print(json.dumps({'reaped':True,'status':status}),flush=True)
 else: raise AssertionError("original descendant not reaped")
'''
        helper = Path(__file__).with_name("workspace_exec_supervisor.py")
        child = subprocess.run([sys.executable, "-I", "-S", "-B", "-c", source, str(helper)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5, check=False)
        self.assertEqual(child.returncode, 0, child.stderr.decode())
        rows = [json.loads(line) for line in child.stdout.splitlines()]
        self.assertEqual(rows[-1], {"reaped": True, "status": 19})
        self.assertEqual({row["kind"] for row in rows[:-1]}, {"launcher", "grandchild"})
        self.assertTrue(all(not Path(f"/proc/{row['pid']}").exists() for row in rows[:-1]))

    def test_unknown_operation_refuses_before_spawning(self):
        helper = Path(__file__).with_name("workspace_exec_supervisor.py")
        result = subprocess.run([sys.executable, "-I", "-S", "-B", str(helper), "arbitrary"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=2, check=False)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (125, b"", b""))
