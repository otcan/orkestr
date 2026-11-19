import hashlib
import importlib.util
import json
from pathlib import Path
import socket
import struct
import subprocess
import tempfile
import threading
import unittest
import unittest.mock
from unittest.mock import patch
import uuid
import zlib

BASE = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, BASE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FramebufferTests(unittest.TestCase):
    def test_png_preserves_rgb_and_checksums(self):
        module = load('desktop_framebuffer')
        data = module.png(bytes([3, 2, 1, 0, 6, 5, 4, 0]), 2, 1)
        self.assertEqual(data[:8], b'\x89PNG\r\n\x1a\n')
        offset = 8
        compressed = b''
        while offset < len(data):
            size = struct.unpack_from('>I', data, offset)[0]
            kind = data[offset + 4:offset + 8]
            raw = data[offset + 8:offset + 8 + size]
            crc = struct.unpack_from('>I', data, offset + 8 + size)[0]
            self.assertEqual(crc, zlib.crc32(kind + raw))
            if kind == b'IDAT':
                compressed += raw
            offset += size + 12
        self.assertEqual(zlib.decompress(compressed), b'\0\x01\x02\x03\x04\x05\x06')

    def test_actual_rfb_frames_send_native_click_and_keys_then_capture(self):
        module = load('desktop_framebuffer')
        client, server = socket.socketpair()
        server.settimeout(3)
        observed, errors = [], []
        def read(size):
            data = b''
            while len(data) < size:
                part = server.recv(size - len(data))
                if not part:
                    raise ValueError('closed')
                data += part
            return data
        def peer():
            try:
                server.sendall(b'RFB 003.008\n')
                self.assertEqual(read(12), b'RFB 003.008\n')
                server.sendall(b'\x01\x01')
                self.assertEqual(read(1), b'\x01')
                server.sendall(b'\0' * 4)
                self.assertEqual(read(1), b'\x01')  # Shared desktop remains open.
                server.sendall(struct.pack('>HH', 2, 1) + b'\0' * 16 + struct.pack('>I', 0))
                read(20)
                read(8)
                observed.extend([read(6), read(6), read(8), read(8), read(8), read(8)])
                self.assertEqual(read(10), struct.pack('>BBHHHH', 3, 0, 0, 0, 2, 1))
                server.sendall(b'\0\0\0\x01' + struct.pack('>HHHHi', 0, 0, 2, 1, 0) + b'\xff' * 8)
            except BaseException as error:
                errors.append(error)
            finally:
                server.close()
        thread = threading.Thread(target=peer)
        thread.start()
        try:
            with patch.object(module.socket, 'create_connection', return_value=client):
                desktop = module.Desktop(5900)
            desktop.initialize()
            desktop.pointer(1, 0, 1)
            desktop.key('Down')
            desktop.text('A')
            self.assertTrue(desktop.screenshot().startswith(b'\x89PNG'))
        finally:
            client.close()
            thread.join(timeout=4)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(observed[:2], [struct.pack('>BBHH', 5, 1, 1, 0), struct.pack('>BBHH', 5, 0, 1, 0)])
        self.assertEqual(observed[2:4], [struct.pack('>BBHI', 4, 1, 0, 0xff54), struct.pack('>BBHI', 4, 0, 0, 0xff54)])
        self.assertEqual(observed[4:], [struct.pack('>BBHI', 4, 1, 0, 65), struct.pack('>BBHI', 4, 0, 0, 65)])

    def test_invalid_input_cannot_send_frames(self):
        module = load('desktop_framebuffer')
        desktop = object.__new__(module.Desktop)
        desktop.width, desktop.height = 100, 80
        with patch.object(desktop, 'write') as write:
            for call in [lambda: desktop.pointer(-1, 0), lambda: desktop.pointer(0, 80),
                         lambda: desktop.key('invalid'), lambda: desktop.text('password\n')]:
                with self.assertRaises(ValueError):
                    call()
            write.assert_not_called()


