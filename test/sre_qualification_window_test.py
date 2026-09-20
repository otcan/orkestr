from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "sre"))
from qualification_window import Window, check_dependency
from service_audit import AuditStore


POLICY = {"window_id": "post-remediation-1", "owner": "operator", "change_ref": "change-1",
          "duration_seconds": 86400, "max_gap_seconds": 300,
          "checks": ["transport", "route-readiness", "disk-below-85", "no-new-dead-letters", "attribution"]}


def sample(stamp, **kwargs):
    return {"observed_at": stamp, "release_id": "release-1", "boot_id": "a"*32, "service_generation": 1,
            "checks": {key: True for key in POLICY["checks"]},
            "evidence_refs": {key: "evidence-1" for key in POLICY["checks"]}, **kwargs}


class WindowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = AuditStore(self.tmp.name)
        self.window = Window(self.store, POLICY)

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def test_full_clean_window_survives_recorder_restart(self):
        for stamp in range(0, 86401, 300):
            self.window.observe(sample(stamp))
        reopened = Window(self.store, POLICY)
        self.assertTrue(reopened.report(86400)["complete"])
        self.assertFalse(reopened.report(87000)["complete"])

    def test_release_boot_cycle_gap_and_failure_each_break_window(self):
        scenarios = [{"release_id": "release-2"}, {"boot_id": "b"*32}, {"service_generation": 2},
                     {"checks": {key: key != "disk-below-85" for key in POLICY["checks"]}}]
        for change in scenarios:
            self.window.observe(sample(self.next_time()))
            self.window.observe(sample(self.next_time(), **change))
            report = self.window.report(self.next_time() - 100)
            self.assertFalse(report["complete"])
            self.assertEqual(report["clean_span_seconds"], 0)
        self.window.observe(sample(10000))
        self.assertIn("sampling_gap", self.window.report(10000)["breaks"][-1]["reasons"])

    def next_time(self):
        row = self.store.db.execute("SELECT max(stamp) FROM observations").fetchone()[0]
        return 0 if row is None else row + 100

    def test_boolean_evidence_forgery_unknown_checks_and_time_replay_rejected(self):
        self.window.observe(sample(100))
        with self.assertRaises(ValueError):
            self.window.observe(sample(100))
        for changes in ({"checks": {key: 1 for key in POLICY["checks"]}}, {"evidence_refs": {}}, {"checks": {}}):
            with self.assertRaises(ValueError):
                self.window.observe(sample(200, **changes))
        with self.assertRaises(ValueError):
            Window(self.store, {**POLICY, "checks": ["transport"]})

    def test_active_mail_dependency_preserved_only_with_exact_current_exception(self):
        policy = {"unit": "mail-dependency.service", "expected": {"active": True, "enabled": True, "funnel_routes": ["mail-pubsub"]},
                  "exception": {"owner": "operator", "change_ref": "change-1", "reason_ref": "gmail-dependency", "review_until": 1000}}
        actual = {"unit": "mail-dependency.service", **policy["expected"]}
        self.assertTrue(check_dependency(actual, policy, 900))
        self.assertFalse(check_dependency({**actual, "active": False}, policy, 900))
        self.assertFalse(check_dependency({**actual, "funnel_routes": []}, policy, 900))
        self.assertFalse(check_dependency({**actual, "funnel_routes": ["mail-pubsub", "unexpected"]}, policy, 900))
        with self.assertRaises(ValueError):
            check_dependency(actual, policy, 1001)
