"""Split startup rejects a mutable Claude native before provider admission."""
import json
import os
from pathlib import Path
import shutil
import unittest
from unittest.mock import patch
from codex_bounded.trust import Refused,digest
from codex_service.package import Package,CLAUDE_FILES,CLAUDE_BROKER
import test_codex_service_identity as identity_tests


@unittest.skipUnless(os.geteuid()==0,'actual synthetic split ownership')
class ClaudeCustodyTests(identity_tests.SplitPackageTests):
    test_split_loader_binds_authority_paths_but_refuses_unqualified_legacy_launch=None
    test_executor_cannot_read_replace_authority_or_gain_setuid_with_nnp=None
    test_external_server_configurations_require_authority_private_custody=None

    def prepare_claude(self):
        package=self.select_split()
        native=self.fixture.root/'synthetic-claude'
        shutil.copyfile('/usr/bin/true',native);native.chmod(0o550)
        launcher=package.root/'launcher-claude.py'
        shutil.copyfile(package.root/'launcher.py',launcher);launcher.chmod(0o550)
        directories={key:str(self.fixture.directory('claude-'+key))
                     for key in ('account','workspace','home','temporary')}
        profile={'executable':str(native),**directories,
                 'managed_host':{'environment':{'HOME':directories['home'],'PATH':'/usr/bin:/bin'}}}
        (package.root/'claude-private.json').write_text(json.dumps(profile))
        (package.root/'claude-private.json').chmod(0o440)
        package.beta['claude']={'launcher':str(launcher),'launcher_sha256':digest(launcher),
            'workspace':directories['workspace'],'default':True,'fast':True}
        for name in CLAUDE_BROKER:
            path=package.root/'broker'/name
            shutil.copyfile(Path(__file__).parent/name,path)
            path.chmod(0o440)
        for name in CLAUDE_FILES:os.chown(package.root/name,0,self.gid)
        beta=package.root/'beta.json';beta.write_text(json.dumps(package.beta))
        manifest=package.root/'manifest.json';value=package.manifest
        for name in CLAUDE_FILES|{'beta.json'}:value['files'][name]=digest(package.root/name)
        manifest.write_text(json.dumps(value))
        return Package(package.root,digest(manifest)),native

    def validate(self,package):package._bind_claude(self.fixture.account,self.fixture.auth)

    def test_provider_configuration_preserves_exact_qualification_code_subject(self):
        from codex_service.qualification import code_subject
        codex_only = Package(self.fixture.package)
        before = code_subject(codex_only)
        self.assertIsNone(codex_only.claude)
        self.assertFalse((codex_only.root/'launcher-claude.py').exists())
        self.assertFalse((codex_only.root/'claude-private.json').exists())
        enabled, _ = self.prepare_claude()
        self.assertIsNotNone(enabled.claude)
        self.assertEqual(code_subject(enabled), before)

    def test_root_requires_immutable_native_and_protected_ancestry(self):
        package,native=self.prepare_claude();self.validate(package)
        os.chown(native,self.uid,self.gid)
        with self.assertRaises(Refused):self.validate(package)
        os.chown(native,0,self.gid);native.chmod(0o570)
        with self.assertRaises(Refused):self.validate(package)
        native.chmod(0o550);self.validate(package)
        parent=native.parent;mode=parent.stat().st_mode&0o777;parent.chmod(mode|0o020)
        try:
            with self.assertRaises(Refused):self.validate(package)
        finally:parent.chmod(mode)

    def test_executor_role_does_not_probe_authority_or_apply_root_validation(self):
        package,native=self.prepare_claude()
        original=package.private;observed=[]
        def scoped(path,*args):
            self.assertFalse(path==package.home or package.home in path.parents,
                             'executor attempted authority-private validation')
            observed.append(path);return original(path,*args)
        with patch('codex_service.package.os.geteuid',return_value=self.uid), \
             patch('codex_service.package.protected',side_effect=AssertionError('Root-only native validation')), \
             patch.object(package,'private',side_effect=scoped):
            self.validate(package)
        self.assertTrue(observed)
        self.assertNotIn(native,observed)


if __name__=='__main__':unittest.main()
