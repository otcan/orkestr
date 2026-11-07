"""Shared startup/refresh context on the existing authenticated MCP surface."""
import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from codex_service import managed_context
from codex_service.contract import Refused
from codex_service.managed_advertisement import codex_options, claude_options
import test_codex_service_managed_capabilities as fixtures


class ContextTests(unittest.TestCase):
    def read(self, provider='codex', resumed=False, initialize=True, ingress=None):
        method = 'initialize' if initialize else 'tools/call'
        params = {'protocolVersion': '2025-06-18', 'clientInfo': {'name': 'untrusted-client'},
                  'instructions': 'untrusted-client-instructions'} if initialize else None
        peer, client, calls = fixtures.HttpManifestTests.peer(self, {}, method=method, params=params)
        peer.source = {**fixtures.SCOPE, 'provider': provider}
        if resumed:
            peer.source.update(native_session_id='private-native-session', resume_setup_id='private-resume-setup')
        if ingress is not None:
            peer.ingress = ingress
        self.assertIsNone(peer.receive())
        self.assertIsNone(peer.path)
        self.assertIsNone(peer.request)
        self.assertEqual(len(calls), 3)
        raw = client.recv(16384)
        headers, body = raw.split(b'\r\n\r\n', 1)
        self.assertIn(b'Cache-Control: no-store', headers)
        result = json.loads(body)['result']
        return json.loads(result['instructions']) if initialize else result['structuredContent']

    def test_same_versioned_rules_for_fresh_and_resumed_codex_and_claude(self):
        expected = None
        for provider in ('codex', 'claude'):
            for resumed in (False, True):
                initialized = self.read(provider, resumed)
                refreshed = self.read(provider, resumed, initialize=False)
                self.assertEqual(initialized, refreshed)
                rules = initialized['application_instructions']
                self.assertEqual(rules['schema_version'], 1)
                self.assertEqual(rules['application'], 'orkestr')
                self.assertEqual(rules['scope'], 'current_conversation')
                self.assertEqual(initialized['provider'], provider)
                self.assertIn('orkestr_capabilities', initialized['registered_tools'])
                self.assertTrue(initialized['limits']['requires_service_uptime'])
                if expected is None:
                    expected = rules
                self.assertEqual(rules, expected)
                for private in ('private-native-session', 'private-resume-setup',
                                'untrusted-client', fixtures.SCOPE['grant'], fixtures.SCOPE['owner_id']):
                    self.assertNotIn(private, json.dumps(initialized))

    def test_resume_and_refresh_observe_setup_and_revocation_without_changing_rules(self):
        ingress = fixtures.fixture()
        before = self.read(ingress=ingress)
        ingress.manager.desk = SimpleNamespace(operations={'synthetic-login': {'conversation_id': fixtures.CONVERSATION}})
        resumed = self.read(resumed=True, ingress=ingress)
        self.assertEqual(fixtures.by_tool(resumed, 'orkestr_desk_login')['status'], 'ready')
        ingress.manager.desk.operations.clear()
        refreshed = self.read(initialize=False, ingress=ingress)
        for value in (before, refreshed):
            self.assertEqual(fixtures.by_tool(value, 'orkestr_desk_login')['status'], 'setup_required')
        self.assertEqual(before['application_instructions'], resumed['application_instructions'])
        self.assertEqual(before['application_instructions'], refreshed['application_instructions'])

    def test_initialization_cannot_return_context_after_identity_revocation(self):
        for step in (1, 2, 3):
            peer, client, _ = fixtures.HttpManifestTests.peer(self, {}, fail_auth_at=step,
                method='initialize', params={'protocolVersion': '2025-06-18'})
            with self.assertRaisesRegex(Refused, 'synthetic_identity_revoked'):
                peer.receive()
            with self.assertRaises(TimeoutError):
                client.recv(16384)

    def test_rules_have_no_shared_mutable_state_and_retain_role_boundaries(self):
        rules = managed_context.instructions()
        text = ' '.join(rules['rules'])
        self.assertIn('Fast read-only', text)
        self.assertIn('Workers within their delegated scope', text)
        self.assertIn('after resuming a session', text)
        rules['rules'].clear()
        self.assertTrue(managed_context.instructions()['rules'])

    def test_existing_provider_routing_supports_resume_without_enabling_fast_or_workers(self):
        package = SimpleNamespace(runtime={'managed_operations': True}, identity_split=True, beta={'managed_host': {}})
        for role, options in (('deep', codex_options), ('claude', claude_options)):
            for resumed in (False, True):
                context = {'role': role, 'setup': {'role': 'deep'},
                           'managed_mcp_url': 'http://127.0.0.1:19345/mcp'}
                if resumed:
                    context['setup'].update(native_session_id='synthetic-native', resume_setup_id='synthetic-setup')
                with patch('codex_service.identity.launch_context', return_value=context):
                    self.assertTrue(options(package))
                    for denied in ('fast', 'worker-0'):
                        context['role'] = denied
                        self.assertEqual(options(package), ())


if __name__ == '__main__':
    unittest.main()
