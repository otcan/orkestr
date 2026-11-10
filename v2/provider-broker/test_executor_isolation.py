"""Actual namespace processes with synthetic secrets, no native provider/auth."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from isolation import ProviderSandbox


class IsolationTests(unittest.TestCase):
    def test_synthetic_stdio_works_without_host_state_or_sibling_proc(self):
        with tempfile.TemporaryDirectory(prefix="provider-isolation-synthetic-") as temporary:
            root=Path(temporary)
            account=root/"canonical-account"; account.mkdir()
            secret=account/"credential-sentinel";secret.write_text("synthetic-canonical-secret")
            project=root/"unrelated-project";project.mkdir()
            state=project/"private-sentinel";state.write_text("synthetic-project-secret")
            fd=os.open(secret,os.O_RDONLY);os.set_inheritable(fd,True)
            sibling=subprocess.Popen([sys.executable,"-I","-c","import time;time.sleep(10)"],
                env={"SYNTHETIC_SIBLING_SECRET":"synthetic-sibling-secret"},close_fds=True)
            source='''import json,os,socket,sys,threading
thread=threading.Thread(target=lambda:None);thread.start();thread.join()
paths=PATHS
blocked=[]
for path in paths:
 try:
  with open(path,"rb") as stream: stream.read(4096)
 except OSError: blocked.append(path)
assert len(blocked)==len(paths),blocked
assert os.listdir("/home")==["provider"]
assert not os.path.exists("/usr/local")
assert "SYNTHETIC_PARENT_SECRET" not in os.environ
assert "SYNTHETIC_SIBLING_SECRET" not in os.environ
assert os.getuid()==EXPECTED_UID
status=dict(line.split(":",1) for line in open("/proc/self/status") if ":" in line)
assert status["NoNewPrivs"].strip()=="1"
assert int(status["CapEff"].strip(),16)==0
for namespace in ("user","pid","net","mnt","ipc","uts","cgroup"):
 assert os.readlink("/proc/self/ns/"+namespace)!=HOST_NAMESPACES[namespace]
import resource
assert resource.getrlimit(resource.RLIMIT_CPU)==(3,3)
assert resource.getrlimit(resource.RLIMIT_NOFILE)==(64,64)
assert all(int(pid)<=2 for pid in os.listdir("/proc") if pid.isdigit())
for descriptor in os.listdir("/proc/self/fd"):
 try:
  target=os.readlink("/proc/self/fd/"+descriptor)
  assert "credential-sentinel" not in target,target
 except FileNotFoundError: pass
for operation in (lambda:socket.socket(),lambda:socket.socketpair(),lambda:os.fork()):
 try: operation()
 except OSError: pass
 else: raise AssertionError("escape primitive allowed")
with open("/work/local","w") as stream:stream.write("disposable")
assert sys.stdin.readline()=="designated synthetic broker input\\n"
print(json.dumps({"blocked":len(blocked),"uid":os.getuid(),"result":"synthetic provider works"}))
'''.replace("PATHS",repr([str(secret),str(state),f"/proc/{sibling.pid}/environ",
                        f"/proc/{sibling.pid}/fd/{fd}",f"/proc/{os.getpid()}/root{secret}"]))
            source=source.replace("EXPECTED_UID",str(os.getuid())).replace("HOST_NAMESPACES",repr({
                name:os.readlink("/proc/self/ns/"+name) for name in ("user","pid","net","mnt","ipc","uts","cgroup")}))
            try:
                os.environ["SYNTHETIC_PARENT_SECRET"]="synthetic-parent-secret"
                with ProviderSandbox().start_python(source) as child:
                    pid=child.pid
                    code,out,err=child.exchange(b"designated synthetic broker input\n")
                self.assertEqual((code,err),(0,b""),out+err)
                self.assertEqual(json.loads(out)["blocked"],5)
                with self.assertRaises(ProcessLookupError):os.kill(pid,0)
                self.assertEqual(secret.read_text(),"synthetic-canonical-secret")
                self.assertEqual(state.read_text(),"synthetic-project-secret")
                self.assertFalse((project/"local").exists())
            finally:
                os.environ.pop("SYNTHETIC_PARENT_SECRET",None)
                os.close(fd)
                sibling.kill();sibling.wait(timeout=2)

    def test_timeout_cancel_and_output_limit_reap_only_owned_children(self):
        cases=[("import time;time.sleep(10)",{"timeout":0.1},TimeoutError),
               ("import time;time.sleep(10)",{"cancelled":lambda:True},InterruptedError),
               ("import sys;sys.stdout.write('x'*10000)",{"max_output":64},BufferError)]
        for source,options,error in cases:
            with self.subTest(error=error.__name__):
                child=ProviderSandbox().start_python(source)
                pid=child.pid
                with self.assertRaises(error):child.exchange(**options)
                with self.assertRaises(ProcessLookupError):os.kill(pid,0)

    def test_runtime_refuses_service_writable_executable(self):
        with tempfile.TemporaryDirectory(prefix="provider-path-synthetic-") as root:
            executable=Path(root)/"native";executable.write_text("fixture");executable.chmod(0o700)
            with self.assertRaises(ValueError):ProviderSandbox().start_codex_offline(executable)
