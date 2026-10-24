"""Disposable selected-service package whose conversations run Claude Deep windows.

Explicit root fixture. By default the Claude native is the fixed synthetic peer
`service_claude_native.py`; `--executable`/`--account` select an installed CLI
and an existing account directory by reference (never read or copied). The
service identity may then be set with ORKESTR_FIXTURE_SERVICE_UID/GID.
"""
import json
from pathlib import Path
import shutil

import owned_execution_http as ordinary
from service_roles_case import ServiceRolesCase, GID, UID, packager, Package, digest
from codex_service.package import CLAUDE_BROKER

PEER = Path(__file__).with_name("service_claude_native.py")


class ClaudeWindowCase(ServiceRolesCase):
    def __init__(self, source, executable=None, account=None):
        super().__init__(source)
        self.executable, self.account_reference = executable, account

    def setup(self):
        f = self.fixture
        server = self.root / "bootstrap-server"
        packager.write(server, ordinary.binary.read_bytes(), GID, 0o550)
        env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": str(f.home / "provider-home"),
               "ORKESTR_V2_HOME": str(self.home), "ORKESTR_V2_BIND": f"127.0.0.1:{self.port}",
               "ORKESTR_V2_ORIGIN": self.origin, "ORKESTR_V2_BOOTSTRAP_TOKEN": self.bootstrap}
        self.spawn([str(server)], env, dropped=True, label="bootstrap")
        ordinary.wait_for(lambda: self.listener(server), "owned bootstrap listener")
        credentials = {"username": "synthetic-owner", "password": "synthetic-claude-window-only"}
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
        self.receipt = f.prepare()
        self.claude_workspace = f.directory("claude-workspace")
        home, temporary = f.directory("claude-home"), f.directory("claude-tmp")
        if self.executable is None:
            # Outside the closed package inventory, like an installed CLI.
            native = f.root / "claude-native"
            packager.write(native, PEER.read_bytes(), GID, 0o555)
            account = f.directory("claude-account")
        else:
            native, account = Path(self.executable), Path(self.account_reference)
        broker = f.package / "broker"
        for name in CLAUDE_BROKER:
            packager.write(broker / name, (ordinary.broker / name).read_bytes(), GID, 0o440)
        launcher = f.package / "launcher-claude.py"
        interpreter = Path("/usr/bin/python3").resolve()
        packager.write(launcher, (f'#!/bin/sh\nexec {interpreter} -I -S -B '
                       '"$(dirname -- "$0")/codex_service/entry.py" broker-claude "$@"\n').encode(),
                       GID, 0o550)
        packager.write(f.package / "claude-private.json", packager.encoded({
            "executable": str(native), "account": str(account),
            "workspace": str(self.claude_workspace), "home": str(home), "temporary": str(temporary),
            "host_full_access": {"environment": {"HOME": str(home), "TMPDIR": str(temporary),
                                                 "PATH": "/usr/local/bin:/usr/bin:/bin",
                                                 "LANG": "C.UTF-8"}}}), GID)
        beta = json.loads((f.package / "beta.json").read_bytes())
        beta["claude"] = {"launcher": str(launcher), "launcher_sha256": digest(launcher),
                          "workspace": str(self.claude_workspace), "default": False,
                          "fast": True}
        (f.package / "beta.json").write_bytes(packager.encoded(beta))
        (f.package / "beta.json").chmod(0o640)
        manifest = json.loads((f.package / "manifest.json").read_bytes())
        names = {"launcher-claude.py", "claude-private.json", "beta.json",
                 *("broker/" + name for name in CLAUDE_BROKER)}
        manifest["files"].update({name: digest(f.package / name) for name in names})
        (f.package / "manifest.json").write_bytes(packager.encoded(manifest))
        self.receipt["manifest_sha256"] = digest(f.package / "manifest.json")
        Package(f.package, self.receipt["manifest_sha256"])
        self.spawn([str(f.package / "manager.py"), self.receipt["manifest_sha256"]],
                   {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}, label="manager")
        ordinary.wait_for(lambda: self.listener(f.package / "server"), "owned configured listener", 15)
        assert self.request("/api/v2/health", browser=False)[0] == 200

    def trace(self):
        self.observe()
        path = self.claude_workspace / "claude-peer.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def cleanup(self, keep_logs=None):
        try:
            super().cleanup()
        finally:
            if keep_logs is not None:
                for log in self.root.glob("*.log"):
                    shutil.copyfile(log, Path(keep_logs) / log.name)
            shutil.rmtree(self.root, ignore_errors=True)
