"""Deep-only native correlation; no Root, real credentials or business actions."""
from pathlib import Path
import unittest
from protocol import Channel,PROTOCOL,Refused
from desk_tool import advertisement,validate_call
from test_protocol import IDENTITY,request,turn


def active():
    channel=Channel(Path('/synthetic/workspace'),desk_login=True)
    identity={**IDENTITY,'role':'deep'}
    channel.client({'id':1,'method':'OpenOwnedSession','params':{'protocol':PROTOCOL,'identity':identity}})
    channel.stage='ready';channel.native='synthetic-native'
    request(channel,turn(),'CommitExecution',6)
    channel.provider({'id':4,'result':{'turn':{'id':'synthetic-turn','status':'inProgress'}}})
    return channel


def call():
    return {'id':0,'method':'item/tool/call','params':{'tool':'orkestr_desk_login','callId':'call:1',
        'threadId':'synthetic-native','turnId':'synthetic-turn','arguments':{'operation_id':'synthetic-login'}}}


class DeskToolTests(unittest.TestCase):
    def test_only_deep_fixed_profile_accepts_and_burns_one_exact_native_call(self):
        channel=active();output=channel.provider(call())
        self.assertEqual(output['params']['frame']['params']['arguments'],{'operation_id':'synthetic-login'})
        with self.assertRaises(Refused):channel.provider(call())
        for role in ('fast','worker'):
            channel=Channel(Path('/synthetic/workspace'),desk_login=True)
            with self.assertRaises(Refused):channel.client({'id':1,'method':'OpenOwnedSession','params':{
                'protocol':PROTOCOL,'identity':{**IDENTITY,'role':role}}})

    def test_no_caller_role_conversation_command_environment_or_path(self):
        for field,value in [('role','deep'),('conversation','synthetic'),('command','/bin/sh'),('environment',{}),('path','/other')]:
            value_call=call();value_call['params']['arguments'][field]=value
            with self.assertRaises(Refused):validate_call(value_call,'synthetic-native','synthetic-turn')
        value=call();value['params']['threadId']='other-native'
        with self.assertRaises(Refused):validate_call(value,'synthetic-native','synthetic-turn')
        value=call();value['params']['turnId']='other-turn'
        with self.assertRaises(Refused):validate_call(value,'synthetic-native','synthetic-turn')

    def test_setup_requires_exact_desk_advertisement(self):
        channel=active();channel.stage='new'
        initialize={'id':1,'method':'initialize','params':{'clientInfo':{'name':'synthetic','title':'synthetic','version':'1'},'capabilities':{'experimentalApi':True}}}
        channel.metadata(initialize)
        channel.stage='subscription'
        frame={'id':2,'method':'thread/start','params':{'cwd':channel.workspace,'approvalPolicy':'never','sandbox':'read-only','ephemeral':False,'modelProvider':'openai','dynamicTools':[advertisement()]}}
        channel.metadata(frame)
        frame['params']['dynamicTools'][0]['name']='arbitrary-root-shell'
        with self.assertRaises(Refused):channel.metadata(frame)
