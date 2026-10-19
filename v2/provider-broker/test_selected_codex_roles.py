"""Two protected profiles must not alias authority or create another budget."""
import json
import os
from pathlib import Path
import socket
import subprocess
import unittest
from unittest.mock import patch

from codex_bounded.configuration import Package, ROLES
from codex_bounded.controller import Runtime
from codex_bounded.profile import Configuration
from codex_bounded.trust import Refused, digest
from selected_codex_fixture import Fixture, UID, GID, packager
import test_selected_codex as single_tests


@unittest.skipUnless(os.geteuid() == 0, "protected role fixtures require an explicit root test run")
class RolePackageTests(unittest.TestCase):
    def setUp(self):
        self.fixture = Fixture(roles=True)
        self.addCleanup(self.fixture.close)

    def package(self):
        receipt = self.fixture.prepare()
        return Package(receipt["package"], receipt["manifest_sha256"])

    def config(self, role, mutate):
        path = self.fixture.home / f"selected-{role}.json"
        value = json.loads(path.read_text())
        mutate(value)
        path.write_bytes(packager.encoded(value))
        self.fixture.alter("runtime.json", lambda value: value["executions"][role].update(sha256=digest(path)))

    def test_preparation_has_two_fixed_profiles_and_never_opens_selected_account(self):
        original = Path.open
        def guarded(path, *args, **kwargs):
            self.assertNotEqual(path, self.fixture.auth)
            return original(path, *args, **kwargs)
        with patch.object(Path, "open", guarded):
            package = self.package()
        self.assertEqual(set(package.executions), set(ROLES))
        self.assertEqual(len({value["launcher"] for value in package.executions.values()}), 2)
        self.assertEqual(len({value["workspace"] for value in package.profiles.values()}), 2)
        self.assertEqual(len({value["state_root"] for value in package.profiles.values()}), 2)
        self.assertEqual(len({value["egress_socket"] for value in package.profiles.values()}), 1)
        self.assertNotIn("ORKESTR_V2_EXECUTION_CONFIG", package.environment())
        self.assertEqual(package.environment()["ORKESTR_V2_EXECUTION_SET"],
                         str(self.fixture.home / "selected-executions.json"))
        self.assertFalse(package.endpoint.exists())
        self.assertFalse((package.endpoint.parent / "window.started").exists())
        for role in ROLES:
            self.assertEqual(list(Path(package.profiles[role]["state_root"]).iterdir()), [])

    def test_fixed_role_is_required_without_argv_or_deep_fallback(self):
        package = self.package()
        for role in (None, "worker", "claude", "", "Deep"):
            with self.subTest(role=role), self.assertRaisesRegex(Refused, "fixed_launcher_role_required"):
                package.profile_path(role)
        for role in ROLES:
            self.assertEqual(package.profile_path(role), package.root / f"profile-{role}.json")
            for args in (["open-owned-session", "--protocol", "orkestr-v2-provider-broker-v1", "--role", "deep"],
                         ["open-owned-worker-session", "--protocol", "orkestr-v2-provider-broker-v1"],
                         ["resume-owned-session", "--protocol", "orkestr-v2-provider-broker-v1"]):
                child = subprocess.run(['/usr/bin/python3','-I','-B',str(package.root / f'launcher-{role}.py'),*args],
                    user=UID, group=GID, extra_groups=[], env={"PATH":"/usr/bin:/bin"}, close_fds=True,
                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=3)
                self.assertEqual(child.returncode, 2)
                self.assertEqual(child.stdout, b"")
                self.assertNotIn(b"synthetic-account-only", child.stderr)
        for role in ROLES:
            self.assertEqual(list(Path(package.profiles[role]["state_root"]).iterdir()), [])

    def test_cross_role_configuration_and_worker_policy_are_refused_even_if_rehashed(self):
        package = self.package()
        mutations = (
            (lambda value: value.update(role="deep"), "exact_execution_role"),
            (lambda value: value.update(launcher=str(package.root / 'launcher-deep.py')),
             "role_launcher_binding"),
            (lambda value: value.update(worker={}), "exact_execution_role"),
            (lambda value: value.update(conversation_id='22222222-2222-4333-8444-555555555555'),
             "role_shared_scope_mismatch"),
            (lambda value: value.update(namespace=package.executions['deep']['namespace']),
             "role_authority_alias"),
            (lambda value: value.update(supervisor_key=package.executions['deep']['supervisor_key']),
             "role_authority_alias"),
        )
        original = dict(package.executions['fast'])
        for mutate, reason in mutations:
            self.config('fast', lambda value: (value.clear(), value.update(original), mutate(value)))
            with self.subTest(reason=reason), self.assertRaisesRegex(Refused, reason):
                Package(package.root)

    def test_role_state_alias_and_cross_profile_workspace_are_refused(self):
        package = self.package()
        self.fixture.alter('profile-fast.json', lambda value:
                           value.update(state_root=package.profiles['deep']['state_root']))
        with self.assertRaisesRegex(Refused, 'role_state_scope_overlap'):
            Package(package.root)
        self.fixture.alter('profile-fast.json', lambda value:
                           value.update(state_root=self.fixture.plan['roles']['fast']['state_root'],
                                        workspace=package.profiles['deep']['workspace']))
        with self.assertRaisesRegex(Refused, 'role_workspace_binding'):
            Package(package.root)

    def test_registry_cannot_omit_duplicate_or_substitute_a_role(self):
        package = self.package()
        path = self.fixture.home / 'selected-executions.json'
        original = json.loads(path.read_text())
        for configurations in ([], [original['configurations'][0]] * 2,
                               list(reversed(original['configurations']))):
            path.write_bytes(packager.encoded({**original, 'configurations':configurations}))
            self.fixture.alter('runtime.json', lambda value: value.update(execution_set_sha256=digest(path)))
            with self.subTest(configurations=configurations), self.assertRaisesRegex(Refused, 'execution_set_binding'):
                Package(package.root)

    def test_scope_aliases_are_rejected_before_any_package_is_created(self):
        self.fixture.plan['roles']['fast']['state_root'] = self.fixture.plan['roles']['deep']['state_root']
        with self.assertRaisesRegex(Refused, 'role_state_scope_overlap'):
            self.fixture.prepare()
        self.assertFalse(Path(self.fixture.plan['output']).exists())

    def test_commands_bind_distinct_native_state_and_workspace_with_same_readonly_auth(self):
        package = self.package()
        with socket.socket(socket.AF_UNIX) as endpoint:
            endpoint.bind(str(package.endpoint));os.chown(package.endpoint,0,GID);package.endpoint.chmod(0o660)
            try:
                old_uid, old_gid = os.geteuid(), os.getegid()
                try:
                    os.setegid(GID);os.seteuid(UID)
                    for role in ROLES:
                        config = Configuration(package.root, role)
                        command, descriptors = config.isolated_command()
                        try:
                            profile = package.profiles[role]
                            for key, target, flag in (('auth_file','/account/auth.json','--ro-bind'),
                                                      ('state_root','/account','--bind'),
                                                      ('workspace',profile['workspace'],'--ro-bind')):
                                index = command.index(profile[key])
                                self.assertEqual(command[index-1:index+2], [flag,profile[key],target])
                            self.assertIn('--die-with-parent',command)
                            self.assertIn('--unshare-pid',command)
                            self.assertEqual(command[-1],'codex-bounded')
                            with self.assertRaisesRegex(Refused,'already_issued'):
                                config.isolated_command()
                        finally:
                            for descriptor in descriptors:os.close(descriptor)
                finally:
                    os.seteuid(old_uid);os.setegid(old_gid)
            finally:
                package.endpoint.unlink()

    def test_both_roles_share_one_budget_and_server_epoch_deadline(self):
        package = self.package()
        runtime = Runtime(package.root,self.fixture.receipt['manifest_sha256'])
        self.addCleanup(runtime.close)
        runtime.start();single_tests.PackageTests.server_ready(self,runtime,package)
        created = runtime.budget.created
        runtime.budget.attempt();runtime.budget.attempt()
        runtime.stop_server()
        runtime.start();single_tests.PackageTests.server_ready(self,runtime,package)
        self.assertEqual(runtime.budget.attempts,2)
        self.assertEqual(runtime.budget.created,created)
        runtime.close()
        self.assertFalse(runtime.forced)
        self.assertFalse(package.endpoint.exists())


if __name__ == '__main__':
    unittest.main()
