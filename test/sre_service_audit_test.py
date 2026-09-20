import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "sre"))
from service_audit import AuditStore, exact_attribution, normalize_event


UNIT = "example.service"
BOOT = "a" * 32


def event(cursor="cursor-1", **extra):
    return {"_PID": "1", "_COMM": "systemd", "UNIT": UNIT,
            "JOB_TYPE": "start", "JOB_ID": "42", "_BOOT_ID": BOOT,
            "__CURSOR": cursor, "__REALTIME_TIMESTAMP": "1789900000000000", **extra}


def evidence(**extra):
    return {"boot_id": BOOT, "job_id": "42", "unit": UNIT,
            "action": "start", "outcome": "accepted", "operation_id": "op-1",
            "principal": "uid:0", "change_ref": "CHANGE-1", "source": "controller", **extra}


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = AuditStore(self.tmp.name)

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def ingest(self, **extra):
        self.store.ingest([event(**extra)], {UNIT}, now=0, grace_seconds=0)

    def test_only_pid_one_metadata_is_accepted(self):
        self.assertIsNone(normalize_event(event(_PID="44"), {UNIT}))
        self.assertIsNone(normalize_event(event(_COMM="node"), {UNIT}))
        self.assertIsNone(normalize_event(event(UNIT="other.service"), {UNIT}))
        without_job = normalize_event(event(JOB_ID=""), {UNIT})
        self.assertIsNotNone(without_job)
        self.assertIsNone(exact_attribution(without_job, [evidence(job_id="")]))

    def test_minimized_payload(self):
        self.ingest(MESSAGE="SECRET BODY", ENV="SECRET ENV", JOB_RESULT="secret")
        value = self.store.db.execute("SELECT payload FROM events").fetchone()[0]
        self.assertNotIn("SECRET", value)
        self.assertNotIn("secret", value)

    def test_non_scalar_fields_are_not_treated_as_trusted_events(self):
        self.assertIsNone(normalize_event(event(JOB_TYPE=[]), {UNIT}))
        self.assertIsNone(normalize_event(event(UNIT={}), {UNIT}))
        self.assertIsNone(exact_attribution(normalize_event(event(), {UNIT}), [evidence(action=[])]))

    def test_duplicate_observation_is_idempotent(self):
        self.ingest()
        self.ingest()
        self.assertEqual(self.store.summary(0)["total"], 1)

    def test_changing_watched_units_cannot_silently_reuse_cursor(self):
        self.ingest()
        with self.assertRaises(ValueError):
            self.store.ingest([], {UNIT, "another.service"}, 1)
        self.assertEqual(self.store.cursor(), "cursor-1")

    def test_cursor_and_pending_are_atomic_and_durable(self):
        self.ingest()
        self.store.close()
        self.store = AuditStore(self.tmp.name)
        self.assertEqual(self.store.cursor(), "cursor-1")
        self.assertEqual(self.store.summary(20)["pending"], 1)

    def test_capacity_does_not_skip_cursor(self):
        self.store.max_events = 1
        self.ingest()
        with self.assertRaises(RuntimeError):
            self.ingest(cursor="cursor-2")
        self.assertEqual(self.store.cursor(), "cursor-1")

    def test_failed_batch_rolls_back_all_records(self):
        with self.assertRaises(ValueError):
            self.store.ingest([event(), event(__CURSOR="")], {UNIT}, 0)
        self.assertIsNone(self.store.cursor())
        self.assertEqual(self.store.summary(0)["total"], 0)

    def test_same_timestamp_is_not_attribution(self):
        normalized = normalize_event(event(), {UNIT})
        self.assertIsNone(exact_attribution(normalized, [{"unit": UNIT, "time_epoch": 1789900000}]))

    def test_attribution_requires_exact_boot_job_unit_action(self):
        normalized = normalize_event(event(), {UNIT})
        for patch in ({"boot_id": "b" * 32}, {"job_id": "43"},
                      {"unit": "other.service"}, {"action": "stop"}, {"outcome": "failed"}):
            self.assertIsNone(exact_attribution(normalized, [evidence(**patch)]))
        self.assertEqual(exact_attribution(normalized, [evidence()])["operation_id"], "op-1")

    def test_restart_receipt_can_bind_same_job_phases(self):
        self.assertIsNotNone(exact_attribution(normalize_event(event(), {UNIT}), [evidence(action="restart")]))

    def test_conflicting_receipts_remain_unattributed(self):
        normalized = normalize_event(event(), {UNIT})
        self.assertIsNone(exact_attribution(normalized, [evidence(), evidence(operation_id="op-2")]))

    def test_late_receipt_reconciles_already_ingested_event(self):
        self.ingest()
        self.store.reconcile([evidence()])
        self.assertEqual(self.store.summary(0)["attributed"], 1)
        self.assertEqual(self.store.dispatch(lambda _: self.fail("must not send"), 100), 0)

    def test_transport_error_keeps_retry_and_excludes_error_text(self):
        self.ingest()
        def fail(_):
            raise RuntimeError("SECRET TOKEN")
        self.assertEqual(self.store.dispatch(fail, 0), 0)
        self.assertEqual(self.store.summary(100)["pending"], 1)
        row = dict(self.store.db.execute("SELECT * FROM events").fetchone())
        self.assertNotIn("SECRET", json.dumps(row))
        self.assertEqual(row["attempts"], 1)
        self.assertGreater(row["next_attempt"], 0)

    def test_sent_or_wrong_receipt_never_completes(self):
        self.ingest()
        for now, receipt in enumerate(({"state": "sent"}, {"state": "delivered", "event_id": "wrong", "receipt_id": "r1"})):
            self.store.dispatch(lambda _, r=receipt: r, now * 1000)
        self.assertEqual(self.store.summary(1000)["pending"], 1)

    def test_same_identity_retry_after_unknown_send(self):
        self.ingest()
        calls = []
        def sender(payload):
            calls.append(payload["event_id"])
            if len(calls) == 1:
                raise TimeoutError("accepted but receipt lost")
            return {"state": "delivered", "event_id": payload["event_id"], "receipt_id": "broker-1", "secret": "do not store"}
        self.store.dispatch(sender, 0)
        self.store.dispatch(sender, 1000)
        self.store.dispatch(sender, 2000)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0], calls[1])
        self.assertEqual(self.store.summary(2000)["delivered"], 1)
        self.assertNotIn("secret", self.store.db.execute("SELECT receipt FROM events").fetchone()[0])

    def test_crash_after_send_keeps_obligation_for_same_broker_key(self):
        self.ingest()
        with self.assertRaises(KeyboardInterrupt):
            self.store.dispatch(lambda _: (_ for _ in ()).throw(KeyboardInterrupt()), 0)
        self.assertEqual(self.store.summary(1)["pending"], 1)
        self.assertEqual(self.store.db.execute("SELECT attempts FROM events").fetchone()[0], 1)

    def test_two_collectors_claim_once_before_io(self):
        self.ingest()
        second = AuditStore(self.tmp.name)
        def sender(payload):
            self.assertEqual(second.dispatch(lambda _: self.fail("duplicate claim"), 0), 0)
            return {"state": "delivered", "event_id": payload["event_id"], "receipt_id": "r1"}
        try:
            self.assertEqual(self.store.dispatch(sender, 0), 1)
        finally:
            second.close()

    def test_unsafe_state_directory_rejected(self):
        unsafe = os.path.join(self.tmp.name, "unsafe")
        os.mkdir(unsafe, 0o755)
        with self.assertRaises(ValueError):
            AuditStore(unsafe)

    def test_symlink_database_rejected(self):
        other = os.path.join(self.tmp.name, "other")
        os.mkdir(other, 0o700)
        os.symlink(os.path.join(self.tmp.name, "audit.sqlite3"), os.path.join(other, "audit.sqlite3"))
        with self.assertRaises(OSError):
            AuditStore(other)


if __name__ == "__main__":
    unittest.main()
