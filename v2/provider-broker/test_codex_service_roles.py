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
