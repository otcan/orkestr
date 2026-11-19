import hashlib
import importlib.util
import json
from pathlib import Path
import socket
import struct
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


class DeskEnsureTests(unittest.TestCase):
    def configure(self, module, value, mode=0o755):
        executable = unittest.mock.Mock()
        executable.stat.return_value.st_mode = mode
        with patch.object(module, 'read', return_value=json.dumps(value).encode()), \
             patch.object(module, 'protected', return_value=executable):
            return module.configuration('/etc/example/descriptor.json')

    def test_descriptor_accepts_only_an_executable_desk_ensure_extra(self):
        module = load('desktop_control')
        self.assertNotIn('desk_ensure', self.configure(module, DESCRIPTOR))
        configured = self.configure(module, {**DESCRIPTOR, 'desk_ensure': '/usr/libexec/example/desk-ensure'})
        self.assertEqual(configured['desk_ensure'], '/usr/libexec/example/desk-ensure')
        for value, mode in [({**DESCRIPTOR, 'desk_ensure': ['/bin/sh']}, 0o755),
                            ({**DESCRIPTOR, 'desk_ensure': '/usr/libexec/example/desk-ensure'}, 0o644),
                            ({**DESCRIPTOR, 'unexpected': True}, 0o755)]:
            with self.assertRaises(ValueError):
                self.configure(module, value, mode)

    def test_desk_ensure_gets_desk_thread_and_version_but_no_grant_or_token(self):
        module = load('desktop_control')
        config = {**DESCRIPTOR, 'desk_ensure': '/usr/libexec/example/desk-ensure'}
        answer = unittest.mock.Mock(returncode=0, stdout='{"ok":true,"started":true}\n')
        with patch.object(module, 'protected', side_effect=Path), \
             patch.object(module.subprocess, 'run', return_value=answer) as run, \
             patch.dict(module.os.environ, {'ORKESTR_V2_DESKTOP_GRANT': 'f' * 64}):
            module.run_desk_ensure(config, LEASE)
        argv, options = run.call_args
        self.assertEqual(argv[0], ['/usr/libexec/example/desk-ensure', '--slug', 'desk-a', '--budget-ms', '45000'])
        env = options['env']
        self.assertEqual((env['ORKESTR_DESKTOP_SLUG'], env['ORKESTR_DESKTOP_THREAD_ID'],
                          env['ORKESTR_DESKTOP_FENCING_VERSION']), ('desk-a', LEASE['v1_thread_id'], '7'))
        self.assertFalse({'ORKESTR_V2_DESKTOP_GRANT', 'ORKESTR_DESKTOP_FENCING_TOKEN'} & set(env))
        self.assertEqual(options['cwd'], '/')

    def test_desk_ensure_failures_and_foreign_leases_become_safe_reason_codes(self):
        module = load('desktop_control')
        config = {**DESCRIPTOR, 'desk_ensure': '/usr/libexec/example/desk-ensure'}
        cases = [('{"ok":false,"error":"desk_start_refused","reason":"no_active_lease_for_caller"}', 69,
                  'controller_desk_start_refused'),
                 ('{"ok":false,"error":"Bad; value"}', 69, 'controller_desk_start_failed'),
                 ('not json', 0, 'controller_desk_start_failed'),
                 ('{"ok":true}', 1, 'controller_desk_start_failed')]
        for stdout, code, reason in cases:
            answer = unittest.mock.Mock(returncode=code, stdout=stdout)
            with patch.object(module, 'protected', side_effect=Path), \
                 patch.object(module.subprocess, 'run', return_value=answer):
                with self.assertRaisesRegex(ValueError, '^' + reason + '$'):
                    module.run_desk_ensure(config, LEASE)
        for lease in [None, {**LEASE, 'v1_thread_id': 'other'}, {**LEASE, 'fencing_version': '7'}]:
            with patch.object(module.subprocess, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'lease_response_invalid'):
                    module.run_desk_ensure(config, lease)
                run.assert_not_called()

    def test_stopped_desk_is_started_once_and_awaited(self):
        module = load('desktop_control')
        steps = [ValueError('controller_framebuffer_inactive'), ValueError('controller_listener_not_owned'),
                 {'pid': 42}]
        with patch.object(module, 'framebuffer_identity', side_effect=steps), \
             patch.object(module, 'run_desk_ensure') as ensure:
            pauses = []
            self.assertEqual(module.ensure_framebuffer(DESCRIPTOR, LEASE, clock=lambda: 0.0, pause=pauses.append),
                             {'pid': 42})
        ensure.assert_called_once_with(DESCRIPTOR, LEASE)
        self.assertEqual(pauses, [0.5])

    def test_running_or_foreign_framebuffer_never_runs_desk_ensure(self):
        module = load('desktop_control')
        for outcome in [{'pid': 42}, ValueError('controller_network_namespace')]:
            with patch.object(module, 'framebuffer_identity', side_effect=[outcome]), \
                 patch.object(module, 'run_desk_ensure') as ensure:
                if isinstance(outcome, dict):
                    self.assertEqual(module.ensure_framebuffer(DESCRIPTOR, LEASE), outcome)
                else:
                    with self.assertRaisesRegex(ValueError, 'network_namespace'):
                        module.ensure_framebuffer(DESCRIPTOR, LEASE)
                ensure.assert_not_called()

    def test_framebuffer_that_never_settles_fails_after_the_deadline(self):
        module = load('desktop_control')
        times = iter([0.0, 5.0, 11.0])
        with patch.object(module, 'framebuffer_identity', side_effect=ValueError('controller_framebuffer_inactive')), \
             patch.object(module, 'run_desk_ensure'):
            with self.assertRaisesRegex(ValueError, 'framebuffer_inactive'):
                module.ensure_framebuffer(DESCRIPTOR, LEASE, clock=lambda: next(times), pause=lambda _s: None)


