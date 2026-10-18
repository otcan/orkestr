"""Acceptance-driver refusal boundaries; no provider or credentials."""
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from codex_stop import request_stop
from verify_package import Refused


class StopDriverTests(unittest.TestCase):
    def setUp(self):
        self.running = {"phase": "running", "capabilities": {"stop": True, "steer": False},
                        "run_id": "synthetic-first-run", "revision": 4}

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

    def test_revision_refresh_cannot_stop_a_successor(self):
        successor = {**self.running, "run_id": "synthetic-successor", "revision": 9}
        candidate, calls = self.candidate(iter([
            (409, {"code": "revision_conflict"}, {}), (200, successor, {})]))
        with patch("codex_stop.ledger", return_value={"cancellations": 0}):
            with self.assertRaisesRegex(Refused, "stop_refresh_changed_run"):
                request_stop(candidate, "/synthetic", self.running)
        self.assertEqual(len(calls), 2)
        self.assertEqual(sum(kwargs.get("method") == "POST" for _, kwargs in calls), 1)

    def test_committed_intent_refuses_retry_even_with_conflict_status(self):
        candidate, calls = self.candidate(iter([(409, {"code": "revision_conflict"}, {})]))
        with patch("codex_stop.ledger", return_value={"cancellations": 1}):
            with self.assertRaisesRegex(Refused, "conflict_already_committed"):
                request_stop(candidate, "/synthetic", self.running)
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
