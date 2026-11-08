import grp
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from v2.compat.v1_runtime.attachment_files import attachment_export_settings, export_attachment


class AttachmentFilesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "media"
        self.content = b"synthetic retained attachment"
        self.item = dict(sha256=hashlib.sha256(self.content).hexdigest(),
                         filename="photo.png", media_type="image/png")

    def export(self, gid=None):
        return Path(export_attachment(str(self.root), gid, "synthetic-conversation",
                                      self.item, self.content))

    def test_unconfigured_export_stays_disabled(self):
        self.assertEqual(attachment_export_settings({}), (None, None))

    def test_declared_executor_group_must_match_resolved_group(self):
        env = dict(ORKESTR_V2_ADAPTER_ATTACHMENT_DIR="/synthetic/media",
                   ORKESTR_V2_ADAPTER_ATTACHMENT_GROUP="synthetic-reader",
                   ORKESTR_V2_ADAPTER_ATTACHMENT_EXECUTOR_GID="23002")
        with patch("v2.compat.v1_runtime.attachment_files.grp.getgrnam",
                   return_value=type("Group", (), {"gr_gid": 23002})()):
            self.assertEqual(attachment_export_settings(env), ("/synthetic/media", 23002))
        with patch("v2.compat.v1_runtime.attachment_files.grp.getgrnam",
                   return_value=type("Group", (), {"gr_gid": 23003})()):
            with self.assertRaisesRegex(ValueError, "group_mismatch"):
                attachment_export_settings(env)

    def test_unknown_or_missing_group_does_not_silently_ignore_reader(self):
        env = dict(ORKESTR_V2_ADAPTER_ATTACHMENT_DIR="/synthetic/media",
                   ORKESTR_V2_ADAPTER_ATTACHMENT_GROUP="missing")
        with patch("v2.compat.v1_runtime.attachment_files.grp.getgrnam", side_effect=KeyError):
            with self.assertRaisesRegex(ValueError, "group_unknown"):
                attachment_export_settings(env)
        env.pop("ORKESTR_V2_ADAPTER_ATTACHMENT_GROUP")
        env["ORKESTR_V2_ADAPTER_ATTACHMENT_EXECUTOR_GID"] = "23002"
        with self.assertRaisesRegex(ValueError, "group_mismatch"):
            attachment_export_settings(env)

    def test_invalid_declared_identity_is_not_coerced(self):
        for value in ("-1", "0", "23002x", "4294967295"):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "group_invalid"):
                attachment_export_settings(dict(ORKESTR_V2_ADAPTER_ATTACHMENT_DIR="/synthetic/media",
                    ORKESTR_V2_ADAPTER_ATTACHMENT_EXECUTOR_GID=value))

    def test_new_export_and_reuse_preserve_exact_content_and_existing_inode(self):
        path = self.export()
        before = path.stat()
        self.assertEqual(path.read_bytes(), self.content)
        self.assertEqual(before.st_mode & 0o777, 0o640)
        self.assertEqual(path.parent.stat().st_mode & 0o777, 0o750)
        self.assertEqual(self.export().stat().st_ino, before.st_ino)
        self.assertEqual(path.stat().st_mtime_ns, before.st_mtime_ns)

    def test_existing_corrupt_content_is_not_replaced(self):
        path = self.export(); path.write_bytes(b"x" * len(self.content))
        before = path.stat()
        with self.assertRaises(OSError): self.export()
        self.assertEqual(path.read_bytes(), b"x" * len(self.content))
        self.assertEqual(path.stat().st_ino, before.st_ino)

    def test_existing_wrong_mode_is_not_repaired_or_advertised(self):
        path = self.export(); path.chmod(0o600)
        with self.assertRaises(OSError): self.export()
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    @unittest.skipUnless(os.geteuid() == 0, "requires disposable root fixture")
    def test_existing_stale_group_is_not_repaired_or_advertised(self):
        path = self.export(23002); os.chown(path, -1, 23003)
        with self.assertRaises(OSError): self.export(23002)
        self.assertEqual(path.stat().st_gid, 23003)

    def test_existing_symlink_is_not_followed(self):
        path = self.export(); path.unlink()
        other = Path(self.temp.name) / "other"; other.write_bytes(b"unchanged")
        path.symlink_to(other)
        with self.assertRaises(OSError): self.export()
        self.assertTrue(path.is_symlink())
        self.assertEqual(other.read_bytes(), b"unchanged")

    def test_existing_hardlink_is_refused(self):
        path = self.export(); os.link(path, Path(self.temp.name) / "alias")
        with self.assertRaises(OSError): self.export()
        self.assertEqual(path.stat().st_nlink, 2)

    def test_symlink_conversation_is_not_followed_or_chmodded(self):
        self.root.mkdir()
        other = Path(self.temp.name) / "other"; other.mkdir(mode=0o700)
        (self.root / "synthetic-conversation").symlink_to(other, target_is_directory=True)
        with self.assertRaises(OSError): self.export()
        self.assertEqual(other.stat().st_mode & 0o777, 0o700)
        self.assertEqual(list(other.iterdir()), [])

    def test_digest_mismatch_is_refused_before_creating_export(self):
        self.item["sha256"] = "0" * 64
        with self.assertRaises(OSError): self.export()
        self.assertFalse(self.root.exists())

    @unittest.skipUnless(os.geteuid() == 0, "requires disposable root fixture")
    def test_actual_configured_reader_reads_but_unrelated_identity_is_denied(self):
        # Fake IDs inside the disposable Linux fixture, never a deployment default.
        os.chmod(self.temp.name, 0o711)
        path = self.export(23002)
        code = "import pathlib,sys; assert pathlib.Path(sys.argv[1]).read_bytes()==b'synthetic retained attachment'"
        allowed = subprocess.run(["/usr/bin/python3", "-I", "-S", "-B", "-c", code, str(path)],
            user=23001, group=23002, extra_groups=[], capture_output=True)
        self.assertEqual(allowed.returncode, 0, allowed.stderr)
        denied = subprocess.run(["/usr/bin/python3", "-I", "-S", "-B", "-c", code, str(path)],
            user=23003, group=23004, extra_groups=[], capture_output=True)
        self.assertNotEqual(denied.returncode, 0)
        self.assertIn(b"PermissionError", denied.stderr)


if __name__ == "__main__": unittest.main()
