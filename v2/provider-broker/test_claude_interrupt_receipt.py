"""Pinned interrupt receipt metadata cannot supply terminal or reap evidence."""
import copy
import unittest

from protocol import Refused, encode
import test_claude_control as control_fixtures


class ClaudeInterruptReceiptTests(unittest.TestCase):
    def setup_control(self):
        fixture = control_fixtures.ClaudeControlTests()
        fixture.setUp()
        fixture.channel.client(fixture.request())
        return fixture

    def native_ack(self, fixture):
        frame = fixture.ack()
        frame['response']['response']['still_queued'] = []
        return frame

    def assert_refused(self, change):
        fixture = self.setup_control()
        frame = self.native_ack(fixture)
        change(frame)
        with self.assertRaises(Refused):
            fixture.channel.provider(frame)
        self.assertFalse(fixture.channel.control.ack)
        self.assertFalse(fixture.channel.terminal)
        self.assertTrue(fixture.channel.poisoned)

    def test_empty_survivors_emit_the_unchanged_ack_without_terminal(self):
        fixture = self.setup_control()
        frame = self.native_ack(fixture)
        original = copy.deepcopy(frame)
        output = fixture.channel.provider(frame)
        expected = {'method': 'BrokerOutput', 'params': {
            'owned_handle': fixture.fixture.handle, 'request_id': 3,
            'frame': fixture.ack()}}
        self.assertEqual(output, expected)
        self.assertEqual(encode(output), encode(expected))
        self.assertEqual(frame, original)
        self.assertTrue(fixture.channel.control.ack)
        self.assertFalse(fixture.channel.terminal)
        self.assertIsNone(fixture.channel.terminal_uuid)
        self.assertIsNone(fixture.channel.control.terminal)

    def test_optional_absence_preserves_the_same_output(self):
        fixture = self.setup_control()
        output = fixture.channel.provider(fixture.ack())
        self.assertEqual(output['params']['frame'], fixture.ack())
        self.assertTrue(fixture.channel.control.ack)
        self.assertFalse(fixture.channel.terminal)

    def test_both_orders_still_require_the_separate_exact_terminal(self):
        for terminal_first in (False, True):
            with self.subTest(terminal_first=terminal_first):
                fixture = self.setup_control()
                frames = [self.native_ack(fixture), fixture.terminal()]
                if terminal_first:
                    frames.reverse()
                first = fixture.channel.provider(frames[0])
                self.assertEqual(fixture.channel.terminal, terminal_first)
                self.assertEqual(fixture.channel.control.ack, not terminal_first)
                second = fixture.channel.provider(frames[1])
                self.assertTrue(fixture.channel.control.ack and fixture.channel.terminal)
                self.assertEqual({first['params']['request_id'], second['params']['request_id']}, {2, 3})
                self.assertNotIn('still_queued', repr((first, second)))

    def test_nonempty_or_wrong_type_survivors_refuse_before_ack(self):
        for value in (['33333333-3333-4333-8333-333333333333'], [None], [[]],
                      {}, None, '', False, 0):
            with self.subTest(value=value):
                self.assert_refused(lambda frame: frame['response']['response'].update(still_queued=value))

    def test_other_interrupt_modes_and_unknown_keys_remain_closed(self):
        for name, value in (('send_now', 'stopped'), ('cancelled', []), ('unknown', None)):
            with self.subTest(name=name):
                self.assert_refused(lambda frame: frame['response']['response'].update({name: value}))

    def test_exact_request_and_stopped_verdict_remain_required(self):
        for field, value in (('request_id', 'foreign'), ('subtype', 'error'),
                             ('pending_permission_requests', [{}]),
                             ('pending_user_dialog_requests', [{}])):
            with self.subTest(field=field):
                self.assert_refused(lambda frame: frame['response'].update({field: value}))
        for value in ('idle', 'spared', None, True):
            with self.subTest(turn=value):
                self.assert_refused(lambda frame: frame['response']['response'].update(turn=value))
        self.assert_refused(lambda frame: frame['response']['response'].pop('turn'))
        self.assert_refused(lambda frame: frame.update(unknown=True))
        self.assert_refused(lambda frame: frame['response'].update(unknown=True))

    def test_ack_replay_remains_refused_without_terminal_credit(self):
        fixture = self.setup_control()
        frame = self.native_ack(fixture)
        fixture.channel.provider(frame)
        with self.assertRaises(Refused):
            fixture.channel.provider(frame)
        self.assertTrue(fixture.channel.control.ack)
        self.assertFalse(fixture.channel.terminal)

    def test_ack_cannot_replace_missing_or_foreign_terminal_evidence(self):
        for field in ('session_id', 'user_message_uuid', 'uuid', 'terminal_reason'):
            for missing in (False, True):
                with self.subTest(field=field, missing=missing):
                    fixture = self.setup_control()
                    fixture.channel.provider(self.native_ack(fixture))
                    terminal = fixture.terminal()
                    if missing:
                        terminal.pop(field)
                    else:
                        terminal[field] = 'foreign'
                    with self.assertRaises(Refused):
                        fixture.channel.provider(terminal)
                    self.assertTrue(fixture.channel.control.ack)
                    self.assertFalse(fixture.channel.terminal)


if __name__ == '__main__':
    unittest.main()
