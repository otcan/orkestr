"""Synthetic regression checks for benchmark evidence and process boundaries."""
import io
import json
import os
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import intake_performance as probe


def sample(duration_ms, status=202, ok=True):
    return {"duration_ns": int(duration_ms * 1_000_000), "status": status, "ok": ok}


class EvidenceTests(unittest.TestCase):
    def test_nearest_rank_and_strict_threshold(self):
        self.assertEqual(probe.percentile(list(range(1, 101)), 95), 95)
        self.assertEqual(probe.percentile([8, 1, 4], 95), 8)
        self.assertIsNone(probe.percentile([], 95))
        self.assertFalse(probe.summary([sample(250)], 1, 250)["passed"])
        self.assertTrue(probe.summary([sample(249.999)], 1, 250)["passed"])

    def test_fast_failures_and_incomplete_runs_cannot_pass(self):
        rows = [sample(1) for _ in range(99)] + [sample(.01, 503, False)]
        result = probe.summary(rows, 100, 250)
        self.assertEqual(result["attempted"], 100)
        self.assertEqual(result["errors"], 1)
        self.assertEqual(result["http_status_counts"], {"202": 99, "503": 1})
        self.assertFalse(result["passed"])
        self.assertFalse(probe.summary(rows[:99], 100, 250)["passed"])
        self.assertFalse(probe.summary([], 100, 250)["passed"])

    def test_failed_latency_is_retained_in_percentiles(self):
        result = probe.summary([sample(1) for _ in range(19)] + [sample(999, None, False)], 20, 250)
        self.assertEqual(result["p99_ms"], 999)
        self.assertEqual(result["http_status_counts"]["None"], 1)
        self.assertFalse(result["passed"])

    def test_ten_clients_have_one_request_outstanding_each(self):
        active, peak, counts, lock = set(), [0], {}, threading.Lock()
        barrier = threading.Barrier(10)
        def action(client, index):
            with lock:
                self.assertNotIn(client, active)
                active.add(client)
                peak[0] = max(peak[0], len(active))
                counts[index] = counts.get(index, 0) + 1
            barrier.wait(timeout=3)
            with lock:
                active.remove(client)
            barrier.wait(timeout=3)
        probe.batch(20, action)
        self.assertEqual(peak[0], 10)
        self.assertEqual(counts, {i: 1 for i in range(20)})

    def test_private_artifacts_exclusive_and_symlinks_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            probe.private_directory(root)
            target = root / "report.json"
            probe.write_private(target, "{}\n")
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                probe.write_private(target, "replacement")
            alias = root / "alias"
            alias.symlink_to(root, target_is_directory=True)
            with self.assertRaises(probe.CheckpointFailure):
                probe.private_directory(alias / "new")
            self.assertFalse((root / "new").exists())
            root.chmod(0o755)
            with self.assertRaises(probe.CheckpointFailure):
                probe.private_directory(root)

    def test_failed_run_preserves_evidence_without_credentials_or_state(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            binary = root / "synthetic-binary"
            binary.write_bytes(b"never executed")
            args = SimpleNamespace(evidence_dir=root / "evidence", source_checkout=root,
                source_revision="a" * 40, binary=binary, binary_sha256=probe.digest(binary),
                budget_seconds=30)
            secret = []
            def fail(server):
                secret.append(server.env["ORKESTR_V2_BOOTSTRAP_TOKEN"])
                server.samples.append({**sample(2, 503, False), "phase": "intake"})
                raise probe.CheckpointFailure("synthetic_failure")
            with patch.object(probe.subprocess, "check_output", side_effect=["a" * 40, b"lock"]), \
                    patch.object(probe, "workload", side_effect=fail), patch("sys.stdout", io.StringIO()):
                self.assertEqual(probe.execute(args), 1)
            report_file, = args.evidence_dir.glob("run-*/report.json")
            report = json.loads(report_file.read_text())
            self.assertFalse(report["checkpoint_passed"])
            self.assertFalse(report["full_release_qualified"])
            self.assertEqual(report["metrics"]["intake"]["errors"], 1)
            self.assertTrue(report["owned_process_cleaned"] and report["synthetic_state_removed"])
            raw = report_file.with_name("samples.jsonl").read_text()
            self.assertEqual(json.loads(raw)["status"], 503)
            for name in ("report.json", "samples.jsonl", "config.json"):
                artifact = report_file.with_name(name)
                self.assertEqual(artifact.stat().st_mode & 0o777, 0o600)
                self.assertNotIn(secret[0], artifact.read_text())


class ProcessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def server(self, binary="/synthetic-binary"):
        server = probe.OwnedServer(Path(binary), self.root, 30)
        self.addCleanup(server.close)
        return server

    def test_no_owned_readiness_issues_no_http(self):
        class Child:
            stderr = io.BytesIO()
            def poll(self): return 1
        server = self.server()
        with patch.object(probe.subprocess, "Popen", return_value=Child()), \
                patch.object(server, "request") as request:
            with self.assertRaisesRegex(probe.CheckpointFailure, "owned_server_not_ready"):
                probe.workload(server)
            request.assert_not_called()

    def test_failure_keeps_http_status_and_raw_duration(self):
        class Response(io.BytesIO):
            status = 503
        class Opener:
            def open(self, request, timeout): return Response(b'{"code":"unavailable"}')
        server = self.server()
        server.local.opener = Opener()
        with self.assertRaises(probe.CheckpointFailure):
            server.request("intake", "/synthetic", 202)
        self.assertEqual(len(server.samples), 1)
        row = server.samples[0]
        self.assertEqual(row["status"], 503)
        self.assertFalse(row["ok"])
        self.assertGreaterEqual(row["duration_ns"], 0)
        self.assertNotIn("Authorization", json.dumps(row))

    def test_redirects_and_ambient_environment_are_excluded(self):
        server = self.server()
        self.assertIsNone(probe.NoRedirect().redirect_request(None))
        self.assertEqual(set(server.env), {"HOME", "LANG", "ORKESTR_V2_HOME", "ORKESTR_V2_BIND",
                                          "ORKESTR_V2_ORIGIN", "ORKESTR_V2_BOOTSTRAP_TOKEN"})
        self.assertEqual(server.env["HOME"], str(self.root))
        with patch.object(probe.urllib.request, "build_opener", side_effect=RuntimeError) as build:
            with self.assertRaises(RuntimeError):
                server.request("setup", "/health", 200)
        self.assertEqual(build.call_args.args[0].proxies, {})

    def test_budget_kills_only_owned_child_and_reaps_it(self):
        binary = self.root / "sleeper"
        binary.write_text("#!/usr/bin/python3\nimport time\ntime.sleep(30)\n")
        binary.chmod(0o700)
        server = probe.OwnedServer(binary, self.root, .1)
        children, popen = [], probe.subprocess.Popen
        def remember(*args, **kwargs):
            child = popen(*args, **kwargs)
            children.append(child)
            return child
        try:
            with patch.object(probe.subprocess, "Popen", side_effect=remember):
                with self.assertRaises((probe.CheckpointFailure, OSError, ValueError)):
                    server.start()
        finally:
            server.close()
        self.assertEqual(len(children), 1)
        self.assertIsNotNone(children[0].poll())
        self.assertIsNone(server.process)


if __name__ == "__main__":
    unittest.main()
