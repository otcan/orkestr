"""Disposable selected-service package with real Rust HTTP and fixed native ELF.

Explicit root fixture only. Every account/state path is freshly owned here;
there is no host account lookup, provider network request or installed service.
"""
from contextlib import closing
import json
import os
from pathlib import Path
import signal
import socket
import sqlite3
import subprocess
import sys

import owned_execution_http as ordinary
from owned_native_probe import descendants, process_start
from selected_codex_roles_case import SelectedNativeProbe

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "v2/provider-broker"))
from codex_service_fixture import ServiceFixture, UID, GID, packager
from codex_service.package import Package, ROLE_FILES
from codex_bounded.trust import digest


class PackageFixture(ServiceFixture):
    def _server(self):
        packager.write(self.package / "server", ordinary.binary.read_bytes(), GID, 0o550)


class ServiceRolesCase:
    request = ordinary.Case.request

    def __init__(self, source, quota_used=None):
        # Optional synthetic Codex five-hour usage (percent): the package then
        # configures a quota projection the parallel Deep gate reads.
        self.quota_used = quota_used
        assert os.geteuid() == 0, "explicit root synthetic fixture required"
        self.fixture = PackageFixture()
        f = self.fixture
        f.source = source
        self.root, self.home = f.root, f.home / "data"
        self.port = f.plan["port"]
        self.origin = f"http://127.0.0.1:{self.port}"
        self.process = self.server_pid = None
        self.cookie = self.csrf = None
        self.bootstrap = "b" * 64
        self.known, self.probes, self.workspaces, self.accounts = {}, {}, {}, {}
        self.logs, self.forced = [], False
        self.receipt = None

    def spawn(self, argv, env, *, dropped=False, label):
        log = (self.root / (label + ".log")).open("xb")
        self.logs.append(log)
        self.process = subprocess.Popen(argv, env=env, cwd="/", stdin=subprocess.DEVNULL,
            stdout=log, stderr=log, **({"user": UID, "group": GID, "extra_groups": []} if dropped else {}))
        self.known[self.process.pid, process_start(self.process.pid)] = "root"

    def observe(self):
        if self.process is None or self.process.poll() is not None:
            return
        for pid in {self.process.pid, *descendants(self.process.pid)}:
            start = process_start(pid)
            if start is not None:
                self.known[pid, start] = "owned"

    def listener(self, executable):
        assert self.process.poll() is None, "owned child exited before readiness"
        self.observe()
        expected = executable.stat()
        matches = []
        for pid, start in self.known:
            if process_start(pid) != start:
                continue
            path = Path("/proc") / str(pid)
            try:
                actual = (path / "exe").stat()
                if (actual.st_dev, actual.st_ino) != (expected.st_dev, expected.st_ino):
                    continue
                sockets = {os.readlink(fd)[8:-1] for fd in (path / "fd").iterdir()
                           if os.readlink(fd).startswith("socket:[")}
                for line in (path / "net/tcp").read_text().splitlines()[1:]:
                    fields = line.split()
                    if fields[1] == f"0100007F:{self.port:04X}" and fields[3] == "0A" and fields[9] in sockets:
                        matches.append(pid)
            except (FileNotFoundError, ProcessLookupError):
                continue
        assert len(matches) <= 1, "ambiguous owned listener"
        if matches:
            self.server_pid = matches[0]
            return True
        return False

    def setup(self):
        f = self.fixture
        server = self.root / "bootstrap-server"
        packager.write(server, ordinary.binary.read_bytes(), GID, 0o550)
        env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": str(f.home / "provider-home"),
               "ORKESTR_V2_HOME": str(self.home), "ORKESTR_V2_BIND": f"127.0.0.1:{self.port}",
               "ORKESTR_V2_ORIGIN": self.origin, "ORKESTR_V2_BOOTSTRAP_TOKEN": self.bootstrap}
        self.spawn([str(server)], env, dropped=True, label="bootstrap")
        ordinary.wait_for(lambda: self.listener(server), "owned bootstrap listener")
        credentials = {"username": "synthetic-owner", "password": "synthetic-window-roles-only"}
        code, body, _ = self.request("/api/v2/setup", "POST", credentials, False,
                                    {"x-orkestr-bootstrap": self.bootstrap})
        assert code == 201, (code, body)
        self.conversation = body["global_conversation_id"]
        code, body, headers = self.request("/api/v2/browser/session", "POST", credentials)
        assert code == 200, code
        self.owner = body["owner_id"]
        self.cookie, self.csrf = headers["Set-Cookie"].split(";", 1)[0], body["csrf_token"]
        self.stop()
        f.owner, f.plan["conversation_id"] = self.owner, self.conversation
        f.write_private(f.auth, b'{"fixture":"synthetic-roles-only"}\n')
        subprocess.run(["cc", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
            str(Path(__file__).with_name("service_roles_native.c")), "-o", str(f.server)],
            check=True, env={"PATH": "/usr/bin:/bin"}, capture_output=True, timeout=15)
        f.server.chmod(0o555)
        self.receipt = f.prepare()
        self.workspaces["deep"], self.accounts["deep"] = f.workspace, f.account
        beta = json.loads((f.package / "beta.json").read_bytes())
        profile = json.loads((f.package / "profile.json").read_bytes())
        roles = {"workers": []}
        for role in ("fast", "worker-0", "worker-1", "worker-2", "worker-3"):
            workspace, account = f.directory(role + "-workspace"), f.directory(role + "-account")
            self.workspaces[role], self.accounts[role] = workspace, account
            launcher = f.package / ("launcher-" + role + ".py")
            script = '#!/bin/sh\nexec ' + str(Path('/usr/bin/python3').resolve()) + ' -I -S -B "$(dirname -- "$0")/codex_service/entry.py" broker-' + role + ' "$@"\n'
            packager.write(launcher, script.encode(), GID, 0o550)
            packager.write(f.package / ("profile-" + role + ".json"), packager.encoded({**profile,
                "workspace": str(workspace), "state_root": str(account)}), GID)
            value = {"launcher": str(launcher), "launcher_sha256": digest(launcher), "workspace": str(workspace)}
            if role == "fast":
                roles["fast"] = value
            else:
                roles["workers"].append(value)
        beta["roles"] = roles
        # Two live windows: a third conversation must queue durably, then start.
        beta["max_active_windows"] = 2
        (f.package / "beta.json").write_bytes(packager.encoded(beta))
        (f.package / "beta.json").chmod(0o640)
        changed = {*ROLE_FILES, "beta.json"}
        if self.quota_used is not None:
            self.quota = f.directory("codex-quota")
            self.write_quota(self.quota_used)
            service = json.loads((f.package / "service.json").read_bytes())
            service["codex_quota_projection"] = {"directory": str(self.quota),
                                                 "account_ref": "00000000-0000-4000-8000-0000000000aa"}
            (f.package / "service.json").write_bytes(packager.encoded(service))
            (f.package / "service.json").chmod(0o640)
            changed.add("service.json")
        manifest = json.loads((f.package / "manifest.json").read_bytes())
        manifest["files"].update({name: digest(f.package / name) for name in changed})
        (f.package / "manifest.json").write_bytes(packager.encoded(manifest))
        self.receipt["manifest_sha256"] = digest(f.package / "manifest.json")
        Package(f.package, self.receipt["manifest_sha256"])
        for role, workspace in self.workspaces.items():
            f.write_private(workspace / "role", role.encode())
            f.write_private(workspace / "mode", b"hold" if role == "deep" else b"complete")
            self.probes[role] = SelectedNativeProbe(f.package / "native")
        self.spawn([str(f.package / "manager.py"), self.receipt["manifest_sha256"]],
                   {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}, label="manager")
        ordinary.wait_for(lambda: self.listener(f.package / "server"), "owned configured listener", 15)
        assert self.request("/api/v2/health", browser=False)[0] == 200

    def write_quota(self, used, observed_ms=None):
        """The closed Codex quota projection the server's gate reads."""
        import time as clock
        observed = int(clock.time() * 1000) if observed_ms is None else observed_ms
        value = {"format": "orkestr-provider-quota-v1", "provider": "codex",
                 "owner_id": "00000000-0000-4000-8000-0000000000ab",
                 "account_ref": "00000000-0000-4000-8000-0000000000aa",
                 "windows": {"five_hour": {"used_percent": used, "resets_at": observed // 1000 + 3600,
                                           "status": None, "observed_at": observed}}}
        path = self.quota / "codex.json"
        path.write_bytes(json.dumps(value).encode())
        os.chown(path, UID, GID)
        path.chmod(0o640)

    def trace(self):
        self.observe()
        rows = []
        for role, account in self.accounts.items():
            path = account / "sessions/synthetic-role.jsonl"
            values = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
            rows.extend(self.probes[role].observe(self.server_pid, values))
        return rows

    def rows(self, sql, args=(), *, manager=False):
        path = self.fixture.ledger_directory / "budget.sqlite3" if manager else self.home / "core.sqlite3"
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA query_only=ON")
            db.execute("PRAGMA trusted_schema=OFF")
            db.execute("BEGIN")
            return [dict(row) for row in db.execute(sql, args)]

    def stop(self):
        child = self.process
        if child is None:
            return
        observation_error = None
        try:
            self.observe()
            if self.accounts:
                self.trace()
        except BaseException as error:
            observation_error = error
        try:
            if child.poll() is None:
                child.send_signal(signal.SIGINT)
            child.wait(timeout=38)
        except subprocess.TimeoutExpired:
            self.forced = True
            # Exact fixture server process group only; never a reused PID.
            if self.server_pid and any(pid == self.server_pid and process_start(pid) == start
                                       for pid, start in self.known):
                os.killpg(self.server_pid, signal.SIGKILL)
            child.kill()
            child.wait(3)
            raise
        finally:
            self.process = None
        if observation_error is not None:
            raise observation_error
        assert child.returncode == 0, "owned service did not retire cleanly"

    def cleanup(self):
        try:
            self.stop()
        finally:
            for stream in self.logs:
                stream.close()
            ordinary.wait_for(lambda: all(process_start(pid) != start for pid, start in self.known),
                              "retained original process remains", 5)
        assert not self.forced
        assert all(probe.gone() for probe in self.probes.values())
        assert not (self.fixture.endpoint / "control.sock").exists()
        assert not (self.fixture.endpoint / "egress.sock").exists()
        with socket.socket() as sock:
            assert sock.connect_ex(("127.0.0.1", self.port)) != 0
