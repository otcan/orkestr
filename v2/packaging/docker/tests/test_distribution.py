"""Synthetic context and mocked Docker checks. No Docker daemon/server is used."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location("docker_" + name, HERE / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


prepare, entrypoint, probe = (load(name) for name in ("prepare", "entrypoint", "probe"))


class DistributionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="v2-container-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.binary = self.root / "fake-server"
        self.binary.write_bytes(b"\x7fELF\x02\x01" + b"\0" * 12 + b"\x3e\0" + b"synthetic never executed")
        self.ui = self.root / "web"
        self.ui.mkdir()
        (self.ui / "index.html").write_text("synthetic web index")
        inventory = prepare.ui_files(self.ui)
        self.args = dict(binary=self.binary, ui=self.ui, output=self.root / "context",
                         binary_sha256=prepare.sha256(self.binary),
                         ui_inventory_sha256=hashlib.sha256(json.dumps(inventory, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
                         source_commit="a" * 40, ui_source_commit="b" * 40,
                         base_image="python@sha256:" + "c" * 64, origin="http://127.0.0.1:48123", port=48123,
                         bind_opt_in="ORKESTR_V2_CONTAINER_BIND=1", required_glibc="2.34")

    def context(self):
        return prepare.prepare(**self.args)

    def test_context_policy_and_copied_hashes(self):
        root = self.context()
        manifest = entrypoint.verify(root)
        config = json.loads((root / "compose.json").read_text())
        service = config["services"]["server"]
        self.assertTrue(service["read_only"])
        self.assertEqual(service["user"], "10001:10001")
        self.assertEqual(service["cap_drop"], ["ALL"])
        self.assertEqual(service["volumes"], ["state:/state"])
        self.assertEqual(service["ports"][0]["host_ip"], "127.0.0.1")
        self.assertTrue(config["networks"]["isolated"]["internal"])
        self.assertEqual(manifest["files"]["server"], self.args["binary_sha256"])
        self.assertNotIn("network_mode", service)
        self.assertNotIn("privileged", service)

    def test_web_manifest_is_declared_verified_and_tamper_checked(self):
        web_manifest = self.ui / "manifest.json"
        web_manifest.write_text('{"name":"synthetic web"}')
        inventory = prepare.ui_files(self.ui)
        self.assertEqual(set(inventory), {"index.html", "manifest.json"})
        self.args["ui_inventory_sha256"] = hashlib.sha256(
            json.dumps(inventory, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        root = self.context()
        declared = entrypoint.verify(root)["files"]
        for name, digest in inventory.items():
            self.assertEqual(declared["ui/" + name], digest)
        (root / "ui/manifest.json").write_text('{"name":"tampered"}')
        with self.assertRaisesRegex(RuntimeError, "checksum"):
            entrypoint.verify(root)
        web_manifest.write_text('{"name":"source tampered"}')
        with self.assertRaisesRegex(RuntimeError, "inventory hash"):
            prepare.prepare(**{**self.args, "output": self.root / "other-context"})

    def test_bad_hash_origin_image_and_reserved_opt_in_refused_before_output(self):
        for key, value in (("binary_sha256", "0" * 64), ("ui_inventory_sha256", "0" * 64),
                           ("origin", "http://0.0.0.0:48123"), ("base_image", "python:latest"),
                           ("bind_opt_in", "ORKESTR_V2_MASTER_KEY=fake")):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                prepare.prepare(**{**self.args, key: value})
            self.assertFalse(self.args["output"].exists())

    def test_existing_context_preserved(self):
        root = self.context()
        before = (root / "compose.json").read_bytes()
        with self.assertRaisesRegex(RuntimeError, "nonexistent"):
            self.context()
        self.assertEqual((root / "compose.json").read_bytes(), before)

    def test_artifact_tampering_refused_before_state(self):
        root = self.context()
        (root / "ui/index.html").write_text("tampered")
        state = self.root / "state"
        state.mkdir(mode=0o700)
        with self.assertRaisesRegex(RuntimeError, "checksum"):
            entrypoint.environment(root, state, {})
        self.assertEqual(list(state.iterdir()), [])

    def test_private_bootstrap_persists_and_inherited_credentials_excluded(self):
        root = self.context()
        state = self.root / "state"
        state.mkdir(mode=0o700)
        incoming = {"ORKESTR_V2_ORIGIN": self.args["origin"], "ORKESTR_V2_CONTAINER_BIND": "1",
                    "OPENAI_API_KEY": "synthetic excluded", "ORKESTR_HOME": "/fake/legacy"}
        first = entrypoint.environment(root, state, incoming)
        second = entrypoint.environment(root, state, incoming)
        self.assertEqual(first, second)
        self.assertNotIn("OPENAI_API_KEY", first)
        self.assertNotIn("ORKESTR_HOME", first)
        self.assertEqual(first["ORKESTR_V2_BIND"], "0.0.0.0:19822")
        self.assertEqual((state / "control/bootstrap.token").stat().st_mode & 0o777, 0o600)

    def test_wrong_origin_and_missing_bind_opt_in_refuse(self):
        root = self.context()
        state = self.root / "state"
        state.mkdir(mode=0o700)
        for env in ({}, {"ORKESTR_V2_ORIGIN": self.args["origin"]}):
            with self.assertRaises(RuntimeError):
                entrypoint.environment(root, state, env)
        self.assertEqual(list(state.iterdir()), [])

    def probe_args(self):
        root = self.context()
        return dict(context=root, reviewed_image_id="sha256:" + "d" * 64,
                    reviewed_compose_sha256=prepare.sha256(root / "compose.json"))

    def test_daemon_denial_does_not_cleanup_or_mutate(self):
        args = self.probe_args()
        with patch.object(probe, "run", side_effect=PermissionError("synthetic daemon denied")) as run:
            with self.assertRaises(PermissionError):
                probe.probe(**args)
        self.assertEqual(run.call_count, 1)

    def test_failed_up_cleans_only_owned_project_and_image(self):
        args = self.probe_args()
        def command(*items):
            if items[:2] == ("image", "inspect"):
                return args["reviewed_image_id"]
            if "up" in items:
                raise subprocess.CalledProcessError(1, ["docker", *items])
            return ""
        with patch.object(probe, "run", side_effect=command) as run, patch.object(probe.socket, "socket"):
            with self.assertRaises(subprocess.CalledProcessError):
                probe.probe(**args)
        calls = [call.args for call in run.call_args_list]
        self.assertIn("down", calls[-2])
        self.assertIn("--volumes", calls[-2])
        self.assertEqual(calls[-1][:2], ("image", "rm"))

    def test_existing_project_never_touched(self):
        args = self.probe_args()
        def command(*items):
            if items[:2] == ("image", "inspect"):
                return args["reviewed_image_id"]
            return "occupied" if items[0] == "container" else ""
        with patch.object(probe, "run", side_effect=command) as run:
            with self.assertRaisesRegex(RuntimeError, "occupants"):
                probe.probe(**args)
        self.assertFalse(any("down" in call.args or "up" in call.args for call in run.call_args_list))


if __name__ == "__main__":
    unittest.main()
