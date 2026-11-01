"""Failure-oriented checks: no provider execution or account fixtures."""
import importlib.util
import io
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location('oss_' + name, HERE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class BootstrapTests(unittest.TestCase):
    def test_local_setup_credential_is_scoped_and_not_printed(self):
        runtime = load('runtime')
        token = 'synthetic-local-setup-credential'
        with tempfile.TemporaryDirectory() as scratch, patch.object(runtime, 'STATE', Path(scratch)):
            (Path(scratch) / 'bootstrap.token').write_text(token)
            with patch.dict(runtime.os.environ, {'ORKESTR_OSS_LOCAL_SETUP': '1'}), \
                    patch('sys.stdout', new=io.StringIO()) as output:
                self.assertEqual(runtime.setup_environment()['ORKESTR_OSS_LOCAL_BOOTSTRAP'], token)
                self.assertNotIn('ORKESTR_OSS_LOCAL_BOOTSTRAP', runtime.dropped_environment())
                runtime.setup_banner()
                self.assertNotIn(token, output.getvalue())
                self.assertNotIn('First-time setup token:', output.getvalue())
            with patch.dict(runtime.os.environ, {'ORKESTR_OSS_LOCAL_SETUP': '0'}):
                self.assertNotIn('ORKESTR_OSS_LOCAL_BOOTSTRAP', runtime.setup_environment())

    def test_archive_cannot_write_arbitrary_members(self):
        fetch = load('fetch_providers')
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode='w:gz') as archive:
            for name, data in (('../../unexpected', b'ignored'), ('bin/codex', b'\x7fELFsynthetic')):
                entry = tarfile.TarInfo(name)
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))
        self.assertEqual(fetch.extract(raw.getvalue(), 'codex'), b'\x7fELFsynthetic')

    def test_ambiguous_cli_binaries_refused(self):
        fetch = load('fetch_providers')
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode='w:gz') as archive:
            for name in ('codex', 'codex-extra'):
                data = b'\x7fELFsynthetic'
                entry = tarfile.TarInfo(name)
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))
        with self.assertRaisesRegex(ValueError, 'exactly one'):
            fetch.extract(raw.getvalue(), 'codex')

    def test_existing_credential_never_overwritten(self):
        runtime = load('runtime')
        with tempfile.TemporaryDirectory() as scratch:
            credential = Path(scratch) / 'credential'
            credential.write_text('synthetic-existing-value')
            with self.assertRaises(FileExistsError):
                runtime.write_private(credential, 'replacement')
            self.assertEqual(credential.read_text(), 'synthetic-existing-value')

    def test_directory_alias_refused(self):
        runtime = load('runtime')
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            (root / 'actual').mkdir(mode=0o700)
            (root / 'alias').symlink_to(root / 'actual')
            with self.assertRaisesRegex(RuntimeError, 'custody'):
                runtime.private_directory(root / 'alias', uid=__import__('os').getuid())

    def test_no_owner_authentication_without_codex_login(self):
        runtime = load('runtime')
        for claude in (False, True):
            with tempfile.TemporaryDirectory() as scratch, patch.object(runtime, 'STATE', Path(scratch)), \
                    patch.object(runtime, 'initialize'), patch.object(runtime, 'drop_child_capabilities'), \
                    patch.object(runtime, 'logged_in', side_effect=lambda p, c=claude: p == 'claude' and c), \
                    patch.object(runtime, 'request') as request:
                with self.assertRaisesRegex(RuntimeError, 'provider_login_required'):
                    runtime.configure()
                request.assert_not_called()

    def configure_with(self, runtime, scratch, claude):
        owner = '7c0b5a59-58b2-4f0e-9d55-3a6b0a8c2f11'
        session = {'owner_id': owner, 'global_conversation_id': 'c-1', 'token': 'synthetic-machine-token'}
        written = {}
        with patch.object(runtime, 'STATE', Path(scratch)), patch.object(runtime, 'initialize'), \
                patch.object(runtime, 'drop_child_capabilities'), \
                patch.object(runtime, 'logged_in', side_effect=lambda p: p == 'codex' or claude), \
                patch.object(runtime, 'request', return_value=session), \
                patch('builtins.input', return_value='synthetic-owner'), \
                patch('getpass.getpass', return_value='synthetic-password'), \
                patch.object(runtime, 'write_private', side_effect=lambda path, value, uid=0: written.update({path.name: value})), \
                patch('sys.stdout', new=io.StringIO()) as out:
            runtime.configure()
        return __import__('json').loads(written['owner.json']), out.getvalue()

    def test_codex_alone_is_enough_and_claude_is_recorded(self):
        runtime = load('runtime')
        with tempfile.TemporaryDirectory() as scratch:
            owner, output = self.configure_with(runtime, scratch, claude=False)
            self.assertIs(owner['claude'], False)
            self.assertIn('Codex only', output)
            owner, output = self.configure_with(runtime, scratch, claude=True)
            self.assertIs(owner['claude'], True)
            self.assertIn('Codex and Claude', output)

    def prepared_plan(self, runtime, owner):
        import json
        with tempfile.TemporaryDirectory() as scratch:
            root, state = Path(scratch) / 'opt', Path(scratch) / 'state'
            (root / 'providers').mkdir(parents=True)
            (state / 'releases').mkdir(parents=True)
            (root / 'paired-artifacts.json').write_text(json.dumps({'source_commit': 'a' * 40}))
            for name in ('codex', 'codex-code-mode-host'):
                (root / 'providers' / name).write_bytes(b'synthetic')
            plans = {}
            def capture(path, value, uid=0):
                plans['plan'] = json.loads(value)
            with patch.object(runtime, 'ROOT', root), patch.object(runtime, 'STATE', state), \
                    patch.object(runtime, 'write_private', side_effect=capture), \
                    patch.object(runtime.subprocess, 'run'):
                runtime.prepare(owner)
            return plans['plan']

    def test_metrics_port_never_collides_with_the_published_proxy_port(self):
        runtime = load('runtime')
        plan = self.prepared_plan(runtime, {'owner_id': 'o', 'conversation_id': 'c', 'claude': False})
        listen = __import__('re').findall(r'listen [0-9.]+:([0-9]+);', (HERE / 'nginx.conf').read_text())
        self.assertEqual(listen, ['19823'])
        self.assertNotIn(plan['metrics_port'], (plan['port'], 19823))

    def test_plan_includes_claude_only_when_configured(self):
        runtime = load('runtime')
        scope = {'owner_id': 'o', 'conversation_id': 'c'}
        self.assertNotIn('claude', self.prepared_plan(runtime, {**scope, 'claude': False}))
        self.assertIn('claude', self.prepared_plan(runtime, {**scope, 'claude': True}))
        # owner.json written before Claude became optional keeps its Claude plan.
        legacy = self.prepared_plan(runtime, dict(scope))
        self.assertIn('claude', legacy)
        self.assertEqual((legacy['owner_id'], legacy['conversation_id']), ('o', 'c'))
        with self.assertRaisesRegex(RuntimeError, 'owner scope refused'):
            self.prepared_plan(runtime, {**scope, 'claude': 'yes'})

    def test_inherited_credentials_never_reach_native(self):
        runtime = load('runtime')
        with patch.dict('os.environ', {'OPENAI_API_KEY': 'synthetic', 'ANTHROPIC_API_KEY': 'synthetic'}):
            self.assertNotIn('OPENAI_API_KEY', runtime.dropped_environment())
            self.assertNotIn('ANTHROPIC_API_KEY', runtime.dropped_environment())


