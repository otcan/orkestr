"""Real pinned peer and SSE bytes; observation time cannot expire peer proof."""
import os
from pathlib import Path
import shutil
import sys
import time
import unittest
from unittest.mock import patch
import uuid
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, str(Path(__file__).parents[1]))
from v1_runtime.rust_client import RustSession, ClientError
from v1_runtime.service_peer import Binding
from peer_test_fixture import CorePeer
from test_service_client import OWNER


class Peer(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        import time
        self.server.calls.append(('GET', self.path))
        time.sleep(getattr(self.server, 'header_delay', 0))
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        self.wfile.flush()
        if getattr(self.server, 'empty_body', False):
            time.sleep(1)
            return
        self.wfile.write(b'data: {"synthetic_event":true}\n\n')
        self.wfile.flush()


@unittest.skipUnless(os.geteuid() == 0 and sys.platform == 'linux',
                     'Root original-actor TCP fixture required')
class EventBudgetTests(unittest.TestCase):
    def setUp(self):
        self.root = Path('/orkestr-event-budget-' + str(uuid.uuid4()))
        self.root.mkdir(mode=0o755)
        self.addCleanup(shutil.rmtree, self.root)
        self.core = CorePeer(self.root, Peer)
        self.addCleanup(self.core.close)
        self.path = self.core.publish()

    def session(self, timeout_s=2):
        return RustSession(
            origin='http://synthetic.example',
            loopback_url='http://127.0.0.1:' + str(self.core.server_port),
            credentials_path=str(self.root / 'never-read-credentials.json'),
            expected_owner=OWNER, expected_source='a' * 40,
            peer_descriptor_path=str(self.path), timeout_s=timeout_s,
        )

    def test_slow_exact_peer_and_headers_do_not_spend_short_sse_body_budget(self):
        original = Binding._verify

        def slow(binding, sock, wait=False):
            if wait:
                time.sleep(0.2)
            return original(binding, sock, wait)

        self.core.command({'set': {'header_delay': 0.2}})
        with patch.object(Binding, '_verify', slow):
            status, body, _headers = self.session()._wire(
                'GET', '/api/v2/health', events=True, timeout_s=0.15,
            )
        self.assertEqual(status, 200)
        self.assertEqual(body, b'data: {"synthetic_event":true}\n\n')
        self.assertEqual(self.core.calls, [('GET', '/api/v2/health')])

    def test_caught_up_stream_keeps_short_body_observation_deadline(self):
        self.core.command({'set': {'empty_body': True}})
        started = time.monotonic()
        status, body, _headers = self.session()._wire(
            'GET', '/api/v2/health', events=True, timeout_s=0.15,
        )
        elapsed = time.monotonic() - started
        self.assertEqual((status, body), (200, b''))
        self.assertGreaterEqual(elapsed, 0.1)
        self.assertLess(elapsed, 0.75)

    def test_foreign_peer_never_gets_headers_during_event_observation(self):
        self.core.close_listener()
        spoof = CorePeer(self.root, Peer, uid=62122, port=self.core.server_port)
        self.addCleanup(spoof.close)
        with self.assertRaises(ClientError) as failure:
            self.session()._wire('GET', '/api/v2/health', events=True, timeout_s=0.15)
        self.assertEqual(failure.exception.code, 'peer_identity_refused')
        self.assertEqual(failure.exception.outcome, 'refused')
        self.assertEqual(spoof.calls, [])

    def test_body_observation_cannot_extend_original_transport_ceiling(self):
        self.core.command({'set': {'empty_body': True, 'header_delay': 0.3}})
        started = time.monotonic()
        status, body, _headers = self.session(timeout_s=0.6)._wire(
            'GET', '/api/v2/health', events=True, timeout_s=1,
        )
        elapsed = time.monotonic() - started
        self.assertEqual((status, body), (200, b''))
        self.assertGreaterEqual(elapsed, 0.5)
        self.assertLess(elapsed, 0.95)


if __name__ == '__main__':
    unittest.main()
