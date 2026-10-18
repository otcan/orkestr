"""Synthetic validator tests. Nothing here is application release evidence."""

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from release_evidence_policy import GATES
from release_readiness import EvidenceError, evaluate, strict_json


REVISION = "a" * 40
NOW = datetime(2026, 10, 18, 18, tzinfo=timezone.utc)


def iso(value):
    return value.isoformat().replace("+00:00", "Z")


class ReleaseReadinessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        payload = b"synthetic test artifact; never production evidence\n"
        (self.root / "synthetic.txt").write_bytes(payload)
        self.artifact = {"path": "synthetic.txt", "sha256": hashlib.sha256(payload).hexdigest()}
        self.scope = {
            "schema_version": 1, "baseline_revision": "b" * 40,
            "reviewed_by": "synthetic-test-reviewer", "reviewed_at": iso(NOW - timedelta(days=5)),
            "repository": "example/orkestr", "required_ci": ["rust", "test (3)", "web"],
            "release_ci": ["image-publish", "provenance"],
            "conditional_ci_skips": {
                "image-publish": {"reason": "publication-only job", "stages": ["development", "candidate"]},
                "provenance": {"reason": "publication-only job", "stages": ["development", "candidate"]},
            },
            "install_targets": ["linux-x86_64", "linux-aarch64"],
            "workflows": {"conversation": True, "timers": True, "unused_example": False},
            "inventory_artifact": deepcopy(self.artifact),
        }
        self.scope_bytes = json.dumps(self.scope, sort_keys=True).encode()
        self.packet = {
            "schema_version": 1, "scope_sha256": hashlib.sha256(self.scope_bytes).hexdigest(),
            "generated_at": iso(NOW),
            "candidate": {"revision": REVISION, "version": "2.0.0-rc.1",
                          "built_at": iso(NOW - timedelta(days=4)), "artifact": deepcopy(self.artifact),
                          "configuration": deepcopy(self.artifact)},
            "gates": {},
        }
        for name, (_, execution, cases) in GATES.items():
            self.packet["gates"][name] = {
                "status": "passed", "revision": REVISION, "execution": execution,
                "candidate_artifact_sha256": self.artifact["sha256"], "configuration_sha256": self.artifact["sha256"],
                "started_at": iso(NOW - timedelta(hours=1)), "completed_at": iso(NOW),
                "expires_at": iso(NOW + timedelta(hours=12)),
                "artifacts": [deepcopy(self.artifact)],
                "cases": {case: "passed" for case in cases},
            }
        self.ci_snapshot = {"total_count": 5, "check_runs": [
            {"name": name, "head_sha": REVISION, "status": "completed", "id": index,
             "conclusion": "success", "completed_at": iso(NOW),
             "details_url": f"https://github.com/example/orkestr/actions/runs/{index}"}
            for index, name in enumerate(self.scope["required_ci"] + self.scope["release_ci"], start=1)
        ]}
        self.packet["gates"]["ci"]["snapshot_filter"] = "latest"
        for provider in ("codex", "claude"):
            self.packet["gates"]["provider_" + provider].update({
                "provider": provider, "isolated_profile": True,
                "native_sessions": {role: f"synthetic-{provider}-{role}" for role in ("fast", "deep", "worker")},
            })
        self.packet["gates"]["workflow_parity"]["cases"].update({
            name: "passed" for name, used in self.scope["workflows"].items() if used
        })
        self.packet["gates"]["installation"]["cases"].update({
            f"{action}/{target}": "passed" for target in self.scope["install_targets"]
            for action in ("clean_install", "upgrade", "backup_restore")
        })
        self.packet["gates"]["web"].update({
            "history_messages": 10000, "busy_turn_seconds": 30, "composer_editable": True,
        })
        self.packet["gates"]["performance"].update({
            "environment": "synthetic unit-test host and dataset",
            "measurements": {
                name: {"unit": "ms", "samples": [100] * 100,
                       "concurrent_clients": 1 if name == "thread_load" else 10,
                       "access_path": "normal_user_path"}
                for name in ("input_acceptance", "stop_fencing", "thread_load")
            },
        })
        start = NOW - timedelta(hours=72)
        self.packet["gates"]["soak"].update({
            "started_at": iso(start), "material_fixes": 0, "incidents": 0,
            "environment": "daily_use_production",
            "segments": [
                {"started_at": iso(start + timedelta(hours=index)),
                 "completed_at": iso(start + timedelta(hours=index + 1)),
                 "candidate_artifact_sha256": self.artifact["sha256"], "configuration_sha256": self.artifact["sha256"],
                 "revision": REVISION, "status": "passed"} for index in range(72)
            ],
        })
        self.packet["gates"]["cutover"].update({
            "environment": "daily_use_production", "backup_completed_at": iso(NOW - timedelta(hours=2)),
        })

    def result(self, **kwargs):
        snapshot_bytes = json.dumps(self.ci_snapshot).encode()
        (self.root / "ci.json").write_bytes(snapshot_bytes)
        if "ci" in self.packet["gates"]:
            self.packet["gates"]["ci"]["snapshot"] = {
                "path": "ci.json", "sha256": hashlib.sha256(snapshot_bytes).hexdigest(),
            }
        return evaluate(self.packet, self.scope, self.scope_bytes, self.root, REVISION, now=NOW, **kwargs)

    def assertBlocked(self, gate, text):
        result = self.result()
        self.assertFalse(result["ready"])
        blockers = result["stages"]["full_release"]["blockers"]
        self.assertTrue(any(item["gate"] == gate and text in item["reason"] for item in blockers), blockers)

    def test_synthetic_complete_packet_meets_policy(self):
        result = self.result()
        self.assertTrue(result["ready"])
        self.assertEqual(result["highest_ready_stage"], "full_release")

    def test_stages_never_promote_fixture_to_candidate(self):
        self.packet["gates"] = {name: gate for name, gate in self.packet["gates"].items()
                                if GATES[name][0] == "development"}
        result = self.result(requested="development")
        self.assertTrue(result["ready"])
        self.assertEqual(result["highest_ready_stage"], "development")
        self.assertFalse(self.result()["ready"])

    def test_development_accepts_actual_workspace_version(self):
        self.packet["candidate"]["version"] = "0.0.1"
        self.assertEqual(self.result()["highest_ready_stage"], "development")
        self.assertTrue(self.result(requested="development")["ready"])
        self.assertBlocked("candidate_version", "requires artifact version")

    def test_missing_soak_preserves_candidate_only(self):
        del self.packet["gates"]["soak"]
        self.assertEqual(self.result()["highest_ready_stage"], "candidate")

    def test_every_required_gate_is_enforced(self):
        complete = deepcopy(self.packet)
        for name in GATES:
            with self.subTest(gate=name):
                self.packet = deepcopy(complete)
                del self.packet["gates"][name]
                self.assertBlocked(name, "missing gate")

    def test_nonpassing_statuses_do_not_pass(self):
        for status in ("pending", "failed", "skipped", "unavailable", "Passed", True):
            with self.subTest(status=status):
                self.packet["gates"]["production_runtime"]["status"] = status
                self.assertBlocked("production_runtime", "not passed")

    def test_candidate_revision_must_match_independent_cli_revision(self):
        self.packet["candidate"]["revision"] = "b" * 40
        self.assertBlocked("packet", "candidate revision mismatch")

    def test_every_gate_is_bound_to_exact_revision(self):
        complete = deepcopy(self.packet)
        for name in GATES:
            with self.subTest(gate=name):
                self.packet = deepcopy(complete)
                self.packet["gates"][name]["revision"] = "b" * 40
                self.assertBlocked(name, "different revision")

    def test_used_workflow_cannot_disappear(self):
        del self.packet["gates"]["workflow_parity"]["cases"]["timers"]
        self.assertBlocked("workflow_parity", "timers")

    def test_live_evidence_is_bound_to_binary_and_configuration(self):
        gate = self.packet["gates"]["provider_codex"]
        gate["candidate_artifact_sha256"] = "c" * 64
        self.assertBlocked("provider_codex", "artifact mismatch")
        gate["candidate_artifact_sha256"] = self.artifact["sha256"]
        gate["configuration_sha256"] = "e" * 64
        self.assertBlocked("provider_codex", "configuration mismatch")

    def test_packet_cannot_silently_replace_reviewed_scope(self):
        self.scope_bytes += b" "
        self.assertBlocked("packet", "scope digest mismatch")

    def test_unlisted_failed_case_blocks(self):
        self.packet["gates"]["web"]["cases"]["extra_accessibility_test"] = "failed"
        self.assertBlocked("web", "not passed")

    def test_ci_missing_failed_skipped_stale_checks(self):
        good = deepcopy(self.ci_snapshot)
        mutations = [
            (lambda data: data.update(check_runs=data["check_runs"][1:], total_count=4), "missing required CI"),
            (lambda data: data["check_runs"][0].update(conclusion="failure"), "CI failed"),
            (lambda data: data["check_runs"][0].update(status="in_progress"), "pending"),
            (lambda data: data["check_runs"][0].update(conclusion="skipped"), "skipped without review"),
            (lambda data: data["check_runs"][0].update(head_sha="c" * 40), "revision mismatch"),
            (lambda data: data["check_runs"][0].update(details_url="https://example.invalid/"), "URL mismatch"),
            (lambda data: data["check_runs"].__setitem__(1, deepcopy(data["check_runs"][0])), "duplicate CI"),
            (lambda data: data["check_runs"].pop(), "pagination"),
        ]
        for mutation, reason in mutations:
            with self.subTest(reason=reason):
                self.ci_snapshot = deepcopy(good)
                mutation(self.ci_snapshot)
                self.assertBlocked("ci", reason)

    def test_reviewed_conditional_skips_allow_pr_checks_but_not_release(self):
        for check in self.ci_snapshot["check_runs"][3:]:
            check["conclusion"] = "skipped"
        self.assertEqual(self.result()["highest_ready_stage"], "candidate")
        self.assertTrue(self.result(requested="development")["ready"])
        self.assertBlocked("ci", "successful release CI required")

    def test_failure_outside_required_scope_cannot_be_hidden(self):
        extra = deepcopy(self.ci_snapshot["check_runs"][0])
        extra.update(name="unexpected-failing-job", id=90, conclusion="failure")
        self.ci_snapshot["check_runs"].append(extra)
        self.ci_snapshot["total_count"] += 1
        self.assertBlocked("ci", "CI failed")

    def test_old_ci_cannot_be_refreshed_by_copying_a_new_snapshot(self):
        self.ci_snapshot["check_runs"][0]["completed_at"] = iso(NOW - timedelta(days=8))
        self.assertBlocked("ci", "execution expired")

    def test_release_artifact_digest_is_bound(self):
        self.packet["gates"]["release_artifacts"]["candidate_artifact_sha256"] = "c" * 64
        self.assertBlocked("release_artifacts", "artifact mismatch")

    def test_each_provider_needs_real_separate_sessions(self):
        for provider in ("codex", "claude"):
            name = "provider_" + provider
            good = deepcopy(self.packet["gates"][name])
            for field, value, reason in (
                ("execution", "fixture", "wrong execution mode"),
                ("provider", "another", "wrong provider"),
                ("isolated_profile", False, "isolated provider"),
                ("native_sessions", {"fast": "same", "deep": "same", "worker": "other"}, "reuse"),
            ):
                with self.subTest(provider=provider, field=field):
                    self.packet["gates"][name] = deepcopy(good)
                    self.packet["gates"][name][field] = value
                    self.assertBlocked(name, reason)
            self.packet["gates"][name] = good

    def test_latency_percentile_is_computed_and_strict(self):
        for name, threshold in (("input_acceptance", 250), ("stop_fencing", 250), ("thread_load", 2000)):
            with self.subTest(measurement=name):
                measure = self.packet["gates"]["performance"]["measurements"][name]
                measure["samples"] = [1] * 94 + [threshold] * 6
                measure["p95_ms"] = 1  # A summary cannot override the raw observations.
                self.assertBlocked("performance", f"{name}: p95")
                measure["samples"] = [1] * 95 + [threshold] * 5
                self.assertTrue(self.result()["ready"])
                measure["samples"] = [1] * 100

    def test_bad_measurements_fail(self):
        measure = self.packet["gates"]["performance"]["measurements"]["input_acceptance"]
        for samples in ([1] * 99, [float("nan")] * 100, [float("inf")] * 100, [True] * 100,
                        [-1] * 100, [10 ** 400] * 100):
            with self.subTest(sample=samples[0]):
                measure["samples"] = samples
                self.assertBlocked("performance", "samples" if len(samples) < 100 else "invalid sample")
        measure["samples"] = [1] * 100
        measure["concurrent_clients"] = 1
        self.assertBlocked("performance", "client count")

    def test_normal_access_path_and_ui_load_are_required(self):
        self.packet["gates"]["performance"]["measurements"]["thread_load"]["access_path"] = "localhost"
        self.assertBlocked("performance", "normal user access")
        self.packet["gates"]["web"].update(history_messages=9999, busy_turn_seconds=29)
        self.assertBlocked("web", "10000")
        self.packet["gates"]["web"]["history_messages"] = 10000
        self.assertBlocked("web", "30")
        self.packet["gates"]["web"]["busy_turn_seconds"] = 30
        self.packet["gates"]["web"]["composer_editable"] = False
        self.assertBlocked("web", "not editable")

    def test_install_target_cannot_be_omitted(self):
        del self.packet["gates"]["installation"]["cases"]["upgrade/linux-aarch64"]
        self.assertBlocked("installation", "upgrade/linux-aarch64")

    def test_soak_requires_72_hours_for_current_build(self):
        self.packet["gates"]["soak"]["started_at"] = iso(NOW - timedelta(hours=71))
        self.assertBlocked("soak", "shorter than 72")
        self.packet["gates"]["soak"]["started_at"] = iso(NOW - timedelta(hours=72))
        self.packet["candidate"]["built_at"] = iso(NOW - timedelta(hours=1))
        self.assertBlocked("soak", "predates candidate")

    def test_live_provider_evidence_cannot_predate_build(self):
        self.packet["gates"]["provider_codex"]["started_at"] = iso(NOW - timedelta(days=5))
        self.assertBlocked("provider_codex", "predates candidate")

    def test_full_release_requires_actual_cutover_and_fresh_backup(self):
        gate = self.packet["gates"]["cutover"]
        gate["environment"] = "canary"
        self.assertBlocked("cutover", "actual production")
        gate["environment"] = "daily_use_production"
        gate["backup_completed_at"] = iso(NOW - timedelta(days=2))
        self.assertBlocked("cutover", "preceding 24 hours")
        gate["backup_completed_at"] = iso(NOW - timedelta(hours=2))
        del gate["cases"]["post_transfer_workflows"]
        self.assertBlocked("cutover", "post_transfer_workflows")

    def test_fixture_or_canary_soak_does_not_qualify_daily_use(self):
        self.packet["gates"]["soak"]["environment"] = "fixture"
        self.assertBlocked("soak", "daily-use production")

    def test_soak_gaps_overlaps_failed_segments_fixes_incidents_and_revision_changes(self):
        good = deepcopy(self.packet["gates"]["soak"])
        mutations = [
            (lambda gate: gate.update(material_fixes=1), "material fixes"),
            (lambda gate: gate.update(incidents=1), "incidents"),
            (lambda gate: gate["segments"][20].update(status="pending"), "segment did not pass"),
            (lambda gate: gate["segments"][20].update(revision="f" * 40), "changed candidate"),
            (lambda gate: gate["segments"][20].update(configuration_sha256="f" * 64), "configuration"),
            (lambda gate: gate["segments"].pop(20), "observation gap"),
            (lambda gate: gate["segments"].insert(20, deepcopy(gate["segments"][19])), "overlap"),
            (lambda gate: gate["segments"].pop(), "complete interval"),
        ]
        for mutation, reason in mutations:
            with self.subTest(reason=reason):
                self.packet["gates"]["soak"] = deepcopy(good)
                mutation(self.packet["gates"]["soak"])
                self.assertBlocked("soak", reason)

    def test_expired_and_open_ended_soak_fail(self):
        gate = self.packet["gates"]["soak"]
        gate["completed_at"] = iso(NOW - timedelta(hours=2))
        gate["expires_at"] = iso(NOW - timedelta(hours=1))
        self.assertBlocked("soak", "expired")
        gate["completed_at"] = iso(NOW)
        gate["expires_at"] = iso(NOW + timedelta(hours=25))
        self.assertBlocked("soak", "freshness policy")
        del gate["completed_at"]
        self.assertBlocked("soak", "timestamp")

    def test_future_evidence_and_packet_before_completion_fail(self):
        gate = self.packet["gates"]["production_runtime"]
        gate["completed_at"] = iso(NOW + timedelta(seconds=1))
        self.assertBlocked("production_runtime", "unfinished")
        gate["completed_at"] = iso(NOW)
        self.packet["generated_at"] = iso(NOW - timedelta(seconds=1))
        self.assertBlocked("production_runtime", "predates evidence")

    def test_date_only_and_naive_timestamps_fail_closed(self):
        for value in ("2026-10-18Z", "2026-10-18T18:00:00", "2026-10-18T18:00:00+01:00Z", None):
            with self.subTest(value=value):
                self.packet["gates"]["web"]["completed_at"] = value
                self.assertBlocked("web", "UTC timestamp")

    def test_artifacts_must_exist_match_and_remain_in_root(self):
        reference = self.packet["candidate"]["artifact"]
        for path, digest, reason in (
            ("missing", self.artifact["sha256"], "missing or unreadable"),
            ("synthetic.txt", "c" * 64, "SHA-256 mismatch"),
            ("../synthetic.txt", self.artifact["sha256"], "inside the artifact root"),
            ("/etc/passwd", self.artifact["sha256"], "inside the artifact root"),
        ):
            with self.subTest(path=path):
                reference.update(path=path, sha256=digest)
                self.assertBlocked("packet", reason)

    def test_artifact_symlink_cannot_escape_root(self):
        (self.root / "outside").symlink_to("/etc/hosts")
        self.packet["candidate"]["artifact"]["path"] = "outside"
        self.assertBlocked("packet", "inside the artifact root")

    def test_unknown_schema_and_unknown_gate_fail_closed(self):
        self.packet["schema_version"] = 2
        self.assertBlocked("packet", "unsupported evidence")
        self.packet["schema_version"] = True
        self.assertBlocked("packet", "unsupported evidence")
        self.packet["schema_version"] = 1
        self.packet["gates"]["typo"] = {}
        self.assertBlocked("packet", "unknown gate")

    def test_json_rejects_duplicate_keys_and_nonfinite_values(self):
        for data in ('{"status":"failed","status":"passed"}', '{"samples":[NaN]}', '{"value":Infinity}'):
            with self.subTest(data=data), self.assertRaises(EvidenceError):
                strict_json(data)

    def test_cli_emits_json_and_fails_for_unready_or_malformed_input(self):
        evidence_path = self.root / "evidence.json"
        scope_path = self.root / "scope.json"
        scope_path.write_bytes(self.scope_bytes)
        command = [sys.executable, str(Path(__file__).with_name("release_readiness.py")),
                   str(evidence_path), "--scope", str(scope_path), "--artifact-root", str(self.root),
                   "--revision", REVISION]
        evidence_path.write_text(json.dumps({"schema_version": 1}))
        result = subprocess.run(command, text=True, capture_output=True, check=False)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertFalse(json.loads(result.stdout)["ready"])
        evidence_path.write_text('{"broken":')
        result = subprocess.run(command, text=True, capture_output=True, check=False)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse(json.loads(result.stdout)["ready"])


if __name__ == "__main__":
    unittest.main()
