"""Default sole-run transport and historic dual-role receipt migration."""
import copy
import json
import time
import unittest
from v2.compat.v1_runtime import config as config_module
from v2.compat.v1_runtime.tests import test_timer_relay as timers, test_web_mirror as web
from unittest.mock import patch

from v2.compat.v1_runtime.worker import Worker
from v2.compat.v1_runtime.rust_client import ClientError
from v2.compat.v1_runtime.tests import test_worker as fixture
from v2.compat.v1_runtime.tests import intake_fixture
from v2.compat.v1_runtime.tests import test_first_response as response_fixture


class SingleAgentTests(unittest.TestCase):
    setUp = fixture.WorkerTests.setUp

    def default_worker(self, progress=False):
        worker = Worker(self.peer, self.ledger, progress_updates=progress)
        self.assertFalse(worker.legacy_companions)
        return worker

    def reject_fast(self):
        original = self.peer.request
        self.calls = []
        self.event_waits = []
        read = self.peer.read_events
        def events(after, maximum, timeout_s=None):
            self.event_waits.append(timeout_s)
            return read(after, maximum, timeout_s=timeout_s)
        self.peer.read_events = events
        def request(method, route, **kwargs):
            self.calls.append((method, route, copy.deepcopy(kwargs.get('body'))))
            if route.startswith('/fast') or route == '/payloads/fast-payload':
                self.fail('single-agent transport accessed Fast: ' + route)
            if route == '/accept':
                self.assertNotEqual(kwargs['body']['run_id'], 'fast-run')
            return original(method, route, **kwargs)
        self.peer.request = request

    def test_default_final_needs_only_own_execution_and_survives_restart_once(self):
        self.reject_fast(); worker = self.default_worker()
        worker.fast_reply_policy = 'owner_only'  # Old presentation does not enable a role.
        worker.step(self.data)
        self.assertEqual(set(self.peer.accepted), {'deep'})
        self.assertTrue(self.event_waits and all(value == 0.15 for value in self.event_waits))
        replies = [r for r in self.ledger.messages() if r['role'] == 'assistant']
        self.assertEqual([(r['id'], r['text']) for r in replies], [('deep-accepted', 'deep result')])
        self.assertNotIn('quickModel', replies[0])
        self.assertEqual(self.ledger.input(self.data['remote_id'])['execution_mode'], 'single')
        before = copy.deepcopy(self.peer.mutations)
        self.assertIsNone(self.ledger.next_input())
        self.default_worker().run_once(intake_fixture.Stop())
        self.assertEqual(self.peer.mutations, before)
        self.assertEqual(len([r for r in self.ledger.messages() if r['role']=='assistant']), 1)

    def test_unknown_accept_response_uses_same_frozen_run_and_request(self):
        self.reject_fast(); self.peer.lose_deep_response = True
        with self.assertRaises(ConnectionError):self.default_worker().step(self.data)
        saved = self.ledger.next_input(); request = copy.deepcopy(saved['deep_accept_request'])
        self.default_worker().step(saved)
        accepts = [body for route,body in self.peer.mutations if route=='/accept']
        self.assertEqual(accepts, [request, request])
        self.assertEqual(len([r for r in self.ledger.messages() if r['role']=='assistant']), 1)

    def test_foreign_source_never_supplies_an_execution_or_final(self):
        self.reject_fast(); self.peer.foreign=True
        self.default_worker().step(self.data)
        self.assertFalse(self.peer.accepted)
        self.assertFalse([r for r in self.ledger.messages() if r['role']=='assistant'])

    def test_frozen_single_input_does_not_acquire_fast_on_legacy_optin(self):
        self.reject_fast(); self.peer.busy=True
        self.default_worker().step(self.data)
        saved=self.ledger.next_input();self.assertEqual(saved['execution_mode'],'single')
        self.peer.busy=False
        Worker(self.peer,self.ledger,legacy_companions=True).step(saved)
        self.assertEqual(set(self.peer.accepted), {'deep'})


