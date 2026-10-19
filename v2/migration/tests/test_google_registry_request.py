"""Mounted synthetic WSGI tests; fake current-session authority, real RO files."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.request import Request as HttpRequest, urlopen
from wsgiref.simple_server import make_server, WSGIRequestHandler
from wsgiref.util import setup_testing_defaults
from wsgiref.validate import validator

from v2.migration.google_registry_metadata import RegistryDescriptor
from v2.migration.google_registry_request import (
    ROUTE, ExactOwnerRegistries, RegistryMetadataBridge, Request,
)

TOKEN_A, TOKEN_B = 'a' * 64, 'b' * 64
HOST, ORIGIN = 'app.example.invalid', 'https://app.example.invalid'


class FakeCurrentSessions:
    """Independent fake; only exact browser-prefixed persisted credentials work."""
    def __init__(self):
        self.sessions = {'browser:' + TOKEN_A: 'owner-a', 'browser:' + TOKEN_B: 'owner-b'}
        self.calls = 0
        self.on_call = None

    def authenticate_browser(self, credential):
        self.calls += 1
        if self.on_call:
            self.on_call(self, credential)
        return self.sessions.get(credential)


class QuietHandler(WSGIRequestHandler):
    def log_message(self, *args):
        pass


class GoogleRegistryRequestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.descriptors = {}
        for owner, caps in (('owner-a', ['gmail_read']), ('owner-b', ['calendar_read'])):
            directory = self.root / owner
            directory.mkdir()
            path = directory / 'google-workspace-connections.json'
            path.write_text(json.dumps({'schemaVersion': 1, 'ownerUserId': owner,
                'connections': [{'connectionId': 'fake-account', 'ownerUserId': owner,
                                 'capabilities': caps, 'tokenRef': 'never-open-token.json'}]}))
            self.descriptors[owner] = RegistryDescriptor(owner, path)
        self.sessions = FakeCurrentSessions()
        self.bridge = RegistryMetadataBridge(self.sessions, ExactOwnerRegistries(self.descriptors),
                                              host=HOST, origin=ORIGIN)

    def request(self, token=TOKEN_A, **kwargs):
        return Request(kwargs.pop('method', 'GET'), kwargs.pop('path', ROUTE),
                       kwargs.pop('query', ''), kwargs.pop('content_length', ''),
                       tuple(kwargs.pop('headers', (('host', HOST), ('origin', ORIGIN),
                                                    ('cookie', 'orkestr_v2_session=' + token)))))

    def mounted(self, token=TOKEN_A, **changes):
        env = {}
        setup_testing_defaults(env)
        env.update(REQUEST_METHOD='GET', PATH_INFO=ROUTE, QUERY_STRING='',
                   HTTP_HOST=HOST, HTTP_ORIGIN=ORIGIN,
                   HTTP_COOKIE='orkestr_v2_session=' + token, **changes)
        captured = []
        def start(status, headers, exc_info=None):
            captured.append((int(status[:3]), dict(headers)))
        response = validator(self.bridge)(env, start)
        try:
            body = b''.join(response)
        finally:
            response.close()
        return captured[0][0], captured[0][1], json.loads(body)

    def test_mounted_two_owners_are_separate(self):
        for token, expected, absent in ((TOKEN_A, 'gmail_read', 'calendar_read'),
                                        (TOKEN_B, 'calendar_read', 'gmail_read')):
            status, headers, value = self.mounted(token)
            self.assertEqual(status, 200)
            self.assertEqual(headers['Cache-Control'], 'no-store')
            self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
            self.assertEqual(value['status'], 'configuration_observed')
            self.assertEqual(value['metadata']['capabilities'][expected], 1)
            self.assertEqual(value['metadata']['capabilities'][absent], 0)
            self.assertFalse(value['metadata']['provider_readiness_verified'])
            self.assertNotIn('owner-', json.dumps(value))
        self.assertEqual(self.sessions.calls, 6)

    def test_revoked_or_logout_at_every_current_auth_boundary(self):
        for phase in (1, 2, 3):
            for action in ('revoke', 'logout'):
                self.sessions = FakeCurrentSessions()
                self.bridge.authority = self.sessions
                def revoke(store, credential):
                    if store.calls == phase:
                        if action == 'revoke':
                            store.sessions.pop(credential, None)
                        else:
                            store.sessions.clear()
                self.sessions.on_call = revoke
                status, _, value = self.mounted()
                self.assertEqual(status, 401)
                self.assertEqual(value['error'], 'authentication_required')
                self.assertNotIn('metadata', value)

    def test_unauthenticated_denies_before_registry_access(self):
        with patch('os.open', side_effect=AssertionError('unexpected file access')):
            status, _, _ = self.mounted('c' * 64)
            self.assertEqual(status, 401)

    def test_no_global_fallback_or_registry_identity_auth(self):
        self.bridge.registries = ExactOwnerRegistries({'owner-b': self.descriptors['owner-b']})
        with patch('os.open', side_effect=AssertionError('fallback file access')):
            self.assertEqual(self.mounted()[0], 503)
        self.sessions.sessions.clear()
        self.assertEqual(self.mounted(TOKEN_B)[0], 401)

    def test_changed_authenticated_account_refuses_before_open_or_delivery(self):
        for phase in (2, 3):
            self.sessions = FakeCurrentSessions()
            self.bridge.authority = self.sessions
            def change(store, credential):
                if store.calls == phase:
                    store.sessions[credential] = 'owner-b'
            self.sessions.on_call = change
            status, _, value = self.mounted()
            self.assertEqual(status, 403)
            self.assertEqual(value['error'], 'owner_scope_changed')
            self.assertNotIn('metadata', value)

    def test_client_scope_and_body_inputs_cannot_select_registry(self):
        for request in (self.request(query='owner=owner-b'),
                        self.request(query='path=untrusted'),
                        self.request(content_length='2'),
                        self.request(headers=(('host', HOST), ('x-owner-id', 'owner-b'))),
                        self.request(headers=(('host', HOST), ('x-registry-path', 'untrusted'))),
                        self.request(headers=(('host', HOST), ('transfer-encoding', 'chunked')))):
            with patch('os.open', side_effect=AssertionError('client-selected registry')):
                self.assertEqual(self.bridge.handle(request)[0], 400)
        self.assertEqual(self.sessions.calls, 0)

    def test_cookie_bearer_duplicate_cookie_host_origin_refuse(self):
        cookie = ('cookie', 'orkestr_v2_session=' + TOKEN_A)
        cases = ((('host', HOST), cookie, ('authorization', 'Bearer ' + TOKEN_A)),
                 (('host', HOST), cookie, cookie),
                 (('host', 'foreign.example.invalid'), cookie),
                 (('host', HOST), ('origin', 'https://foreign.example.invalid'), cookie),
                 (('host', HOST), ('cookie', 'orkestr_v2_session=invalid')),
                 (('host', HOST), ('x-forwarded-user', 'owner-a')))
        for headers in cases:
            with patch('os.open', side_effect=AssertionError('unauthorized open')):
                self.assertIn(self.bridge.handle(self.request(headers=headers))[0], (401, 403))
        self.assertEqual(self.sessions.calls, 0)

    def test_missing_or_foreign_registry_no_initialization(self):
        path = self.descriptors['owner-a'].path
        path.unlink()
        with patch('os.mkdir', side_effect=AssertionError('initializer')):
            status, _, value = self.mounted()
        self.assertEqual(status, 503)
        self.assertEqual(value['error'], 'registry_unavailable')
        self.assertFalse(path.exists())
        path.write_text(self.descriptors['owner-b'].path.read_text())
        self.assertEqual(self.mounted()[0], 503)

    def test_authority_failure_is_sanitized(self):
        def unavailable(*args):
            raise RuntimeError('private exception detail')
        self.sessions.authenticate_browser = unavailable
        status, _, value = self.mounted()
        self.assertEqual(status, 503)
        self.assertEqual(value['error'], 'authority_unavailable')
        self.assertNotIn('private', json.dumps(value))

    def test_forwarded_principal_never_creates_or_changes_account(self):
        headers = (('host', HOST), ('cookie', 'orkestr_v2_session=' + TOKEN_A),
                   ('x-forwarded-user', 'owner-b'))
        status, value = self.bridge.handle(self.request(headers=headers))
        self.assertEqual(status, 200)
        self.assertEqual(value['metadata']['capabilities']['gmail_read'], 1)
        self.assertEqual(value['metadata']['capabilities']['calendar_read'], 0)

    def test_frozen_fixture_matches_success_and_error_vocabulary(self):
        fixture = json.loads((Path(__file__).parents[2] / 'fixtures' / 'migration-audit' /
                              'google-registry' / 'status-v1.json').read_text())
        path = self.descriptors['owner-a'].path
        path.write_text(json.dumps({'schemaVersion': 1, 'ownerUserId': 'owner-a', 'connections': []}))
        self.assertEqual(self.mounted()[2], fixture['success'])
        expected = {(400, 'request_parameters_rejected'), (401, 'authentication_required'),
                    (403, 'host_rejected'), (403, 'origin_rejected'), (403, 'owner_scope_changed'),
                    (404, 'not_found'), (405, 'method_not_allowed'),
                    (503, 'authority_unavailable'), (503, 'registry_unavailable')}
        self.assertEqual({(r['http_status'], r['body']['error']) for r in fixture['refusals']}, expected)
        for refusal in fixture['refusals']:
            self.assertEqual(set(refusal['body']), {'format_version', 'status', 'error'})

    def test_request_and_verifier_repr_do_not_expose_cookie(self):
        self.assertNotIn(TOKEN_A, repr(self.request()))

    def test_route_and_method_are_closed(self):
        self.assertEqual(self.bridge.handle(self.request(path='/other'))[0], 404)
        self.assertEqual(self.bridge.handle(self.request(method='POST'))[0], 405)
        self.assertEqual(self.sessions.calls, 0)

    def test_mounted_port_has_no_writer_token_lookup_or_provider_transport(self):
        real_open = os.open
        def readonly(path, flags, *args, **kwargs):
            self.assertEqual(flags & os.O_ACCMODE, os.O_RDONLY)
            self.assertFalse(flags & (os.O_CREAT | os.O_TRUNC | os.O_APPEND))
            self.assertNotIn('never-open-token', str(path))
            return real_open(path, flags, *args, **kwargs)
        with patch('os.open', readonly), patch('os.mkdir', side_effect=AssertionError('mkdir')), \
                patch('os.write', side_effect=AssertionError('write')), \
                patch('socket.socket', side_effect=AssertionError('provider transport')):
            self.assertEqual(self.mounted()[0], 200)

    def test_bounded_request_headers_refuse_before_authority(self):
        headers = (('host', HOST), ('cookie', 'x' * 16385))
        self.assertEqual(self.bridge.handle(self.request(headers=headers))[0], 400)
        self.assertEqual(self.sessions.calls, 0)

    def test_real_loopback_mount_readonly_and_no_token_provider_calls(self):
        before = {p: hashlib.sha256(p.read_bytes()).digest() for p in self.root.rglob('*.json')}
        with make_server('127.0.0.1', 0, self.bridge, handler_class=QuietHandler) as server:
            thread = threading.Thread(target=server.handle_request)
            thread.start()
            request = HttpRequest(f'http://127.0.0.1:{server.server_port}' + ROUTE,
                headers={'Host': HOST, 'Origin': ORIGIN,
                         'Cookie': 'orkestr_v2_session=' + TOKEN_A})
            with urlopen(request, timeout=5) as response:
                value = json.load(response)
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers['Cache-Control'], 'no-store')
                self.assertEqual(value['metadata']['capabilities']['gmail_read'], 1)
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())
        after = {p: hashlib.sha256(p.read_bytes()).digest() for p in self.root.rglob('*.json')}
        self.assertEqual(before, after)
        self.assertFalse(any(self.root.rglob('*token*')))


if __name__ == '__main__':
    unittest.main()
