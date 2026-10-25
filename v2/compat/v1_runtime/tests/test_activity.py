"""Activity notices use live own-run evidence; never queued-input age or promises."""
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest

from v2.compat.v1_runtime.activity import observe
from v2.compat.v1_runtime.ledger import Ledger
from v2.compat.v1_runtime.worker import Worker
from v2.compat.v1_runtime.tests.test_worker import Peer


class ActivityTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        self.ledger=Ledger(Path(temp.name)/'ledger.sqlite3',dict(public_thread_id='thread',chat_id='chat',account_id='account'))
        self.worker=Worker(Peer(),self.ledger,progress_updates=False)
        self.data=self.ledger.enqueue(dict(publicMessageId='owner',publicThreadId='thread',chatId='chat',accountId='account',text='work'))[0]
        self.data.update(queued_at=1,admitted_at=1000,phase='running',matched_runs=['own'])
        self.ledger.save(self.data)
        self.status=dict(deep=dict(run_id='own',phase='running',progress=dict(payload_id='payload')))
        self.last=990

    def poll(self,now,status=None):
        observe(self.worker,self.data,self.status if status is None else status,now=now)
        self.last=now

    def advance(self,end):
        for now in range(self.last+10,end+1,10):self.poll(now)

    def notices(self):
        return [m for m in self.ledger.messages() if m.get('activityNotice')]

    def ack(self,message,at):
        parent=next(m['publicMessageId'] for m in self.ledger.messages() if m['id']==message['parentMessageId'])
        self.ledger.acknowledge(message['id'],dict(outcome='delivered',parentPublicMessageId=parent,
            outboxJobId='fake-outbox',connectorMessageIds=['fake-receipt'],deliveredAt=datetime.fromtimestamp(at,timezone.utc).isoformat()))

    def test_old_arrival_and_queued_followers_never_create_notices(self):
        self.poll(1000);self.poll(1010);self.assertEqual(self.notices(),[])
        queued=dict(self.data);queued.pop('admitted_at');queued['phase']='queued'
        observe(self.worker,queued,{},now=100000);self.assertEqual(self.notices(),[])

    def test_running_heartbeat_at_ten_minutes_is_truthful_and_does_not_complete_work(self):
        self.advance(1590);self.assertEqual(self.notices(),[])
        self.poll(1600);self.assertEqual(len(self.notices()),1)
        text=self.notices()[0]['text'];self.assertIn('Still running, 10 minutes since admission',text)
        self.assertNotIn('retry',text);self.assertNotIn('alert',text)
        self.assertEqual(self.ledger.next_input()['remote_id'],self.data['remote_id'])
        self.assertEqual(self.ledger.health()['stalledInputs'],0)

    def test_unresolved_notice_is_one_per_thread_even_after_restart_and_another_input(self):
        self.advance(1600);self.worker=Worker(Peer(),self.ledger)
        self.advance(2200);self.assertEqual(len(self.notices()),1)
        other=dict(self.data,remote_id='other')
        # The same admitted head cannot create a second message after restart.
        self.poll(2200);self.assertEqual(len(self.notices()),1)

    def test_confirmed_work_progress_postpones_notice_but_unconfirmed_does_not(self):
        self.advance(1500)
        message=self.ledger.add_progress(self.data,'real','Real work')
        self.poll(1510);self.assertEqual(self.notices(),[])
        self.ack(message,1510);self.advance(1800);self.assertEqual(self.notices(),[])
        self.advance(2110);self.assertEqual(len(self.notices()),1)

    def test_progress_payload_change_resets_inactivity(self):
        self.advance(1500);self.status['deep']['progress']['payload_id']='new'
        self.poll(1510);self.advance(1800);self.assertEqual(self.notices(),[])

    def test_session_outage_pauses_notice_clock_and_never_claims_liveness(self):
        self.advance(1200);self.poll(5000)
        self.assertEqual(self.notices(),[]);self.assertEqual(self.data['activity']['paused_s'],3800)
        for now in range(5010,5601,10):self.poll(now)
        self.assertEqual(len(self.notices()),1)

    def test_missing_run_has_truthful_wording_and_ready_final_needs_no_heartbeat(self):
        self.advance(1590);self.poll(1600,dict(deep=None))
        self.assertIn('No running task is confirmed',self.notices()[0]['text'])

    def test_notices_do_not_consume_progress_budget_and_timer_notices_use_a_deliverable_parent(self):
        self.data['origin']='timer';self.advance(1600)
        for index in range(3):self.assertIsNotNone(self.ledger.add_progress(self.data,str(index),'work'))
        self.assertIsNone(self.ledger.add_progress(self.data,'fourth','work'))
        notice=self.notices()[0]
        self.assertEqual(notice['phase'],'final_answer')
        self.assertNotEqual(notice['parentMessageId'],self.data['remote_id'])

    def test_healthy_notice_is_once_then_a_second_only_at_an_hour_and_never_a_third(self):
        self.advance(1600);self.ack(self.notices()[0],1600)
        self.advance(4590);self.assertEqual(self.notices(),[])
        self.poll(4600);self.assertEqual(len(self.notices()),1)
        self.ack(self.notices()[0],4600);self.advance(8200);self.assertEqual(self.notices(),[])
        with self.ledger.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM inputs WHERE json_extract(data,'$.activity_notice') IS NOT NULL").fetchone()[0],2)

    def test_missing_run_alert_is_immediate_at_detection_and_notice_at_most_every_thirty_minutes(self):
        self.status=dict(deep=None)
        self.advance(1600);self.assertEqual(self.ledger.next_input()['activity']['problem'],'no_running_task')
        self.ack(self.notices()[0],1600);self.advance(3390);self.assertEqual(self.notices(),[])
        self.poll(3400);self.assertEqual(len(self.notices()),1)

    def test_confirmed_running_progress_clears_missing_run_alert_without_waiting_ten_more_minutes(self):
        self.status=dict(deep=None);self.advance(1600)
        self.assertEqual(self.data['activity']['problem'],'no_running_task')
        self.status=dict(deep=dict(run_id='own',phase='running',progress=dict(payload_id='new')))
        self.poll(1610);self.assertNotIn('problem',self.ledger.next_input()['activity'])

    def test_a_second_admitted_input_cannot_add_a_notice_while_the_thread_has_one_pending(self):
        self.advance(1600)
        other=self.ledger.enqueue(dict(publicMessageId='second',publicThreadId='thread',chatId='chat',accountId='account',text='other'))[0]
        other.update(admitted_at=1000,phase='running',matched_runs=['own'],
                     activity=dict(observed_at=1590,progress_at=1000,payload_id='payload'))
        self.ledger.save(other)
        observe(self.worker,other,self.status,now=1600)
        self.assertEqual(len(self.notices()),1)
