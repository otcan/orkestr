"""Private bootstrap contract with owned synthetic helper processes only."""
import os
from pathlib import Path
import socket
import subprocess
import sys
import unittest
import uuid
from claude_bootstrap import PREFIX


class BootstrapTests(unittest.TestCase):
    def run_record(self, record, expected, foreign=False):
        parent, child = socket.socketpair()
        # A new process sees the creator as its actual parent. No production FD.
        source='''import sys
sys.path.insert(0,sys.argv[1])
from claude_bootstrap import receive
try:
 spec=receive(object(),int(sys.argv[2]))
 print(str(spec._native))
except Exception:
 print("refused")
 sys.exit(2)
'''
        if foreign:
            # The grandchild inherits the channel, but creator is not its parent.
            source='''import subprocess,sys
result=subprocess.run([sys.executable,"-I","-c",sys.argv[3],sys.argv[1],sys.argv[2]],pass_fds=(int(sys.argv[2]),),capture_output=True)
sys.stdout.buffer.write(result.stdout)
sys.exit(result.returncode)
'''
        inner='''import sys
sys.path.insert(0,sys.argv[1])
from claude_bootstrap import receive
try:
 receive(object(),int(sys.argv[2])); print("accepted")
except Exception:
 print("refused");sys.exit(2)
'''
        process=None
        try:
            process=subprocess.Popen([sys.executable,"-I","-c",source,
                str(Path(__file__).parent.resolve()),str(child.fileno()),inner],
                pass_fds=(child.fileno(),),stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            child.close()
            parent.sendall(record);parent.shutdown(socket.SHUT_WR)
            output,error=process.communicate(timeout=3)
            self.assertEqual(error,b"")
            self.assertEqual(output.strip().decode(),expected)
            self.assertEqual(process.returncode,0 if expected!="refused" else 2)
        finally:
            parent.close();child.close()
            if process is not None and process.poll() is None:
                process.kill();process.wait(timeout=2)

    def test_exact_parent_record_and_eof(self):
        native=str(uuid.uuid4())
        self.run_record(PREFIX+native.encode(),native)

    def test_malformed_extra_or_json_record_refuses(self):
        native=str(uuid.uuid4()).encode()
        for record in (b"",b'{"native":"fake"}',PREFIX+b"x"*36,PREFIX+native+b"x"):
            with self.subTest(record=record):self.run_record(record,"refused")

    def test_inherited_foreign_parent_channel_refuses(self):
        self.run_record(PREFIX+str(uuid.uuid4()).encode(),"refused",foreign=True)
