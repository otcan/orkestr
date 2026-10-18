from copy import deepcopy
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core_history import prepare_import
from recovery_bundle import make_bundle, validate_bundle
from snapshot import Invalid, canonical, sha


def uid(n):
    return f'00000000-0000-0000-0000-{n:012d}'


class RecoveryBundleTests(unittest.TestCase):
    def sources(self):
        page = {'conversation_id': uid(2), 'scope': {'kind': 'global'},
                'last_sequence': 1, 'messages': [{'message_id': uid(3), 'sequence': 1,
                'actor_kind': 'owner', 'text': 'Synthetic history'}], 'next_cursor': None}
        request = prepare_import([page], namespace=uid(1))
        receipt = {key: request[key] for key in ('namespace', 'source_digest', 'source_conversation_id', 'source_watermark')}
        receipt.update(schema_version=1, owner_id=uid(4), message_count=1, revision=1, active=True)
        native = deepcopy(page)
        native['conversation_id'] = uid(5)
        native['messages'][0].update(message_id=uid(6), text='Synthetic delta')
        return request, receipt, [native]

    def test_active_and_inactive_roundtrip_preserves_sources(self):
        for revision, active in [(1, True), (2, False)]:
            request, receipt, pages = self.sources()
            receipt.update(revision=revision, active=active)
            payload = validate_bundle(make_bundle(request, receipt, pages))
            self.assertEqual(payload['ledger']['request'], request)
            self.assertEqual(payload['ledger']['current_receipt'], receipt)
            self.assertEqual(payload['native_delta']['messages'], pages[0]['messages'])
            self.assertEqual(payload['coherence'], 'caller_supplied_not_attested')

    def test_partial_overlap_and_changed_digest_refused(self):
        for change in ('partial', 'overlap', 'digest', 'state', 'messages'):
            request, receipt, pages = self.sources()
            if change == 'partial':
                pages[0]['next_cursor'] = 1
            elif change == 'overlap':
                pages[0]['messages'][0]['message_id'] = uid(3)
            elif change == 'digest':
                request['messages'][0]['text'] = 'Changed'
            elif change == 'state':
                receipt['revision'] = 2
            else:
                request['messages'] = {}
            with self.assertRaises((Invalid, ValueError)):
                make_bundle(request, receipt, pages)

    def test_tamper_unknown_noncanonical_and_duplicate_refused(self):
        encoded = make_bundle(*self.sources())
        with self.assertRaises(Invalid):
            validate_bundle(encoded + b'\n')
        with self.assertRaises(Invalid):
            validate_bundle(b'{"payload":0,"payload":1}')
        import json
        for change in ('digest', 'unknown', 'coherence'):
            value = json.loads(encoded)
            if change == 'digest':
                value['payload_sha256'] = '0' * 64
            elif change == 'unknown':
                value['payload']['credentials'] = 'excluded'
                value['payload_sha256'] = sha(value['payload'])
            else:
                value['payload']['coherence'] = 'atomic'
                value['payload_sha256'] = sha(value['payload'])
            with self.assertRaises(Invalid):
                validate_bundle(canonical(value))
