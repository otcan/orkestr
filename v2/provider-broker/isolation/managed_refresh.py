"""Trusted managed account/read refresh callback; no external-token login route."""
import json


class ManagedAccountRefresh:
    """Install only inside the sole canonical writer's serialized owner.

    exchange owns an already initialized pinned native connection and must enforce
    the supplied wall deadline/response byte bound, cleanup and exact correlation.
    publish advances the private selected generation only after identity checks.
    Neither callback nor private identity is supplied by ordinary clients.
    """
    __slots__=('_exchange','_publish','_expected')

    def __init__(self, exchange, publish, expected):
        fields={'email','planType','chatgptAccountId','backendOrigin','accountRoutingOverride'}
        if (not callable(exchange) or not callable(publish) or not isinstance(expected,dict)
                or set(expected)!=fields or any(not isinstance(v,str) or not 0<len(v)<=512
                                               for v in expected.values())):
            raise ValueError('private managed refresh identity required')
        if expected['accountRoutingOverride'] not in ('NO_CONSTRAINT','us','us_cr'):
            raise ValueError('private managed refresh routing required')
        self._exchange,self._publish,self._expected=exchange,publish,dict(expected)

    def __reduce__(self):raise TypeError('private managed refresh')
    def __copy__(self):raise TypeError('private managed refresh')
    def __deepcopy__(self,memo):raise TypeError('private managed refresh')

    def __call__(self):
        try:
            # Dedicated trusted connection, one fixed correlated request; never
            # forwarded through the isolated metadata whitelist or turn channel.
            response=self._exchange({'id':1,'method':'account/read',
                                     'params':{'refreshToken':True}},
                                    timeout_seconds=15,max_response_bytes=16384)
            if len(json.dumps(response,allow_nan=False).encode())>16384:raise ValueError()
            if not isinstance(response,dict) or set(response)!={'id','result'}:raise ValueError()
            if type(response['id']) is not int or response['id']!=1:raise ValueError()
            result=response['result']
            if (not isinstance(result,dict) or set(result)!={'account','requiresOpenaiAuth','workspaceRouting'}
                    or result['requiresOpenaiAuth'] is not True):raise ValueError()
            account=result['account'];routing=result['workspaceRouting']
            if not isinstance(account,dict) or set(account)!={'type','email','planType'}:raise ValueError()
            if account['type']!='chatgpt':raise ValueError()
            if not isinstance(routing,dict) or set(routing)!={'chatgptAccountId','backendOrigin','accountRoutingOverride'}:
                raise ValueError()
            actual={**routing,'email':account['email'],'planType':account['planType']}
            if actual!=self._expected:raise ValueError()
            # No raw response/account payload returned to ordinary composition.
            self._publish()
        except Exception:raise ValueError('managed account refresh refused') from None
