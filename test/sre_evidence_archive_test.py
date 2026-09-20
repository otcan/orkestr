from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "sre"))
from evidence_archive import Archive
from service_audit import AuditStore


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = AuditStore(self.tmp.name)
        self.archive = Archive(self.store, "independent-vault", 86400)
        self.row = {"_PID": "1", "_COMM": "systemd", "_BOOT_ID": "a" * 32,
                    "UNIT": "example.service", "JOB_TYPE": "restart", "JOB_ID": "42",
                    "__CURSOR": "cursor-1", "__REALTIME_TIMESTAMP": "1000"}
        self.store.ingest([self.row], {"example.service"}, 1, grace_seconds=0)

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def settle(self):
        self.store.dispatch(lambda p: {"event_id": p["event_id"], "state": "delivered", "receipt_id": "delivery-1"}, 2)

    def receipt(self, request):
        return {"bundle_id": request["bundle_id"], "sink_id": "independent-vault", "state": "retained",
                "immutable": True, "receipt_id": "vault-1", "retained_until": 300000}

    def test_unresolved_evidence_exported_but_never_pruned(self):
        prepared = self.archive.prepare(100000)
        self.archive.deliver(prepared["bundle_id"], self.receipt)
        self.assertEqual(self.archive.prune(prepared["bundle_id"], 110000), 0)
        self.assertEqual(self.store.summary(110000)["pending"], 1)
        self.assertIsNone(self.archive.prepare(120000))
        self.settle()
        self.assertIsNotNone(self.archive.prepare(120000))

    def test_recent_evidence_exported_but_never_pruned(self):
        self.settle()
        prepared = self.archive.prepare(10)
        self.archive.deliver(prepared["bundle_id"], self.receipt)
        self.assertEqual(self.archive.prune(prepared["bundle_id"], 20), 0)
        self.assertEqual(self.store.summary(20)["total"], 1)
        due = self.archive.prepare(100000)
        self.archive.deliver(due["bundle_id"], self.receipt)
        self.assertEqual(self.archive.prune(due["bundle_id"], 110000), 1)

    def test_receipt_loss_retries_identical_bytes_after_restart(self):
        self.settle()
        prepared = self.archive.prepare(100000)
        with self.assertRaises(TimeoutError):
            self.archive.deliver(prepared["bundle_id"], lambda _: (_ for _ in ()).throw(TimeoutError()))
        reopened = Archive(self.store, "independent-vault", 86400)
        self.assertEqual(reopened.prepare(110000), prepared)
        with self.assertRaises(ValueError):
            reopened.prune(prepared["bundle_id"], 110000)
        reopened.deliver(prepared["bundle_id"], self.receipt)
        self.assertEqual(reopened.prune(prepared["bundle_id"], 110000), 1)
        self.assertEqual(reopened.prune(prepared["bundle_id"], 110000), 0)

    def test_wrong_partial_numeric_and_expired_receipts_rejected(self):
        self.settle()
        prepared = self.archive.prepare(100000)
        for change in ({"bundle_id": "wrong"}, {"sink_id": "wrong"}, {"state": "accepted"},
                       {"immutable": 1}, {"retained_until": 100001}, {"retained_until": float("nan")}):
            with self.assertRaises(ValueError):
                self.archive.deliver(prepared["bundle_id"], lambda p: {**self.receipt(p), **change})
        self.assertEqual(self.store.summary(1)["total"], 1)

    def test_changed_attribution_or_delivery_state_prevents_pruning(self):
        self.settle()
        prepared = self.archive.prepare(100000)
        self.archive.deliver(prepared["bundle_id"], self.receipt)
        with self.store.db:
            self.store.db.execute("UPDATE events SET delivered=0,receipt=NULL")
        self.assertEqual(self.archive.prune(prepared["bundle_id"], 110000), 0)
        self.assertEqual(self.store.summary(1)["pending"], 1)

    def test_replayed_cursor_cannot_recreate_pruned_alert(self):
        self.settle()
        prepared = self.archive.prepare(100000)
        self.archive.deliver(prepared["bundle_id"], self.receipt)
        self.archive.prune(prepared["bundle_id"], 110000)
        self.store.ingest([self.row], {"example.service"}, 120000)
        self.assertEqual(self.store.summary(120000)["total"], 0)
        self.assertEqual(self.store.cursor(), "cursor-1")
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM archived_events").fetchone()[0], 1)

    def test_sink_policy_drift_and_expired_retention_fail_closed(self):
        with self.assertRaises(ValueError):
            Archive(self.store, "replacement-vault", 86400)
        self.settle()
        prepared = self.archive.prepare(100000)
        self.archive.deliver(prepared["bundle_id"], self.receipt)
        with self.assertRaises(ValueError):
            self.archive.prune(prepared["bundle_id"], 300001)
        self.assertEqual(self.store.summary(1)["total"], 1)

    def test_crash_rolls_back_tombstone_and_deletion_together(self):
        self.settle()
        prepared = self.archive.prepare(100000)
        self.archive.deliver(prepared["bundle_id"], self.receipt)
        self.store.db.execute("CREATE TRIGGER fail_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'simulated crash'); END")
        with self.assertRaises(Exception):
            self.archive.prune(prepared["bundle_id"], 110000)
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM archived_events").fetchone()[0], 0)
        self.assertEqual(self.store.summary(1)["total"], 1)
