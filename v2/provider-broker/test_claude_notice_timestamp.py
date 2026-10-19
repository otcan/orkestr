"""Native user-notice timestamps remain discard-only during issued Stop."""
import copy
import unittest
import uuid

from protocol import Refused
import test_claude_control as control


class NoticeTimestampTests(unittest.TestCase):
    def setUp(self):
        self.fixture = control.ClaudeControlTests()
        self.fixture.setUp()
        self.channel = self.fixture.channel
        self.channel.client(self.fixture.request())

    def notice(self):
        return {'type': 'user', 'session_id': self.fixture.fixture.native,
                'uuid': '66666666-6666-4666-8666-666666666666',
                'parent_tool_use_id': None, 'timestamp': '2026-01-01T00:00:00.000Z',
                'message': {'role': 'user', 'content': [
                    {'type': 'text', 'text': 'synthetic interrupted notice'}]}}

    def assert_no_authority(self):
        self.assertFalse(self.channel.terminal or self.channel.control.ack)
        self.assertIsNone(self.channel.terminal_uuid)
        self.assertIsNone(self.channel.control.terminal)

    def refuse(self, frame):
        with self.assertRaises(Refused):
            self.channel.provider(frame)
        self.assertTrue(self.channel.poisoned)
        self.assert_no_authority()

    def test_timestamp_is_discarded_without_output_or_authority(self):
        frame = self.notice(); original = copy.deepcopy(frame)
        self.assertIsNone(self.channel.provider(frame))
        self.assertEqual(frame, original)
        self.assertEqual(self.channel.control.notices, 1)
        self.assertEqual(self.channel.control.notice_ids, {frame['uuid']})
        self.assert_no_authority()

    def test_optional_absence_and_clock_values_never_change_authority(self):
        for timestamp in (None, '2000-02-29T23:59:59.999Z', '2099-12-31T00:00:00.001Z'):
            with self.subTest(timestamp=timestamp):
                self.setUp(); frame = self.notice()
                if timestamp is None: del frame['timestamp']
                else: frame['timestamp'] = timestamp
                self.assertIsNone(self.channel.provider(frame))
                self.assert_no_authority()

    def test_noncanonical_or_invalid_calendar_timestamps_refuse(self):
        for timestamp in (None, True, 0, {}, [], '', 'x'*129,
                          '2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000+00:00',
                          '2026-01-01T00:00:00.000000Z', '2026-1-01T00:00:00.000Z',
                          '2026-01-01T00:00:00.000Z\n', '2026-01-01T00:00:00.000\0',
                          '2026-02-29T00:00:00.000Z', '2026-13-01T00:00:00.000Z',
                          '2026-01-01T24:00:00.000Z', '2026-01-01T00:00:60.000Z',
                          '２０２６-01-01T00:00:00.000Z'):
            with self.subTest(timestamp=timestamp):
                self.setUp(); frame = self.notice(); frame['timestamp'] = timestamp
                self.refuse(frame)

    def test_timestamp_does_not_authorize_an_uncancelled_user_frame(self):
        self.fixture.setUp(); self.channel = self.fixture.channel
        with self.assertRaises(Refused): self.channel.provider(self.notice())
        self.assertIsNone(self.channel.control)
        self.assertFalse(self.channel.terminal)

    def test_current_identity_and_replay_checks_still_apply(self):
        for field, value in (('session_id', str(uuid.uuid4())),
                             ('user_message_uuid', str(uuid.uuid4())),
                             ('user_message_uuids', []), ('uuid', control.INPUT),
                             ('uuid', 'bad'), ('parent_tool_use_id', 'tool')):
            with self.subTest(field=field):
                self.setUp(); frame = self.notice(); frame[field] = value
                self.refuse(frame)
        self.setUp(); frame = self.notice(); self.channel.provider(frame)
        self.refuse(frame)

    def test_timestamp_is_user_notice_only(self):
        frame = self.notice(); frame['type'] = frame['message']['role'] = 'assistant'
        self.refuse(frame)

    def test_other_native_intent_tool_and_unknown_fields_remain_closed(self):
        for key, value in (('shouldQuery', True), ('priority', 'now'),
                           ('origin', {'kind': 'human'}), ('is_virtual', True),
                           ('interrupted_message_id', 'msg_synthetic'),
                           ('refused_message_id', 'msg_synthetic'),
                           ('tool_use_result', {}), ('tool_result_meta', []),
                           ('is_api_error_message', True), ('unknown', None)):
            with self.subTest(key=key):
                self.setUp(); frame = self.notice(); frame[key] = value
                self.refuse(frame)
        self.setUp(); frame = self.notice()
        frame['message']['content'] = [{'type': 'tool_result', 'content': 'synthetic'}]
        self.refuse(frame)

    def test_original_frame_size_and_notice_count_budgets_remain(self):
        frame = self.notice()
        frame['message']['content'] = [{'type': 'text', 'text': 'x'*8192}]*2
        self.refuse(frame)
        self.setUp()
        for _ in range(128):
            frame = self.notice(); frame['uuid'] = str(uuid.uuid4())
            self.assertIsNone(self.channel.provider(frame))
        self.assertEqual(self.channel.control.notices, 128)
        self.assert_no_authority()
        frame['uuid'] = str(uuid.uuid4()); self.refuse(frame)

    def test_separate_ack_and_genuine_terminal_still_required(self):
        self.channel.provider(self.notice())
        self.channel.provider(self.fixture.ack())
        self.assertTrue(self.channel.control.ack)
        self.assertFalse(self.channel.terminal)
        output = self.channel.provider(self.fixture.terminal())
        self.assertEqual(output['params']['frame']['terminal_reason'], 'aborted_streaming')
        self.assertTrue(self.channel.terminal)
        frame = self.notice(); frame['uuid'] = str(uuid.uuid4())
        with self.assertRaises(Refused): self.channel.provider(frame)


if __name__ == '__main__': unittest.main()
