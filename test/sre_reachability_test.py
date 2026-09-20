from pathlib import Path
from unittest.mock import patch
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "sre"))
from service_audit import AuditStore
from reachability import Monitor, classify, main, probe, validate_target


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = AuditStore(self.tmp.name)
        self.monitor = Monitor(self.store, "independent-example")

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def test_failure_is_not_proof_of_power_loss(self):
        self.assertEqual(classify(False, False), "host_or_public_path_unreachable")

    def test_shared_state_directory_cannot_mix_monitor_types(self):
        with self.assertRaises(ValueError):
            self.store.ingest([], {"example.service"}, 0)

    def test_only_fresh_internal_signal_attributes_route_drift(self):
        self.assertEqual(classify(False, False, {"route_ok": False, "observed_at": 100}, now=110), "public_route_drift")
        self.assertEqual(classify(False, False, {"route_ok": False, "observed_at": 100}, now=999), "host_or_public_path_unreachable")

    def test_one_failure_does_not_page_and_recovery_needs_two_samples(self):
        for now, result in enumerate(["https_unreachable", "healthy", "https_unreachable", "https_unreachable", "https_unreachable"], 1):
            self.monitor.observe(result, now)
        self.assertEqual(self.store.summary(5)["total"], 1)
        self.monitor.observe("healthy", 6)
        self.assertEqual(self.store.summary(6)["total"], 1)
        self.monitor.observe("healthy", 7)
        self.assertEqual(self.store.summary(7)["total"], 2)

    def test_restart_continues_failure_count(self):
        self.monitor.observe("https_unreachable", 1)
        self.monitor.observe("https_unreachable", 2)
        restarted = Monitor(self.store, "independent-example")
        restarted.observe("https_unreachable", 3)
        self.assertEqual(self.store.summary(3)["pending"], 1)

    def test_no_repeated_transition_on_sustained_failure(self):
        for now in range(1, 20):
            self.monitor.observe("https_unreachable", now)
        self.assertEqual(self.store.summary(20)["total"], 1)

    def test_alternating_failure_classes_still_open_an_incident(self):
        for now, outcome in enumerate(["ssh_unreachable", "https_unreachable", "host_or_public_path_unreachable"], 1):
            state = self.monitor.observe(outcome, now)
        self.assertEqual(self.store.summary(3)["pending"], 1)
        self.assertEqual(state["active"], "host_or_public_path_unreachable")
        for now in range(4, 12):
            self.monitor.observe("https_unreachable" if now % 2 else "ssh_unreachable", now)
        self.assertEqual(self.store.summary(12)["total"], 1)

    def test_stale_failure_samples_are_not_combined_across_a_gap(self):
        self.monitor.observe("https_unreachable", 1)
        self.monitor.observe("https_unreachable", 2)
        state = self.monitor.observe("https_unreachable", 500)
        self.assertEqual(state["active"], "healthy")
        self.assertEqual(self.store.summary(500)["total"], 0)
        self.monitor.observe("https_unreachable", 501)
        self.monitor.observe("https_unreachable", 502)
        self.assertEqual(self.store.summary(502)["total"], 1)

    def test_gap_does_not_recover_an_active_incident(self):
        for now in (1, 2, 3):
            self.monitor.observe("https_unreachable", now)
        self.monitor.observe("healthy", 4)
        state = self.monitor.observe("healthy", 500)
        self.assertEqual(state["active"], "https_unreachable")
        self.assertEqual(self.store.summary(500)["total"], 1)
        self.monitor.observe("healthy", 501)
        self.assertEqual(self.store.summary(501)["total"], 2)

    def test_policy_and_targets_bound_before_first_observation(self):
        targets = {"ssh": "example.invalid", "https": "https://example.invalid/"}
        Monitor(self.store, "scoped-example", targets=targets)
        Monitor(self.store, "scoped-example", targets=targets)
        for options in ({"targets": {**targets, "ssh": "different.invalid"}},
                        {"targets": targets, "fail_after": 1}, {"targets": targets, "max_gap_seconds": 60}):
            with self.assertRaises(ValueError):
                Monitor(self.store, "scoped-example", **options)
        self.assertEqual(self.store.summary(0)["total"], 0)

    def test_legacy_state_cannot_silently_adopt_new_targets(self):
        self.store.db.execute("INSERT INTO monitors VALUES(?,?,?)", ("legacy", "{}", 1))
        self.store.db.commit()
        with self.assertRaises(ValueError):
            Monitor(self.store, "legacy", targets={"ssh": "example.invalid", "https": "https://example.invalid/"})

    def test_cli_target_drift_is_rejected_before_any_probe(self):
        Monitor(self.store, "cli-scope", targets={"ssh": "example.invalid", "https": "https://example.invalid/"})
        args = ["reachability.py", "--state-directory", self.tmp.name, "--probe-id", "cli-scope",
                "--ssh-host", "changed.invalid", "--https-url", "https://example.invalid/"]
        with patch("sys.argv", args), patch("reachability.probe") as mocked:
            with self.assertRaises(ValueError):
                main()
            mocked.assert_not_called()

    def test_invalid_numeric_policy_and_timestamps_do_not_poison_state(self):
        for now in (float("nan"), float("inf"), -1, True):
            with self.assertRaises(ValueError):
                self.monitor.observe("healthy", now)
        for options in ({"fail_after": True}, {"recover_after": 1.5}, {"max_gap_seconds": float("nan")}):
            with self.assertRaises(ValueError):
                Monitor(self.store, "invalid", **options)
        self.assertEqual(self.store.summary(10)["total"], 0)

    def test_queue_full_preserves_prior_monitor_state(self):
        self.store.max_events = 0
        self.monitor.observe("https_unreachable", 1)
        self.monitor.observe("https_unreachable", 2)
        with self.assertRaises(RuntimeError):
            self.monitor.observe("https_unreachable", 3)
        self.store.max_events = 100
        self.monitor.observe("https_unreachable", 3)
        self.assertEqual(self.store.summary(3)["total"], 1)

    def test_delayed_or_duplicate_samples_rejected(self):
        self.monitor.observe("healthy", 10)
        with self.assertRaises(ValueError):
            self.monitor.observe("https_unreachable", 9)

    def test_target_validation_rejects_credentials_and_non_https(self):
        for url in ("http://example.invalid", "https://user:pass@example.invalid", "https://example.invalid/?token=secret", "https://example.invalid:8443", "https://example.invalid/\n", "https://example.invalid/a b"):
            with self.assertRaises(ValueError):
                validate_target("https", url)

    def test_dns_or_network_hang_is_process_deadline_bounded(self):
        def runner(command, **options):
            self.assertEqual(options["timeout"], 8)
            self.assertEqual(set(options["env"]), {"PATH", "LC_ALL"})
            raise subprocess.TimeoutExpired(command, 8)
        self.assertFalse(probe("ssh", "example.invalid", runner=runner))

    def test_reuses_receipt_bound_spool_without_real_send(self):
        for now in (1, 2, 3):
            self.monitor.observe("https_unreachable", now)
        self.assertEqual(self.store.dispatch(lambda payload: {"event_id": payload["event_id"], "state": "delivered", "receipt_id": "isolated-receipt"}, 3), 1)


if __name__ == "__main__":
    unittest.main()
