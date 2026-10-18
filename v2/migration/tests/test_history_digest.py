import unittest
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from history_digest import source_digest


class HistoryDigestTests(unittest.TestCase):
    def test_pinned_empty(self):
        self.assertEqual(source_digest({
            'source_conversation_id': '00000000-0000-0000-0000-000000000002',
            'source_scope': {'kind': 'global'}, 'source_watermark': 0,
            'messages': [],
        }), '705fbd75e107ac9ebf0f4f5d1adb1ac05629d3b30b8abd8d674626f4aafc40e3')

    def test_owner_actor_only(self):
        with self.assertRaises(ValueError):
            source_digest({
                'source_conversation_id': '00000000-0000-0000-0000-000000000002',
                'source_scope': {'kind': 'global'}, 'source_watermark': 1,
                'messages': [{'message_id': '00000000-0000-0000-0000-000000000003',
                              'sequence': 1, 'actor_kind': 'provider', 'text': 'Synthetic'}],
            })
