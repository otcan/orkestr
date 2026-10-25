"""The same native question cannot use both the post and progress transports."""
from unittest.mock import patch
import unittest

from v2.compat.v1_runtime.tests import test_worker as fixture
from v2.compat.v1_runtime.worker import QUESTION_PREFIX, Worker


class QuestionExportTests(unittest.TestCase):
    setUp = fixture.WorkerTests.setUp

    def configure(self, event_first):
        self.question = 'b1000000-0000-4000-8000-000000000001'
        self.text = QUESTION_PREFIX + 'Which synthetic option should I use?'
        self.event_visible = event_first
        self.data.update(phase='running',intake=dict(message_id='message',event_id='event',sequence=1),
                         cursor=1,window=dict(window_id='window'),admitted_at=0,
                         matched_runs=['fast-run','deep-run'])
        self.ledger.save(self.data)
        self.peer.read_events = lambda after, maximum: ([dict(sequence=2,schema_version=8,
            payload_ref_or_safe_payload=dict(kind='provider_observed',run_id='deep-run',
                observation=dict(kind='progress_ref',payload_id=self.question)))]
            if self.event_visible and after<2 else [])
        original = self.peer.request
        def request(method, route, **kwargs):
            if route == '/execution?run_id=deep-run':
                return 200,dict(run_id='deep-run',phase='running',revision=1,progress=dict(payload_id=self.question))
            if route == '/payloads/'+self.question:
                return 200,dict(run_id='deep-run',payload_id=self.question,text=self.text)
            return original(method,route,**kwargs)
        self.peer.request = request
        self.worker = Worker(self.peer,self.ledger,progress_updates=True)

    def observe(self):
        with patch('time.time',return_value=1000):
            self.worker.observe(self.ledger.next_input())

    def assert_once(self):
        questions=[message for message in self.ledger.messages() if message.get('text')==self.text]
        self.assertEqual(len(questions),1)
        self.assertNotEqual(questions[0]['parentMessageId'],self.data['remote_id'])
        self.assertEqual(questions[0]['phase'],'final_answer')
        with self.ledger.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM exports WHERE source_key=?",
                ('progress:'+self.data['remote_id']+':'+self.question,)).fetchone()[0],0)

    def test_event_post_is_not_duplicated_by_the_latest_progress_view(self):
        self.configure(event_first=True)
        self.observe()
        self.assert_once()
        self.worker=Worker(self.peer,self.ledger,progress_updates=True)
        self.observe()
        self.assert_once()

    def test_latest_question_before_event_catchup_uses_the_same_durable_post(self):
        self.configure(event_first=False)
        self.observe()
        self.assert_once()
        self.event_visible=True
        self.worker=Worker(self.peer,self.ledger,progress_updates=True)
        self.observe()
        self.assert_once()


if __name__=='__main__':
    unittest.main()
