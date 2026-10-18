"""Pinned schema-shaped synthetic responses; never proactive live refresh."""
import copy
import threading
import unittest
from isolation.managed_refresh import ManagedAccountRefresh
from isolation.managed_codex import ManagedCodexOwner

EXPECTED={'email':'synthetic@example.invalid','planType':'plus',
          'chatgptAccountId':'synthetic-account','backendOrigin':'https://example.invalid',
          'accountRoutingOverride':'NO_CONSTRAINT'}


def response():
    return {'id':1,'result':{'requiresOpenaiAuth':True,'account':{
        'type':'chatgpt','email':EXPECTED['email'],'planType':'plus'},
        'workspaceRouting':{k:EXPECTED[k] for k in
            ('chatgptAccountId','backendOrigin','accountRoutingOverride')}}}


class ManagedRefreshTests(unittest.TestCase):
    def test_fixed_request_bounded_transport_and_sanitized_completion(self):
        calls=[];published=[]
        def exchange(request,**bounds):
            calls.append((request,bounds));return response()
        refresh=ManagedAccountRefresh(exchange,lambda:published.append(True),EXPECTED)
        self.assertIsNone(refresh())
        self.assertEqual(calls,[({'id':1,'method':'account/read','params':{'refreshToken':True}},
                               {'timeout_seconds':15,'max_response_bytes':16384})])
        self.assertEqual(published,[True])

    def test_foreign_missing_external_or_error_never_publishes(self):
        for mutation in ('foreign','missing','external','auth','id','error','large'):
            frame=copy.deepcopy(response());published=[]
            if mutation=='foreign':frame['result']['workspaceRouting']['chatgptAccountId']='foreign'
            if mutation=='missing':del frame['result']['workspaceRouting']
            if mutation=='external':frame['result']['account']={'type':'apiKey'}
            if mutation=='auth':frame['result']['requiresOpenaiAuth']=False
            if mutation=='id':frame['id']=True
            if mutation=='error':frame={'id':1,'error':{'message':'synthetic private detail'}}
            if mutation=='large':frame['result']['account']['email']='x'*17000
            refresh=ManagedAccountRefresh(lambda *a,**kw:frame,lambda:published.append(True),EXPECTED)
            with self.assertRaisesRegex(ValueError,'^managed account refresh refused$'):refresh()
            self.assertEqual(published,[])

    def test_timeout_quarantines_owner_and_outstanding_handle(self):
        record={'identity':'synthetic','generation':0,'state':'ready'}
        def timeout(*args,**kwargs):raise TimeoutError('synthetic private path')
        refresh=ManagedAccountRefresh(timeout,lambda:None,EXPECTED)
        owner=ManagedCodexOwner('synthetic',lambda:dict(record),lambda:None,supported_refresh=refresh)
        old=owner.select()
        with self.assertRaises(ValueError):owner.refresh()
        with self.assertRaises(ValueError):old.launch()
        with self.assertRaises(ValueError):owner.select()

    def test_owner_serializes_native_refresh_and_generation_publication(self):
        record={'identity':'synthetic','generation':0,'state':'ready'}
        active=[];errors=[];results=[]
        def exchange(*args,**kwargs):
            active.append(1)
            if len(active)!=1:errors.append('overlap')
            active.pop();return response()
        def publish():record['generation']+=1
        refresh=ManagedAccountRefresh(exchange,publish,EXPECTED)
        owner=ManagedCodexOwner('synthetic',lambda:dict(record),lambda:record['generation'],
                                supported_refresh=refresh)
        threads=[threading.Thread(target=lambda:results.append(owner.refresh())) for _ in range(8)]
        for thread in threads:thread.start()
        for thread in threads:thread.join(2);self.assertFalse(thread.is_alive())
        self.assertEqual(errors,[]);self.assertEqual(record['generation'],8)
        self.assertEqual(len(results),8)
        self.assertEqual(owner.select().launch(),8)
