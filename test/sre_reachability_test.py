from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "sre"))
from service_audit import AuditStore
from reachability import Monitor, classify, probe, validate_target


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
        for url in ("http://example.invalid", "https://user:pass@example.invalid", "https://example.invalid/?token=secret", "https://example.invalid:8443"):
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
