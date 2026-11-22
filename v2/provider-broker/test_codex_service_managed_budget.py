"""Managed admission: concurrency, pace, backstop and answered refusals.

Synthetic claims and socketpairs only: no Root, provider, Core or live manager.
The Ingress is assembled from its parts like the journal tests do.
"""
import io
import json
import os
from pathlib import Path
import socket
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

from codex_bounded.trust import metadata, process
from codex_service import managed_budget as budget
from codex_service.contract import Refused, canonical
from codex_service.managed_budget import STATE_MESSAGES, Admission, Busy, limits, refusal
from codex_service.managed_http import Peer as HttpPeer
from codex_service.managed_ingress import Ingress, Peer as SocketPeer
from codex_service.managed_journal import Journal

RUN = str(uuid.UUID(int=4))
SUBMIT = {'name': 'orkestr_root_request_submit',
          'arguments': {'action': 'read', 'resource': 'example.invalid', 'summary': 'Synthetic summary'}}


def source(window, run=RUN):
    return {'owner_id': str(uuid.UUID(int=1)), 'conversation_id': str(uuid.UUID(int=2)),
            'session_id': str(uuid.UUID(int=3)), 'generation': 1, 'incarnation': 'synthetic',
            'provider': 'codex', 'window_id': window, 'window_generation': 1,
            'broker_pid': 10, 'broker_start': 20, 'caller_pid': 30, 'caller_start': 40,
            'caller_uid': 65534, 'run_id': run}


def claim(request, window, state, run=RUN):
    return {'request_id': request, 'source': source(window, run), 'payload_sha256': '0' * 64,
            'request': {'version': 1, 'request_key': request, 'operation': 'root_request_submit',
                        'arguments': SUBMIT['arguments']},
            'created_at_ms': 1, 'state': state}


def live_proof():
    return SimpleNamespace(identity=process(os.getpid()), exited=lambda: False, close=lambda: None)


class NoAccept:
    def accept(self):
        raise BlockingIOError()


class Fixture:
    """An Ingress from its parts, with one held window and its live callers."""

    def __init__(self, test, runtime=None):
        temp = tempfile.TemporaryDirectory(prefix='synthetic-managed-budget-')
        test.addCleanup(temp.cleanup)
        self.test, self.directory = test, Path(temp.name)
        self.window = str(uuid.uuid4())
        self.log = io.StringIO()
        ingress = Ingress.__new__(Ingress)
        ingress.manager = SimpleNamespace(_desk_window_active=lambda *_: True, windows={self.window: None},
                                          desk=None, package=SimpleNamespace(runtime=runtime or {}))
        ingress.directory, ingress.peers = self.directory, []
        ingress.journal = Journal(self.directory)
        ingress.limits = limits((runtime or {}).get('managed_limits'))
        ingress.admission = Admission(ingress.limits, stream=self.log)
        ingress.runs = SimpleNamespace(attach=self.attach)
        ingress.natives = SimpleNamespace(prune=lambda: None, close=lambda: None)
        ingress.socket = SimpleNamespace(socket=NoAccept(), close=lambda: None)
        ingress.http = None
        self.ingress = ingress

    @staticmethod
    def attach(peer):
        peer.source = {**peer.source, 'run_id': RUN}

    def waiting(self, count, window=None):
        """Live callers of `window` whose claims are still pending."""
        window = window or self.window
        for _ in range(count):
            request = str(uuid.uuid4())
            path = self.directory / (request + '.json')
            path.write_text(json.dumps(claim(request, window, 'pending')))
            self.ingress.journal.add(request, window, RUN)
            self.ingress.peers.append(SimpleNamespace(source=source(window), request=request, path=path,
                                                      proof=live_proof(), deadline=time.monotonic() + 3600,
                                                      close=lambda: None))

    def http(self, method='tools/call', params=None, call=9):
        """An authenticated original-native HTTP peer that sent one request."""
        server, client = socket.socketpair()
        self.test.addCleanup(server.close)
        self.test.addCleanup(client.close)
        client.settimeout(1)
        server.setblocking(False)
        peer = HttpPeer(self.ingress, server)
        peer.source, peer.proof = source(self.window), live_proof()
        peer.authenticate = lambda: None
        body = json.dumps({'jsonrpc': '2.0', 'id': call, 'method': method,
                           'params': SUBMIT if params is None else params}).encode()
        client.sendall(b'POST /mcp HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: '
                       + str(len(body)).encode() + b'\r\n\r\n' + body)
        self.ingress.peers.append(peer)
        return peer, client

    def answer(self, client):
        raw = b''
        while b'\r\n\r\n' not in raw or len(raw.split(b'\r\n\r\n', 1)[1]) < int(
                raw.split(b'Content-Length: ')[1].split(b'\r\n')[0]):
            part = client.recv(16384)
            self.test.assertTrue(part, 'peer closed without an answer')
            raw += part
        headers, body = raw.split(b'\r\n\r\n', 1)
        self.test.assertTrue(headers.startswith(b'HTTP/1.1 200 OK'))
        return json.loads(body)

    def claims(self):
        return sorted(path.stem for path in self.directory.glob('*.json'))


