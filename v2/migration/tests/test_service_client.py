"""Migration consumers must retain source/owner pins and service provenance."""
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
import v2_client
from v2.compat.v1_runtime.tests.test_provision_service_credential import Peer, OWNER, SOURCE, SECRET


class ServiceClientTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='migration-service-synthetic-')
        self.root = Path(self.temporary.name)
        self.secret = self.root / 'service.json'
        self.secret.write_text(json.dumps({'service_token': SECRET}))
        self.secret.chmod(0o600)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Peer)
        self.server.requests = []
        self.server.source = SOURCE
        self.server.reject_service = self.server.unknown_create = False
        self.server.on_exchange = None
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': 0.01})
        self.thread.start()
        self.client = v2_client.Client(f'http://127.0.0.1:{self.server.server_port}',
                                       origin='https://example.test', timeout=0.5)

    def tearDown(self):
        self.client.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temporary.cleanup()

    def login(self, **pins):
        return self.client.login_file(self.secret, **({'expected_owner': OWNER,
                                                       'expected_source': SOURCE} | pins))

    def test_service_login_no_origin_and_logout_with_csrf(self):
        self.assertEqual(self.login(), {'owner_id': OWNER})
        exchange = next(r for r in self.server.requests if r[1].endswith('service-session'))
        self.assertNotIn('Origin', exchange[2])
        self.assertEqual(exchange[3], {'service_token': SECRET})
        self.client.close()
        method, path, headers, _ = self.server.requests[-1]
        self.assertEqual((method, path), ('DELETE', '/api/v2/browser/session'))
        self.assertIn('X-Orkestr-CSRF', headers)
        self.assertEqual(headers['Origin'], 'https://example.test')

    def test_missing_pins_refuse_without_network(self):
        with self.assertRaisesRegex(v2_client.ApiError, 'service_identity_pins_required'):
            self.client.login_file(self.secret)
        self.assertEqual(self.server.requests, [])

    def test_wrong_source_never_sends_secret(self):
        with self.assertRaisesRegex(v2_client.ApiError, 'source_mismatch'):
            self.login(expected_source='e' * 40)
        self.assertFalse(any(r[0] == 'POST' for r in self.server.requests))

    def test_wrong_owner_refuses_session(self):
        with self.assertRaisesRegex(v2_client.ApiError, 'session_scope_mismatch'):
            self.login(expected_owner='00000000-0000-4000-8000-000000000099')
        self.assertIsNone(self.client.service)

    def test_drift_after_login_blocks_mutation(self):
        self.login()
        self.server.source = 'e' * 40
        with self.assertRaisesRegex(v2_client.ApiError, 'source_mismatch'):
            self.client.post('/api/v2/conversations', {'name': 'must not be created'})
        self.assertFalse(any(r[1] == '/api/v2/conversations' for r in self.server.requests))

    def test_remote_service_endpoint_refused_before_network(self):
        self.client.base = 'https://example.test'
        with self.assertRaisesRegex(v2_client.ApiError, 'loopback_refused'):
            self.login()
        self.assertEqual(self.server.requests, [])

    def test_mutation_rechecks_session_before_request(self):
        self.login()
        with self.assertRaisesRegex(v2_client.ApiError, 'unexpected_status'):
            self.client.put('/api/v2/synthetic-not-found', {'synthetic': True})
        mutation = self.server.requests[-1]
        self.assertEqual(mutation[:2], ('PUT', '/api/v2/synthetic-not-found'))
        self.assertIn('X-Orkestr-CSRF', mutation[2])
        self.assertEqual(self.server.requests[-2][1], '/api/v2/browser/session')


if __name__ == '__main__':
    unittest.main()
