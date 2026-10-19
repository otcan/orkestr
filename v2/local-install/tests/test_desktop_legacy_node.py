import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parents[1]))
from desktop_legacy_node import PinnedNodePreparer, SOURCE_NAMES
from desktop_restore import RecoveryError

# Synthetic pure export only: tests the pinned execution transport, NOT the
# public cohort validator or cryptographic adoption semantics.
FIXTURE = '''import {createHash} from 'node:crypto';
export const serializePreparedLegacy = state=>Buffer.from(JSON.stringify(state,null,2)+'\\n');
export function prepareLegacyCohort(state,{sourceSha256,revokedAt}) {
 const preparedSha256=createHash('sha256').update(serializePreparedLegacy(state)).digest('hex');
 return {state,adoption:{sourceSha256,preparedSha256,synthetic:true,revokedAt}};
}
'''


class NodeBridgeTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        subprocess.run(['git','init','-q',str(self.root)],check=True)
        source = self.root/'packages/browsers/src';source.mkdir(parents=True)
        for name in SOURCE_NAMES:
            code = FIXTURE if name == 'desktop-lease-legacy.js' else (
                'export const parseLegacyJson=raw=>JSON.parse(raw.toString("utf8"));' if
                name == 'desktop-lease-canonical.js' else '// synthetic dependency\n')
            (source/name).write_text(code)
        subprocess.run(['git','-C',str(self.root),'add','.'],check=True)
        subprocess.run(['git','-C',str(self.root),'-c','user.name=Synthetic',
                        '-c','user.email=synthetic@example.invalid','commit','-qm','fixture'],check=True)
        self.commit = subprocess.check_output(['git','-C',str(self.root),'rev-parse','HEAD'],text=True).strip()
        self.raw = b'{"synthetic":true,"unicode":"\\ud83d\\ude00","number":1.25}'
        self.digest = hashlib.sha256(self.raw).hexdigest()

    def test_exact_git_objects_execute_despite_mutable_source_poison(self):
        path = self.root/'packages/browsers/src/desktop-lease-legacy.js'
        path.write_text('throw Error("mutable_worktree_must_not_execute");')
        pinned = PinnedNodePreparer(self.root,self.commit)
        output,receipt = pinned(self.raw,self.digest,revoked_at='2030-01-01T00:00:00.000Z')
        self.assertEqual(json.loads(output),json.loads(self.raw))
        self.assertIn('😀'.encode(),output)
        self.assertEqual(json.loads(receipt)['preparedSha256'],hashlib.sha256(output).hexdigest())
        self.assertEqual(pinned.provenance['sourceCommit'],self.commit)
        self.assertEqual(pinned.provenance['files']['packages/browsers/src/desktop-lease-legacy.js'],
                         hashlib.sha256(FIXTURE.encode()).hexdigest())

    def test_unpinned_missing_or_short_source_refuses(self):
        for commit in ('HEAD',self.commit[:12],'0'*40):
            with self.assertRaises(RecoveryError): PinnedNodePreparer(self.root,commit)
        pinned = PinnedNodePreparer(self.root,self.commit)
        with self.assertRaises(RecoveryError): pinned(self.raw,'0'*64)

    def test_child_failure_never_echoes_source_or_child_diagnostics(self):
        pinned = PinnedNodePreparer(self.root,self.commit)
        pinned.sources['desktop-lease-legacy.js']=b'throw Error("PRIVATE_SYNTHETIC_SENTINEL");'
        with self.assertRaises(RecoveryError) as raised: pinned(self.raw,self.digest)
        self.assertNotIn('PRIVATE_SYNTHETIC_SENTINEL',str(raised.exception))


if __name__ == '__main__': unittest.main()
