"""Actual dedicated subprocess path, with a synthetic executable only."""
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import tempfile
import time
import unittest
from protocol import PROTOCOL, encode
from test_protocol import IDENTITY, turn

FAKE = r'''#!/usr/bin/python3
import json, os, sys
from pathlib import Path
Path(__file__).with_name("inspection.json").write_text(json.dumps({"pid":os.getpid(), "argv":sys.argv[1:], "env":sorted(os.environ)}))
for line in sys.stdin:
 v=json.loads(line)
 if v.get("method")=="initialize":
  print(json.dumps({"id":v["id"],"result":{"userAgent":"synthetic","platformFamily":"unix","platformOs":"linux","codexHome":os.environ["CODEX_HOME"]}}),flush=True)
 elif v.get("method")=="account/read":
  print(json.dumps({"id":v["id"],"result":{"requiresOpenaiAuth":True,"account":{"type":"chatgpt"}}}),flush=True)
 elif v.get("method")=="thread/start":
  cwd=str(Path(__file__).with_name("workspace"))
  print(json.dumps({"id":v["id"],"result":{"thread":{"id":"synthetic-native","ephemeral":False,"cwd":cwd},"cwd":cwd,"approvalPolicy":"never","sandbox":{"type":"readOnly","networkAccess":False}}}),flush=True)
 elif v.get("method")=="turn/start":
  with Path(__file__).with_name("turns.txt").open("a") as output: output.write("one-turn\n")
  print(json.dumps({"id":v["id"],"result":{"turn":{"id":"synthetic-turn","status":"inProgress"}}}),flush=True)

'''


class ServerTests(unittest.TestCase):
    def test_owned_subprocess_fixed_config_and_eof_cleanup(self):
        self.owned_case(False)

    def test_full_owned_session_and_duplicate_turn_has_no_retry(self):
        self.owned_case(True)

    def owned_case(self, commit):
        with tempfile.TemporaryDirectory(prefix="provider-broker-synthetic-") as root:
            root = Path(root).resolve()
            for name in ["configuration.py", "protocol.py", "transport.py", "server.py"]:
                shutil.copy(Path(__file__).with_name(name), root / name)
            for name in ["account", "workspace", "home", "tmp"]:
                (root / name).mkdir()
            fake = root / "fake-codex"
            fake.write_text(FAKE)
            fake.chmod(0o700)
            config = {"codex_executable": str(fake), "codex_home": str(root / "account"),
                      "workspace": str(root / "workspace"), "home": str(root / "home"), "temporary": str(root / "tmp")}
            (root / "broker-private.json").write_text(json.dumps(config))
            child = subprocess.Popen(["/usr/bin/python3", str(root / "server.py"),
                "open-owned-session", "--protocol", PROTOCOL], stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            buffer = b""
            def receive():
                nonlocal buffer
                deadline = time.monotonic() + 5
                while b"\n" not in buffer:
                    self.assertGreater(deadline, time.monotonic(), "synthetic peer timeout")
                    readable, _, _ = select.select([child.stdout], [], [], max(0, deadline-time.monotonic()))
                    self.assertTrue(readable)
                    raw = os.read(child.stdout.fileno(), 65536)
                    self.assertTrue(raw, "unexpected broker EOF")
                    buffer += raw
                line, buffer = buffer.split(b"\n", 1)
                return json.loads(line)
            try:
                child.stdin.write(encode({"id": 1, "method": "OpenOwnedSession", "params": {
                    "protocol": PROTOCOL, "identity": IDENTITY}})); child.stdin.flush()
                handle = receive()["result"]["owned_handle"]
                child.stdin.write(encode({"id": 2, "method": "BrokerMetadata", "params": {"owned_handle": handle,
                    "frame": {"id": 1, "method": "initialize", "params": {
                    "clientInfo": {"name": "synthetic", "title": "Synthetic", "version": "1"},
                    "capabilities": {"experimentalApi": False}}}}})); child.stdin.flush()
                response = receive()
                self.assertEqual(response["result"]["frame"]["result"]["codexHome"], "broker-private")
                self.assertNotIn(str(root / "account"), str(response))
                inspection = json.loads((root / "inspection.json").read_text())
                self.assertEqual(inspection["argv"], ["app-server", "--listen", "stdio://"])
                self.assertEqual(inspection["env"], sorted(["PATH", "LANG", "LC_ALL", "HOME", "TMPDIR", "CODEX_HOME"]))
                if commit:
                    def send(outer, frame, method="BrokerMetadata"):
                        child.stdin.write(encode({"id":outer,"method":method,"params":{
                            "owned_handle":handle,"frame":frame}})); child.stdin.flush()
                        return receive()
                    send(3, {"method":"initialized"})
                    send(4, {"id":2,"method":"account/read","params":{"refreshToken":False}})
                    send(5, {"id":3,"method":"thread/start","params":{
                        "cwd":str(root / "workspace"),"approvalPolicy":"never","sandbox":"read-only","ephemeral":False}})
                    reply = send(6, turn(), "CommitExecution")
                    self.assertEqual(reply["result"]["frame"]["result"]["turn"]["id"], "synthetic-turn")
                    child.stdin.write(encode({"id":7,"method":"CommitExecution","params":{
                        "owned_handle":handle,"frame":turn()}})); child.stdin.flush()
                    self.assertEqual(child.wait(timeout=5), 2)
                    self.assertEqual((root / "turns.txt").read_text(), "one-turn\n")
                    child.stdin.close()
                else:
                    child.stdin.close()
                    self.assertEqual(child.wait(timeout=5), 0)
                with self.assertRaises(ProcessLookupError):
                    os.kill(inspection["pid"], 0)  # observation only; never signals
            finally:
                if child.returncode is None:
                    child.terminate()
                    try:
                        child.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        child.kill(); child.wait(timeout=3)
                child.stdout.close(); child.stderr.close()


if __name__ == "__main__":
    unittest.main()
