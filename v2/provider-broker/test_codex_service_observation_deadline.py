"""Read-only observation replies share the caller's bounded control allowance."""
import json
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
        reply, deadlines, manager = self.exchange(1.2)
        self.assertIsNotNone(reply, 'the manager closed without its observation reply')
        self.assertTrue(reply['ok'])
        self.assertEqual(deadlines, [11, 15])
        manager.ledger._scope.assert_called_once()

    def test_receive_time_does_not_restart_the_five_second_budget(self):
        reply, deadlines, _manager = self.exchange(1.2, received=.7)
        self.assertTrue(reply['ok'])
        self.assertEqual(deadlines, [11, 15])

    def test_observation_cannot_spend_window_cleanup_time_or_exceed_five_seconds(self):
        for elapsed, work, expected in [(1.2, 10.5, 10.5), (5.01, 100, 15)]:
            with self.subTest(elapsed=elapsed, work=work):
                reply, deadlines, _manager = self.exchange(elapsed, work=work)
                self.assertIsNone(reply)
                self.assertEqual(deadlines, [11, expected])

    def test_other_operations_keep_the_existing_one_second_reply_bound(self):
        for operation in ('status', 'managed_consume', 'managed_result', 'managed_cancel'):
            with self.subTest(operation=operation):
                reply, deadlines, manager = self.exchange(1.2, operation=operation)
                self.assertIsNone(reply)
                self.assertEqual(deadlines, [11, 11])
                manager.ledger._scope.assert_not_called()

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
