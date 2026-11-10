from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core_history import prepare_import, verify_import_receipt
from snapshot import Invalid

NS = '00000000-0000-0000-0000-000000000001'
CONV = '00000000-0000-0000-0000-000000000002'
OWNER = '00000000-0000-0000-0000-000000000004'


class CoreHistoryTests(unittest.TestCase):
    def page(self):
        return {'conversation_id': CONV, 'scope': {'kind': 'global'},
                'last_sequence': 0, 'messages': [], 'next_cursor': None}

    def test_exact_fields_and_pinned_digest(self):
        request = prepare_import([self.page()], namespace=NS)
        self.assertEqual(set(request), {'namespace', 'source_digest', 'source_conversation_id',
                                       'source_scope', 'source_watermark', 'messages'})
        self.assertEqual(request['source_digest'], '705fbd75e107ac9ebf0f4f5d1adb1ac05629d3b30b8abd8d674626f4aafc40e3')
        receipt = {**{key: request[key] for key in ('namespace', 'source_digest', 'source_conversation_id', 'source_watermark')},
                   'schema_version': 1, 'owner_id': OWNER, 'message_count': 0, 'revision': 1, 'active': True}
        self.assertEqual(verify_import_receipt(receipt, request, target_owner=OWNER), receipt)
        for key, value in [('active', False), ('revision', 2), ('message_count', 1), ('owner_id', NS), ('source_watermark', False)]:
            with self.assertRaises(Invalid):
                verify_import_receipt({**receipt, key: value}, request, target_owner=OWNER)

    def test_incomplete_and_nil_namespace_refuse(self):
        with self.assertRaises(Invalid):
            prepare_import([], namespace=NS)
        with self.assertRaises(Invalid):
            prepare_import([self.page()], namespace='00000000-0000-0000-0000-000000000000')

    def test_unsupported_actor_and_non_utf8_refuse(self):
        page = self.page()
        page['last_sequence'] = 1
        page['messages'] = [{'message_id': NS, 'sequence': 1, 'actor_kind': 'provider', 'text': 'Synthetic'}]
        with self.assertRaises(ValueError):
            prepare_import([page], namespace=NS)
        page['messages'][0]['actor_kind'] = 'owner'
        page['messages'][0]['text'] = '\ud800'
        with self.assertRaises(UnicodeError):
            prepare_import([page], namespace=NS)
