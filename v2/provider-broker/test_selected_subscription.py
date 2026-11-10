"""Synthetic current-account/revision checks, no credential store or network."""
import os
import unittest
from isolation.selected_subscription import SelectedSubscription


class SubscriptionTests(unittest.TestCase):
    def setUp(self):
        self.profile=object()
        self.identity={'owner_id':'synthetic-owner','account_id':'synthetic-account','credential_revision':3}
        self.current={**self.identity,'provider':'claude-code','auth_mode':'subscription',
            'authentication_method':'subscription_token','state':'ready','token':'synthetic-selected'}
        self.binding=SelectedSubscription(self.profile,self.identity,lambda:dict(self.current))

    def test_current_selection_crosses_only_once(self):
        cap=self.binding.acquire();fd=cap._take(self.profile)
        try:self.assertEqual(os.read(fd,16384),b'synthetic-selected')
        finally:os.close(fd)
        with self.assertRaises(ValueError):cap._take(self.profile)

    def test_changed_account_revision_provider_state_refused_before_memfd(self):
        for key,value in (('owner_id','foreign'),('account_id','foreign'),
            ('credential_revision',4),('provider','external'),('auth_mode','api'),
            ('authentication_method','browser_login'),('state','revoked'),('token','rotated')):
            with self.subTest(key=key):
                prior=dict(self.current);cap=self.binding.acquire();self.current[key]=value
                with self.assertRaises(ValueError):cap._take(self.profile)
                self.current=prior
                with self.assertRaises(ValueError):cap._take(self.profile)

    def test_no_missing_token_environment_or_exception_fallback(self):
        self.current.pop('token')
        with self.assertRaises(ValueError):self.binding.acquire()
        self.current['token']=''
        with self.assertRaises(ValueError):self.binding.acquire()
        def failed():raise RuntimeError('synthetic-private-detail')
        binding=SelectedSubscription(self.profile,self.identity,failed)
        with self.assertRaisesRegex(ValueError,'^selected subscription unavailable or changed$'):
            binding.acquire()
