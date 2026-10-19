"""Native metadata never replaces correlated interrupted terminal evidence."""
import copy
import unittest

from protocol import Refused
import test_claude_control as control


class StopMetadataTests(unittest.TestCase):
    def setUp(self):
        self.fixture = control.ClaudeControlTests()
        self.fixture.setUp()
        self.channel = self.fixture.channel
        self.channel.client(self.fixture.request())

    def terminal(self):
        frame = self.fixture.terminal()
        frame.update(queued_turn_count=0, result_index=1, safety_stops=0,
                     fast_mode_disabled_reason='synthetic-disabled',
                     timestamp='2026-01-01T00:00:00Z', parent_tool_use_id=None,
                     origin={'kind': 'human'}, subagent_stats={
                         'spawned': 0, 'started_in_background': 0, 'max_depth': 0,
                         'spawned_by_subagents': 0, 'completed': 0, 'failed': 0,
                         'by_type': {}, 'requested': dict.fromkeys(('background', 'foreground', 'unset'), 0),
                         'killed': dict.fromkeys(('parent', 'user', 'system'), 0),
                         'refused': dict.fromkeys(('depth_limit', 'concurrency_limit', 'budget'), 0)})
        return frame

    def test_native_metadata_is_stripped_without_changing_ack_or_terminal(self):
        for ack_first in (True, False):
            self.setUp()
            if ack_first: self.channel.provider(self.fixture.ack())
            frame = self.terminal(); original = copy.deepcopy(frame)
            clean = self.channel.provider(frame)['params']['frame']
            self.assertEqual(frame, original)
            self.assertEqual(set(clean), {'type', 'session_id', 'uuid', 'user_message_uuid',
                                         'subtype', 'is_error', 'terminal_reason'})
            self.assertEqual(clean['terminal_reason'], 'aborted_streaming')
            self.assertEqual(self.channel.control.ack, ack_first)
            if not ack_first: self.channel.provider(self.fixture.ack())
            self.assertTrue(self.channel.terminal and self.channel.control.ack)
            with self.assertRaises(Refused): self.channel.provider(frame)

    def test_metadata_cannot_replace_required_authority(self):
        for field in ('session_id', 'user_message_uuid', 'uuid', 'subtype', 'is_error', 'terminal_reason'):
            self.setUp(); frame = self.terminal(); del frame[field]
            with self.assertRaises(Refused): self.channel.provider(frame)
            self.assertFalse(self.channel.terminal or self.channel.control.ack)
        for field, value in (('user_message_uuid', 'foreign'), ('terminal_reason', 'aborted_tools'),
                             ('subtype', 'success'), ('is_error', False)):
            self.setUp(); frame = self.terminal(); frame[field] = value
            with self.assertRaises(Refused): self.channel.provider(frame)
            self.assertFalse(self.channel.terminal)

    def test_malformed_interleaved_tool_and_unknown_metadata_refuse(self):
        changes = [('queued_turn_count', 1), ('queued_turn_count', True), ('result_index', -1),
                   ('safety_stops', 2**53), ('timestamp', 'x'*129),
                   ('fast_mode_disabled_reason', {}), ('parent_tool_use_id', 'tool'),
                   ('origin', {'kind': 'peer', 'from': 'foreign'}), ('runner_exit', {}),
                   ('resume_reason', 'automatic-retry'), ('unknown', True)]
        for key, value in changes:
            self.setUp(); frame = self.terminal(); frame[key] = value
            with self.assertRaises((Refused, ValueError)): self.channel.provider(frame)
            self.assertFalse(self.channel.terminal)
        for mutate in (lambda s: s.update(spawned=1), lambda s: s.update(spawned=False),
                       lambda s: s['requested'].update(unset=1), lambda s: s['by_type'].update(other=0),
                       lambda s: s.update(other=0), lambda s: s.pop('killed')):
            self.setUp(); frame = self.terminal(); mutate(frame['subagent_stats'])
            with self.assertRaises(Refused): self.channel.provider(frame)
            self.assertFalse(self.channel.terminal)

    def test_whole_original_bound_is_checked_before_discard(self):
        frame = self.terminal(); frame['subagent_stats']['by_type'] = {'x'*16384: 0}
        with self.assertRaises(Refused): self.channel.provider(frame)
        self.assertFalse(self.channel.terminal)


if __name__ == '__main__': unittest.main()
