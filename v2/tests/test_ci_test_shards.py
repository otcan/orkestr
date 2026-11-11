"""Assignment and coverage decisions only: no cargo, no test binary."""
import json
from pathlib import Path
import tempfile
import unittest

import ci_test_shards as shards

LISTING = """\
store::opens_a_fresh_database: test
store::slow_property: test
runtime::tests::child: test
runtime::tests::child: test
timer_lifecycle: test

unrelated cargo output
bench_only: benchmark
"""


def plans(names, count, weights=None, default=1.0):
    return [shards.make_plan(names, count, index, default, weights or {}) for index in range(1, count + 1)]


class ListingTests(unittest.TestCase):
    def test_names_are_unique_sorted_and_other_lines_are_ignored(self):
        self.assertEqual(shards.listed(LISTING), [
            "bench_only", "runtime::tests::child", "store::opens_a_fresh_database",
            "store::slow_property", "timer_lifecycle"])

    def test_empty_listing_and_names_that_cannot_be_exact_filters_are_refused(self):
        for output in ("", "nothing here\n", "has space: test\n", "--list: test\n"):
            with self.assertRaises(shards.Refused, msg=output):
                shards.listed(output)


class AssignmentTests(unittest.TestCase):
    def test_every_name_lands_in_exactly_one_shard_for_any_shard_count(self):
        names = shards.listed("".join(f"module_{n % 7}::case_{n}: test\n" for n in range(203)))
        for count in (1, 2, 3, 8, 50):
            groups, _ = shards.assign(names, count, 1.0, {"module_0::case_0": 400.0})
            self.assertEqual(sorted(name for group in groups for name in group), names)
            self.assertEqual(shards.verify(plans(names, count, {"module_0::case_0": 400.0}))["total"], len(names))

    def test_a_dominant_test_gets_a_shard_of_its_own_and_the_rest_balance(self):
        names = [f"case_{n:03}" for n in range(60)] + ["slow_a", "slow_b"]
        groups, loads = shards.assign(names, 4, 1.0, {"slow_a": 700.0, "slow_b": 700.0})
        self.assertEqual([groups[0], groups[1]], [["slow_a"], ["slow_b"]])
        self.assertEqual([len(groups[2]), len(groups[3])], [30, 30])
        self.assertEqual(loads, [700.0, 700.0, 30.0, 30.0])

    def test_assignment_is_the_same_whatever_order_the_listing_came_in(self):
        names = [f"t{n}" for n in range(40)]
        self.assertEqual(shards.assign(names, 5, 0.5, {"t3": 9.0}), shards.assign(names[::-1], 5, 0.5, {"t3": 9.0}))

    def test_a_shard_without_tests_and_an_index_out_of_range_are_refused(self):
        for index, count in ((3, 3), (0, 2), (3, 2)):
            with self.assertRaises(shards.Refused):
                shards.make_plan(["a", "b"], count, index, 1.0, {})


class VerifyTests(unittest.TestCase):
    def setUp(self):
        self.names = [f"suite::case_{n}" for n in range(25)]
        self.plans = plans(self.names, 4)

    def test_a_complete_set_of_plans_is_accepted(self):
        self.assertEqual(shards.verify(self.plans), {
            "shards": 4, "total": 25, "list_sha256": shards.digest(sorted(self.names))})

    def test_missing_duplicate_or_disagreeing_plans_are_refused(self):
        missing = self.plans[:-1]
        twice = [*self.plans[:-1], self.plans[0]]
        other_list = [*self.plans[:-1], shards.make_plan([*self.names, "suite::new"], 4, 4, 1.0, {})]
        dropped = json.loads(json.dumps(self.plans))
        dropped[1]["selected"].pop()
        overlapping = json.loads(json.dumps(self.plans))
        overlapping[1]["selected"].append(overlapping[0]["selected"][0])
        for broken in ([], missing, twice, other_list, dropped, overlapping):
            with self.assertRaises(shards.Refused):
                shards.verify(broken)


class CommandTests(unittest.TestCase):
    def test_the_cargo_command_must_follow_the_separator_and_carry_no_test_arguments(self):
        self.assertEqual(shards.cargo_arguments(["--", "cargo", "test", "--workspace"]), ["cargo", "test", "--workspace"])
        for arguments in ([], ["--"], ["--", "cargo", "test", "--", "--ignored"]):
            with self.assertRaises(shards.Refused):
                shards.cargo_arguments(arguments)

    def test_weights_must_be_positive_numbers(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "weights.json"
            path.write_text(json.dumps({"default_seconds": 0.3, "tests": {"slow": 12}}))
            self.assertEqual(shards.load_weights(path), (0.3, {"slow": 12.0}))
            for document in ({"default_seconds": 0, "tests": {}}, {"default_seconds": 1, "tests": {"slow": -1}},
                             {"default_seconds": 1, "tests": []}):
                path.write_text(json.dumps(document))
                with self.assertRaises(shards.Refused):
                    shards.load_weights(path)

    def test_the_checked_in_weights_leave_each_store_property_test_alone_on_eight_shards(self):
        default, weights = shards.load_weights(Path(__file__).with_name("ci_test_weights.json"))
        names = [*weights, *(f"suite::case_{n}" for n in range(1950))]
        groups, loads = shards.assign(names, 8, default, weights)
        alone = [group[0] for group in groups if len(group) == 1]
        self.assertEqual(len(alone), 2)
        self.assertTrue(all("::stranded::failures::property::" in name for name in alone))
        shared = [load for group, load in zip(groups, loads) if len(group) > 1]
        self.assertLess(max(shared) - min(shared), 2.0)

    def test_the_checked_in_weights_cover_the_long_tests_measured_in_ci(self):
        # Seconds each test added to its shard in the unit job logs of 2026-11-11
        # (ORK-791). A long test without a weight counts default_seconds and can
        # land beside other long tests: that shard ran a minute past the others.
        measured = {
            "owner_worker_budgets_preserve_deadlines_stop_and_tool_lineage": 152,
            "production_runtime::process_tests::actual_process_crashes_preserve_atomic_ack_and_never_reissue_dispatch": 54,
            "ordinary_durable_timer_binary_logout_restart_crash_and_revocation": 71,
            "same_owned_process_survives_natural_lease_and_original_control_still_stops": 59,
            "steering_is_scoped_durable_and_never_replayed_after_uncertainty": 61,
            "containment::tests::durable_races::natural_store_deadline_expiry_fences_owned_child_without_clock_override": 54,
            "worker_original_reap_proofs_survive_parent_lifecycle": 45,
            "ordinary_fast_presentation_continuation_stop_restart_and_revocation": 43,
            "ordinary_http_dispatch_progress_acceptance_and_revocation": 43,
            "claude_stop_requires_terminal_reap_and_preserves_held_inputs": 34,
            "preflight::tests::schema36_edges::populated_prefixes_copy_first_edges_to_50_preserve_rows_and_rollback_source": 25,
            "http_and_crash_recovery": 24,
        }
        _, weights = shards.load_weights(Path(__file__).with_name("ci_test_weights.json"))
        for name, seconds in measured.items():
            self.assertGreaterEqual(weights.get(name, 0), 0.8 * seconds, name)


if __name__ == "__main__":
    unittest.main()
