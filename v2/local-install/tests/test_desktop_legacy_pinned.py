"""Explicit opt-in integration with an independently reviewed public Git pin.

No checkout imports, live state, or store activation. Set both variables to run.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parents[1]))
from desktop_legacy_node import PinnedNodePreparer
from desktop_legacy_io import prepare_bundle
from desktop_restore import RecoveryError
import desktop_legacy_canonical as canonical

REPOSITORY = os.environ.get('DESKTOP_LEGACY_VALIDATOR_REPOSITORY')
COMMIT = os.environ.get('DESKTOP_LEGACY_VALIDATOR_COMMIT')


@unittest.skipUnless(REPOSITORY and COMMIT, 'explicit reviewed public validator Git pin required')
class PinnedPublicPreparationTests(unittest.TestCase):
    def setUp(self):
        self.preparer = PinnedNodePreparer(REPOSITORY, COMMIT)
        self.golden = json.loads((Path(__file__).parent/'desktop_legacy_golden.json').read_text())
        self.raw = self.golden['sourceUtf8'].encode()
        self.digest = hashlib.sha256(self.raw).hexdigest()

    def seal(self, raw, digest):
        return self.preparer(raw, digest, revoked_at=self.golden['revokedAt'])

    def test_public_serializer_cohort_and_fresh_evidence_publication(self):
        output, receipt_bytes = self.seal(self.raw, self.digest)
        state, receipt = json.loads(output), json.loads(receipt_bytes)
        original = json.loads(self.raw)
        self.assertEqual(receipt['preparedSha256'], hashlib.sha256(output).hexdigest())
        self.assertEqual(receipt['cohort'], state['legacyRetiredCohort'])
        self.assertEqual(receipt['cohort']['retiredSha256'], canonical.retired_digest(
            self.digest, 10, state['desktopLeases']))
        self.assertEqual(receipt['cohort']['retiredSha256'],
                         self.golden['pythonReferenceAdoption']['cohort']['retiredSha256'])
        self.assertEqual(state['fencingCounter'], 10)
        self.assertEqual(state['extra'], original['extra'])
        self.assertNotIn('lockIdentity', state)
        for before, after in zip(original['desktopLeases'], state['desktopLeases']):
            self.assertTrue(after['releasedAt'])
            if before['releasedAt']:
                self.assertEqual(after, before)
            for key in before.keys() - {'releasedAt', 'updatedAt', 'releaseReason'}:
                self.assertEqual(after[key], before[key])
        # Node's serializer retains literal Unicode; Python reference bytes are
        # deliberately not an interchangeable prepared-byte authority.
        self.assertIn('😀'.encode(), output)
        self.assertNotEqual(output, self.golden['pythonReferencePreparedUtf8'].encode())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.chmod(0o700)
            source, target = root/'original.json', root/'prepared'
            source.write_bytes(self.raw)
            source.chmod(0o600)
            result = prepare_bundle(source, target, self.digest, self.seal,
                                    offline_confirmed=True, provenance=self.preparer.provenance)
            self.assertEqual(source.read_bytes(), self.raw)
            self.assertEqual((target/'original.json').read_bytes(), self.raw)
            self.assertEqual((target/'leases.json').read_bytes(), output)
            self.assertEqual((target/'adoption.json').read_bytes(), receipt_bytes)
            self.assertEqual(result['preparationSource']['sourceCommit'], COMMIT)
            self.assertEqual(len(result['preparationSource']['files']), 4)
            with self.assertRaises(RecoveryError):
                prepare_bundle(source, target, self.digest, self.seal, offline_confirmed=True)

    def test_public_refusals_leave_no_target_or_staging(self):
        original = json.loads(self.raw)
        cases = [self.raw.replace(b'1.25', b'1e999'),
                 b'{"fencingCounter":9,"fencingCounter":9,"desktopLeases":[]}',
                 json.dumps(dict(original, lockIdentity='12:34')).encode(),
                 json.dumps(dict(original, legacyRetiredCohort={})).encode()]
        for raw in cases:
            with self.subTest(digest=hashlib.sha256(raw).hexdigest()), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                root.chmod(0o700)
                source, target = root/'original.json', root/'prepared'
                source.write_bytes(raw)
                source.chmod(0o600)
                with self.assertRaises(RecoveryError):
                    prepare_bundle(source, target, hashlib.sha256(raw).hexdigest(), self.seal,
                                   offline_confirmed=True)
                self.assertEqual(source.read_bytes(), raw)
                self.assertEqual(list(root.iterdir()), [source])


if __name__ == '__main__':
    unittest.main()
