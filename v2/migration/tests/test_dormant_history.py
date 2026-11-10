"""Synthetic proposed-port oracle only; no actual Core dormant port exists here."""
from copy import deepcopy
from pathlib import Path
import json
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dormant_history import HistoryPlan, prepare_history, apply_history, rollback_history
from snapshot import Invalid, canonical

OWNER = '00000000-0000-4000-8000-000000000010'
TARGET = '00000000-0000-4000-8000-000000000020'
SOURCE = '00000000-0000-4000-8000-000000000030'


class ProposedPortOracle:
    """Test-only model; not a storage implementation or production adapter."""
    def __init__(self):
        self.request = None
        self.revision = 1
        self.inactive = False
        self.calls = 0

    def receipt(self):
        r = self.request
        return {k: r[k] for k in ('batch_key', 'target_owner', 'target_namespace',
                                  'source_digest', 'target_conversation_id')} | {
            'message_count': len(r['messages']), 'revision': self.revision,
            'state': 'INACTIVE' if self.inactive else 'DORMANT'}

    def import_dormant_history(self, *, token, request):
        self.calls += 1
        if token != 'synthetic-target-session':
            raise Invalid('unauthorized')
        if self.request is not None and self.request != request:
            raise Invalid('namespace_conflict')
        self.request = deepcopy(request)
        return self.receipt()

    def deactivate_dormant_history(self, *, token, target_owner, target_namespace,
                                   batch_key, expected_revision):
        self.calls += 1
        if token != 'synthetic-target-session' or target_owner != OWNER:
            raise Invalid('unauthorized')
        if (target_namespace != self.request['target_namespace'] or
                batch_key != self.request['batch_key'] or expected_revision != self.revision):
            raise Invalid('changed_target_hold')
        self.inactive = True
        return self.receipt()


class DormantHistoryTests(unittest.TestCase):
    def setUp(self):
        self.page = json.loads((Path(__file__).resolve().parents[2] /
                               'fixtures/conversation-snapshot.json').read_text())
        self.port = ProposedPortOracle()
        self.token = 'synthetic-target-session'

    def plan(self, page=None):
        return prepare_history([page or self.page], target_owner=OWNER,
                               target_namespace=TARGET, source_namespace=SOURCE)

    def test_deterministic_scope_order_digest_history_only(self):
        before = deepcopy(self.page)
        plan = self.plan()
        self.assertEqual(plan, self.plan())
        request = plan.request()
        self.assertEqual(request['disposition'], 'HISTORY_ONLY')
        self.assertEqual(request['source_scope'], self.page['scope'])
        self.assertEqual(request['messages'][0]['sequence'], 1)
        self.assertNotEqual(request['target_conversation_id'], self.page['conversation_id'])
        self.assertNotIn('token', request)
        self.assertEqual(self.page, before)
        request['messages'].clear()
        self.assertEqual(len(plan.request()['messages']), 1)

    def test_replay_and_untouched_rollback_are_idempotent(self):
        plan = self.plan()
        receipt = apply_history(plan, self.port, token=self.token)
        self.assertEqual(apply_history(plan, self.port, token=self.token), receipt)
        inactive = rollback_history(plan, receipt, self.port, token=self.token)
        self.assertEqual(inactive['state'], 'INACTIVE')
        self.assertEqual(rollback_history(plan, receipt, self.port, token=self.token), inactive)
        with self.assertRaises(Invalid):
            apply_history(plan, self.port, token=self.token)  # cannot reactivate via replay

    def test_changed_source_and_changed_target_refuse(self):
        plan = self.plan()
        receipt = apply_history(plan, self.port, token=self.token)
        changed = deepcopy(self.page)
        changed['messages'][0]['text'] = 'synthetic conflicting history'
        with self.assertRaisesRegex(Invalid, 'namespace_conflict'):
            apply_history(self.plan(changed), self.port, token=self.token)
        self.port.revision += 1  # a V2-only change must survive, not be deleted
        with self.assertRaisesRegex(Invalid, 'changed_target_hold'):
            rollback_history(plan, receipt, self.port, token=self.token)
        self.assertFalse(self.port.inactive)

    def test_partial_and_credential_fields_refuse_before_port(self):
        for change in ({'next_cursor': 1, 'last_sequence': 2},
                       {'auth_sessions': ['synthetic-secret-marker']}):
            with self.assertRaises(Invalid):
                self.plan(self.page | change)
        self.assertEqual(self.port.calls, 0)

    def test_tampered_plan_and_receipt_refused(self):
        request = self.plan().request()
        request['disposition'] = 'RUNNABLE'
        with self.assertRaises(Invalid):
            apply_history(HistoryPlan(canonical(request)), self.port, token=self.token)
        self.assertEqual(self.port.calls, 0)
        plan = self.plan()
        receipt = apply_history(plan, self.port, token=self.token)
        for change in ({'state': 'PARTIAL'}, {'message_count': 0}, {'revision': True},
                       {'target_owner': SOURCE}):
            with self.assertRaises(Invalid):
                rollback_history(plan, receipt | change, self.port, token=self.token)

    def test_partial_apply_receipt_is_not_success(self):
        original = self.port.import_dormant_history
        def incomplete(**kwargs):
            return original(**kwargs) | {'message_count': 0}
        self.port.import_dormant_history = incomplete
        with self.assertRaises(Invalid):
            apply_history(self.plan(), self.port, token=self.token)
        # Store reconciliation is required; adapter never guesses rollback or retries.
        self.assertEqual(self.port.calls, 1)

    def test_wrong_target_auth_refused(self):
        with self.assertRaises(Invalid):
            apply_history(self.plan(), self.port, token='synthetic-source-session')
        self.assertIsNone(self.port.request)

    def test_empty_and_multipage_order_preserved(self):
        empty = deepcopy(self.page)
        empty.update(messages=[], last_sequence=0)
        self.assertEqual(self.plan(empty).request()['messages'], [])
        pages = []
        for start, end in ((1, 101), (101, 102)):
            page = deepcopy(self.page)
            page['last_sequence'] = 101
            page['messages'] = [dict(message_id=f'00000000-0000-4000-8000-{i:012x}',
                                      sequence=i, actor_kind='unknown-preserved-actor',
                                      text=f'synthetic history {i}') for i in range(start, end)]
            page['next_cursor'] = 100 if start == 1 else None
            pages.append(page)
        plan = prepare_history(pages, target_owner=OWNER, target_namespace=TARGET,
                               source_namespace=SOURCE)
        receipt = apply_history(plan, self.port, token=self.token)
        self.assertEqual(receipt['message_count'], 101)
        self.assertEqual([m['sequence'] for m in plan.request()['messages']], list(range(1, 102)))
        self.assertEqual(plan.request()['messages'][-1]['actor_kind'], 'unknown-preserved-actor')
