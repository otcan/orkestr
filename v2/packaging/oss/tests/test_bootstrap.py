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

    def test_no_owner_authentication_before_both_provider_logins(self):
        runtime = load('runtime')
        with tempfile.TemporaryDirectory() as scratch, patch.object(runtime, 'STATE', Path(scratch)), \
                patch.object(runtime, 'initialize'), patch.object(runtime, 'drop_child_capabilities'), \
                patch.object(runtime, 'logged_in', return_value=False), \
                patch.object(runtime, 'request') as request:
            with self.assertRaisesRegex(RuntimeError, 'provider_login_required'):
                runtime.configure()
            request.assert_not_called()

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


if __name__ == '__main__':
    unittest.main()
