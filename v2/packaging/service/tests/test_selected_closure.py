"""Root-only disposable closure tests; never run a provider or inspect an account."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SERVICE = Path(__file__).resolve().parents[1]
REPO = SERVICE.parents[2]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result)
    return result


@unittest.skipUnless(os.geteuid() == 0, 'explicit root-only protected synthetic fixtures')
class SelectedClosure(unittest.TestCase):
    def setUp(self):
        self.tools_root = Path(tempfile.mkdtemp(prefix='selected-closure-tools-', dir='/root'))
        self.addCleanup(lambda: shutil.rmtree(self.tools_root))
        for name in ('selected_closure.py', 'closure.py'):
            shutil.copyfile(SERVICE / name, self.tools_root / name)
            (self.tools_root / name).chmod(0o440)
        sys.modules.pop('closure', None)
        self.c = module('selected_closure', self.tools_root / 'selected_closure.py')
        fixture = module('selected_fixture', SERVICE / 'tests/test_selected.py')
        fixture.REPO = REPO
        self.fixture = fixture.Selected('test_full_package_credentials_metadata_only')
        self.fixture.setUp(); self.addCleanup(self.fixture.doCleanups)
        self.root = self.fixture.root
        self.source = fixture.MANAGER_BASE
        # Real ELF bytes, no invocation. Pair identity is appended as inert data.
        (self.root / 'server').write_bytes(Path('/usr/bin/true').read_bytes() +
            f'ORKESTR_V2_BUILD_IDENTITY_V1|server|2.0.0-beta.1|{self.source}|END'.encode())
        (self.root / 'native').write_bytes(Path('/usr/bin/true').read_bytes())
        pair = json.loads((self.root / 'pair').read_bytes())
        pair['server']['sha256'] = fixture.sha(self.root / 'server')
        (self.root / 'pair').write_text(json.dumps(pair))
        self.fixture.plan['pair_sha256'] = fixture.sha(self.root / 'pair')
        self.fixture.plan['native_sha256'] = fixture.sha(self.root / 'native')
        fixture.selected.prepare(self.fixture.plan)
        self.package = self.fixture.validate()
        self.release = self.root / 'release'
        self.fake_stdlib = self.root / 'stdlib'; self.fake_stdlib.mkdir()
        (self.fake_stdlib / 'cached.pyc').write_bytes(b'compiled synthetic stdlib')
        (self.fake_stdlib / 'extension.so').write_bytes(b'ELF fixture, not executed')
        self.dependency = self.root / 'extension-dependency.so'
        self.dependency.write_bytes(b'recursive extension dependency fixture')
        self.dependency_alias = self.root / 'dependency-link'
        self.dependency_alias.symlink_to(self.dependency)

    def runtime(self, _):
        files = [*self.fake_stdlib.iterdir(), self.dependency]
        return {'files': {str(p): self.c._pin(p) for p in files},
                'stdlib_root': str(self.fake_stdlib), 'tree': self.c._tree(self.fake_stdlib),
                'fixed': {p: str(self.c._canonical(p)) for p in self.c.FIXED},
                'elf_seeds': [str(self.fake_stdlib / 'extension.so')],
                'elf_graphs': self.graphs([])[1], 'loader': self.c._loader()}

    def graphs(self, _):
        return {}, {str(self.fake_stdlib / 'extension.so'): [str(self.dependency_alias.resolve())]}

    def capture(self):
        with patch.object(self.c, '_runtime', side_effect=self.runtime):
            return self.c.capture(self.package, self.release, REPO)

    def verify(self, receipt, release=None):
        with patch.object(self.c.sysconfig, 'get_path', return_value=str(self.fake_stdlib)), \
                patch.object(self.c, '_elf_graphs', side_effect=self.graphs):
            return self.c.verify(receipt, self.package, release or self.release)

    def test_capture_verify_and_no_private_content_reads(self):
        forbidden = {self.root / 'bootstrap', self.root / 'authdir/auth.json'}
        original_path, original_os = Path.open, os.open
        def guarded_path(path, *args, **kwargs):
            self.assertNotIn(Path(path), forbidden, 'credential content opened')
            return original_path(path, *args, **kwargs)
        def guarded_os(path, *args, **kwargs):
            if not isinstance(path, int): self.assertNotIn(Path(path), forbidden, 'credential FD opened')
            return original_os(path, *args, **kwargs)
        with patch.object(Path, 'open', guarded_path), patch.object(os, 'open', guarded_os):
            receipt = self.capture(); self.assertTrue(self.verify(receipt)['verified'])
        self.assertFalse(receipt['credential_contents_read']); self.assertFalse(receipt['provider_invoked'])
        self.assertIn('codex_service/package.py', receipt['source_modules'])
        self.assertIn('isolation/bounded_proxy.py', receipt['source_modules'])
        self.assertNotIn(str(self.root / 'authdir/auth.json'), json.dumps(receipt))
        output = self.root / 'closure.json'; self.c._write(output, receipt, self.package)
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        with self.assertRaisesRegex(RuntimeError, 'fresh'): self.c._write(output, receipt, self.package)

    def early_binding(self):
        return self.c._binding(self.package.root,
            self.c._pin(self.package.root / 'manifest.json')['sha256'],
            self.c._pin(self.release / 'release.json')['sha256'])

    def test_early_artifact_aliases_never_open_credential_sentinels(self):
        server = self.package.root / 'server'; original = server.read_bytes()
        original_os = os.open
        for target in (self.root / 'bootstrap', self.root / 'authdir/auth.json'):
            # Even incorrectly root-owned credentials must not weaken this
            # early boundary (the full Package would reject their identity).
            os.chown(target, 0, 0)
            for hardlink in (False, True):
                server.unlink()
                if hardlink: os.link(target, server)
                else: server.symlink_to(target)
                def guarded(path, *args, **kwargs):
                    if not isinstance(path, int):
                        self.assertNotEqual(Path(path).resolve(), target, 'credential sentinel opened')
                    return original_os(path, *args, **kwargs)
                with patch.object(os, 'open', guarded), self.assertRaises(RuntimeError): self.early_binding()
                server.unlink(); server.write_bytes(original); server.chmod(0o550)
            os.chown(target, 995, 986)

    def test_early_same_path_bootstrap_substitution_never_opens_artifact(self):
        server = self.package.root / 'server'
        value = json.loads((self.package.root / 'service.json').read_bytes())
        value['bootstrap_file'] = str(server)
        (self.package.root / 'service.json').write_text(json.dumps(value))
        server.write_bytes(b'synthetic private sentinel, never open')
        original_os = os.open
        def guarded(path, *args, **kwargs):
            if not isinstance(path, int): self.assertNotEqual(Path(path), server, 'private sentinel opened')
            return original_os(path, *args, **kwargs)
        with patch.object(os, 'open', guarded), self.assertRaisesRegex(RuntimeError, 'private artifact alias'):
            self.early_binding()

    def test_current_selector_resolves_but_switch_refuses(self):
        receipt = self.capture(); current = self.root / 'current'
        current.symlink_to(self.release, target_is_directory=True)
        self.assertEqual(self.c._canonical(current / 'package'), self.package.root)
        self.assertTrue(self.verify(receipt, current)['verified'])
        other = self.root / 'other'; other.mkdir()
        current.unlink(); current.symlink_to(other, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'selected release changed'): self.verify(receipt, current)

    def test_cached_bytecode_drift_refused(self):
        receipt = self.capture(); (self.fake_stdlib / 'cached.pyc').write_bytes(b'changed code')
        with self.assertRaisesRegex(RuntimeError, 'dependency changed'): self.verify(receipt)

    def test_new_stdlib_module_refused(self):
        receipt = self.capture(); (self.fake_stdlib / 'new.py').write_bytes(b'new code')
        with self.assertRaisesRegex(RuntimeError, 'stdlib inventory changed'): self.verify(receipt)

    def test_recursive_extension_dependency_drift_refused(self):
        receipt = self.capture(); self.dependency.write_bytes(b'changed native dependency')
        with self.assertRaisesRegex(RuntimeError, 'dependency changed'): self.verify(receipt)

    def test_dependency_alias_retarget_refused_without_old_file_drift(self):
        receipt = self.capture(); other = self.root / 'other-dependency.so'
        other.write_bytes(self.dependency.read_bytes())
        self.dependency_alias.unlink(); self.dependency_alias.symlink_to(other)
        with self.assertRaisesRegex(RuntimeError, 'ELF dependency resolution changed'): self.verify(receipt)

    def test_helper_drift_refused(self):
        receipt = self.capture(); helper = self.tools_root / 'closure.py'
        helper.chmod(0o600); helper.write_bytes(helper.read_bytes() + b'\n# changed\n'); helper.chmod(0o440)
        with self.assertRaisesRegex(RuntimeError, 'tool changed'): self.verify(receipt)

    def test_dependency_metadata_drift_refused(self):
        receipt = self.capture(); self.dependency.chmod(0o400)
        with self.assertRaisesRegex(RuntimeError, 'dependency changed'): self.verify(receipt)

    def test_replaced_dependency_inode_refused_even_same_bytes(self):
        receipt = self.capture(); replacement = self.root / 'replacement'
        replacement.write_bytes(self.dependency.read_bytes()); replacement.replace(self.dependency)
        with self.assertRaisesRegex(RuntimeError, 'dependency changed'): self.verify(receipt)

    def test_manifest_and_outer_entry_binding(self):
        receipt = self.capture(); entry = self.release / 'start-service'
        entry.chmod(0o600); entry.write_bytes(b'#!/bin/sh\nexit 0\n'); entry.chmod(0o550)
        with self.assertRaisesRegex(RuntimeError, 'outer release file changed'): self.verify(receipt)

    def test_root_selector_cannot_traverse_untrusted_alias(self):
        untrusted = self.root / 'untrusted'; untrusted.mkdir(mode=0o777); untrusted.chmod(0o777)
        (untrusted / 'inner').symlink_to(self.release)
        alias = self.root / 'alias'; alias.symlink_to(untrusted / 'inner')
        with self.assertRaisesRegex(RuntimeError, 'nonwritable'): self.c._canonical(alias)

    def test_inventory_count_and_receipt_placement_bounds(self):
        with patch.object(self.c, 'MAX_FILES', 1):
            with self.assertRaisesRegex(RuntimeError, 'count bound'): self.c._tree(self.fake_stdlib)
        with self.assertRaisesRegex(RuntimeError, 'outside selected release'):
            self.c._write(self.package.root / 'extra.json', {}, self.package)
        with self.assertRaises(RuntimeError):
            self.c._pin(self.root / 'authdir/auth.json')

    def test_source_cross_binding_refused(self):
        receipt = self.capture(); binding = dict(receipt['binding'], source_commit='0' * 40)
        with self.assertRaises(subprocess.CalledProcessError): self.c._source(binding, REPO)

    def test_real_system_closure_and_exact_cli(self):
        # The only full scan: actual readelf recursion over every installed
        # stdlib ELF, fixed tools and synthetic selected native/server bytes.
        command = ['/usr/bin/python3', '-I', '-S', '-B', str(self.tools_root / 'selected_closure.py')]
        output = self.root / 'real-closure.json'
        env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}
        capture = subprocess.run(command + ['capture', '--package', str(self.package.root),
            '--source-repository', str(REPO), '--manifest-sha256', self.c._pin(self.package.root / 'manifest.json')['sha256'],
            '--release-sha256', self.c._pin(self.release / 'release.json')['sha256'], '--output', str(output)],
            env=env, capture_output=True, text=True, timeout=200)
        self.assertEqual(capture.returncode, 0, capture.stderr)
        result = json.loads(capture.stdout); receipt = json.loads(output.read_bytes())
        self.assertTrue(any(p.endswith('.pyc') for p in receipt['runtime']['files']))
        self.assertIn('/etc/ssl/certs/ca-certificates.crt', receipt['runtime']['files'])
        self.assertIn('/etc/ld.so.cache', receipt['runtime']['files'])
        extension = next(p for p in receipt['runtime']['elf_seeds'] if '/_sqlite3.' in p)
        dependency_graph = self.c.closure.elf_files(extension)
        self.assertTrue(any('libsqlite3.so' in p for p in dependency_graph['files']))
        self.assertTrue(set(dependency_graph['files']) <= set(receipt['runtime']['files']))
        for p in ('server', 'native'):
            self.assertIn(str(self.package.root / p), receipt['runtime']['elf_seeds'])
        current = self.root / 'current'; current.symlink_to(self.release)
        verify = command + ['verify', '--package', str(current / 'package'), '--receipt', str(output),
                            '--receipt-sha256', result['receipt_sha256']]
        checked = subprocess.run(verify, env=env, capture_output=True, text=True, timeout=200)
        self.assertEqual(checked.returncode, 0, checked.stderr)
        other = self.root / 'other'; shutil.copytree(self.release, other)
        current.unlink(); current.symlink_to(other)
        refused = subprocess.run(verify, env=env, capture_output=True, text=True, timeout=200)
        self.assertEqual(refused.returncode, 2)
        self.assertEqual(refused.stderr, 'selected service startup closure refused\n')
        print(json.dumps({'actual_system_closure': {
            'files': len(receipt['runtime']['files']), 'elf_seeds': len(receipt['runtime']['elf_seeds']),
            'existing_pyc': sum(p.endswith('.pyc') for p in receipt['runtime']['files']),
            'bytes': sum(p['bytes'] for p in receipt['runtime']['files'].values()),
            'source_modules': len(receipt['source_modules']),
            'capture_verify_and_switched_selector_refusal': True, 'provider_invoked': False}}))


if __name__ == '__main__': unittest.main()
