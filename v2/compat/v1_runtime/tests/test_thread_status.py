"""Synthetic authenticated Core projections; no executor or transport effects."""
from types import SimpleNamespace
import unittest

from v2.compat.v1_runtime.thread_status import read
from v2.compat.v1_runtime.rust_client import ClientError
from v2.compat.v1_runtime.tests.test_ledger_server import Harness, binding_doc


class Client:
    def __init__(self, conversation):
        self.conversation, self.calls = conversation, []
        self.answers = {}

    def request(self, method, route, allowed=(200,), **kwargs):
        self.calls.append((method, route))
        if route in self.answers:
            status, value = self.answers[route]
            if status not in allowed:
                raise ClientError('unexpected_status', status)
            return status, value
        if route == '/window/queue':
            return 200, dict(conversation_id=self.conversation, entries=[dict(state='queued', input_message_id='input-1')])
        return 200, dict(conversation_id=self.conversation, run_id='run-1', phase='running',
                         observed_at_ms=100, revision=7, progress=dict(observed_at_ms=90))


def binding_for(client, state='enabled'):
    return SimpleNamespace(state=state, config=dict(conversation_id=client.conversation, public_thread_id='public-thread'),
                           worker=SimpleNamespace(client=client))


class ProjectionTests(unittest.TestCase):
    def test_core_fields_and_input_ids_without_side_effects(self):
        client = Client('synthetic-conversation')
        binding = binding_for(client)
        value = read(binding)
        self.assertEqual(value['roles']['deep']['runId'], 'run-1')
        self.assertEqual(value['queuedInputs'][0]['inputMessageId'], 'input-1')
        self.assertEqual(value['taskOutcome'], 'unknown')
        self.assertTrue(all(method == 'GET' for method, _ in client.calls))
        client.conversation = 'other-conversation'
        with self.assertRaises(ClientError): read(binding)

    def test_no_content_is_a_role_without_a_run(self):
        # Core answers 204 for a role with no run or no Fast role at all; that
        # is no execution, not an unavailable status.
        client = Client('synthetic-conversation')
        client.answers['/fast/execution'] = (204, None)
        value = read(binding_for(client))
        self.assertIsNone(value['roles']['fast'])
        self.assertEqual(value['roles']['deep']['phase'], 'running')
        client.answers['/execution'] = (204, None)
        client.answers['/window/queue'] = (200, dict(conversation_id=client.conversation, entries=[]))
        value = read(binding_for(client))
        self.assertEqual(value['roles'], dict(deep=None, fast=None))
        self.assertEqual(value['queuedInputs'], [])
        self.assertEqual(value['taskOutcome'], 'unknown')
        self.assertEqual([route for _, route in client.calls[-3:]], ['/execution', '/fast/execution', '/window/queue'])
        self.assertTrue(all(method == 'GET' for method, _ in client.calls))

    def test_missing_conversation_is_unavailable_not_idle(self):
        client = Client('synthetic-conversation')
        client.answers['/execution'] = (404, dict(error='not_found'))
        with self.assertRaises(ClientError): read(binding_for(client))
        client = Client('synthetic-conversation')
        client.answers['/window/queue'] = (404, dict(error='beta_unconfigured'))
        with self.assertRaises(ClientError): read(binding_for(client))

    def test_unavailable_core_fails_the_whole_read(self):
        # Never a partial projection: one unreadable role or queue is no
        # evidence about the others' silence.
        for route, answer in (('/execution', (503, None)), ('/fast/execution', (401, None)),
                              ('/window/queue', (503, None)), ('/execution', (500, None))):
            client = Client('synthetic-conversation')
            client.answers[route] = answer
            with self.assertRaises(ClientError): read(binding_for(client))
        client = Client('synthetic-conversation')
        client.answers['/window/queue'] = (200, dict(conversation_id=client.conversation, entries='not-a-list'))
        with self.assertRaises(ClientError): read(binding_for(client))
        client = Client('synthetic-conversation')
        client.answers['/execution'] = (200, ['not', 'an', 'object'])
        with self.assertRaises(ClientError): read(binding_for(client))
        client = Client('synthetic-conversation')
        client.answers['/execution'] = (200, dict(conversation_id=client.conversation, phase='running', observed_at_ms='100'))
        with self.assertRaises(ClientError): read(binding_for(client))

    def test_another_conversation_is_refused(self):
        for route in ('/execution', '/fast/execution'):
            client = Client('synthetic-conversation')
            client.answers[route] = (200, dict(conversation_id='other-conversation', run_id='run-9', phase='running',
                                               observed_at_ms=100))
            with self.assertRaises(ClientError): read(binding_for(client))
        client = Client('synthetic-conversation')
        client.answers['/window/queue'] = (200, dict(conversation_id='other-conversation', entries=[]))
        with self.assertRaises(ClientError): read(binding_for(client))
        client = Client('synthetic-conversation')
        client.answers['/window/queue'] = (200, dict(conversation_id=client.conversation, entries=[
            dict(state='queued', conversation_id='other-conversation', input_message_id='foreign-input'),
            dict(state='queued', conversation_id=client.conversation, input_message_id='own-input'),
            dict(state='dispatched', input_message_id='dispatched-input'), 'not-a-row']))
        self.assertEqual([entry['inputMessageId'] for entry in read(binding_for(client))['queuedInputs']], ['own-input'])

    def test_disabled_binding_is_unavailable(self):
        client = Client('synthetic-conversation')
        for state in ('revoked', 'refused', 'paused'):
            with self.assertRaises(ClientError): read(binding_for(client, state))
        self.assertEqual(client.calls, [])

    def test_provider_model_and_failure_class_only_in_closed_shapes(self):
        client = Client('synthetic-conversation')
        client.answers['/execution'] = (200, dict(
            conversation_id=client.conversation, run_id='run-2', phase='failed', observed_at_ms=100, revision=8,
            failure={'class': 'quota'},
            models=dict(provider='claude', resolved_model='claude-opus-5-5', actual_model='claude-opus-5-5')))
        client.answers['/fast/execution'] = (200, dict(
            conversation_id=client.conversation, run_id='run-3', phase='completed', observed_at_ms=100, revision=9,
            models=dict(provider='other', actual_model='/srv/models/../secret')))
        roles = read(binding_for(client))['roles']
        self.assertEqual((roles['deep']['provider'], roles['deep']['model'], roles['deep']['failure']),
                         ('claude', 'claude-opus-5-5', 'quota'))
        self.assertEqual((roles['fast']['provider'], roles['fast']['model']), (None, None))

    def test_projection_carries_no_paths_secrets_or_native_internals(self):
        client = Client('synthetic-conversation')
        client.answers['/execution'] = (200, dict(
            schema_version=1, conversation_id=client.conversation, run_id='../../srv/run', phase='failed',
            observed_at_ms=100, revision='7', control_revision=3, queue_age_ms=5,
            progress=dict(payload_id='native-payload-id', observed_at_ms='90'),
            resources=dict(cpu_capacity_permille=10, resident_bytes=1, observed_at_ms=90),
            capabilities=dict(stop=True, steer=True),
            acceptance_candidate=dict(run_id='run-1', completion_event_id='native-event-id'),
            failure={'class': '/home/user/.codex/auth.json'},
            models=dict(provider=['codex'], actual_model='/root/.claude/model', resolved_model='a//b',
                        refused_model='native-refused-model'),
            credential='synthetic-credential-value', path='/var/lib/orkestr/private'))
        client.answers['/fast/execution'] = (200, dict(
            conversation_id=client.conversation, run_id='00000000-0000-4000-8000-000000000003', phase='running',
            observed_at_ms=100, failure='quota', models=dict(provider='codex', actual_model='gpt-5.5-codex')))
        value = read(binding_for(client))
        deep, fast = value['roles']['deep'], value['roles']['fast']
        keys = {'phase', 'runId', 'observedAtMs', 'revision', 'lastProgressAtMs', 'failure', 'provider', 'model'}
        self.assertEqual(set(deep), keys)
        self.assertEqual(set(fast), keys)
        self.assertEqual(deep, dict(phase='failed', runId=None, observedAtMs=100, revision=None, lastProgressAtMs=None,
                                    failure=None, provider=None, model=None))
        self.assertEqual((fast['runId'], fast['provider'], fast['model'], fast['failure']),
                         ('00000000-0000-4000-8000-000000000003', 'codex', 'gpt-5.5-codex', None))
        text = repr(value)
        for leaked in ('native-payload', 'native-event', 'native-refused', 'synthetic-credential', '/srv', '/home', '/root',
                       '/var', 'auth.json', 'a//b', 'stop', 'resident'):
            self.assertNotIn(leaked, text)
        self.assertEqual(set(value), {'version', 'source', 'publicThreadId', 'conversationId', 'observedAtMs', 'roles',
                                      'queuedInputs', 'taskOutcome'})

    def test_invalid_phase_is_refused(self):
        client = Client('synthetic-conversation')
        client.answers['/execution'] = (200, dict(conversation_id=client.conversation, phase='invented', observed_at_ms=100))
        with self.assertRaises(ClientError): read(binding_for(client))


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
        binding.worker.client.answers['/fast/execution'] = (204, None)
        status, value = self.request('GET', route)
        self.assertEqual(status, 200)
        self.assertIsNone(value['roles']['fast'])
        # Each remote id answers only for its own binding and conversation.
        other = self.binding(2)
        other.worker = SimpleNamespace(client=Client(other.config['conversation_id']))
        status, value = self.request('GET', '/threads/%s/status' % self.remote(2))
        self.assertEqual((status, value['publicThreadId']), (200, 'thread-2'))
        self.assertEqual(value['conversationId'], other.config['conversation_id'])
        self.assertEqual(binding.worker.client.calls.count(('GET', '/window/queue')), 2)
        self.write(binding_doc(1, enabled=False))
        self.registry.reload()
        self.assertEqual(self.request('GET', route)[0], 503)  # Paused: no status, not idle.
        self.write(binding_doc(1, enabled=False, revoked=True))
        self.registry.reload()
        self.assertEqual(self.request('GET', route)[0], 410)


if __name__ == '__main__': unittest.main()
