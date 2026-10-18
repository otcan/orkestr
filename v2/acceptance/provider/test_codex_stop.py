"""Acceptance-driver refusal boundaries; no provider or credentials."""
from pathlib import Path
from types import SimpleNamespace
import unittest

from codex_stop import request_stop
from verify_package import Refused


class StopDriverTests(unittest.TestCase):
    def setUp(self):
        self.running = {"phase": "running", "capabilities": {"stop": True, "steer": False},
                        "run_id": "synthetic-first-run", "revision": 4, "control_revision": 2}

    def candidate(self, responses):
        calls = []

        def browser(path, **kwargs):
            calls.append((path, kwargs))
            return next(responses)

        return SimpleNamespace(root=Path("/synthetic-only"), browser=browser), calls

    def test_uncertain_delivery_never_reissues_stop(self):
        candidate, calls = self.candidate(iter([(503, {"code": "control_unavailable"}, {})]))
        with self.assertRaisesRegex(Refused, "stop_handoff_unconfirmed"):
            request_stop(candidate, "/synthetic", self.running)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1]["method"], "POST")

    def test_conflict_cannot_refresh_or_stop_a_successor(self):
        successor = {**self.running, "run_id": "synthetic-successor", "revision": 9}
        candidate, calls = self.candidate(iter([
            (409, {"code": "revision_conflict"}, {}), (200, successor, {})]))
        with self.assertRaisesRegex(Refused, "stop_precondition_conflict"):
            request_stop(candidate, "/synthetic", self.running)
        self.assertEqual(len(calls), 1)
        self.assertEqual(sum(kwargs.get("method") == "POST" for _, kwargs in calls), 1)
        self.assertEqual(calls[0][1]["body"]["run_id"], self.running["run_id"])
        self.assertEqual(calls[0][1]["body"]["expected_revision"], 4)
        self.assertEqual(calls[0][1]["body"]["expected_control_revision"], 2)

    def test_missing_or_invalid_control_revision_never_submits(self):
        for revision in (None, 0, -1, True, "2"):
            with self.subTest(revision=revision):
                candidate, calls = self.candidate(iter([]))
                with self.assertRaisesRegex(Refused, "explicit_control_revision_required"):
                    request_stop(candidate, "/synthetic", {**self.running, "control_revision": revision})
                self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
