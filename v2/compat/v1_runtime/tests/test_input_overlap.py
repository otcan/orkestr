"""Owner answers keep their own run and delivery when a later timer is silent."""
import json
from pathlib import Path
import tempfile
import unittest

from v2.compat.v1_runtime.ledger import Ledger
from v2.compat.v1_runtime.worker import Worker
from v2.compat.v1_runtime.tests.test_timer_relay import SCOPE, occurrence
from v2.compat.v1_runtime.tests.test_timer_settlement import OwnRunPeer, status


class InputOverlapTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.ledger = Ledger(Path(directory.name) / 'ledger.sqlite3', SCOPE)
        self.owner, _ = self.ledger.enqueue(dict(publicMessageId='owner-public', publicThreadId='v1-thread',
            chatId='chat@g.us', accountId='account', text='Make a plan'))
        self.owner.update(phase='running', intake=dict(message_id='owner-message', event_id='owner-event', sequence=1),
                          cursor=1, window=dict(window_id='shared-window'))
        self.ledger.save(self.owner)
        self.peer = OwnRunPeer()
        self.peer.runs['owner-message'] = {role: status(role + '-owner', 'completed') for role in ('fast', 'deep')}
        self.peer.auto_accepted.update(['fast-owner', 'deep-owner'])
        self.peer.texts['deep-owner'] = 'The accepted plan'
        self.peer.texts['fast-owner'] = 'NO_REPLY' # This overlap case exercises only the substantive Deep answer.
        self.peer.ran(2, text='NO_REPLY')
        self.peer.timer_rows = [occurrence(2)]
        self.worker = Worker(self.peer, self.ledger)
        self.ledger.set_timer_cursor(0)

    def row(self, remote):
        with self.ledger.connect() as db:
            return json.loads(db.execute('SELECT data FROM inputs WHERE remote_id=?', (remote,)).fetchone()[0])

    def test_owner_then_silent_timer_export_once_and_track_delivery_per_input(self):
        progress = self.ledger.add_progress(self.owner, 'earlier-progress', 'Earlier progress')
        self.ledger.acknowledge(progress['id'], dict(outcome='delivered', parentPublicMessageId='owner-public',
            outboxJobId='synthetic-progress-job', localMessageId='synthetic-progress-local', deliveredAt='2026-01-01T00:00:00Z',
            connectorMessageIds=['synthetic-progress-receipt']))
        self.worker.discover_timers()
        self.worker.observe(self.owner)
        self.assertEqual(self.owner['phase'], 'completed')
        timer = self.ledger.next_input()
        self.assertEqual(timer['origin'], 'timer')
        self.worker.step(timer)
        self.assertEqual(timer['phase'], 'completed')
        replies = [message for message in self.ledger.messages() if message.get('phase') == 'final_answer']
        self.assertEqual(len(replies), 2)
        answer, silent = replies
        self.assertEqual((answer['parentMessageId'], answer['text']), (self.owner['remote_id'], 'The accepted plan'))
        self.assertEqual((silent['parentMessageId'], silent['text'], silent['noReply']), (timer['remote_id'], 'NO_REPLY', True))
        self.assertNotIn('settled', self.row(timer['remote_id']))
        self.ledger.acknowledge(answer['id'], dict(outcome='delivered', parentPublicMessageId='owner-public',
            outboxJobId='synthetic-answer-job', localMessageId='synthetic-answer-local', deliveredAt='2026-01-01T00:00:00Z',
            connectorMessageIds=['synthetic-owner-final-receipt']))
        self.assertEqual(self.row(self.owner['remote_id'])['settled']['outcome'], 'delivered')
        self.assertNotIn('settled', self.row(timer['remote_id']))
        self.ledger.acknowledge(silent['id'], dict(outcome='no_reply',
            parentPublicMessageId='v2timer-' + timer['remote_id'], connectorMessageIds=[]))
        self.assertEqual(self.row(timer['remote_id'])['settled']['outcome'], 'no_reply')
        self.assertIsNone(self.ledger.next_input())
        with self.ledger.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM exports WHERE kind='progress'").fetchone()[0], 1)
        self.assertFalse([route for route, _ in self.peer.mutations if route != '/settings/render'],
                         'already accepted own results need no new input/run/acceptance')

    def test_role_status_is_pinned_to_the_owner_even_when_current_views_have_moved(self):
        ids = {'fast-owner', 'deep-owner'}
        for role in ('fast', 'deep'):
            result = self.worker.role_status(self.owner, role, ids)
            self.assertEqual(result['run_id'], role + '-owner')
        queried = [route for method, route in self.peer.reads if '/execution' in route]
        self.assertTrue(queried)
        self.assertTrue(all('?run_id=' in route for route in queried))

    def test_foreign_current_run_cannot_supply_a_missing_owned_role(self):
        del self.peer.runs['owner-message']['fast']
        result = self.worker.role_status(self.owner, 'fast', {'deep-owner'})
        self.assertIsNone(result)

    def test_short_nonempty_sse_reads_do_not_refuse_a_completed_timer_behind_the_cursor(self):
        self.worker.discover_timers()
        with self.ledger.connect() as db:
            timer = json.loads(db.execute("SELECT data FROM inputs WHERE json_extract(data,'$.origin')='timer'").fetchone()[0])
        timer['deep_missing_since'] = 0
        self.ledger.save(timer)
        original_match = self.peer.matching_run_ids
        self.peer.read_events = lambda after, maximum: ([{'sequence': after + 1}] if after < 5 else [])
        self.peer.matching_run_ids = lambda events, intake: (original_match(events, intake)
            if any(event['sequence'] == 5 for event in events) else [])
        self.worker.step(timer)
        self.assertNotEqual(timer['phase'], 'completed')
        self.assertEqual(timer['cursor'], 2)
        for _ in range(3):
            self.worker.step(timer)
        self.assertEqual(timer['phase'], 'completed')
        self.assertEqual(timer['reply']['text'], 'NO_REPLY')
        self.assertNotIn('refused', timer)


if __name__ == '__main__':
    unittest.main()
