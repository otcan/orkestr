"""Synthetic HTTP/process acceptance. No provider, credentials or legacy state used."""
import concurrent.futures
import json
import os
from pathlib import Path
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

BINARY = sys.argv.pop(1)
PORT = int(os.environ.get("ORKESTR_V2_TEST_PORT", "47110"))
BASE = f"http://127.0.0.1:{PORT}"
BOOTSTRAP = "synthetic-bootstrap-for-offline-tests-only"
CREDENTIALS = {"username": "fixture-owner", "password": "synthetic-password-for-tests"}


class IntakeAcceptance(unittest.TestCase):
    def setUp(self):
        parent = os.environ["ORKESTR_V2_HOME"]
        Path(parent).mkdir(parents=True, exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(prefix="intake-", dir=parent)
        self.home = Path(self.directory.name)
        self.token = None
        self.process = None
        self.start()
        status, setup = self.request("POST", "/setup", CREDENTIALS, bootstrap=True)
        self.assertEqual(status, 201, setup)
        self.conversation = setup["global_conversation_id"]
        status, session = self.request("POST", "/session", CREDENTIALS)
        self.assertEqual(status, 200, session)
        self.token = session["token"]

    def start(self):
        # Never kill another occupant of this lane's reserved port.
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", PORT)) == 0:
                raise AssertionError("reserved test port already occupied")
        env = dict(os.environ, ORKESTR_V2_HOME=str(self.home), ORKESTR_V2_BIND=f"127.0.0.1:{PORT}",
                   ORKESTR_V2_BOOTSTRAP_TOKEN=BOOTSTRAP)
        self.process = subprocess.Popen([BINARY], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        for _ in range(100):
            if self.process.poll() is not None:
                raise AssertionError(self.process.stderr.read().decode())
            try:
                status, _ = self.request("GET", "/health", authenticated=False)
                if status == 200:
                    return
            except (urllib.error.URLError, ConnectionError):
                time.sleep(0.05)
        raise AssertionError("server did not become healthy")

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.kill()  # SIGKILL, no SQLite close/checkpoint or graceful shutdown.
            self.process.wait(timeout=5)
        if self.process and self.process.stderr:
            self.process.stderr.close()

    def tearDown(self):
        self.stop()
        self.directory.cleanup()

    def request(self, method, path, body=None, authenticated=True, bootstrap=False, headers=None):
        merged = {"Content-Type": "application/json"}
        if authenticated and self.token:
            merged["Authorization"] = f"Bearer {self.token}"
        if bootstrap:
            merged["x-orkestr-bootstrap"] = BOOTSTRAP
        merged.update(headers or {})
        request = urllib.request.Request(BASE + "/api/v2" + path, method=method,
            data=None if body is None else json.dumps(body).encode(), headers=merged)
        try:
            response = urllib.request.urlopen(request, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def admit(self, key="fixture-1", text="Synthetic local request"):
        return self.request("POST", f"/conversations/{self.conversation}/messages",
                            {"client_message_id": key, "text": text})

    def counts(self):
        with sqlite3.connect(self.home / "core.sqlite3") as db:
            return [db.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
                    for table in ("messages", "events", "reasoning_inbox", "outbox")]

    def test_concurrent_duplicate_and_body_conflict(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
            results = list(pool.map(lambda _: self.admit(), range(10)))
        self.assertEqual(sum(code == 202 for code, _ in results), 1)
        self.assertEqual(sum(code == 200 for code, _ in results), 9)
        self.assertTrue(all(body == results[0][1] for _, body in results))
        self.assertEqual(self.counts(), [1, 1, 1, 1])
        code, error = self.admit(text="Conflicting content")
        self.assertEqual((code, error["code"]), (409, "idempotency_conflict"))
        self.assertEqual(self.counts(), [1, 1, 1, 1])

    def test_kill_after_receipt_reopen_and_replay(self):
        receipts = [self.admit(f"key-{i}", f"Synthetic text {i}")[1] for i in range(5)]
        self.stop()
        self.start()
        code, snapshot = self.request("GET", f"/conversations/{self.conversation}?limit=2")
        self.assertEqual(code, 200)
        self.assertEqual(snapshot["last_sequence"], 5)
        self.assertEqual(snapshot["next_cursor"], 2)
        messages = snapshot["messages"]
        code, page = self.request("GET", f"/conversations/{self.conversation}?after=2&limit=100")
        messages += page["messages"]
        self.assertEqual([m["message_id"] for m in messages], [r["message_id"] for r in receipts])
        self.assertEqual([m["text"] for m in messages], [f"Synthetic text {i}" for i in range(5)])
        self.assertEqual(self.counts(), [5, 5, 5, 5])
        code, receipt = self.admit("key-0", "Synthetic text 0")
        self.assertEqual((code, receipt), (200, receipts[0]))
        with sqlite3.connect(self.home / "core.sqlite3") as db:
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(db.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            self.assertEqual(db.execute("SELECT sequence FROM reasoning_inbox ORDER BY sequence").fetchall(), [(i,) for i in range(1, 6)])

    def test_rollback_when_inbox_write_fails(self):
        with sqlite3.connect(self.home / "core.sqlite3") as db:
            db.execute("CREATE TRIGGER fail_inbox BEFORE INSERT ON reasoning_inbox BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
        code, error = self.admit()
        self.assertEqual((code, error["code"]), (503, "store_unavailable"))
        self.assertEqual(self.counts(), [0, 0, 0, 0])
        with sqlite3.connect(self.home / "core.sqlite3") as db:
            db.execute("DROP TRIGGER fail_inbox")
        self.assertEqual(self.admit()[1]["sequence"], 1)

    def test_auth_origin_spoofing_and_scope_rejection(self):
        for method, path, body in [("GET", "/projects", None), ("GET", f"/conversations/{self.conversation}", None),
                ("GET", f"/conversations/{self.conversation}/events", None),
                ("POST", f"/conversations/{self.conversation}/messages", {"client_message_id": "x", "text": "hi"})]:
            self.assertEqual(self.request(method, path, body, authenticated=False)[0], 401)
        self.assertEqual(self.request("POST", "/setup", CREDENTIALS, bootstrap=True)[0], 409)
        self.assertEqual(self.request("POST", "/setup", CREDENTIALS)[0], 401)
        self.assertEqual(self.request("GET", "/projects", headers={"Origin": "https://untrusted.example"})[0], 403)
        self.assertEqual(self.request("POST", f"/conversations/{self.conversation}/messages",
            {"client_message_id": "x", "text": "spoof", "actor_kind": "owner", "owner_id": "fake"})[0], 400)
        self.assertEqual(self.request("GET", "/conversations/00000000-0000-4000-8000-000000000000")[0], 404)
        self.assertEqual(self.request("POST", "/session", dict(CREDENTIALS, password="wrong-but-long-enough"))[0], 401)
        self.assertEqual(self.counts(), [0, 0, 0, 0])

    def test_projects_are_local_idempotent_and_paginated(self):
        body = {"client_request_id": "project-1", "name": "Synthetic local project"}
        code, project = self.request("POST", "/projects", body)
        self.assertEqual(code, 201)
        self.assertEqual(project["resources"], {"local_git": "not_provisioned", "local_oxrm": "unverified"})
        self.assertEqual(self.request("POST", "/projects", body), (200, project))
        self.assertEqual(self.request("POST", "/projects", dict(body, name="changed"))[0], 409)
        self.assertEqual(self.request("POST", "/projects", dict(body, client_request_id="project-2"))[0], 201)
        _, page = self.request("GET", "/projects?limit=1")
        self.assertEqual(len(page["projects"]), 1)
        _, second = self.request("GET", f'/projects?after={page["next_cursor"]}&limit=1')
        self.assertEqual(len(second["projects"]), 1)
        self.assertIsNone(second["next_cursor"])
        with sqlite3.connect(self.home / "core.sqlite3") as db:
            self.assertEqual(db.execute("SELECT count(*) FROM conversations WHERE project_id=?", (project["project_id"],)).fetchone()[0], 1)
        self.assertEqual(self.request("POST", f'/conversations/{project["conversation_id"]}/messages',
            {"client_message_id": "fixture-1", "text": "project scope"})[0], 202)
        self.assertEqual(self.admit()[0], 202)  # Same key in another scope is independent.

    def test_sse_cursor_replay_and_invalid_cursor(self):
        for i in range(3):
            self.assertEqual(self.admit(f"sse-{i}")[0], 202)
        request = urllib.request.Request(BASE + f"/api/v2/conversations/{self.conversation}/events",
            headers={"Authorization": f"Bearer {self.token}", "Last-Event-ID": "1"})
        events = []
        with urllib.request.urlopen(request, timeout=5) as response:
            while len(events) < 2:
                line = response.readline().decode().strip()
                if line.startswith("data:"):
                    events.append(json.loads(line[5:]))
        self.assertEqual([e["sequence"] for e in events], [2, 3])
        self.assertNotIn("text", json.dumps(events))
        code, error = self.request("GET", f"/conversations/{self.conversation}/events?after=99")
        self.assertEqual((code, error["code"]), (409, "resync_required"))
        self.assertEqual(self.request("GET", f"/conversations/{self.conversation}?after=-1")[0], 400)

    def test_limits_and_session_expiry(self):
        self.assertEqual(self.admit(text="x" * 32769)[0], 400)
        self.assertEqual(self.admit(key="bad key")[0], 400)
        self.assertEqual(self.admit(text=" " * 10)[0], 400)
        self.assertEqual(self.counts(), [0, 0, 0, 0])
        with sqlite3.connect(self.home / "core.sqlite3") as db:
            db.execute("UPDATE auth_sessions SET expires_at=0")
        self.assertEqual(self.request("GET", "/projects")[0], 401)


if __name__ == "__main__":
    unittest.main(verbosity=2)
