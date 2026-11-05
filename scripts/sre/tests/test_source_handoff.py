import importlib.util
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('handoff', Path(__file__).parents[1] / 'source_handoff.py')
h = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(h)


def decision(**updates):
    value = dict(request_id='request-a', decision_id='decision-a', conversation_id='source-a',
                 source_run_id='run-a', native_session_id='native-a', provider_generation=3,
                 action='repair', resource='owned-connector', verdict='approve', password='DO-NOT-COPY')
    value.update(updates)
    return value


class SourceHandoffTests(unittest.TestCase):
    def test_targets_source_with_agent_author_and_fences_and_dedupes(self):
        with tempfile.TemporaryDirectory() as tmp:
            calls = []
            def send(conversation, body):
                calls.append((conversation, body))
                return dict(message_id='11111111-1111-4111-8111-111111111111', event_id='22222222-2222-4222-8222-222222222222', sequence=1, status='accepted', secret='DO-NOT-COPY')
            result = h.deliver(tmp, decision(), send)
            again = h.deliver(tmp, decision(), send)
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][0], 'source-a')
            self.assertEqual(calls[0][1]['author'], 'v1_agent')
            self.assertEqual(calls[0][1]['continuation_source_run_id'], 'run-a')
            self.assertEqual(calls[0][1]['expected_provider_generation'], 3)
            self.assertEqual(result['execution_owner'], 'source')
            self.assertFalse(result['grant']['runtime_privileges_changed'])
            self.assertEqual(again['status'], 'accepted')
            self.assertNotIn('DO-NOT-COPY', str(result))

    def test_unknown_result_never_retries(self):
        with tempfile.TemporaryDirectory() as tmp:
            calls = []
            def send(*args):
                calls.append(args)
                raise TimeoutError('possibly accepted')
            self.assertEqual(h.deliver(tmp, decision(), send)['status'], 'unknown')
            h.deliver(tmp, decision(), send)
            self.assertEqual(len(calls), 1)

    def test_crash_after_claim_is_fenced(self):
        with tempfile.TemporaryDirectory() as tmp:
            def crash(*args):
                raise KeyboardInterrupt()
            with self.assertRaises(KeyboardInterrupt):
                h.deliver(tmp, decision(), crash)
            result = h.deliver(tmp, decision(), lambda *args: self.fail('must not replay'))
            self.assertEqual(result['status'], 'claimed')

    def test_decision_key_cannot_change_target_or_scope(self):
        with tempfile.TemporaryDirectory() as tmp:
            h.deliver(tmp, decision(), lambda *args: dict(message_id='m', event_id='e'))
            with self.assertRaisesRegex(h.HandoffRefused, 'identity_changed'):
                h.deliver(tmp, decision(conversation_id='other'), lambda *args: self.fail())

    def test_denial_grants_no_execution_and_dry_run_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = h.deliver(tmp, decision(verdict='deny'), lambda *args: self.fail(), dry=True)
            self.assertFalse(result['grant']['approved'])
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_incomplete_source_is_refused_before_transport(self):
        with tempfile.TemporaryDirectory() as tmp:
            for fields in [dict(source_run_id=''), dict(provider_generation=None), dict(verdict='rescope')]:
                with self.assertRaises(h.HandoffRefused):
                    h.deliver(tmp, decision(**fields), lambda *args: self.fail())


if __name__ == '__main__':
    unittest.main()
