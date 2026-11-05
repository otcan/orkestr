"""A definite stale request never releases an unretired Core source input."""
import copy
import time
import unittest
from v2.compat.v1_runtime.rust_client import ClientError
from v2.compat.v1_runtime.tests import test_refusals as fixture

class WindowFencedTests(unittest.TestCase):
    def setUp(self):
        self.f=fixture.RefusalTests('run');self.f.setUp();self.addCleanup(self.f.doCleanups)
        self.first,_=self.f.ledger.enqueue(fixture.body('first'))
        self.mode='unknown';self.posts=[];original=self.f.peer.request
        def request(method,route,body=None,allowed=(200,)):
            if method=='POST' and route=='/window':
                self.posts.append(copy.deepcopy(body))
                if self.mode=='unknown':raise ClientError('unexpected_status',503)
                if self.mode in ('window_fenced','window_input_retired'):
                    return 409,{'error':{'code':self.mode}}
            return original(method,route,body=body,allowed=allowed)
        self.f.peer.request=request
    def row(self,public):
        with self.f.ledger.connect() as db:
            import json
            return json.loads(db.execute('SELECT data FROM inputs WHERE public_id=?',(public,)).fetchone()[0])
    def messages(self):
        return [body for route,body in self.f.peer.mutations if route=='/messages']
    def test_unretired_fence_holds_original_and_later_inputs_until_core_proves_retirement(self):
        f=self.f;f.worker.run_once(fixture.Stop());frozen=self.row('first')['window_request']
        keys=copy.deepcopy(self.row('first')['keys']);f.ledger.enqueue(fixture.body('later'))
        self.mode='window_fenced'
        for _ in range(2):f.worker.run_once(fixture.Stop())
        self.assertEqual(self.row('first')['phase'],'admitted')
        self.assertEqual(self.row('later')['phase'],'queued')
        self.assertEqual(self.row('first')['window_request'],frozen)
        self.assertEqual(self.row('first')['keys'],keys)
        self.assertEqual(len(self.messages()),1)
        self.assertNotIn('refused',self.row('first'))
        # The separate real-Core HTTP fixture qualifies this exact retired
        # response. No adapter retirement, replacement keys or old-input replay.
        self.mode='window_input_retired';f.worker.run_once(fixture.Stop())
        self.assertEqual(self.row('first')['phase'],'completed')
        self.assertEqual(self.row('first')['window_request'],frozen)
        self.assertEqual(self.row('first')['keys'],keys)
        self.assertEqual(len(self.messages()),1)
        self.assertEqual(self.row('later')['phase'],'queued')
        self.mode='normal';f.worker.run_once(fixture.Stop())
        self.assertEqual(len(self.messages()),2)
        self.assertTrue(all(post==frozen for post in self.posts[:-1]))
        self.assertFalse(any(route.endswith('/retire') for route,_ in f.peer.mutations))
    def test_real_unavailable_preserves_frozen_unknown_request_without_terminal_refusal(self):
        f=self.f
        for _ in range(2):f.worker.run_once(fixture.Stop())
        row=self.row('first');self.assertEqual(row['phase'],'admitted');self.assertNotIn('refused',row)
        self.assertNotIn('window_refusal',row);self.assertEqual(self.posts,[row['window_request']]*2)
        self.assertEqual(f.ledger.expire_stale(0,now=time.time()+86400),[])
        self.assertEqual(len(self.messages()),1)
    def test_parallel_fast_cannot_admit_later_window_past_fenced_source(self):
        from v2.compat.v1_runtime import intake_fast
        f=self.f;f.worker.run_once(fixture.Stop());frozen=self.row('first')['window_request']
        head=self.row('first');head['author']={'role':'owner'};f.ledger.save(head)
        later=fixture.body('later');later['author']={'role':'owner'};f.ledger.enqueue(later)
        f.worker.fast_reply_policy='owner_only';self.mode='window_fenced'
        intake_fast.drive(f.worker)
        self.assertEqual(self.row('first')['phase'],'admitted')
        self.assertNotIn('window',self.row('later'))
        self.assertTrue(all(post==frozen for post in self.posts))
        self.assertEqual(f.peer.accepted,{})
    def test_historical_busy_phase_cannot_age_expire_after_unretired_fence(self):
        f=self.f;f.worker.run_once(fixture.Stop());old=self.row('first')
        frozen=copy.deepcopy(old['window_request']);keys=copy.deepcopy(old['keys'])
        old['phase']='waiting_for_window';f.ledger.save(old)
        self.mode='window_fenced';f.worker.run_once(fixture.Stop())
        self.assertEqual(f.ledger.expire_stale(0,now=time.time()+86400),[])
        self.assertEqual(self.row('first')['window_request'],frozen)
        self.assertEqual(self.row('first')['keys'],keys)
        self.assertNotIn('refused',self.row('first'))
