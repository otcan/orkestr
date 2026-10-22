#!/usr/bin/env python3
"""Linux smoke test of the packaged desktop app (headless, Xvfb + D-Bus).

1. "Installs" the package into a fresh temporary root as a user would get it:
   the .deb is unpacked with dpkg-deb -x (no root needed) or the AppImage
   is copied and made executable.
2. Launches the app with an isolated HOME and XDG directories under
   dbus-run-session and xvfb-run, exactly as a first run on a new account.
3. Waits until the bundled server answers and the WebAssembly UI inside the
   app's webview has booted (its first API call reaches the server).
4. Completes first-run setup with the token the app generated (what the UI
   does with the handed-over token), signs in like the browser does and
   creates a conversation, then lists it back.
5. Quits the app and checks that the server process is gone.

Prints a JSON report including install-to-first-UI time. No network access
is needed; no provider is contacted.
"""
import argparse
import glob
import http.cookiejar
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

IDENTIFIER = "de.orkestr.desktop"


def install(args, root):
    if args.deb:
        subprocess.run(["dpkg-deb", "-x", args.deb, str(root)], check=True)
        return root / "usr" / "bin" / "orkestr"
    target = root / "Orkestr.AppImage"
    shutil.copy2(args.appimage, target)
    target.chmod(0o755)
    return target


def wait_for(predicate, timeout, what):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.1)
    raise TimeoutError(f"timed out waiting for {what}")


class Client:
    def __init__(self, port):
        self.origin = f"http://127.0.0.1:{port}"
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookies))
        self.csrf = ""

    def call(self, method, path, body=None, headers=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.origin + path, data=data, method=method)
        request.add_header("Origin", self.origin)
        request.add_header("Content-Type", "application/json")
        if self.csrf and method not in ("GET", "HEAD"):
            request.add_header("x-orkestr-csrf", self.csrf)
        for name, value in (headers or {}).items():
            request.add_header(name, value)
        try:
            with self.opener.open(request, timeout=10) as response:
                return response.status, json.loads(response.read() or b"null")
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read() or b"null")

    def healthy(self):
        try:
            return self.call("GET", "/api/v2/health")[0] == 200
        except OSError:
            return False


def server_requests(log_dir):
    lines = []
    for path in glob.glob(str(log_dir / "server.log")):
        for line in Path(path).read_text(errors="replace").splitlines():
            if line.startswith("{"):
                try:
                    lines.append(json.loads(line))
                except ValueError:
                    pass
    return lines


