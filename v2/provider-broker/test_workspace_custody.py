"""Synthetic Root project descriptor checks; no live project or release reads."""
import os
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
import uuid

from codex_service.contract import Refused
from codex_service.workspace_custody import Installation
from codex_service_fixture import ServiceFixture, UID, GID


@unittest.skipUnless(os.geteuid() == 0, 'requires disposable numeric-UID fixture')
class WorkspaceCustodyTests(unittest.TestCase):
    def setUp(self):
        self.fixture = ServiceFixture(); self.addCleanup(self.fixture.close)
        root = self.fixture.root
        self.workspace = self.fixture.directory('private-project')
        self.git = self.workspace / '.git'; self.git.mkdir(mode=0o700); os.chown(self.git, UID, GID)
        self.package = SimpleNamespace(identity_split=True, executor_uid=UID,
            home=root / 'authority-private', ledger_directory=root / 'ledger',
            provider_home=root / 'provider-home', root=root / 'package')
        self.profile = dict(conversation_id=str(uuid.uuid4()), project_id=str(uuid.uuid4()),
            workspace=str(self.workspace), allowed_roots=[str(self.workspace)],
            protected_roots=[str(root / 'protected')], cgroup_root=str(root / 'cgroups'),
            toolchain_root=str(root / 'image'), trusted={'managed_executor': True})

    def installation(self):
        value = Installation(self.package, self.profile); self.addCleanup(value.close)
        return value

    def test_exact_retained_project_git_and_common_without_core_access(self):
        value = self.installation(); value.check()
        self.assertEqual(len(value.fds), 3)
        self.assertEqual(value.identities[1], value.identities[2])
        self.assertTrue(all(v[2] == UID for v in value.identities))
        self.assertEqual(Path('/proc/self/fd/' + str(value.fds[0])).resolve(), self.workspace)

    def test_replacement_refuses_even_while_original_descriptors_remain_open(self):
        value = self.installation()
        self.git.rename(self.workspace / '.old-git')
        self.git.mkdir(mode=0o700); os.chown(self.git, UID, GID)
        with self.assertRaisesRegex(Refused, 'workspace_managed_replaced'): value.check()

    def test_worktree_association_is_closed_and_rechecked(self):
        self.git.rmdir()
        external = self.fixture.directory('external-git')
        self.git.write_text('gitdir: ../external-git\n'); self.git.chmod(0o600); os.chown(self.git, UID, GID)
        value = self.installation()
        self.assertEqual(value.paths, (self.workspace, external, external))
        other = self.fixture.directory('other-common')
        pointer = external / 'commondir'; pointer.write_text('../other-common\n')
        pointer.chmod(0o600); os.chown(pointer, UID, GID)
        with self.assertRaisesRegex(Refused, 'workspace_git_association_changed'): value.check()
        self.assertNotEqual(other, external)

    def test_old_privileged_profile_and_implicit_mode_never_become_managed(self):
        for trusted in ({'host_privileged': True}, {}, {'managed_executor': True, 'host_privileged': True},
                        {'managed_executor': 1}):
            self.profile['trusted'] = trusted
            with self.assertRaisesRegex(Refused, 'workspace_explicit_managed_executor'): self.installation()

    def test_mutable_git_pointer_cannot_enter_separate_provider_account(self):
        account = self.fixture.directory('provider-account')
        selected = self.fixture.root / 'selected-profile.json'
        selected.write_text(json.dumps({'state_root': str(account), 'auth_file': str(account / 'auth.json'),
            'workspace': str(self.fixture.root / 'provider-workspace')}))
        self.package.role_profiles = {'deep': selected}
        self.git.rmdir(); self.git.write_text('gitdir: ../provider-account\n')
        self.git.chmod(0o600); os.chown(self.git, UID, GID)
        with self.assertRaisesRegex(Refused, 'workspace_managed_overlap'): self.installation()

    def test_alias_external_protected_git_and_group_writable_directory_refused(self):
        self.git.rename(self.workspace / '.saved-git')
        self.git.symlink_to(self.workspace / '.saved-git')
        with self.assertRaisesRegex(Refused, 'workspace_git_alias'): self.installation()
        self.git.unlink(); (self.workspace / '.saved-git').rename(self.git)
        self.profile['protected_roots'] = [str(self.workspace.parent)]
        with self.assertRaisesRegex(Refused, 'workspace_managed_overlap'): self.installation()
        self.profile['protected_roots'] = [str(self.fixture.root / 'protected')]
        self.git.chmod(0o770)
        with self.assertRaisesRegex(Refused, 'workspace_managed_custody'): self.installation()


if __name__ == '__main__': unittest.main()
