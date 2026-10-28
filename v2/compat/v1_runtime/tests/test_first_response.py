"""Interactive Fast delivery through the real input/export ledger; no sends."""
from unittest.mock import patch
import unittest

from v2.compat.v1_runtime.tests import test_worker as fixture
from v2.compat.v1_runtime.outbound_text import PROGRESS_SETTLE_S
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
        self.worker.fast_reply_policy = "owner_only"

    def step_at(self, seconds):
        with patch("time.time", return_value=100 + seconds):
            self.worker.step(self.ledger.next_input() or self.data)

    def replies(self):
        return [r for r in self.ledger.messages() if r["role"] == "assistant"]

    def ack_fast(self, outcome='delivered'):
        fast=next(row for row in self.replies() if row.get('firstResponse'))
        parent=next(row for row in self.ledger.messages() if row['id']==fast['parentMessageId'])
        self.ledger.acknowledge(fast['id'],dict(outcome=outcome,outboxJobId='fake-fast',parentPublicMessageId=parent['publicMessageId'],
            connectorMessageIds=['fake-receipt'] if outcome=='delivered' else [],deliveredAt='1970-01-01T00:01:42+00:00'))
        return fast

    def test_fast_is_exported_immediately_and_survives_restart_once(self):
        self.configure()
        self.step_at(1)
        first = self.replies()
        self.assertEqual([r["text"] for r in first], [self.state["fast"]])
        self.assertTrue(first[0]["firstResponse"])
        self.worker = Worker(self.peer, self.ledger, progress_updates=True)
        self.worker.fast_reply_policy="owner_only"
        self.step_at(6)
        self.assertEqual(self.replies(), first)
        self.assertNotIn("deep", self.peer.accepted)

    def test_only_a_burst_fast_reply_quotes_its_source(self):
        self.configure()
        self.step_at(1)
        lone = next(row for row in self.replies() if row.get("firstResponse"))
        self.assertNotIn("quoteSource", lone)

    def test_burst_fast_reply_is_marked_to_quote_its_source(self):
        self.configure()
        inner = self.peer.request
        def request(method, route, **kwargs):
            status, value = inner(method, route, **kwargs)
            if route.split("?", 1)[0] == "/fast/execution" and isinstance(value, dict):
                value = dict(value, concurrent_fast=True)
            return status, value
        self.peer.request = request
        self.step_at(1)
        fast = next(row for row in self.replies() if row.get("firstResponse"))
        self.assertIs(fast["quoteSource"], True)
        self.assertEqual(fast["sourceInputId"], self.data["remote_id"])

    def test_ack_then_final_and_later_progress_are_spaced_by_a_minute(self):
        self.configure()
        self.step_at(5)
        self.step_at(64)
        self.assertEqual(len(self.replies()), 1)
        self.step_at(65)  # The complete snapshot is held until it settles.
        self.step_at(65 + PROGRESS_SETTLE_S)
        self.assertEqual([r["text"] for r in self.replies()], ["Still checking.", self.state["fast"]])
        self.ack_fast()
        self.state["deep"] = "ready"
        self.step_at(66 + PROGRESS_SETTLE_S)
        self.assertEqual([r["text"] for r in self.replies()],
                         ["Still checking.", self.state["final"]])

    def test_ready_fast_is_preserved_when_deep_is_also_ready(self):
        self.configure()
        self.state["deep"] = "ready"
        self.step_at(1)
        self.assertEqual([r["text"] for r in self.replies()],[self.state["fast"]])
        self.assertNotEqual(self.ledger.next_input()['phase'],'completed')
        self.ack_fast();self.step_at(2)
        self.assertEqual([r["text"] for r in self.replies()],[self.state["final"]])

    def test_silent_deep_does_not_drop_a_substantive_ready_fast(self):
        self.configure(final="NO_REPLY")
        self.step_at(1)
        self.state["deep"] = "ready"
        self.step_at(4)
        self.assertEqual([r["text"] for r in self.replies()],[self.state["fast"]])
        self.ack_fast();self.step_at(5)
        self.assertEqual(len(self.replies()),1)
        self.assertTrue(self.replies()[0]['noReply'])

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

    def test_no_stale_fast_after_final_and_ordering_survives_restart(self):
        self.configure(deep="ready");self.step_at(1)
        (fast,)=self.replies()
        self.worker=Worker(self.peer,self.ledger,progress_updates=False)
        self.worker.fast_reply_policy="owner_only"
        self.step_at(2);self.assertEqual(self.replies(),[fast])
        self.ack_fast();self.step_at(3)
        (final,)=self.replies();self.assertFalse(final.get('firstResponse'))
        self.ledger.acknowledge(final['id'],dict(outcome='delivered',outboxJobId='fake-final',parentPublicMessageId='public'))
        self.assertEqual(self.ledger.messages(),[])
        self.assertIsNone(self.ledger.next_input())

    def test_uncertain_fast_blocks_final_without_resending_or_reexporting(self):
        self.configure(deep="ready");self.step_at(1)
        fast=self.ack_fast('uncertain')
        self.step_at(2)
        self.assertEqual([row['id'] for row in self.replies()],[fast['id']])
        self.assertEqual(self.ledger.next_input()['first_response']['delivery_blocker'],'unverified_uncertain')
        self.ack_fast();self.step_at(3)
        self.assertEqual([row['text'] for row in self.replies()],[self.state['final']])

    def test_participant_binding_preserves_existing_preference_coalesce_and_ready_deep_policy(self):
        self.configure();self.worker.fast_reply_policy="legacy";self.worker.progress_updates=False
        self.step_at(1);self.step_at(6);self.assertEqual(self.replies(),[])
        self.worker.progress_updates=True;self.step_at(7)
        self.assertEqual(len(self.replies()),1)
        self.assertEqual(self.replies()[0]['kind'],'progress')
        self.assertFalse(self.replies()[0].get('firstResponse'))

    def test_coordinator_policy_suppresses_fast_with_progress_enabled(self):
        self.configure(deep="ready");self.worker.fast_reply_policy='disabled'
        self.step_at(1)
        self.assertEqual([row['text'] for row in self.replies()],[self.state['final']])

    def test_participant_binding_keeps_ready_final_supersession(self):
        self.configure(deep="ready");self.worker.fast_reply_policy="legacy"
        self.step_at(1)
        self.assertEqual([row['text'] for row in self.replies()],[self.state['final']])

    def test_definite_fast_non_send_releases_the_final_without_a_later_fast(self):
        self.configure(deep="ready");self.step_at(1)
        self.ack_fast('suppressed');self.step_at(2)
        self.assertEqual([row['text'] for row in self.replies()],[self.state['final']])

    def test_hanging_fast_never_holds_final_longer_than_fifteen_seconds_even_after_restart(self):
        self.configure(deep="ready");self.step_at(1)
        (fast,)=self.replies()
        self.worker=Worker(self.peer,self.ledger)
        self.worker.fast_reply_policy="owner_only"
        self.step_at(15);self.assertEqual(self.replies(),[fast])
        self.step_at(16);(final,)=self.replies()
        self.assertEqual(final['text'],self.state['final'])
        with self.ledger.connect() as db:
            outcome,raw=db.execute('SELECT outcome,ack FROM exports WHERE export_id=?',(fast['id'],)).fetchone()
            self.assertEqual(outcome,'superseded');self.assertIsNone(raw)
        self.ledger.acknowledge(final['id'],dict(outcome='delivered',outboxJobId='fake-final',parentPublicMessageId='public'))
        self.assertEqual(self.ledger.messages(),[])

    def test_uncertain_fast_releases_final_at_fifteen_seconds_and_keeps_late_receipt_honest(self):
        import json
        self.configure(deep="ready");self.step_at(1)
        (fast,)=self.replies()
        parent=next(row for row in self.ledger.messages() if row['id']==fast['parentMessageId'])
        self.ack_fast('uncertain');self.step_at(16)
        self.assertEqual([row['text'] for row in self.replies()],[self.state['final']])
        with self.ledger.connect() as db:
            data=json.loads(db.execute('SELECT data FROM inputs WHERE remote_id=?',(self.data['remote_id'],)).fetchone()[0])
            self.assertEqual(data['first_response']['delivery_blocker'],'unverified_uncertain')
        self.ledger.acknowledge(fast['id'],dict(outcome='delivered',outboxJobId='fake-fast',parentPublicMessageId=parent['publicMessageId'],
            connectorMessageIds=['late-receipt'],deliveredAt='1970-01-01T00:01:57+00:00'))
        with self.ledger.connect() as db:
            outcome,raw=db.execute('SELECT outcome,ack FROM exports WHERE export_id=?',(fast['id'],)).fetchone()
            self.assertEqual(outcome,'superseded');self.assertEqual(json.loads(raw)['connectorMessageIds'],['late-receipt'])

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
