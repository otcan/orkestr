"""Independent synthetic filesystem/authority oracle for the metadata port."""
import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from v2.migration.google_registry_metadata import (
    MAX_BYTES, MAX_CONNECTIONS, CurrentAccount, RegistryDescriptor, RegistryRefused,
    read_registry_metadata,
)


class GoogleRegistryMetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / 'google-workspace-connections.json'
        self.raw = {'schemaVersion': 1, 'ownerUserId': 'owner-a', 'connections': [
            {'connectionId': 'account-a', 'ownerUserId': 'owner-a',
             'capabilities': ['gmail_read', 'gmail_read'], 'healthState': 'connected',
             'useMode': 'explicit_only', 'email': 'fake@example.invalid',
             'tokenRef': 'must-not-open.json'},
            {'connectionId': 'account-b', 'ownerUserId': 'owner-a',
             'capabilities': ['calendar_read', 'calendar_actions'],
             'healthState': 'disconnected', 'useMode': 'available'}]}
        self.write()
        self.descriptor = RegistryDescriptor('owner-a', self.path)

    def write(self):
        self.path.write_text(json.dumps(self.raw))

    def read(self):
        return read_registry_metadata(self.descriptor, lambda: CurrentAccount('owner-a'))

    def test_separate_capabilities_and_no_identity_output(self):
        result = self.read()
        self.assertEqual(result['capabilities'], {
            'gmail_read': 1, 'gmail_send': 0, 'gmail_actions': 0, 'gmail_drafts': 0,
            'calendar_read': 1, 'calendar_actions': 1})
        self.assertEqual(result['health']['disconnected'], 1)
        self.assertEqual(result['use_mode']['explicit_only'], 1)
        self.assertTrue(result['configuration_only'])
        self.assertFalse(result['provider_readiness_verified'])
        self.assertFalse(result['activity_proven'])
        encoded = json.dumps(result)
        for private in ('owner-a', 'account-a', 'fake@example.invalid', 'must-not-open'):
            self.assertNotIn(private, encoded)

    def test_only_readonly_opens_no_token_lookup_or_writes(self):
        before = hashlib.sha256(self.path.read_bytes()).digest()
        real_open = os.open
        opened = []
        def observed(path, flags, *args, **kwargs):
            self.assertEqual(flags & os.O_ACCMODE, os.O_RDONLY)
            self.assertFalse(flags & (os.O_CREAT | os.O_TRUNC | os.O_APPEND))
            self.assertNotIn('must-not-open', str(path))
            opened.append(str(path))
            return real_open(path, flags, *args, **kwargs)
        with patch('os.open', observed), patch('os.mkdir', side_effect=AssertionError('mkdir')), \
                patch('os.write', side_effect=AssertionError('write')), \
                patch('os.unlink', side_effect=AssertionError('unlink')), \
                patch('os.rename', side_effect=AssertionError('rename')):
            self.read()
        self.assertIn(self.path.name, opened)
        self.assertEqual(hashlib.sha256(self.path.read_bytes()).digest(), before)
        self.assertEqual(list(self.root.iterdir()), [self.path])

    def test_unauthenticated_and_foreign_denied_before_open(self):
        for owner in (None, '', 'owner-a', CurrentAccount('owner-b'),
                      CurrentAccount('owner-a', kind='system'),
                      CurrentAccount('owner-a', machine=True),
                      CurrentAccount('owner-a', anonymous=True),
                      {'userId': 'owner-a'}, True):
            with patch('os.open', side_effect=AssertionError('opened before auth')):
                with self.assertRaises(RegistryRefused):
                    read_registry_metadata(self.descriptor, lambda: owner)

    def test_current_auth_rechecked_before_delivery(self):
        for second in ('owner-b', None):
            values = iter((CurrentAccount('owner-a'), second))
            with self.assertRaises(RegistryRefused):
                read_registry_metadata(self.descriptor, lambda: next(values))

    def test_registry_and_each_account_require_exact_owner(self):
        for variant in ('registry', 'account', 'missing_account_owner'):
            raw = copy.deepcopy(self.raw)
            if variant == 'registry':
                raw['ownerUserId'] = 'owner-b'
            elif variant == 'account':
                raw['connections'][1]['ownerUserId'] = 'owner-b'
            else:
                del raw['connections'][1]['ownerUserId']
            self.path.write_text(json.dumps(raw))
            with self.assertRaises(RegistryRefused):
                self.read()

    def test_missing_does_not_create_or_normalize(self):
        self.path.unlink()
        with self.assertRaises(RegistryRefused):
            self.read()
        self.assertEqual(list(self.root.iterdir()), [])

    def test_symlink_file_and_directory_refused(self):
        real = self.root / 'actual.json'
        self.path.rename(real)
        self.path.symlink_to(real)
        with self.assertRaises(RegistryRefused):
            self.read()
        directory_link = self.root / 'linked'
        directory_link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(RegistryRefused):
            read_registry_metadata(RegistryDescriptor('owner-a', directory_link / self.path.name), lambda: CurrentAccount('owner-a'))

    def test_duplicate_keys_nonfinite_and_malformed_refused(self):
        for text in ('{"schemaVersion":1,"schemaVersion":1}', '{"x":NaN}', '{', '[]'):
            self.path.write_text(text)
            with self.assertRaises(RegistryRefused):
                self.read()

    def test_bounds_duplicate_identity_and_wrong_version(self):
        variants = []
        raw = copy.deepcopy(self.raw); raw['schemaVersion'] = True; variants.append(raw)
        raw = copy.deepcopy(self.raw); raw['connections'][1]['connectionId'] = 'account-a'; variants.append(raw)
        raw = copy.deepcopy(self.raw); raw['connections'] = [{}] * (MAX_CONNECTIONS + 1); variants.append(raw)
        raw = copy.deepcopy(self.raw); raw['connections'][0]['capabilities'] = 'gmail_read'; variants.append(raw)
        for raw in variants:
            self.path.write_text(json.dumps(raw))
            with self.assertRaises(RegistryRefused):
                self.read()
        self.path.write_bytes(b' ' * (MAX_BYTES + 1))
        with self.assertRaises(RegistryRefused):
            self.read()

    def test_unknown_values_never_become_output_keys_or_readiness(self):
        self.raw['connections'][0].update(capabilities=['GMAIL_READ', 'untrusted-value'],
                                          healthState='private-detail', useMode='private-detail')
        self.write()
        result = self.read()
        self.assertEqual(result['capabilities']['gmail_read'], 0)
        self.assertEqual(result['unknown_capability_connections'], 1)
        self.assertEqual(result['health']['unknown'], 1)
        self.assertNotIn('private-detail', json.dumps(result))

    def test_mutation_during_read_refuses_snapshot(self):
        real_read = os.read
        changed = False
        def mutate(fd, size):
            nonlocal changed
            value = real_read(fd, size)
            if not changed:
                changed = True
                with self.path.open('ab') as f:
                    f.write(b' ')
            return value
        with patch('os.read', mutate):
            with self.assertRaises(RegistryRefused):
                self.read()

    def test_empty_owned_registry_is_configuration_only(self):
        self.raw['connections'] = []
        self.write()
        self.assertEqual(self.read()['connections'], 0)
        self.assertFalse(self.read()['activity_proven'])


if __name__ == '__main__':
    unittest.main()
