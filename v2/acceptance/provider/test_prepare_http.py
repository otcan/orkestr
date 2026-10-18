"""Harness lifecycle oracle, not an Orkestr product or provider acceptance test."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest

import test_verify_package as package_fixture
from prepare_http import prepare

SERVER = r'''#!/usr/bin/python3
import json, os
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
root = Path.cwd()
class Handler(BaseHTTPRequestHandler):
 def log_message(self, *_args): pass
 def do_GET(self): self.reply()
 def do_POST(self): self.reply()
 def reply(self):
  size = int(self.headers.get('Content-Length', '0'))
  if size: self.rfile.read(size)
  with (root / 'requests.jsonl').open('a') as file:
   file.write(json.dumps({'method':self.command, 'path':self.path}) + '\n')
  code, body, headers = 200, {}, {}
  conversation = '11111111-1111-4111-8111-111111111111'
  if self.path == '/api/v2/health': body = {'product':'orkestr-v2','fixture_mode':False}
  elif self.path == '/api/v2/setup': code, body = 201, {'global_conversation_id':conversation}
  elif self.path == '/api/v2/machine/session': body = {'token':'ab'*32,'global_conversation_id':conversation}
  elif self.path == '/api/v2/browser/session':
   body = {'csrf_token':'cd'*32,'global_conversation_id':conversation}
   headers = {'Set-Cookie':'orkestr_v2_session=' + 'ef'*32 + '; HttpOnly'}
  elif self.path.endswith('/execution'): code, body = 204, None
  else: code = 500
  raw = b'' if body is None else json.dumps(body).encode()
  self.send_response(code)
  for key, value in headers.items(): self.send_header(key, value)
  self.send_header('Content-Length', str(len(raw)))
  self.end_headers()
  self.wfile.write(raw)
(root / 'env-names.json').write_text(json.dumps(sorted(os.environ)))
(root / 'server.pid').write_text(str(os.getpid()))
host, port = os.environ['ORKESTR_V2_BIND'].split(':')
try: HTTPServer((host,int(port)),Handler).serve_forever()
except KeyboardInterrupt: pass
'''


@unittest.skipUnless(os.geteuid() == 0 and Path("/opt").is_dir(),
                     "immutable-manifest preparation fixture requires root and /opt")
class PreparationTests(unittest.TestCase):
    def test_disabled_http_bootstrap_never_opts_in_or_admits_and_reaps_child(self):
        fixture = package_fixture.PackageTests("test_protected_complete_package_proves_only_metadata")
        fixture.setUp()
        try:
            with tempfile.TemporaryDirectory(prefix="v2-http-prepare-test-") as temporary:
                root = Path(temporary)
                for name in ("workspace", "provider-home", "provider-tmp"):
                    (root / name).mkdir(mode=0o700)
                def artifact(name, text):
                    entry = fixture.manifest["artifacts"][name]
                    path = Path(entry["path"])
                    path.write_text(text)
                    entry["sha256"] = hashlib.sha256(text.encode()).hexdigest()
                artifact("server_binary", SERVER)
                artifact("broker_config", json.dumps({
                    "codex_executable": fixture.manifest["artifacts"]["provider_native"]["path"],
                    "codex_home": str(root / "unused-account-reference"),
                    "workspace": str(root / "workspace"), "home": str(root / "provider-home"),
                    "temporary": str(root / "provider-tmp")}))
                fixture.save()
                receipt = prepare(fixture.path, root)
                self.assertEqual(receipt["status"], "prepared_only")
                self.assertFalse(receipt["provider_started"])
                self.assertTrue(receipt["server_stopped"])
                requests = [json.loads(line) for line in (root / "requests.jsonl").read_text().splitlines()]
                self.assertEqual([r["path"] for r in requests if r["method"] == "POST"],
                                 ["/api/v2/setup", "/api/v2/machine/session", "/api/v2/browser/session"])
                names = json.loads((root / "env-names.json").read_text())
                self.assertEqual(names, sorted(["PATH", "LANG", "LC_ALL", "ORKESTR_V2_HOME",
                    "ORKESTR_V2_BIND", "ORKESTR_V2_ORIGIN", "ORKESTR_V2_BOOTSTRAP_TOKEN"]))
                self.assertFalse((root / "unused-account-reference").exists())
                for name in ("execution.json", "machine-token", "synthetic-session.json", "prepared.json"):
                    self.assertEqual((root / name).stat().st_mode & 0o777, 0o600)
                config = json.loads((root / "execution.json").read_text())
                self.assertEqual(config["machine_token_file"], str(root / "machine-token"))
                self.assertEqual(config["mode"], "isolated-acceptance-v1")
                with self.assertRaises(ProcessLookupError):
                    os.kill(int((root / "server.pid").read_text()), 0)
        finally:
            fixture.tearDown()


if __name__ == "__main__":
    unittest.main()
