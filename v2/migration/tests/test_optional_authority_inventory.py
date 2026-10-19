"""Synthetic caller/scope evidence; no connector calls or credentials."""
import unittest
from v2.migration.optional_authority_inventory import classify


class OptionalAuthorityInventoryTests(unittest.TestCase):
    def test_refusal_is_not_absence(self):
        for authority in ('memory', 'google_workspace', 'oxrm'):
            for code, state in ((401, 'authentication_required'), (403, 'caller_refused'),
                                (404, 'route_or_scope_unresolved')):
                result = classify(authority, http_status=code, configured=True)
                self.assertEqual(result['state'], state)
                self.assertTrue(result['preserve_required'])
                self.assertFalse(result['activity_proven'])

    def test_configuration_and_success_need_scope(self):
        self.assertEqual(classify('oxrm', configured=True)['state'], 'configured_unverified')
        self.assertEqual(classify('memory', http_status=200, capability=True)['state'],
                         'scope_unverified')

    def test_scoped_capability_is_not_activity_or_credentials(self):
        result = classify('google_workspace', http_status=200, capability=True, scope_verified=True)
        self.assertEqual(result['state'], 'capability_reported_in_observed_scope')
        self.assertFalse(result['activity_proven'])
        self.assertFalse(result['credential_migration_allowed'])

    def test_disabled_and_unavailable_remain_scoped(self):
        for flags, expected in (({'enabled': False}, 'disabled_in_observed_scope'),
                                ({'capability': False}, 'capability_unavailable_in_observed_scope'),
                                ({}, 'status_shape_unresolved')):
            self.assertEqual(classify('memory', http_status=200, scope_verified=True, **flags)['state'], expected)

    def test_unknown_and_malformed_fail_closed(self):
        self.assertEqual(classify('oxrm', http_status=503)['state'], 'unresolved')
        for kwargs in ({'http_status': True}, {'capability': 'true'}, {'configured': 1},
                       {'scope_verified': 'owner'}, {'http_status': 600}):
            with self.assertRaises(ValueError):
                classify('memory', **kwargs)
        with self.assertRaises(ValueError):
            classify('other')


if __name__ == '__main__':
    unittest.main()