def server_pids(executable_dir):
    pids = []
    for entry in Path("/proc").iterdir():
        if entry.name.isdigit():
            try:
                exe = os.readlink(entry / "exe")
            except OSError:
                continue
            if exe.startswith(str(executable_dir)) and "orkestr-v2-server" in exe:
                pids.append(int(entry.name))
    return pids


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--deb")
    group.add_argument("--appimage")
    parser.add_argument("--report", help="write the JSON report here too")
    parser.add_argument("--screenshot", help="save an X window dump (xwd) of the screen here")
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--keep", action="store_true", help="keep the temporary root")
    args = parser.parse_args()

    scratch = Path(tempfile.mkdtemp(prefix="orkestr-desktop-smoke-"))
    root, user = scratch / "install", scratch / "user"
    root.mkdir()
    for sub in ("home", "data", "config", "cache", "state"):
        (user / sub).mkdir(parents=True)
    report = {"package": args.deb or args.appimage}
    t0 = time.monotonic()
    app = install(args, root)
    report["install_s"] = round(time.monotonic() - t0, 2)

    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": str(user / "home"),
        "XDG_DATA_HOME": str(user / "data"),
        "XDG_CONFIG_HOME": str(user / "config"),
        "XDG_CACHE_HOME": str(user / "cache"),
        "XDG_STATE_HOME": str(user / "state"),
        "XDG_RUNTIME_DIR": str(scratch),
        "LANG": "C.UTF-8",
        # Software rendering in Xvfb (no GPU); harmless on real desktops.
        "WEBKIT_DISABLE_DMABUF_RENDERER": "1",
        "LIBGL_ALWAYS_SOFTWARE": "1",
        "APPIMAGE_EXTRACT_AND_RUN": "1",
        "NO_CLEANUP": "1",
        # One log line per request, so the test sees the UI's first API call.
        "ORKESTR_V2_ACCESS_LOG": "all",
    }
    scratch.chmod(0o700)
    read_fd, write_fd = os.pipe()
    xvfb = subprocess.Popen(["Xvfb", "-displayfd", str(write_fd), "-screen", "0", "1280x900x24", "-nolisten", "tcp"],
                            pass_fds=(write_fd,), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.close(write_fd)
    with os.fdopen(read_fd) as display_pipe:
        display = ":" + display_pipe.readline().strip()
    env["DISPLAY"] = display
    app_log = open(scratch / "app.log", "wb")
    process = subprocess.Popen(["dbus-run-session", "--", str(app)], env=env, stdout=app_log,
                               stderr=subprocess.STDOUT, start_new_session=True)
    data_dir = user / "data" / IDENTIFIER
    log_dir = data_dir / "logs"
    ok = False
    try:
        config = wait_for(lambda: (data_dir / "desktop.json").is_file() and json.loads((data_dir / "desktop.json").read_text()),
                          args.timeout, "first-run configuration")
        port = config["port"]
        token = (data_dir / "bootstrap.token").read_text().strip()
        report["first_run_files"] = sorted(p.name for p in data_dir.iterdir())
        report["token_mode"] = oct((data_dir / "bootstrap.token").stat().st_mode & 0o777)
        client = Client(port)
        wait_for(client.healthy, args.timeout, "server health")
        report["server_ready_s"] = round(time.monotonic() - t0, 2)
        # The WebAssembly UI asks for its browser session as soon as it runs.
        wait_for(lambda: any(r.get("route", "").endswith("/browser/session") for r in server_requests(log_dir)),
                 args.timeout, "the UI to boot in the app window")
        report["install_to_first_ui_s"] = round(time.monotonic() - t0, 2)
        report["ui_requests"] = sorted({r.get("route") for r in server_requests(log_dir)})
        if args.screenshot:
            time.sleep(3)  # let the first frame paint
            subprocess.run(["xwd", "-root", "-display", display, "-out", args.screenshot], check=False)

        # First run, as the UI does it with the handed-over token.
        status, body = client.call("GET", "/api/v2/setup", headers={"x-orkestr-bootstrap": token})
        assert (status, body) == (200, {"setup_required": True}), (status, body)
        credentials = {"username": "smoke-owner", "password": "synthetic-smoke-password-1"}
        status, body = client.call("POST", "/api/v2/setup", credentials, {"x-orkestr-bootstrap": token})
        assert status == 201, (status, body)
        status, session = client.call("POST", "/api/v2/browser/session", credentials)
        assert status == 200, (status, session)
        client.csrf = session["csrf_token"]
        status, created = client.call("POST", "/api/v2/conversations",
                                      {"client_request_id": "smoke-1", "name": "Job tracker"})
        assert status == 201, (status, created)
        status, listing = client.call("GET", "/api/v2/conversations")
        assert status == 200 and "Job tracker" in json.dumps(listing), (status, listing)
        status, body = client.call("GET", "/api/v2/setup", headers={"x-orkestr-bootstrap": token})
        assert body == {"setup_required": False}, body
        report["conversation_created"] = True
        report["setup_to_conversation_s"] = round(time.monotonic() - t0 - report["install_to_first_ui_s"], 2)
        ok = True
    finally:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        app_log.close()
        xvfb.terminate()
        xvfb.wait()
        time.sleep(1)
        leftovers = server_pids(root)
        report["server_left_running"] = bool(leftovers)
        for pid in leftovers:
            os.kill(pid, signal.SIGKILL)
        if not ok:
            sys.stderr.write((scratch / "app.log").read_text(errors="replace")[-4000:])
            for path in glob.glob(str(log_dir / "server.log")):
                sys.stderr.write(Path(path).read_text(errors="replace")[-4000:])
        report["ok"] = ok and not leftovers
        if not args.keep:
            shutil.rmtree(scratch, ignore_errors=True)
    text = json.dumps(report, indent=2)
    print(text)
    if args.report:
        Path(args.report).write_text(text + "\n")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
