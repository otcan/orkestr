"""Operator policy shape is checked before a selected package is published."""
import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from beta_config import provider_routing


class ProviderRouting(unittest.TestCase):
    def config(self):
        return {"provider_routing": {"rules": [{
            "id": "synthetic-category", "threshold": 3,
            "terms": [{"text": "cedar", "weight": 3}],
            "excluded": "claude", "preferred": "codex",
        }]}}

    def test_absent_and_valid_policy(self):
        provider_routing({})
        provider_routing(self.config())

    def test_invalid_policy_never_reaches_runtime(self):
        cases = [[], {"rules": []}, {"rules": [], "command": "synthetic"}]
        for value in cases:
            with self.subTest(value=value), self.assertRaises(Exception):
                provider_routing({"provider_routing": value})
        for field, value in [("threshold", True), ("preferred", "claude"),
                             ("id", "invalid id"), ("conversations", ["bad"]),
                             ("terms", [{"text": "", "weight": 3}]),
                             ("terms", [{"text": "cedar", "weight": True}])]:
            config = self.config()
            config["provider_routing"]["rules"][0][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(Exception):
                provider_routing(config)

    def test_duplicate_ids_are_not_order_dependent(self):
        config = self.config()
        config["provider_routing"]["rules"].append(copy.deepcopy(config["provider_routing"]["rules"][0]))
        with self.assertRaises(Exception):
            provider_routing(config)


if __name__ == "__main__":
    unittest.main()
