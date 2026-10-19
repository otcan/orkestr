"""Disposable local Git only: no real projects, credentials or execution."""
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from workspace_inventory import inspect_workspace, WorkspaceRefusal


class WorkspaceInventoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.home = self.root/'state'; self.home.mkdir(mode=0o700)
        self.repo = self.root/'project'; self.repo.mkdir()
        self.git(self.repo, 'init', '-q')
        (self.repo/'source.txt').write_text('synthetic source\n')
        self.git(self.repo, 'add', 'source.txt')
        self.git(self.repo, '-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid',
                 'commit', '-qm', 'fixture')

    def git(self, root, *args):
        return subprocess.run(['git', '-C', str(root), *args], check=True,
                              capture_output=True, text=True).stdout.strip()

    def test_linked_worktree_references_and_dirty_source_preserved(self):
        linked = self.root/'linked'
        self.git(self.repo, 'worktree', 'add', '-qb', 'fixture-linked', str(linked))
        (linked/'source.txt').write_text('uncommitted synthetic edit\n')
        before = self.git(linked, 'status', '--porcelain')
        first = inspect_workspace(self.repo, [self.home])
        second = inspect_workspace(linked, [self.home])
        self.assertEqual(first['git_common_directory'], second['git_common_directory'])
        self.assertNotEqual(first['git_directory'], second['git_directory'])
        self.assertEqual(first['head'], second['head'])
        self.assertEqual(second['authority'], 'none')
        self.assertEqual(before, self.git(linked, 'status', '--porcelain'))
        self.assertEqual((linked/'source.txt').read_text(), 'uncommitted synthetic edit\n')

    def test_explicit_root_and_canonical_paths_required(self):
        child = self.repo/'child'; child.mkdir()
        alias = self.root/'alias'; alias.symlink_to(self.repo, target_is_directory=True)
        for value in (child, alias, Path('relative')):
            with self.subTest(value=value), self.assertRaises((WorkspaceRefusal, FileNotFoundError)):
                inspect_workspace(value, [self.home])

    def test_state_overlap_in_either_direction_refused(self):
        for protected in (self.repo, self.root, self.repo/'.git'):
            with self.subTest(protected=protected), self.assertRaises(WorkspaceRefusal):
                inspect_workspace(self.repo, [protected])

    def test_protected_linked_common_metadata_refused(self):
        linked = self.root/'linked'; self.git(self.repo, 'worktree', 'add', '-qb', 'fixture-linked', str(linked))
        with self.assertRaises(WorkspaceRefusal):
            inspect_workspace(linked, [self.repo/'.git'])

    def test_other_writable_directory_refused(self):
        self.repo.chmod(0o777)
        with self.assertRaises(WorkspaceRefusal): inspect_workspace(self.repo, [self.home])

    def test_different_operator_owner_refused(self):
        with patch("workspace_inventory.os.getuid", return_value=self.repo.stat().st_uid + 1):
            with self.assertRaises(WorkspaceRefusal): inspect_workspace(self.repo, [self.home])

    def test_new_commit_changes_inventory_without_generation_claim(self):
        before = inspect_workspace(self.repo, [self.home])
        self.git(self.repo, '-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid',
                 'commit', '--allow-empty', '-qm', 'next fixture')
        after = inspect_workspace(self.repo, [self.home])
        self.assertNotEqual(before['head'], after['head'])
        self.assertEqual(after['generation_binding'], 'pending-runtime-contract')
