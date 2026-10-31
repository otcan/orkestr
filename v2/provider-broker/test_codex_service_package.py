"""Explicit root run: protected dummy package, fixed synthetic ELF, local IPC."""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import time
import unittest
from unittest.mock import patch

from codex_bounded.trust import digest, exists, process, protected, Refused as TrustRefused
from codex_service.contract import Refused
from codex_service.custody import StateLock, OwnedSocket
from codex_service.manager import Manager
from codex_service.package import CODEX_QUOTA_FILE_ENV, DESKTOP_BROKER_ENV, TIMER_CONFIG_ENV, V1_CHAT_ICONS_ENV, LIVE_MAP_ENV, METRICS_BIND_ENV, ACCESS_LOG_ENV, WHATSAPP_CHATS_ENV, Package, live_map_path
from codex_service_fixture import ServiceFixture, UID, GID


class LiveMapPathTests(unittest.TestCase):
    def test_optional_live_map_is_absolute_and_only_reaches_server_environment(self):
        self.assertEqual(live_map_path("/var/lib/synthetic/map.json"), "/var/lib/synthetic/map.json")
        for bad in ("relative/map.json", "/", "/var/../map.json", "/x\0y", "/x\ny", 7, None, "/" + "a" * 4096):
            with self.assertRaises(Refused):
                live_map_path(bad)
        stub = object.__new__(Package)
        stub.provider_home, stub.data, stub.root = Path("/p"), Path("/d"), Path("/r")
        stub.runtime = {"port": 19842, "trusted_origin": "https://example.invalid"}
        stub.live_map = None
        self.assertNotIn(LIVE_MAP_ENV, Package.environment(stub))
        self.assertEqual(Package.environment(stub)[METRICS_BIND_ENV], "127.0.0.1:19843")
        self.assertEqual(Package.environment(stub)[ACCESS_LOG_ENV], "quiet")
        stub.runtime = {**stub.runtime, "metrics_port": 19850}
        self.assertEqual(Package.environment(stub)[METRICS_BIND_ENV], "127.0.0.1:19850")
        stub.runtime = {"port": 19842, "trusted_origin": "https://example.invalid"}
        stub.live_map = "/var/lib/synthetic/map.json"
        self.assertEqual(Package.environment(stub)[LIVE_MAP_ENV], "/var/lib/synthetic/map.json")
        self.assertNotIn(DESKTOP_BROKER_ENV, Package.environment(stub))
        stub.desktop_broker = "/var/lib/synthetic/desktop-broker.json"
        self.assertEqual(Package.environment(stub)[DESKTOP_BROKER_ENV], "/var/lib/synthetic/desktop-broker.json")
        self.assertNotIn(TIMER_CONFIG_ENV, Package.environment(stub))
        stub.timer_config = "/var/lib/synthetic/timers.json"
        self.assertEqual(Package.environment(stub)[TIMER_CONFIG_ENV], "/var/lib/synthetic/timers.json")
        self.assertNotIn(V1_CHAT_ICONS_ENV, Package.environment(stub))
        stub.v1_chat_icons_dir = "/var/lib/synthetic/icons"
        self.assertEqual(Package.environment(stub)[V1_CHAT_ICONS_ENV], "/var/lib/synthetic/icons")
        self.assertNotIn(WHATSAPP_CHATS_ENV, Package.environment(stub))
        stub.whatsapp_chats = "/var/lib/synthetic/whatsapp-chats.json"
        self.assertEqual(Package.environment(stub)[WHATSAPP_CHATS_ENV], "/var/lib/synthetic/whatsapp-chats.json")
        # The Codex quota projection file for the server's parallel Deep gate.
        self.assertNotIn(CODEX_QUOTA_FILE_ENV, Package.environment(stub))
        stub.codex_quota_file = "/var/lib/orkestr-provider-quota/codex.json"
        self.assertEqual(Package.environment(stub)[CODEX_QUOTA_FILE_ENV],
                         "/var/lib/orkestr-provider-quota/codex.json")