class HistoricReceiptTests(unittest.TestCase):
    setUp = fixture.WorkerTests.setUp
    configure = response_fixture.FirstResponseTests.configure
    step_at = response_fixture.FirstResponseTests.step_at
    replies = response_fixture.FirstResponseTests.replies
    ack_fast = response_fixture.FirstResponseTests.ack_fast

    def test_pending_fast_is_withdrawn_on_single_start_without_fabricated_ack_or_final_wait(self):
        self.configure(); self.step_at(1)
        fast, = self.replies()
        parent = next(row for row in self.ledger.messages() if row['id'] == fast['parentMessageId'])
        self.worker = Worker(self.peer, self.ledger)
        # Selection withdraws the pending export before the next listing, even
        # while the sole execution is still running. It does not accept Fast.
        self.assertEqual(self.replies(), [])
        with self.ledger.connect() as db:
            outcome, ack = db.execute('SELECT outcome,ack FROM exports WHERE export_id=?', (fast['id'],)).fetchone()
        self.assertEqual(outcome, 'superseded'); self.assertIsNone(ack)
        self.state['deep'] = 'ready'; self.step_at(2)
        self.assertEqual([r['text'] for r in self.replies()], ['Here is the result.'])
        self.assertEqual(set(self.peer.accepted), {'deep'})
        # A transport already handed to V1 can finish late. Preserve that real
        # receipt without re-exporting or pretending the earlier withdrawal sent.
        self.ledger.acknowledge(fast['id'], dict(outcome='delivered', outboxJobId='real-late-job',
            parentPublicMessageId=parent['publicMessageId'], connectorMessageIds=['real-late-receipt'],
            deliveredAt='1970-01-01T00:00:03+00:00'))
        with self.ledger.connect() as db:
            outcome, ack = db.execute('SELECT outcome,ack FROM exports WHERE export_id=?', (fast['id'],)).fetchone()
        self.assertEqual(outcome, 'superseded')
        self.assertEqual(json.loads(ack)['connectorMessageIds'], ['real-late-receipt'])

    def test_a_foreign_pending_export_is_not_withdrawn_by_a_corrupt_reference(self):
        self.configure(); self.step_at(1)
        fast, = self.replies()
        with self.ledger.connect() as db:
            db.execute("UPDATE exports SET message=json_set(message,'$.sourceInputId','foreign-input') WHERE export_id=?", (fast['id'],))
        Worker(self.peer, self.ledger)
        with self.ledger.connect() as db:
            self.assertEqual(db.execute('SELECT outcome,ack FROM exports WHERE export_id=?', (fast['id'],)).fetchone(), (None, None))

    def test_historic_fast_proposal_and_delivered_ack_remain_without_fast_acceptance(self):
        self.configure(); self.step_at(1); fast=self.ack_fast()
        with self.ledger.connect() as db:
            before=db.execute('SELECT export_id,outcome,ack FROM exports WHERE export_id=?',(fast['id'],)).fetchone()
        self.state['deep']='ready'
        original=self.peer.request;calls=[]
        def no_fast(method,route,**kwargs):
            calls.append((method,route))
            self.assertFalse(route.startswith('/fast'))
            if route=='/accept':self.assertNotEqual(kwargs['body']['run_id'],'fast-run')
            return original(method,route,**kwargs)
        self.peer.request=no_fast
        self.worker=Worker(self.peer,self.ledger)
        self.step_at(2)
        self.assertEqual(set(self.peer.accepted), {'deep'})
        self.assertEqual([r['text'] for r in self.replies()], ['Here is the result.'])
        with self.ledger.connect() as db:
            self.assertEqual(db.execute('SELECT export_id,outcome,ack FROM exports WHERE export_id=?',(fast['id'],)).fetchone(),before)
        self.assertIsNone(self.ledger.next_input())


