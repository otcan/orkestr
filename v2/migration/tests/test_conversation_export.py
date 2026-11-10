"""Published V2 contract collection using public synthetic fixture only."""
from copy import deepcopy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from conversation_export import collect_pages
from snapshot import Invalid


class ConversationExportTests(unittest.TestCase):
    def setUp(self):
        self.page = json.loads((Path(__file__).resolve().parents[2] /
                               'fixtures/conversation-snapshot.json').read_text())

    def split(self):
        first = deepcopy(self.page)
        first['last_sequence'] = 2
        first['next_cursor'] = 1
        second = deepcopy(first)
        second['next_cursor'] = None
        second['messages'][0].update(message_id='00000000-0000-4000-8000-000000000005',sequence=2)
        return first, second

    def test_existing_contract_and_deterministic_collection(self):
        original = deepcopy(self.page)
        result, digest = collect_pages([self.page])
        self.assertEqual(result, self.page)
        self.assertEqual(self.page, original)
        self.assertEqual((result, digest), collect_pages([deepcopy(self.page)]))
        a,b = self.split()
        combined,_ = collect_pages([a,b])
        self.assertEqual([m['sequence'] for m in combined['messages']], [1,2])

    def test_empty_conversation(self):
        self.page.update(messages=[],last_sequence=0)
        self.assertEqual(collect_pages([self.page])[0]['messages'],[])

    def test_changing_cut_scope_or_conversation_refused(self):
        for field, value in (('last_sequence',3), ('scope',{'kind':'global'}),
                            ('conversation_id','00000000-0000-4000-8000-000000000099')):
            a,b = self.split(); b[field] = value
            with self.subTest(field=field), self.assertRaises(Invalid):
                collect_pages([a,b])

    def test_incomplete_and_trailing_pages_refused(self):
        a,b = self.split()
        for pages in ([],[a],[a,b,b]):
            with self.subTest(pages=len(pages)), self.assertRaises(Invalid):
                collect_pages(pages)

    def test_bad_cursor_order_and_duplicate_identity_refused(self):
        for mutation in ('cursor','order','identity'):
            a,b = self.split()
            if mutation == 'cursor': a['next_cursor']=True
            elif mutation == 'order': b['messages'][0]['sequence']=1
            else: b['messages'][0]['message_id']=a['messages'][0]['message_id']
            with self.subTest(mutation=mutation), self.assertRaises(Invalid):
                collect_pages([a,b])

    def test_unknown_fields_and_page_size_refused(self):
        for mutation in ('extra','size','watermark'):
            page=deepcopy(self.page)
            if mutation=='extra': page['credentials']='synthetic-denied'
            elif mutation=='size': page['messages']*=101
            else: page['last_sequence']=True
            with self.subTest(mutation=mutation), self.assertRaises(Invalid):
                collect_pages([page])

    def test_collector_bounds_refused(self):
        from unittest.mock import patch
        a,b = self.split()
        with patch('conversation_export.MAX_PAGES',1), self.assertRaises(Invalid):
            collect_pages([a,b])
        with patch('conversation_export.MAX_BYTES',1), self.assertRaises(Invalid):
            collect_pages([self.page])
