import hashlib
import importlib.util
import json
from pathlib import Path
import socket
import struct
import tempfile
import threading
import unittest
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
