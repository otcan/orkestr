"""Disposable ordinary server executable + synthetic peer; never real credentials."""
import hashlib
import json
import os
from pathlib import Path
import select
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
broker = Path(__file__).resolve().parent.parent / "provider-broker"
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


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
        # Prove this exact child owns the requested listener before any HTTP
        # request. An ephemeral-port race must never contact another service.
        expected = (f"orkestr-v2-server schema=1 home={self.home} "
                    f"bind=127.0.0.1:{self.port} execution=").encode()
        pending = bytearray()
        def owned_listener():
            if self.process.poll() is not None:
                raise AssertionError("ordinary server exited before owned-listener readiness")
            if not select.select([self.process.stderr], [], [], 0.05)[0]:
                return False
            chunk = os.read(self.process.stderr.fileno(), 8192)
            assert chunk, "ordinary server stderr closed before readiness"
            pending.extend(chunk)
            assert len(pending) <= 16384, "ordinary server readiness output exceeded bound"
            return any(line.startswith(expected) and line.endswith(b" connections=none")
                       for line in pending.split(b"\n")[:-1])
        wait_for(owned_listener, "child-owned listener readiness deadline")
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
        # Real product broker and FD handoff, fixed synthetic native executable.
        # All of its homes/configuration are disposable and contain no auth file.
        provider = self.root / "synthetic-provider"
        shutil.copyfile(peer, provider)
        provider.chmod(0o700)
        provider_home, provider_tmp = self.root / "provider-home", self.root / "provider-tmp"
        provider_home.mkdir(mode=0o700)
        provider_tmp.mkdir(mode=0o700)
        broker_config = self.root / "broker-private.json"
        broker_config.write_text(json.dumps({"codex_executable": str(provider),
            "codex_home": str(provider_home), "home": str(provider_home),
            "temporary": str(provider_tmp), "workspace": str(self.workspace)}))
        broker_config.chmod(0o600)
        launcher = self.root / "synthetic-launcher"
        launcher.write_text("#!/usr/bin/python3\nimport sys\n"
                            f"sys.path.insert(0, {str(broker)!r})\nfrom server import main\n"
                            f"raise SystemExit(main({str(broker_config)!r}))\n")
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

    def message(self, number=1):
        return self.request(self.path + "/messages", "POST", {
            "client_message_id": f"synthetic:{number}",
            "text": "synthetic ordinary HTTP input" + (f" {number}" if number > 1 else "")})

    def phase(self, expected):
        code, body, _ = self.request(self.path + "/execution")
        return body if code == 200 and body["phase"] == expected else None

    def peer_gone(self):
        pid = self.trace()[0]["pid"]
        try:
            os.kill(pid, 0)
            return False
        except ProcessLookupError:
            return True

    def cleanup(self):
        self.stop()
        if self.trace():
            wait_for(self.peer_gone, "normal shutdown must reap the owned synthetic native peer")
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
    assert not case.peer_gone(), "proposal must retain the owned native child"
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
    assert not case.peer_gone(), "owner acceptance must retain the same native child"
    assert case.request(payload_path, "DELETE")[0] == 204
    assert case.request(payload_path)[1]["text"] is None


def revoked_after_start(case):
    case.stop()
    case.configure()
    case.start(configured=True)
    wait_for(lambda: any(r["kind"] == "ready" for r in case.trace()), "synthetic readiness deadline")
    case.revoke_machine()
    assert case.message()[0] == 202
    wait_for(case.peer_gone, "revocation must reap the owned synthetic peer")
    status = case.request(case.path + "/execution")[1]
    assert status["phase"] == "queued" and status["run_id"] is None
    assert not any(r["kind"] == "turn" for r in case.trace())


def revoked_in_flight(case):
    case.stop()
    case.configure()
    (case.workspace / "hold-first").touch()
    case.start(configured=True)
    assert case.message()[0] == 202
    wait_for(lambda: case.phase("running"), "first synthetic turn must be active")
    assert case.message(2)[0] == 202
    case.revoke_machine()
    wait_for(case.peer_gone, "in-flight revocation must reap the owned synthetic peer")
    assert len([r for r in case.trace() if r["kind"] == "turn"]) == 1
    # Revocation is itself an auth fence. A local kill cannot forge a provider
    # stopped/completed receipt using the now-revoked machine credential.
    with sqlite3.connect(case.home / "core.sqlite3") as db:
        assert db.execute("SELECT count(*) FROM production_runs").fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM reasoning_inbox WHERE state!='consumed'").fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM production_observations WHERE kind IN ('completed_proposal','stopped')").fetchone()[0] == 0
    assert case.request(case.path + "/execution")[1]["phase"] not in ("completed", "cancelled")


def shutdown_with_open_events(case):
    case.stop()
    case.configure()
    (case.workspace / "hold-first").touch()
    case.start(configured=True)
    assert case.message()[0] == 202
    wait_for(lambda: case.phase("running"), "synthetic turn must be active before shutdown")
    request = urllib.request.Request(case.origin + case.path + "/events", headers={
        "Origin": case.origin, "Cookie": case.cookie})
    with opener.open(request, timeout=3) as stream:
        assert stream.status == 200
        # Keep this valid SSE connection open while requesting ordinary shutdown.
        case.process.send_signal(signal.SIGINT)
        assert case.process.wait(timeout=5) == 0
        wait_for(case.peer_gone, "open SSE must not retain the owned native child")
    with sqlite3.connect(case.home / "core.sqlite3") as db:
        assert db.execute("SELECT state FROM production_runs").fetchone()[0] == "cancel_requested"
        assert db.execute("SELECT count(*) FROM production_cancellations").fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM production_observations WHERE kind='stopped'").fetchone()[0] == 0


def main():
    from owned_execution_followup import two_turn, in_flight_followup
    from owned_execution_stop import stop
    for scenario in ["success", "revoked_after_start", "revoked_in_flight", "shutdown_with_open_events",
                     "revoked_at_start", "queued_at_start", "two_turn", "in_flight_followup",
                     "stop_terminal", "stop_ack_only"]:
        case = Case()
        try:
            case.setup()
            if scenario == "success":
                success(case)
            elif scenario == "revoked_after_start":
                revoked_after_start(case)
            elif scenario == "revoked_in_flight":
                revoked_in_flight(case)
            elif scenario == "shutdown_with_open_events":
                shutdown_with_open_events(case)
            elif scenario == "two_turn":
                two_turn(case, wait_for)
            elif scenario == "in_flight_followup":
                in_flight_followup(case, wait_for)
            elif scenario in ("stop_terminal", "stop_ack_only"):
                stop(case, wait_for, scenario == "stop_terminal")
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


if __name__ == "__main__":
    main()
