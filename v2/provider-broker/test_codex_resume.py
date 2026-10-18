"""Closed resume framing; bootstrap alone never grants inference authority."""
import unittest
from protocol import Channel, PROTOCOL, Refused
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
            'approvalPolicy': 'never', 'sandbox': 'read-only', 'modelProvider': 'openai'}}

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
