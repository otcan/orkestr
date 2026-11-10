import ctypes
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from dataclasses import replace

from isolation.bounded_budget import Budget, Context, Limits, Refused
from isolation.bounded_dns import resolve, validated


class ResolverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bounded-dns-test-")
        self.addCleanup(self.temp.cleanup)
        self.client, self.peer = socket.socketpair()
        self.addCleanup(self.client.close);self.addCleanup(self.peer.close)
        self.context = Context(self.client, Budget(replace(Limits(), setup_seconds=.3)))
        self.children = []

    def helper(self, body):
        path = Path(self.temp.name) / "resolver.py"
        directory = str(Path(__file__).parent / "isolation")
        path.write_text("import sys,os,time,socket\nsys.path.insert(0," + repr(directory) + ")\n"
            "import bounded_dns\n" + body + "\n")
        return path

    def observe(self, child):
        self.children.append(child)

    def assert_reaped(self):
        self.assertTrue(self.children)
        for child in self.children:
            self.assertIsNotNone(child.returncode)
            self.assertFalse(Path('/proc', str(child.pid)).exists())

    def test_fixed_child_has_no_inherited_environment_or_socket_authority(self):
        helper = self.helper(
            "assert set(os.environ)<= {'PATH','LANG','LC_CTYPE'}\n"
            "for n in range(3,256):\n"
            " try:os.fstat(n)\n"
            " except OSError:continue\n"
            " raise AssertionError('extra inherited descriptor')\n"
            "socket.getaddrinfo=lambda *a,**kw:[(2,1,6,'',('93.184.216.34',443))]\n"
            "raise SystemExit(bounded_dns.child_main())")
        addresses=resolve(self.context,"fixture.example",helper,self.observe)
        self.assertEqual(addresses,[(2,1,6,('93.184.216.34',443))])
        self.assert_reaped()

    def test_blocked_resolver_deadline_kills_and_reaps_child(self):
        helper=self.helper("socket.getaddrinfo=lambda *a,**kw:time.sleep(30)\n"
            "raise SystemExit(bounded_dns.child_main())")
        started=time.monotonic()
        with self.assertRaises(Refused):resolve(self.context,"fixture.example",helper,self.observe)
        self.assertLess(time.monotonic()-started,1.5)
        self.assert_reaped()

    def test_explicit_cancellation_joins_resolver_without_waiting_for_dns(self):
        helper=self.helper("socket.getaddrinfo=lambda *a,**kw:time.sleep(30)\n"
            "raise SystemExit(bounded_dns.child_main())")
        ready=threading.Event();outcomes=[]
        def observe(child):self.observe(child);ready.set()
        def work():
            try:resolve(self.context,"fixture.example",helper,observe)
            except Refused:outcomes.append('cancelled')
        worker=threading.Thread(target=work);worker.start()
        self.assertTrue(ready.wait(2));self.context.close();worker.join(2)
        self.assertFalse(worker.is_alive());self.assertEqual(outcomes,['cancelled']);self.assert_reaped()

    def test_malformed_and_oversize_responses_are_refused_and_reaped(self):
        for payload in ("b'not-json'", "b'x'*9000"):
            with self.subTest(payload=payload):
                helper=self.helper("sys.stdout.buffer.write("+payload+");sys.stdout.flush();time.sleep(.01)")
                with self.assertRaises(Refused):resolve(self.context,"fixture.example",helper,self.observe)
                self.assert_reaped()

    def test_all_answers_must_be_public_and_structurally_valid(self):
        public=[2,1,6,"",["93.184.216.34",443]]
        for bad in ([2,1,6,"",["127.0.0.1",443]], [2,1,6,"",["10.0.0.1",443]],
                    [10,1,6,"",["93.184.216.34",443,0,0]], [2,1,6,"",["93.184.216.34",80]]):
            with self.assertRaises((Refused,ValueError)):validated([public,bad])
        with self.assertRaises(Refused):validated([public]*17)

    def test_actual_parent_death_kills_owned_resolver_and_test_reaps_it(self):
        libc=ctypes.CDLL(None,use_errno=True);previous=ctypes.c_int()
        self.assertEqual(libc.prctl(37,ctypes.byref(previous),0,0,0),0)
        self.assertEqual(libc.prctl(36,1,0,0,0),0)
        helper=self.helper("socket.getaddrinfo=lambda *a,**kw:time.sleep(30)\n"
            "raise SystemExit(bounded_dns.child_main())")
        receipt=Path(self.temp.name)/'child-pid'
        code=("import sys,socket;from pathlib import Path;sys.path.insert(0,"+repr(str(Path(__file__).parent))+");"
            "from isolation.bounded_budget import Budget,Context;from isolation.bounded_dns import resolve;"
            "a,b=socket.socketpair();resolve(Context(a,Budget()),'fixture.example',"+repr(str(helper))+","
            "lambda p:Path("+repr(str(receipt))+").write_text(str(p.pid)))")
        parent=subprocess.Popen([sys.executable,'-I','-B','-c',code],env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'},
            stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True)
        child_pid=None
        try:
            deadline=time.monotonic()+2
            while not receipt.exists() and time.monotonic()<deadline:time.sleep(.005)
            self.assertTrue(receipt.exists());child_pid=int(receipt.read_text())
            parent.kill();parent.wait(timeout=2)
            deadline=time.monotonic()+2
            while time.monotonic()<deadline:
                pid,_=os.waitpid(child_pid,os.WNOHANG)
                if pid:break
                time.sleep(.005)
            else:self.fail('parent-death resolver was not reaped')
            self.assertFalse(Path('/proc',str(child_pid)).exists());child_pid=None
        finally:
            if parent.poll() is None:parent.kill();parent.wait(timeout=2)
            if child_pid is not None:
                try:os.kill(child_pid,signal.SIGKILL);os.waitpid(child_pid,0)
                except ProcessLookupError:pass
            libc.prctl(36,previous.value,0,0,0)


if __name__=='__main__':unittest.main()
