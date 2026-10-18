#!/usr/bin/env python3
"""Opt-in local acceptance against an already-built server; standard library only."""
import argparse
import importlib
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

PENDING = (
    "PENDING conversation-to-result: server admits messages but has no execution loop/result route.\n"
    "PENDING run/cancel: no HTTP routes or CLI commands implemented.\n"
    "PENDING UI acceptance: candidate supports an optional static bundle; real UI checks unexecuted.\n"
    "PENDING Docker: no v2 image/Dockerfile/Compose packaging supplied.\n"
    "UNEXECUTED macOS/Docker acceptance: must be performed on the owner's local machine."
)


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def overlap(a, b):
    return a == b or a in b.parents or b in a.parents


def filesystem_disjoint(candidate, protected_paths):
    """Fail closed until the Linux filesystem identity guard proves isolation."""
    candidate = Path(candidate).resolve()
    protected_paths = [Path(path).resolve() for path in protected_paths]
    require(all(not overlap(candidate, path) for path in protected_paths),
            "destination overlaps protected source, package, repository or legacy home")
    require(sys.platform == "linux",
            "filesystem identity isolation unsupported on this platform; Linux required, macOS pending")
    try:
        guard = importlib.import_module("path_identity")
    except ImportError as error:
        raise RuntimeError("filesystem identity guard unavailable; install/package path_identity.py before proceeding") from error
    # PathIdentityError/PathOverlapError are RuntimeError; preserve their diagnostics.
    return guard.assert_disjoint(candidate, protected_paths)


def preflight(binary, home, port, environ=None):
    """Read-only except a transient loopback bind; never create homes or run binaries."""
    environ = os.environ if environ is None else environ
    require(sys.version_info >= (3, 11), "Python 3.11+ is required")
    raw = Path(home)
    require(raw.is_absolute(), "--home must be absolute")
    require(not raw.exists() and not raw.is_symlink(), "--home must not exist (including symlinks)")
    home = raw.resolve()
    require(home.parent.is_dir(), "--home parent must already exist")
    require(os.access(home.parent, os.W_OK | os.X_OK), "--home parent must be writable")
    # Refuse overlap with this checkout as well as any explicitly configured legacy home.
    protected = [Path(__file__).resolve().parents[2]]
    if environ.get("ORKESTR_HOME"):
        legacy = Path(environ["ORKESTR_HOME"])
        require(legacy.is_absolute() and legacy.is_dir(), "ORKESTR_HOME must name an existing absolute directory")
        protected.append(legacy.resolve())
    home = filesystem_disjoint(home, protected)
    binary = Path(binary).resolve()
    require(binary.is_file() and os.access(binary, os.X_OK), "--binary must be an existing executable; build separately")
    home = filesystem_disjoint(home, [binary])
    require(1024 <= port <= 65535, "--port must be between 1024 and 65535")
    try:
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", port))
    except OSError as error:
        raise RuntimeError("loopback port unavailable; choose another port (no occupant will be stopped)") from error
    return binary, home


def environment(home, port):
    # Do not inherit connector credentials, provider config, or legacy sessions.
    env = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "TMPDIR") if key in os.environ}
    env.update(HOME=str(home), ORKESTR_V2_HOME=str(home),
               ORKESTR_V2_BIND=f"127.0.0.1:{port}",
               ORKESTR_V2_BOOTSTRAP_TOKEN=secrets.token_urlsafe(48))
    return env


class Client:
    def __init__(self, port):
        self.base = f"http://127.0.0.1:{port}/api/v2"
        self.token = None
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(self, method, path, body=None, bootstrap=None, authenticated=True):
        headers = {"Content-Type": "application/json"}
        if self.token and authenticated:
            headers["Authorization"] = f"Bearer {self.token}"
        if bootstrap:
            headers["x-orkestr-bootstrap"] = bootstrap
        request = urllib.request.Request(self.base + path, method=method, headers=headers,
            data=None if body is None else json.dumps(body).encode())
        try:
            response = self.opener.open(request, timeout=2)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def health(self):
        status, body = self.request("GET", "/health", authenticated=False)
        require(status == 200 and body.get("status") == "ok" and
                body.get("product") == "orkestr-v2" and body.get("fixture_mode") is False,
                "health response does not identify the real v2 intake server")


