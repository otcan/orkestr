"""Native lifecycle metadata never supplies readiness, completion or control."""
import copy
import unittest

import test_claude_telemetry as fixtures
from protocol import Refused


STATES = ('queued', 'started', 'completed', 'cancelled', 'discarded', 'refused')


class ClaudeLifecycleTelemetryTests(unittest.TestCase):
    setUp = fixtures.ClaudeTelemetryTests.setUp
    init = fixtures.ClaudeTelemetryTests.init
    request = fixtures.ClaudeTelemetryTests.request
    telemetry = fixtures.ClaudeTelemetryTests.telemetry

    def admit(self, terminal=False):
        self.init()
        self.channel.client(self.request(2))
        if terminal:
            self.channel.provider({'type': 'system', 'subtype': 'init',
                                   'session_id': self.native})
            self.channel.provider({'type': 'result', 'subtype': 'success',
                'is_error': False, 'session_id': self.native, 'result': 'synthetic',
                'uuid': '55555555-5555-4555-8555-555555555555'})

    def authority(self):
        return (self.channel.initialized, self.channel.system_seen,
                self.channel.active, self.channel.terminal,
                self.channel.terminal_uuid, self.channel.input_uuid)

    def test_every_native_state_before_init_and_after_terminal_is_only_metadata(self):
        for terminal in (False, True):
            for state in STATES:
                with self.subTest(terminal=terminal, state=state):
                    self.setUp()
                    self.admit(terminal)
                    before = self.authority()
                    frame = self.telemetry()
                    frame['state'] = state
                    self.assertIsNone(self.channel.provider(frame))
                    self.assertEqual(self.authority(), before)
                    self.assertFalse(self.channel.poisoned)

    def test_new_terminal_metadata_states_cannot_create_control_or_continuation(self):
        for state in ('cancelled', 'discarded', 'refused'):
            with self.subTest(state=state):
                self.setUp()
                self.admit()
                frame = self.telemetry()
                frame['state'] = state
                self.assertIsNone(self.channel.provider(frame))
                self.assertFalse(self.channel.system_seen or self.channel.terminal)
                request = self.request(3, 'message:2')
                with self.assertRaises(Refused):
                    self.channel.client(request)
                request = copy.deepcopy(self.request(4, 'message:3'))
                request['method'] = 'CancelExecution'
                with self.assertRaises(Refused):
                    self.channel.client(request)
                self.assertFalse(self.channel.system_seen or self.channel.terminal)

    def test_unknown_or_malformed_states_refuse_before_authority_changes(self):
        for value in ('stopped', 'interrupted', 'aborted_streaming', 'CANCELLED',
                      '', None, 1, True, [], {}):
            with self.subTest(value=value):
                self.setUp()
                self.admit(True)
                before = self.authority()
                frame = self.telemetry()
                frame['state'] = value
                with self.assertRaises(Refused):
                    self.channel.provider(frame)
                self.assertTrue(self.channel.poisoned)
                self.assertEqual(self.authority(), before)

    def test_added_states_keep_exact_fields_and_scope(self):
        for state in ('cancelled', 'discarded', 'refused'):
            for key, value in (
                ('session_id', '44444444-4444-4444-8444-444444444444'),
                ('command_uuid', '44444444-4444-4444-8444-444444444444'),
                ('request', {'subtype': 'interrupt'}), ('subtype', 'init'),
                ('terminal_reason', 'aborted_streaming'), ('is_error', True),
                ('result', 'synthetic payload'),
            ):
                with self.subTest(state=state, key=key):
                    self.setUp()
                    self.admit(True)
                    before = self.authority()
                    frame = self.telemetry()
                    frame.update(state=state)
                    frame[key] = value
                    with self.assertRaises(Refused):
                        self.channel.provider(frame)
                    self.assertTrue(self.channel.poisoned)
                    self.assertEqual(self.authority(), before)

    def test_added_states_still_require_unique_bounded_event_identities(self):
        self.admit(True)
        before = self.authority()
        frame = self.telemetry()
        frame['state'] = 'cancelled'
        self.assertIsNone(self.channel.provider(frame))
        with self.assertRaises(Refused):
            self.channel.provider(frame)
        self.assertEqual(self.authority(), before)
        self.setUp()
        self.admit()
        before = self.authority()
        for _ in range(128):
            frame = self.telemetry()
            frame['state'] = 'discarded'
            self.assertIsNone(self.channel.provider(frame))
        frame = self.telemetry()
        frame['state'] = 'refused'
        with self.assertRaises(Refused):
            self.channel.provider(frame)
        self.assertEqual(self.authority(), before)

    def test_added_states_cannot_supply_setup_or_accept_second_terminal(self):
        frame = self.telemetry()
        frame['state'] = 'cancelled'
        with self.assertRaises(Refused):
            self.channel.provider(frame)
        self.assertFalse(self.channel.initialized or self.channel.system_seen)
        self.setUp()
        self.admit(True)
        before = self.authority()
        frame = self.telemetry()
        frame['state'] = 'cancelled'
        self.assertIsNone(self.channel.provider(frame))
        with self.assertRaises(Refused):
            self.channel.provider({'type': 'result', 'subtype': 'error_during_execution',
                'is_error': True, 'session_id': self.native, 'result': 'synthetic',
                'uuid': '66666666-6666-4666-8666-666666666666'})
        self.assertTrue(self.channel.poisoned)
        self.assertEqual(self.authority(), before)


if __name__ == '__main__':
    unittest.main()