class Configuration(unittest.TestCase):
    def test_defaults_and_closed_bounded_overrides(self):
        self.assertEqual(limits(), budget.DEFAULTS)
        self.assertEqual(budget.DEFAULTS['window_in_flight_max'], 16)
        self.assertEqual(budget.DEFAULTS['window_requests_max'], 2000)
        self.assertEqual(limits({'window_in_flight_max': 4})['window_in_flight_max'], 4)
        for bad in ([], {'window_in_flight_max': 0}, {'window_in_flight_max': 33},
                    {'window_requests_max': 31}, {'window_requests_max': 10001},
                    {'window_requests_per_minute': True}, {'window_request_burst': 2.0},
                    {'native_http_request_burst': '60'}, {'lifetime_requests_max': 5}):
            with self.subTest(bad=bad), self.assertRaisesRegex(Refused, 'managed_limits_configuration'):
                limits(bad)

    def test_ingress_and_manifest_use_the_selected_limits(self):
        f = Fixture(self, {'managed_limits': {'window_in_flight_max': 3, 'window_requests_per_minute': 12}})
        from codex_service.managed_http import discovery
        value = discovery(f.ingress, {'conversation_id': str(uuid.UUID(int=2)), 'provider': 'codex'})
        self.assertEqual(value['limits']['operations_in_flight_per_window_max'], 3)
        self.assertEqual(value['limits']['operation_requests_per_window_per_minute'], 12)
        self.assertEqual(value['limits']['operation_requests_per_window_max'], 2000)


