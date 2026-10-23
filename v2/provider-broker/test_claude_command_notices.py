"""Large native command catalogs are discarded, never setup or inference proof."""
import unittest
import uuid
from test_claude_protocol import ClaudeProtocolTests
from protocol import Refused


class CommandNoticeTests(unittest.TestCase):
    def setUp(self):
        self.fixture = ClaudeProtocolTests()
        self.fixture.setUp()
        self.channel = self.fixture.channel
        self.channel.tools = True

    def notice(self, **changes):
        frame = dict(type='system', subtype='commands_changed', session_id=self.fixture.native,
            uuid=str(uuid.uuid4()), commands=[dict(name='synthetic-command',
                description='synthetic description ' * 20, argumentHint='', aliases=[])
                for _ in range(80)])
        frame.update(changes)
        return frame

    def test_catalog_before_first_turn_is_a_bounded_discard_then_real_turn_completes(self):
        self.assertIsNone(self.channel.provider(self.notice()))
        self.assertFalse(self.channel.initialized)
        self.assertFalse(self.channel.system_seen)
        self.assertIsNone(self.channel.active)
        self.fixture.init()
        self.channel.client(self.fixture.request(2))
        self.assertIsNone(self.channel.provider(self.notice()))
        self.assertFalse(self.channel.joined)
        self.assertFalse(self.channel.terminal)
        result = dict(type='result',subtype='success',is_error=False,result='NO_REPLY',
            uuid=str(uuid.uuid4()),session_id=self.fixture.native,
            user_message_uuid='33333333-3333-4333-8333-333333333333')
        self.assertEqual(self.channel.provider(result)['params']['frame']['result'], 'NO_REPLY')

    def test_only_full_access_command_notice_receives_the_larger_bound(self):
        for tools, subtype in [(False,'commands_changed'),(True,'api_retry')]:
            self.setUp()
            self.channel.tools = tools
            with self.assertRaises(Refused):
                self.channel.provider(self.notice(subtype=subtype))

    def test_wrong_scope_unknown_outer_fields_and_oversized_catalog_are_refused(self):
        variants = [dict(session_id=str(uuid.uuid4())),dict(commands='invalid'),
            dict(commands=[{}]*4097),dict(commands=[{'description':'x'*(4*1024*1024)}]),
            dict(method='CommitExecution'),dict(uuid='invalid')]
        for change in variants:
            self.setUp()
            with self.assertRaises(Refused):
                self.channel.provider(self.notice(**change))

    def test_catalog_does_not_escape_notice_count_limit(self):
        self.channel.system_notices = 255
        self.assertIsNone(self.channel.provider(self.notice()))
        with self.assertRaises(Refused):
            self.channel.provider(self.notice())

    def test_only_one_warning_with_byte_count_and_no_catalog_content(self):
        import json
        sizes = []
        self.channel.catalog_warning = sizes.append
        frame = self.notice()
        self.channel.provider(frame)
        self.channel.provider(self.notice())
        self.assertEqual(sizes, [len(json.dumps(frame, allow_nan=False).encode())])
        self.assertGreater(sizes[0], 16384)
