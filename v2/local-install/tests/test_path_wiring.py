"""Consumer API regressions; identity/mount parsing belongs to the separate helper.

No mount changes, listener, server or real filesystem identity proof occurs here.
"""
from contextlib import nullcontext
import importlib.util
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

LOCAL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LOCAL))
import helper
import install_state as state
import recovery


class PathWiringTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="v2-path-wiring-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.target = self.root / "new-home"
        self.protected = self.root / "protected"
        self.protected.mkdir()
        self.guard = Mock(side_effect=lambda candidate, protected: candidate)
        self.module = SimpleNamespace(assert_disjoint=self.guard)
        self.loader = patch.object(helper.importlib, "import_module", return_value=self.module)
        self.loader.start()
        self.addCleanup(self.loader.stop)
        self.platform = patch.object(helper.sys, "platform", "linux")
        self.platform.start()
        self.addCleanup(self.platform.stop)

    def test_fresh_sibling_calls_identity_guard_with_protected_roots(self):
        with patch.dict(state.os.environ, {"ORKESTR_HOME": str(self.protected)}):
            result = state.fresh_path(self.target)
        self.assertEqual(result, self.target)
        self.guard.assert_called_once()
        self.assertIn(self.protected, self.guard.call_args.args[1])
        self.assertIn(LOCAL.parents[1], self.guard.call_args.args[1])
        self.assertFalse(self.target.exists())

    def test_alias_and_ambiguous_mount_fail_before_destination_creation(self):
        for explanation in ("synthetic filesystem root alias", "synthetic unreadable mountinfo"):
            with self.subTest(explanation=explanation):
                self.guard.side_effect = RuntimeError(explanation)
                with self.assertRaisesRegex(RuntimeError, explanation):
                    state.fresh_path(self.target, [self.protected])
                self.assertFalse(self.target.exists())

    def test_missing_guard_fails_closed(self):
        with patch.object(helper.importlib, "import_module", side_effect=ImportError("synthetic missing")):
            with self.assertRaisesRegex(RuntimeError, "guard unavailable"):
                state.fresh_path(self.target)
        self.assertFalse(self.target.exists())

    def test_unsupported_platform_explicit(self):
        with patch.object(helper.sys, "platform", "darwin"):
            with self.assertRaisesRegex(RuntimeError, "unsupported.*macOS pending"):
                state.fresh_path(self.target)
        self.guard.assert_not_called()

    def test_lexical_overlap_still_refused_before_guard(self):
        with self.assertRaisesRegex(RuntimeError, "overlaps"):
            state.fresh_path(self.protected / "new", [self.protected])
        self.guard.assert_not_called()

    def test_install_alias_refusal_precedes_port_and_home_mutation(self):
        self.guard.side_effect = RuntimeError("synthetic mount alias")
        with patch.object(state, "unprivileged"), \
             patch.object(state, "package", return_value=(self.protected, {})), \
             patch.object(state, "free_port") as port:
            with self.assertRaisesRegex(RuntimeError, "synthetic mount alias"):
                state.initialize(self.target, self.protected, 48123)
        port.assert_not_called()
        self.assertFalse(self.target.exists())

    def test_intake_preflight_uses_guard_before_binary_or_socket(self):
        self.guard.side_effect = RuntimeError("synthetic mount alias")
        with self.assertRaisesRegex(RuntimeError, "synthetic mount alias"):
            helper.preflight(self.root / "missing-binary", self.target, 48123, {})
        self.assertFalse(self.target.exists())

    def test_backup_guard_precedes_sqlite_and_output_creation(self):
        self.guard.side_effect = RuntimeError("synthetic mount alias")
        with patch.object(recovery, "unprivileged"), \
             patch.object(recovery, "private_home", return_value=self.protected), \
             patch.object(recovery, "readonly") as database:
            with self.assertRaisesRegex(RuntimeError, "synthetic mount alias"):
                recovery.backup(self.protected, self.target)
        database.assert_not_called()
        self.assertFalse(self.target.exists())

    def test_upgrade_alias_does_not_copy_or_select_release(self):
        self.guard.side_effect = RuntimeError("synthetic mount alias")
        with patch.object(state, "unprivileged"), \
             patch.object(state, "private_home", return_value=self.protected), \
             patch.object(state, "locked", return_value=nullcontext()), \
             patch.object(state, "config", return_value={}), \
             patch.object(state, "package", return_value=(self.target, {})), \
             patch.object(state, "add_release") as copy:
            with self.assertRaisesRegex(RuntimeError, "synthetic mount alias"):
                state.upgrade(self.protected, self.root)
        copy.assert_not_called()

    def test_restore_preview_alias_refused_without_target_mutation(self):
        self.guard.side_effect = RuntimeError("synthetic mount alias")
        with patch.object(recovery, "unprivileged"), \
             patch.object(recovery, "private_home", return_value=self.protected), \
             patch.object(recovery, "locked", return_value=nullcontext()), \
             patch.object(recovery, "config", return_value={"release": "synthetic"}), \
             patch.object(recovery, "package"), \
             patch.object(recovery, "validate_snapshot", return_value=(self.target, {})) as validate:
            with self.assertRaisesRegex(RuntimeError, "synthetic mount alias"):
                recovery.restore_preview(self.protected, self.target)
        validate.assert_not_called()
        self.assertEqual(list(self.protected.iterdir()), [])

    def test_existing_home_root_alias_refused(self):
        self.protected.chmod(0o700)
        self.guard.side_effect = RuntimeError("synthetic existing home alias")
        with self.assertRaisesRegex(RuntimeError, "synthetic existing home alias"):
            state.private_home(self.protected)
        self.assertEqual(list(self.protected.iterdir()), [])

    def test_existing_home_child_alias_refused(self):
        self.protected.chmod(0o700)
        for name in ("data", "logs", "control", "releases", "provider-home"):
            (self.protected / name).mkdir(mode=0o700)
        def identity(candidate, protected):
            if candidate.name == "logs":
                self.assertIn(self.protected / "data", protected)
                raise RuntimeError("synthetic sibling alias")
            return candidate
        self.guard.side_effect = identity
        with self.assertRaisesRegex(RuntimeError, "synthetic sibling alias"):
            state.private_home(self.protected)
        self.assertEqual(len(list(self.protected.iterdir())), 5)

    def test_fresh_path_uses_guard_returned_canonical_path(self):
        canonical = self.root / "canonical-target"
        self.guard.side_effect = None
        self.guard.return_value = canonical
        self.assertEqual(state.fresh_path(self.target, [self.protected]), canonical)

    def test_upgrade_uses_guard_returned_canonical_source(self):
        canonical = self.root / "canonical-source"
        self.guard.side_effect = None
        self.guard.return_value = canonical
        with patch.object(state, "unprivileged"), \
             patch.object(state, "private_home", return_value=self.protected), \
             patch.object(state, "locked", return_value=nullcontext()), \
             patch.object(state, "config", return_value={}), \
             patch.object(state, "package", return_value=(self.target, {})), \
             patch.object(state, "add_release", return_value=("synthetic", {})) as copy, \
             patch.object(state, "replace_json"):
            state.upgrade(self.protected, self.target)
        copy.assert_called_once_with(self.protected, canonical)

    def test_packaged_home_with_no_external_roots_has_explicit_protections(self):
        self.protected.chmod(0o700)
        for name in ("data", "logs", "control", "releases", "provider-home"):
            (self.protected / name).mkdir(mode=0o700)
        with patch.object(state, "protected_roots", return_value=[]):
            self.assertEqual(state.private_home(self.protected), self.protected)
        self.assertEqual(self.guard.call_count, 5)
        for call in self.guard.call_args_list:
            self.assertIn(self.protected / "install.json", call.args[1])
            self.assertIn(self.protected / "launcher.lock", call.args[1])

    def test_package_inventory_includes_guard_dependency(self):
        spec = importlib.util.spec_from_file_location("path_wiring_builder", LOCAL.parent / "packaging/package.py")
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        self.assertIn("path_identity.py", builder.TOOLS)


if __name__ == "__main__":
    unittest.main()
