"""Synthetic opt-in channel only; no native writer or sandbox invocation."""
import unittest
from pathlib import Path
from protocol import Channel,PROTOCOL,Refused
from offline_tool import advertisement
from test_protocol import IDENTITY,request,turn
from test_offline_tool import call


def active(enabled=True):
    channel=Channel(Path('/synthetic/workspace'),offline_python=enabled)
    identity={**IDENTITY,'role':'worker'}
    channel.client({'id':1,'method':'OpenOwnedSession','params':{'protocol':PROTOCOL,'identity':identity}})
    # Ready helper uses default closed setup; synthetic active state avoids
    # claiming actual metadata/native/Core readiness in these routing tests.
    channel.stage='ready';channel.native='synthetic-native'
    request(channel,turn(),'CommitExecution',6)
    channel.provider({'id':4,'result':{'turn':{'id':'synthetic-turn','status':'inProgress'}}})
    return channel


class OfflineRouteTests(unittest.TestCase):
    def test_opt_in_request_result_distinct_outer_native_ids_no_ack_claim(self):
        channel=active();output=channel.provider(call())
        self.assertEqual(output['params']['frame']['id'],7)
        result={'id':7,'result':{'contentItems':[{'type':'inputText','text':'synthetic'}],'success':True}}
        native,reply=request(channel,result,'ToolResult',8)
        self.assertEqual(native,result);self.assertEqual(reply['id'],8)
        self.assertIsNone(reply['result']['frame'])
        with self.assertRaises(Refused):request(channel,result,'ToolResult',9)
        with self.assertRaises(Refused):channel.provider(call())

    def test_default_refuses_and_pending_terminal_quarantines(self):
        with self.assertRaises(Refused):active(False).provider(call())
        channel=active();channel.provider(call())
        with self.assertRaises(Refused):channel.provider(call())
        with self.assertRaises(Refused):channel.provider({'method':'turn/completed','params':{
            'threadId':'synthetic-native','turn':{'id':'synthetic-turn','status':'completed'}}})

    def test_closed_setup_requires_fixed_advertisement(self):
        channel=active();channel.stage='new'
        init={'id':1,'method':'initialize','params':{'clientInfo':{'name':'synthetic','title':'synthetic','version':'1'},
                                                  'capabilities':{'experimentalApi':True}}}
        self.assertEqual(channel.metadata(init),'initialize')
        init['params']['capabilities']['experimentalApi']=False
        with self.assertRaises(Refused):channel.metadata(init)
        channel.stage='subscription'
        frame={'id':2,'method':'thread/start','params':{'cwd':channel.workspace,'approvalPolicy':'never',
               'sandbox':'read-only','ephemeral':False,'modelProvider':'openai','dynamicTools':[advertisement()]}}
        self.assertEqual(channel.metadata(frame),'thread/start')
        frame['params']['dynamicTools'][0]['name']='shell'
        with self.assertRaises(Refused):channel.metadata(frame)


    def test_pending_progress_and_exact_typed_native_id(self):
        channel=active();frame=call();frame['id']='7';channel.provider(frame)
        progress=channel.provider({'method':'item/agentMessage/delta','params':{
            'threadId':'synthetic-native','turnId':'synthetic-turn','delta':'bounded'}})
        self.assertEqual(progress['params']['frame']['params']['delta'],'bounded')
        result={'id':7,'result':{'contentItems':[{'type':'inputText','text':'synthetic'}],'success':True}}
        with self.assertRaises(Refused):request(channel,result,'ToolResult',8)
        result['id']='7'
        native,_=request(channel,result,'ToolResult',9)
        self.assertEqual(native['id'],'7')
