import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1]))
import desktop_legacy_io as module


class LegacyIOTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.source = self.root / 'source.json'
        self.raw = b'{ "fencingCounter": 9, "desktopLeases": [], "extra": {"keep":true}}\n'
        self.source.write_bytes(self.raw)
        self.digest = hashlib.sha256(self.raw).hexdigest()
        self.target = self.root / 'fresh'

    def seal(self, raw, digest):
        # Transport-only fixture, deliberately NOT a production cohort sealer.
        self.assertEqual(raw, self.raw)
        self.assertEqual(digest, self.digest)
        return b'{"synthetic_output":true}\n', b'{"synthetic_external_receipt":true}\n'

    def run_prepare(self, **kwargs):
        return module.prepare_bundle(self.source, self.target, self.digest,
                                     kwargs.pop('seal', self.seal),
                                     offline_confirmed=True, **kwargs)

    def unchanged(self):
        self.assertEqual(self.source.read_bytes(), self.raw)

    def test_original_exact_private_and_receipt_hashes(self):
        receipt = self.run_prepare()
        self.assertEqual((self.target / 'original.json').read_bytes(), self.raw)
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o700)
        for name in ('original.json', 'leases.json', 'adoption.json', 'bundle.json'):
            self.assertEqual((self.target / name).stat().st_mode & 0o777, 0o600)
        self.assertEqual(receipt['adoption_sha256'], hashlib.sha256(
            (self.target / 'adoption.json').read_bytes()).hexdigest())
        self.unchanged()

    def test_confirmation_digest_identity_and_json_refuse_before_sealer(self):
        with self.assertRaises(module.RecoveryError):
            module.prepare_bundle(self.source, self.target, self.digest, self.seal)
        cases = [b'{"lockIdentity":"12:34"}', b'{"lockIdentity":null}',
                 b'{"extra":[1e999]}', b'{"a":1,"a":2}', b'[]', b'bad-json']
        for raw in cases:
            self.source.write_bytes(raw)
            with self.assertRaises(module.RecoveryError):
                module.prepare_bundle(self.source, self.target, hashlib.sha256(raw).hexdigest(),
                                      lambda *_: self.fail('sealer called'), offline_confirmed=True)
            self.assertEqual(self.source.read_bytes(), raw)
        self.source.write_bytes(self.raw)
        with self.assertRaises(module.RecoveryError):
            module.prepare_bundle(self.source, self.target, '0'*64, self.seal, offline_confirmed=True)
        self.assertFalse(list(self.root.glob('.desktop-legacy-*')))

    def test_target_existing_and_racing_are_never_overwritten(self):
        self.target.mkdir()
        (self.target / 'keep').write_text('keep')
        with self.assertRaises(module.RecoveryError):
            self.run_prepare()
        self.assertEqual((self.target / 'keep').read_text(), 'keep')
        (self.target / 'keep').unlink()
        self.target.rmdir()
        def race(phase):
            self.target.mkdir()
            (self.target / 'keep').write_text('racer')
        with self.assertRaises(module.PublicationUnknown):
            self.run_prepare(hook=race)
        self.assertEqual((self.target / 'keep').read_text(), 'racer')
        self.assertEqual(len(list(self.root.glob('.desktop-legacy-*'))), 1)
        self.unchanged()

    def test_special_sources_refused(self):
        for kind in ('symlink', 'fifo', 'hardlink'):
            candidate = self.root / kind
            if kind == 'symlink': candidate.symlink_to(self.source)
            elif kind == 'fifo': os.mkfifo(candidate)
            else: os.link(self.source, candidate)
            with self.assertRaises((OSError, module.RecoveryError)):
                module.prepare_bundle(candidate, self.target, self.digest, self.seal, offline_confirmed=True)
            candidate.unlink()
        self.unchanged()

    def test_seal_failure_invalid_output_and_copy_failure_no_publication(self):
        def fail(*_): raise module.RecoveryError('cohort rejected')
        for seal in (fail, lambda *_: (b'NaN', b'{}'), lambda *_: (b'{}', b'{"x":1e999}')):
            with self.assertRaises(module.RecoveryError): self.run_prepare(seal=seal)
            self.assertFalse(self.target.exists())
        with patch.object(module.os, 'fsync', side_effect=OSError('disk failure')):
            with self.assertRaises(OSError): self.run_prepare()
        self.assertFalse(list(self.root.glob('.desktop-legacy-*')))
        self.unchanged()

    def test_interruption_and_unknown_publication(self):
        def interrupt(_): raise KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt): self.run_prepare(hook=interrupt)
        self.assertFalse(self.target.exists())
        self.assertFalse(list(self.root.glob('.desktop-legacy-*')))
        def after(phase):
            if phase == 'published': raise KeyboardInterrupt()
        with self.assertRaises(module.PublicationUnknown): self.run_prepare(hook=after)
        self.assertEqual((self.target / 'original.json').read_bytes(), self.raw)
        self.assertTrue((self.target / 'adoption.json').exists())
        self.unchanged()


if __name__ == '__main__': unittest.main()
