from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "sre"))
from service_audit import AuditStore
from service_control import control, receipts


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = AuditStore(self.tmp.name)

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def call(self, runner, unit="example.service"):
        return control(self.store, unit, "restart", "CHANGE-1", "a" * 32, ["example.service"], runner)

    def test_intent_is_durable_before_bus_call_and_job_is_bound(self):
        def run(command, **options):
            self.assertEqual(self.store.db.execute("SELECT outcome FROM controls").fetchone()[0], "intent")
            self.assertIn("RestartUnit", command)
            self.assertIn("--system", command)
            self.assertEqual(set(options["env"]), {"PATH", "LC_ALL"})
            return subprocess.CompletedProcess(command, 0, '{"type":"o","data":["/org/freedesktop/systemd1/job/42"]}')
        self.assertEqual(self.call(run)["outcome"], "accepted")
        self.assertEqual(receipts(self.store)[0]["job_id"], "42")

    def test_unknown_unit_cannot_invoke_bus(self):
        with self.assertRaises(ValueError):
            self.call(lambda *a, **k: self.fail("must not execute"), "another.service")

    def test_timeout_never_retries_or_claims_success(self):
        calls = []
        def run(*args, **options):
            calls.append(1)
            raise subprocess.TimeoutExpired("busctl", 7)
        self.assertEqual(self.call(run)["outcome"], "uncertain")
        self.assertEqual(calls, [1])
        self.assertEqual(receipts(self.store), [])

    def test_exit_zero_without_exact_job_is_not_attributed(self):
        for output in ('{}', '{"type":"o","data":["/other/42"]}', 'bad json'):
            self.assertEqual(self.call(lambda *a, **k: subprocess.CompletedProcess(a, 0, output))["outcome"], "uncertain")

    def test_raw_stderr_is_not_logged(self):
        self.call(lambda *a, **k: subprocess.CompletedProcess(a, 1, "", "SECRET"))
        self.assertNotIn("SECRET", str([tuple(row) for row in self.store.db.execute("SELECT * FROM controls")]))

    def call_keyed(self, runner, **overrides):
        args = dict(unit="example.service", action="restart", change_ref="CHANGE-1", boot_id="a" * 32,
                    allowed_units=["example.service"], runner=runner, operation_id="stable-request")
        args.update(overrides)
        return control(self.store, **args)

    def test_accepted_operation_replay_does_not_issue_another_action(self):
        calls = []
        def run(command, **options):
            calls.append(command)
            return subprocess.CompletedProcess(command, 0, '{"type":"o","data":["/org/freedesktop/systemd1/job/42"]}')
        first = self.call_keyed(run)
        second = self.call_keyed(run)
        self.assertEqual(len(calls), 1)
        self.assertTrue(second["reused"])
        self.assertEqual(first["job_id"], second["job_id"])

    def test_uncertain_operation_remains_uncertain_after_restart(self):
        def timeout(*args, **options):
            raise subprocess.TimeoutExpired("busctl", 7)
        self.call_keyed(timeout)
        self.store.close()
        self.store = AuditStore(self.tmp.name)
        result = self.call_keyed(lambda *a, **k: self.fail("must not retry uncertain action"))
        self.assertEqual(result["outcome"], "uncertain")
        self.assertTrue(result["reused"])

    def test_second_controller_cannot_repeat_an_inflight_operation(self):
        def run(command, **options):
            second = AuditStore(self.tmp.name)
            try:
                result = control(second, "example.service", "restart", "CHANGE-1", "a" * 32,
                                 ["example.service"], lambda *a, **k: self.fail("duplicate control"), operation_id="stable-request")
                self.assertEqual(result["outcome"], "intent")
            finally:
                second.close()
            return subprocess.CompletedProcess(command, 0, '{"type":"o","data":["/org/freedesktop/systemd1/job/42"]}')
        self.assertEqual(self.call_keyed(run)["outcome"], "accepted")

    def test_operation_identity_cannot_be_rebound(self):
        self.call_keyed(lambda *a, **k: subprocess.CompletedProcess(a, 1, ""))
        for overrides in ({"action": "stop"}, {"change_ref": "OTHER"}, {"boot_id": "b" * 32}):
            with self.assertRaises(ValueError):
                self.call_keyed(lambda *a, **k: self.fail("must not execute"), **overrides)

    def test_full_control_ledger_blocks_before_execution(self):
        self.store.max_events = 0
        with self.assertRaises(RuntimeError):
            self.call_keyed(lambda *a, **k: self.fail("must not execute"))
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM controls").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
