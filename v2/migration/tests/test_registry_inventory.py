import json
from pathlib import Path
import os
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from registry_inventory import read_timer_inventory, project_timers


class RegistryInventoryTests(unittest.TestCase):
    def test_fixed_buckets_no_private_values(self):
        raw = [{'id': 'PRIVATE_ID', 'prompt': 'PRIVATE_PROMPT', 'target': 'PRIVATE_TARGET',
                'cadence': 'daily', 'enabled': False, 'status': 'disabled', 'targetType': 'thread',
                'requiredConnector': 'PRIVATE_CONNECTOR'}, {'cadence': 'PRIVATE_VALUE', 'enabled': 1}, None]
        result = project_timers(raw)
        self.assertNotIn('PRIVATE', json.dumps(result))
        self.assertEqual(result['enabled_field']['false'], 1)
        self.assertEqual(result['enabled_field']['unknown'], 1)
        self.assertEqual(result['non_objects'], 1)

    def test_missing_and_malformed_do_not_mean_absent_feature(self):
        with tempfile.TemporaryDirectory() as home:
            self.assertEqual(read_timer_inventory(home)['coverage'], 'missing_file')
            path = Path(home)/'timers.json'
            for content in ('{}', '[', '[{"enabled":true,"enabled":false}]', '[NaN]'):
                path.write_text(content)
                with self.assertRaises(ValueError):
                    read_timer_inventory(home)
            path.write_text('[{}]')
            self.assertEqual(read_timer_inventory(home)['counts']['rows'], 1)

    def test_alias_and_nonregular_refusal(self):
        with tempfile.TemporaryDirectory() as home:
            root = Path(home)
            (root/'synthetic.json').write_text('[]')
            path = root/'timers.json'
            path.symlink_to(root/'synthetic.json')
            with self.assertRaises(OSError):
                read_timer_inventory(home)
            path.unlink()
            os.link(root/'synthetic.json', path)
            with self.assertRaises(ValueError):
                read_timer_inventory(home)
            path.unlink()
            os.mkfifo(path)
            with self.assertRaises(ValueError):
                read_timer_inventory(home)

    def test_legacy_and_case_are_explicit_unknown(self):
        result = project_timers([{'cadence': 'DAILY', 'legacy': {}, 'repeat': {}}, {'cadence': 'unknown'}, {}])
        self.assertEqual(result['cadence']['unknown'], 2)
        self.assertEqual(result['cadence']['missing'], 1)
        self.assertEqual(result['legacy_object_present'], 1)