class StartLifecycleTests(unittest.TestCase):
    def run_start(self, temporary, ensure, config_extra):
        module = load('desktop_control')
        config = {**DESCRIPTOR, 'state_directory': temporary, **config_extra}
        request = str(uuid.uuid4())
        order = unittest.mock.Mock()
        lease = order.lease
        lease.call.side_effect = lambda operation, body=None: (
            {'fencing_token': 'synthetic-token', 'lease': LEASE} if operation == 'acquire' else {'ok': True})
        order.ensure.side_effect = ensure
        with patch.object(module, 'read', side_effect=lambda p: Path(p).read_bytes()), \
             patch.object(module, 'Lease', return_value=lease), \
             patch.object(module, 'ensure_framebuffer', order.ensure), \
             patch.object(module, 'framebuffer_identity', order.identity), \
             patch.object(module, 'protected', side_effect=ValueError('stop_before_framebuffer')):
            try:
                module.execute(config, 'start', [], '', request)
            except ValueError as error:
                outcome = str(error)
            status = module.execute(config, 'status', [], '', request)
            try:
                module.execute(config, 'start', [], '', request)
            except ValueError as error:
                retry = str(error)
        return module, order, outcome, status, retry

    def test_autostart_runs_under_the_new_lease_and_pins_the_started_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            _module, order, outcome, status, _retry = self.run_start(
                temporary, lambda config, lease: {'pid': 42}, {'desk_ensure': '/usr/libexec/example/desk-ensure'})
            sessions = list(Path(temporary).glob('session-*.json'))
            self.assertEqual(len(sessions), 1)
            self.assertEqual(json.loads(sessions[0].read_text())['target'], {'pid': 42})
        self.assertEqual(outcome, 'stop_before_framebuffer')
        names = [entry[0] for entry in order.mock_calls]
        self.assertLess(names.index('lease.call'), names.index('ensure'))
        self.assertEqual(order.lease.call.call_args_list[0].args[0], 'acquire')
        order.identity.assert_not_called()
        self.assertEqual(status['state'], 'intent')

    def test_failed_autostart_releases_the_lease_and_records_a_definite_failure(self):
        def refuse(config, lease):
            raise ValueError('controller_desk_start_failed')
        with tempfile.TemporaryDirectory() as temporary:
            _module, order, outcome, status, retry = self.run_start(
                temporary, refuse, {'desk_ensure': '/usr/libexec/example/desk-ensure'})
            self.assertEqual(list(Path(temporary).glob('session-*.json')), [])
        self.assertEqual(outcome, 'controller_desk_start_failed')
        release = order.lease.call.call_args_list[-1]
        self.assertEqual(release.args[0], 'release')
        self.assertEqual(release.args[1]['fencing_token'], 'synthetic-token')
        self.assertEqual((status['state'], status['error'], status['session_id']),
                         ('failed', 'controller_desk_start_failed', None))
        self.assertEqual(retry, 'controller_request_failed_use_new_request_id')

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

    def test_status_of_an_unknown_request_reports_nothing_ran(self):
        module = load('desktop_control')
        with tempfile.TemporaryDirectory() as temporary:
            self.assertEqual(module.execute({'state_directory': temporary}, 'status', [], '', str(uuid.uuid4())),
                             {'ok': True, 'state': 'not_recorded', 'session_id': None, 'result': None,
                              'automatic_retry': False})
