"""Verification snapshots stay fresh across calls and retain every denial."""
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from codex_service.contract import Refused
from codex_service import resource_receipt, workspace_acl
from codex_service.resource_projects import verify_projects


class VerificationSnapshotTests(unittest.TestCase):
    def test_mount_snapshot_binds_exact_decoded_target_and_flags(self):
        raw = '41 1 0:7 / /project\\040files rw,nosuid,nodev - tmpfs tmpfs rw\n'
        with patch.object(Path, 'read_text', return_value=raw) as read:
            mounts = resource_receipt.mount_options()
            for _ in range(4):
                self.assertEqual(resource_receipt.options(41, '/project files', mounts),
                                 {'rw', 'nosuid', 'nodev'})
            self.assertEqual(read.call_count, 1)
            with self.assertRaisesRegex(Refused, 'resource_mount_target'):
                resource_receipt.options(41, '/project', mounts)
            with self.assertRaisesRegex(Refused, 'resource_mount_missing'):
                resource_receipt.options(42, mounts=mounts)

    def test_next_verification_observes_revoked_mount_flags(self):
        row = dict(path='/project', project_id='project', device=1, inode=2,
                   uid=62002, mount_id=41)
        ctx = dict(projects=[dict(project_id='project')], authority_uid=62001)
        safe = {41: ('/project', frozenset({'rw', 'nosuid', 'nodev'}))}
        revoked = {41: ('/project', frozenset({'rw', 'nosuid'}))}
        with patch('os.geteuid', return_value=62001), patch.object(
                resource_receipt, 'mount_options', side_effect=[safe, revoked]) as read:
            verify_projects([row], ctx)
            with self.assertRaisesRegex(Refused, 'resource_project_flags'):
                verify_projects([row], ctx)
            self.assertEqual(read.call_count, 2)

    def test_default_mount_lookup_does_not_reuse_old_target(self):
        lines = ['41 1 0:7 / /project rw,nodev - tmpfs tmpfs rw\n',
                 '41 1 0:7 / /replacement rw,nodev - tmpfs tmpfs rw\n']
        with patch.object(Path, 'read_text', side_effect=lines):
            resource_receipt.options(41, '/project')
            with self.assertRaisesRegex(Refused, 'resource_mount_target'):
                resource_receipt.options(41, '/project')

    def test_shared_group_membership_does_not_share_writer_authorization(self):
        group = SimpleNamespace(gr_mem=['owner'])
        user = SimpleNamespace(pw_uid=62003, pw_gid=62003)
        with patch.object(workspace_acl.grp, 'getgrgid', return_value=group) as groups, \
                patch.object(workspace_acl.pwd, 'getpwnam', return_value=user), \
                patch.object(workspace_acl.pwd, 'getpwall', return_value=[user]):
            observation = {}
            workspace_acl.source_group(62003, (62003,), observation)
            workspace_acl.source_group(62003, (62003, 62004), observation)
            with self.assertRaisesRegex(Refused, 'workspace_unselected_group_writer'):
                workspace_acl.source_group(62003, (62004,), observation)
            self.assertEqual(groups.call_count, 1)

    def test_new_group_observation_detects_new_primary_member(self):
        allowed = SimpleNamespace(pw_uid=62003, pw_gid=62003)
        outsider = SimpleNamespace(pw_uid=62005, pw_gid=62003)
        with patch.object(workspace_acl.grp, 'getgrgid', return_value=SimpleNamespace(gr_mem=[])), \
                patch.object(workspace_acl.pwd, 'getpwall', side_effect=[[allowed], [allowed, outsider]]):
            workspace_acl.source_group(62003, (62003,), {})
            with self.assertRaisesRegex(Refused, 'workspace_unselected_group_writer'):
                workspace_acl.source_group(62003, (62003,), {})

    def test_unknown_groups_still_refuse(self):
        with patch.object(workspace_acl.grp, 'getgrgid', side_effect=KeyError(62005)):
            with self.assertRaisesRegex(Refused, 'workspace_source_group_unknown'):
                workspace_acl.source_group(62005, (62003,), {})


if __name__ == '__main__':
    unittest.main()
