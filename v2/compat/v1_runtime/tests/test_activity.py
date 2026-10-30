"""Activity notices use live own-run evidence; never queued-input age or promises."""
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest

from v2.compat.v1_runtime.activity import observe, waiting
from v2.compat.v1_runtime.ledger import Ledger
from v2.compat.v1_runtime.worker import Worker
from v2.compat.v1_runtime.tests.test_worker import Peer


class ActivityCase(unittest.TestCase):
    heartbeat=False

    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        self.ledger=Ledger(Path(temp.name)/'ledger.sqlite3',dict(public_thread_id='thread',chat_id='chat',account_id='account'))
        self.worker=Worker(Peer(),self.ledger,progress_updates=False);self.worker.deep_heartbeat=self.heartbeat
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



class ActivityTests(ActivityCase):
    """Legacy notices (`deep_heartbeat: false`)."""

    def test_old_arrival_and_queued_followers_never_create_notices(self):
        self.poll(1000);self.poll(1010);self.assertEqual(self.notices(),[])
        queued=dict(self.data);queued.pop('admitted_at');queued['phase']='queued'
        observe(self.worker,queued,{},now=100000);self.assertEqual(self.notices(),[])

    def test_running_heartbeat_at_ten_minutes_is_truthful_and_does_not_complete_work(self):
        self.advance(1590);self.assertEqual(self.notices(),[])
        self.poll(1600);self.assertEqual(len(self.notices()),1)
        text=self.notices()[0]['text'];self.assertIn('Still working on it, 10 minutes so far',text)
        self.assertNotIn('retry',text);self.assertNotIn('alert',text)
        self.assertEqual(self.ledger.next_input()['remote_id'],self.data['remote_id'])
        self.assertEqual(self.ledger.health()['stalledInputs'],0)

    def test_unresolved_notice_is_one_per_thread_even_after_restart_and_another_input(self):
        self.advance(1600);self.worker=Worker(Peer(),self.ledger);self.worker.deep_heartbeat=False
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
        self.assertIn('I cannot confirm that this task is still running',self.notices()[0]['text'])

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


