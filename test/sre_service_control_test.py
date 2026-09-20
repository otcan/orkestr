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


if __name__ == "__main__":
    unittest.main()
