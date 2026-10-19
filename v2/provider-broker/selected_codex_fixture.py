"""Root-owned disposable package fixtures; dummy account and synthetic ELF only."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile

from codex_bounded.configuration import BROKER, ISOLATION, MODULES, ROLE_MODULES
from codex_bounded.trust import digest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("selected_codex_packager", ROOT / "v2/packaging/selected_codex.py")
packager = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(packager)
UID = GID = 65534


class Fixture:
    def __init__(self, *, stubborn=False, roles=False, fixture_parent="/opt"):
        self.root = Path(tempfile.mkdtemp(prefix="selected-codex-test-", dir=fixture_parent))
        self.root.chmod(0o755)
        self.repository = self.root / "repository"
        self.repository.mkdir()
        source = ROOT / "v2/provider-broker"
        for directory, names in (("", BROKER), ("isolation", ISOLATION),
                                 ("codex_bounded", ROLE_MODULES if roles else MODULES)):
            for name in names:
                relative = Path("v2/provider-broker") / directory / name
                target = self.repository / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((source / directory / name).read_bytes())
        packaging = self.repository / "v2/packaging/selected_codex.py"
        packaging.parent.mkdir(parents=True)
        packaging.write_bytes((ROOT / "v2/packaging/selected_codex.py").read_bytes())
        if roles:
            packaging.with_name("selected_codex_roles.py").write_bytes(
                (ROOT / "v2/packaging/selected_codex_roles.py").read_bytes())
        environment = {"PATH": "/usr/bin:/bin", "HOME": str(self.root), "GIT_CONFIG_NOSYSTEM": "1",
                       "GIT_CONFIG_GLOBAL": "/dev/null"}
        for arguments in (("init", "-q"), ("add", "."),
                          ("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                           "commit", "-qm", "Synthetic package source")):
            subprocess.run(["git", "-C", str(self.repository), *arguments], check=True,
                           env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        self.source = subprocess.check_output(["git", "-C", str(self.repository), "rev-parse", "HEAD"],
                                              env=environment).decode().strip()
        self.server = self.root / "synthetic-server"
        code = ('#include <signal.h>\n#include <unistd.h>\n'
                'static volatile sig_atomic_t stopped; static void stop(int n){(void)n;stopped=1;}\n'
                '__attribute__((used)) const char identity[]="ORKESTR_V2_BUILD_IDENTITY_V1|server|2.0.0-dev|' +
                self.source + '|END";\nint main(void){signal(SIGINT,' +
                ('SIG_IGN' if stubborn else 'stop') + ');signal(SIGTERM,stop);alarm(20);'
                'while(!stopped)pause();return 0;}\n')
        subprocess.run(["cc", "-x", "c", "-", "-o", str(self.server)], input=code.encode(), check=True,
                       env={"PATH": "/usr/bin:/bin"}, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.server.chmod(0o555)
        self.home = self.directory("home")
        for name in ("data", "provider-home"):
            self.directory("home/" + name)
        self.workspace = self.directory("workspace")
        self.account = self.directory("account")
        self.auth = self.directory("canonical") / "auth.json"
        self.write_private(self.auth, b'{"fixture":"synthetic-account-only"}\n')
        self.token = self.home / "machine.token"
        self.bootstrap = self.home / "bootstrap.token"
        self.write_private(self.token, b"a" * 64)
        self.write_private(self.bootstrap, b"b" * 64)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        self.plan = {"format": "orkestr-v2-codex-bounded-plan-v1", "output": str(self.root / "package"),
            "source_repository": str(self.repository), "source_commit": self.source,
            "server": str(self.server), "native": str(self.server), "uid": UID, "gid": GID,
            "home": str(self.home), "workspace": str(self.workspace), "state_root": str(self.account),
            "auth_file": str(self.auth), "egress_directory": str(self.root / "endpoint"),
            "bootstrap_file": str(self.bootstrap), "machine_token_file": str(self.token),
            "conversation_id": "11111111-2222-4333-8444-555555555555", "namespace": "synthetic",
            "supervisor_key": "synthetic-owner", "port": port, "lifetime_seconds": 30}
        self.receipt = None
        self.roles = roles
        if roles:
            self.plan["format"] = "orkestr-v2-codex-bounded-roles-plan-v1"
            self.plan["roles"] = {
                "deep": {name: self.plan.pop(name) for name in
                         ("workspace", "state_root", "namespace", "supervisor_key")},
                "fast": {"workspace": str(self.directory("fast-workspace")),
                         "state_root": str(self.directory("fast-account")),
                         "namespace": "synthetic-fast", "supervisor_key": "synthetic-fast-owner"},
            }

    def directory(self, name):
        path = self.root / name
        path.mkdir(mode=0o700)
        os.chown(path, UID, GID)
        return path

    @staticmethod
    def write_private(path, content):
        path.write_bytes(content)
        os.chown(path, UID, GID)
        path.chmod(0o600)

    def prepare(self):
        if self.roles:
            spec = importlib.util.spec_from_file_location("selected_codex_roles_packager",
                ROOT / "v2/packaging/selected_codex_roles.py")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            self.receipt = module.prepare(self.plan)
        else:
            self.receipt = packager.prepare(self.plan)
        return self.receipt

    def alter(self, name, mutate):
        root = Path(self.receipt["package"])
        path = root / name
        value = json.loads(path.read_text())
        mutate(value)
        path.write_bytes(packager.encoded(value))
        manifest = root / "manifest.json"
        value = json.loads(manifest.read_text())
        value["files"][name] = digest(path)
        manifest.write_bytes(packager.encoded(value))
        self.receipt["manifest_sha256"] = digest(manifest)

    def close(self):
        shutil.rmtree(self.root)