class ControllerTests(unittest.TestCase):
    def test_operate_permission_is_exact_current_and_required(self):
        module = load('desktop_control')
        config = {'desktop_slug': 'desk-a', 'v1_thread_id': 'thread-a'}
        valid = {'desktopSlug': 'desk-a', 'threadId': 'thread-a',
                 'permissions': ['acquire', 'operate'], 'revokedAt': None, 'expiresAt': None}
        module.authorize_permissions([valid], config)
        for change in [{'desktopSlug': 'desk-b'}, {'threadId': 'thread-b'},
                       {'permissions': ['acquire']}, {'revokedAt': '2020-01-01T00:00:00Z'},
                       {'expiresAt': '2020-01-01T00:00:00Z'}]:
            with self.assertRaisesRegex(ValueError, 'operate_not_granted'):
                module.authorize_permissions([{**valid, **change}], config)

    def test_changed_framebuffer_refuses_input_before_heartbeat(self):
        module = load('desktop_control')
        session, request = str(uuid.uuid4()), str(uuid.uuid4())
        state = {'session_id': session, 'state': 'active', 'conversation_id': 'conversation-a',
                 'desktop_slug': 'desk-a', 'target': {'pid': 41}, 'fencing_token': 'synthetic'}
        with tempfile.TemporaryDirectory() as temporary:
            (Path(temporary) / ('session-' + session + '.json')).write_text(json.dumps(state))
            config = {'state_directory': temporary, 'conversation_id': 'conversation-a', 'desktop_slug': 'desk-a'}
            with patch.object(module, 'read', side_effect=lambda p: Path(p).read_bytes()), \
                 patch.object(module, 'framebuffer_identity', return_value={'pid': 42}), patch.object(module, 'Lease') as lease:
                with self.assertRaisesRegex(ValueError, 'session_or_target_changed'):
                    module.execute(config, 'key', ['Return'], session, request)
                lease.return_value.call.assert_not_called()

    def test_unknown_action_intent_is_never_repeated(self):
        module = load('desktop_control')
        request, session = str(uuid.uuid4()), str(uuid.uuid4())
        fingerprint = hashlib.sha256(json.dumps(['key', ['Return'], session], separators=(',', ':')).encode()).hexdigest()
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / ('request-' + request + '.json')
            path.write_text(json.dumps({'state': 'intent', 'fingerprint': fingerprint}))
            with patch.object(module, 'read', side_effect=lambda p: Path(p).read_bytes()), patch.object(module, 'Lease') as lease:
                with self.assertRaisesRegex(ValueError, 'outcome_unknown_no_retry'):
                    module.execute({'state_directory': temporary}, 'key', ['Return'], session, request)
                lease.assert_not_called()

    def test_completed_request_returns_original_result_without_input(self):
        module = load('desktop_control')
        request, session = str(uuid.uuid4()), str(uuid.uuid4())
        fingerprint = hashlib.sha256(json.dumps(['key', ['Return'], session], separators=(',', ':')).encode()).hexdigest()
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / ('request-' + request + '.json')
            path.write_text(json.dumps({'state': 'complete', 'fingerprint': fingerprint, 'result': {'ok': True}}))
            with patch.object(module, 'read', side_effect=lambda p: Path(p).read_bytes()), patch.object(module, 'Lease') as lease:
                self.assertEqual(module.execute({'state_directory': temporary}, 'key', ['Return'], session, request),
                                 {'ok': True, 'duplicate': True})
                lease.assert_not_called()

    def test_malformed_actions_are_rejected_before_lease_access(self):
        module = load('desktop_control')
        for operation, values in [('click', ['1', '2', '0']), ('move', ['99999', '0']),
                                  ('key', ['Return; command']), ('type', ['hidden\ntext']), ('start', ['target'])]:
            with self.assertRaises(ValueError):
                module.argument_shape(operation, values)


DESCRIPTOR = {
    'format': 'orkestr-desktop-control-v1', 'v2_url': 'http://127.0.0.1:19822',
    'conversation_id': '11111111-1111-4111-8111-111111111111',
    'v1_thread_id': '22222222-2222-4222-8222-222222222222', 'desktop_slug': 'desk-a',
    'grant_file': '/etc/example/grant.env', 'broker_file': '/var/lib/example/broker.json', 'broker_uid': 1001,
    'framebuffer_port': 15900, 'framebuffer_unit': 'desk-a-x11vnc.service',
    'state_directory': '/var/lib/example/state', 'output_directory': '/var/lib/example/images',
    'output_uid': 1002, 'output_gid': 1002}
LEASE = {'v1_thread_id': DESCRIPTOR['v1_thread_id'], 'fencing_version': 7}


def child(stdout='', code=0, timeout=False):
    process = unittest.mock.Mock(pid=4242, returncode=code)
    if timeout:
        process.communicate.side_effect = [subprocess.TimeoutExpired('desk-ensure', 1), ('', None)]
    else:
        process.communicate.return_value = (stdout, None)
    return process


class DeskEnsureTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.program = Path(self.directory.name) / 'desk-ensure'
        self.program.write_text('#!/bin/false\n')
        self.program.chmod(0o755)
        self.entry = {'path': str(self.program), 'sha256': hashlib.sha256(self.program.read_bytes()).hexdigest()}
        self.config = {**DESCRIPTOR, 'desk_ensure': self.entry}

    def tearDown(self):
        self.directory.cleanup()

    def configure(self, module, value):
        with patch.object(module, 'read', return_value=json.dumps(value).encode()), \
             patch.object(module, 'protected', side_effect=lambda path, directory=False: Path(path)):
            return module.configuration('/etc/example/descriptor.json')

    def run_ensure(self, module, process, lease=LEASE, budget_ms=30000):
        with patch.object(module, 'protected', side_effect=Path), \
             patch.object(module.subprocess, 'Popen', return_value=process) as popen, \
             patch.object(module.os, 'killpg') as killpg, \
             patch.dict(module.os.environ, {'ORKESTR_V2_DESKTOP_GRANT': 'f' * 64}):
            try:
                module.run_desk_ensure(self.config, lease, budget_ms)
                return popen, killpg, None
            except ValueError as error:
                return popen, killpg, str(error)

    def test_descriptor_checks_the_desk_ensure_shape_but_not_its_file(self):
        module = load('desktop_control')
        self.assertNotIn('desk_ensure', self.configure(module, DESCRIPTOR))
        self.assertEqual(self.configure(module, self.config)['desk_ensure'], self.entry)
        # A changed or missing program must not block status or release of a live session.
        self.assertEqual(self.configure(module, {**DESCRIPTOR, 'desk_ensure': {'path': '/missing', 'sha256': '0' * 64}})
                         ['desk_ensure']['path'], '/missing')
        for entry in [str(self.program), {**self.entry, 'sha256': 'A' * 64}, {**self.entry, 'extra': 1},
                      {'path': 7, 'sha256': '0' * 64}]:
            with self.assertRaisesRegex(ValueError, 'desk_ensure_invalid'):
                self.configure(module, {**DESCRIPTOR, 'desk_ensure': entry})
        with self.assertRaisesRegex(ValueError, 'controller_configuration'):
            self.configure(module, {**DESCRIPTOR, 'unexpected': True})

    def test_desk_ensure_gets_desk_thread_and_version_but_no_grant_or_token(self):
        module = load('desktop_control')
        popen, killpg, error = self.run_ensure(module, child('{"ok":true,"started":true}\n'), budget_ms=30000)
        self.assertIsNone(error)
        argv, options = popen.call_args
        self.assertEqual(argv[0], [str(self.program), '--slug', 'desk-a', '--budget-ms', '30000'])
        env = options['env']
        self.assertEqual((env['ORKESTR_DESKTOP_SLUG'], env['ORKESTR_DESKTOP_THREAD_ID'],
                          env['ORKESTR_DESKTOP_FENCING_VERSION']), ('desk-a', LEASE['v1_thread_id'], '7'))
        self.assertFalse({'ORKESTR_V2_DESKTOP_GRANT', 'ORKESTR_DESKTOP_FENCING_TOKEN'} & set(env))
        self.assertEqual((options['cwd'], options['start_new_session']), ('/', True))
        killpg.assert_not_called()

    def test_changed_or_non_executable_desk_ensure_is_never_run(self):
        module = load('desktop_control')
        self.program.write_text('#!/bin/true\n')
        popen, _killpg, error = self.run_ensure(module, child('{"ok":true}'))
        self.assertEqual(error, 'controller_desk_ensure_changed')
        popen.assert_not_called()
        self.program.write_text('#!/bin/false\n')
        self.program.chmod(0o644)
        popen, _killpg, error = self.run_ensure(module, child('{"ok":true}'))
        self.assertEqual(error, 'controller_desk_ensure_invalid')
        popen.assert_not_called()

    def test_desk_ensure_failures_and_foreign_leases_become_safe_reason_codes(self):
        module = load('desktop_control')
        cases = [('{"ok":false,"error":"desk_start_refused","reason":"no_active_lease_for_caller"}', 69,
                  'controller_desk_start_refused'),
                 ('{"ok":false,"error":"Bad; value"}', 69, 'controller_desk_start_failed'),
                 ('not json', 0, 'controller_desk_start_failed'),
                 ('{"ok":true}', 1, 'controller_desk_start_failed')]
        for stdout, code, reason in cases:
            self.assertEqual(self.run_ensure(module, child(stdout, code))[2], reason)
        for lease in [None, {**LEASE, 'v1_thread_id': 'other'}, {**LEASE, 'fencing_version': '7'}]:
            popen, _killpg, error = self.run_ensure(module, child('{"ok":true}'), lease=lease)
            self.assertEqual(error, 'controller_lease_response_invalid')
            popen.assert_not_called()

    def test_overrunning_desk_ensure_has_its_whole_process_group_killed(self):
        module = load('desktop_control')
        _popen, killpg, error = self.run_ensure(module, child(timeout=True))
        self.assertEqual(error, 'controller_desk_start_timeout')
        killpg.assert_called_once_with(4242, module.signal.SIGKILL)

    def test_stopped_desk_is_started_once_with_the_time_left_and_awaited(self):
        module = load('desktop_control')
        steps = [ValueError('controller_framebuffer_inactive'), ValueError('controller_listener_not_owned'),
                 {'pid': 42}]
        with patch.object(module, 'framebuffer_identity', side_effect=steps), \
             patch.object(module, 'run_desk_ensure') as ensure:
            pauses = []
            self.assertEqual(module.ensure_framebuffer(DESCRIPTOR, LEASE, 50.0, clock=lambda: 0.0,
                                                       pause=pauses.append), {'pid': 42})
        ensure.assert_called_once_with(DESCRIPTOR, LEASE, 30000)
        self.assertEqual(pauses, [0.5])
        with patch.object(module, 'framebuffer_identity', side_effect=steps[:1] + [{'pid': 42}]), \
             patch.object(module, 'run_desk_ensure') as ensure:
            module.ensure_framebuffer(DESCRIPTOR, LEASE, 500.0, clock=lambda: 0.0)
        ensure.assert_called_once_with(DESCRIPTOR, LEASE, module.DESK_ENSURE_BUDGET_MS)

    def test_too_little_time_left_never_runs_desk_ensure(self):
        module = load('desktop_control')
        with patch.object(module, 'framebuffer_identity', side_effect=ValueError('controller_framebuffer_inactive')), \
             patch.object(module, 'run_desk_ensure') as ensure:
            with self.assertRaisesRegex(ValueError, 'start_budget_exhausted'):
                module.ensure_framebuffer(DESCRIPTOR, LEASE, 24.0, clock=lambda: 0.0)
        ensure.assert_not_called()

    def test_running_or_foreign_framebuffer_never_runs_desk_ensure(self):
        module = load('desktop_control')
        for outcome in [{'pid': 42}, ValueError('controller_network_namespace')]:
            with patch.object(module, 'framebuffer_identity', side_effect=[outcome]), \
                 patch.object(module, 'run_desk_ensure') as ensure:
                if isinstance(outcome, dict):
                    self.assertEqual(module.ensure_framebuffer(DESCRIPTOR, LEASE, 80.0, clock=lambda: 0.0), outcome)
                else:
                    with self.assertRaisesRegex(ValueError, 'network_namespace'):
                        module.ensure_framebuffer(DESCRIPTOR, LEASE, 80.0, clock=lambda: 0.0)
                ensure.assert_not_called()

    def test_framebuffer_that_never_settles_fails_after_the_deadline(self):
        module = load('desktop_control')
        times = iter([0.0, 0.0, 5.0, 11.0])
        with patch.object(module, 'framebuffer_identity', side_effect=ValueError('controller_framebuffer_inactive')), \
             patch.object(module, 'run_desk_ensure'):
            with self.assertRaisesRegex(ValueError, 'framebuffer_inactive'):
                module.ensure_framebuffer(DESCRIPTOR, LEASE, 80.0, clock=lambda: next(times), pause=lambda _s: None)


