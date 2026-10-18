"""Synthetic read-only authority audit/refusal checks; no server/provider."""
import copy
import unittest
import upgrade_authority as audit


class AuthorityTests(unittest.TestCase):
    def setUp(self):
        self.before={'tasks':{'queued':('queued',None,None),'claimed':('claimed','a'*64,None),'old':('held',None,None)},
                     'authority':{'production_runs':{'run':('blocked','quarantined')},'worker_provider_delegations':{}}}
        self.after=copy.deepcopy(self.before)
        self.after['tasks'].update(queued=('held',None,None),claimed=('held',None,None))

    def test_pending_claims_held_without_new_authority(self):
        self.assertEqual(audit.verify(self.before,self.after)['pending_tasks_held'],2)

    def test_missing_hold_retained_claim_and_lost_receipt_refused(self):
        for change in ('queued','claimed','lost'):
            with self.subTest(change=change):
                after=copy.deepcopy(self.after)
                if change=='lost':del after['tasks']['old']
                else:after['tasks'][change]=self.before['tasks'][change]
                with self.assertRaises(RuntimeError):audit.verify(self.before,after)

    def test_new_run_delegation_and_reactivated_parent_refused(self):
        for table,row in [('production_runs',('running','candidate')),('worker_provider_delegations',('delegated','b'*64,None))]:
            after=copy.deepcopy(self.after);after['authority'][table]['new']=row
            with self.assertRaisesRegex(RuntimeError,'created or removed'):audit.verify(self.before,after)
        after=copy.deepcopy(self.after);after['authority']['production_runs']['run']=('running','quarantined')
        with self.assertRaisesRegex(RuntimeError,'reactivated'):audit.verify(self.before,after)