class DeepHeartbeatTests(ActivityCase):
    """`deep_heartbeat` (default on): lines at 3, 8, 15, then every 15 minutes, at most 6."""
    heartbeat=True

    def setUp(self):
        super().setUp()
        self.data['author']=dict(role='owner',id='owner@c.us',label='Owner');self.ledger.save(self.data)

    def heartbeats(self):
        return [m for m in self.notices() if m['text'].startswith('\U0001f9e0')]

    def test_binding_setting_defaults_on_and_must_be_a_boolean(self):
        from v2.compat.v1_runtime import config
        from v2.compat.v1_runtime.tests.test_ledger_server import OWNER,binding_doc
        self.assertIs(config.binding(binding_doc(1),OWNER)['deep_heartbeat'],True)
        self.assertIs(config.binding(binding_doc(1,deep_heartbeat=False),OWNER)['deep_heartbeat'],False)
        for bad in (None,'false',0):
            with self.subTest(value=bad),self.assertRaisesRegex(ValueError,'config_activation'):
                config.binding(binding_doc(1,deep_heartbeat=bad),OWNER)
        self.assertTrue(Worker(Peer(),self.ledger).deep_heartbeat)

    def test_off_keeps_the_legacy_ten_minute_notice(self):
        self.worker.deep_heartbeat=False;self.advance(1590);self.assertEqual(self.notices(),[])
        self.poll(1600);self.assertIn('Still working on it, 10 minutes',self.notices()[0]['text'])

    def drain(self,end):
        """Poll to `end`, acknowledging each line when it appears; their times."""
        sent=[]
        for now in range(self.last+10,end+1,10):
            self.poll(now)
            for line in self.heartbeats():
                self.ack(line,now);sent.append(now)
        return sent

    def test_lines_back_off_at_three_eight_fifteen_then_every_fifteen_minutes_capped_at_six(self):
        self.advance(1170);self.assertEqual(self.notices(),[])
        self.poll(1180);self.assertEqual(len(self.heartbeats()),1)
        text=self.heartbeats()[0]['text']
        self.assertEqual(text,'\U0001f9e0 Still working\u2026 3 min so far, the full answer follows.')
        self.assertEqual(self.ledger.next_input()['remote_id'],self.data['remote_id'])
        self.ack(self.heartbeats()[0],1180)
        # A four-hour turn: lines at 3, 8, 15, 30, 45, 60 minutes and never a seventh.
        sent=[1180]+self.drain(1000+4*3600)
        self.assertEqual([(at-1000)//60 for at in sent],[3,8,15,30,45,60])
        with self.ledger.connect() as db:
            count=db.execute("SELECT count(*) FROM inputs WHERE json_extract(data,'$.activity_notice.heartbeat')=1").fetchone()[0]
        self.assertEqual(count,6)

    def test_timer_and_non_person_inputs_get_no_heartbeat(self):
        for change in (dict(origin='timer'),dict(author=None),dict(author=dict(role='guest',id='x',label='Guest'))):
            with self.subTest(change=change):
                self.setUp();self.data.update(change);self.ledger.save(self.data)
                self.advance(1590);self.assertEqual(self.heartbeats(),[])

    def test_a_member_input_gets_the_heartbeat(self):
        self.data['author']=dict(role='member',id='491700000001@c.us',label='Ayse');self.ledger.save(self.data)
        self.advance(1180);self.assertEqual(len(self.heartbeats()),1)

    def test_model_progress_does_not_postpone_but_a_delivered_message_does(self):
        self.advance(1100);self.status['deep']['progress']['payload_id']='new'
        self.poll(1110);self.advance(1180);self.assertEqual(len(self.heartbeats()),1)
        self.ack(self.heartbeats()[0],1180)
        message=self.ledger.add_progress(self.data,'real','Real work')
        self.ack(message,1400);self.advance(1690);self.assertEqual(self.notices(),[])
        self.poll(1700);self.assertEqual(len(self.heartbeats()),1)

    def test_an_unacknowledged_line_is_never_followed_by_another(self):
        self.advance(1180);self.advance(3000);self.assertEqual(len(self.heartbeats()),1)

    def test_one_line_per_chat_across_inputs(self):
        self.advance(1180);self.ack(self.heartbeats()[0],1180)
        other=self.ledger.enqueue(dict(publicMessageId='second',publicThreadId='thread',chatId='chat',accountId='account',text='other'))[0]
        other.update(admitted_at=1000,phase='running',matched_runs=['own'],activity=dict(observed_at=1190,payload_id='payload'),
                     author=dict(role='owner',id='owner@c.us',label='Owner'))
        self.ledger.save(other)
        observe(self.worker,other,self.status,now=1200);self.assertEqual(self.notices(),[])

    def test_no_line_once_the_final_is_ready_or_the_run_ended(self):
        self.poll(1000,dict(deep=dict(run_id='own',phase='awaiting_acceptance')))
        for now in range(1010,1400,10):self.poll(now,dict(deep=dict(run_id='own',phase='completed')))
        self.assertEqual(self.notices(),[])

    def test_outage_restarts_the_clock(self):
        self.advance(1100);self.poll(5000);self.assertEqual(self.notices(),[])
        for now in range(5010,5171,10):self.poll(now)
        self.assertEqual(self.notices(),[])
        self.poll(5180);self.assertEqual(len(self.heartbeats()),1)

    def test_language_follows_the_input(self):
        self.data['text']='bu işi bitir lütfen, çok acil değil ama bak';self.ledger.save(self.data)
        self.advance(1180)
        self.assertIn('Hâlâ çalışıyorum',self.heartbeats()[0]['text'])


class HeartbeatAfterFinalTests(ActivityCase):
    """No heartbeat after, or racing, an answer final.

    KDP-bookwriting 2026-10-30: the owner sent two messages 16 s apart. The
    ISBN answer (first input) was delivered at 12:24:11; the follow-up's own
    Deep then read running, its quiet clock counted from its 12:12 admission,
    and the moment the 5-minute chat spacing reopened (12:24:49) it posted
    "Still working... 12 min so far", 41 s after the answer."""

    heartbeat=True
    heartbeats=DeepHeartbeatTests.heartbeats

    def setUp(self):
        super().setUp()
        self.data['author']=dict(role='owner',id='owner@c.us',label='Owner');self.ledger.save(self.data)

    def answer(self,data,at=None):
        reply=dict(id='reply-'+data['remote_id'],role='assistant',state='completed',phase='final_answer',
                   source='rust-v2-pilot',parentMessageId=data['remote_id'],text='Answer')
        self.assertTrue(self.ledger.complete(data,reply))
        if at is not None:
            message=next(m for m in self.ledger.messages() if m['id']==reply['id'])
            self.ack(message,at)

    def follower(self):
        other=self.ledger.enqueue(dict(publicMessageId='second',publicThreadId='thread',chatId='chat',
            accountId='account',text='and also this'),author=dict(role='owner',id='owner@c.us',label='Owner'))[0]
        other.update(queued_at=1016,admitted_at=1016,phase='running',matched_runs=['next'])
        self.ledger.save(other)
        return other

    def test_follow_up_gets_no_line_right_after_the_earlier_answer(self):
        other=self.follower()
        self.answer(self.data,at=1750)
        status=dict(deep=dict(run_id='next',phase='running'))
        for now in range(1760,1750+180,10):
            observe(self.worker,other,status,now=now)
        self.assertEqual(self.heartbeats(),[],'the chat just saw an answer')
        observe(self.worker,other,status,now=1750+180)
        self.assertEqual(len(self.heartbeats()),1,'three quiet minutes after the answer it is due again')

    def test_no_line_while_an_answer_is_still_in_transit(self):
        other=self.follower()
        self.answer(self.data)  # Exported, V1 has not reported it yet.
        for now in range(1200,1800,10):
            observe(self.worker,other,dict(deep=dict(run_id='next',phase='running')),now=now)
        self.assertEqual(self.heartbeats(),[])

    def test_no_line_once_its_own_final_is_exported_even_if_the_run_still_reads_running(self):
        self.answer(self.data)
        self.advance(1600);self.assertEqual(self.heartbeats(),[])

    def test_a_line_not_yet_taken_by_v1_is_withdrawn_when_the_final_comes_first(self):
        self.advance(1180);line=self.heartbeats()[0]
        self.answer(self.data)
        self.assertEqual(self.heartbeats(),[],'withdrawn from the listing')
        with self.ledger.connect() as db:
            self.assertEqual(db.execute("SELECT outcome FROM exports WHERE export_id=?",(line['id'],)).fetchone()[0],'superseded')
        # A late real ACK of a line V1 had already taken is recorded, never refused.
        with self.ledger.connect() as db:
            parent=json.loads(db.execute("SELECT data FROM inputs WHERE remote_id=?",(line['parentMessageId'],)).fetchone()[0])
        result=self.ledger.acknowledge(line['id'],dict(outcome='delivered',parentPublicMessageId=parent['public_id'],
            outboxJobId='fake-outbox',connectorMessageIds=['fake-receipt'],deliveredAt='1970-01-01T00:20:00+00:00'))
        self.assertFalse(result['settled'])

    def test_an_already_delivered_line_is_kept(self):
        self.advance(1180);line=self.heartbeats()[0];self.ack(line,1180)
        self.answer(self.data)
        with self.ledger.connect() as db:
            self.assertEqual(db.execute("SELECT outcome FROM exports WHERE export_id=?",(line['id'],)).fetchone()[0],'delivered')


class WaitingHeartbeatTests(ActivityCase):
    """A person's input queued behind a running turn (activity.waiting).

    otcanClaw-academic 2026-10-29: the owner's "Stats?" waited 10.5 minutes
    behind a watcher-alert Deep turn and got no heartbeat at all, because only
    the observed head can run the heartbeat clock."""
    heartbeat=True

    def setUp(self):
        super().setUp()
        # The running head is a local watcher alert (never a heartbeat itself).
        self.data['author']=dict(role='v1_agent',id='v1:cli:-',label='Orkestr CLI',source='cli')
        self.ledger.save(self.data)
        self.owner=self.ledger.enqueue(dict(publicMessageId='stats',publicThreadId='thread',chatId='chat',
            accountId='account',text='Stats?'),author=dict(role='owner',id='owner@c.us',label='Owner'))[0]
        self.owner.update(arrived_at=1000,queued_at=1000);self.ledger.save(self.owner)

    def tick(self,now,running=True,fresh=True):
        self.data['transport_activity']=dict(observed_at_ms=int((now if fresh else now-600)*1000),
            deep_running=running,fast_ready=True,final_ready=False)
        self.ledger.save(self.data)
        waiting(self.worker,now=now)

    def run_to(self,end,start=1000,**kw):
        for now in range(start,end+1,15):self.tick(now,**kw)

    def lines(self):
        """Pending lines (an acknowledged one leaves the listing)."""
        return [m for m in self.notices() if m['text'].startswith('\U0001f9e0')]

    def posted(self):
        with self.ledger.connect() as db:
            return db.execute("SELECT count(*) FROM inputs WHERE json_extract(data,'$.activity_notice.heartbeat')=1").fetchone()[0]

    def test_queued_owner_input_gets_a_truthful_line_after_three_quiet_minutes(self):
        self.run_to(1170);self.assertEqual(self.notices(),[])
        self.tick(1185);self.assertEqual(len(self.lines()),1)
        self.assertEqual(self.lines()[0]['text'],'\U0001f9e0 Still on it\u2026 3 min so far. '
                         'An earlier task is finishing first, then the full answer follows.')
        self.assertEqual(self.ledger.next_input()['remote_id'],self.data['remote_id'],'nothing is admitted or completed')
        self.assertNotIn('intake',self.row())
        self.ack(self.lines()[0],1185)
        self.run_to(1000+16*60,start=1200)
        self.assertEqual(self.posted(),2,'the same 3/8/15 backoff: the next line at 8 minutes')
        self.assertEqual(self.row()['activity']['heartbeats'],2)

    def row(self):
        with self.ledger.connect() as db:
            return json.loads(db.execute("SELECT data FROM inputs WHERE remote_id=?",(self.owner['remote_id'],)).fetchone()[0])

    def test_no_line_without_fresh_proof_that_the_earlier_turn_is_running(self):
        self.run_to(1600,fresh=False);self.assertEqual(self.notices(),[])
        self.run_to(1600,running=False);self.assertEqual(self.notices(),[])

    def test_only_a_person_waiting_and_not_observed_elsewhere_gets_it(self):
        for change in (dict(origin='timer'),dict(author=dict(role='v1_agent',id='a',label='A',source='cli')),
                       dict(absorbed_into='x'),dict(activity=dict(observed_at=1590)),dict(deep_final_ready_at=1500.0)):
            with self.subTest(change=change):
                self.setUp();self.owner.update(change);self.ledger.save(self.owner)
                self.run_to(1600);self.assertEqual(self.lines(),[])
        self.setUp();self.worker.deep_heartbeat=False
        self.run_to(1600);self.assertEqual(self.notices(),[])

    def test_the_clock_continues_once_the_input_is_observed_itself(self):
        self.run_to(1185);self.assertEqual(len(self.lines()),1);self.ack(self.lines()[0],1185)
        # Its turn comes: observe() takes over without an immediate second line.
        row=self.row();row.update(admitted_at=1190,phase='running',matched_runs=['own'])
        self.ledger.save(row)
        for now in range(1200,1480,10):observe(self.worker,row,self.status,now=now)
        self.assertEqual(self.posted(),1)
        observe(self.worker,row,self.status,now=1490);self.assertEqual(self.posted(),2)
        self.assertTrue(self.lines()[0]['text'].startswith('\U0001f9e0 Still working\u2026 5 min so far'))
