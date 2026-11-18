import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import uuid

spec = importlib.util.spec_from_file_location('desktop_control', Path(__file__).resolve().parents[1] / 'desktop_control.py')
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)
CONFIG = {'conversation_id': '11111111-1111-4111-8111-111111111111',
          'v1_thread_id': 'worker-example', 'desktop_slug': 'example-desk',
          'broker_file': '/etc/example/broker.json', 'broker_uid': 1001}


class BindingInspectionTests(unittest.TestCase):
    def lease(self, shared=False, slugs=None, **binding_changes):
        lease = object.__new__(controller.Lease)
        lease.config = CONFIG
        document = {'binding': {'conversation_id': CONFIG['conversation_id'],
                    'v1_thread_id': CONFIG['v1_thread_id'], 'grant_issued': True,
                    'desktop_slugs': slugs or [], **binding_changes},
                    'shared_with_all_chats': shared,
                    'leases': [{'fencing_token': 'must-never-appear'}],
                    'grant': 'must-never-appear'}
        lease.call = lambda: document
        return lease

    def test_shared_flag_is_reported_without_secret_or_unrelated_data(self):
        value = self.lease(shared=True).inspect_binding()
        self.assertTrue(value['shared_with_all_chats'])
        self.assertFalse(value['configured_slug_bound'])
        self.assertNotIn('must-never-appear', json.dumps(value))
        self.assertEqual(set(value), {'conversation_id', 'v1_thread_id', 'desktop_slug',
            'binding_conversation_matches', 'binding_thread_matches', 'bound_desktop_slugs',
            'grant_issued', 'shared_with_all_chats', 'configured_slug_bound'})

    def test_unbound_shared_desk_keeps_operate_enforcement(self):
        # Passing V2 identity/sharing checks must still reach the existing
        # broker permission path, rather than return or acquire a lease early.
        for lease in [self.lease(shared=True), self.lease(slugs=['example-desk'])]:
            with patch.object(controller.Path, 'resolve', side_effect=RuntimeError('broker permission check reached')):
                with self.assertRaisesRegex(RuntimeError, 'broker permission check reached'):
                    lease.binding()

    def test_identity_revocation_and_nonboolean_sharing_never_bypass_binding(self):
        leases = [self.lease(), self.lease(shared='true'), self.lease(shared=1),
                  self.lease(shared=True, grant_issued=False),
                  self.lease(shared=True, conversation_id='different'),
                  self.lease(shared=True, v1_thread_id='different')]
        with patch.object(controller.os, 'open') as open_file:
            for lease in leases:
                with self.assertRaisesRegex(ValueError, 'controller_binding_changed'):
                    lease.binding()
            open_file.assert_not_called()

    def test_read_only_inspection_has_no_framebuffer_lease_or_journal_effect(self):
        with patch.object(controller, 'Lease') as lease, \
             patch.object(controller, 'framebuffer_identity') as framebuffer, \
             patch.object(controller, 'write') as write:
            lease.return_value.inspect_binding.return_value = {'shared_with_all_chats': True}
            result = controller.execute({}, 'inspect-binding', [], None, str(uuid.uuid4()))
            self.assertTrue(result['ok'])
            lease.return_value.call.assert_not_called()
            lease.return_value.binding.assert_not_called()
            framebuffer.assert_not_called()
            write.assert_not_called()


if __name__ == '__main__':
    unittest.main()
