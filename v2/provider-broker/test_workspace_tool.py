"""Pure synthetic wire contracts; no provider request or tool execution."""
import copy
import unittest
from workspace_tool import NAME, advertisement, validate_call, validate_result
from protocol import Refused


def call():
    return {'id':7,'method':'item/tool/call','params':{'arguments':{'command':'print(1)'},
        'callId':'synthetic-call','threadId':'synthetic-native','turnId':'synthetic-turn','tool':NAME}}


class WorkspaceToolTests(unittest.TestCase):
    def test_closed_spec_and_bound_call(self):
        self.assertEqual(advertisement()['inputSchema']['additionalProperties'],False)
        frame=call();clean=validate_call(frame,'synthetic-native','synthetic-turn')
        frame['params']['arguments']['command']='changed'
        self.assertEqual(clean['params']['arguments']['command'],'print(1)')
        frame=call();frame['params']['namespace']=None
        validate_call(frame,'synthetic-native','synthetic-turn')

    def test_foreign_or_generic_provider_request_refused(self):
        for key,value in (('threadId','foreign'),('turnId','foreign'),('tool','shell'),
                          ('namespace','external'),('arguments',{'command':'x','path':'/synthetic'})):
            frame=call();frame['params'][key]=value
            with self.assertRaises(Refused):validate_call(frame,'synthetic-native','synthetic-turn')
        for source in ('','x'*32769,'\0'):
            frame=call();frame['params']['arguments']['command']=source
            with self.assertRaises(Refused):validate_call(frame,'synthetic-native','synthetic-turn')

    def test_exact_result_no_urls_or_extra_commands(self):
        frame={'id':7,'result':{'contentItems':[{'type':'inputText','text':'synthetic output'}],'success':True}}
        self.assertEqual(validate_result(frame,7),frame)
        for mutation in ('foreign','image','extra','oversize'):
            bad=copy.deepcopy(frame)
            if mutation=='foreign':bad['id']=8
            if mutation=='image':bad['result']['contentItems']=[{'type':'inputImage','imageUrl':'synthetic'}]
            if mutation=='extra':bad['result']['command']='shell'
            if mutation=='oversize':bad['result']['contentItems'][0]['text']='x'*8193
            with self.assertRaises(Refused):validate_result(bad,7)

    def test_tool_result_outer_preserves_native_correlation(self):
        from workspace_tool import validate_submission
        native={'id':'native-request','result':{'contentItems':[
            {'type':'inputText','text':'bounded'}],'success':True}}
        outer={'id':11,'method':'ToolResult','params':{
            'owned_handle':'synthetic-owned','frame':native}}
        clean=validate_submission(outer,'synthetic-owned','native-request')
        self.assertEqual(clean['id'],11)
        self.assertEqual(clean['params']['frame']['id'],'native-request')
        outer['params']['frame']['result']['contentItems'][0]['text']='changed'
        self.assertEqual(clean['params']['frame']['result']['contentItems'][0]['text'],'bounded')
        for mutation in ('handle','native','method','extra'):
            bad=copy.deepcopy(clean)
            if mutation=='handle':bad['params']['owned_handle']='foreign'
            if mutation=='native':bad['params']['frame']['id']='replacement'
            if mutation=='method':bad['method']='BrokerMetadata'
            if mutation=='extra':bad['params']['command']='shell'
            with self.assertRaises(Refused):
                validate_submission(bad,'synthetic-owned','native-request')


    def test_core_native_request_id_boundary(self):
        from workspace_tool import request_id
        for value in (1,2**53-1,'synthetic-id','é'*64):
            self.assertTrue(request_id(value))
        for value in (True,False,0,-1,2**53,1.0,None,'','é'*65,
                      'line\nfeed','nul\0byte','delete\x7f','next\x85line'):
            self.assertFalse(request_id(value))
            frame=call();frame['id']=value
            with self.assertRaises(Refused):
                validate_call(frame,'synthetic-native','synthetic-turn')
