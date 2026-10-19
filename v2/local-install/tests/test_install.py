"""Synthetic filesystem/SQLite install tests. No server, provider or listener runs."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

LOCAL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LOCAL))
import install_state as state
import launcher
import recovery

SPEC = importlib.util.spec_from_file_location("package_builder", LOCAL.parent / "packaging" / "package.py")
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="v2-install-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.binary = self.root / "fake-server"
        self.binary.write_text("#!/bin/sh\n# Synthetic, never executed.\nexit 0\n")
        self.binary.chmod(0o700)
        self.package = self.root / "package"
        builder.assemble(self.binary, self.package, "0.1.0-fixture", "a" * 40)
        self.home = self.root / "home"
        self.port = patch.object(state, "free_port")
        self.port.start()
        self.addCleanup(self.port.stop)

    def install(self):
        return state.initialize(self.home, self.package, 48123)

    def database(self, home=None):
        path = (home or self.home) / "data" / "core.sqlite3"
        db = sqlite3.connect(path)
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("CREATE TABLE fixture_messages (id INTEGER PRIMARY KEY, text TEXT)")
        db.execute("INSERT INTO fixture_messages VALUES (1, 'synthetic only')")
        db.commit()
        self.addCleanup(db.close)
        return db

    def test_clean_install_version_doctor_without_execution(self):
        with patch.object(launcher, "start") as start:
            self.install()
            report = launcher.doctor(self.home)
        start.assert_not_called()
        self.assertEqual(report["version"], "0.1.0-fixture")
        self.assertEqual(report["source_commit"], "a" * 40)
        self.assertEqual(report["launcher"], "stopped")
        self.assertEqual(report["health"], "unexecuted")
        self.assertEqual(self.home.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.home / "control/bootstrap.token").stat().st_mode & 0o777, 0o600)
        self.assertEqual(list((self.home / "data").iterdir()), [])

    def test_packaged_cli_version_and_doctor_are_runnable_without_server(self):
        self.install()
        entrypoint = self.package / "bin/orkestr-v2"
        for command in ("version", "doctor"):
            response = subprocess.run([str(entrypoint), command, "--home", str(self.home)],
                                      capture_output=True, text=True, timeout=5, check=True)
            report = json.loads(response.stdout)
            self.assertEqual(report["version"], "0.1.0-fixture")
        state.package(self.package)  # Running CLI must not create untracked bytecode in package.
        state.package(self.home / "releases" / state.config(self.home)["release"])

    def test_install_never_adopts_or_overwrites_home(self):
        self.home.mkdir()
        marker = self.home / "session.fixture"
        marker.write_text("synthetic existing state")
        with self.assertRaisesRegex(RuntimeError, "nonexistent"):
            self.install()
        self.assertEqual(marker.read_text(), "synthetic existing state")

    def test_root_refusal(self):
        with patch.object(os, "getuid", return_value=0), self.assertRaisesRegex(RuntimeError, "unprivileged"):
            self.install()
        self.assertFalse(self.home.exists())

    def test_package_tamper_and_invalid_version_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "version"):
            builder.assemble(self.binary, self.root / "bad", "../bad", "a" * 40)
        (self.package / "server/orkestr-v2-server").write_text("tampered fixture")
        with self.assertRaisesRegex(RuntimeError, "checksum"):
            self.install()
        self.assertFalse(self.home.exists())

    def test_package_symlinks_rejected(self):
        (self.package / "alias").symlink_to(self.binary)
        with self.assertRaisesRegex(RuntimeError, "symlinks"):
            state.package(self.package)

    def test_upgrade_keeps_data_auth_port_and_previous_release(self):
        self.install()
        self.database()
        before = state.sha256(self.home / "data/core.sqlite3")
        token = (self.home / "control/bootstrap.token").read_bytes()
        old = state.config(self.home)
        newer = self.root / "new-package"
        builder.assemble(self.binary, newer, "0.2.0-fixture", "b" * 40)
        with patch.object(launcher, "start") as start:
            state.upgrade(self.home, newer)
        start.assert_not_called()
        current = state.config(self.home)
        self.assertNotEqual(old["release"], current["release"])
        self.assertTrue((self.home / "releases" / old["release"]).is_dir())
        self.assertEqual(current["port"], old["port"])
        self.assertEqual(state.sha256(self.home / "data/core.sqlite3"), before)
        self.assertEqual((self.home / "control/bootstrap.token").read_bytes(), token)

    def test_busy_home_blocks_upgrade_backup(self):
        self.install()
        with state.locked(self.home):
            with self.assertRaisesRegex(RuntimeError, "busy"):
                state.upgrade(self.home, self.package)
            with self.assertRaisesRegex(RuntimeError, "busy"):
                recovery.backup(self.home, self.root / "snapshot")
        self.assertFalse((self.root / "snapshot").exists())

    def test_environment_excludes_inherited_auth_and_sets_explicit_ui(self):
        self.install()
        current, root, _ = launcher.release(self.home)
        with patch.dict(os.environ, {"OPENAI_API_KEY": "synthetic", "ORKESTR_HOME": "/fake/legacy", "ORKESTR_V2_MASTER_KEY": "synthetic"}):
            env = launcher.child_environment(self.home, root, current["port"])
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertNotIn("ORKESTR_HOME", env)
        self.assertNotIn("ORKESTR_V2_MASTER_KEY", env)
        self.assertEqual(env["ORKESTR_V2_HOME"], str(self.home / "data"))
        self.assertEqual(env["HOME"], str(self.home / "provider-home"))

    def test_sqlite_backup_includes_wal_and_leaves_source_unchanged(self):
        self.install()
        database = self.database()
        database.execute("INSERT INTO fixture_messages VALUES (2, 'committed WAL fixture')")
        database.commit()
        # Connection remains open so the backup must account for committed WAL pages.
        database_path = self.home / "data/core.sqlite3"
        original = state.sha256(database_path)
        snapshot = self.root / "snapshot"
        result = recovery.backup(self.home, snapshot)
        self.assertEqual(result["status"], "database snapshot verified")
        self.assertEqual(state.sha256(database_path), original)
        with contextlib.closing(sqlite3.connect(snapshot / "core.sqlite3")) as copied:
            self.assertEqual(copied.execute("SELECT count(*) FROM fixture_messages").fetchone()[0], 2)
        _, manifest = recovery.validate_snapshot(snapshot)
        self.assertTrue(manifest["contains_sensitive_database_auth"])
        self.assertEqual(snapshot.stat().st_mode & 0o777, 0o700)

    def test_backup_destination_and_tampered_snapshot_refused(self):
        self.install()
        self.database()
        with self.assertRaisesRegex(RuntimeError, "overlaps"):
            recovery.backup(self.home, self.home / "snapshot")
        output = self.root / "snapshot"
        recovery.backup(self.home, output)
        with self.assertRaisesRegex(RuntimeError, "nonexistent"):
            recovery.backup(self.home, output)
        (output / "core.sqlite3").write_bytes(b"tampered synthetic database")
        with self.assertRaisesRegex(RuntimeError, "checksum"):
            recovery.validate_snapshot(output)

    def test_snapshot_manifest_symlink_rejected_before_read(self):
        self.install()
        self.database()
        snapshot = self.root / "snapshot"
        recovery.backup(self.home, snapshot)
        external = self.root / "external-manifest.fixture"
        (snapshot / "manifest.json").rename(external)
        (snapshot / "manifest.json").symlink_to(external)
        with self.assertRaisesRegex(RuntimeError, "snapshot manifest symlink"):
            recovery.validate_snapshot(snapshot)
        self.assertTrue(external.is_file())

    def test_restore_preview_gates_apply_and_does_not_duplicate_auth(self):
        self.install()
        self.database()
        snapshot = self.root / "snapshot"
        recovery.backup(self.home, snapshot)
        target = self.root / "target"
        state.initialize(target, self.package, 48124)
        token = (target / "control/bootstrap.token").read_bytes()
        result = recovery.restore_preview(target, snapshot)
        self.assertEqual(result["apply"], "PENDING canonical Migration contract")
        self.assertEqual(list((target / "data").iterdir()), [])
        self.assertEqual((target / "control/bootstrap.token").read_bytes(), token)
        with self.assertRaisesRegex(RuntimeError, "empty"):
            recovery.restore_preview(self.home, snapshot)

    def test_foreground_launch_stop_only_owned_process_with_mocks(self):
        self.install()
        # Short mock control path avoids platform Unix socket length restrictions.
        path = Mock()
        path.is_symlink.return_value = False
        path.exists.return_value = False
        child = Mock()
        child.poll.return_value = None
        connection = Mock()
        connection.recv.return_value = b"stop\n"
        connection.__enter__ = Mock(return_value=connection)
        connection.__exit__ = Mock(return_value=False)
        with patch.object(launcher, "control_path", return_value=path), \
             patch.object(launcher, "free_port"), \
             patch.object(launcher.socket, "socket") as socket_mock, \
             patch.object(launcher, "start", return_value=child) as start, \
             patch.object(launcher, "stop") as stop, \
             contextlib.redirect_stdout(io.StringIO()):
            socket_mock.return_value.__enter__.return_value.accept.return_value = (connection, None)
            launcher.serve(self.home)
        start.assert_called_once()
        stop.assert_called_once_with(child)
        path.unlink.assert_called_once_with(missing_ok=True)
        connection.sendall.assert_called_once_with(b"stopping\n")

    def test_port_probe_reuses_closed_connections_and_refuses_occupant(self):
        self.port.stop()
        with patch.object(state.socket, "socket") as factory:
            probe = factory.return_value.__enter__.return_value
            state.free_port(48123)
            probe.setsockopt.assert_called_once_with(state.socket.SOL_SOCKET, state.socket.SO_REUSEADDR, 1)
            probe.bind.assert_called_once_with(("127.0.0.1", 48123))
            probe.bind.side_effect = OSError("synthetic occupant")
            with self.assertRaisesRegex(RuntimeError, "occupant will not be stopped"):
                state.free_port(48123)

    def test_ui_package_and_log_tail(self):
        ui = self.root / "ui"
        ui.mkdir()
        (ui / "index.html").write_text("<title>Synthetic V2</title>")
        output = self.root / "with-ui"
        builder.assemble(self.binary, output, "0.3.0-fixture", "c" * 40, ui)
        state.initialize(self.home, output, 48123)
        current, root, manifest = launcher.release(self.home)
        env = launcher.child_environment(self.home, root, current["port"])
        self.assertTrue(manifest["ui"])
        self.assertEqual(env["ORKESTR_V2_UI_DIST"], str(root / "ui"))
        (self.home / "logs/server.log").write_text("synthetic first\nsynthetic second\n")
        self.assertEqual(launcher.logs(self.home, 1), "synthetic second")


if __name__ == "__main__":
    unittest.main()
