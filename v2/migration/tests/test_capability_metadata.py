"""Synthetic responses only; no status API invocation or authentication."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from capability_metadata import personal_agent_observation
from snapshot import Invalid


class CapabilityMetadataTests(unittest.TestCase):
    def response(self, state='available'):
        value = {'enabled': state != 'disabled', 'capability': state == 'available',
                 'assistant': {'available': False, 'reason': 'not_configured'}}
        if state != 'available':
            value['reason'] = state
        return value

    def test_all_source_states_and_no_mutation(self):
        for state in ('available', 'disabled', 'storage_unavailable'):
            value = self.response(state)
            before = deepcopy(value)
            result = personal_agent_observation(value)
            self.assertEqual(result['buckets'][state], 1)
            self.assertEqual(sum(result['buckets'].values()), 1)
            self.assertEqual(value, before)

    def test_raw_fields_refused(self):
        for key in ('accounts', 'token', 'owner', 'error', 'reason'):
            value = self.response()
            value[key] = 'synthetic-private-marker'
            with self.assertRaises(Invalid):
                personal_agent_observation(value)

    def test_non_boolean_and_impossible_flags(self):
        for key, value in (('enabled', 1), ('capability', 0), ('enabled', False)):
            response = self.response()
            response[key] = value
            with self.assertRaises(Invalid):
                personal_agent_observation(response)

    def test_assistant_changes_fail_closed(self):
        for assistant in (None, [], {'available': 0, 'reason': 'not_configured'},
                          {'available': False, 'reason': 'other'},
                          {'available': False, 'reason': 'not_configured', 'id': 'fake'}):
            response = self.response()
            response['assistant'] = assistant
            with self.assertRaises(Invalid):
                personal_agent_observation(response)

    def test_missing_wrong_reason_and_shape(self):
        for value in (None, [], {}, self.response('disabled') | {'reason': 'other'},
                      self.response('available') | {'enabled': True, 'capability': False}):
            with self.assertRaises(Invalid):
                personal_agent_observation(value)
