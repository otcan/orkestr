"""Native-shaped synthetic terminal failures; no account or provider process."""
import json
import unittest
import uuid

from protocol import Refused
import test_claude_protocol as fixtures


def native_failure(native):
    return {'type': 'result', 'subtype': 'error_during_execution', 'duration_ms': 0,
        'duration_api_ms': 0, 'is_error': True, 'num_turns': 0, 'stop_reason': None,
        'session_id': native, 'total_cost_usd': 0,
        'usage': {'input_tokens': 0, 'output_tokens': 0}, 'modelUsage': {},
        'permission_denials': [], 'uuid': '22222222-2222-4222-8222-222222222222',
        'errors': ['synthetic-private-error'],
        'user_message_uuid': '33333333-3333-4333-8333-333333333333'}


class FailureTests(unittest.TestCase):
    def ready(self):
        fixture = fixtures.ClaudeProtocolTests()
        fixture.setUp()
        fixture.init()
        fixture.channel.client(fixture.request(2))
        fixture.channel.provider({'type': 'system', 'subtype': 'init', 'session_id': fixture.native})
        return fixture.channel, native_failure(fixture.native)

    def refuse(self, change):
        channel, frame = self.ready()
        change(frame)
        with self.assertRaises((Refused, ValueError, TypeError)):
            channel.provider(frame)
        self.assertTrue(channel.poisoned)
        self.assertFalse(channel.terminal)

    def test_native_error_has_only_existing_failed_contract(self):
        channel, frame = self.ready()
        clean = channel.provider(frame)['params']['frame']
        self.assertEqual(clean, {key: frame[key] for key in (
            'type', 'session_id', 'uuid', 'user_message_uuid', 'subtype', 'is_error')} | {'result': ''})
        self.assertNotIn('synthetic-private-error', json.dumps(clean))
        self.assertNotIn('terminal_reason', clean)
        self.assertTrue(clean['is_error'])
        self.assertTrue(channel.terminal)
        self.assertIsNone(channel.control)
        with self.assertRaises(Refused):
            channel.provider(frame)

    def test_foreign_missing_nil_or_replayed_identity_refused(self):
        for key in ('session_id', 'user_message_uuid', 'uuid'):
            self.refuse(lambda f, k=key: f.pop(k))
        for key in ('session_id', 'user_message_uuid'):
            self.refuse(lambda f, k=key: f.update({k: '44444444-4444-4444-8444-444444444444'}))
        for value in ('not-a-uuid', str(uuid.UUID(int=0)),
                      '11111111-1111-4111-8111-111111111111',
                      '33333333-3333-4333-8333-333333333333'):
            self.refuse(lambda f, v=value: f.update(uuid=v))
        self.refuse(lambda f: f.update(user_message_uuids=[]))
        for prior in ('telemetry', 'assistant'):
            channel, frame = self.ready()
            if prior == 'telemetry':
                channel.provider({'type': 'command_lifecycle', 'session_id': channel.native,
                    'uuid': frame['uuid'], 'command_uuid': frame['user_message_uuid'], 'state': 'started'})
            else:
                channel.provider({'type': 'assistant', 'session_id': channel.native,
                    'uuid': frame['uuid'], 'user_message_uuid': frame['user_message_uuid'],
                    'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'synthetic'}]}})
            with self.assertRaises(Refused):
                channel.provider(frame)

    def test_malformed_or_oversized_errors_refused(self):
        for value in (None, 'raw', [], [False], ['x'] * 129, ['x' * 8193], ['x' * 4097] * 2):
            self.refuse(lambda f, v=value: f.update(errors=v))
        self.refuse(lambda f: f.update(usage={'synthetic': 'x' * 17000}))
        self.refuse(lambda f: f.update(total_cost_usd=float('nan')))
        self.refuse(lambda f: f.update(num_turns=True))
        self.refuse(lambda f: f.update(unknown='synthetic'))

    def test_success_and_unissued_stop_are_not_error_authority(self):
        for value in (False, 1, None):
            self.refuse(lambda f, v=value: f.update(is_error=v))
        self.refuse(lambda f: f.update(subtype='success'))
        self.refuse(lambda f: f.update(terminal_reason='aborted_streaming'))
        self.refuse(lambda f: f.update(terminal_reason='aborted_tools'))
        self.refuse(lambda f: f.update(permission_denials=[{}]))


if __name__ == '__main__':
    unittest.main()
