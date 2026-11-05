"""Synthetic business credentials; no real environment or account reads."""
import copy
import os
from pathlib import Path
import unittest

from codex_service.contract import Refused
from codex_service.workspace_environment import definition, environment
from codex_service_fixture import ServiceFixture, UID, GID


@unittest.skipUnless(os.geteuid() == 0, 'Root-owned disposable credential fixture')
class WorkspaceEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.fixture = ServiceFixture(); self.addCleanup(self.fixture.close)
        self.secret = self.fixture.root / 'synthetic-business.env'
        self.secret.write_text('GOG_KEYRING_PASSWORD="synthetic selected"\nUNSELECTED_TOKEN=synthetic-not-exported\n')
        self.secret.chmod(0o600)
        self.value = {'environment': {'HOME': '/home/example', 'PATH': '/usr/bin:/bin'},
            'credentials': [{'path': str(self.secret), 'keys': ['GOG_KEYRING_PASSWORD']}]}

    def load(self):
        return environment(self.value, [self.fixture.root / 'core-private'], Path('/srv/project'))

    def test_only_selected_keys_reach_environment_and_rotation_is_not_cached(self):
        value = self.load()
        self.assertEqual(set(value), {'HOME', 'PATH', 'PWD', 'GOG_KEYRING_PASSWORD'})
        self.assertEqual(value['GOG_KEYRING_PASSWORD'], 'synthetic selected')
        self.secret.write_text('GOG_KEYRING_PASSWORD=synthetic rotated\n')
        self.assertEqual(self.load()['GOG_KEYRING_PASSWORD'], 'synthetic rotated')

    def test_core_scope_alias_hardlink_nonroot_and_readable_secret_are_refused(self):
        with self.assertRaisesRegex(Refused, 'managed_workspace_credential_scope'):
            environment(self.value, [self.fixture.root], Path('/srv/project'))
        for mode in (0o640, 0o644):
            self.secret.chmod(mode)
            with self.assertRaisesRegex(Refused, 'managed_workspace_credential_custody'): self.load()
        self.secret.chmod(0o600); os.chown(self.secret, UID, GID)
        with self.assertRaisesRegex(Refused, 'managed_workspace_credential_custody'): self.load()
        os.chown(self.secret, 0, 0)
        linked = self.fixture.root / 'linked-secret'; os.link(self.secret, linked)
        with self.assertRaisesRegex(Refused, 'managed_workspace_credential_custody'): self.load()
        linked.unlink()
        alias = self.fixture.root / 'alias-secret'; alias.symlink_to(self.secret)
        self.value['credentials'][0]['path'] = str(alias)
        with self.assertRaises(OSError): self.load()

    def test_reserved_keys_unclosed_shapes_and_missing_or_duplicate_selected_values_refuse(self):
        for name in ('HOME', 'PATH', 'PWD', 'ORKESTR_V2_BOOTSTRAP_TOKEN', 'CODEX_HOME', 'LD_PRELOAD', 'BASH_ENV'):
            value = copy.deepcopy(self.value); value['credentials'][0]['keys'] = [name]
            with self.assertRaises(Refused): definition(value)
        for extra in ('uid', 'command', 'host_privileged'):
            with self.assertRaisesRegex(Refused, 'managed_workspace_environment_fields'):
                definition({**self.value, extra: True})
        for text in ('OTHER=synthetic\n', 'GOG_KEYRING_PASSWORD=first\nGOG_KEYRING_PASSWORD=second\n',
                     'source other.env\nGOG_KEYRING_PASSWORD=synthetic\n'):
            self.secret.write_text(text)
            with self.assertRaises(Refused): self.load()


if __name__ == '__main__': unittest.main()
