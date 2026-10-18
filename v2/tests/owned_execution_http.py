"""Disposable ordinary server executable + synthetic peer; never real credentials."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

binary = Path(sys.argv[1]).resolve(strict=True)
peer = Path(__file__).with_name("owned_execution_peer.py").resolve(strict=True)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def wait_for(operation, description, seconds=8):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = operation()
        if value:
            return value
        time.sleep(0.025)
    raise AssertionError(description)


class Case:
    def __init__(self):
        self.temp = tempfile.TemporaryDirectory(prefix="v2-owned-http-")
        self.root = Path(self.temp.name)
        self.home = self.root / "data"
        self.workspace = self.root / "workspace"
        for path in [self.home, self.workspace]:
            path.mkdir(mode=0o700)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]
        self.origin = f"http://127.0.0.1:{self.port}"
        self.process = None
        self.cookie = None
        self.csrf = None
        self.bootstrap = "synthetic-bootstrap-token-ordinary-http-only"

    def request(self, path, method="GET", body=None, browser=True, extra=None):
        headers = {}
        if browser:
            headers["Origin"] = self.origin
            if self.cookie:
                headers.update({"Cookie": self.cookie, "x-orkestr-csrf": self.csrf})
        headers.update(extra or {})
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        request = urllib.request.Request(self.origin + path, headers=headers, data=data, method=method)
        try:
            reply = opener.open(request, timeout=3)
        except urllib.error.HTTPError as error:
            reply = error
        with reply:
            raw = reply.read()
            return reply.status, json.loads(raw) if raw else None, reply.headers

    def start(self, configured=False, refused=False):
        environment = {"PATH": "/usr/local/bin:/usr/bin:/bin", "ORKESTR_V2_HOME": str(self.home),
                       "ORKESTR_V2_BIND": f"127.0.0.1:{self.port}", "ORKESTR_V2_ORIGIN": self.origin,
                       "ORKESTR_V2_BOOTSTRAP_TOKEN": self.bootstrap}
        if configured:
            environment["ORKESTR_V2_EXECUTION_CONFIG"] = str(self.root / "execution.json")
        self.process = subprocess.Popen([str(binary)], env=environment, stdout=subprocess.DEVNULL,
                                        stderr=subprocess.PIPE, text=True)
        if refused:
            assert self.process.wait(timeout=6) != 0
            assert not (self.workspace / "synthetic-peer.jsonl").exists()
            assert not (self.home / "owned-execution").exists()
            return
        def healthy():
            if self.process.poll() is not None:
                raise AssertionError("ordinary server startup failed: " + self.process.stderr.read())
            try:
                return self.request("/api/v2/health", browser=False)[0] == 200
            except (urllib.error.URLError, TimeoutError):
                return False
        wait_for(healthy, "ordinary server health deadline")

    def setup(self):
        self.start()
        credentials = {"username": "synthetic-owner", "password": "synthetic-password-ordinary-http"}
        code, body, _ = self.request("/api/v2/setup", "POST", credentials, False,
                                    {"x-orkestr-bootstrap": self.bootstrap})
        assert code == 201
        self.conversation = body["global_conversation_id"]
        code, body, _ = self.request("/api/v2/machine/session", "POST", credentials, False)
        assert code == 200
        self.machine = body["token"]
        code, body, headers = self.request("/api/v2/browser/session", "POST", credentials)
        assert code == 200
        self.cookie = headers["Set-Cookie"].split(";", 1)[0]
        self.csrf = body["csrf_token"]
        self.path = f"/api/v2/conversations/{self.conversation}"
        assert self.request(self.path + "/execution")[0] == 204
        assert not (self.home / "owned-execution").exists()

    def stop(self):
        if self.process is not None:
            if self.process.poll() is None:
                self.process.send_signal(signal.SIGINT)
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=3)
            self.process.stderr.close()
            self.process = None

    def configure(self):
        launcher = self.root / "synthetic-launcher"
        shutil.copyfile(peer, launcher)
        launcher.chmod(0o700)
        token = self.root / "machine.token"
        token.write_text(self.machine)
        token.chmod(0o600)
        config = {"schema_version": 1, "mode": "isolated-acceptance-v1",
                  "conversation_id": self.conversation, "machine_token_file": str(token),
                  "launcher": str(launcher), "launcher_sha256": hashlib.sha256(launcher.read_bytes()).hexdigest(),
                  "workspace": str(self.workspace), "namespace": "synthetic:local",
                  "supervisor_key": "synthetic-http"}
        file = self.root / "execution.json"
        file.write_text(json.dumps(config))
        file.chmod(0o600)

    def trace(self):
        path = self.workspace / "synthetic-peer.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def revoke_machine(self):
        # This is the test's newly created disposable database, never host state.
        with sqlite3.connect(self.home / "core.sqlite3") as db:
            db.execute("DELETE FROM auth_sessions WHERE token_hash=?",
                       (hashlib.sha256(self.machine.encode()).hexdigest(),))

    def message(self):
        return self.request(self.path + "/messages", "POST", {
            "client_message_id": "synthetic:1", "text": "synthetic ordinary HTTP input"})

    def cleanup(self):
        self.stop()
        self.temp.cleanup()


def success(case):
    case.stop()
    case.configure()
    case.start(configured=True)
    assert case.message()[0] == 202
    def proposed():
        code, body, _ = case.request(case.path + "/execution")
        return body if code == 200 and body["phase"] == "awaiting_acceptance" else None
    status = wait_for(proposed, "durable provider proposal deadline")
    assert status["capabilities"] == {"stop": False, "steer": False}
    payload_path = case.path + "/payloads/" + status["progress"]["payload_id"]
    code, payload, headers = case.request(payload_path)
    assert code == 200 and headers["Cache-Control"] == "no-store"
    assert payload["text"] == "synthetic progress <untrusted>"
    assert len([row for row in case.trace() if row["kind"] == "turn"]) == 1
    stop = {"run_id": status["run_id"], "expected_revision": status["revision"], "request_key": "stop:1"}
    assert case.request(case.path + "/stop", "POST", stop)[0] == 503
    assert case.request(case.path + "/execution")[1]["revision"] == status["revision"]
    request = urllib.request.Request(case.origin + case.path + "/events", headers={
        "Origin": case.origin, "Cookie": case.cookie})
    with opener.open(request, timeout=3) as stream:
        for line in stream:
            if line.startswith(b"data: "):
                event = json.loads(line[6:])
                observation = event["payload_ref_or_safe_payload"].get("observation", {})
                if observation.get("kind") == "completed_proposal":
                    completion = event["event_id"]
                    break
    accept = {"run_id": status["run_id"], "completion_event_id": completion,
              "expected_revision": status["revision"], "request_key": "accept:1"}
    assert case.request(case.path + "/accept", "POST", dict(accept, expected_revision=status["revision"]-1))[0] == 409
    code, receipt, _ = case.request(case.path + "/accept", "POST", accept)
    assert code == 200 and receipt["outcome"] == "succeeded"
    assert case.request(case.path + "/accept", "POST", accept)[:2] == (200, receipt)
    assert case.request(case.path + "/execution")[1]["phase"] == "completed"
    assert case.request(payload_path, "DELETE")[0] == 204
    assert case.request(payload_path)[1]["text"] is None


def revoked_after_start(case):
    case.stop()
    case.configure()
    case.start(configured=True)
    wait_for(lambda: any(r["kind"] == "ready" for r in case.trace()), "synthetic readiness deadline")
    case.revoke_machine()
    assert case.message()[0] == 202
    def peer_gone():
        pid = case.trace()[0]["pid"]
        try:
            os.kill(pid, 0)
            return False
        except ProcessLookupError:
            return True
    wait_for(peer_gone, "revocation must reap the owned synthetic peer")
    status = case.request(case.path + "/execution")[1]
    assert status["phase"] == "queued" and status["run_id"] is None
    assert not any(r["kind"] == "turn" for r in case.trace())


for scenario in ["success", "revoked_after_start", "revoked_at_start", "queued_at_start"]:
    case = Case()
    try:
        case.setup()
        if scenario == "success":
            success(case)
        elif scenario == "revoked_after_start":
            revoked_after_start(case)
        else:
            if scenario == "queued_at_start":
                assert case.message()[0] == 202
            case.stop()
            case.configure()
            if scenario == "revoked_at_start":
                case.revoke_machine()
            case.start(configured=True, refused=True)
        print("ordinary synthetic HTTP case passed:", scenario)
    finally:
        case.cleanup()
