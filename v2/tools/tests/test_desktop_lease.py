"""Offline checks for the Worker desktop-lease client against a fake V2 API."""
import contextlib
import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import unittest.mock

SPEC = importlib.util.spec_from_file_location(
    "desktop_lease", Path(__file__).resolve().parents[1] / "desktop_lease.py")
LEASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LEASE)

GRANT = 'ab' * 32
CONVERSATION = '00000000-0000-4000-8000-000000000001'
TOKEN = 'fence-aaaa-aaaa-0001'


class FakeV2(http.server.BaseHTTPRequestHandler):
    calls = []
    lose_after = None

    def log_message(self, *_):
        pass

    def _reply(self, status, body):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _handle(self):
        length = int(self.headers.get('Content-Length') or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        assert self.headers.get('Origin') is None and self.headers.get('Authorization') is None
        if self.headers.get('X-Orkestr-Desktop-Grant') != GRANT:
            return self._reply(401, {'code': 'unauthorized'})
        prefix = f'/api/v2/conversations/{CONVERSATION}'
        path = self.path[len(prefix):]
        FakeV2.calls.append((self.command, path, body))
        lease = {'v1_thread_id': 'v1-parent', 'fencing_version': 3, 'state': 'active'}
        if path == '/desktops/sales-nav/acquire':
            return self._reply(201, {'lease': lease, 'fencing_token': TOKEN})
        if path == '/desktops/sales-nav/heartbeat':
            beats = sum(1 for c in FakeV2.calls if c[1].endswith('heartbeat'))
            if FakeV2.lose_after is not None and beats > FakeV2.lose_after:
                return self._reply(409, {'code': 'desktop_lease_lost'})
            return self._reply(200, lease)
        if path == '/desktops/sales-nav/release':
            return self._reply(200, dict(lease, state='released'))
        if path == '/desktops':
            return self._reply(200, {'leases': []})
        return self._reply(404, {'code': 'not_found'})

    do_GET = do_POST = _handle


class DesktopLeaseClientTests(unittest.TestCase):
    def setUp(self):
        FakeV2.calls, FakeV2.lose_after = [], None
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), FakeV2)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        self.client = LEASE.Client(self.url, CONVERSATION, GRANT)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_grant_sources_are_private_and_well_formed(self):
        self.assertEqual(LEASE.read_grant(environ={'ORKESTR_V2_DESKTOP_GRANT': GRANT}), GRANT)
        with self.assertRaises(LEASE.LeaseError):
            LEASE.read_grant(environ={'ORKESTR_V2_DESKTOP_GRANT': 'short'})
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'grant'
            path.write_text(GRANT + '\n')
            os.chmod(path, 0o644)
            with self.assertRaises(LEASE.LeaseError) as caught:
                LEASE.read_grant(path)
            self.assertEqual(caught.exception.code, 'grant_file_must_be_private')
            os.chmod(path, 0o600)
            self.assertEqual(LEASE.read_grant(path), GRANT)

    def test_hold_exports_fence_heartbeats_and_releases(self):
        seen = {}

        class Child:
            def __init__(self, command, env):
                seen.update(command=command, env=env)
                self.done = threading.Event()

            def wait(self):
                self.done.wait(0.5)
                return 7

            def terminate(self):
                self.done.set()

            def send_signal(self, _):
                self.done.set()

        status = LEASE.hold(self.client, 'sales-nav', 600000, ['browser-task'], interval=0.05, popen=Child)
        self.assertEqual(status, 7)
        env = seen['env']
        self.assertEqual((env['ORKESTR_DESKTOP_FENCING_TOKEN'], env['ORKESTR_DESKTOP_THREAD_ID'],
                          env['ORKESTR_DESKTOP_FENCING_VERSION']), (TOKEN, 'v1-parent', '3'))
        self.assertNotIn('ORKESTR_V2_DESKTOP_GRANT', env)
        paths = [c[1] for c in FakeV2.calls]
        self.assertEqual(paths[0], '/desktops/sales-nav/acquire')
        self.assertEqual(paths[-1], '/desktops/sales-nav/release')
        beats = [c[2] for c in FakeV2.calls if c[1].endswith('heartbeat')]
        self.assertTrue(beats and all(b == {'fencing_token': TOKEN, 'extend_ttl_ms': 600000} for b in beats))

    def test_lost_lease_stops_the_command_without_release(self):
        FakeV2.lose_after = 1

        class Child:
            def __init__(self, command, env):
                self.done = threading.Event()

            def wait(self):
                self.done.wait(5)
                return -15

            def terminate(self):
                self.done.set()

            def send_signal(self, _):
                self.done.set()

        status = LEASE.hold(self.client, 'sales-nav', 600000, ['browser-task'], interval=0.05, popen=Child)
        self.assertEqual(status, LEASE.LOST_EXIT)
        self.assertFalse(any(c[1].endswith('release') for c in FakeV2.calls))

    def test_cli_reports_codes_without_secrets(self):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
                unittest.mock.patch.dict(os.environ, {'ORKESTR_V2_DESKTOP_GRANT': 'cd' * 32}):
            code = LEASE.main(['--v2-url', self.url, '--conversation', CONVERSATION, 'list'])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(err.getvalue())['code'], 'unauthorized')
        self.assertNotIn('cd' * 32, err.getvalue() + out.getvalue())
        out = io.StringIO()
        with contextlib.redirect_stdout(out), \
                unittest.mock.patch.dict(os.environ, {'ORKESTR_V2_DESKTOP_GRANT': GRANT}):
            code = LEASE.main(['--v2-url', self.url, '--conversation', CONVERSATION,
                               'acquire', 'sales-nav', '--ttl-ms', '600000'])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out.getvalue())['result']['fencing_token'], TOKEN)
        self.assertNotIn(GRANT, out.getvalue())


if __name__ == '__main__':
    sys.exit(unittest.main())