class AdmissionLimits(unittest.TestCase):
    def test_in_flight_bound_counts_waiting_calls_not_lifetime(self):
        admission = Admission(limits())
        for n in range(16):
            admission.admit('w', n, 0, now=n)  # one at a time, below burst
        with self.assertRaises(Busy) as refused:
            admission.admit('w', 16, 16, now=17)
        self.assertEqual(refused.exception.refusal['reason'], 'managed_window_busy')
        self.assertEqual(refused.exception.refusal['limit'], 'window_in_flight_max')
        self.assertEqual(refused.exception.refusal['status'], 429)
        self.assertEqual(refused.exception.refusal['retry_after_s'], budget.IN_FLIGHT_RETRY_S)
        # Thirty-two completed calls (the old lifetime bound) are no reason to refuse.
        admission.admit('w', 0, 32, now=100)
        admission.admit('w', 15, 33, now=101)

    def test_default_pace_admits_waves_of_sixteen_parallel_calls(self):
        admission = Admission(limits())
        claims = 0
        for wave in range(3):  # Three waves of 16 short parallel calls, one a second.
            for in_flight in range(16):
                admission.admit('w', in_flight, claims, now=wave)
                claims += 1
        with self.assertRaises(Busy) as refused:  # A sustained flood still meets the pace.
            for in_flight in range(16):
                admission.admit('w', in_flight, claims, now=3)
                claims += 1
        self.assertEqual(refused.exception.refusal['limit'], 'window_requests_per_minute')

    def test_pace_refuses_with_retry_after_and_recovers(self):
        admission = Admission(limits({'window_requests_per_minute': 60, 'window_request_burst': 5}))
        for _ in range(5):
            admission.admit('w', 0, 0, now=10)
        with self.assertRaises(Busy) as refused:
            admission.admit('w', 0, 5, now=10)
        value = refused.exception.refusal
        self.assertEqual((value['reason'], value['limit'], value['status']),
                         ('managed_window_busy', 'window_requests_per_minute', 429))
        self.assertTrue(value['retryable'])
        self.assertEqual(value['retry_after_s'], 1)  # 60 a minute: the next token in one second.
        with self.assertRaises(Busy):
            admission.admit('w', 0, 5, now=10.5)
        admission.admit('w', 0, 5, now=11)
        admission.admit('other', 0, 0, now=11)  # Windows have separate buckets.
        # A long pause refills at most the burst.
        for _ in range(5):
            admission.admit('w', 0, 6, now=1000)
        with self.assertRaises(Busy):
            admission.admit('w', 0, 11, now=1000)

    def test_slow_pace_names_the_whole_wait(self):
        admission = Admission(limits({'window_requests_per_minute': 6, 'window_request_burst': 1}))
        admission.admit('w', 0, 0, now=0)
        with self.assertRaises(Busy) as refused:
            admission.admit('w', 0, 1, now=1)
        self.assertEqual(refused.exception.refusal['retry_after_s'], 9)

    def test_a_refused_call_takes_no_token(self):
        admission = Admission(limits({'window_request_burst': 1}))
        for _ in range(3):
            with self.assertRaises(Busy):
                admission.admit('w', 16, 0, now=0)
        admission.admit('w', 0, 0, now=0)

    def test_backstop_is_lasting_and_checked_first(self):
        admission = Admission(limits())
        with self.assertRaises(Busy) as refused:
            admission.admit('w', 8, 2000, now=0)
        value = refused.exception.refusal
        self.assertEqual((value['reason'], value['limit'], value['status'], value['retryable']),
                         ('managed_window_budget_exhausted', 'window_requests_max', 409, False))
        self.assertIsNone(value['retry_after_s'])
        admission.admit('w', 0, 1999, now=0)

    def test_native_http_pace(self):
        admission = Admission(limits({'native_http_requests_per_minute': 120, 'native_http_request_burst': 3}))
        record = {}
        self.assertEqual([admission.native(record, now=0) for _ in range(3)], [None] * 3)
        busy = admission.native(record, now=0)
        self.assertEqual((busy.refusal['reason'], busy.refusal['status'], busy.refusal['retry_after_s']),
                         ('managed_native_busy', 429, 1))
        self.assertIsNone(admission.native(record, now=0.5))
        self.assertIsNotNone(admission.native(record, now=0.5))
        self.assertIsNone(admission.native({}, now=0.5))  # Each native has its own pace.

    def test_buckets_and_reports_of_closed_windows_are_dropped(self):
        admission = Admission(limits(), stream=io.StringIO())
        admission.admit('held', 0, 0, now=0)
        admission.admit('closed', 0, 0, now=0)
        admission.report({'window_id': 'closed'}, 'worker_status', 'refused', refusal(Refused('x'), 'refused'), now=0)
        admission.prune({'held'})
        self.assertEqual(set(admission.windows), {'held'})
        self.assertFalse(admission.reports)


class Answers(unittest.TestCase):
    def test_fixed_refusal_categories_only(self):
        self.assertEqual(refusal(Refused('managed_no_consumed_run'), 'refused')['reason'], 'managed_no_consumed_run')
        self.assertEqual(refusal(Refused('managed_no_consumed_run'), 'refused')['status'], 403)
        self.assertEqual(refusal(Refused('Some /private/path text'), 'refused')['reason'], 'managed_refused')
        self.assertEqual(refusal(OSError('/private/path'), 'refused')['reason'], 'managed_internal_error')
        self.assertEqual(refusal(OSError('/private/path'), 'refused')['status'], 500)
        self.assertEqual(refusal(Refused('managed_call_deadline'), 'unknown')['status'], 504)
        unknown = refusal(Refused('managed_window_closed'), 'unknown')
        self.assertFalse(unknown['retryable'])
        self.assertIn('do not repeat', unknown['message'])
        for value in (unknown, refusal(Busy('managed_window_busy', 'window_in_flight_max', 429, 2), 'refused')):
            self.assertEqual(value['kind'], 'managed_refusal')
            self.assertNotIn('result', value)

    def test_argument_bounds_say_which_bound_and_that_it_is_no_permission_decision(self):
        # EasyLab 2026-11-22: a 6.7 KB host.exec summary read as a permission refusal.
        size = refusal(Refused('managed_submit_text'), 'refused')
        self.assertEqual((size['reason'], size['status'], size['retryable']), ('managed_submit_text', 400, False))
        for part in ('4096 bytes', 'Nothing was executed', 'not a permission or policy decision', 'split'):
            self.assertIn(part, size['message'])
        fields = refusal(Refused('managed_submit_fields'), 'refused')
        self.assertEqual(fields['status'], 400)
        self.assertIn('action, resource and summary', fields['message'])
        # Other refusals keep the generic text; an unknown outcome never reads as a size check.
        self.assertEqual(refusal(Refused('managed_no_consumed_run'), 'refused')['message'], STATE_MESSAGES['refused'])
        late = refusal(Refused('managed_submit_text'), 'unknown')
        self.assertEqual((late['status'], late['message']), (502, STATE_MESSAGES['unknown']))

    def test_reports_are_paced_per_window_and_reason_and_lasting_ones_alert(self):
        log = io.StringIO()
        admission = Admission(limits(), stream=log)
        scope = {'window_id': 'w', 'window_generation': 3}
        busy = Busy('managed_window_busy', 'window_in_flight_max', 429, 2).refusal
        for n in range(5):
            admission.report(scope, 'root_request_submit', 'refused', busy, now=n)
        admission.report(scope, 'root_request_submit', 'refused', busy, now=61)
        lines = log.getvalue().splitlines()
        self.assertEqual(len(lines), 2)
        self.assertTrue(lines[0].startswith('manager managed_refusal reason=managed_window_busy'))
        self.assertIn('window=w generation=3 operation=root_request_submit retry_after_s=2 refusals=1', lines[0])
        self.assertIn('refusals=5', lines[1])
        exhausted = Busy('managed_window_budget_exhausted', 'window_requests_max', 409).refusal
        admission.report(scope, 'worker_status', 'refused', exhausted, now=62)
        self.assertTrue(log.getvalue().splitlines()[-1].startswith(
            'ALERT orkestr-v2-manager managed_refusal reason=managed_window_budget_exhausted'))
        admission.report(scope, '../../not-an-operation', 'refused', busy, now=200)
        self.assertIn('operation=None', log.getvalue().splitlines()[-1])


