"""Probe concurrency and error accounting without a server."""
import unittest
from stop_performance import measure


class MeasureTests(unittest.TestCase):
    def test_ten_clients_and_receipts(self):
        rows = measure([lambda: (200, {"outcome": "requested_unknown"}, {}) for _ in range(10)])
        self.assertEqual({row["client"] for row in rows}, set(range(10)))
        self.assertTrue(all(row["ok"] and row["duration_ns"] > 0 for row in rows))

    def test_errors_are_samples(self):
        def fail():
            raise TimeoutError()
        rows = measure([fail, lambda: (409, {"error": "conflict"}, {})])
        self.assertEqual(len(rows), 2)
        self.assertFalse(any(row["ok"] for row in rows))
        self.assertEqual(rows[0]["error"], "TimeoutError")


if __name__ == "__main__":
    unittest.main()
