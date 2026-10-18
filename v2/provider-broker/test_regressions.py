"""Independent review regressions, synthetic protocol and mocked I/O only."""
import io
import json
import unittest
from unittest.mock import patch
from protocol import Refused, decode, encode
from test_protocol import opened, ready, request, turn
from transport import Pump, MAX_PENDING
import server

class ReviewRegressions(unittest.TestCase):
    def committed(self):
        channel, _ = opened()
        ready(channel)
        request(channel, turn(), "CommitExecution", 6)
        return channel

    def test_malformed_nested_turns_refuse_without_attribute_errors(self):
        for value in (None, [], 1, "invalid"):
            with self.assertRaises(Refused):
                self.committed().provider({"id":4,"result":{"turn":value}})
            with self.assertRaises(Refused):
                self.committed().provider({"method":"turn/completed","params":{
                    "threadId":"synthetic-native","turn":value}})

    def test_strict_utf8_and_finite_numbers(self):
        for raw in ['{"value":true}'.encode('utf-16'), b'{"value":1e999}', b'-1e999']:
            with self.assertRaises(Refused):
                decode(raw)

    def test_bounded_burst_drains_all_frames_without_replay(self):
        channel = self.committed()
        channel.provider({"id":4,"result":{"turn":{"id":"synthetic-turn","status":"inProgress"}}})
        pump = Pump(None, channel, incoming=100, outgoing=101)
        wire = b''.join(encode({"method":"item/agentMessage/delta","params":{
            "threadId":"synthetic-native","turnId":"synthetic-turn","delta":str(i)}}) for i in range(19))
        try:
            with patch('transport.os.read', return_value=wire):
                self.assertTrue(pump.read(102))
            self.assertEqual(len(pump.queues[101]), MAX_PENDING)
            sent = []
            def write(_fd, data):
                sent.append(json.loads(data)); return len(data)
            with patch('transport.os.write', side_effect=write):
                while pump.queues[101]:
                    self.assertLessEqual(len(pump.queues[101]), MAX_PENDING)
                    pump.write(101)
            self.assertEqual([x['params']['frame']['params']['delta'] for x in sent], [str(i) for i in range(19)])
            self.assertEqual(pump.buffers[102], b'')
        finally:
            pump.selector.close()

    def test_server_exception_boundary_never_prints_traceback_or_path(self):
        for exception in [AttributeError('/synthetic/private/path'), OSError('/synthetic/cleanup')]:
            output = io.StringIO()
            with patch.object(server.sys, 'argv', ['server','open-owned-session','--protocol',server.PROTOCOL]), \
                 patch.object(server.signal, 'signal'), patch.object(server.Configuration, 'load'), \
                 patch.object(server.Pump, 'run', side_effect=exception), patch.object(server.sys, 'stderr', output):
                self.assertEqual(server.main('/synthetic/config'), 2)
            self.assertEqual(output.getvalue(), 'provider broker refused; reconcile uncertain delivery\n')

    def test_subscription_provider_evidence_is_required_and_retained(self):
        channel, _ = opened()
        channel.stage = 'initialized'
        request(channel, {'id':1,'method':'account/read','params':{'refreshToken':False}})
        with self.assertRaises(Refused):
            channel.provider({'id':1,'result':{'requiresOpenaiAuth':False,'account':{'type':'chatgpt'}}})
        for provider in [None, 'external', 'openai']:
            channel, _ = opened(); channel.stage='subscription'
            request(channel, {'id':3,'method':'thread/start','params':{
                'cwd':channel.workspace,'approvalPolicy':'never','sandbox':'read-only','ephemeral':False,'modelProvider':'openai'}})
            result={'thread':{'id':'synthetic-native','cwd':channel.workspace,'ephemeral':False,'modelProvider':provider},
                'cwd':channel.workspace,'modelProvider':'openai','approvalPolicy':'never','sandbox':{'type':'readOnly','networkAccess':False}}
            if provider != 'openai':
                with self.assertRaises(Refused): channel.provider({'id':3,'result':result})
            else:
                clean=channel.provider({'id':3,'result':result})['result']['frame']['result']
                self.assertEqual(clean['modelProvider'], 'openai')
                self.assertEqual(clean['thread']['modelProvider'], 'openai')