@unittest.skipUnless(os.geteuid() == 0, "explicit root run required for protected synthetic fixture")
class PackageTests(unittest.TestCase):
    def setUp(self):
        self.fixture = ServiceFixture()
        self.addCleanup(self.fixture.close)
        self.receipt = self.fixture.prepare()
        self.root = self.fixture.package

    def test_package_and_environment_never_read_dummy_account_or_select_other_mode(self):
        original = Path.open
        def guarded(path, *args, **kwargs):
            self.assertNotEqual(path, self.fixture.auth)
            return original(path, *args, **kwargs)
        with patch.object(Path, "open", guarded):
            package = Package(self.root, self.receipt["manifest_sha256"])
        environment = package.environment()
        self.assertIn("ORKESTR_V2_BETA_CONFIG", environment)
        self.assertEqual(environment["ORKESTR_V2_UI_DIST"], str(self.root / "ui"))
        self.assertNotIn("ORKESTR_V2_EXECUTION_CONFIG", environment)
        self.assertNotIn("CODEX_HOME", environment)
        self.assertNotIn("ORKESTR_V2_LIVE_MAP", environment)
        self.assertFalse(package.control.exists())
        self.assertFalse(package.endpoint.exists())
        self.assertEqual(list(self.fixture.account.iterdir()), [])

    def test_running_package_rechecks_root_owned_bytecode_without_relaxing_inventory(self):
        package = Package(self.root, self.receipt["manifest_sha256"])
        cache = self.root / "broker/__pycache__"
        cache.mkdir(mode=0o750)
        artifact = cache / "synthetic.cpython-312.pyc"
        artifact.write_bytes(b"synthetic bytecode")
        artifact.chmod(0o640)
        with self.assertRaisesRegex(Refused, "unexpected_package_file"):
            package.verify_inventory()
        artifact.unlink()
        cache.rmdir()
        package.verify_inventory()

    def test_fixture_owns_protected_ancestry_without_relaxing_writable_parent_refusal(self):
        self.assertEqual(self.fixture.root.parent, Path("/"))
        self.assertEqual(protected(self.root, True), self.root)
        delegated = self.fixture.root / "synthetic-delegated-parent"
        delegated.mkdir(mode=0o755)
        delegated.chmod(0o777)
        child = delegated / "package"
        child.mkdir(mode=0o755)
        with self.assertRaisesRegex(TrustRefused, "protected_package_required"):
            protected(child, True)

    def test_fixed_no_site_entry_rejects_missing_flags_before_package_import(self):
        for options in (("-I", "-B"), ("-S", "-B"), ("-I", "-S")):
            result = subprocess.run([str(Path("/usr/bin/python3").resolve()), *options,
                str(self.root / "codex_service/entry.py"), "broker", "invalid"],
                env={"PATH": "/usr/bin:/bin"}, capture_output=True, timeout=3)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stderr, b"selected Codex service entry refused\n")
        self.assertFalse((self.fixture.endpoint / "control.sock").exists())

    def test_hash_drift_and_rehashed_cross_binding_refuse(self):
        source = self.root / "codex_service/contract.py"
        source.write_bytes(source.read_bytes() + b"\n# synthetic drift\n")
        result = subprocess.run([str(self.root / "manager.py"), self.receipt["manifest_sha256"]],
            env={"PATH": "/usr/bin:/bin"}, capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 2)
        self.assertFalse((self.fixture.endpoint / "control.sock").exists())
        self.fixture.alter("profile.json", lambda value: value.update(hosts=["example.invalid"]))
        manifest = self.root / "manifest.json"
        value = json.loads(manifest.read_text())
        value["files"]["codex_service/contract.py"] = digest(source)
        manifest.write_text(json.dumps(value))
        with self.assertRaisesRegex(Refused, "profile_binding"):
            Package(self.root)

    def test_os_managed_dependencies_are_held_to_custody_not_bytes(self):
        # An unattended ca-certificates/python/bwrap update must not refuse the
        # release: the packaging-time hash is evidence, custody is enforced.
        from codex_service_fixture import packager
        manifest = self.root / "manifest.json"
        value = json.loads(manifest.read_text())
        for name in value["dependencies"]:
            value["dependencies"][name] = "0" * 64
        manifest.write_bytes(packager.encoded(value))
        package = Package(self.root, digest(manifest))
        self.assertEqual(set(package.manifest["dependencies"]), set(value["dependencies"]))
        value["dependencies"][next(iter(value["dependencies"]))] = "not-a-hash"
        manifest.write_bytes(packager.encoded(value))
        with self.assertRaisesRegex(Refused, "dependency_hash"):
            Package(self.root, digest(manifest))

    def test_manager_seal_lets_children_skip_rehash_but_never_hides_changes(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("sealed_entry", self.root / "codex_service/entry.py")
        entry = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(entry)
        time.sleep(1.1)  # Only settled ctimes are sealed.
        manifest_digest, records = entry.verified(self.root, self.receipt["manifest_sha256"])
        self.assertEqual(manifest_digest, self.receipt["manifest_sha256"])
        self.assertTrue(records)
        self.assertNotIn(str(Path("/etc/ssl/certs/ca-certificates.crt").resolve()),
                         {key[0] for key in records})  # OS files: custody only.
        self.assertTrue(entry.write_seal(self.fixture.endpoint, GID, self.root, manifest_digest, records))
        seal = self.fixture.endpoint / entry.SEAL
        self.assertEqual((seal.stat().st_uid, seal.stat().st_gid, seal.stat().st_mode & 0o777), (0, GID, 0o640))
        hashed = []
        original = entry.digest
        def counting(path):
            hashed.append(str(path))
            return original(path)
        with patch.object(entry, "digest", counting):
            entry.verified(self.root, None, sealed=True)
        self.assertEqual(hashed, [str(self.root / "manifest.json")])
        # A rewritten file has a new identity: it is hashed and refused.
        source = self.root / "codex_service/contract.py"
        source.write_bytes(source.read_bytes() + b"\n# synthetic drift\n")
        with patch.object(entry, "digest", counting), self.assertRaisesRegex(ValueError, "package digest"):
            entry.verified(self.root, None, sealed=True)
        self.assertIn(str(source), hashed)
        # A seal for another release root is ignored.
        value = json.loads(seal.read_text())
        value["root"] = "/elsewhere"
        seal.write_text(json.dumps(value))
        self.assertEqual(entry.read_seal(self.root, manifest_digest), {})

    def test_host_natives_carry_exactly_their_pinned_code_mode_host(self):
        from codex_service_fixture import packager
        access = {"providers": True, "environment": {"HOME": "/synthetic", "PATH": "/usr/bin:/bin"}}
        self.fixture.alter("beta.json", lambda value: value.update(host_full_access=access))
        with self.assertRaisesRegex(Refused, "code_mode_host_inventory"):
            Package(self.root, self.fixture.receipt["manifest_sha256"])
        host = self.root / "codex-code-mode-host"
        packager.write(host, b"synthetic code-mode host", GID, 0o550)
        manifest = self.root / "manifest.json"
        value = json.loads(manifest.read_text())
        value["files"]["codex-code-mode-host"] = digest(host)
        manifest.write_bytes(packager.encoded(value))
        self.fixture.receipt["manifest_sha256"] = digest(manifest)
        package = Package(self.root, self.fixture.receipt["manifest_sha256"])
        self.assertIn("codex-code-mode-host", package.manifest["files"])
        # A sandboxed provider never carries one.
        self.fixture.alter("beta.json", lambda value: value.pop("host_full_access"))
        with self.assertRaisesRegex(Refused, "code_mode_host_inventory"):
            Package(self.root, self.fixture.receipt["manifest_sha256"])

    def test_actual_dropped_uid_peer_and_ordered_shutdown(self):
        manager = Manager(self.root, self.receipt["manifest_sha256"])
        try:
            manager.start()
            identity = dict(manager.identity)
            self.assertEqual(identity["uid"], UID)
            report = self.fixture.home / "data/synthetic-peer.json"
            deadline = time.monotonic() + 4
            while not report.exists() and time.monotonic() < deadline:
                manager.once()
            self.assertTrue(report.exists())
            self.assertTrue(json.loads(report.read_text())["ok"])
            self.assertEqual(Path(f"/proc/{identity['pid']}/exe").resolve(), self.root / "server")
            self.assertEqual(manager.ledger.status()["state"], "idle")
        finally:
            self.assertTrue(manager.close())
        self.assertFalse(exists(identity))
        self.assertFalse((self.fixture.endpoint / "control.sock").exists())

    def test_singleton_and_replaced_socket_refuse_without_unlink(self):
        manager = Manager(self.root, self.receipt["manifest_sha256"])
        try:
            with self.assertRaises(BlockingIOError):
                StateLock(self.fixture.ledger_directory)
            original = manager.control.identity
            manager.control.path.unlink()
            other = socket.socket(socket.AF_UNIX)
            other.bind(str(manager.control.path))
            self.addCleanup(other.close)
            with self.assertRaisesRegex(Refused, "socket_replaced"):
                manager.control.close()
            self.assertNotEqual(original, (manager.control.path.stat().st_dev, manager.control.path.stat().st_ino))
            self.assertTrue(manager.control.path.exists())
        finally:
            self.assertFalse(manager.close())

    def test_manager_abrupt_death_triggers_server_parent_death(self):
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        old = ctypes.c_int()
        self.assertEqual(libc.prctl(37, ctypes.byref(old), 0, 0, 0), 0)
        self.assertEqual(libc.prctl(36, 1, 0, 0, 0), 0)
        child = subprocess.Popen([str(self.root / "manager.py"), self.receipt["manifest_sha256"]],
            env={"PATH": "/usr/bin:/bin"}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        identity = None
        try:
            deadline = time.monotonic() + 4
            report = self.fixture.home / "data/synthetic-peer.json"
            while not report.exists() and time.monotonic() < deadline:
                self.assertIsNone(child.poll())
                time.sleep(.01)
            self.assertTrue(report.exists())
            for pid in Path(f"/proc/{child.pid}/task/{child.pid}/children").read_text().split():
                selected = process(int(pid))
                if selected and Path(f"/proc/{pid}/exe").resolve() == self.root / "server":
                    identity = selected
            self.assertIsNotNone(identity)
            child.kill();child.wait(3)
            deadline = time.monotonic() + 3
            while exists(identity) and time.monotonic() < deadline:
                try:
                    os.waitpid(identity["pid"], os.WNOHANG)
                except ChildProcessError:
                    pass
                time.sleep(.01)
            self.assertFalse(exists(identity))
            successor = Manager(self.root, self.receipt["manifest_sha256"])
            self.assertTrue(successor.close())
        finally:
            if child.poll() is None:
                child.kill();child.wait(3)
            if identity and exists(identity):
                os.kill(identity["pid"], signal.SIGKILL)
                os.waitpid(identity["pid"], 0)
            libc.prctl(36, old.value, 0, 0, 0)


if __name__ == "__main__":
    unittest.main()
