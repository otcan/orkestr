"""Activity hints prove a fresh own run for one input and cannot initiate work."""
import time
from v2.compat.v1_runtime.input_activity import read,record
from v2.compat.v1_runtime.tests.test_ledger_server import Harness


class InputActivityTests(Harness):
    def running(self,n=1,public='message'):
        self.post(n,body=self.body(n,publicMessageId=public))
        data=self.binding(n).ledger.next_input()
        data['phase']='running'
        record(data,dict(deep=dict(run_id='own',phase='running')),{'own'})
        self.binding(n).ledger.save(data)
        return data

    def get(self,n=1,query='publicMessageId=message',token=True):
        return self.request('GET','/threads/'+self.remote(n)+'/activity?'+query,token=token)

    def test_exact_input_scope_authentication_and_no_message_text(self):
        self.running(public='first')
        self.assertEqual(self.get(query='publicMessageId=first',token=False)[0],401)
        self.assertEqual(self.get(2,query='publicMessageId=first')[0],404)
        status,value=self.get(query='publicMessageId=first')
        self.assertEqual(status,200);self.assertTrue(value['active'])
        self.assertEqual(value['publicThreadId'],'thread-1')
        self.assertNotIn('text',str(value));self.assertNotIn('own',str(value))

    def test_stale_foreign_or_paused_execution_never_claims_work_is_active(self):
        data=self.running();ledger=self.binding(1).ledger
        record(data,dict(deep=dict(run_id='foreign',phase='running')),{'own'});ledger.save(data)
        self.assertFalse(self.get()[1]['active'])
        record(data,dict(deep=dict(run_id='own',phase='running')),{'own'},now=time.time()-6);ledger.save(data)
        self.assertFalse(self.get()[1]['active'])
        record(data,dict(deep=dict(run_id='own',phase='running')),{'own'});ledger.save(data)
        self.assertFalse(read(ledger,'message',enabled=False)['active'])

    def test_ready_fast_and_final_are_visible_without_exporting_or_sending(self):
        data=self.running();ledger=self.binding(1).ledger
        record(data,dict(deep=dict(run_id='own',phase='running'),fast=dict(run_id='fast',phase='awaiting_acceptance')),{'own','fast'})
        ledger.save(data);self.assertTrue(self.get()[1]['fastReady'])
        data['deep_final_ready_at']=time.time();ledger.save(data)
        self.assertTrue(self.get()[1]['finalReady']);self.assertFalse(self.get()[1]['active'])
        with ledger.connect() as db:self.assertEqual(db.execute('SELECT count(*) FROM exports').fetchone()[0],0)

    def test_unknown_duplicate_extra_or_oversized_query_is_rejected(self):
        self.running()
        for query in ['', 'publicMessageId=', 'publicMessageId=message&publicMessageId=other',
                      'publicMessageId=message&other=1','publicMessageId='+'x'*257]:
            self.assertEqual(self.get(query=query)[0],400)

    def test_read_does_not_modify_ledger_and_queued_input_is_not_active(self):
        self.post(1);ledger=self.binding(1).ledger
        from pathlib import Path
        before=Path(ledger.path).read_bytes()
        self.assertFalse(self.get()[1]['active'])
        self.assertEqual(Path(ledger.path).read_bytes(),before)
