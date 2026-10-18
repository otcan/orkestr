"""Synthetic HTTP/process acceptance. No provider, credentials or legacy state used."""
import concurrent.futures
from contextlib import closing
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
        with closing(sqlite3.connect((self.home / "core.sqlite3").as_uri() + "?mode=ro", uri=True)) as db, db:
            db.execute("PRAGMA query_only=ON")
            db.execute("BEGIN")
            return [db.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
                    for table in ("messages", "events", "reasoning_inbox", "outbox")]

    def durable_rows(self):
        # Archive durability oracle adapted to intake's one authoritative schema:
        # compare accepted rows and cursor, rather than only aggregate counts.
        with closing(sqlite3.connect((self.home / "core.sqlite3").as_uri() + "?mode=ro", uri=True)) as db, db:
            db.execute("PRAGMA query_only=ON")
            db.execute("BEGIN")
            return {table: db.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall()
                    for table in ("conversations", "messages", "events", "reasoning_inbox", "outbox")}

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
        receipts = []
        for i in range(5):
            code, receipt = self.admit(f"key-{i}", f"Synthetic text {i}")
            self.assertEqual(code, 202, receipt)
            receipts.append(receipt)
        before = self.durable_rows()
        self.stop()
        self.start()
        self.assertEqual(self.durable_rows(), before)
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
        with closing(sqlite3.connect(self.home / "core.sqlite3")) as db, db:
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(db.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            self.assertEqual(db.execute("SELECT sequence FROM reasoning_inbox ORDER BY sequence").fetchall(), [(i,) for i in range(1, 6)])

    def test_rollback_when_inbox_write_fails(self):
        with closing(sqlite3.connect(self.home / "core.sqlite3")) as db, db:
            db.execute("CREATE TRIGGER fail_inbox BEFORE INSERT ON reasoning_inbox BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
        code, error = self.admit()
        self.assertEqual((code, error["code"]), (503, "store_unavailable"))
        self.assertEqual(self.counts(), [0, 0, 0, 0])
        with closing(sqlite3.connect(self.home / "core.sqlite3")) as db, db:
            db.execute("DROP TRIGGER fail_inbox")
        self.assertEqual(self.admit()[1]["sequence"], 1)

    def test_write_failures_preserve_previously_accepted_state(self):
        # Reuses the archive projection-failure invariant, without its store/schema.
        code, first = self.admit("preserved", "Previously accepted synthetic text")
        self.assertEqual(code, 202, first)
        for table in ("events", "reasoning_inbox", "outbox"):
            with self.subTest(failed_insert=table):
                before = self.durable_rows()
                with closing(sqlite3.connect(self.home / "core.sqlite3")) as db, db:
                    db.execute(f"CREATE TRIGGER fail_projection BEFORE INSERT ON {table} "
                               "BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
                try:
                    code, error = self.admit(f"failure-{table}")
                    self.assertEqual((code, error["code"]), (503, "store_unavailable"))
                    self.assertEqual(self.durable_rows(), before)
                finally:
                    with closing(sqlite3.connect(self.home / "core.sqlite3")) as db, db:
                        db.execute("DROP TRIGGER fail_projection")
                self.assertEqual(self.admit("preserved", "Previously accepted synthetic text"),
                                 (200, first))
                code, accepted = self.admit(f"failure-{table}")
                self.assertEqual(code, 202, accepted)
                self.assertEqual(accepted["sequence"], len(before["messages"]) + 1)

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
        with closing(sqlite3.connect(self.home / "core.sqlite3")) as db, db:
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
        with closing(sqlite3.connect(self.home / "core.sqlite3")) as db, db:
            db.execute("UPDATE auth_sessions SET expires_at=0")
        self.assertEqual(self.request("GET", "/projects")[0], 401)

    def browser_request(self, method, path, body=None, cookie=None, csrf=None, headers=None):
        merged = {"Content-Type": "application/json", "Origin": BASE}
        if cookie is not None:
            merged["Cookie"] = cookie
        if csrf is not None:
            merged["x-orkestr-csrf"] = csrf
        for key, value in (headers or {}).items():
            if value is None:
                merged.pop(key, None)
            else:
                merged[key] = value
        request = urllib.request.Request(BASE + "/api/v2" + path, method=method,
            data=None if body is None else json.dumps(body).encode(), headers=merged)
        try:
            response = urllib.request.urlopen(request, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None, response.headers

    def browser_login(self):
        status, data, headers = self.browser_request("POST", "/browser/session", CREDENTIALS)
        self.assertEqual(status, 200, data)
        header = headers["Set-Cookie"]
        self.assertIn("HttpOnly", header)
        self.assertIn("SameSite=Strict", header)
        self.assertIn("Path=/api/v2", header)
        self.assertNotIn("Domain=", header)
        self.assertNotIn("Secure", header)  # synthetic loopback HTTP only
        self.assertNotIn("token", data)  # cookie token never returned in JSON
        return header.split(";", 1)[0], data["csrf_token"]

    def test_browser_cookie_csrf_origin_host_and_logout(self):
        for headers in [{"Origin": None}, {"Origin": "http://foreign.test"},
                        {"Host": "foreign.test"}]:
            self.assertEqual(self.browser_request("POST", "/browser/session", CREDENTIALS,
                                                 headers=headers)[0], 403)
        cookie, csrf = self.browser_login()
        status, _, headers = self.browser_request("GET", "/browser/session", cookie=cookie)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(self.browser_request("GET", "/browser/session", cookie=cookie,
                         headers={"Host": "foreign.test"})[0], 403)
        path = f"/conversations/{self.conversation}/messages"
        message = {"client_message_id": "browser-request", "text": "Synthetic browser input"}
        for supplied, headers in [(None, {}), ("wrong", {}), (csrf, {"Origin": None}),
                                  (csrf, {"Origin": "http://foreign.test"}),
                                  (csrf, {"Host": "foreign.test"})]:
            self.assertEqual(self.browser_request("POST", path, message, cookie, supplied, headers)[0], 403)
        self.assertEqual(self.counts(), [0, 0, 0, 0])
        self.assertEqual(self.browser_request("POST", path, message, cookie, csrf)[0], 202)
        self.assertEqual(self.browser_request("DELETE", "/browser/session", cookie=cookie)[0], 403)
        status, _, headers = self.browser_request("DELETE", "/browser/session", cookie=cookie, csrf=csrf)
        self.assertEqual(status, 204)
        self.assertIn("Max-Age=0", headers["Set-Cookie"])
        self.assertEqual(self.browser_request("GET", "/browser/session", cookie=cookie)[0], 401)
        self.assertEqual(self.browser_request("POST", path, message, cookie, csrf)[0], 401)
        # Browser logout revokes only that cookie session, not the machine session.
        self.assertEqual(self.request("GET", "/projects")[0], 200)

    def test_browser_expiry_rotation_and_machine_separation(self):
        cookie, csrf = self.browser_login()
        raw_token = cookie.split("=", 1)[1]
        self.assertEqual(self.request("GET", "/projects", authenticated=False,
                         headers={"Authorization": "Bearer " + raw_token})[0], 401)
        # A browser namespace prefix must never become machine Bearer authority.
        before = self.counts()
        path = f"/conversations/{self.conversation}/messages"
        status, _ = self.request("POST", path,
                                 {"client_message_id": "prefixed-cookie-bypass", "text": "synthetic"},
                                 authenticated=False,
                                 headers={"Authorization": "Bearer browser:" + raw_token})
        self.assertEqual(status, 401)
        self.assertEqual(self.counts(), before)
        machine_cookie = "orkestr_v2_session=" + self.token
        self.assertEqual(self.browser_request("GET", "/browser/session", cookie=machine_cookie)[0], 401)
        # Successful login rotates and revokes the prior cookie in server storage.
        status, _, headers = self.browser_request("POST", "/browser/session", CREDENTIALS, cookie=cookie)
        self.assertEqual(status, 200)
        new_cookie = headers["Set-Cookie"].split(";", 1)[0]
        self.assertEqual(self.browser_request("GET", "/browser/session", cookie=cookie)[0], 401)
        self.assertEqual(self.browser_request("GET", "/browser/session", cookie=new_cookie)[0], 200)
        self.assertEqual(self.browser_request("GET", "/browser/session", cookie=new_cookie + "; " + new_cookie)[0], 401)
        with closing(sqlite3.connect(self.home / "core.sqlite3")) as db, db:
            db.execute("UPDATE auth_sessions SET expires_at=0")
        self.assertEqual(self.browser_request("GET", "/browser/session", cookie=new_cookie)[0], 401)

    def test_origin_bearing_machine_issuance_and_authority_are_rejected(self):
        with closing(sqlite3.connect(self.home / "core.sqlite3")) as db:
            before = db.execute("SELECT count(*) FROM auth_sessions").fetchone()[0]
        for origin in [BASE, "null", "https://foreign.test"]:
            for path in ["/machine/session", "/session"]:
                status, body = self.request("POST", path, CREDENTIALS, authenticated=False,
                                            headers={"Origin": origin})
                self.assertEqual(status, 403, body)
                self.assertNotIn("token", body)
            self.assertEqual(self.request("GET", "/projects", headers={"Origin": origin})[0], 403)
            self.assertEqual(self.request("POST", f"/conversations/{self.conversation}/messages",
                             {"client_message_id": "origin-machine", "text": "Synthetic"},
                             headers={"Origin": origin})[0], 403)
        self.assertEqual(self.counts(), [0, 0, 0, 0])
        with closing(sqlite3.connect(self.home / "core.sqlite3")) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM auth_sessions").fetchone()[0], before)
        # An explicitly non-browser machine request still obtains and uses Bearer authority.
        status, body = self.request("POST", "/machine/session", CREDENTIALS, authenticated=False)
        self.assertEqual(status, 200, body)
        self.assertEqual(self.request("GET", "/projects", authenticated=False,
                         headers={"Authorization": "Bearer " + body["token"]})[0], 200)


if __name__ == "__main__":
    unittest.main(verbosity=2)
