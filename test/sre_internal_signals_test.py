from pathlib import Path
import json
import os
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "sre"))
from evidence_archive import digest
from internal_signals import collect, load_signal, protected_json, table_id
from reachability import Monitor, classify, main
from service_audit import AuditStore


def policy():
    return {"source_id": "example-core", "routes": [{"source": "192.0.2.2", "destination": "198.51.100.1",
             "gateway": "192.0.2.1", "device": "eth0", "table": 1001, "priority": 100}],
            "task_budgets": {"example.service": 100}, "thresholds": {"memory_available_fraction": .1,
             "swap_used_fraction": .8, "memory_psi_avg10": 10, "file_used_fraction": .8, "host_tasks": 5000}}


class SignalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.reads = {"/proc/meminfo": "MemTotal: 100 kB\nMemAvailable: 50 kB\nSwapTotal: 10 kB\nSwapFree: 10 kB\n",
                      "/proc/pressure/memory": "some avg10=0.00 avg60=0.00 avg300=0.00 total=123\n",
                      "/proc/loadavg": "0.1 0.2 0.3 1/100 42", "/proc/sys/fs/file-nr": "100 0 1000"}
        self.route_device = "eth0"
        self.route_table = {"table": 1001}
        self.rules = [{"src": "192.0.2.2", "priority": 100, "table": 1001}]

    def tearDown(self):
        self.tmp.cleanup()

    def runner(self, args, **kwargs):
        self.assertEqual(kwargs["timeout"], 5)
        if args[0] == "systemctl":
            self.assertNotIn("Environment", str(args))
            data = "Id=example.service\nLoadState=loaded\nActiveState=active\nTasksCurrent=10\nTasksMax=200\nMemoryCurrent=1000\n"
            if args[2].startswith("nord"):
                data = f"Id={args[2]}\nActiveState=inactive\nUnitFileState=masked\n"
        elif "route" in args:
            data = json.dumps([{"dev": self.route_device, "gateway": "192.0.2.1", **self.route_table}])
        elif "rule" in args:
            data = json.dumps(self.rules)
        else:
            data = json.dumps([{"ifname": "eth0"}, {"ifname": "tun0"}])
        return SimpleNamespace(returncode=0, stdout=data)

    def sample(self):
        return collect(policy(), 100, self.runner, self.reads.__getitem__)

    def save(self, sample):
        path = Path(self.tmp.name) / "signal.json"
        path.write_text(json.dumps(sample))
        path.chmod(0o600)
        return path

    def test_collects_only_minimized_metadata_without_treating_intended_tunnel_as_vpn(self):
        sample = self.sample()
        self.assertTrue(sample["route_ok"])
        self.assertFalse(sample["resource_pressure"])
        self.assertEqual(sample["errors"], [])
        self.assertNotIn("192.0.2", json.dumps(sample))

    def test_route_and_source_rule_drift_are_detected(self):
        self.route_device = "nordlynx"
        self.assertFalse(self.sample()["route_ok"])
        self.route_device = "eth0"
        self.rules[0]["priority"] = 200
        self.assertFalse(self.sample()["route_ok"])

    def test_known_tables_normalize_but_missing_rule_and_unknown_alias_do_not(self):
        for value, expected in (("main", 254), ("default", 253), ("local", 255), ("1001", 1001), (1001, 1001)):
            self.assertEqual(table_id(value), expected)
        for value in (None, True, 1.0, "operator-table", "0254", "", -1, "4294967296"):
            self.assertIsNone(table_id(value, route_get=True))
        self.assertEqual(table_id(route_get=True), 254)
        self.assertIsNone(table_id())

    def test_main_named_numeric_and_omitted_route_get_table_agree(self):
        expected = policy()
        expected["routes"][0]["table"] = 254
        for rule_table in ("main", "254", 254):
            self.rules[0]["table"] = rule_table
            for route_table in ({"table": "main"}, {"table": "254"}, {"table": 254}, {}):
                self.route_table = route_table
                self.assertTrue(collect(expected, 100, self.runner, self.reads.__getitem__)["route_ok"])

    def test_absent_table_never_matches_arbitrary_policy_or_missing_rule(self):
        self.route_table = {}
        self.assertFalse(self.sample()["route_ok"])
        expected = policy()
        expected["routes"][0]["table"] = 254
        self.rules[0].pop("table")
        self.assertFalse(collect(expected, 100, self.runner, self.reads.__getitem__)["route_ok"])
        self.rules[0]["table"] = "main"
        self.route_table = {"table": None}
        self.assertFalse(collect(expected, 100, self.runner, self.reads.__getitem__)["route_ok"])
        self.route_table = {"table": "unknown-alias"}
        self.assertFalse(collect(expected, 100, self.runner, self.reads.__getitem__)["route_ok"])
        self.route_table = {"type": "local"}
        self.assertFalse(collect(expected, 100, self.runner, self.reads.__getitem__)["route_ok"])

    def test_pressure_warns_even_before_public_probe_failure(self):
        self.reads["/proc/pressure/memory"] = "some avg10=20.00 total=100"
        sample = self.sample()
        self.assertTrue(sample["resource_pressure"])
        self.assertEqual(classify(True, True, sample, 110), "resource_pressure")

    def test_failed_internal_reads_never_become_false_health(self):
        def timeout(*args, **kwargs):
            raise subprocess.TimeoutExpired(args[0], 5)
        sample = collect(policy(), 100, timeout, self.reads.__getitem__)
        self.assertIsNone(sample["route_ok"])
        self.assertIsNone(sample["resource_pressure"])
        self.assertTrue(sample["errors"])

    def test_malformed_ip_records_remain_missing_telemetry_without_crashing(self):
        for command, error in (("route", "route_read_failed"), ("rule", "route_read_failed"),
                               ("link", "vpn_read_failed")):
            for payload in ({}, None, "unexpected", [None], ["unexpected"], [1]):
                with self.subTest(command=command, payload=payload):
                    def runner(args, **kwargs):
                        if args[0] == "ip" and command in args:
                            return SimpleNamespace(returncode=0, stdout=json.dumps(payload))
                        return self.runner(args, **kwargs)
                    result = collect(policy(), 100, runner, self.reads.__getitem__)
                    self.assertIn(error, result["errors"])
                    self.assertIsNone(result["route_ok"])

    def test_empty_or_unnamed_link_inventory_cannot_prove_vpn_absence(self):
        for payload in ([], [{}], [{"ifname": None}], [{"ifname": ""}], [{"ifname": 1}]):
            with self.subTest(payload=payload):
                def runner(args, **kwargs):
                    if args[0] == "ip" and "link" in args:
                        return SimpleNamespace(returncode=0, stdout=json.dumps(payload))
                    return self.runner(args, **kwargs)
                result = collect(policy(), 100, runner, self.reads.__getitem__)
                self.assertIsNone(result["vpn_absent"])
                self.assertIn("vpn_read_failed", result["errors"])

    def test_contradictory_vpn_and_route_signal_is_not_healthy(self):
        path = self.save({**self.sample(), "route_ok": True, "vpn_absent": False})
        with self.assertRaisesRegex(ValueError, "inconsistent"):
            load_signal(path, "example-core", digest(policy()), 110)

    def test_only_fresh_bound_file_signals_accepted_and_extras_stripped(self):
        sample = {**self.sample(), "secret_extra": "not retained"}
        path = self.save(sample)
        signal = load_signal(path, "example-core", digest(policy()), 110)
        self.assertEqual(set(signal), {"observed_at", "route_ok", "resource_pressure"})
        for source, hash_value, now in (("other", digest(policy()), 110), ("example-core", "f"*64, 110),
                                      ("example-core", digest(policy()), 300), ("example-core", digest(policy()), 90)):
            with self.assertRaises(ValueError):
                load_signal(path, source, hash_value, now)

    def test_untrusted_file_symlink_hardlink_and_writable_mode_rejected(self):
        path = self.save(self.sample())
        alias = Path(self.tmp.name) / "alias"
        alias.symlink_to(path)
        with self.assertRaises(OSError):
            protected_json(alias)
        alias.unlink()
        os.link(path, alias)
        with self.assertRaises(ValueError):
            protected_json(path)
        alias.unlink()
        path.chmod(0o666)
        with self.assertRaises(ValueError):
            protected_json(path)

    def test_internal_source_policy_is_durably_bound_to_monitor(self):
        with tempfile.TemporaryDirectory() as directory:
            store = AuditStore(directory)
            try:
                binding = {"source_id": "example-core", "policy_digest": digest(policy())}
                Monitor(store, "example", internal_source=binding)
                with self.assertRaises(ValueError):
                    Monitor(store, "example")
                with self.assertRaises(ValueError):
                    Monitor(store, "example", internal_source={**binding, "source_id": "other"})
            finally:
                store.close()

    def test_incomplete_numeric_or_boolean_version_signals_never_pass(self):
        for change in ({"errors": ["task_read_failed"]}, {"resource_pressure": None},
                       {"resource_pressure": 0}, {"version": True}):
            path = self.save({**self.sample(), **change})
            with self.assertRaises(ValueError):
                load_signal(path, "example-core", digest(policy()), 110)

    def test_missing_configured_signal_cannot_recover_active_pressure_incident(self):
        store = AuditStore(self.tmp.name)
        binding = {"source_id": "example-core", "policy_digest": digest(policy())}
        targets = {"ssh": "example.invalid", "https": "https://example.invalid/"}
        try:
            monitor = Monitor(store, "example", internal_source=binding, targets=targets)
            for now in (1, 2, 3):
                monitor.observe("resource_pressure", now)
            args = ["reachability.py", "--state-directory", self.tmp.name, "--probe-id", "example",
                    "--ssh-host", targets["ssh"], "--https-url", targets["https"], "--internal-signal",
                    str(Path(self.tmp.name) / "missing"), "--signal-source", binding["source_id"],
                    "--signal-policy-digest", binding["policy_digest"]]
            for now in (4, 5):
                with patch("sys.argv", args), patch("reachability.probe", return_value=True), patch("reachability.time.time", return_value=now), patch("builtins.print"):
                    self.assertEqual(main(), 2)
            state = json.loads(store.db.execute("SELECT state FROM monitors WHERE id='example'").fetchone()[0])
            self.assertEqual(state["active"], "resource_pressure")
            self.assertEqual(store.summary(5)["total"], 1)
        finally:
            store.close()
