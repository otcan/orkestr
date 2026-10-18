"""Synthetic verifier tests, not evidence of actual Rust bridge execution."""
from copy import deepcopy
from pathlib import Path
import json
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from collector_bridge import verify_bridge
from snapshot import Invalid


class CollectorBridgeTests(unittest.TestCase):
    def report(self):
        page = json.loads((Path(__file__).resolve().parents[2] /
                           'fixtures/conversation-snapshot.json').read_text())
        partial = deepcopy(page)
        partial['last_sequence'] = 2
        partial['next_cursor'] = 1
        return {'format_version': 1, 'expected': page, 'pages': [page],
                'refused_partial_pages': [partial], 'refusal_observed': True}

    def test_complete_and_partial_discard(self):
        report = self.report()
        before = deepcopy(report)
        self.assertTrue(verify_bridge(report)['partial_discarded'])
        self.assertEqual(report, before)

    def test_mixed_cut_and_complete_partial_refused(self):
        for key in ('pages', 'refused_partial_pages'):
            report = self.report()
            if key == 'pages':
                report[key] = deepcopy(report[key])
                report[key][0]['messages'][0]['text'] = 'late synthetic value'
            else:
                report[key] = [report['expected']]
            with self.assertRaises(Invalid):
                verify_bridge(report)

    def test_missing_or_malformed_refusal(self):
        for value in ([], [{'unexpected': 'synthetic'}]):
            report = self.report()
            report['refused_partial_pages'] = value
            with self.assertRaises(Invalid):
                verify_bridge(report)
        report = self.report()
        report['refusal_observed'] = False
        with self.assertRaises(Invalid):
            verify_bridge(report)
