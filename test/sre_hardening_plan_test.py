from copy import deepcopy
from pathlib import Path
import subprocess
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "sre"))
from hardening_plan import BOOLS, compile_profile, verify_rollback
from systemd_posture import evaluate


def profile():
    return {"unit": "example.service", "owner": "operator", "approved_by": "reviewer", "change_ref": "change-1",
            "inventory_ref": "inventory-1", "review_until": 2000,
            "properties": {**{key: "yes" for key in BOOLS}, "User": "example", "Group": "example", "ProtectSystem": "strict",
                           "ProtectHome": "yes", "UMask": "0077", "RestrictNamespaces": "yes", "CapabilityBoundingSet": [],
                           "AmbientCapabilities": [], "RestrictAddressFamilies": ["AF_UNIX", "AF_INET", "AF_INET6"],
                           "ReadWritePaths": ["/var/lib/example"]},
            "persistence_paths": ["/usr/local/bin/example", "/etc/systemd/system/example.service"],
            "health_checks": ["https", "routing", "connector", "worker", "mail-dependency"],
            "task_budget": {"max": 200, "headroom_fraction": .5, "basis_ref": "measured-window-1"},
            "restart": {"delay_seconds": 30, "interval_seconds": 300, "burst": 3}}


def baseline():
    return {"unit": "example.service", "failed_count": 0, "missing_phases": [], "observed_peak": 100,
            "span_seconds": 600, "phase_counts": {"startup": 3, "normal": 3, "peak": 3, "recovery": 3}}


class HardeningTests(unittest.TestCase):
    def test_dropin_resets_inherited_lists_and_has_exact_rollback(self):
        plan = compile_profile(profile(), baseline(), 1000)
        content = plan["candidate"]["content"]
        self.assertIn("ReadWritePaths=\nReadWritePaths=/var/lib/example", content)
        self.assertIn("CapabilityBoundingSet=\n", content)
        self.assertIn("TasksMax=200\nRestartSec=30s", content)
        self.assertTrue(verify_rollback(plan, content))
        self.assertFalse(verify_rollback(plan, content + "# changed by operator\n"))
        self.assertFalse(plan["production_applied"])

    def test_unknown_property_or_injected_value_never_becomes_systemd_directive(self):
        for key, value in (("ExecStart", "/bin/false"), ("User", "example\nExecStart=/bin/false"),
                           ("ReadWritePaths", ["/var/lib/%n"]), ("ReadWritePaths", ["/etc"]),
                           ("ReadWritePaths", ["/var/lib/../secrets"])):
            candidate = profile()
            candidate["properties"][key] = value
            with self.assertRaises(ValueError):
                compile_profile(candidate, baseline(), 1000)

    def test_idle_or_failed_baseline_cannot_justify_limits(self):
        for change in ({"missing_phases": ["peak"]}, {"failed_count": 1}, {"span_seconds": 20},
                       {"span_seconds": float("nan")}, {"phase_counts": {}}, {"observed_peak": 190}):
            with self.assertRaises(ValueError):
                compile_profile(profile(), {**baseline(), **change}, 1000)

    def test_root_or_browser_namespace_exception_requires_unexpired_owner_review(self):
        candidate = profile()
        candidate["properties"]["User"] = "root"
        with self.assertRaises(ValueError):
            compile_profile(candidate, baseline(), 1000)
        approval = {"owner": "operator", "change_ref": "change-1", "reason_ref": "privilege-inventory-1", "review_until": 1500}
        candidate["root_exception"] = approval
        candidate["properties"]["RestrictNamespaces"] = ["user", "pid", "net"]
        with self.assertRaises(ValueError):
            compile_profile(candidate, baseline(), 1000)
        candidate["property_exceptions"] = {"RestrictNamespaces": approval}
        self.assertIn("RestrictNamespaces=user pid net", compile_profile(candidate, baseline(), 1000)["candidate"]["content"])
        with self.assertRaises(ValueError):
            compile_profile(candidate, baseline(), 1600)

    def test_each_capability_and_backoff_needs_a_bound(self):
        candidate = profile()
        candidate["properties"]["CapabilityBoundingSet"] = ["CAP_NET_BIND_SERVICE"]
        candidate["properties"]["AmbientCapabilities"] = ["CAP_NET_BIND_SERVICE"]
        with self.assertRaises(ValueError):
            compile_profile(candidate, baseline(), 1000)
        candidate["capability_reasons"] = {"CAP_NET_BIND_SERVICE": "low-port-inventory"}
        compile_profile(candidate, baseline(), 1000)
        candidate["restart"]["delay_seconds"] = 0
        with self.assertRaises(ValueError):
            compile_profile(candidate, baseline(), 1000)

    def test_generated_profile_roundtrips_systemd_property_normalization(self):
        candidate = profile()
        candidate["properties"]["CapabilityBoundingSet"] = ["CAP_NET_BIND_SERVICE"]
        candidate["capability_reasons"] = {"CAP_NET_BIND_SERVICE": "low-port-inventory"}
        posture = compile_profile(candidate, baseline(), 1000)["posture_profile"]
        actual = {key: " ".join(value) if isinstance(value, list) else value for key, value in candidate["properties"].items()}
        actual.update(LoadState="loaded", ActiveState="active", TasksCurrent="100", TasksMax="200", RestartUSec="30s",
                      StartLimitBurst="3", StartLimitIntervalUSec="5min", CapabilityBoundingSet="cap_net_bind_service")
        self.assertEqual(evaluate(actual, posture, 1000), [])
        self.assertIn("profile_review_expired", evaluate(actual, posture, 2001))

    @unittest.skipUnless(shutil.which("systemd-analyze"), "systemd offline verifier unavailable")
    def test_systemd_offline_verifies_generated_directives(self):
        artifact = compile_profile(profile(), baseline(), 1000)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "example.service"
            path.write_text("[Service]\nExecStart=/usr/bin/true\n" + artifact["candidate"]["content"])
            result = subprocess.run(["systemd-analyze", "verify", str(path)], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("Unknown", result.stderr)
            self.assertNotIn("Failed to parse", result.stderr)
