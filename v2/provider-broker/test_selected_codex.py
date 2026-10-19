"""Independent configuration/ownership refusals and real dropped-UID lifecycle."""
import importlib
import ctypes
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

from codex_bounded.configuration import Package
from codex_bounded.controller import Runtime
from codex_bounded.profile import Configuration
from codex_bounded.trust import Refused, digest, exists, process
from selected_codex_fixture import Fixture, GID, UID, packager


@unittest.skipUnless(os.geteuid() == 0, "protected package and dropped-UID tests require explicit root test run")
class PackageTests(unittest.TestCase):
    def setUp(self):
        self.fixture = Fixture()
        self.addCleanup(self.fixture.close)

    def package(self):
        receipt = self.fixture.prepare()
        return Package(receipt["package"], receipt["manifest_sha256"])

    def server_ready(self, runtime, package):
        # Observe the synthetic server's installed handler, not a sleep or the
        # short-lived Python exec shim, before asserting graceful shutdown.
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            self.assertIsNone(runtime.child.poll())
            pid = runtime.child.pid
            status = Path(f"/proc/{pid}/status").read_text().splitlines()
            caught = int(next(line.split()[1] for line in status if line.startswith("SigCgt:")), 16)
            if caught & (1 << (2 - 1)) and Path(f"/proc/{pid}/exe").resolve() == package.root / "server":
                return
            time.sleep(.02)
        self.fail("synthetic graceful signal handler did not become ready")

    def test_fresh_package_reads_no_account_and_starts_nothing(self):
        original = Path.open
        auth = self.fixture.auth
        def guarded(path, *args, **kwargs):
            self.assertNotEqual(path, auth, "packaging tried to open synthetic account")
            return original(path, *args, **kwargs)
        with patch.object(Path, "open", guarded):
            package = self.package()
        self.assertFalse(package.endpoint.exists())
        self.assertEqual(list(self.fixture.account.iterdir()), [])
        self.assertFalse((package.endpoint.parent / "window.started").exists())
        self.assertFalse(self.fixture.receipt["provider_invoked"])
        self.assertNotIn("CODEX_HOME", package.environment())
        with self.assertRaises(Refused):
            digest(auth)

    def test_mixed_source_binary_refused_before_destination_creation(self):
        self.fixture.plan["source_commit"] = "e" * 40
        with self.assertRaisesRegex(Refused, "same_commit_server"):
            self.fixture.prepare()
        self.assertFalse(Path(self.fixture.plan["output"]).exists())

    def test_profile_cross_binding_and_extra_hosts_refused_even_when_rehashed(self):
        self.package()
        self.fixture.alter("profile.json", lambda value: value.update(hosts=["example.invalid"]))
        with self.assertRaisesRegex(Refused, "artifact_binding"):
            Package(**dict(root=self.fixture.receipt["package"]))

    def test_wrong_native_artifact_refused_even_when_rehashed(self):
        self.package()
        self.fixture.alter("profile.json", lambda value: value.update(native=str(self.fixture.server)))
        with self.assertRaisesRegex(Refused, "artifact_binding"):
            Package(self.fixture.receipt["package"])

    def test_workspace_substitution_refused(self):
        self.package()
        self.fixture.alter("profile.json", lambda value: value.update(workspace=str(self.fixture.account)))
        with self.assertRaisesRegex(Refused, "workspace_binding"):
            Package(self.fixture.receipt["package"])

    def test_changed_execution_config_and_extra_import_refused(self):
        package = self.package()
        config = self.fixture.home / "selected-execution.json"
        config.write_bytes(config.read_bytes() + b" ")
        with self.assertRaisesRegex(Refused, "execution_config_pin"):
            Package(package.root)
        (package.root / "broker/shadow.py").write_text("# must never import\n")
        with self.assertRaisesRegex(Refused, "unexpected_package_file"):
            Package(package.root)

    def test_bool_or_unbounded_lifetime_is_refused(self):
        self.package()
        for value in (True, 0, 901, -1):
            self.fixture.alter("runtime.json", lambda v: v.update(lifetime_seconds=value))
            with self.subTest(value=value), self.assertRaisesRegex(Refused, "finite_controller_lifetime"):
                Package(self.fixture.receipt["package"])

    def test_one_use_command_and_readonly_mounts_under_actual_executor_uid(self):
        package = self.package()
        with socket.socket(socket.AF_UNIX) as listener:
            listener.bind(str(package.endpoint))
            os.chown(package.endpoint, 0, GID)
            package.endpoint.chmod(0o660)
            old_uid, old_gid = os.geteuid(), os.getegid()
            try:
                os.setegid(GID);os.seteuid(UID)
                config = Configuration(package.root)
                command, descriptors = config.isolated_command()
                try:
                    self.assertEqual(command[-1], "codex-bounded")
                    index = command.index(str(self.fixture.auth))
                    self.assertEqual(command[index-1:index+2], ["--ro-bind", str(self.fixture.auth), "/account/auth.json"])
                    for kind in ("user", "pid", "net", "ipc", "uts", "cgroup"):
                        self.assertIn("--unshare-" + kind, command)
                    self.assertIn("--die-with-parent", command)
                    self.assertIn("--disable-userns", command)
                    self.assertEqual(len(descriptors), 1)
                    with self.assertRaisesRegex(Refused, "already_issued"):
                        config.isolated_command()
                finally:
                    for descriptor in descriptors:os.close(descriptor)
            finally:
                os.seteuid(old_uid);os.setegid(old_gid)
                package.endpoint.unlink()

    def test_actual_dropped_uid_server_replacement_keeps_budget_and_forbids_reset(self):
        package = self.package()
        runtime = Runtime(package.root, self.fixture.receipt["manifest_sha256"])
        self.addCleanup(runtime.close)
        first = runtime.start()
        self.assertEqual(first["uid"], UID)
        self.server_ready(runtime, package)
        runtime.budget.attempt()
        created = runtime.budget.created
        runtime.stop_server()
        self.assertFalse(exists(first))
        second = runtime.start()
        self.server_ready(runtime, package)
        self.assertNotEqual((first["pid"], first["start"]), (second["pid"], second["start"]))
        self.assertEqual(runtime.budget.created, created)
        self.assertEqual(runtime.budget.attempts, 1)
        runtime.close()
        self.assertFalse(exists(second))
        self.assertFalse(package.endpoint.exists())
        self.assertFalse(runtime.forced)
        with self.assertRaises(FileExistsError):
            Runtime(package.root, self.fixture.receipt["manifest_sha256"]).start()

    def test_bad_operations_and_missing_private_descriptors_never_start_native(self):
        package = self.package()
        with socket.socket(socket.AF_UNIX) as endpoint:
            endpoint.bind(str(package.endpoint));os.chown(package.endpoint, 0, GID);package.endpoint.chmod(0o660)
            try:
                for arguments in ([], ["open-owned-worker-session", "--protocol", "orkestr-v2-provider-broker-v1"],
                        ["open-owned-session", "--protocol", "unknown"],
                        ["open-owned-session", "--protocol", "orkestr-v2-provider-broker-v1"],
                        ["resume-owned-session", "--protocol", "orkestr-v2-provider-broker-v1"]):
                    with self.subTest(arguments=arguments):
                        child = subprocess.run(["/usr/bin/python3", "-I", "-B", str(package.root / "launcher.py"),
                            *arguments], user=UID, group=GID, extra_groups=[], close_fds=True,
                            env={"PATH": "/usr/bin:/bin"}, timeout=3, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                        self.assertEqual(child.returncode, 2)
                        self.assertEqual(child.stdout, b"")
                        self.assertNotIn(b"synthetic-account-only", child.stderr)
                        self.assertEqual(list(self.fixture.account.iterdir()), [])
            finally:
                package.endpoint.unlink()

    def test_forced_stubborn_server_cleanup_permanently_refuses_replacement(self):
        fixture = Fixture(stubborn=True)
        self.addCleanup(fixture.close)
        receipt = fixture.prepare()
        package = Package(receipt["package"], receipt["manifest_sha256"])
        runtime = Runtime(package.root, receipt["manifest_sha256"])
        self.addCleanup(runtime.close)
        identity = runtime.start()
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            self.assertIsNone(runtime.child.poll())
            status = Path(f"/proc/{identity['pid']}/status").read_text().splitlines()
            ignored = int(next(line.split()[1] for line in status if line.startswith("SigIgn:")), 16)
            if ignored & (1 << (2 - 1)) and Path(f"/proc/{identity['pid']}/exe").resolve() == package.root / "server":
                break
            time.sleep(.02)
        else:
            self.fail("finite stubborn synthetic server did not become ready")
        with self.assertRaisesRegex(Refused, "owned_cleanup_incomplete"):
            runtime.stop_server()
        self.assertTrue(runtime.forced)
        self.assertFalse(exists(identity))
        self.assertFalse(package.endpoint.exists())
        self.assertIsNone(runtime.child)
        self.assertIsNone(runtime.listener)
        self.assertIsNone(runtime.egress)
        # A second cleanup can finish, but must never restore launch authority.
        runtime.stop_server()
        with patch("codex_bounded.controller.subprocess.Popen") as launch:
            with self.assertRaisesRegex(Refused, "execution_window_unusable"):
                runtime.start()
            launch.assert_not_called()
        self.assertTrue(runtime.snapshot()["window_poisoned"])

    def test_recovered_egress_cleanup_error_does_not_restore_replacement_authority(self):
        package = self.package()
        runtime = Runtime(package.root, self.fixture.receipt["manifest_sha256"])
        self.addCleanup(runtime.close)
        identity = runtime.start()
        self.server_ready(runtime, package)
        endpoint = runtime.egress
        original_close = endpoint.close
        def completed_then_failed():
            original_close()
            raise RuntimeError("synthetic cleanup result lost")
        with patch.object(endpoint, "close", completed_then_failed):
            with self.assertRaisesRegex(Refused, "owned_cleanup_incomplete"):
                runtime.stop_server()
        self.assertFalse(exists(identity))
        self.assertFalse(package.endpoint.exists())
        self.assertIs(runtime.egress, endpoint)
        runtime.stop_server()
        self.assertIsNone(runtime.egress)
        self.assertFalse(runtime.forced)
        with patch("codex_bounded.controller.subprocess.Popen") as launch:
            with self.assertRaisesRegex(Refused, "execution_window_unusable"):
                runtime.start()
            launch.assert_not_called()
        self.assertTrue(runtime.snapshot()["window_poisoned"])

    def test_controller_death_stops_exact_dropped_uid_server(self):
        from reaping import become_subreaper
        libc = ctypes.CDLL(None, use_errno=True)
        previous_subreaper = ctypes.c_int()
        self.assertEqual(libc.prctl(37, ctypes.byref(previous_subreaper), 0, 0, 0), 0)
        become_subreaper()  # Reap only this test's identified grandchild below.
        package = self.package()
        controller = subprocess.Popen(["/usr/bin/python3", "-I", "-B", str(package.root / "controller.py"),
            self.fixture.receipt["manifest_sha256"]], env={"PATH": "/usr/bin:/bin"},
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        identity = None
        try:
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                self.assertIsNone(controller.poll())
                path = Path(f"/proc/{controller.pid}/task/{controller.pid}/children")
                for pid in path.read_text().split():
                    item = process(int(pid))
                    try:
                        if item and item["uid"] == UID and Path(f"/proc/{pid}/exe").resolve() == package.root / "server":
                            identity = item
                    except OSError:
                        pass
                if identity:break
                time.sleep(.02)
            self.assertIsNotNone(identity, "fixed server exec never became observable")
            controller.kill();controller.wait(timeout=3)
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                try:os.waitpid(identity["pid"], os.WNOHANG)
                except ChildProcessError:pass
                if not exists(identity):break
                time.sleep(.02)
            self.assertFalse(exists(identity), "parent death did not reap the selected server")
            self.assertTrue((package.endpoint.parent / "window.started").is_file())
        finally:
            if controller.poll() is None:controller.kill();controller.wait(timeout=3)
            if identity and exists(identity):
                os.kill(identity["pid"], 9)
                os.waitpid(identity["pid"], 0)
            self.assertEqual(libc.prctl(36, previous_subreaper.value, 0, 0, 0), 0)


class BootstrapTests(unittest.TestCase):
    def test_fd4_validation_remains_product_owned(self):
        # No new decoder/config selector: exercise the public decoder's existing
        # oversized/unknown/missing/duplicate refusal matrix in its own suite.
        from codex_bounded.broker import modules
        import types
        with patch.dict(sys.modules, {"protocol": types.SimpleNamespace(__file__="/unrelated/protocol.py")}):
            with self.assertRaisesRegex(Refused, "import_origin"):
                modules(Path(__file__).parent)


if __name__ == "__main__":
    unittest.main()
