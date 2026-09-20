from pathlib import Path
import subprocess
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "sre"))
from systemd_posture import collect, evaluate, parse_properties


class PostureTests(unittest.TestCase):
    def test_parser_drops_sensitive_unrequested_fields(self):
        self.assertEqual(parse_properties("Id=example.service\nEnvironment=SECRET\nExecStart=SECRET\nUser=app"),
                         {"Id": "example.service", "User": "app"})

    def test_budget_needs_measurement_basis(self):
        with self.assertRaises(ValueError):
            evaluate({}, {"taskBudget": {"max": 300}})

    def test_pressure_and_limit_drift_are_independent(self):
        findings = evaluate({"LoadState": "loaded", "ActiveState": "active", "User": "app", "TasksCurrent": "240", "TasksMax": "80000"},
                            {"taskBudget": {"max": 300, "basis": "isolated peak and recovery test"}})
        self.assertEqual(findings, ["task_limit_drift", "task_pressure"])

    def test_infinity_is_not_a_verified_budget(self):
        findings = evaluate({"User": "app", "TasksCurrent": "2", "TasksMax": "infinity"},
                            {"taskBudget": {"max": 300, "basis": "test"}})
        self.assertIn("task_counts_unavailable_or_unbounded", findings)

    def test_no_budget_does_not_invent_a_limit(self):
        self.assertIn("task_budget_unreviewed", evaluate({}, {}))

    def test_unknown_or_secret_properties_rejected(self):
        with self.assertRaises(ValueError):
            evaluate({}, {"properties": {"Environment": ""}})

    def test_root_exception_must_be_explicit(self):
        self.assertIn("undocumented_root_identity", evaluate({"User": ""}, {}))
        self.assertNotIn("undocumented_root_identity", evaluate({"User": "root"}, {"rootException": "privileged helper under review"}))

    def test_command_is_read_only_bounded_and_drops_inherited_environment(self):
        def run(command, **options):
            self.assertEqual(command[:3], ["systemctl", "show", "example.service"])
            self.assertNotIn("Environment", command[-1])
            self.assertEqual(options["timeout"], 10)
            self.assertEqual(set(options["env"]), {"PATH", "LC_ALL"})
            return subprocess.CompletedProcess(command, 0, "Id=example.service\nUser=app\nLoadState=loaded\nActiveState=active")
        result = collect({"unit": "example.service"}, runner=run)
        self.assertFalse(result["ok"])

    def test_option_or_path_injection_rejected(self):
        for unit in ("--all", "../../other.service", "valid.service;evil"):
            with self.assertRaises(ValueError):
                collect({"unit": unit})

    def test_error_payload_does_not_copy_stderr(self):
        result = collect({"unit": "example.service"}, runner=lambda *a, **k: subprocess.CompletedProcess(a, 1, "", "SECRET"))
        self.assertNotIn("SECRET", str(result))


if __name__ == "__main__":
    unittest.main()
