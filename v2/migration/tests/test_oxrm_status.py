"""Synthetic transport only; never calls a deployment or operational CRM tool."""
import http.server
import json
from pathlib import Path
import sys
import threading
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from oxrm_status import Binding, Refused, StatusAdapter, project, read_health, MAX_BYTES


def payload(**updates):
    value = {'status': 'ok', 'service': 'oxrm-mcp',
             'product': {'slug': 'oxrm', 'version': 'example'},
             'deployment': {'target': 'private-never-forward'}}
    value.update(updates)
    return json.dumps(value).encode()


def binding(owner='owner-a', port=12345, workspace='workspace-a', account='account-a'):
    return Binding(owner, workspace, account, 'endpoint-example', f'http://127.0.0.1:{port}/mcp')


class Tests(unittest.TestCase):
    def test_exact_two_owner_dispatch_and_no_raw_strings(self):
        calls = []
        def transport(endpoint):
            calls.append(endpoint)
            return 200, payload(outreachWorkspaceId='untrusted', linkedinAccountAlias='untrusted')
        adapter = StatusAdapter([binding(), binding('owner-b', 12346, 'workspace-b', 'account-b')], transport=transport)
        for owner in ('owner-a', 'owner-b'):
            result = adapter.observe(lambda: owner)
            self.assertFalse(result['workflow_ready'])
            self.assertEqual(result['scope_coverage'], 'not_exposed_by_reviewed_transport')
            self.assertNotIn('private', json.dumps(result))
            self.assertNotIn('untrusted', json.dumps(result))
        self.assertEqual(calls, ['http://127.0.0.1:12345/mcp', 'http://127.0.0.1:12346/mcp'])

    def test_no_fallback_unauthenticated_or_foreign(self):
        calls = []
        adapter = StatusAdapter([binding()], transport=lambda endpoint: calls.append(endpoint))
        for owner, code in ((None, 'authentication_required'), ('foreign', 'binding_unavailable')):
            with self.assertRaisesRegex(Refused, code):
                adapter.observe(lambda: owner)
        self.assertEqual(calls, [])

    def test_pre_post_logout_and_owner_change(self):
        for sequence, code, count in [
            (['owner-a', None], 'authentication_required', 0),
            (['owner-a', 'other'], 'owner_scope_changed', 0),
            (['owner-a', 'owner-a', None], 'authentication_required', 1),
            (['owner-a', 'owner-a', 'other'], 'owner_scope_changed', 1),
        ]:
            with self.subTest(sequence=sequence):
                calls = []
                def transport(endpoint):
                    calls.append(endpoint)
                    return 200, payload()
                adapter = StatusAdapter([binding()], transport=transport)
                iterator = iter(sequence)
                with self.assertRaisesRegex(Refused, code):
                    adapter.observe(lambda: next(iterator))
                self.assertEqual(len(calls), count)

    def test_ambiguous_or_unsafe_bindings_refused(self):
        for values in ([binding(), binding()],
                       [binding(), binding('owner-b', 12345, 'workspace-b', 'account-b')],
                       [binding(), binding('owner-b', 12346)]):
            with self.assertRaises(ValueError):
                StatusAdapter(values)
        for url in ('http://user:pass@example.invalid/mcp', 'http://example.invalid/records',
                    'http://example.invalid/mcp?scope=a', 'file:///mcp', 'https://example.invalid/mcp#x'):
            with self.assertRaises(ValueError):
                Binding('owner', 'workspace', 'account', 'endpoint', url)

    def test_status_denied_unsupported_and_invalid_not_absence(self):
        for status, code in ((401, 'upstream_access_denied'), (403, 'upstream_access_denied'),
                             (404, 'status_transport_unsupported'), (500, 'upstream_unavailable')):
            with self.assertRaisesRegex(Refused, code):
                project(status, b'')
        for body in (b'{"status":"ok","status":"ok"}', b'NaN', b'[]', b' '*(MAX_BYTES+1),
                     payload(service='other'), payload(status='degraded'), payload(product={}),
                     payload(deployment=None), b'\xff'):
            with self.assertRaisesRegex(Refused, 'response_invalid'):
                project(200, body)

    def test_verifier_and_transport_failure_do_not_escape_private_details(self):
        def fail(*_):
            raise RuntimeError('private endpoint or credential detail')
        with self.assertRaisesRegex(Refused, '^authority_unavailable$'):
            StatusAdapter([binding()]).observe(fail)
        with self.assertRaisesRegex(Refused, '^upstream_unavailable$'):
            StatusAdapter([binding()], transport=fail).observe(lambda: 'owner-a')

    def test_published_status_fixture(self):
        fixture = Path(__file__).resolve().parents[2] / 'fixtures/migration-audit/oxrm/status-v1.json'
        self.assertEqual(project(200, payload()), json.loads(fixture.read_text())['success'])

    def test_transport_exact_get_no_auth_no_redirect_and_bounded(self):
        records = []
        mode = [200]
        oversized = [False]
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                records.append((self.command, self.path, dict(self.headers)))
                self.send_response(mode[0])
                if mode[0] == 302:
                    self.send_header('Location', '/contacts')
                    data = b''
                elif oversized[0]:
                    data = b' '*(MAX_BYTES+1)
                else:
                    data = payload()
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            def log_message(self, *_):
                pass
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        endpoint = f'http://127.0.0.1:{server.server_port}/mcp'
        try:
            self.assertEqual(read_health(endpoint)[0], 200)
            mode[0] = 302
            self.assertEqual(read_health(endpoint), (302, b''))
            self.assertEqual(len(records), 2)
            self.assertTrue(all(method == 'GET' and path == '/health' for method, path, _ in records))
            for _, _, headers in records:
                self.assertNotIn('Authorization', headers)
                self.assertNotIn('Cookie', headers)
            mode[0] = 200
            oversized[0] = True
            with self.assertRaisesRegex(Refused, 'response_invalid'):
                read_health(endpoint)
        finally:
            server.shutdown()
            server.server_close()
            worker.join()


if __name__ == '__main__':
    unittest.main()
