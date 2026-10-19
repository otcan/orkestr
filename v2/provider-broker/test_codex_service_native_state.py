"""Metadata-only persistent Codex state compatibility; no native/account access."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from isolation.authenticated import private_state


class NativeStateTests(unittest.TestCase):
    def setUp(self):
        # The product rejects writable ancestry, including the shared /tmp.
        self.temp = tempfile.TemporaryDirectory(prefix=".synthetic-codex-state-", dir=Path.home())
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)
        self.lock = self.root / ".sqlite-maintenance.lock"

    def empty_lock(self):
        self.lock.touch(mode=0o600)
        self.lock.chmod(0o600)

    def validate_without_content_reads(self):
        with patch.object(Path, "open", side_effect=AssertionError("state content read")), \
                patch("builtins.open", side_effect=AssertionError("state content read")), \
                patch("io.open", side_effect=AssertionError("state content read")):
            return private_state(self.root)

    def test_empty_private_regular_maintenance_lock_preserves_state_without_reads(self):
        self.empty_lock()
        for name in ("sessions", "archived_sessions", "tmp", "cache", "skills", "thread-writer-locks"):
            (self.root / name).mkdir(mode=0o700)
        for name in ("auth.json", "session_index.jsonl", "state_5.sqlite"):
            (self.root / name).touch(mode=0o600)
        before = self.lock.stat()
        self.assertEqual(self.validate_without_content_reads(), str(self.root))
        after = self.lock.stat()
        self.assertEqual((before.st_dev, before.st_ino, before.st_size, before.st_mode),
                         (after.st_dev, after.st_ino, after.st_size, after.st_mode))

    def test_nonempty_maintenance_lock_refused(self):
        self.empty_lock()
        self.lock.write_bytes(b"synthetic-only")
        with self.assertRaises(ValueError):
            self.validate_without_content_reads()

    def test_directory_maintenance_lock_refused(self):
        self.lock.mkdir(mode=0o700)
        with self.assertRaises(ValueError):
            self.validate_without_content_reads()

    def test_fifo_maintenance_lock_refused_without_opening(self):
        os.mkfifo(self.lock, mode=0o600)
        with self.assertRaises(ValueError):
            self.validate_without_content_reads()

    def test_symlink_maintenance_lock_refused(self):
        target = self.root / "installation_id"
        target.touch(mode=0o600)
        self.lock.symlink_to(target)
        with self.assertRaises(ValueError):
            self.validate_without_content_reads()

    def test_hardlink_maintenance_lock_refused(self):
        self.empty_lock()
        os.link(self.lock, self.root / "installation_id")
        with self.assertRaises(ValueError):
            self.validate_without_content_reads()

    def test_nonprivate_or_writable_maintenance_lock_refused(self):
        self.empty_lock()
        for mode in (0o644, 0o640, 0o604, 0o660, 0o666, 0o700):
            with self.subTest(mode=oct(mode)):
                self.lock.chmod(mode)
                with self.assertRaises(ValueError):
                    self.validate_without_content_reads()

    def test_unknown_similar_filename_remains_refused(self):
        (self.root / ".sqlite-maintenance.lock.backup").touch(mode=0o600)
        with self.assertRaises(ValueError):
            self.validate_without_content_reads()

    def test_nonempty_disposable_directory_remains_refused(self):
        self.empty_lock()
        directory = self.root / "thread-writer-locks"
        directory.mkdir(mode=0o700)
        (directory / "unexpected").touch(mode=0o600)
        with self.assertRaises(ValueError):
            self.validate_without_content_reads()


if __name__ == "__main__":
    unittest.main()
