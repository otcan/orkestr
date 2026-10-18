"""Unsupported auth routes remain closed; synthetic inputs never reach native."""
import unittest
from protocol import Refused
from test_protocol import opened, request, ready


class ManagedAuthBoundaryTests(unittest.TestCase):
    def test_external_token_login_and_auth_mutation_not_metadata(self):
        for method,params in (
            ('account/login/start',{'type':'chatgptAuthTokens','accessToken':'synthetic-not-a-token',
                                    'chatgptAccountId':'synthetic-account'}),
            ('account/login/start',{'type':'apiKey','apiKey':'synthetic-not-a-key'}),
            ('account/logout',{}),
            ('account/read',{'refreshToken':True}),
        ):
            with self.subTest(method=method,params=params):
                channel,_=opened()
                ready(channel)
                with self.assertRaises(Refused):
                    request(channel,{'id':50,'method':method,'params':params},outer=20)

    def test_server_external_token_refresh_is_not_a_passthrough(self):
        channel,_=opened();ready(channel)
        with self.assertRaises(Refused):
            channel.provider({'id':50,'method':'account/chatgptAuthTokens/refresh',
                'params':{'reason':'unauthorized','previousAccountId':'synthetic-account'}})
        with self.assertRaises(Refused):
            channel.provider({'id':50,'result':{'accessToken':'synthetic-not-a-token',
                'chatgptAccountId':'synthetic-account'}})
