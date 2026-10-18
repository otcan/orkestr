"""Offline safety checks: subprocesses are mocked; no provider is launched."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch

SPEC = importlib.util.spec_from_file_location(
    "probe_codex", Path(__file__).resolve().parents[1] / "probe_codex.py"
)
PROBE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROBE)


class MetadataProbeTests(unittest.TestCase):
    def run_probe(self, version="codex-cli 0.163.0", reply=None, timeout=False):
        process = MagicMock()
        process.returncode = 0
        if timeout:
            process.communicate.side_effect = [subprocess.TimeoutExpired("fixture", 10), ("", None)]
        else:
            process.communicate.return_value = (
                json.dumps(reply if reply is not None else {
                    "id": 1, "result": {"codexHome": "PRIVATE_PATH", "userAgent": "PRIVATE_HOST"}
                }) + "\n", None
            )
        output = io.StringIO()
        with tempfile.TemporaryDirectory(prefix="orkestr-offline-probe-test-") as parent:
            with patch.object(PROBE.shutil, "which", return_value="/fixture/codex"), \
                    patch.object(PROBE.subprocess, "run") as version_run, \
                    patch.object(PROBE.subprocess, "Popen", return_value=process) as launch, \
                    patch.dict(PROBE.os.environ, {
                        "OPENAI_API_KEY": "FAKE_SECRET", "CODEX_HOME": "/fixture/existing-profile",
                        "CLAUDE_CONFIG_DIR": "/fixture/other-profile", "ACCESS_TOKEN": "FAKE_TOKEN"
                    }), \
                    patch("sys.argv", ["probe", "--scratch-parent", parent]), \
                    contextlib.redirect_stdout(output):
                version_run.return_value.stdout = version
                try:
                    PROBE.main()
                except SystemExit as exc:
                    return exc, process, launch, version_run, output.getvalue()
        return None, process, launch, version_run, output.getvalue()

    def test_only_initialize_is_sent_and_existing_profile_credentials_are_not_inherited(self):
        error, process, launch, version_run, output = self.run_probe()
        self.assertIsNone(error)
        launch.assert_called_once()
        args, kwargs = launch.call_args
        self.assertEqual(args[0], ["/fixture/codex", "app-server", "--listen", "stdio://"])
        env = kwargs["env"]
        for key in ("OPENAI_API_KEY", "ACCESS_TOKEN", "CLAUDE_CONFIG_DIR"):
            self.assertNotIn(key, env)
        self.assertEqual(env["HOME"], env["CODEX_HOME"])
        self.assertNotEqual(env["CODEX_HOME"], "/fixture/existing-profile")
        self.assertEqual(version_run.call_args.kwargs["env"], env)
        frames = process.communicate.call_args.args[0].splitlines()
        self.assertEqual(len(frames), 1)
        self.assertEqual(json.loads(frames[0])["method"], "initialize")
        self.assertEqual(process.communicate.call_args.kwargs["timeout"], 10)
        self.assertNotIn("PRIVATE_PATH", output)
        self.assertNotIn("PRIVATE_HOST", output)
        self.assertEqual(json.loads(output)["inference"], "not_attempted")

    def test_version_mismatch_stops_before_app_server_launch(self):
        error, _, launch, _, output = self.run_probe(version="codex-cli 0.0.0")
        self.assertIsInstance(error, SystemExit)
        launch.assert_not_called()
        self.assertEqual(output, "")

    def test_timeout_kills_and_reaps_only_launched_child(self):
        error, process, _, _, output = self.run_probe(timeout=True)
        self.assertIn("timed out", str(error))
        process.kill.assert_called_once_with()
        self.assertEqual(process.communicate.call_count, 2)
        self.assertEqual(output, "")

    def test_rpc_error_does_not_emit_raw_provider_metadata(self):
        error, _, _, _, output = self.run_probe(reply={"id": 1, "error": {"message": "PRIVATE_DATA"}})
        self.assertIn("no initialize result", str(error))
        self.assertEqual(output, "")


if __name__ == "__main__":
    unittest.main()
