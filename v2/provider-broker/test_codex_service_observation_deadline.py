"""Read-only observation replies share the caller's bounded control allowance."""
import json
import time
import socket
import struct
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from codex_service.contract import DRAIN_SECONDS, Refused
from codex_service.manager import Manager
from codex_service.managed_ingress import Ingress


class ObservationReplyTests(unittest.TestCase):
    def exchange(self, elapsed, *, operation='managed_pending', work=100, received=0):
        clock = [10.0]
        request = dict(operation=operation, window_id='synthetic-window', generation=1,
                       owner_id='synthetic-owner', conversation_id='synthetic-conversation')
        ledger = SimpleNamespace(_scope=Mock(), details=Mock(return_value={
            'conversation': request['conversation_id'],
            'deadline_mono_ns': int((work + DRAIN_SECONDS) * 1e9)}),
            status=Mock(return_value={}))
        server, client = socket.socketpair()
        self.addCleanup(client.close)
        manager = Manager.__new__(Manager)
        manager.ledger = ledger
        manager.peer = SimpleNamespace(accepts=lambda _: True)
        manager.control = SimpleNamespace(socket=SimpleNamespace(accept=lambda: (server, None)))
        manager.due = lambda: False
        deadlines = []

        def receive(_connection, deadline):
            deadlines.append(deadline)
            clock[0] += received
            return request, []

        def dispatch(_request, deadline, _descriptors):
            deadlines.append(deadline)
            clock[0] += elapsed
            return {'ok': True, 'receipt': {}, 'managed_pending': []}

        manager.dispatch = Mock(side_effect=dispatch)
        with patch('time.monotonic', side_effect=lambda: clock[0]), \
                patch('codex_service.manager.receive_control', receive):
            manager.once()
        client.settimeout(1)
        raw = client.recv(65536)
        reply = json.loads(raw[4:]) if raw else None
        if raw:
            self.assertEqual(struct.unpack('!I', raw[:4])[0], len(raw) - 4)
        return reply, deadlines, manager

    def test_observation_reply_survives_work_past_the_old_one_second_limit(self):
        for operation in ('managed_pending', 'managed_run_open', 'managed_consume',
                          'managed_poll', 'managed_renew', 'managed_result'):
            with self.subTest(operation=operation):
                reply, deadlines, manager = self.exchange(1.2, operation=operation)
                self.assertIsNotNone(reply, 'the manager closed without its acknowledgement')
                self.assertTrue(reply['ok'])
                self.assertEqual(deadlines, [11, 15])
                manager.ledger._scope.assert_called_once()

    def test_receive_time_does_not_restart_the_five_second_budget(self):
        reply, deadlines, _manager = self.exchange(1.2, received=.7)
        self.assertTrue(reply['ok'])
        self.assertEqual(deadlines, [11, 15])

    def test_workspace_attestation_has_one_bounded_read_only_reply_allowance(self):
        for elapsed, received, succeeds in ((1.2, 0, True), (1.2, .7, True),
                                            (5.01, 0, False), (4.4, .7, False)):
            with self.subTest(elapsed=elapsed, received=received):
                reply, deadlines, manager = self.exchange(
                    elapsed, operation='workspace_attest', received=received)
                self.assertEqual(reply is not None, succeeds)
                if succeeds:
                    self.assertTrue(reply['ok'])
                self.assertEqual(deadlines, [11, 15])
                # Physical proof does not admit work or spend a window's
                # cleanup margin. Actual project scope is checked by dispatch.
                manager.ledger._scope.assert_not_called()

    def test_observation_cannot_spend_window_cleanup_time_or_exceed_five_seconds(self):
        for elapsed, work, expected in [(1.2, 10.5, 10.5), (5.01, 100, 15)]:
            with self.subTest(elapsed=elapsed, work=work):
                reply, deadlines, _manager = self.exchange(elapsed, work=work)
                self.assertIsNone(reply)
                self.assertEqual(deadlines, [11, expected])

    def test_other_operations_keep_the_existing_one_second_reply_bound(self):
        for operation in ('status', 'managed_cancel', 'managed_run_close'):
            with self.subTest(operation=operation):
                reply, deadlines, manager = self.exchange(1.2, operation=operation)
                self.assertIsNone(reply)
                self.assertEqual(deadlines, [11, 11])
                manager.ledger._scope.assert_not_called()

    def test_poll_during_cleanup_keeps_one_second_and_the_original_cleanup_end(self):
        reply, deadlines, _ = self.exchange(.2, operation='managed_poll', work=9)
        self.assertTrue(reply['ok'])
        self.assertEqual(deadlines, [11, 11])
        reply, deadlines, _ = self.exchange(1.2, operation='managed_poll', work=9)
        self.assertIsNone(reply)
        self.assertEqual(deadlines, [11, 11])
        reply, deadlines, _ = self.exchange(.2, operation='managed_poll', work=10.1-DRAIN_SECONDS)
        self.assertIsNone(reply)
        self.assertEqual(deadlines, [11, 10.1])

    def test_observation_scope_and_expired_work_refuse_before_dispatch(self):
        manager = Manager.__new__(Manager)
        manager.ledger = SimpleNamespace(_scope=Mock(), details=Mock(return_value={
            'conversation': 'other-conversation', 'deadline_mono_ns': 100_000_000_000}))
        request = dict(window_id='synthetic-window', generation=1,
                       conversation_id='synthetic-conversation')
        with self.assertRaisesRegex(Refused, '^scope$'):
            manager._observation_deadline(request, 10)
        manager.ledger.details.return_value = dict(conversation='synthetic-conversation',
            deadline_mono_ns=int((10 + DRAIN_SECONDS) * 1e9))
        with patch('time.monotonic', return_value=10), \
                self.assertRaisesRegex(Refused, '^observation_deadline$'):
            manager._observation_deadline(request, 10)