class SingleIntakePeer(intake_fixture.IntakePeer):
    def start(self, role):
        if role=='deep':super().start(role)

    def request(self, method, route, body=None, allowed=(200,)):
        assert not route.startswith('/fast'), 'single intake consulted Fast'
        return super().request(method,route,body,allowed)


class SingleIntakeTests(intake_fixture.IntakeBase):
    def setUp(self):
        super().setUp();self.peer=SingleIntakePeer();self.worker=self.new_worker()

    def new_worker(self):
        worker=Worker(self.peer,self.ledger)
        worker.fast_reply_policy='disabled';worker.web_mirror=False
        worker._timers_checked=worker._posts_checked=worker._digest_checked=time.monotonic()
        return worker

    def test_owner_member_intake_does_not_wait_for_busy_run_or_fast_policy(self):
        self.enqueue('head');self.worker.run_once(intake_fixture.Stop())
        self.enqueue('member',role='member');self.enqueue('owner')
        self.worker.run_once(intake_fixture.Stop())
        self.assertEqual([b['text'] for b in self.mutations('/messages')],['Request head','Request member','Request owner'])
        self.assertEqual([b['input_message_id'] for b in self.mutations('/window')],
                         [self.row(name)['intake']['message_id'] for name in ['head','member','owner']])
        self.assertEqual(set(role for _,role in self.peer.runs), {'deep'})
        self.assertEqual(self.peer.runs[0,'deep']['phase'],'running')
        self.assertEqual(self.fast(), [])
        with self.ledger.connect() as db:self.assertEqual(db.execute('SELECT count(*) FROM fast_watch').fetchone()[0],0)
        before=copy.deepcopy(self.mutations('/messages'))
        self.worker=self.new_worker();self.worker.run_once(intake_fixture.Stop())
        self.assertEqual(self.mutations('/messages'),before)

    def test_uncertain_earlier_intake_is_not_passed_by_later_owner(self):
        self.enqueue('first');self.enqueue('later');original=self.peer.request
        def uncertain(method,route,body=None,allowed=(200,)):
            if method=='POST' and route=='/messages':raise ConnectionError('synthetic unknown commit')
            return original(method,route,body,allowed)
        self.peer.request=uncertain
        self.worker.run_once(intake_fixture.Stop())
        self.assertNotIn('intake',self.row('later'))
        self.assertEqual(self.fast(),[])

    def test_new_intake_revision_cannot_refuse_an_unchanged_sole_agent_proposal(self):
        self.enqueue('first'); self.worker.run_once(intake_fixture.Stop())
        self.peer.runs[0, 'deep']['phase'] = 'awaiting_acceptance'
        def unknown(body):
            self.peer.before_accept = None
            raise ClientError('transport_outcome_unknown')
        self.peer.before_accept = unknown
        with self.assertRaises(ClientError): self.worker.step(self.ledger.next_input())
        original = copy.deepcopy(self.row('first')['deep_accept_request'])
        self.enqueue('later'); self.worker.run_once(intake_fixture.Stop())
        refreshed = self.row('first')['deep_accept_request']
        self.assertNotIn('refused', self.row('first'))
        self.assertGreater(refreshed['expected_revision'], original['expected_revision'])
        self.assertEqual({k:v for k,v in refreshed.items() if k != 'expected_revision'},
                         {k:v for k,v in original.items() if k != 'expected_revision'})
        self.worker.run_once(intake_fixture.Stop())
        self.assertEqual(self.row('first')['accepted']['deep']['run_id'], original['run_id'])
        self.assertEqual(self.row('first')['phase'], 'completed')
        self.assertEqual(len([r for r in self.ledger.messages() if r['role'] == 'assistant']), 1)


