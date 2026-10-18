"""Owned synthetic packages and fault injection; no executable is started."""
from contextlib import closing
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from test_install import builder, launcher, state


class PackageIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="v2-integrity-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        binary = self.root / "server"
        binary.write_text("#!/bin/sh\nexit 99\n")
        binary.chmod(0o700)
        ui = self.root / "ui"
        ui.mkdir()
        (ui / "index.html").write_text("synthetic web")
        (ui / "bundle.js").write_text("// synthetic")
        self.old = builder.assemble(binary, self.root / "old", "1.0.0", "a" * 40, ui)
        self.new = builder.assemble(binary, self.root / "new", "1.1.0", "b" * 40, ui)
        self.home = self.root / "home"
        with patch.object(state, "free_port"):
            state.initialize(self.home, self.old, 48123)
        with closing(sqlite3.connect(self.home / "data/core.sqlite3")) as db:
            db.execute("CREATE TABLE messages (body TEXT)")
            db.execute("INSERT INTO messages VALUES ('synthetic retained history')")
            db.commit()
        self.before = {name: (self.home / name).read_bytes() for name in
                       ("install.json", "control/bootstrap.token", "data/core.sqlite3")}
        self.selected = state.config(self.home)["release"]
        self.old_inventory = state.files(self.home / "releases" / self.selected)
        self.manifest = json.loads((self.new / "manifest.json").read_text())

    def write_manifest(self, manifest):
        (self.new / "manifest.json").write_text(json.dumps(manifest))

    def preserved(self):
        for name, content in self.before.items():
            self.assertEqual((self.home / name).read_bytes(), content, name)
        self.assertEqual(state.config(self.home)["release"], self.selected)
        self.assertEqual(state.files(self.home / "releases" / self.selected), self.old_inventory)
        self.assertFalse(any(path.name.startswith(".stage-") for path in (self.home / "releases").iterdir()))
        self.assertFalse(any(path.name.startswith("install.json.") for path in self.home.iterdir()))
        with closing(sqlite3.connect(self.home / "data/core.sqlite3")) as db:
            self.assertEqual(db.execute("SELECT body FROM messages").fetchall(), [("synthetic retained history",)])

    def rejected(self):
        with patch.object(launcher, "start") as start, patch("subprocess.Popen") as process:
            with self.assertRaises((RuntimeError, ValueError, OSError)):
                state.upgrade(self.home, self.new)
        start.assert_not_called()
        process.assert_not_called()
        self.preserved()

    def test_tampered_binary_ui_and_tool_inventory(self):
        for name in ("server/orkestr-v2-server", "ui/bundle.js", "tools/launcher.py"):
            with self.subTest(name=name):
                path = self.new / name
                original = path.read_bytes()
                path.write_bytes(b"synthetic tampering")
                self.rejected()
                path.write_bytes(original)

    def test_missing_extra_and_self_consistently_removed_required_file(self):
        path = self.new / "tools/helper.py"
        original = path.read_bytes()
        path.unlink()
        self.rejected()
        changed = dict(self.manifest, files=dict(self.manifest["files"]))
        del changed["files"]["tools/helper.py"]
        self.write_manifest(changed)
        self.rejected()
        path.write_bytes(original)
        self.write_manifest(self.manifest)
        (self.new / "unexpected.fixture").write_text("extra")
        self.rejected()

    def test_invalid_manifest_shapes_types_and_inventory_paths(self):
        cases = [[], None, {}, dict(self.manifest, version=1), dict(self.manifest, target=[]),
                 dict(self.manifest, ui="false"), dict(self.manifest, files=[]),
                 dict(self.manifest, schema_compatibility=None), dict(self.manifest, source_commit=False)]
        for name in ("../escape", "/absolute", "ui//alias", "./alias", "manifest.json"):
            cases.append(dict(self.manifest, files={**self.manifest["files"], name: "a" * 64}))
        cases.append(dict(self.manifest, files={**self.manifest["files"], "extra": 123}))
        for manifest in cases:
            with self.subTest(manifest_type=type(manifest).__name__):
                self.write_manifest(manifest)
                self.rejected()

    def test_invalid_json_and_duplicate_keys(self):
        for text in ("{", '{"format":"wrong","format":"orkestr-v2-directory-package-v1"}'):
            (self.new / "manifest.json").write_text(text)
            self.rejected()

    def test_ui_declaration_mismatch(self):
        self.write_manifest(dict(self.manifest, ui=False))
        self.rejected()

    def test_incomplete_copy_exception_and_incomplete_success(self):
        for raises in (False, True):
            def partial(source, target):
                target.mkdir()
                shutil.copy2(source / "manifest.json", target / "manifest.json")
                if raises:
                    raise OSError("synthetic copy interruption")
            with self.subTest(raises=raises), patch.object(state.shutil, "copytree", side_effect=partial):
                self.rejected()

    def test_valid_but_changed_manifest_during_copy_rejected(self):
        copytree = shutil.copytree
        def changed(source, target, *args, **kwargs):
            result = copytree(source, target, *args, **kwargs)
            if not Path(target).name.startswith(".stage-"):
                return result
            manifest = json.loads((target / "manifest.json").read_text())
            manifest["version"] = "9.0.0"
            (target / "manifest.json").write_text(json.dumps(manifest))
        with patch.object(state.shutil, "copytree", side_effect=changed):
            self.rejected()

    def test_config_replace_failure_keeps_previous_selection(self):
        with patch.object(state.os, "replace", side_effect=OSError("synthetic atomic selection failure")):
            self.rejected()
        # A verified but unselected release is allowed; a subsequent retry may reuse it.
        state.upgrade(self.home, self.new)
        self.assertNotEqual(state.config(self.home)["release"], self.selected)
        self.assertEqual((self.home / "data/core.sqlite3").read_bytes(), self.before["data/core.sqlite3"])

    def test_cached_release_manifest_identity_mismatch(self):
        release = state.sha256(self.new / "manifest.json")
        target = self.home / "releases" / release
        shutil.copytree(self.new, target)
        changed = dict(self.manifest, version="9.0.0")
        (target / "manifest.json").write_text(json.dumps(changed))
        self.rejected()

    def test_rejected_selected_binary_never_starts(self):
        target = self.home / "releases" / self.selected / "server/orkestr-v2-server"
        target.write_text("synthetic rejected executable")
        with patch.object(launcher, "start") as start, patch("subprocess.Popen") as process:
            with self.assertRaisesRegex(RuntimeError, "checksum"):
                launcher.serve(self.home)
        start.assert_not_called()
        process.assert_not_called()
        for name, content in self.before.items():
            self.assertEqual((self.home / name).read_bytes(), content)


if __name__ == "__main__":
    unittest.main()
