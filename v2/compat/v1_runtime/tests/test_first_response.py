"""Interactive Fast delivery through the real input/export ledger; no sends."""
from unittest.mock import patch
import unittest

from v2.compat.v1_runtime.tests import test_worker as fixture
from v2.compat.v1_runtime.worker import Worker


class FirstResponseTests(unittest.TestCase):
    setUp = fixture.WorkerTests.setUp

    def configure(self, fast="I am checking the request.", deep="running", final="Here is the result."):
        self.state = {"fast": fast, "deep": deep, "final": final, "payload": "deep-progress"}
        self.data["queued_at"] = 100
        self.ledger.save(self.data)
        original = self.peer.request
        def request(method, route, **kwargs):
            if route.split("?", 1)[0] == "/execution" and self.state["deep"] == "running":
                return 200, {"run_id": "deep-run", "phase": "running", "revision": 1,
                             "progress": {"payload_id": self.state["payload"]}}
            if route == "/payloads/fast-payload":
                return 200, {"run_id": "fast-run", "payload_id": "fast-payload", "text": self.state["fast"]}
            if route == "/payloads/deep-payload":
                return 200, {"run_id": "deep-run", "payload_id": "deep-payload", "text": self.state["final"]}
            if route.startswith("/payloads/deep-progress"):
                return 200, {"run_id": "deep-run", "payload_id": self.state["payload"], "text": "Still checking."}
            return original(method, route, **kwargs)
        self.peer.request = request
        self.worker = Worker(self.peer, self.ledger, progress_updates=True)

    def step_at(self, seconds):
        with patch("time.time", return_value=100 + seconds):
            self.worker.step(self.ledger.next_input() or self.data)

    def replies(self):
        return [r for r in self.ledger.messages() if r["role"] == "assistant"]

    def test_fast_is_exported_immediately_and_survives_restart_once(self):
        self.configure()
        self.step_at(1)
        first = self.replies()
        self.assertEqual([r["text"] for r in first], [self.state["fast"]])
        self.assertTrue(first[0]["firstResponse"])
        self.worker = Worker(self.peer, self.ledger, progress_updates=True)
        self.step_at(6)
        self.assertEqual(self.replies(), first)
        self.assertNotIn("deep", self.peer.accepted)

    def test_ack_then_final_and_later_progress_are_spaced_by_a_minute(self):
        self.configure()
        self.step_at(5)
        self.step_at(64)
        self.assertEqual(len(self.replies()), 1)
        self.step_at(65)
        self.assertEqual([r["text"] for r in self.replies()], ["Still checking.", self.state["fast"]])
        self.state["deep"] = "ready"
        self.step_at(66)
        self.assertEqual([r["text"] for r in self.replies()],
                         ["Still checking.", self.state["final"], self.state["fast"]])

    def test_ready_fast_is_preserved_when_deep_is_also_ready(self):
        self.configure()
        self.state["deep"] = "ready"
        self.step_at(1)
        self.assertEqual([r["text"] for r in self.replies()], [self.state["final"], self.state["fast"]])

    def test_silent_deep_does_not_drop_a_substantive_ready_fast(self):
        self.configure(final="NO_REPLY")
        self.step_at(1)
        self.state["deep"] = "ready"
        self.step_at(4)
        self.assertEqual(len(self.replies()), 2)
        self.assertTrue(self.replies()[0]["noReply"])
        self.assertEqual(self.replies()[1]["text"], self.state["fast"])

    def test_first_available_fast_after_the_coalescing_window_has_no_extra_delay(self):
        self.configure()
        self.step_at(8)
        self.assertEqual([r["text"] for r in self.replies()], [self.state["fast"]])

    def test_foreign_fast_run_is_ignored(self):
        self.configure()
        original = self.peer.request
        def request(method, route, **kwargs):
            status, value = original(method, route, **kwargs)
            if route.split("?", 1)[0] == "/fast/execution":
                value = {**value, "run_id": "foreign-fast-run"}
            return status, value
        self.peer.request = request
        self.step_at(8)
        self.assertEqual(self.replies(), [])

    def test_no_reply_fast_never_creates_an_ack_and_final_no_reply_stays_silent(self):
        self.configure(fast="NO_REPLY", final="NO_REPLY")
        self.step_at(5)
        self.assertEqual(self.replies(), [])
        self.state["deep"] = "ready"
        self.step_at(6)
        self.assertEqual(len(self.replies()), 1)
        self.assertTrue(self.replies()[0]["noReply"])
        self.assertEqual(self.replies()[0]["text"], "NO_REPLY")

    def test_fast_is_independent_of_progress_preference_but_timers_keep_silence_policy(self):
        self.configure()
        self.worker.progress_updates = False
        self.step_at(5)
        first = self.replies()
        self.assertEqual(len(first), 1)
        self.worker.progress_updates = True
        current = self.ledger.next_input()
        current["origin"] = "timer"
        self.ledger.save(current)
        # Exercise the helper directly: timer intake has its separate run lookup.
        from v2.compat.v1_runtime.first_response import capture
        capture(self.worker, current, {"fast": {"run_id": "fast-run", "phase": "completed"}}, {"fast-run"})
        self.assertEqual(self.replies(), first)

    def test_final_receipt_cannot_supersede_fast_and_restart_cannot_reexport_it(self):
        self.configure(deep="ready")
        self.step_at(1)
        final=next(row for row in self.replies() if not row.get('firstResponse'))
        fast=next(row for row in self.replies() if row.get('firstResponse'))
        self.ledger.acknowledge(final['id'],dict(outcome='delivered',outboxJobId='fake-final',parentPublicMessageId='public'))
        self.assertEqual([row['id'] for row in self.replies()],[fast['id']])
        self.worker=Worker(self.peer,self.ledger,progress_updates=False)
        self.assertIsNone(self.ledger.next_input())
        parent=next(row for row in self.ledger.messages() if row['id']==fast['parentMessageId'])
        self.ledger.acknowledge(fast['id'],dict(outcome='delivered',outboxJobId='fake-fast',parentPublicMessageId=parent['publicMessageId']))
        self.assertEqual(self.ledger.messages(),[])

    def test_fast_does_not_consume_any_of_the_three_ordinary_progress_slots(self):
        self.configure();self.step_at(1)
        current=self.ledger.next_input()
        for index in range(3):
            self.assertIsNotNone(self.ledger.add_progress(current,'update-'+str(index),'work'))
        self.assertIsNone(self.ledger.add_progress(current,'fourth','work'))

    def test_v1_local_fast_is_recorded_locally_without_a_pseudo_group_notification(self):
        self.configure()
        self.data['author']=dict(role='v1_owner',id='v1:web:owner',label='Owner',source='web')
        self.ledger.save(self.data)
        self.step_at(1)
        self.assertEqual(len(self.replies()),1)
        self.assertEqual(self.replies()[0]['parentMessageId'],self.data['remote_id'])
        with self.ledger.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM inputs').fetchone()[0],1)

    def test_latency_uses_only_the_explicit_fast_parent_and_confirmed_receipt(self):
        from v2.compat.v1_runtime.latency import measure
        self.configure();self.step_at(1)
        fast=self.replies()[0]
        parent=next(row for row in self.ledger.messages() if row['id']==fast['parentMessageId'])
        self.ledger.acknowledge(fast['id'],dict(outcome='delivered',outboxJobId='fake-fast',parentPublicMessageId=parent['publicMessageId'],
            connectorMessageIds=['fake-receipt'],deliveredAt='1970-01-01T00:01:42+00:00'))
        result=measure(self.ledger.path,100000)
        self.assertEqual((result['sample_n'],result['p50_ms'],result['samples'][0]['first_kind']),(1,2000,'fast'))
        with self.ledger.connect() as db:
            db.execute("UPDATE inputs SET data=json_set(data,'$.first_response_for.input_id','foreign') WHERE remote_id=?",(fast['parentMessageId'],))
        self.assertEqual(measure(self.ledger.path,100000)['sample_n'],0)


if __name__ == "__main__":
    unittest.main()