class SingleProgressTests(unittest.TestCase):
    setUp = fixture.WorkerTests.setUp
    configure = response_fixture.FirstResponseTests.configure
    step_at = response_fixture.FirstResponseTests.step_at
    replies = response_fixture.FirstResponseTests.replies

    def test_actual_sole_run_progress_then_one_final_without_fast(self):
        self.configure();self.worker=Worker(self.peer,self.ledger,progress_updates=True)
        original=self.peer.request
        def no_fast(method,route,**kwargs):
            self.assertFalse(route.startswith('/fast'))
            return original(method,route,**kwargs)
        self.peer.request=no_fast
        self.step_at(1);self.step_at(61);self.step_at(66)
        progress,=self.replies();self.assertEqual(progress['text'],'Still checking.')
        self.ledger.acknowledge(progress['id'],dict(outcome='delivered',outboxJobId='synthetic-progress',
            parentPublicMessageId=self.data['public_id'],connectorMessageIds=['synthetic-receipt'],deliveredAt='1970-01-01T00:02:46+00:00'))
        self.state['deep']='ready';self.step_at(67)
        self.assertEqual([r['text'] for r in self.replies()],['Here is the result.'])
        with self.ledger.connect() as db:
            rows=db.execute('SELECT kind,ack FROM exports ORDER BY seq').fetchall()
        self.assertEqual([kind for kind,_ in rows],['progress','final'])
        self.assertEqual(json.loads(rows[0][1])['outcome'],'delivered')
        self.assertEqual(set(self.peer.accepted),{'deep'})


class SingleOtherOriginTests(timers.Base):
    def test_timer_uses_original_claim_once_and_needs_no_fast_or_new_message(self):
        self.worker=Worker(self.peer,self.ledger);self.ledger.set_timer_cursor(0)
        self.peer.timer_rows=[timers.occurrence(2)]
        original=self.peer.request
        def no_fast(method,route,**kwargs):
            self.assertFalse(route.startswith('/fast'))
            return original(method,route,**kwargs)
        self.peer.request=no_fast
        self.worker.run_once(timers._Stop());self.worker.run_once(timers._Stop())
        self.assertEqual(set(self.peer.accepted),{'deep'})
        self.assertFalse([r for r,_ in self.peer.mutations if r=='/messages'])
        self.assertEqual(len([r for r in self.ledger.messages() if r['role']=='assistant']),1)

    def test_web_accepted_result_remains_delivery_only_and_no_fast(self):
        self.peer=web.WebPeer();self.worker=Worker(self.peer,self.ledger)
        self.ledger.set_web_cursor(10);self.peer.snapshot=[web.row()]
        self.peer.runs[web.WEB]=['sole-run'];self.peer.answer('sole-run','Saved the requested result.')
        original=self.peer.request
        def no_fast(method,route,**kwargs):
            self.assertFalse(route.startswith('/fast'))
            return original(method,route,**kwargs)
        self.peer.request=no_fast
        for _ in range(2):self.worker._web_checked=None;self.worker.run_once(timers._Stop())
        self.assertEqual([m['text'] for m in self.ledger.messages() if m['role']=='assistant'],
                         ['Deploy the window change','Saved the requested result.'])
        self.assertFalse([r for r,_ in self.peer.mutations if r in ('/messages','/window','/accept')])


class SingleConfigTests(unittest.TestCase):
    def service(self,**extra):
        value=dict(origin='https://example.test',loopback_url='http://127.0.0.1:1234',
                   expected_owner='00000000-0000-4000-8000-000000000001',listen_port=1234,token_path='/synthetic/token')
        value.update(extra)
        with patch.object(config_module,'private_json',return_value=dict(token='a'*64)):
            return config_module._service(value)

    def test_absent_mode_defaults_single_and_legacy_requires_explicit_bool(self):
        self.assertIs(self.service()['legacy_companions'],False)
        self.assertIs(self.service(legacy_companions=True)['legacy_companions'],True)
        for value in [1,'true',None]:
            with self.subTest(value=value),self.assertRaisesRegex(ValueError,'config_legacy_companions'):
                self.service(legacy_companions=value)


if __name__=='__main__':unittest.main()
