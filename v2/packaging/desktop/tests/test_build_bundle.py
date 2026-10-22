import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_bundle  # noqa: E402


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="bundle-"))
        self.server = self.root / "server"
        self.server.write_bytes(b"\x7fELF synthetic server")
        self.server.chmod(0o755)
        self.ui = self.root / "ui"
        self.ui.mkdir()
        (self.ui / "index.html").write_text("<!doctype html>")
        (self.ui / "orkestr_v2_ui_bg.wasm").write_bytes(b"\0asm")

    def test_stage_lists_every_file_with_its_digest(self):
        root = build_bundle.stage(self.server, self.ui, self.root / "out", "2.0.0-test", "x86_64-unknown-linux-gnu")
        manifest = json.loads((root / "manifest.json").read_text())
        self.assertEqual(root.name, "orkestr-v2-2.0.0-test-x86_64-unknown-linux-gnu")
        self.assertIn("bin/orkestr-v2-server", manifest["files"])
        self.assertIn("ui/index.html", manifest["files"])
        self.assertEqual(manifest["files"]["ui/index.html"], build_bundle.digest(root / "ui" / "index.html"))
        self.assertTrue(os.access(root / "bin" / "orkestr-v2-server", os.X_OK))

    def test_windows_targets_use_exe_names(self):
        root = build_bundle.stage(self.server, self.ui, self.root / "out", "2.0.0-test", "x86_64-pc-windows-msvc")
        self.assertTrue((root / "bin" / "orkestr-v2-server.exe").is_file())

    def test_archive_is_byte_reproducible_with_fixed_owner_and_time(self):
        first = build_bundle.archive(build_bundle.stage(self.server, self.ui, self.root / "a", "v", "t"), 1_700_000_000)
        second = build_bundle.archive(build_bundle.stage(self.server, self.ui, self.root / "b", "v", "t"), 1_700_000_000)
        manifest_a = json.loads((self.root / "a" / "orkestr-v2-v-t" / "manifest.json").read_text())
        manifest_b = json.loads((self.root / "b" / "orkestr-v2-v-t" / "manifest.json").read_text())
        self.assertEqual(manifest_a, manifest_b)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        with tarfile.open(first) as tar:
            for member in tar.getmembers():
                self.assertEqual((member.uid, member.gid, member.mtime), (0, 0, 1_700_000_000))
            self.assertEqual(tar.getmember("orkestr-v2-v-t/bin/orkestr-v2-server").mode, 0o755)

    def test_ui_without_index_and_symlinks_are_refused(self):
        (self.ui / "index.html").unlink()
        with self.assertRaises(build_bundle.BundleError):
            build_bundle.stage(self.server, self.ui, self.root / "out", "v", "t")
        (self.ui / "index.html").write_text("x")
        (self.ui / "link").symlink_to("/etc/hostname")
        with self.assertRaises(build_bundle.BundleError):
            build_bundle.stage(self.server, self.ui, self.root / "out2", "v", "t")


if __name__ == "__main__":
    unittest.main()
