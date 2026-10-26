"""Protected synthetic role inventory and original paused-launch checks only."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from codex_bounded.trust import digest, process
from codex_service.contract import Refused
from codex_service.ownership import Children
from codex_service.package import Package
from codex_service.role_profiles import ROLE_FILES, ROLE_NAMES
from codex_service_fixture import ServiceFixture, UID, GID, packager


@unittest.skipUnless(os.geteuid() == 0, "explicit root synthetic package custody")
class RolePackageTests(unittest.TestCase):
    def setUp(self):
        self.fixture = ServiceFixture()
        self.addCleanup(self.fixture.close)
        self.fixture.prepare()
        self.root = self.fixture.package
        base = json.loads((self.root / "profile.json").read_bytes())
        roles = {"workers": []}
        for role in ROLE_NAMES:
            state = self.fixture.root / ("native-" + role)
            state.mkdir(mode=0o700); os.chown(state, UID, GID)
            launcher = self.root / f"launcher-{role}.py"
            interpreter = Path("/usr/bin/python3").resolve()
            script = (f'#!/bin/sh\nexec {interpreter} -I -S -B '
                      f'"$(dirname -- "$0")/codex_service/entry.py" broker-{role} "$@"\n')
            packager.write(launcher, script.encode(), GID, 0o550)
            packager.write(self.root / f"profile-{role}.json",
                           packager.encoded({**base, "state_root": str(state)}), GID)
            value = {"launcher": str(launcher), "launcher_sha256": digest(launcher),
                     "workspace": base["workspace"]}
            if role == "fast": roles["fast"] = value
            else: roles["workers"].append(value)
        manifest = json.loads((self.root / "manifest.json").read_bytes())
        manifest["files"].update({name: digest(self.root / name) for name in ROLE_FILES})
        (self.root / "manifest.json").write_text(json.dumps(manifest))
        self.fixture.alter("beta.json", lambda value: value.update(roles=roles))

    def test_disjoint_profiles_share_only_selected_read_only_auth_and_workspace(self):
        original = Path.open
        def guarded(path, *args, **kwargs):
            self.assertNotEqual(path, self.fixture.auth)
            return original(path, *args, **kwargs)
        with patch.object(Path, "open", guarded):
            package = Package(self.root)
        self.assertEqual(set(package.role_profiles), {"deep", *ROLE_NAMES})
        profiles = [json.loads(path.read_bytes()) for path in package.role_profiles.values()]
        self.assertEqual(len({p["state_root"] for p in profiles}), 6)
        self.assertEqual({p["auth_file"] for p in profiles}, {str(self.fixture.auth)})

    def test_rehashed_worker_native_state_alias_is_refused(self):
        self.fixture.alter("profile-worker-0.json", lambda value:
                           value.update(state_root=str(self.fixture.account)))
        with self.assertRaisesRegex(Refused, "role_state_scope_overlap"):
            Package(self.root)

    def test_rehashed_role_workspace_cannot_mount_application_home(self):
        self.fixture.alter("profile-fast.json", lambda value:
                           value.update(workspace=str(self.fixture.home)))
        self.fixture.alter("beta.json", lambda value:
                           value["roles"]["fast"].update(workspace=str(self.fixture.home)))
        with self.assertRaisesRegex(Refused, "role_workspace_scope_overlap"):
            Package(self.root)

    def test_rehashed_role_launcher_substitution_is_refused(self):
        def substitute(value):
            value["roles"]["workers"][0] = dict(value["roles"]["fast"])
        self.fixture.alter("beta.json", substitute)
        with self.assertRaisesRegex(Refused, "role_launcher_binding"):
            Package(self.root)

    def test_extra_role_fields_and_partial_inventory_are_refused(self):
        self.fixture.alter("beta.json", lambda value:
                           value["roles"]["fast"].update(account="untrusted"))
        with self.assertRaisesRegex(Refused, "role_configuration"):
            Package(self.root)


    def host_fast(self):
        """Host full access with a real service-user home and operator auth."""
        from codex_service_fixture import packager
        home = self.fixture.root / "service-user-home"
        (home / ".codex").mkdir(parents=True, mode=0o700)
        (home / ".codex/auth.json").write_text('{"synthetic": "auth"}')
        for path in (home, home / ".codex", home / ".codex/auth.json"):
            os.chown(path, UID, GID)
        os.chmod(home / ".codex/auth.json", 0o600)
        host = self.root / "codex-code-mode-host"
        packager.write(host, b"synthetic code-mode host", GID, 0o550)
        manifest = json.loads((self.root / "manifest.json").read_bytes())
        manifest["files"]["codex-code-mode-host"] = digest(host)
        (self.root / "manifest.json").write_text(json.dumps(manifest))
        access = {"providers": True, "environment": {"HOME": str(home), "PATH": "/usr/bin:/bin",
                                                    "CODEX_HOME": str(home / ".codex")}}
        self.fixture.alter("beta.json", lambda value: value.update(host_full_access=access))
        return home

    def test_repeated_host_fast_launches_keep_the_real_state_root_valid(self):
        """Incident 2026-10-26: the second host Fast launch failed loading its
        own role profile (private_state) because the first had created the Fast
        CODEX_HOME inside the Fast native state root. Run real launches as the
        service user against the real package and a synthetic native."""
        home = self.host_fast()
        import socket
        egress = socket.socket(socket.AF_UNIX)  # The root-owned egress endpoint a profile requires.
        self.addCleanup(egress.close)
        egress.bind(str(self.fixture.endpoint / "egress.sock"))
        os.chown(self.fixture.endpoint / "egress.sock", 0, GID)
        os.chmod(self.fixture.endpoint / "egress.sock", 0o660)
        native = self.fixture.root / "synthetic-fast-native"
        auth = home / ".codex/auth.json"
        native.write_text('#!/bin/sh\n[ -L "$CODEX_HOME/auth.json" ] '
                          f'&& [ "$(readlink "$CODEX_HOME/auth.json")" = "{auth}" ] '
                          '&& [ -f "$CODEX_HOME/auth.json" ] && printf "%s|%s" "$CODEX_HOME" "$*"\n')
        native.chmod(0o755)
        script = (
            "import json,subprocess,sys\n"
            "from pathlib import Path\n"
            "sys.path.insert(0,sys.argv[1])\n"
            "from codex_service.package import Package\n"
            "from codex_service.profile import Configuration\n"
            "root,native=sys.argv[1],sys.argv[2]\n"
            "out=[]\n"
            "for _ in range(3):\n"
            "    # Loading the role profile re-runs private_state on the Fast state root.\n"
            "    config=Configuration(Package(Path(root)),'fast')\n"
            "    command,_=config.isolated_command()\n"
            "    command[command.index(str(config.profile.native))]=native\n"
            "    out.append(subprocess.run(command,capture_output=True,text=True).stdout)\n"
            "print(json.dumps(out))\n")
        result = subprocess.run([str(Path("/usr/bin/python3").resolve()), "-I", "-S", "-B", "-c", script,
                                 str(self.root), str(native)],
                                cwd=str(self.fixture.root), env={"PATH": "/usr/bin:/bin"},
                                user=UID, group=GID, extra_groups=[], capture_output=True, text=True,
                                timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        outputs = json.loads(result.stdout)
        self.assertEqual(len(outputs), 3)
        fast_home = {output.split("|")[0] for output in outputs}
        self.assertEqual(len(fast_home), 1)
        fast_home = Path(fast_home.pop())
        state = self.fixture.root / "native-fast"
        self.assertNotIn(state, fast_home.parents)
        self.assertIn(home, fast_home.parents)
        # Each launch saw the Fast home's link to the operator auth file.
        self.assertTrue(all("app-server" in output and "--disable" in output for output in outputs))
        self.assertEqual({p.name for p in state.iterdir()} & {"host-codex-home"}, set())


class PausedRoleTests(unittest.TestCase):
    def check_launch(self, mode, operation, enabled, accepted):
        with tempfile.TemporaryDirectory(prefix="synthetic-role-bind-") as name:
            root = Path(name); (root / "codex_service").mkdir()
            entry = root / "codex_service/entry.py"
            entry.write_text('import os,signal\nos.kill(os.getpid(),signal.SIGSTOP)\n')
            child = subprocess.Popen([str(Path('/usr/bin/python3').resolve()), '-I', '-S', '-B',
                str(entry), mode, operation, '--protocol', 'orkestr-v2-provider-broker-v1'],
                env={}, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            owner = Children(SimpleNamespace(root=root, uid=os.getuid(), role_profiles=enabled),
                             process(os.getpid()))
            try:
                identity = process(child.pid)
                if accepted:
                    self.assertTrue(owner.bind(child.pid, identity['start'], time.monotonic() + 2))
                    child.wait(3)
                    self.assertTrue(owner.proven_gone())
                else:
                    with self.assertRaisesRegex(Refused, 'broker_source'):
                        owner.bind(child.pid, identity['start'], time.monotonic() + 2)
                    self.assertIsNone(child.poll())
            finally:
                if child.poll() is None: child.kill()
                child.wait(3); owner.close()
                self.assertIsNone(process(child.pid))

    def test_only_configured_fixed_modes_are_continued(self):
        for role in ROLE_NAMES:
            with self.subTest(role=role):
                self.check_launch('broker-' + role, 'open-owned-session', {role: None}, True)
        self.check_launch('broker-fast', 'open-owned-session', {}, False)
        self.check_launch('broker-worker-0', 'resume-owned-session', {'worker-0': None}, False)
        self.check_launch('broker-worker-4', 'open-owned-session', {'worker-4': None}, False)


if __name__ == '__main__':
    unittest.main()
