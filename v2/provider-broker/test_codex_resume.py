"""Closed resume framing; bootstrap alone never grants inference authority."""
import json
import unittest
from protocol import Channel, MAX_FRAME, PROTOCOL, Refused, decode, encode
from transport import Pump
from test_protocol import IDENTITY, request


class ResumeTests(unittest.TestCase):
    def opened(self):
        channel = Channel('/synthetic/workspace', expected_native='synthetic-native')
        channel.client({'id': 1, 'method': 'OpenOwnedSession', 'params': {
            'protocol': PROTOCOL, 'identity': dict(IDENTITY)}})
        channel.stage = 'subscription'
        return channel

    def frame(self):
        return {'id': 3, 'method': 'thread/resume', 'params': {
            'threadId': 'synthetic-native', 'cwd': '/synthetic/workspace',
            'approvalPolicy': 'never', 'sandbox': 'read-only', 'modelProvider': 'openai',
            'excludeTurns': True}}

    def response(self):
        return {'id': 3, 'result': {'thread': {'id': 'synthetic-native',
            'cwd': '/synthetic/workspace', 'ephemeral': False, 'modelProvider': 'openai',
            'turns': []}, 'cwd': '/synthetic/workspace', 'modelProvider': 'openai',
            'approvalPolicy': 'never', 'sandbox': {'type': 'readOnly', 'networkAccess': False}}}

    def test_exact_identity_and_no_fresh_fallback(self):
        channel = self.opened()
        outgoing, _ = request(channel, self.frame())
        self.assertEqual(outgoing, self.frame())
        result = {'thread': {'id': 'synthetic-native', 'cwd': channel.workspace,
            'ephemeral': False, 'modelProvider': 'openai'}, 'cwd': channel.workspace,
            'modelProvider': 'openai', 'approvalPolicy': 'never',
            'sandbox': {'type': 'readOnly', 'networkAccess': False}}
        channel.provider({'id': 3, 'result': result})
        self.assertEqual(channel.native, 'synthetic-native')
        for key, value in [('threadId', 'foreign'), ('cwd', '/foreign'),
                           ('modelProvider', 'external'), ('ephemeral', False)]:
            channel = self.opened()
            frame = self.frame()
            frame['params'][key] = value
            with self.assertRaises(Refused):
                request(channel, frame)
        channel = self.opened()
        frame = self.frame()
        frame['method'] = 'thread/start'
        del frame['params']['threadId']
        frame['params']['ephemeral'] = False
        with self.assertRaises(Refused):
            request(channel, frame)

    def test_foreign_returned_identity_refuses(self):
        channel = self.opened()
        request(channel, self.frame())
        with self.assertRaises(Refused):
            channel.provider({'id': 3, 'result': {'thread': {'id': 'foreign',
                'cwd': channel.workspace, 'ephemeral': False, 'modelProvider': 'openai'},
                'cwd': channel.workspace, 'modelProvider': 'openai',
                'approvalPolicy': 'never', 'sandbox': {'type': 'readOnly'}}})
        self.assertIsNone(channel.native)

    def test_resume_requires_exact_metadata_only_flag(self):
        for value in (False, None, 0, 1, 'true', [], {}):
            with self.subTest(value=value):
                channel = self.opened()
                frame = self.frame()
                frame['params']['excludeTurns'] = value
                with self.assertRaises(Refused):
                    request(channel, frame)
        for key in ('excludeTurns', 'history', 'includeTurns', 'cursor'):
            with self.subTest(key=key):
                channel = self.opened()
                frame = self.frame()
                if key == 'excludeTurns':
                    del frame['params'][key]
                else:
                    frame['params'][key] = False
                with self.assertRaises(Refused):
                    request(channel, frame)

    def test_history_shaped_reply_cannot_confirm_resume(self):
        for turns in ([{'id': 'historical-turn', 'items': [{'text': 'synthetic-history'}]}],
                      None, {}, False, 'history'):
            with self.subTest(turns=turns):
                channel = self.opened()
                request(channel, self.frame())
                frame = self.response()
                frame['result']['thread']['turns'] = turns
                with self.assertRaises(Refused):
                    channel.provider(frame)
                self.assertIsNone(channel.native)
                self.assertEqual(channel.stage, 'subscription')

    def test_resume_history_never_expands_the_wire_bound(self):
        channel = self.opened()
        outgoing, _ = request(channel, self.frame())
        self.assertIs(outgoing['params']['excludeTurns'], True)
        self.assertEqual(MAX_FRAME, 65536)
        response = self.response()
        response['result']['thread']['turns'] = [{'items': [{'text': 'h' * MAX_FRAME}]}]
        oversized = json.dumps(response).encode()
        self.assertGreater(len(oversized), MAX_FRAME)
        pump = Pump(None, channel)
        try:
            with self.assertRaises(Refused):
                pump.line(999, oversized)
        finally:
            pump.selector.close()
        self.assertIsNone(channel.native)
        # A separate successful metadata-only setup fits the original bound;
        # a refused connection never authorizes a retry or a fresh identity.
        channel = self.opened()
        request(channel, self.frame())
        bounded = encode(self.response())
        self.assertLess(len(bounded), 4096)
        accepted = channel.provider(decode(bounded))
        self.assertEqual(channel.native, 'synthetic-native')
        self.assertNotIn('turns', accepted['result']['frame']['result']['thread'])
