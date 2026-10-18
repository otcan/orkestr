"""Independent probes for core intake. Synthetic owned processes and data only."""
import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request


class IntakeProbes(unittest.TestCase):
    binary = None
    parent = None
    port = 47140

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="independent-", dir=self.parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "candidate"
        self.home.mkdir()
        self.bootstrap = secrets.token_hex(32)
        self.password = secrets.token_hex(16)
        self.token = None
        self.process = None
        self.addCleanup(self.stop)
        self.start()
        status, setup = self.call("POST", "/setup", {"username": "synthetic-owner", "password": self.password},
                                  {"x-orkestr-bootstrap": self.bootstrap})
        self.assertEqual(status, 201)
        self.conversation = setup["global_conversation_id"]
        status, session = self.call("POST", "/session", {"username": "synthetic-owner", "password": self.password})
        self.assertEqual(status, 200)
        self.token = session["token"]

    def launch(self, home, extra=None):
        with socket.socket() as probe:
            self.assertNotEqual(probe.connect_ex(("127.0.0.1", self.port)), 0, "port occupied")
        env = {k: os.environ[k] for k in ("PATH", "LANG") if k in os.environ}
        env.update(ORKESTR_V2_HOME=str(home), ORKESTR_V2_BIND=f"127.0.0.1:{self.port}",
                   ORKESTR_V2_BOOTSTRAP_TOKEN=self.bootstrap)
        env.update(extra or {})
        return subprocess.Popen([self.binary], env=env, cwd=self.root, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL)

    def start(self):
        self.process = self.launch(self.home)
        for _ in range(100):
            self.assertIsNone(self.process.poll(), "candidate exited before readiness")
            try:
                if self.call("GET", "/health")[0] == 200:
                    return
            except (urllib.error.URLError, ConnectionError):
                time.sleep(0.05)
        self.fail("candidate readiness timeout")

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.kill()
            self.process.wait(timeout=5)

    def call(self, method, path, body=None, headers=None):
        merged = {"Content-Type": "application/json"}
        if self.token:
            merged["Authorization"] = "Bearer " + self.token
        merged.update(headers or {})
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/api/v2" + path,
              data=None if body is None else json.dumps(body).encode(), headers=merged, method=method)
        try:
            response = urllib.request.urlopen(req, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def admit(self, text="Synthetic request"):
        return self.call("POST", f"/conversations/{self.conversation}/messages",
                         {"client_message_id": "same-request", "text": text})

    def counts(self):
        uri = (self.home / "core.sqlite3").as_uri() + "?mode=ro"
        with sqlite3.connect(uri, uri=True) as db:
            db.execute("PRAGMA query_only=ON")
            db.execute("BEGIN")
            counts = tuple(db.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
                           for table in ("messages", "events", "reasoning_inbox", "outbox"))
            db.execute("COMMIT")
            return counts

    def test_receipt_concurrency_conflict_and_restart(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
            receipts = list(pool.map(lambda _: self.admit(), range(10)))
        self.assertEqual(sorted(code for code, _ in receipts), [200] * 9 + [202])
        self.assertTrue(all(body == receipts[0][1] for _, body in receipts))
        self.assertEqual(self.counts(), (1, 1, 1, 1))
        self.assertEqual(self.admit("Changed request")[0], 409)
        self.stop()
        self.start()
        self.assertEqual(self.admit(), (200, receipts[0][1]))
        self.assertEqual(self.counts(), (1, 1, 1, 1))
        _, snapshot = self.call("GET", f"/conversations/{self.conversation}")
        self.assertEqual([m["message_id"] for m in snapshot["messages"]], [receipts[0][1]["message_id"]])

    def test_spoof_origin_and_cookie_have_no_authority(self):
        path = f"/conversations/{self.conversation}/messages"
        self.assertEqual(self.call("POST", path, {"client_message_id": "spoof", "text": "Synthetic",
                             "actor_kind": "owner"})[0], 400)
        self.assertEqual(self.call("POST", path, {"client_message_id": "foreign", "text": "Synthetic"},
                             {"Origin": "https://foreign.example"})[0], 403)
        token, self.token = self.token, None
        self.assertEqual(self.call("GET", "/projects", headers={"Cookie": "session=" + token})[0], 401)
        self.assertEqual(self.counts(), (0, 0, 0, 0))

    def assert_alias_refused(self, legacy):
        def files(directory):
            # Include existence, link identity and bytes, including WAL/SHM.
            return {p.name: (os.readlink(p) if p.is_symlink() else None, p.read_bytes())
                    for p in directory.iterdir()}

        target = self.root / "symlink-candidate"
        target.mkdir()
        (target / "core.sqlite3").symlink_to(legacy / "core.sqlite3")
        before = (files(legacy), files(target))
        self.process = self.launch(target, {"ORKESTR_HOME": str(legacy)})
        exited = True
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            exited = False
        # Capture before killing the child or closing the synthetic WAL writer:
        # cleanup must not checkpoint/delete sidecars and conceal a mutation.
        during = (files(legacy), files(target))
        self.stop()
        after = (files(legacy), files(target))
        self.assertEqual(during, before, "startup mutated database/sidecars before cleanup")
        self.assertEqual(after, before, "child cleanup changed database/sidecars")
        self.assertTrue(exited, "server accepted database symlink into legacy home")
        self.assertNotEqual(self.process.returncode, 0)

    def test_database_symlink_into_legacy_is_refused_without_mutation(self):
        self.stop()
        legacy = self.root / "legacy-synthetic"
        legacy.mkdir()
        (legacy / "core.sqlite3").touch()
        self.assert_alias_refused(legacy)

    def test_live_wal_database_alias_is_refused_without_sidecar_mutation(self):
        self.stop()
        legacy = self.root / "legacy-wal-synthetic"
        legacy.mkdir()
        with sqlite3.connect(legacy / "core.sqlite3") as writer:
            self.assertEqual(writer.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
            writer.execute("PRAGMA wal_autocheckpoint=0")
            writer.execute("CREATE TABLE synthetic_legacy(value TEXT)")
            writer.execute("INSERT INTO synthetic_legacy VALUES ('preserve')")
            writer.commit()
            self.assertTrue((legacy / "core.sqlite3-wal").exists())
            self.assertTrue((legacy / "core.sqlite3-shm").exists())
            self.assert_alias_refused(legacy)

    def test_sse_header_cursor_precedes_query_cursor(self):
        first = self.admit()[1]
        status, second = self.call("POST", f"/conversations/{self.conversation}/messages",
                                  {"client_message_id": "second", "text": "Synthetic second"})
        self.assertEqual(status, 202)
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/api/v2/conversations/{self.conversation}/events?after=99",
            headers={"Authorization": "Bearer " + self.token, "Last-Event-ID": str(first["sequence"])})
        with urllib.request.urlopen(req, timeout=5) as response:
            self.assertEqual(response.status, 200)
            for _ in range(20):
                line = response.readline().decode().strip()
                if line.startswith("data:"):
                    event = json.loads(line[5:])
                    break
            else:
                self.fail("missing replay event")
        self.assertEqual(event["event_id"], second["event_id"])
        self.assertEqual(event["sequence"], second["sequence"])
        self.assertNotIn("text", event["payload_ref_or_safe_payload"])
        self.assertEqual(self.call("GET", f"/conversations/{self.conversation}/events?after=99")[0], 409)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--port", type=int, default=47140, choices=range(47140, 47150))
    args = parser.parse_args()
    if not args.home.is_absolute() or not args.binary.is_absolute():
        parser.error("binary and isolated home must be absolute")
    args.home.mkdir(parents=True, exist_ok=True)
    IntakeProbes.binary, IntakeProbes.parent, IntakeProbes.port = str(args.binary), args.home, args.port
    unittest.main(argv=[__file__], verbosity=2)
