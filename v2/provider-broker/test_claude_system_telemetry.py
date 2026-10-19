"""Pinned headless metadata cannot become observation or control authority."""
import unittest
import uuid

from protocol import Refused
import test_claude_control as control
import test_claude_protocol as protocol


class SystemTelemetryTests(unittest.TestCase):
    def setUp(self):
        self.fixture = control.ClaudeControlTests()
        self.fixture.setUp()
        self.channel = self.fixture.channel

    def frame(self, subtype='thinking_tokens'):
        common = {'type': 'system', 'subtype': subtype, 'session_id': self.channel.native,
                  'uuid': str(uuid.uuid4())}
        return dict(common, user_message_uuid=self.channel.input_uuid,
                    estimated_tokens=12, estimated_tokens_delta=3) if subtype == 'thinking_tokens' else dict(
                        common, status='requesting', user_message_uuids=[self.channel.input_uuid])

    def refuse(self, update, subtype='thinking_tokens'):
        self.setUp()
        frame = self.frame(subtype)
        update(frame)
        with self.assertRaises((Refused, ValueError, TypeError)):
            self.channel.provider(frame)
        self.assertFalse(self.channel.terminal)

    def test_two_exact_shapes_never_emit_an_observation(self):
        for subtype in ('thinking_tokens', 'status'):
            self.assertIsNone(self.channel.provider(self.frame(subtype)))
            self.assertTrue(self.channel.system_seen)
            self.assertFalse(self.channel.terminal)
            self.assertIsNone(self.channel.control)

    def test_before_init_metadata_cannot_enable_readiness(self):
        for subtype in ('thinking_tokens', 'status'):
            fixture = protocol.ClaudeProtocolTests(); fixture.setUp(); fixture.init()
            fixture.channel.client(fixture.request(2))
            self.channel = fixture.channel
            with self.assertRaises(Refused):
                self.channel.provider(self.frame(subtype))
            self.assertFalse(self.channel.system_seen or self.channel.terminal)

    def test_metadata_cannot_ack_or_confirm_stop_even_after_terminal(self):
        self.channel.client(self.fixture.request())
        for subtype in ('thinking_tokens', 'status'):
            self.assertIsNone(self.channel.provider(self.frame(subtype)))
        self.assertFalse(self.channel.control.ack or self.channel.terminal)
        self.channel.provider(self.fixture.ack())
        self.assertFalse(self.channel.terminal)
        self.channel.provider(self.fixture.terminal())
        terminal = self.channel.terminal_uuid
        for subtype in ('thinking_tokens', 'status'):
            self.assertIsNone(self.channel.provider(self.frame(subtype)))
        self.assertEqual(self.channel.terminal_uuid, terminal)
        with self.assertRaises(Refused):
            self.channel.provider(self.fixture.terminal())

    def test_missing_foreign_or_widened_scope_and_authority_fields_refuse(self):
        for key in ('session_id', 'user_message_uuid', 'uuid'):
            self.refuse(lambda f, k=key: f.pop(k))
        for key in ('session_id', 'user_message_uuid'):
            self.refuse(lambda f, k=key: f.update({k: str(uuid.uuid4())}))
        for value in ([], [str(uuid.uuid4())], [control.INPUT, control.INPUT]):
            self.refuse(lambda f, v=value: f.update(user_message_uuids=v), 'status')
        self.refuse(lambda f: f.pop('user_message_uuids'), 'status')
        for key in ('terminal_reason', 'result', 'request_id', 'permissionMode', 'is_error'):
            self.refuse(lambda f, k=key: f.update({k: 'synthetic'}))
        for value in (None, 'compacting', 'stopped', 'completed'):
            self.refuse(lambda f, v=value: f.update(status=v), 'status')

    def test_numeric_bounds_and_identity_reuse_refuse(self):
        for key in ('estimated_tokens', 'estimated_tokens_delta'):
            for value in (True, -1, 1.5, 2**53, '3'):
                self.refuse(lambda f, k=key, v=value: f.update({k: v}))
        for value in ('bad', str(uuid.UUID(int=0)), control.INPUT):
            self.refuse(lambda f, v=value: f.update(uuid=v))
        self.setUp()
        frame = self.frame(); self.assertIsNone(self.channel.provider(frame))
        with self.assertRaises(Refused): self.channel.provider(frame)
        self.setUp()
        frame = self.frame(); self.channel.output_uuids.add(frame['uuid'])
        with self.assertRaises(Refused): self.channel.provider(frame)
        self.setUp(); self.channel.output_uuid_overflow = True
        with self.assertRaises(Refused): self.channel.provider(self.frame())

    def test_shared_budget_and_unknown_system_remain_refused(self):
        self.channel.telemetry_uuids.update(str(uuid.uuid4()) for _ in range(127))
        self.assertIsNone(self.channel.provider(self.frame()))
        with self.assertRaises(Refused): self.channel.provider(self.frame('status'))
        self.refuse(lambda f: f.update(subtype='unrecognized_system'))
        self.setUp()
        with self.assertRaises(Refused):
            self.channel.provider({'type':'system','subtype':'init','session_id':self.channel.native})


if __name__ == '__main__':
    unittest.main()