def stop(process):
    if process.poll() is None:
        process.send_signal(signal.SIGINT)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()  # Only the process created by this helper, never a PID file.
            process.wait(timeout=5)


def start(binary, home, env, client):
    # Log stays private and contains no HTTP credential payloads.
    with (home / "server.log").open("ab") as log:
        process = subprocess.Popen([str(binary)], env=env, stdout=log, stderr=log)
    try:
        for _ in range(100):
            require(process.poll() is None, "server exited; inspect private server.log")
            try:
                client.health()
                require(process.poll() is None, "server exited during health check")
                return process
            except (urllib.error.URLError, ConnectionError, TimeoutError):
                time.sleep(0.1)
        raise RuntimeError("server health deadline exceeded; inspect private server.log")
    except BaseException:
        stop(process)
        raise


def smoke(client, bootstrap):
    """Only call on a fresh helper-owned home; creates synthetic local administrator."""
    credentials = {"username": "fixture-owner", "password": secrets.token_urlsafe(32)}
    status, _ = client.request("GET", "/projects", authenticated=False)
    require(status == 401, "unauthenticated project access was not rejected")
    status, _ = client.request("POST", "/setup", credentials, bootstrap="synthetic-invalid-token")
    require(status == 401, "invalid bootstrap was not rejected")
    status, setup = client.request("POST", "/setup", credentials, bootstrap=bootstrap)
    require(status == 201, "fresh setup failed")
    status, session = client.request("POST", "/session", credentials)
    require(status == 200 and session.get("token_type") == "Bearer", "session creation failed")
    client.token = session["token"]
    conversation = setup["global_conversation_id"]
    require(session["global_conversation_id"] == conversation, "session scope mismatch")
    path = f"/conversations/{conversation}"
    message = {"client_message_id": "local-install-fixture-1", "text": "Synthetic local acceptance message"}
    status, receipt = client.request("POST", path + "/messages", message)
    require(status == 202 and receipt.get("status") == "accepted", "message admission failed")
    require(client.request("POST", path + "/messages", message) == (200, receipt), "duplicate receipt mismatch")
    verify_history(client, path, receipt, message)
    return path, receipt, message


def verify_history(client, path, receipt, message):
    status, history = client.request("GET", path)
    require(status == 200, "history unavailable")
    require(any(m.get("message_id") == receipt["message_id"] and m.get("text") == message["text"]
                for m in history["messages"]), "accepted message missing from history")


def run(args):
    binary, home = preflight(args.binary, args.home, args.port)
    if args.command == "preflight":
        print("PASS read-only preflight: executable, fresh isolated home, loopback port")
        print(PENDING)
        return
    # Atomic mkdir refuses concurrent creation; no existing state is adopted or deleted.
    home.mkdir(mode=0o700)
    env = environment(home, args.port)
    client = Client(args.port)
    process = None
    try:
        process = start(binary, home, env, client)
        if args.command == "launch":
            print("PASS health; foreground server running. Ctrl-C stops this child; data retained.", flush=True)
            print(PENDING, flush=True)
            require(process.wait() == 0, "server exited unsuccessfully; inspect private server.log")
        else:
            path, receipt, message = smoke(client, env["ORKESTR_V2_BOOTSTRAP_TOKEN"])
            stop(process)
            process = start(binary, home, env, client)
            verify_history(client, path, receipt, message)
            require(client.request("POST", path + "/messages", message) == (200, receipt),
                    "receipt not durable across restart")
            print("PASS synthetic auth, admission, duplicate receipt, history, stop/restart persistence")
            print(PENDING)
    finally:
        if process is not None:
            stop(process)
        print("Helper child stopped; private home retained. Review it before manual removal.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("preflight", "launch", "smoke"))
    parser.add_argument("--binary", required=True, help="already-built orkestr-v2-server executable")
    parser.add_argument("--home", required=True, help="absolute nonexistent isolated directory")
    parser.add_argument("--port", type=int, required=True, help="explicit isolated lane/local port")
    args = parser.parse_args()
    try:
        run(args)
    except KeyboardInterrupt:
        return 130
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
