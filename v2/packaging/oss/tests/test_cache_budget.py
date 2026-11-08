"""Exports must leave room for both architectures and unrelated caches."""
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location(
    'cache_budget', Path(__file__).resolve().parents[1] / 'cache_budget.py')
budget = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(budget)


class CacheBudgetTests(unittest.TestCase):
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
