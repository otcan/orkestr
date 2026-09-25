import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "sre"))
from task_baseline import Baseline, read_sample


def response(tasks=12, **extras):
    fields = dict(Id="example.service", LoadState="loaded", ActiveState="active", TasksCurrent=str(tasks), TasksMax="512", MemoryCurrent="100000")
    fields.update(extras)
    return SimpleNamespace(returncode=0, stdout="\n".join(f"{k}={v}" for k, v in fields.items()))


class TaskBaselineTest(unittest.TestCase):
    def test_minimized_probe_no_control_or_environment(self):
        calls = []
        def runner(argv, **kwargs):
            calls.append((argv, kwargs))
            return response(Environment="PRIVATE_VALUE", ExecStart="PRIVATE_COMMAND")
        sample = read_sample("example.service", runner)
        self.assertEqual(sample["tasks"], 12)
        self.assertNotIn("PRIVATE", json.dumps(sample))
        self.assertEqual(calls[0][0][:2], ["systemctl", "show"])
        self.assertNotIn("Environment", calls[0][0][-1])
        self.assertEqual(set(calls[0][1]["env"]), {"PATH", "LC_ALL"})
        self.assertEqual(calls[0][1]["timeout"], 5)

    def test_failed_or_unbounded_probe_is_not_zero(self):
        for value in [response(Id="other.service"), response(TasksCurrent="[not set]"), response(ActiveState="inactive")]:
            self.assertNotIn("tasks", read_sample("example.service", lambda *a, **k: value))
        sample = read_sample("example.service", lambda *a, **k: response(TasksMax="infinity"))
        self.assertIsNone(sample["configured_max"])
        def timeout(*a, **k):
            raise subprocess.TimeoutExpired("systemctl", 5)
        self.assertEqual(read_sample("example.service", timeout)["error"], "property_read_failed")

    def test_restart_safe_phase_and_gap_report_never_recommends_a_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            baseline = Baseline(directory, ["example.service"])
            baseline.collect("normal", now=10, runner=lambda *a, **k: response(4))
            baseline.collect("peak", now=30, runner=lambda *a, **k: response(120))
            baseline.collect("recovery", now=40, runner=lambda *a, **k: response(TasksCurrent="unknown"))
            baseline.close()
            reopened = Baseline(directory, ["example.service"])
            report = reopened.report()
            reopened.close()
            row = report["services"][0]
            self.assertEqual((row["sample_count"], row["valid_count"], row["failed_count"]), (3, 2, 1))
            self.assertEqual(row["observed_peak"], 120)
            self.assertEqual(row["largest_gap_seconds"], 20)
            self.assertEqual(row["missing_phases"], ["recovery", "startup"])
            self.assertIsNone(report["limit_recommendation"])

    def test_scope_and_capacity_fail_closed_without_deleting_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            baseline = Baseline(directory, ["example.service"], capacity=1)
            baseline.collect("normal", now=1, runner=lambda *a, **k: response())
            with self.assertRaises(RuntimeError):
                baseline.collect("normal", now=2, runner=lambda *a, **k: response())
            self.assertEqual(baseline.report()["services"][0]["sample_count"], 1)
            with self.assertRaises(ValueError):
                Baseline(directory, ["other.service"])
            with self.assertRaises(ValueError):
                baseline.collect("guessed", now=3)
            baseline.close()

    def test_replayed_or_backward_samples_cannot_inflate_phase_evidence_after_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            baseline = Baseline(directory, ["example.service"])
            baseline.collect("normal", now=100, runner=lambda *a, **k: response())
            baseline.close()
            reopened = Baseline(directory, ["example.service"])
            try:
                for stamp in (100, 99, True, float("nan"), float("inf")):
                    with self.subTest(stamp=stamp), self.assertRaises(ValueError):
                        reopened.collect("peak", now=stamp, runner=lambda *a, **k: response(999))
                row = reopened.report()["services"][0]
                self.assertEqual(row["sample_count"], 1)
                self.assertEqual(row["phase_counts"]["peak"], 0)
                reopened.collect("recovery", now=101, runner=lambda *a, **k: response())
                self.assertEqual(reopened.report()["services"][0]["sample_count"], 2)
            finally:
                reopened.close()


if __name__ == "__main__":
    unittest.main()
