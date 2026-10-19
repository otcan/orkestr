import copy
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parents[1]))
import desktop_legacy_canonical as canonical
import desktop_legacy_prepare as module
from desktop_legacy_io import prepare_bundle
from desktop_restore import RecoveryError


class LegacyPrepareTests(unittest.TestCase):
    def state(self):
        def row(id, released, desktop):
            return dict(id=id, ownerUserId='owner', desktopSlug=desktop, threadId='thread',
                        fencingToken='old-token-'+id, fencingVersion=1, mode='exclusive',
                        acquiredAt='old', heartbeatAt='old', expiresAt='expired', releasedAt=released,
                        metadata={'unknown': ['😀', {'n': 1.25, 'keep': True}]})
        return dict(fencingCounter=9, extra={'keep': [1, None, False]},
                    desktopLeases=[row('z', None, 'one'), row('a', 'past', 'two'), row('b', None, 'three')])

    def seal(self, state):
        raw = json.dumps(state, ensure_ascii=True).encode()
        output, receipt = module.seal(raw, hashlib.sha256(raw).hexdigest(), revoked_at='synthetic-revocation')
        return raw, json.loads(output), json.loads(receipt), output

    def test_duplicates_retained_all_active_revoked_and_fresh_floor(self):
        original = self.state()
        raw, state, receipt, output = self.seal(original)
        self.assertEqual(state['fencingCounter'], 10)
        self.assertEqual(state['extra'], original['extra'])
        self.assertEqual([r['fencingVersion'] for r in state['desktopLeases']], [1, 1, 1])
        self.assertEqual(state['desktopLeases'][1], original['desktopLeases'][1])
        for before, after in zip(original['desktopLeases'], state['desktopLeases']):
            self.assertTrue(after['releasedAt'])
            for key in before.keys() - {'releasedAt', 'updatedAt', 'releaseReason'}:
                self.assertEqual(after[key], before[key])
        cohort = state['legacyRetiredCohort']
        self.assertEqual(cohort['retiredIds'], ['a', 'b', 'z'])
        self.assertEqual(cohort['generationFloor'], 10)
        self.assertEqual(cohort['retiredSha256'], canonical.retired_digest(
            hashlib.sha256(raw).hexdigest(), 10, state['desktopLeases']))
        self.assertEqual(receipt['cohort'], cohort)
        self.assertEqual(receipt['preparedSha256'], hashlib.sha256(output).hexdigest())
        self.assertNotIn('lockIdentity', state)
        self.assertEqual(original, self.state())

    def test_digest_covers_unknown_values_and_order_is_id_sorted(self):
        _, state, _, _ = self.seal(self.state())
        rows = state['desktopLeases']
        digest = lambda r: canonical.retired_digest('a'*64, 10, r)
        self.assertEqual(digest(rows), digest(list(reversed(rows))))
        altered = copy.deepcopy(rows)
        altered[0]['metadata']['unknown'].append('changed')
        self.assertNotEqual(digest(rows), digest(altered))
        self.assertNotEqual(digest(rows), canonical.retired_digest('b'*64, 10, rows))
        self.assertNotEqual(digest(rows), canonical.retired_digest('a'*64, 11, rows))

    def test_refuses_all_other_legacy_structural_faults(self):
        mutations = [lambda s:s.update(lockIdentity='12:34'),
                     lambda s:s.update(legacyRetiredCohort={}),
                     lambda s:s.update(fencingCounter=canonical.MAX_SAFE),
                     lambda s:s.update(fencingCounter=canonical.MAX_SAFE-1),
                     lambda s:s['desktopLeases'][0].update(id='a'),
                     lambda s:s['desktopLeases'][0].update(fencingVersion=10),
                     lambda s:s['desktopLeases'][0].update(fencingToken=''),
                     lambda s:s['desktopLeases'][0].update(ownerUserId='UPPER'),
                     lambda s:s['desktopLeases'][0].update(mode='invalid'),
                     lambda s:s['desktopLeases'][0].pop('expiresAt'),
                     lambda s:s['desktopLeases'][2].update(desktopSlug='one')]
        for mutate in mutations:
            state = self.state(); mutate(state)
            with self.subTest(state=state):
                with self.assertRaises(RecoveryError): self.seal(state)

    def test_numeric_unicode_duplicate_and_complexity_refusals(self):
        for raw in (b'{"x":1e999}', b'{"x":-1e999}', b'{"x":-0}', b'{"x":-0.0}',
                    b'{"x":9007199254740992}', b'{"x":"\\ud800"}',
                    b'{"x":1,"x":2}', b'\xef\xbb\xbf{}', '{}'.encode('utf-16'),
                    b'['*66+b'0'+b']'*66):
            with self.subTest(raw=raw):
                with self.assertRaises(RecoveryError): canonical.parse(raw)
        with self.assertRaises(RecoveryError): canonical.canonical([None]*100001)
        with self.assertRaises(RecoveryError): canonical.canonical('a'*(8*1024*1024))

    def test_canonical_fixed_vectors_and_utf8_object_order(self):
        vectors = [(None,b'n'),(True,b't'),(False,b'f'),(1,b'd3ff0000000000000'),
                   ('€',b's3:\xe2\x82\xac'),([],b'a0:[]'),({},b'o0:{}'),
                   ([None,True],b'a2:[nt]')]
        for value, expected in vectors: self.assertEqual(canonical.canonical(value),expected)
        self.assertEqual(canonical.canonical({'😀':False,'\ue000':True}),
                         b'o2:{s3:\xee\x80\x80ts4:\xf0\x9f\x98\x80f}')

    def test_independent_node_tagged_encoding_matches_python(self):
        # Independent cross-language protocol oracle; production store owner
        # module remains a separately required integration test.
        script = r'''
const fs=require('fs');const crypto=require('crypto');
function e(x){if(x===null)return Buffer.from('n');if(typeof x==='boolean')return Buffer.from(x?'t':'f');
if(typeof x==='number'){let b=Buffer.alloc(8);b.writeDoubleBE(x);return Buffer.from('d'+b.toString('hex'));}
if(typeof x==='string'){let b=Buffer.from(x);return Buffer.concat([Buffer.from('s'+b.length+':'),b]);}
if(Array.isArray(x))return Buffer.concat([Buffer.from('a'+x.length+':['),...x.map(e),Buffer.from(']')]);
let keys=Object.keys(x).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
return Buffer.concat([Buffer.from('o'+keys.length+':{'),...keys.flatMap(k=>[e(k),e(x[k])]),Buffer.from('}')]);}
let x=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(crypto.createHash('sha256').update(e(x)).digest('hex'));
'''
        document = {'format':canonical.COHORT_FORMAT,'sourceSha256':'a'*64,'generationFloor':10,
                    'retiredRecords':self.state()['desktopLeases'], 'unicode':{'😀':1,'\ue000':2},
                    'numbers':[1,1.5,5e-324,1e-300,canonical.MAX_SAFE]}
        actual = subprocess.run(['node','-e',script],input=json.dumps(document).encode(),capture_output=True,check=True)
        self.assertEqual(actual.stdout.decode(), hashlib.sha256(canonical.canonical(document)).hexdigest())

    def test_shared_golden_receipt_and_exact_prepared_bytes(self):
        fixture = json.loads((Path(__file__).parent/'desktop_legacy_golden.json').read_text())
        raw = fixture['sourceUtf8'].encode()
        output, adoption = module.seal(raw, hashlib.sha256(raw).hexdigest(), revoked_at=fixture['revokedAt'])
        self.assertEqual(output.decode(), fixture['preparedUtf8'])
        self.assertEqual(json.loads(adoption), fixture['adoption'])
        state = json.loads(output)
        document = dict(format=canonical.COHORT_FORMAT,
            sourceSha256=hashlib.sha256(raw).hexdigest(), generationFloor=10,
            retiredRecords=sorted(state['desktopLeases'],key=lambda r:r['id'].encode()))
        self.assertEqual(canonical.canonical(document).hex(),fixture['retiredCanonicalHex'])

    def test_actual_sigterm_sighup_cleanup_and_unknown_publication(self):
        for name in ('SIGTERM', 'SIGHUP'):
            for phase in ('prepared', 'published'):
                with self.subTest(signal=name, phase=phase), tempfile.TemporaryDirectory() as directory:
                    root = Path(directory); source = root / 'source.json'; target = root / 'fresh'
                    raw = json.dumps(self.state()).encode(); source.write_bytes(raw)
                    script = r'''import os,signal,sys
sys.path.insert(0,sys.argv[1])
import desktop_legacy_prepare as module
original=module.prepare_bundle
signal_name,signal_phase=sys.argv[2:4]
def wrapped(*args,**kwargs):
 def hook(phase):
  if phase==signal_phase: os.kill(os.getpid(),getattr(signal,signal_name))
 return original(*args,hook=hook,**kwargs)
module.prepare_bundle=wrapped
sys.argv=["prepare",*sys.argv[4:]]
module.main()
'''
                    result = subprocess.run([sys.executable, '-B', '-c', script,
                        str(Path(module.__file__).parent), name, phase, '--source', str(source),
                        '--target', str(target), '--source-sha256', hashlib.sha256(raw).hexdigest(),
                        '--offline-source-confirmed'], capture_output=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(source.read_bytes(), raw)
                    self.assertFalse(list(root.glob('.desktop-legacy-*')))
                    if phase == 'prepared':
                        self.assertFalse(target.exists())
                    else:
                        self.assertIn(b'publication uncertain', result.stderr)
                        self.assertEqual((target/'original.json').read_bytes(), raw)
                        self.assertTrue((target/'adoption.json').exists())

    def test_actual_cli_fresh_bundle_original_and_external_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'source.json';target=root/'fresh'
            raw=json.dumps(self.state()).encode();source.write_bytes(raw)
            command=[sys.executable,'-B',str(Path(module.__file__)), '--source',str(source),
                     '--target',str(target),'--source-sha256',hashlib.sha256(raw).hexdigest(),
                     '--offline-source-confirmed']
            result=subprocess.run(command,capture_output=True,check=True)
            self.assertEqual(source.read_bytes(),raw)
            self.assertEqual((target/'original.json').read_bytes(),raw)
            output=json.loads((target/'leases.json').read_bytes())
            receipt=json.loads((target/'adoption.json').read_bytes())
            self.assertEqual(receipt['cohort'],output['legacyRetiredCohort'])
            self.assertTrue(all(row['releasedAt'] for row in output['desktopLeases']))
            self.assertEqual(output['fencingCounter'],10)
            again=subprocess.run(command,capture_output=True)
            self.assertNotEqual(again.returncode,0)
            self.assertEqual(source.read_bytes(),raw)
            self.assertFalse(list(root.glob('.desktop-legacy-*')))


if __name__ == '__main__': unittest.main()
