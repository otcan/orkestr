"""Owned-pipe control is trusted parent input, never proof of a Core receipt."""
import unittest
from protocol import Refused
from test_protocol import opened, ready, request, turn

class ControlTests(unittest.TestCase):
    def active(self):
        channel, _ = opened(); ready(channel)
        request(channel, turn(), 'CommitExecution', 6)
        channel.provider({'id':4,'result':{'turn':{'id':'synthetic-turn','status':'inProgress'}}})
        return channel
    def test_interrupt_exact_native_once_and_never_metadata(self):
        frame={'id':5,'method':'turn/interrupt','params':{'threadId':'synthetic-native','turnId':'synthetic-turn'}}
        channel=self.active()
        forwarded,_=request(channel,frame,'CancelExecution',7)
        self.assertEqual(forwarded,frame)
        channel.provider({'id':5,'result':{}})
        with self.assertRaises(Refused): request(channel,frame,'CancelExecution',8)
        for method in ['BrokerMetadata','CommitExecution']:
            with self.assertRaises(Refused): request(self.active(),frame,method,7)
        for field in ['threadId','turnId']:
            wrong={'id':5,'method':'turn/interrupt','params':dict(frame['params'],**{field:'foreign'})}
            with self.assertRaises(Refused): request(self.active(),wrong,'CancelExecution',7)
    def test_followup_requires_terminal_and_distinct_consumed_message(self):
        channel=self.active()
        channel.provider({'method':'turn/completed','params':{'threadId':'synthetic-native',
            'turn':{'id':'synthetic-turn','status':'completed'}}})
        with self.assertRaises(Refused): request(channel,turn(),'CommitExecution',7)
        next_frame=turn(); next_frame['id']=8; next_frame['params']['clientUserMessageId']='synthetic-message-2'
        forwarded,_=request(channel,next_frame,'CommitExecution',8)
        self.assertEqual(forwarded,next_frame)
        self.assertEqual(channel.native,'synthetic-native')
        self.assertFalse(channel.terminal)
