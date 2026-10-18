"""Real filesystem policy checks; no subprocess or provider execution."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

from verify_package import NAMES, PACKAGE, PACKAGE_FILES, Refused, verify


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


if __name__ == "__main__":
    unittest.main()
