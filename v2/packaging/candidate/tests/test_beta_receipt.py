"""Real local Git provenance and synthetic artifacts; no build or executable run."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import package_candidate as package
import receipt


class BetaReceiptTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='v2-beta-receipt-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.checkout = self.root / 'source'
        self.checkout.mkdir()
        migrations = self.checkout / 'v2/crates/store-sqlite/migrations'
        migrations.mkdir(parents=True)
        (migrations / '0001_fixture.sql').write_text('CREATE TABLE fixture (id INTEGER);\n')
        (self.checkout / 'v2/rust-toolchain.toml').write_text('[toolchain]\nchannel = "stable"\n')
        environment = {'PATH': os.defpath, 'HOME': str(self.root),
                       'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null'}

        def git(*arguments):
            return subprocess.run(['git', '-C', str(self.checkout), *arguments],
                                  env=environment, capture_output=True, text=True,
                                  check=True, timeout=5).stdout.strip()

        git('init', '--quiet', '--template=')
        git('add', 'v2')
        git('-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid',
            '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic source')
        self.source = git('rev-parse', 'HEAD')
        self.binary = self.root / 'server'
        self.binary.write_bytes(b'\x7fELF\x02\x01' + b'\0' * 12 + b'\x3e\0never executed')
        self.binary.chmod(0o755)
        self.ui = self.root / 'web'
        self.ui.mkdir()
        (self.ui / 'index.html').write_text('Synthetic packaging fixture')
        (self.ui / 'app.wasm').write_bytes(b'Synthetic WASM; never loaded')
        self.paired = self.root / 'paired.json'
        self.output = self.root / 'candidate'

    def seal(self, version='2.0.0-beta.1'):
        return receipt.seal(self.checkout, self.binary, self.ui, self.source,
                            version, 'release', [], '2.34', execution_controls=True)

    def assemble(self, value):
        self.paired.write_text(json.dumps(value))
        return package.assemble(self.binary, self.ui, self.paired, self.output,
                                'python@sha256:' + 'c' * 64, 19842)

    def test_beta_and_existing_rc_versions_seal_without_relabeling(self):
        for version in ('2.0.0-beta.1', '2.0.0-beta.2', '2.0.0-beta.3', '2.0.0-beta.4', '2.0.0-beta.5', '2.0.0-rc.1', '2.0.0-rc.42'):
            with self.subTest(version=version):
                value = self.seal(version)
                self.assertEqual(receipt.verify(value, self.binary, self.ui)['version'], version)
                self.assertEqual(value['source_commit'], self.source)
                self.assertEqual(value['web']['server_candidate'], self.source)
                self.assertEqual(value['web']['features'], ['web', 'execution-controls'])
                self.assertEqual(value['server']['features'], [])

    def test_receipt_target_follows_the_server_elf_machine(self):
        self.assertEqual(self.seal()['target'], 'linux-x86_64')
        self.binary.write_bytes(b'\x7fELF\x02\x01' + b'\0' * 12 + b'\xb7\0never executed')
        value = self.seal()
        self.assertEqual(value['target'], 'linux-aarch64')
        self.assertEqual(receipt.verify(value, self.binary, self.ui)['target'], 'linux-aarch64')
        self.binary.write_bytes(b'\x7fELF\x02\x01' + b'\0' * 12 + b'\x28\0never executed')
        with self.assertRaises(Exception):
            self.seal()
        value['target'] = 'linux-armv7'
        with self.assertRaises(Exception):
            receipt.verify(value, self.binary, self.ui)

    def test_only_explicit_betas_and_existing_positive_rc_numbers_are_supported(self):
        for version in ('2.0.0-beta.0', '2.0.0-beta.6', '2.0.0-beta.01', '2.0.0-beta',
                        '2.0.0-rc.0', '2.0.0-rc.01', '2.0.0', '2.0.1-beta.1',
                        'v2.0.0-beta.1', '2.0.0-beta.1+build', '2.0.0-rc.1+build',
                        '2.0.0-beta.1\n', '', None, 1, True):
            with self.subTest(version=version):
                with self.assertRaisesRegex(RuntimeError, 'version required'):
                    self.seal(version)

    def test_beta_round_trips_through_native_and_docker_candidate_metadata(self):
        paired = self.seal()
        self.assemble(paired)
        candidate = package.verify(self.output)
        self.assertEqual(candidate['version'], '2.0.0-beta.1')
        self.assertEqual(candidate['source_commit'], self.source)
        self.assertEqual((self.output / 'paired-artifacts.json').read_bytes(), self.paired.read_bytes())
        for name in ('native/manifest.json', 'docker/artifact-manifest.json'):
            metadata = json.loads((self.output / name).read_text())['release_metadata']
            self.assertEqual(metadata['version'], '2.0.0-beta.1')
            self.assertEqual(metadata['source_commit'], self.source)
        self.assertIn('unexecuted', candidate['acceptance'])

    def test_unsupported_receipt_relabel_is_refused_before_assembly(self):
        value = self.seal('2.0.0-rc.1')
        for version in ('2.0.0-beta.6', '2.0.0', None):
            with self.subTest(version=version):
                value['version'] = version
                with self.assertRaisesRegex(RuntimeError, 'version required'):
                    self.assemble(value)
                self.assertFalse(self.output.exists())

    def test_beta_preserves_clean_and_exact_source_requirements(self):
        with self.assertRaisesRegex(RuntimeError, 'exact source'):
            receipt.seal(self.checkout, self.binary, self.ui, 'f' * 40,
                         '2.0.0-beta.1', 'release', [], '2.34')
        (self.checkout / 'v2/rust-toolchain.toml').write_text('changed source')
        with self.assertRaisesRegex(RuntimeError, 'clean tracked'):
            self.seal()

    def test_beta_preserves_server_and_web_hash_checks_before_output(self):
        for path, error in ((self.binary, 'server identity'), (self.ui / 'app.wasm', 'web identity')):
            with self.subTest(artifact=path.name):
                value = self.seal()
                original = path.read_bytes()
                path.write_bytes(b'tampered')
                with self.assertRaisesRegex(RuntimeError, error):
                    self.assemble(value)
                self.assertFalse(self.output.exists())
                path.write_bytes(original)

    def test_beta_controls_cannot_bind_a_different_server_revision(self):
        value = self.seal()
        value['web']['server_candidate'] = 'f' * 40
        with self.assertRaisesRegex(RuntimeError, 'binding mismatch'):
            self.assemble(value)
        self.assertFalse(self.output.exists())

    def test_beta_does_not_enable_debug_or_fixture_feature_artifacts(self):
        for field, altered in (('profile', 'debug'), ('features', ['fixture-test-controls'])):
            with self.subTest(field=field):
                value = self.seal()
                value['server'][field] = altered
                with self.assertRaisesRegex(RuntimeError, 'release-profile|default features'):
                    self.assemble(value)
                self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