class IngressRefusals(unittest.TestCase):
    def test_call_beyond_the_in_flight_bound_is_answered_busy_and_queues_nothing(self):
        f = Fixture(self)
        f.waiting(16)
        before = f.claims()
        peer, client = f.http()
        f.ingress.tick()
        value = f.answer(client)
        self.assertEqual(value['id'], 9)
        result = value['result']
        self.assertTrue(result['isError'])
        self.assertEqual(json.loads(result['content'][0]['text']), result['structuredContent'])
        answer = result['structuredContent']
        self.assertEqual(answer['state'], 'refused')
        self.assertEqual((answer['result']['reason'], answer['result']['status'], answer['result']['retry_after_s']),
                         ('managed_window_busy', 429, budget.IN_FLIGHT_RETRY_S))
        self.assertNotIn(peer, f.ingress.peers)
        self.assertEqual(f.claims(), before)
        self.assertEqual(f.ingress.journal.count(f.window), 16)
        self.assertIn('reason=managed_window_busy limit=window_in_flight_max status=429', f.log.getvalue())

    def test_other_windows_and_exact_retries_are_not_blocked_by_a_busy_window(self):
        f = Fixture(self)
        f.waiting(15)
        request = {'version': 1, 'request_key': 'k', 'operation': 'worker_status', 'arguments': {}}
        last = SimpleNamespace(source=source(f.window), proof=live_proof(), deadline=time.monotonic() + 60)
        f.ingress._record(last, request)
        f.ingress.peers.append(last)
        self.assertEqual(f.ingress.in_flight(f.window), 16)
        with self.assertRaisesRegex(Refused, 'managed_window_busy'):
            f.ingress._record(SimpleNamespace(source=source(f.window)), {**request, 'request_key': 'new'})
        # An exact retry finds its own claim; it is never a new admission.
        retry = SimpleNamespace(source=dict(last.source))
        f.ingress._record(retry, request)
        self.assertEqual(retry.path, last.path)
        other = str(uuid.uuid4())
        f.ingress.manager.windows[other] = None
        caller = SimpleNamespace(source=source(other))
        f.ingress._record(caller, request)
        self.assertEqual((f.ingress.journal.count(other), f.ingress.journal.count(f.window)), (1, 16))

    def test_call_after_a_completed_call_is_admitted_when_slots_free(self):
        f = Fixture(self)
        for _ in range(40):  # Forty completed calls: more than the old lifetime bound.
            request = str(uuid.uuid4())
            (f.directory / (request + '.json')).write_text(json.dumps(claim(request, f.window, 'completed')))
            f.ingress.journal.add(request, f.window, RUN, settled=True)
        f.ingress.admission.windows.clear()
        peer, client = f.http()
        f.ingress.tick()
        self.assertIn(peer, f.ingress.peers)
        self.assertEqual(metadata(peer.path)['state'], 'pending')
        self.assertEqual(f.ingress.journal.count(f.window), 41)

    def test_pace_refusal_names_retry_after(self):
        f = Fixture(self, {'managed_operations': True,
                           'managed_limits': {'window_requests_per_minute': 6, 'window_request_burst': 1}})
        first, _ = f.http(call=1)
        f.ingress.tick()
        self.assertIsNotNone(first.request)
        _, client = f.http(call=2)
        f.ingress.tick()
        answer = f.answer(client)['result']['structuredContent']['result']
        self.assertEqual((answer['reason'], answer['limit']), ('managed_window_busy', 'window_requests_per_minute'))
        self.assertGreaterEqual(answer['retry_after_s'], 9)
        self.assertEqual(f.ingress.journal.count(f.window), 1)

    def test_exhausted_window_budget_is_a_lasting_409_and_an_alert(self):
        f = Fixture(self, {'managed_operations': True, 'managed_limits': {'window_requests_max': 32}})
        for _ in range(32):
            request = str(uuid.uuid4())
            (f.directory / (request + '.json')).write_text(json.dumps(claim(request, f.window, 'completed')))
            f.ingress.journal.add(request, f.window, RUN, settled=True)
        _, client = f.http()
        f.ingress.tick()
        answer = f.answer(client)['result']['structuredContent']
        self.assertEqual(answer['state'], 'refused')
        self.assertEqual((answer['result']['reason'], answer['result']['status'], answer['result']['retryable']),
                         ('managed_window_budget_exhausted', 409, False))
        self.assertIn('ALERT orkestr-v2-manager managed_refusal reason=managed_window_budget_exhausted',
                      f.log.getvalue())
        self.assertEqual(f.ingress.journal.count(f.window), 32)

    def test_other_refusals_are_answered_instead_of_closing_the_peer(self):
        f = Fixture(self)

        def no_run(peer):
            raise Refused('managed_no_consumed_run')
        f.ingress.runs.attach = no_run
        _, client = f.http()
        f.ingress.tick()
        answer = f.answer(client)['result']['structuredContent']
        self.assertEqual((answer['state'], answer['result']['reason'], answer['result']['status']),
                         ('refused', 'managed_no_consumed_run', 403))
        self.assertFalse(f.claims())
        # Invalid arguments of a Root submission are refused the same way.
        _, client = f.http(params={'name': 'orkestr_root_request_submit',
                                   'arguments': {'action': 'read', 'resource': 'x', 'summary': '\0'}})
        f.ingress.tick()
        self.assertEqual(f.answer(client)['result']['structuredContent']['result']['reason'], 'managed_submit_text')

    def test_native_pace_is_answered_for_tool_calls_and_other_requests(self):
        f = Fixture(self)
        peer, client = f.http()
        peer.busy = Busy('managed_native_busy', 'native_http_requests_per_minute', 429, 3)
        f.ingress.tick()
        answer = f.answer(client)['result']['structuredContent']['result']
        self.assertEqual((answer['reason'], answer['retry_after_s']), ('managed_native_busy', 3))
        self.assertFalse(f.claims())
        peer, client = f.http(method='tools/list', params={})
        peer.busy = Busy('managed_native_busy', 'native_http_requests_per_minute', 429, 3)
        f.ingress.tick()
        error = f.answer(client)['error']
        self.assertEqual((error['code'], error['message']), (-32000, 'managed_native_busy'))
        self.assertEqual(error['data']['state'], 'refused')

    def test_first_authentication_takes_one_pace_token_per_connection(self):
        f = Fixture(self, {'managed_operations': True, 'managed_limits': {'native_http_request_burst': 2}})
        record = {}
        f.ingress.natives = SimpleNamespace(actor=lambda pid: record, prune=lambda: None)
        identity = process(os.getpid())
        peers = []
        for _ in range(3):
            server, client = socket.socketpair()
            self.addCleanup(server.close)
            self.addCleanup(client.close)
            peer = HttpPeer(f.ingress, server)
            with patch('codex_service.managed_http.socket_owner', return_value=identity), \
                 patch('codex_service.managed_http.source', return_value=(source(f.window), live_proof())):
                peer.authenticate()
                peer.authenticate()  # A recheck takes no token.
            peers.append(peer)
        self.assertEqual([p.busy is None for p in peers], [True, True, False])
        self.assertEqual(peers[2].busy.refusal['reason'], 'managed_native_busy')

    def test_unauthenticated_peer_is_still_closed_without_an_answer(self):
        f = Fixture(self)
        peer, client = f.http()
        peer.proof = None
        peer.registration_deadline = 0

        def refused():
            raise Refused('managed_http_original_native_owner')
        peer.authenticate = refused
        f.ingress.tick()
        self.assertNotIn(peer, f.ingress.peers)
        try:
            self.assertEqual(client.recv(16384), b'')
        except ConnectionResetError:
            pass  # Closed with the unread request still buffered: no answer either way.
        self.assertEqual(f.log.getvalue(), '')

    def test_a_claimed_call_past_its_deadline_is_answered_unknown(self):
        f = Fixture(self)
        peer, client = f.http()
        f.ingress.tick()
        self.assertEqual(metadata(peer.path)['state'], 'pending')
        peer.deadline = 0
        f.ingress.tick()
        answer = f.answer(client)['result']['structuredContent']
        self.assertEqual((answer['state'], answer['result']['reason'], answer['result']['status']),
                         ('unknown', 'managed_call_deadline', 504))
        self.assertNotIn('result_sent', metadata(peer.path))
        self.assertEqual(metadata(peer.path)['state'], 'unknown')

    def test_a_peer_is_answered_once(self):
        f = Fixture(self)
        peer, client = f.http(method='ping', params={})
        f.ingress.tick()
        self.assertEqual(f.answer(client)['result'], {})
        peer.refuse('refused', refusal(Refused('managed_late'), 'refused'))
        self.assertEqual(client.recv(16384), b'')

    def test_manager_stop_answers_waiting_callers(self):
        f = Fixture(self)
        peer, client = f.http()
        f.ingress.tick()
        f.ingress.close()
        answer = f.answer(client)['result']['structuredContent']
        self.assertEqual((answer['state'], answer['result']['reason']), ('unknown', 'managed_manager_stopping'))
        self.assertEqual(metadata(peer.path)['state'], 'unknown')

    def test_socket_caller_gets_a_refused_reply_the_cli_accepts(self):
        left, right = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        self.addCleanup(right.close)
        peer = SocketPeer.__new__(SocketPeer)
        peer.connection, peer.path, peer.request, peer.answered = left, None, None, False
        peer.received = {'version': 1, 'request_key': 'synthetic', 'operation': 'root_request_submit',
                         'arguments': SUBMIT['arguments']}
        peer.refuse('refused', Busy('managed_window_busy', 'window_in_flight_max', 429, 2).refusal)
        value = json.loads(right.recv(16384))
        self.assertEqual(set(value), {'version', 'request_key', 'request_id', 'state', 'result'})
        self.assertEqual((value['state'], value['request_key'], value['request_id']), ('refused', 'synthetic', None))
        self.assertEqual(value['result']['reason'], 'managed_window_busy')
        peer.refuse('refused', value['result'])
        right.setblocking(False)
        with self.assertRaises(BlockingIOError):
            right.recv(16384)
        left.close()


