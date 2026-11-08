"""Exports must leave room for both architectures and unrelated caches."""
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location(
    'cache_budget', Path(__file__).resolve().parents[1] / 'cache_budget.py')
budget = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(budget)


class CacheBudgetTests(unittest.TestCase):
    def test_lagging_aggregate_cannot_hide_completed_uploads(self):
        replies = iter([{'active_caches_size_in_bytes': 100},
                        {'total_count': 2, 'actions_caches': [{'id': 1, 'size_in_bytes': 80}]},
                        {'total_count': 2, 'actions_caches': [{'id': 2, 'size_in_bytes': 90}]}])
        observed = budget.observed_usage(lambda _: next(replies))
        self.assertEqual(observed['repository_cache_bytes'], 170)
        self.assertEqual(observed['listed_cache_entries'], 2)

    def test_more_conservative_aggregate_remains_reserved(self):
        replies = iter([{'active_caches_size_in_bytes': 200},
                        {'total_count': 1, 'actions_caches': [{'id': 1, 'size_in_bytes': 80}]}])
        self.assertEqual(budget.observed_usage(lambda _: next(replies))['repository_cache_bytes'], 200)

    def test_duplicate_ids_or_changing_totals_cannot_understate_usage(self):
        for second in [{'total_count': 2, 'actions_caches': [{'id': 1, 'size_in_bytes': 90}]},
                       {'total_count': 3, 'actions_caches': [{'id': 2, 'size_in_bytes': 90}]}]:
            replies = iter([{'active_caches_size_in_bytes': 0},
                            {'total_count': 2, 'actions_caches': [{'id': 1, 'size_in_bytes': 80}]}, second])
            with self.assertRaises(ValueError):
                budget.observed_usage(lambda _: next(replies))

    def test_unknown_entries_and_unbounded_listings_disable_export(self):
        for listing in [{'total_count': 1001, 'actions_caches': []},
                        {'total_count': True, 'actions_caches': []},
                        {'total_count': 1, 'actions_caches': [{'id': 1, 'size_in_bytes': -1}]},
                        {'total_count': 1, 'actions_caches': []}]:
            replies = iter([{'active_caches_size_in_bytes': 0}, listing])
            with self.assertRaises(ValueError):
                budget.observed_usage(lambda _: next(replies))

    def test_cold_cache_fits_but_two_concurrent_large_exports_do_not(self):
        self.assertTrue(budget.decide(0, 1024 ** 3, budget.allocation(0))['export_allowed'])
        self.assertFalse(budget.decide(0, 5 * 1024 ** 3, budget.allocation(0))['export_allowed'])

    def test_existing_unrelated_caches_are_reserved_not_evicted(self):
        self.assertFalse(budget.decide(8 * 1024 ** 3, 1024 ** 3,
                                     budget.allocation(8 * 1024 ** 3))['export_allowed'])

    def test_completed_sibling_does_not_consume_the_same_allowance_twice(self):
        initial = 4 * 1024 ** 3
        allowance = budget.allocation(initial)
        cache_bytes = allowance - 64 * 1024 ** 2
        self.assertTrue(budget.decide(initial, cache_bytes, allowance)['export_allowed'])
        self.assertTrue(budget.decide(initial + allowance, cache_bytes, allowance)['export_allowed'])
        self.assertFalse(budget.decide(initial + allowance + 1, cache_bytes, allowance)['export_allowed'])

    def test_unknown_and_ambiguous_inventory_fail_closed(self):
        for usage, rows in [(True, 10), (-1, 10), (None, 10), (0, 0),
                            (0, '1 GB'), (0, True)]:
            with self.subTest(usage=usage, rows=rows), self.assertRaises(ValueError):
                budget.decide(usage, rows, 1024 ** 3)


if __name__ == '__main__':
    unittest.main()
