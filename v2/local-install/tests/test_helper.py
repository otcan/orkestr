"""Offline mocks only: no server, listener, Docker, Cargo, credentials or provider."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location("helper", Path(__file__).parents[1] / "helper.py")
h = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(h)


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.binary = self.root / "fake-executable"
        self.binary.write_text("fixture only, never executed")
        self.binary.chmod(0o700)
        self.home = self.root / "fresh"
        self.socket = patch.object(h.socket, "socket")
        self.probe = self.socket.start()
        self.addCleanup(self.socket.stop)

    def check(self, **kwargs):
        return h.preflight(kwargs.get("binary", self.binary), kwargs.get("home", self.home),
                           kwargs.get("port", 48122), kwargs.get("environ", {}))

    def test_read_only_and_loopback(self):
        self.check()
        self.assertFalse(self.home.exists())
        self.probe.return_value.__enter__.return_value.bind.assert_called_once_with(("127.0.0.1", 48122))

    def test_existing_data_and_session_refused_without_changes(self):
        self.home.mkdir()
        session = self.home / "session.fixture"
        session.write_text("synthetic existing content")
        with self.assertRaisesRegex(RuntimeError, "must not exist"):
            self.check()
        self.assertEqual(session.read_text(), "synthetic existing content")

    def test_relative_missing_binary_and_port_errors(self):
        for kwargs, message in [({"home": "relative"}, "absolute"),
                                ({"binary": self.root / "missing"}, "existing executable"),
                                ({"port": 0}, "between"),
                                ({"environ": {"ORKESTR_HOME": "relative"}}, "existing absolute")]:
            with self.subTest(kwargs=kwargs), self.assertRaisesRegex(RuntimeError, message):
                self.check(**kwargs)
        self.binary.chmod(0o600)
        with self.assertRaisesRegex(RuntimeError, "existing executable"):
            self.check()

    def test_overlap_legacy_and_repository(self):
        with self.assertRaisesRegex(RuntimeError, "overlaps"):
            self.check(environ={"ORKESTR_HOME": str(self.root)})
        with self.assertRaisesRegex(RuntimeError, "overlaps"):
            self.check(home=Path(h.__file__).resolve().parents[2] / "fresh-fixture-home")
        self.assertTrue(h.overlap(self.root, self.home))
        self.assertTrue(h.overlap(self.home, self.root))

    def test_symlink_overlap_and_dangling_symlink(self):
        legacy = self.root / "legacy"
        legacy.mkdir()
        alias = self.root / "alias"
        alias.symlink_to(legacy, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "overlaps"):
            self.check(home=alias / "fresh", environ={"ORKESTR_HOME": str(legacy)})
        self.home.symlink_to(self.root / "missing")
        with self.assertRaisesRegex(RuntimeError, "must not exist"):
            self.check()

    def test_busy_port_does_not_stop_occupant(self):
        self.probe.return_value.__enter__.return_value.bind.side_effect = OSError("busy")
        with self.assertRaisesRegex(RuntimeError, "no occupant will be stopped"):
            self.check()

    def test_python_dependency_error(self):
        with patch.object(h.sys, "version_info", (3, 10)), self.assertRaisesRegex(RuntimeError, "3.11"):
            self.check()

    def test_environment_drops_provider_and_legacy_config(self):
        with patch.dict(os.environ, {"ORKESTR_HOME": "/fake-legacy", "OPENAI_API_KEY": "synthetic-only"}):
            env = h.environment(self.home, 48122)
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertNotIn("ORKESTR_HOME", env)
        self.assertEqual(env["HOME"], str(self.home))
        self.assertEqual(env["ORKESTR_V2_BIND"], "127.0.0.1:48122")
        self.assertGreaterEqual(len(env["ORKESTR_V2_BOOTSTRAP_TOKEN"]), 32)


class LifecycleTests(unittest.TestCase):
    def test_stop_only_owned_child_gracefully(self):
        process = Mock()
        process.poll.return_value = None
        h.stop(process)
        process.send_signal.assert_called_once_with(h.signal.SIGINT)
        process.kill.assert_not_called()

    def test_stop_timeout_kills_only_owned_child(self):
        process = Mock()
        process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired("fixture", 5), 0]
        h.stop(process)
        process.kill.assert_called_once()

    def test_start_and_health_failure_cleanup(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(h.subprocess, "Popen") as popen:
            process = popen.return_value
            process.poll.return_value = None
            client = Mock()
            self.assertIs(h.start(Path("/fake/binary"), Path(directory), {}, client), process)
            client.health.assert_called_once()
            client.health.side_effect = RuntimeError("wrong health identity")
            with self.assertRaisesRegex(RuntimeError, "identity"):
                h.start(Path("/fake/binary"), Path(directory), {}, client)
            process.send_signal.assert_called_once()

    def test_smoke_and_restart_orchestration_without_process_or_network(self):
        args = Mock(command="smoke", binary="unused", home="unused", port=48122)
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / "fresh"
            process = Mock()
            receipt = {"message_id": "fixture-message", "status": "accepted"}
            message = {"text": "synthetic"}
            client = Mock()
            client.request.return_value = (200, receipt)
            with patch.object(h, "preflight", return_value=(Path("/fake/binary"), home)), \
                 patch.object(h, "Client", return_value=client), \
                 patch.object(h, "start", return_value=process) as start, \
                 patch.object(h, "stop") as stop, \
                 patch.object(h, "smoke", return_value=("/conversations/fixture", receipt, message)), \
                 patch.object(h, "verify_history") as verify:
                with contextlib.redirect_stdout(io.StringIO()):
                    h.run(args)
                self.assertEqual(start.call_count, 2)
                self.assertEqual(stop.call_count, 2)
                verify.assert_called_once_with(client, "/conversations/fixture", receipt, message)
            self.assertTrue(home.is_dir())  # Never auto-delete retained data.

    def test_failed_smoke_stops_child_and_retains_home(self):
        args = Mock(command="smoke", binary="unused", home="unused", port=48122)
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / "fresh"
            process = Mock()
            with patch.object(h, "preflight", return_value=(Path("/fake/binary"), home)), \
                 patch.object(h, "Client"), \
                 patch.object(h, "start", return_value=process), \
                 patch.object(h, "stop") as stop, \
                 patch.object(h, "smoke", side_effect=RuntimeError("fixture failure")), \
                 contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(RuntimeError, "fixture failure"):
                    h.run(args)
                stop.assert_called_once_with(process)
            self.assertTrue(home.is_dir())

    def test_synthetic_http_contract(self):
        client = Mock()
        receipt = {"message_id": "fixture-message", "status": "accepted"}
        client.request.side_effect = [(401, {}), (401, {}),
            (201, {"global_conversation_id": "fixture-conversation"}),
            (200, {"token": "synthetic-session", "token_type": "Bearer", "global_conversation_id": "fixture-conversation"}),
            (202, receipt), (200, receipt)]
        with patch.object(h, "verify_history") as history:
            path, actual, message = h.smoke(client, "synthetic-bootstrap")
        self.assertEqual(path, "/conversations/fixture-conversation")
        self.assertEqual(actual, receipt)
        self.assertEqual(message["client_message_id"], "local-install-fixture-1")
        history.assert_called_once()

    def test_wrong_health_identity_fails(self):
        client = h.Client(48122)
        with patch.object(client, "request", return_value=(200, {"status": "ok", "product": "other"})):
            with self.assertRaisesRegex(RuntimeError, "real v2"):
                client.health()


if __name__ == "__main__":
    unittest.main()