@unittest.skipUnless(os.geteuid() == 0, 'Root-owned managed socket endpoint')
class CliRefusal(unittest.TestCase):
    def test_cli_returns_the_refusal_instead_of_an_unknown_transport(self):
        import threading
        from codex_service import managed_client
        with tempfile.TemporaryDirectory(prefix='managed-cli-refusal-') as directory:
            path = Path(directory) / 'managed.sock'
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
            listener.bind(str(path))
            listener.listen()
            request = {'version': 1, 'request_key': 'synthetic', 'operation': 'root_request_submit',
                       'arguments': SUBMIT['arguments']}

            def serve():
                connection, _ = listener.accept()
                with connection:
                    connection.recv(16384)
                    connection.send(canonical({'version': 1, 'request_key': 'synthetic', 'request_id': None,
                        'state': 'refused',
                        'result': Busy('managed_window_busy', 'window_in_flight_max', 429, 2).refusal}))
            thread = threading.Thread(target=serve)
            thread.start()
            try:
                with patch.object(managed_client, 'endpoint', return_value=(0, 0)):
                    value = managed_client.exchange(path, canonical(request))
            finally:
                thread.join(5)
                listener.close()
        self.assertEqual(value['state'], 'refused')
        self.assertEqual(value['result']['retry_after_s'], 2)


if __name__ == '__main__':
    unittest.main()
