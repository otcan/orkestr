"""Pure synthetic wire contracts; no provider request or tool execution."""
import copy
import unittest
from offline_tool import NAME, advertisement, validate_call, validate_result
from protocol import Refused


def call():
    return {'id':7,'method':'item/tool/call','params':{'arguments':{'source':'print(1)'},
        'callId':'synthetic-call','threadId':'synthetic-native','turnId':'synthetic-turn','tool':NAME}}


class OfflineToolTests(unittest.TestCase):
    def test_closed_spec_and_bound_call(self):
        self.assertEqual(advertisement()['inputSchema']['additionalProperties'],False)
        frame=call();clean=validate_call(frame,'synthetic-native','synthetic-turn')
        frame['params']['arguments']['source']='changed'
        self.assertEqual(clean['params']['arguments']['source'],'print(1)')
        frame=call();frame['params']['namespace']=None
        validate_call(frame,'synthetic-native','synthetic-turn')

    def test_foreign_or_generic_provider_request_refused(self):
        for key,value in (('threadId','foreign'),('turnId','foreign'),('tool','shell'),
                          ('namespace','external'),('arguments',{'source':'x','path':'/synthetic'})):
            frame=call();frame['params'][key]=value
            with self.assertRaises(Refused):validate_call(frame,'synthetic-native','synthetic-turn')
        for source in ('','x'*32769,'\0'):
            frame=call();frame['params']['arguments']['source']=source
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
