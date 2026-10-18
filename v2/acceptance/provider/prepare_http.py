#!/usr/bin/env python3
"""Bootstrap a fresh isolated owner through ordinary HTTP with execution disabled."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import stat
import subprocess
import time
import urllib.error
import urllib.request
import uuid

from verify_package import Refused, exact, require, verify


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def private_write(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as file:
        file.write(value)
        file.flush()
        os.fsync(file.fileno())


def private_directory(path):
    require(path.is_absolute() and path.resolve(strict=True) == path,
            "state_directory_not_canonical")
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid()
            and stat.S_IMODE(info.st_mode) == 0o700, "state_directory_not_private")


class Candidate:
    def __init__(self, server, root):
        self.root = root
        self.child = None
        self.bootstrap = secrets.token_hex(32)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            self.port = listener.getsockname()[1]
        self.origin = f"http://127.0.0.1:{self.port}"
        self.server = server

    def request(self, path, *, method="GET", body=None, headers=None):
        request_headers = dict(headers or {})
        if body is not None:
            request_headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.origin + path, method=method,
                                         headers=request_headers,
                                         data=None if body is None else json.dumps(body).encode())
        # Do not inherit HTTP(S)_PROXY or ambient cookies from this host.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        try:
            response = opener.open(request, timeout=3)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read(256 * 1024 + 1)
            require(len(raw) <= 256 * 1024, "http_response_limit")
            return response.status, (json.loads(raw) if raw else None), response.headers

    def start(self):
        require(self.child is None, "candidate_already_started")
        # No execution opt-in, provider credentials, legacy home or inherited env.
        self.child = subprocess.Popen([self.server], cwd=self.root, env={
            "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
            "ORKESTR_V2_HOME": str(self.root / "data"),
            "ORKESTR_V2_BIND": f"127.0.0.1:{self.port}",
            "ORKESTR_V2_ORIGIN": self.origin,
            "ORKESTR_V2_BOOTSTRAP_TOKEN": self.bootstrap,
        }, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            close_fds=True, start_new_session=True)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            require(self.child.poll() is None, "candidate_start_failed")
            try:
                status, body, _ = self.request("/api/v2/health")
                if status == 200:
                    require(body.get("product") == "orkestr-v2"
                            and body.get("fixture_mode") is False, "ordinary_server_required")
                    return
            except (OSError, urllib.error.URLError):
                pass
            time.sleep(0.05)
        raise Refused("candidate_readiness_timeout")

    def stop(self):
        if self.child is None:
            return
        if self.child.poll() is None:
            os.killpg(self.child.pid, signal.SIGINT)
            try:
                self.child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(self.child.pid, signal.SIGKILL)
                self.child.wait(timeout=5)
        self.child = None


def prepare(manifest_path, root):
    proof = verify(manifest_path)
    manifest = json.loads(Path(manifest_path).read_text())
    private_directory(root)
    expected = {"workspace", "provider-home", "provider-tmp"}
    require({item.name for item in root.iterdir()} == expected, "state_root_not_fresh")
    for name in expected:
        private_directory(root / name)
        require(not any((root / name).iterdir()), "provider_directory_not_empty")
    broker = json.loads(Path(manifest["artifacts"]["broker_config"]["path"]).read_text())
    exact(broker, {"codex_executable", "codex_home", "workspace", "home", "temporary"})
    require(broker["workspace"] == str(root / "workspace")
            and broker["home"] == str(root / "provider-home")
            and broker["temporary"] == str(root / "provider-tmp")
            and broker["codex_executable"] == manifest["artifacts"]["provider_native"]["path"],
            "broker_fixture_scope_mismatch")
    # codex_home is a reviewed reference. Never open its contents or copy auth.
    (root / "data").mkdir(mode=0o700)
    candidate = Candidate(manifest["artifacts"]["server_binary"]["path"], root)
    credentials = {"username": "synthetic-acceptance-owner", "password": secrets.token_hex(32)}
    try:
        candidate.start()
        status, setup, _ = candidate.request("/api/v2/setup", method="POST", body=credentials,
                                             headers={"x-orkestr-bootstrap": candidate.bootstrap})
        require(status == 201, "fresh_http_setup_failed")
        conversation = setup["global_conversation_id"]
        uuid.UUID(conversation)
        status, machine, _ = candidate.request("/api/v2/machine/session", method="POST", body=credentials)
        require(status == 200 and machine["global_conversation_id"] == conversation,
                "machine_session_failed")
        token = machine["token"]
        require(isinstance(token, str) and len(token) == 64
                and all(c in "0123456789abcdef" for c in token), "machine_token_shape")
        status, browser, headers = candidate.request("/api/v2/browser/session", method="POST",
            body=credentials, headers={"Origin": candidate.origin})
        require(status == 200 and browser["global_conversation_id"] == conversation,
                "browser_session_failed")
        cookie = headers.get("Set-Cookie", "").split(";", 1)[0]
        require(cookie.startswith("orkestr_v2_session=") and len(cookie.split("=", 1)[1]) == 64,
                "browser_cookie_shape")
        status, _, _ = candidate.request(f"/api/v2/conversations/{conversation}/execution",
                                         headers={"Cookie": cookie})
        require(status == 204, "fresh_execution_not_absent")
        require(not (root / "data" / "owned-execution").exists(), "unexpected_execution_start")
    finally:
        candidate.stop()
    private_write(root / "machine-token", token + "\n")
    launcher = manifest["artifacts"]["broker_launcher"]
    config = {"schema_version": 1, "mode": "isolated-acceptance-v1",
              "conversation_id": conversation, "machine_token_file": str(root / "machine-token"),
              "launcher": launcher["path"], "launcher_sha256": launcher["sha256"],
              "workspace": str(root / "workspace"), "namespace": "acceptance:" + uuid.uuid4().hex,
              "supervisor_key": "acceptance:" + uuid.uuid4().hex}
    config_bytes = json.dumps(config) + "\n"
    private_write(root / "execution.json", config_bytes)
    # Synthetic login values stay private so an attended authorized continuation
    # can use cookie/CSRF owner acceptance; no account authority is exported.
    private_write(root / "synthetic-session.json", json.dumps({
        "credentials": credentials, "cookie": cookie, "csrf": browser["csrf_token"],
        "bootstrap": candidate.bootstrap, "origin": candidate.origin,
        "conversation_id": conversation}) + "\n")
    receipt = {"schema_version": 1, "status": "prepared_only", "provider_started": False,
               "credentials_read": False, "server_stopped": True,
               "manifest_sha256": proof["manifest_sha256"],
               "execution_config_sha256": hashlib.sha256(config_bytes.encode()).hexdigest(),
               "server_source": proof["server_source"], "broker_source": proof["broker_source"],
               "checks": ["fresh_http_setup", "machine_session", "cookie_session",
                          "execution_absent", "no_owned_execution", "owned_server_stopped"]}
    private_write(root / "prepared.json", json.dumps(receipt, indent=2) + "\n")
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--state-root", required=True)
    args = parser.parse_args()
    def interrupted(_signal, _frame):
        raise Refused("preparation_interrupted")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        result = prepare(args.manifest, Path(args.state_root))
    except Refused as error:
        result = {"status": "refused", "code": str(error)}
    except Exception:
        result = {"status": "refused", "code": "preparation_unavailable_or_invalid"}
    print(json.dumps(result, sort_keys=True))
    return 0 if result["status"] == "prepared_only" else 1


if __name__ == "__main__":
    raise SystemExit(main())
