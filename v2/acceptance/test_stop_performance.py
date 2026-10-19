"""Probe concurrency and error accounting without a server."""
import unittest
from pathlib import Path
import json
import subprocess
from unittest.mock import patch
from stop_performance import binary_identity, measure


class MeasureTests(unittest.TestCase):
    def test_ten_clients_and_receipts(self):
        rows = measure([lambda: (200, {"outcome": "requested_unknown"}, {}) for _ in range(10)])
        self.assertEqual({row["client"] for row in rows}, set(range(10)))
        self.assertTrue(all(row["ok"] and row["duration_ns"] > 0 for row in rows))

    def test_errors_are_samples(self):
        def fail():
            raise TimeoutError()
        rows = measure([fail, lambda: (409, {"error": "conflict"}, {})])
        self.assertEqual(len(rows), 2)
        self.assertFalse(any(row["ok"] for row in rows))
        self.assertEqual(rows[0]["error"], "TimeoutError")


class IdentityTests(unittest.TestCase):
    def identity(self, source, **fields):
        return subprocess.CompletedProcess([], 0, json.dumps({
            "format": "orkestr-v2-build-identity-v1", "component": "server",
            "source_commit": source, **fields}), "")

    def test_matching_embedded_source(self):
        with patch("stop_performance.subprocess.run", return_value=self.identity("a" * 40)) as run:
            result = binary_identity(Path(__file__), "a" * 40)
        self.assertEqual(result["source_commit"], "a" * 40)
        self.assertEqual(run.call_args.args[0][1:], ["--version", "--json"])

    def test_different_binary_or_component_refused(self):
        for identity in [self.identity("b" * 40), self.identity("a" * 40, component="web")]:
            with self.subTest(identity=identity.stdout):
                with patch("stop_performance.subprocess.run", return_value=identity):
                    with self.assertRaisesRegex(ValueError, "identity mismatch"):
                        binary_identity(Path(__file__), "a" * 40)

    def test_short_expected_source_refused_before_execution(self):
        with patch("stop_performance.subprocess.run") as run:
            with self.assertRaises(ValueError):
                binary_identity(Path(__file__), "abc")
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
