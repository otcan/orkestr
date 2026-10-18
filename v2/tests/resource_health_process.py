"""Actual isolated server; synthetic login only, owned child cleanup on every path."""
import concurrent.futures
import json
import os
from pathlib import Path
import select
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def run(binary):
    credentials = {"username": "resource-fixture", "password": "synthetic-resource-password"}
    bootstrap = "synthetic-bootstrap-for-resource-probe"
    with tempfile.TemporaryDirectory(prefix="v2-resource-http-") as root:
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL") if key in os.environ}
        env.update(ORKESTR_V2_HOME=str(Path(root) / "state"), ORKESTR_V2_ORIGIN=base,
                   ORKESTR_V2_BIND=f"127.0.0.1:{port}", ORKESTR_V2_BOOTSTRAP_TOKEN=bootstrap)
        process = subprocess.Popen([binary], env=env, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.PIPE)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

        def request(path, body=None, headers=None, method=None):
            request = urllib.request.Request(base + "/api/v2" + path,
                data=None if body is None else json.dumps(body).encode(),
                method=method or ("GET" if body is None else "POST"),
                headers={"Content-Type": "application/json", **(headers or {})})
            try:
                response = opener.open(request, timeout=5)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                raw = response.read()
                return response.status, json.loads(raw) if raw else None, response.headers

        try:
            deadline = time.monotonic() + 10
            output = b""
            # The child emits readiness only after binding. An arbitrary /health
            # responder is not proof that it owns the reserved endpoint.
            while not any(line.startswith(b"orkestr-v2-server ") and
                          f" bind=127.0.0.1:{port} ".encode() in line
                          for line in output.splitlines()):
                assert process.poll() is None, "owned server failed to start; no other occupant touched"
                assert time.monotonic() < deadline, "owned server startup timeout"
                if select.select([process.stderr], [], [], 0.05)[0]:
                    output += os.read(process.stderr.fileno(), 4096)
                    assert len(output) <= 16_384, "unexpected owned startup output"
            assert process.poll() is None
            assert request("/health")[0] == 200
            assert request("/resources")[0] == 401
            assert request("/setup", credentials, {"x-orkestr-bootstrap": bootstrap})[0] == 201
            code, session, _ = request("/machine/session", credentials)
            assert code == 200
            machine = {"Authorization": "Bearer " + session["token"]}
            code, first, headers = request("/resources", headers=machine)
            assert code == 200 and headers["Cache-Control"] == "no-store"
            assert first["schema_version"] == 1 and first["scope"] == "host"
            assert first["sample_sequence"] == 1 and first["cpu"] is None
            expected = "warming_up" if sys.platform.startswith("linux") else "unavailable"
            assert first["availability"] == expected
            with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
                responses = list(pool.map(lambda _: request("/resources", headers=machine), range(10)))
            samples = {(first["instance_id"], first["sample_sequence"]): first}
            for code, body, _ in responses:
                assert code == 200 and body["sample_sequence"] >= first["sample_sequence"]
                assert body["instance_id"] == first["instance_id"]
                identity = (body["instance_id"], body["sample_sequence"])
                assert samples.setdefault(identity, body) == body
            assert request("/resources", headers={**machine, "Origin": base})[0] == 403
            assert request("/resources", headers={"Origin": "https://other.invalid"})[0] == 403
            time.sleep(1.1)
            code, second, _ = request("/resources", headers=machine)
            assert code == 200 and second["sample_sequence"] > first["sample_sequence"]
            assert second["observed_at_ms"] > first["observed_at_ms"]
            if sys.platform.startswith("linux"):
                assert second["availability"] == "ready"
                assert 0 <= second["cpu"]["busy_permille"] <= 1000
                memory = second["memory"]
                assert 0 <= memory["available_bytes"] <= memory["total_bytes"]
                assert memory["used_bytes"] == memory["total_bytes"] - memory["available_bytes"]
            code, browser, headers = request("/browser/session", credentials, {"Origin": base})
            assert code == 200
            cookie = headers["Set-Cookie"].split(";", 1)[0]
            assert request("/resources", headers={"Cookie": cookie})[0] == 200
            assert request("/resources", headers={"Cookie": cookie, **machine})[0] == 401
            assert request("/browser/session", headers={"Cookie": cookie, "Origin": base,
                "x-orkestr-csrf": browser["csrf_token"]}, method="DELETE")[0] == 204
            assert request("/resources", headers={"Cookie": cookie})[0] == 401
            print(json.dumps({"resource_health_http": "passed", "concurrent_readers": 10,
                              "auth_scopes": ["machine", "browser", "revoked", "cross_origin"]}))
        finally:
            if process.poll() is None:
                process.send_signal(signal.SIGINT)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            process.stderr.close()


if __name__ == "__main__":
    run(sys.argv[1])
