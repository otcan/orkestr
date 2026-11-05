"""Pinned conversation cwd and host tools retain the separate executor boundary."""
import copy
import json
import os
from pathlib import Path
import shutil
import unittest
from unittest.mock import patch
from codex_bounded.trust import digest
from codex_service.contract import Refused
from codex_service.managed_host import selected_workspace
from codex_service.package import Package, CODE_MODE_HOST
from test_codex_service_identity import SplitPackageTests


@unittest.skipUnless(os.geteuid() == 0, 'actual protected split package')
class ManagedHostTests(SplitPackageTests):
    test_split_loader_binds_authority_paths_but_refuses_unqualified_legacy_launch = None
    test_executor_cannot_read_replace_authority_or_gain_setuid_with_nnp = None
    test_external_server_configurations_require_authority_private_custody = None

    def prepare(self):
        package = self.select_split()
        workspace = self.fixture.directory('pinned-conversation')
        beta_path = package.root / 'beta.json'
        beta = json.loads(beta_path.read_text())
        beta['managed_host'] = {'environment': {'HOME': str(self.fixture.home), 'PATH': '/usr/bin:/bin'}}
        beta['conversation_workspaces'] = {package.conversation: str(workspace)}
        helper = package.root / CODE_MODE_HOST
        shutil.copyfile('/usr/bin/true', helper); helper.chmod(0o550)
        beta_path.write_text(json.dumps(beta))
        manifest = package.root / 'manifest.json'; value = json.loads(manifest.read_text())
        for path in (helper, beta_path): value['files'][path.name] = digest(path)
        manifest.write_text(json.dumps(value))
        return Package(package.root, digest(manifest)), workspace

    def test_root_attested_conversation_selects_only_its_pinned_directory(self):
        package, workspace = self.prepare()
        context = {'owner_id': package.owner, 'conversation_id': package.conversation}
        with patch('codex_service.identity.launch_context', return_value=context):
            self.assertEqual(selected_workspace(package, '/fallback', 'deep'), str(workspace))
            self.assertEqual(selected_workspace(package, '/fallback', 'worker-0'), '/fallback')
            context['conversation_id'] = '99999999-9999-4999-8999-999999999999'
            self.assertEqual(selected_workspace(package, '/fallback', 'deep'), '/fallback')
            context['owner_id'] = context['conversation_id']
            with self.assertRaises(Refused): selected_workspace(package, '/fallback', 'deep')
        with patch('codex_service.identity.launch_context', return_value=None):
            with self.assertRaises(Refused): selected_workspace(package, '/fallback', 'deep')

    def test_foreign_directory_and_legacy_full_access_cannot_be_smuggled(self):
        package, workspace = self.prepare()
        from codex_service.managed_host import validate
        original = copy.deepcopy(package.beta)
        package.beta['host_full_access'] = package.beta['managed_host']
        with self.assertRaises(Refused): validate(package)
        package.beta = original
        os.chown(workspace, package.authority_uid, package.gid)
        with self.assertRaises(Refused): validate(package)
        package.beta['conversation_workspaces'][package.conversation] = {'path': str(workspace), 'shared': True}
        with self.assertRaises((OSError, Refused)): validate(package)


if __name__ == '__main__': unittest.main()
