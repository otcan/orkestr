"""Real filesystem policy checks; no subprocess or provider execution."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

from verify_package import INVENTORY_MODULES, NAMES, PACKAGE, PACKAGE_FILES, Refused, verify


@unittest.skipUnless(os.geteuid() == 0 and Path("/opt").is_dir(),
                     "real root-owned ancestor checks require root and /opt")
class PackageTests(unittest.TestCase):
    def setUp(self):
        # /tmp is deliberately unsuitable: its writable ancestor must be refused.
        self.root = Path(tempfile.mkdtemp(prefix="v2-package-test-", dir="/opt"))
        self.package = self.root / "broker"
        self.package.mkdir(mode=0o700)
        self.manifest = {"schema_version": 1, "mode": "isolated-codex-acceptance-v1",
                         "server_source": "1" * 40, "broker_source": "2" * 40,
                         "package_root": str(self.package), "artifacts": {}}
        for name in sorted(NAMES):
            file = ((self.package / PACKAGE_FILES[name]) if name in PACKAGE else self.root / name)
            content = ("synthetic fixture " + name).encode()
            file.write_bytes(content)
            file.chmod(0o500)
            self.manifest["artifacts"][name] = {
                "path": str(file), "sha256": hashlib.sha256(content).hexdigest()}
        self.path = self.root / "manifest.json"
        self.save()

    def tearDown(self):
        shutil.rmtree(self.root)

    def save(self):
        self.path.write_text(json.dumps(self.manifest))
        self.path.chmod(0o600)

    def refused(self, code):
        with self.assertRaisesRegex(Refused, "^" + code + "$"):
            verify(self.path)

    def test_protected_complete_package_proves_only_metadata(self):
        receipt = verify(self.path)
        self.assertEqual(receipt["status"], "verified")
        self.assertFalse(receipt["provider_started"])
        self.assertFalse(receipt["credentials_read"])
        self.assertEqual(set(receipt["artifacts"]), NAMES)

    def test_imported_module_mutation_is_detected_with_unchanged_launcher(self):
        Path(self.manifest["artifacts"]["broker_protocol"]["path"]).write_text("changed module")
        self.refused("artifact_hash_mismatch")

    def test_writable_parent_refused_even_with_protected_files(self):
        self.package.chmod(0o720)
        self.refused("artifact_or_ancestor_has_untrusted_writer")

    def test_unlisted_python_cache_or_module_refused(self):
        for name in ("shadow.py", "__pycache__"):
            path = self.package / name
            path.write_text("synthetic")
            self.refused("unexpected_broker_package_entry")
            path.unlink()

    def test_symlink_and_hardlink_aliases_refused(self):
        path = Path(self.manifest["artifacts"]["broker_config"]["path"])
        original = self.root / "original"
        path.rename(original)
        path.symlink_to(original)
        self.refused("artifact_path_not_canonical")
        path.unlink()
        os.link(original, path)
        self.refused("artifact_not_unaliased_regular_file")

    def test_missing_pin_or_aliased_artifact_refused(self):
        provider = self.manifest["artifacts"]["provider_native"]
        provider["sha256"] = ""
        self.save()
        self.refused("artifact_pin_required")
        self.manifest["artifacts"]["provider_native"] = self.manifest["artifacts"]["python_interpreter"]
        self.save()
        self.refused("artifact_alias_refused")

    def test_mutable_manifest_parent_refused_and_duplicate_keys_rejected(self):
        self.root.chmod(0o702)
        self.refused("artifact_or_ancestor_has_untrusted_writer")
        self.root.chmod(0o700)
        self.path.write_text('{"schema_version":1,"schema_version":1}')
        self.refused("duplicate_manifest_key")

    def add_inventory(self):
        self.manifest["schema_version"] = 2
        module = self.package / "codex_bootstrap.py"
        module.write_text("synthetic bootstrap fixture")
        module.chmod(0o400)
        self.manifest["artifacts"]["broker_codex_bootstrap"] = {
            "path": str(module), "sha256": hashlib.sha256(module.read_bytes()).hexdigest()}
        self.inventory = {"format": "orkestr-v2-codex-package-v1", "entry": "server.py",
                          "activation": "synthetic-only-no-activation-authority", "files": {
                              PACKAGE_FILES[name]: self.manifest["artifacts"][name]["sha256"]
                              for name in INVENTORY_MODULES}}
        self.save_inventory()

    def save_inventory(self):
        path = self.package / "codex-package.json"
        path.write_text(json.dumps(self.inventory))
        path.chmod(0o400)
        self.manifest["artifacts"]["broker_inventory"] = {
            "path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        self.save()

    def test_complete_five_module_inventory_and_legacy_package_both_verify(self):
        self.assertEqual(verify(self.path)["schema_version"], 1)
        self.add_inventory()
        receipt = verify(self.path)
        self.assertEqual(receipt["schema_version"], 2)
        self.assertIn("broker_codex_bootstrap", receipt["artifacts"])
        self.assertFalse(receipt["provider_started"])

    def test_bootstrap_mutation_and_missing_manifest_pin_refused(self):
        self.add_inventory()
        Path(self.manifest["artifacts"]["broker_codex_bootstrap"]["path"]).write_text("changed")
        self.refused("artifact_hash_mismatch")
        del self.manifest["artifacts"]["broker_codex_bootstrap"]
        self.save()
        self.refused("invalid_manifest_shape")

    def test_reviewed_inventory_must_match_complete_module_pins(self):
        self.add_inventory()
        self.inventory["files"]["protocol.py"] = "0" * 64
        self.save_inventory()
        self.refused("broker_inventory_pin_mismatch")
        del self.inventory["files"]["codex_bootstrap.py"]
        self.save_inventory()
        self.refused("invalid_manifest_shape")

    def test_legacy_shape_cannot_hide_new_importable_module(self):
        self.add_inventory()
        self.manifest["schema_version"] = 1
        del self.manifest["artifacts"]["broker_codex_bootstrap"]
        del self.manifest["artifacts"]["broker_inventory"]
        self.save()
        self.refused("unexpected_broker_package_entry")


if __name__ == "__main__":
    unittest.main()
