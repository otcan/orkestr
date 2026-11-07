"""Unprivileged discovery projection and actual HTTP framing, using synthetic scope."""
import json
import socket
from types import SimpleNamespace
import unittest

from codex_service import managed_capabilities as capabilities
from codex_service.contract import Refused
from codex_service.managed_http import Peer, tools
from codex_service.managed_ingress import MAX_CONNECTIONS, MAX_WINDOW_REQUESTS

CONVERSATION = '11111111-1111-4111-8111-111111111111'
FOREIGN = '22222222-2222-4222-8222-222222222222'
SCOPE = {'conversation_id': CONVERSATION, 'provider': 'codex',
         'owner_id': 'not-for-discovery', 'caller_pid': 123, 'grant': 'synthetic-private-value'}


def fixture(operations=None):
    desk = None if operations is None else SimpleNamespace(operations=operations)
    return SimpleNamespace(manager=SimpleNamespace(desk=desk))


def by_tool(value, name):
    return next(row for row in value['capabilities'] if row['tool'] == name)


class ManifestTests(unittest.TestCase):
    def read(self, ingress, scope=SCOPE):
        return capabilities.manifest(scope, tools(ingress, scope))

    def test_registered_tools_current_scope_and_limits_without_private_metadata(self):
        ingress = fixture({'own-login': {'conversation_id': CONVERSATION, 'password': 'never-copy'},
                           'foreign-login': {'conversation_id': FOREIGN}})
        value = self.read(ingress)
        self.assertEqual(value['schema_version'], 1)
        self.assertEqual(value['conversation_id'], CONVERSATION)
        self.assertEqual(value['registered_tools'], [tool['name'] for tool in tools(ingress, SCOPE)])
        login = by_tool(value, 'orkestr_desk_login')
        self.assertEqual(login['status'], 'ready')
        self.assertEqual(login['operations'], ['request_scoped_login'])
        self.assertTrue(login['requires_operation_authorization'])
        self.assertEqual(value['limits']['operation_requests_per_window_max'], MAX_WINDOW_REQUESTS)
        self.assertEqual(value['limits']['concurrent_connections_max'], MAX_CONNECTIONS)
        self.assertTrue(value['limits']['requires_service_uptime'])
        self.assertFalse(value['complete'])
        self.assertIn('native_timers', value['uncovered'])
        text = json.dumps(value)
        for private in (FOREIGN, 'foreign-login', 'own-login', 'never-copy', SCOPE['grant'], SCOPE['owner_id']):
            self.assertNotIn(private, text)

    def test_missing_configuration_refresh_and_revocation_have_no_cached_ready_state(self):
        ingress = fixture()
        first = self.read(ingress)
        login = by_tool(first, 'orkestr_desk_login')
        self.assertEqual(login['status'], 'setup_required')
        self.assertEqual(login['operations'], [])
        self.assertTrue(login['setup_action'])
        ingress.manager.desk = SimpleNamespace(operations={'login': {'conversation_id': CONVERSATION}})
        self.assertEqual(by_tool(self.read(ingress), 'orkestr_desk_login')['status'], 'ready')
        ingress.manager.desk.operations.clear()
        self.assertEqual(by_tool(self.read(ingress), 'orkestr_desk_login')['status'], 'setup_required')
        self.assertEqual(login['status'], 'setup_required')

    def test_foreign_configuration_never_makes_this_conversation_ready(self):
        value = self.read(fixture({'foreign-login': {'conversation_id': FOREIGN}}))
        self.assertEqual(by_tool(value, 'orkestr_desk_login')['status'], 'setup_required')
        for provider in ('codex', 'claude'):
            self.assertEqual(self.read(fixture(), {**SCOPE, 'provider': provider})['provider'], provider)
        with self.assertRaises(Refused):
            self.read(fixture(), {**SCOPE, 'provider': 'invented'})

    def test_only_known_unique_registry_names_and_canonical_conversation_are_accepted(self):
        registered = tools(fixture(), SCOPE)
        for altered in (registered + [{'name': 'arbitrary-shell'}], registered + registered, []):
            with self.assertRaises(Refused):
                capabilities.manifest(SCOPE, altered)
        with self.assertRaises(Refused):
            capabilities.manifest({**SCOPE, 'conversation_id': 'foreign/path'}, registered)


class HttpManifestTests(unittest.TestCase):
    def peer(self, arguments, fail_auth_at=None, method='tools/call'):
        server, client = socket.socketpair()
        self.addCleanup(server.close)
        self.addCleanup(client.close)
        client.settimeout(.1)
        peer = Peer(fixture(), server)
        peer.source = SCOPE
        calls = []

        def authenticate():
            calls.append(True)
            if len(calls) == fail_auth_at:
                raise Refused('synthetic_identity_revoked')

        peer.authenticate = authenticate
        params = {'name': capabilities.NAME, 'arguments': arguments} if method == 'tools/call' else {}
        body = json.dumps({'jsonrpc': '2.0', 'id': 7, 'method': method, 'params': params}).encode()
        client.sendall(b'POST /mcp HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: '
                       + str(len(body)).encode() + b'\r\n\r\n' + body)
        return peer, client, calls

    def test_read_only_tool_is_registered_and_returns_structured_current_metadata(self):
        peer, client, calls = self.peer({})
        self.assertIsNone(peer.receive())
        self.assertTrue(peer.metadata_done)
        self.assertIsNone(peer.path)
        self.assertIsNone(peer.request)
        headers, body = client.recv(16384).split(b'\r\n\r\n', 1)
        self.assertIn(b'Cache-Control: no-store', headers)
        result = json.loads(body)['result']
        self.assertFalse(result['isError'])
        self.assertEqual(json.loads(result['content'][0]['text']), result['structuredContent'])
        self.assertEqual(result['structuredContent']['conversation_id'], CONVERSATION)
        self.assertEqual(len(calls), 3, 'identity is rechecked before sending metadata')
        advertisement = capabilities.advertisement()
        self.assertTrue(advertisement['annotations']['readOnlyHint'])
        self.assertFalse(advertisement['annotations']['destructiveHint'])
        peer, client, _ = self.peer({}, method='tools/list')
        peer.receive()
        names = [row['name'] for row in json.loads(client.recv(16384).split(b'\r\n\r\n', 1)[1])['result']['tools']]
        self.assertIn(capabilities.NAME, names)

    def test_no_scope_override_or_command_and_no_reply_after_identity_revocation(self):
        for arguments in ({'conversation_id': FOREIGN}, {'role': 'deep'}, {'command': 'id'}, [], None):
            peer, _, _ = self.peer(arguments)
            with self.assertRaisesRegex(Refused, 'managed_capability_arguments'):
                peer.receive()
        for step in (1, 2, 3):
            peer, client, _ = self.peer({}, fail_auth_at=step)
            with self.assertRaisesRegex(Refused, 'synthetic_identity_revoked'):
                peer.receive()
            self.assertFalse(peer.metadata_done)
            with self.assertRaises(TimeoutError):
                client.recv(16384)


if __name__ == '__main__':
    unittest.main()
