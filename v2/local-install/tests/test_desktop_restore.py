import hashlib
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('desktop_restore', Path(__file__).parents[1] / 'desktop_restore.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RestoreTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.source = self.root / 'source.json'
        self.state = dict(lockIdentity='12:34', fencingCounter=9, extra={'keep': [1]}, desktopLeases=[dict(
            id='lease', ownerUserId='owner', desktopSlug='desk', threadId='thread', fencingToken='token',
            fencingVersion=9, mode='exclusive', acquiredAt='old', heartbeatAt='old', expiresAt=None,
            releasedAt=None, metadata={'unknown': True})])
        self.raw = json.dumps(self.state).encode()
        self.source.write_bytes(self.raw)
        self.digest = hashlib.sha256(self.raw).hexdigest()
        self.target = self.root / 'fresh'

    def run_prepare(self, **kwargs):
        return module.prepare(self.source, self.target, kwargs.pop('digest', self.digest),
                              kwargs.pop('identity', '12:34'), offline_confirmed=True, **kwargs)

    def unchanged(self):
        self.assertEqual(self.source.read_bytes(), self.raw)

    def test_preserved_original_and_revoked_output(self):
        receipt = self.run_prepare()
        self.assertEqual((self.target / 'original.json').read_bytes(), self.raw)
        output = json.loads((self.target / 'leases.json').read_bytes())
        self.assertNotIn('lockIdentity', output)
        self.assertEqual(output['extra'], self.state['extra'])
        self.assertEqual(output['fencingCounter'], 9)
        old = self.state['desktopLeases'][0]
        lease = output['desktopLeases'][0]
        for field in old.keys() - {'releasedAt'}:
            self.assertEqual(lease[field], old[field])
        self.assertTrue(lease['releasedAt'])
        self.assertEqual(receipt['revoked'], 1)
        self.unchanged()

    def test_no_overwrite(self):
        self.target.mkdir()
        (self.target / 'keep').write_text('keep')
        with self.assertRaises(module.RecoveryError):
            self.run_prepare()
        self.assertEqual((self.target / 'keep').read_text(), 'keep')
        self.unchanged()

    def test_digest_identity_and_confirmation_refusals(self):
        for changes in [dict(digest='0' * 64), dict(identity='12:35')]:
            with self.assertRaises(module.RecoveryError):
                self.run_prepare(**changes)
        with self.assertRaises(module.RecoveryError):
            module.prepare(self.source, self.target, self.digest, '12:34')
        self.assertFalse(self.target.exists())
        self.unchanged()

    def test_symlink_fifo_and_hardlink_refused(self):
        for kind in ['symlink', 'fifo', 'hardlink']:
            candidate = self.root / kind
            if kind == 'symlink':
                candidate.symlink_to(self.source)
            elif kind == 'fifo':
                os.mkfifo(candidate)
            else:
                os.link(self.source, candidate)
            with self.assertRaises((OSError, module.RecoveryError)):
                module.prepare(candidate, self.target, self.digest, '12:34', offline_confirmed=True)
            candidate.unlink()
        self.unchanged()

    def test_interruption_before_publication_cleans_stage(self):
        def interrupt(phase):
            raise KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):
            self.run_prepare(hook=interrupt)
        self.assertFalse(self.target.exists())
        self.assertFalse(list(self.root.glob('.desktop-recovery-*')))
        self.unchanged()

    def test_unknown_publication_preserves_evidence(self):
        def interrupt(phase):
            if phase == 'published':
                raise KeyboardInterrupt()
        with self.assertRaises(module.PublicationUnknown):
            self.run_prepare(hook=interrupt)
        self.assertEqual((self.target / 'original.json').read_bytes(), self.raw)
        with self.assertRaises(module.RecoveryError):
            self.run_prepare()
        self.unchanged()

    def test_racing_target_not_overwritten(self):
        def race(phase):
            self.target.mkdir()
            (self.target / 'keep').write_text('racer')
        with self.assertRaises(module.PublicationUnknown):
            self.run_prepare(hook=race)
        self.assertEqual((self.target / 'keep').read_text(), 'racer')
        self.assertEqual(len(list(self.root.glob('.desktop-recovery-*'))), 1)
        self.unchanged()

    def test_exhausted_generation_refuses(self):
        self.state['fencingCounter'] = 2**53 - 1
        self.raw = json.dumps(self.state).encode()
        self.source.write_bytes(self.raw)
        self.digest = hashlib.sha256(self.raw).hexdigest()
        with self.assertRaisesRegex(module.RecoveryError, 'generation exhausted'):
            self.run_prepare()
        self.assertFalse(self.target.exists())
        self.unchanged()

    def test_all_active_revoked_and_history_unknown_fields_retained(self):
        import copy
        second = copy.deepcopy(self.state['desktopLeases'][0])
        second.update(id='other', desktopSlug='other-desk', fencingVersion=8, fencingToken='other-token')
        historical = copy.deepcopy(second)
        historical.update(id='historical', fencingVersion=7, releasedAt='past', releaseReason='keep-reason')
        historical['extension'] = {'keep': ['unknown']}
        self.state['desktopLeases'].extend([second, historical])
        self.raw = json.dumps(self.state).encode()
        self.source.write_bytes(self.raw)
        self.digest = hashlib.sha256(self.raw).hexdigest()
        receipt = self.run_prepare()
        output = json.loads((self.target / 'leases.json').read_bytes())
        self.assertEqual(receipt['revoked'], 2)
        self.assertEqual(output['fencingCounter'], 9)
        self.assertTrue(all(item['releasedAt'] for item in output['desktopLeases']))
        self.assertEqual(output['desktopLeases'][2], historical)
        for before, after in zip(self.state['desktopLeases'][:2], output['desktopLeases'][:2]):
            for field in before.keys() - {'releasedAt'}:
                self.assertEqual(before[field], after[field])
        self.unchanged()

    def signal_subprocess(self, signal_name, boundary):
        # Inject a real OS signal into the CLI with its actual handlers installed.
        # Hooks exist only in this disposable subprocess, never in production CLI.
        code = r"""
import importlib.util, os, signal, sys
spec = importlib.util.spec_from_file_location('recovery', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
boundary, signame = sys.argv[2:4]
sys.argv = ['desktop_restore.py', *sys.argv[4:]]
if boundary == 'prepublication':
    original = m.os.fsync
    def injected(fd):
        os.kill(os.getpid(), getattr(signal, signame))
        original(fd)
    m.os.fsync = injected
else:
    original = m.rename_fresh
    def injected(source, target):
        original(source, target)
        os.kill(os.getpid(), getattr(signal, signame))
    m.rename_fresh = injected
m.main()
"""
        return subprocess.run([sys.executable, '-B', '-c', code, str(Path(module.__file__)),
                               boundary, signal_name, '--source', str(self.source), '--target', str(self.target),
                               '--source-sha256', self.digest, '--old-lock-identity', '12:34',
                               '--offline-source-confirmed'], capture_output=True, text=True, timeout=5)

    def test_sigterm_before_publication_cleans(self):
        result = self.signal_subprocess('SIGTERM', 'prepublication')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('KeyboardInterrupt', result.stderr)
        self.assertFalse(self.target.exists())
        self.assertFalse(list(self.root.glob('.desktop-recovery-*')))
        self.unchanged()

    def test_sighup_before_publication_cleans(self):
        result = self.signal_subprocess('SIGHUP', 'prepublication')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('KeyboardInterrupt', result.stderr)
        self.assertFalse(self.target.exists())
        self.assertFalse(list(self.root.glob('.desktop-recovery-*')))
        self.unchanged()

    def test_sigterm_after_rename_retains_unknown_publication(self):
        result = self.signal_subprocess('SIGTERM', 'postrename')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('PublicationUnknown', result.stderr)
        self.assertEqual((self.target / 'original.json').read_bytes(), self.raw)
        self.unchanged()

    def test_sighup_after_rename_retains_unknown_publication(self):
        result = self.signal_subprocess('SIGHUP', 'postrename')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('PublicationUnknown', result.stderr)
        self.assertEqual((self.target / 'original.json').read_bytes(), self.raw)
        self.unchanged()

    def test_released_history_unchanged(self):
        self.state['desktopLeases'][0].update(releasedAt='already', releaseReason='original')
        self.raw = json.dumps(self.state).encode()
        self.source.write_bytes(self.raw)
        self.digest = hashlib.sha256(self.raw).hexdigest()
        self.run_prepare()
        output = json.loads((self.target / 'leases.json').read_bytes())
        self.assertEqual(output['desktopLeases'], self.state['desktopLeases'])


if __name__ == '__main__':
    unittest.main()
