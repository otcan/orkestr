"""Synthetic parent-pipe steer correlation; no Core authority claim."""
import copy
import unittest
from protocol import Refused
import test_control
from test_protocol import request


def steer():
    return {'id':'00000000-0000-4000-8000-000000000001','method':'turn/steer',
            'params':{'threadId':'synthetic-native','expectedTurnId':'synthetic-turn',
                      'input':[{'type':'text','text':'synthetic revision','text_elements':[]}]}}


class SteerTests(unittest.TestCase):
    def active(self):
        return test_control.ControlTests().active()

    def test_correlated_reply_and_progress(self):
        channel=self.active(); frame=steer()
        self.assertEqual(request(channel,frame,'SteerExecution',7),(frame,None))
        progress=channel.provider({'method':'item/agentMessage/delta','params':{
            'threadId':'synthetic-native','turnId':'synthetic-turn','delta':'progress'}})
        self.assertEqual(progress['method'],'BrokerOutput')
        reply=channel.provider({'id':frame['id'],'result':{'turnId':'synthetic-turn'}})
        self.assertEqual(reply['id'],7)
        with self.assertRaises(Refused):request(channel,frame,'SteerExecution',8)

    def test_closed_scope_and_frame(self):
        variations=[]
        for key in ('threadId','expectedTurnId'):
            frame=steer();frame['params'][key]='foreign';variations.append(frame)
        for value in ('not-uuid',1):
            frame=steer();frame['id']=value;variations.append(frame)
        frame=steer();frame['params']['input'][0]['text']='x'*32769;variations.append(frame)
        frame=steer();frame['params']['input'][0]['text']='bad\0';variations.append(frame)
        frame=steer();frame['params']['extra']=True;variations.append(frame)
        for frame in variations:
            with self.assertRaises(Refused):request(self.active(),frame,'SteerExecution',7)
        for method in ('BrokerMetadata','CommitExecution'):
            with self.assertRaises(Refused):request(self.active(),steer(),method,7)
        for state in ('terminal','cancelled','worker','tool'):
            channel=self.active()
            if state=='worker':channel.role='worker'
            elif state=='tool':channel.tool_enabled=True
            else:setattr(channel,state,True)
            with self.assertRaises(Refused):request(channel,steer(),'SteerExecution',7)

    def test_pending_and_wrong_or_late_reply(self):
        for result in ({'turnId':'foreign'},{'turnId':'synthetic-turn','extra':True}):
            channel=self.active();request(channel,steer(),'SteerExecution',7)
            with self.assertRaises(Refused):channel.provider({'id':steer()['id'],'result':result})
        channel=self.active();request(channel,steer(),'SteerExecution',7)
        with self.assertRaises(Refused):request(channel,copy.deepcopy(steer()),'SteerExecution',8)
        channel.provider({'method':'turn/completed','params':{'threadId':'synthetic-native',
            'turn':{'id':'synthetic-turn','status':'completed'}}})
        with self.assertRaises(Refused):channel.provider({'id':steer()['id'],'result':{'turnId':'synthetic-turn'}})