class LocalOriginTests(unittest.TestCase):
    def test_loopback_is_exact_and_existing_https_stays_supported(self):
        sys.path.insert(0, str(HERE.parent / 'service'))
        from prepare import settings
        base = (Path('/srv/example/home'), Path('/srv/example/package'))
        for origin in ('http://127.0.0.1:19822', 'https://example.test'):
            settings(base[0], origin, 19822, 10001, base[1])
        for origin in ('http://127.0.0.1:19823', 'http://example.test',
                       'http://127.0.0.1:19822/', 'http://127.0.0.1:19822?x=1'):
            with self.assertRaises(RuntimeError):
                settings(base[0], origin, 19822, 10001, base[1])

    def test_compose_needs_commit_only_for_builds(self):
        compose = (HERE / 'compose.yaml').read_text()
        self.assertIn('SOURCE_COMMIT: ${ORKESTR_SOURCE_COMMIT:-}', compose)
        self.assertNotIn(':?', compose)
        dockerfile = (HERE / 'Dockerfile').read_text()
        self.assertIn('SOURCE_COMMIT must be the exact 40-character public commit', dockerfile)


    def test_each_architecture_has_its_own_complete_pins(self):
        fetch = load('fetch_providers')
        names = lambda machine: [entry[0] for entry in fetch.assets(machine)]
        self.assertEqual(names('x86_64'), names('aarch64'))
        for machine, marker in (('x86_64', 'x86_64'), ('aarch64', 'aarch64')):
            for name, url, algorithm, expected in fetch.assets(machine):
                self.assertTrue(url.startswith('https://'))
                self.assertIn(marker if 'codex' in url else ('x64' if machine == 'x86_64' else 'arm64'), url)
                self.assertEqual(len(expected), {'sha256': 64, 'sha512': 128}[algorithm])
        self.assertFalse({e[3] for e in fetch.assets('x86_64')} & {e[3] for e in fetch.assets('aarch64')})
        with self.assertRaises(ValueError):
            fetch.assets('armv7l')

    def test_wrong_architecture_cli_refused(self):
        fetch = load('fetch_providers')
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode='w:gz') as archive:
            data = b'\x7fELF\x02\x01' + bytes(12) + b'\x3e\x00'
            entry = tarfile.TarInfo('codex')
            entry.size = len(data)
            archive.addfile(entry, io.BytesIO(data))
        self.assertEqual(fetch.extract(raw.getvalue(), 'codex', 'x86_64')[18:20], b'\x3e\x00')
        with self.assertRaises(ValueError):
            fetch.extract(raw.getvalue(), 'codex', 'aarch64')

    def test_compose_builds_for_the_native_host_platform(self):
        self.assertNotRegex((HERE / 'compose.yaml').read_text(), r'(?m)^\s*platform:')

if __name__ == '__main__':
    unittest.main()
