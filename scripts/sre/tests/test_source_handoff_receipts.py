import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).parents[1]
def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + '.py'))
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value
h, r = load('source_handoff'), load('source_handoff_receipts')
OWNER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
CONVERSATION='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
SOURCE='cccccccc-cccc-4ccc-8ccc-cccccccccccc'
MESSAGE='dddddddd-dddd-4ddd-8ddd-dddddddddddd'
EVENT='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
RUN='ffffffff-ffff-4fff-8fff-ffffffffffff'

def decision():
    return dict(request_id='request-a',decision_id='decision-a',owner_id=OWNER,conversation_id=CONVERSATION,
                source_run_id=SOURCE,native_session_id='synthetic-native',source_provider='codex',
                provider_generation=3,action='repair',resource='synthetic-owned-resource',verdict='approve')

class Receipts(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name); self.sends=0
        def ambiguous(*args):self.sends+=1;raise TimeoutError()
        self.state=h.deliver(self.root,decision(),ambiguous)
        self.key=self.state['body']['client_message_id'].removeprefix('approval-handoff-')
        self.path=self.root/(self.key+'.json'); self.lookups=0

    def projection(self,conversation,query):
        self.lookups+=1;self.assertEqual(conversation,CONVERSATION)
        return dict(schema_version=1,owner_id=OWNER,conversation_id=CONVERSATION,admission_state='admitted',
                    admission={**query,'message_id':MESSAGE,'event_id':EVENT,'sequence':2,
                               'source_binding_generation':1,'authentication_kind':'machine','service_credential_id':None},
                    input_state='queued',run=None,business_state='unverified',work_completed=False)

    def accepted(self):
        return r.reconcile(self.root,self.key,self.projection)

    def report(self,**changes):
        return dict(report_id='report-a',reported_run_id=RUN,reported_state='completed',text='Agent claims business success',**changes)

    def result(self,conversation,query):
        projection=self.projection(conversation,query)
        projection['input_state']='consumed'
        projection['run']=dict(run_id=RUN,native_session_id='synthetic-native',provider='codex',binding_generation=1,
            state='succeeded',dispatch_state='delivery_unknown',input_relation='exact_input',
            completion_event_id='11111111-1111-4111-8111-111111111111',
            acceptance_event_id='22222222-2222-4222-8222-222222222222',
            payload_id='33333333-3333-4333-8333-333333333333',
            payload_text='Agent claims business success',payload_sha256=r.sha('Agent claims business success'))
        return projection

    def test_unknown_reconciles_original_key_hash_fences_once_without_resending(self):
        state=self.accepted()
        self.assertEqual(state['status'],'accepted');self.assertEqual(state['receipt']['sequence'],2)
        self.assertEqual(state['admission_proof']['author'],'v1_agent');self.assertFalse(state['work_completed'])
        r.reconcile(self.root,self.key,lambda *args:self.fail('accepted handoff queried again'))
        self.assertEqual(self.sends,1);self.assertEqual(self.lookups,1)

    def test_missing_legacy_or_unavailable_is_never_a_replay_permission_or_write(self):
        before=self.path.read_bytes()
        for status in ('missing','legacy_unproven'):
            def absent(c,q):
                p=self.projection(c,q);p.update(admission_state=status,admission=None);return p
            self.assertEqual(r.reconcile(self.root,self.key,absent)['status'],'unknown')
        def unavailable(*args):raise TimeoutError()
        self.assertEqual(r.reconcile(self.root,self.key,unavailable)['reconciliation_state'],'lookup_unavailable')
        self.assertEqual(before,self.path.read_bytes());self.assertEqual(self.sends,1)

    def test_claimed_crash_can_only_be_resolved_by_typed_core_proof(self):
        self.state['status']='claimed';r.write(self.path,self.state)
        self.assertEqual(self.accepted()['status'],'accepted');self.assertEqual(self.sends,1)

    def test_cross_owner_conversation_changed_payload_or_source_fences_refuse(self):
        before=self.path.read_bytes()
        for field,bad in [('owner_id',SOURCE),('conversation_id',SOURCE),('schema_version',True),('work_completed',True)]:
            def forged(c,q):p=self.projection(c,q);p[field]=bad;return p
            with self.subTest(field=field),self.assertRaises(r.ReceiptRefused):r.reconcile(self.root,self.key,forged)
        for field,bad in [('text_sha256','0'*64),('author','owner'),('source_provider','claude'),
                          ('continuation_source_run_id',RUN),('source_native_session_id','foreign'),
                          ('expected_provider_generation',4),('message_id','invalid'),('sequence',True)]:
            def forged(c,q):p=self.projection(c,q);p['admission'][field]=bad;return p
            with self.subTest(field=field),self.assertRaises(r.ReceiptRefused):r.reconcile(self.root,self.key,forged)
        self.assertEqual(before,self.path.read_bytes());self.assertEqual(self.sends,1)

    def test_historical_context_cannot_be_inferred_or_backfilled(self):
        state=copy.deepcopy(self.state);state['decision'].pop('owner_id');state['decision'].pop('source_provider')
        state['digest']=r.sha(json.dumps(state['decision'],sort_keys=True));r.write(self.path,state)
        before=self.path.read_bytes()
        with self.assertRaisesRegex(r.ReceiptRefused,'legacy_context_unproven'):
            r.reconcile(self.root,self.key,lambda *args:self.fail('legacy guessed'))
        self.assertEqual(before,self.path.read_bytes())

    def test_agent_success_without_core_result_is_only_an_attributed_report(self):
        self.accepted();record=r.ingest_report(self.root,self.key,self.projection,self.report())
        self.assertEqual(record['attribution'],'source_agent_report');self.assertIsNone(record['core_result'])
        self.assertFalse(record['attribution_verified_by_core'])
        self.assertIsNone(record['verified_business_receipt']);self.assertFalse(record['work_completed'])
        self.assertEqual(record['business_state'],'unverified')

    def test_accepted_actual_core_output_still_does_not_verify_business_effects(self):
        self.accepted();record=r.ingest_report(self.root,self.key,self.result,self.report())
        self.assertTrue(record['core_result']['report_matches_core_payload'])
        self.assertTrue(record['attribution_verified_by_core'])
        self.assertIsNotNone(record['core_result']['acceptance_event_id'])
        self.assertIsNone(record['verified_business_receipt']);self.assertFalse(record['work_completed'])
        self.assertFalse(json.loads(self.path.read_text())['work_completed'])

    def test_report_claimed_run_cannot_select_core_result_and_identity_is_immutable(self):
        self.accepted();report=self.report();report['reported_run_id']=SOURCE
        record=r.ingest_report(self.root,self.key,self.result,report)
        self.assertEqual(record['core_result']['run_id'],RUN);self.assertFalse(record['core_result']['report_matches_core_payload'])
        self.assertEqual(r.ingest_report(self.root,self.key,lambda *args:self.fail('duplicate queried'),report),record)
        report['text']='changed'
        with self.assertRaisesRegex(r.ReceiptRefused,'identity_changed'):r.ingest_report(self.root,self.key,self.result,report)

    def test_changed_native_provider_epoch_cannot_credit_original_source(self):
        self.accepted()
        def changed(c,q):p=self.result(c,q);p['run']['native_session_id']='new-source';return p
        record=r.ingest_report(self.root,self.key,changed,self.report())
        self.assertFalse(record['core_result']['source_binding_matches']);self.assertFalse(record['work_completed'])

    def test_unknown_cannot_ingest_result_and_private_state_is_required(self):
        with self.assertRaisesRegex(r.ReceiptRefused,'not_reconciled'):r.ingest_report(self.root,self.key,self.result,self.report())
        self.root.chmod(0o770)
        with self.assertRaisesRegex(r.ReceiptRefused,'private_state'):r.reconcile(self.root,self.key,lambda *args:self.fail())
        self.root.chmod(0o700)

    def test_unrecognized_report_fields_cannot_smuggle_business_receipts(self):
        report=self.report();report['verified_business_receipt']={'status':'done'}
        with self.assertRaisesRegex(r.ReceiptRefused,'report_fields'):r.ingest_report(self.root,self.key,self.result,report)

    def test_state_aliases_and_hardlinks_are_rejected_before_core_query(self):
        other=self.root/'alias-copy';other.write_bytes(self.path.read_bytes());other.chmod(0o600)
        self.path.unlink();self.path.symlink_to(other)
        with self.assertRaises(OSError):r.reconcile(self.root,self.key,lambda *args:self.fail('alias queried'))
        self.path.unlink();os.link(other,self.path)
        with self.assertRaisesRegex(r.ReceiptRefused,'private_handoff'):r.reconcile(self.root,self.key,lambda *args:self.fail('hardlink queried'))

    def test_core_output_without_actual_payload_or_completion_lineage_is_refused(self):
        self.accepted()
        for field in ('payload_id','completion_event_id'):
            def incomplete(c,q):p=self.result(c,q);p['run'][field]=None;return p
            with self.subTest(field=field),self.assertRaises(r.ReceiptRefused):
                r.ingest_report(self.root,self.key,incomplete,self.report())

if __name__=='__main__':unittest.main()