class PendingScopeTests(unittest.TestCase):
    def test_other_windows_are_not_reauthenticated_for_a_pending_observation(self):
        for window, generation in [('other-window', 1), ('synthetic-window', 2)]:
            with self.subTest(window=window, generation=generation):
                peer = SimpleNamespace(request='synthetic-request', source={
                    'window_id': window, 'window_generation': generation},
                    proof=SimpleNamespace(identity={}, exited=Mock(return_value=False)),
                    deadline=100, authenticate=Mock())
                ingress = Ingress.__new__(Ingress)
                ingress.manager = SimpleNamespace(_desk_window_active=lambda *_: True)
                ingress.peers = [peer]
                ingress.directory = SimpleNamespace(glob=lambda _: [])
                with patch('codex_service.managed_ingress.exists', return_value=True) as exists, \
                        patch('time.monotonic', return_value=10):
                    self.assertEqual(ingress.pending('synthetic-window', 1), [])
                exists.assert_not_called()
                peer.proof.exited.assert_not_called()
                peer.authenticate.assert_not_called()


if __name__ == '__main__':
    unittest.main()


class ExpiredConsumptionTests(unittest.TestCase):
    """2026-11-20 and 2026-11-22 (PA): a managed consumption Core gave up on (no
    answer within its deadline, or a refusal) paused the window as "delivery
    unknown". A consumption now carries Core's deadline; the manager applies
    nothing after it, and managed_poll proves whether it was ever applied."""
    OPERATION = '55555555-5555-4555-8555-555555555555'
    RUN = '44444444-4444-4444-8444-444444444444'

    def setUp(self):
        import tempfile
        from pathlib import Path
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        source = dict(window_id='66666666-6666-4666-8666-666666666666', window_generation=1,
                      owner_id='11111111-1111-4111-8111-111111111111',
                      conversation_id='22222222-2222-4222-8222-222222222222', run_id=self.RUN,
                      session_id='33333333-3333-4333-8333-333333333333', generation=1, provider='codex',
                      incarnation='synthetic', native_session_id='synthetic-native', resume_setup_id=None)
        request = {'version': 1, 'request_key': 'synthetic-1', 'operation': 'root_request_submit',
                   'arguments': {'action': 'read', 'resource': 'example.invalid', 'summary': 'summary'}}
        self.record = dict(request_id=self.OPERATION, source=source, request=request, payload_sha256='0' * 64,
                           created_at_ms=1, state='pending')
        self.path = self.directory / (self.OPERATION + '.json')
        self.path.write_text(json.dumps(self.record))
        now = int(time.time() * 1000)
        self.cap = dict(operation_id=self.OPERATION, run_id=self.RUN, binding_generation=1, lease_generation=1,
                        dispatch_fence=1, expires_at_ms=now + 20000, hard_deadline_ms=now + 60000,
                        evidence={'source': source, 'request': request},
                        source_message_id='77777777-7777-4777-8777-777777777777',
                        source_event_id='88888888-8888-4888-8888-888888888888')
        self.published = []
        self.ingress = SimpleNamespace(directory=self.directory, peers=[], manager=SimpleNamespace(desk=None),
                                       pending=lambda *_: [self.record])

    def consume(self, deadline_ms):
        from codex_service import managed_control
        with patch('codex_service.managed_control.protected', lambda path, directory=False: path), \
                patch('codex_service.managed_control.publish', lambda _ingress, record: self.published.append(record)):
            return managed_control.consume(self.ingress, self.cap, deadline_ms)

    def stored(self):
        return json.loads(self.path.read_text())

    def test_a_consumption_past_its_deadline_changes_nothing(self):
        from codex_service.managed_control import receipt
        with self.assertRaisesRegex(Refused, 'managed_request_expired'):
            self.consume(int(time.time() * 1000) - 1)
        self.assertEqual(self.stored(), self.record)
        self.assertEqual(self.published, [])
        proof = receipt(self.stored())
        self.assertEqual((proof['state'], proof['consumed']), ('pending', False))

    def test_a_consumption_within_its_deadline_applies_once(self):
        from codex_service.managed_control import receipt
        record = self.consume(int(time.time() * 1000) + 5000)
        self.assertEqual(record['state'], 'completed')
        self.assertEqual(len(self.published), 1)
        self.assertEqual((receipt(self.stored())['state'], receipt(self.stored())['consumed']), ('completed', True))
        # The same consumption again, even after its deadline, is the same applied claim.
        self.assertEqual(self.consume(int(time.time() * 1000) - 1)['state'], 'completed')
        self.assertEqual(len(self.published), 1)

    def test_without_a_deadline_the_old_behaviour_stays(self):
        self.assertEqual(self.consume(None)['state'], 'completed')

    def test_a_caller_that_went_away_leaves_a_claim_that_was_never_applied(self):
        from codex_service.managed_control import receipt
        gone = dict(self.record, state='unknown')
        self.assertEqual((receipt(gone)['state'], receipt(gone)['consumed']), ('unknown', False))

    def test_the_contract_accepts_a_deadline_only_on_a_consumption(self):
        from codex_service.contract import decode
        base = {'version': 1, 'request_id': 'managed:synthetic', 'owner_id': '11111111-1111-4111-8111-111111111111',
                'conversation_id': '22222222-2222-4222-8222-222222222222',
                'window_id': '66666666-6666-4666-8666-666666666666', 'generation': 1}
        consume = dict(base, operation='managed_consume', capability=self.cap, deadline_ms=int(time.time() * 1000))
        self.assertEqual(decode(json.dumps(consume).encode())['deadline_ms'], consume['deadline_ms'])
        without = {k: v for k, v in consume.items() if k != 'deadline_ms'}
        self.assertNotIn('deadline_ms', decode(json.dumps(without).encode()))
        for bad in ('soon', -1, 0, 1.5):
            with self.subTest(deadline=bad), self.assertRaisesRegex(Refused, 'deadline_ms'):
                decode(json.dumps(dict(consume, deadline_ms=bad)).encode())
        poll = dict(base, operation='managed_poll', operation_id=self.OPERATION, deadline_ms=1)
        with self.assertRaisesRegex(Refused, 'fields'):
            decode(json.dumps(poll).encode())