class StartLifecycleTests(unittest.TestCase):
    """A start never sends input, so every failure after its acquire releases the lease."""

    def run_start(self, temporary, ensure, config_extra, identity=None):
        module = load('desktop_control')
        config = {**DESCRIPTOR, 'state_directory': temporary, **config_extra}
        request = str(uuid.uuid4())
        order = unittest.mock.Mock()
        lease = order.lease
        lease.call.side_effect = lambda operation, body=None: (
            {'fencing_token': 'synthetic-token', 'lease': LEASE} if operation == 'acquire' else {'ok': True})
        order.ensure.side_effect = ensure
        order.identity.side_effect = identity
        outcome = retry = None
        with patch.object(module, 'read', side_effect=lambda p: Path(p).read_bytes()), \
             patch.object(module, 'Lease', return_value=lease), \
             patch.object(module, 'ensure_framebuffer', order.ensure), \
             patch.object(module, 'framebuffer_identity', order.identity), \
             patch.object(module, 'protected', side_effect=ValueError('framebuffer_module_unavailable')):
            try:
                module.execute(config, 'start', [], '', request)
            except ValueError as error:
                outcome = str(error)
            status = module.execute(config, 'status', [], '', request)
            try:
                module.execute(config, 'start', [], '', request)
            except ValueError as error:
                retry = str(error)
        sessions = [json.loads(path.read_text()) for path in Path(temporary).glob('session-*.json')]
        return order, outcome, status, retry, sessions

    def assert_released(self, order, status, retry):
        release = order.lease.call.call_args_list[-1]
        self.assertEqual(release.args[0], 'release')
        self.assertEqual(release.args[1]['fencing_token'], 'synthetic-token')
        self.assertEqual((status['state'], status['session_id']), ('failed', None))
        self.assertEqual(retry, 'controller_request_failed_use_new_request_id')

    def test_autostart_runs_under_the_new_lease_and_a_later_capture_failure_releases_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            order, outcome, status, retry, sessions = self.run_start(
                temporary, lambda config, lease, deadline: {'pid': 42},
                {'desk_ensure': {'path': '/usr/libexec/example/desk-ensure', 'sha256': '0' * 64}})
        self.assertEqual(outcome, 'framebuffer_module_unavailable')
        names = [entry[0] for entry in order.mock_calls]
        self.assertLess(names.index('lease.call'), names.index('ensure'))
        self.assertEqual(order.lease.call.call_args_list[0].args[0], 'acquire')
        order.identity.assert_not_called()
        self.assertEqual([(s['target'], s['state']) for s in sessions], [({'pid': 42}, 'released')])
        self.assertEqual(status['error'], 'framebuffer_module_unavailable')
        self.assert_released(order, status, retry)

    def test_failed_autostart_releases_the_lease_and_records_a_definite_failure(self):
        def refuse(config, lease, deadline):
            raise ValueError('controller_desk_start_failed')
        with tempfile.TemporaryDirectory() as temporary:
            order, outcome, status, retry, sessions = self.run_start(
                temporary, refuse, {'desk_ensure': {'path': '/usr/libexec/example/desk-ensure', 'sha256': '0' * 64}})
        self.assertEqual((outcome, sessions), ('controller_desk_start_failed', []))
        self.assertEqual(status['error'], 'controller_desk_start_failed')
        self.assert_released(order, status, retry)

    def test_unconfirmed_release_leaves_the_outcome_unknown(self):
        module = load('desktop_control')
        lease = unittest.mock.Mock()
        lease.call.side_effect = OSError('broker unreachable')
        with tempfile.TemporaryDirectory() as temporary:
            journal = Path(temporary) / 'request.json'
            journal.write_text('{"state":"intent"}')
            module.abandon_start(lease, {'fencing_token': 't'}, journal, 'f', Path(temporary) / 'missing.json',
                                 ValueError('controller_desk_start_failed'))
            self.assertEqual(json.loads(journal.read_text()), {'state': 'intent'})

    def test_without_desk_ensure_a_stopped_desk_refuses_before_any_lease(self):
        def stopped(config):
            raise ValueError('controller_framebuffer_inactive')
        with tempfile.TemporaryDirectory() as temporary:
            module = load('desktop_control')
            config = {**DESCRIPTOR, 'state_directory': temporary}
            request = str(uuid.uuid4())
            with patch.object(module, 'read', side_effect=lambda p: Path(p).read_bytes()), \
                 patch.object(module, 'Lease') as lease, \
                 patch.object(module, 'framebuffer_identity', side_effect=stopped):
                with self.assertRaisesRegex(ValueError, 'framebuffer_inactive'):
                    module.execute(config, 'start', [], '', request)
                lease.return_value.call.assert_not_called()
                self.assertEqual(module.execute(config, 'status', [], '', request)['state'], 'not_recorded')

    def test_without_desk_ensure_a_failed_start_capture_also_releases_its_lease(self):
        with tempfile.TemporaryDirectory() as temporary:
            order, outcome, status, retry, sessions = self.run_start(temporary, None, {}, identity=lambda c: {'pid': 9})
        self.assertEqual(outcome, 'framebuffer_module_unavailable')
        order.ensure.assert_not_called()
        self.assertEqual([(s['target'], s['state']) for s in sessions], [({'pid': 9}, 'released')])
        self.assert_released(order, status, retry)

    def test_status_of_an_unknown_request_reports_nothing_ran(self):
        module = load('desktop_control')
        with tempfile.TemporaryDirectory() as temporary:
            self.assertEqual(module.execute({'state_directory': temporary}, 'status', [], '', str(uuid.uuid4())),
                             {'ok': True, 'state': 'not_recorded', 'session_id': None, 'result': None,
                              'automatic_retry': False})
