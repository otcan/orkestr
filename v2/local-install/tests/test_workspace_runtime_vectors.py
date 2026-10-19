"""Topology and retained-FD fixture tests only, no issuer/consumer qualification."""
import os
from pathlib import Path
import unittest
from workspace_runtime_vectors import WorkspaceVectors, FD_ADAPTER_CASES


class RuntimeVectorFixtureTests(unittest.TestCase):
    def test_linked_root_and_worker_reopen_keep_dirty_artifact(self):
        with WorkspaceVectors() as fixture:
            before = (fixture.worker/'sentinel.txt').read_bytes()
            self.assertEqual(fixture.git(fixture.parent, 'rev-parse', 'HEAD'),
                             fixture.git(fixture.worker, 'rev-parse', 'HEAD'))
            self.assertEqual(Path(fixture.git(fixture.worker, 'rev-parse', '--path-format=absolute', '--git-common-dir')), fixture.common)
            self.assertNotEqual(fixture.worker_git, fixture.common)
            # Ordinary read-only Git reopening; not Store reopen/grant evidence.
            for _ in range(2):
                self.assertIn('sentinel.txt', fixture.git(fixture.worker, 'status', '--porcelain'))
                self.assertEqual((fixture.worker/'sentinel.txt').read_bytes(), before)
            self.assertTrue(fixture.foreign.is_dir())

    @unittest.skipUnless(hasattr(os, 'O_DIRECTORY'), 'POSIX directory descriptor fixture')
    def test_retained_workspace_fd_distinguishes_replacement(self):
        with WorkspaceVectors() as fixture:
            fd = os.open(fixture.worker, os.O_RDONLY | os.O_DIRECTORY)
            try:
                old = os.fstat(fd)
                displaced = fixture.replace_workspace()
                self.assertEqual((old.st_dev, old.st_ino), (displaced.stat().st_dev, displaced.stat().st_ino))
                self.assertNotEqual(os.fstat(fd).st_ino, fixture.worker.stat().st_ino)
                child = os.open('sentinel.txt', os.O_RDONLY, dir_fd=fd)
                try: self.assertEqual(os.read(child, 128), b'public synthetic dirty edit\n')
                finally: os.close(child)
                self.assertEqual((fixture.worker/'sentinel.txt').read_bytes(), b'public synthetic replacement\n')
            finally: os.close(fd)

    @unittest.skipUnless(hasattr(os, 'O_DIRECTORY'), 'POSIX directory descriptor fixture')
    def test_retained_metadata_fd_distinguishes_replacement(self):
        with WorkspaceVectors() as fixture:
            fd = os.open(fixture.worker_git, os.O_RDONLY | os.O_DIRECTORY)
            try:
                old = os.fstat(fd)
                displaced = fixture.replace_worker_metadata()
                self.assertEqual(os.fstat(fd).st_ino, old.st_ino)
                self.assertEqual(displaced.stat().st_ino, old.st_ino)
                self.assertNotEqual(fixture.worker_git.stat().st_ino, old.st_ino)
            finally: os.close(fd)

    def test_owned_cleanup_and_explicit_pending_authority_vectors(self):
        with WorkspaceVectors() as fixture:
            root = fixture.root
            self.assertEqual(root.stat().st_mode & 0o777, 0o700)
            self.assertEqual(set(FD_ADAPTER_CASES), {'linked-worktree','foreign-scope','foreign-owner',
                'workspace-replaced','metadata-replaced','revoke','reopen','callback-error','closed-handle'})
        self.assertFalse(root.exists())
