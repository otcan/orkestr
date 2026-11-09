"""Synthetic authenticated Core projections; no executor or transport effects."""
from types import SimpleNamespace
import unittest

from v2.compat.v1_runtime.thread_status import read
from v2.compat.v1_runtime.rust_client import ClientError
from v2.compat.v1_runtime.tests.test_ledger_server import Harness


class Client:
    def __init__(self, conversation):
        self.conversation, self.calls = conversation, []

    def request(self, method, route, **kwargs):
        self.calls.append((method, route))
        if route == '/window/queue':
            return 200, dict(conversation_id=self.conversation, entries=[dict(state='queued', input_message_id='input-1')])
        return 200, dict(conversation_id=self.conversation, run_id='run-1', phase='running',
                         observed_at_ms=100, revision=7, progress=dict(observed_at_ms=90))


class ProjectionTests(unittest.TestCase):
    def test_core_fields_and_input_ids_without_side_effects(self):
        client = Client('synthetic-conversation')
        binding = SimpleNamespace(state='enabled', config=dict(conversation_id=client.conversation, public_thread_id='public-thread'), worker=SimpleNamespace(client=client))
        value = read(binding)
        self.assertEqual(value['roles']['deep']['runId'], 'run-1')
        self.assertEqual(value['queuedInputs'][0]['inputMessageId'], 'input-1')
        self.assertEqual(value['taskOutcome'], 'unknown')
        self.assertTrue(all(method == 'GET' for method, _ in client.calls))
        client.conversation = 'other-conversation'
        with self.assertRaises(ClientError): read(binding)


class StatusHttpTests(Harness):
    def test_authentication_query_and_binding_scope(self):
        route = '/threads/%s/status' % self.remote(1)
        self.assertEqual(self.request('GET', route, token=False)[0], 401)
        self.assertEqual(self.request('GET', route+'?other=1')[0], 400)
        self.assertEqual(self.request('GET', '/threads/unknown/status')[0], 404)
        self.assertEqual(self.request('GET', route)[0], 503)
        binding = self.binding(1)
        binding.worker = SimpleNamespace(client=Client(binding.config['conversation_id']))
        status, value = self.request('GET', route)
        self.assertEqual(status, 200)
        self.assertEqual(value['publicThreadId'], 'thread-1')
        self.assertEqual(value['source'], 'core')


if __name__ == '__main__': unittest.main()
