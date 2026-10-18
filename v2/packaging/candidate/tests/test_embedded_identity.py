"""Synthetic bytes only: identity validation never executes an artifact."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import embedded_identity as identity
import receipt
from test_candidate import CandidateTests


class EmbeddedIdentityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.binary = self.root/'server'
        self.ui = self.root/'web'; self.ui.mkdir()
        self.wasm = self.ui/'app.wasm'
        self.binary.write_bytes(identity.record('server','2.0.0-dev','a'*40).encode())
        self.wasm.write_bytes(identity.record('web','2.0.0-dev','a'*40).encode())

    def test_development_identity_is_exact_without_subprocess_or_state(self):
        before = {p.relative_to(self.root).as_posix():p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        with patch('subprocess.run', side_effect=AssertionError('must not execute')):
            value = identity.verify(self.binary,self.ui,'2.0.0-dev','a'*40)
        self.assertEqual(value['server']['version'],'2.0.0-dev')
        self.assertEqual(before,{p.relative_to(self.root).as_posix():p.read_bytes() for p in self.root.rglob('*') if p.is_file()})

    def test_relabel_source_component_and_unknown_refused(self):
        for component,version,source in [('server','2.0.0-rc.1','a'*40),('server','2.0.0-dev','b'*40),('web','2.0.0-dev','a'*40)]:
            with self.subTest(component=component,version=version,source=source):
                with self.assertRaisesRegex(RuntimeError,'mismatch'):
                    identity.read(self.binary,component,version,source)
        self.binary.write_bytes(b'ORKESTR_V2_BUILD_IDENTITY_V1|server|2.0.0-dev|unknown|END')
        with self.assertRaisesRegex(RuntimeError,'malformed'):
            identity.verify(self.binary,self.ui,'2.0.0-dev','a'*40)

    def test_conflicting_or_malformed_extra_record_refused(self):
        original = self.binary.read_bytes()
        for extra in [identity.record('server','2.0.0-dev','b'*40).encode(),b'ORKESTR_V2_BUILD_IDENTITY_V1|invalid']:
            self.binary.write_bytes(original+extra)
            with self.assertRaises(RuntimeError):identity.verify(self.binary,self.ui,'2.0.0-dev','a'*40)

    def test_matching_repeat_allowed_but_multiple_wasm_refused(self):
        self.binary.write_bytes(self.binary.read_bytes()*2)
        identity.verify(self.binary,self.ui,'2.0.0-dev','a'*40)
        (self.ui/'other.wasm').write_bytes(self.wasm.read_bytes())
        with self.assertRaisesRegex(RuntimeError,'one compiled web'):
            identity.verify(self.binary,self.ui,'2.0.0-dev','a'*40)


class ReceiptRelabelTests(CandidateTests):
    # Reuse established synthetic packaging fixture; inherited cases run in its
    # own module. Only the added cases are loaded here.
    def test_relabel_with_updated_hashes_still_refused_before_output(self):
        for field,value in [('version','2.0.0-dev'),('source_commit','b'*40)]:
            original=self.value[field]; self.value[field]=value
            self.paired.write_text(json.dumps(self.value))
            with self.assertRaisesRegex(RuntimeError,'embedded build identity mismatch'):
                self.assemble()
            self.assertFalse((self.root/'candidate').exists())
            self.value[field]=original

    def test_dev_seal_requires_matching_compiled_pair(self):
        (self.root/'v2/Cargo.toml').write_text('[workspace.package]\nversion="2.0.0-dev"\n')
        from types import SimpleNamespace
        self.binary.write_bytes(self.binary.read_bytes().replace(b'2.0.0-rc.1',b'2.0.0-dev'))
        wasm=self.ui/'app.wasm';wasm.write_bytes(wasm.read_bytes().replace(b'2.0.0-rc.1',b'2.0.0-dev'))
        with patch.object(receipt,'git',side_effect=['a'*40,'']), \
             patch.object(receipt,'schema',return_value={'0001_fixture.sql':'b'*64}), \
             patch.object(receipt.subprocess,'run',return_value=SimpleNamespace(stdout=b'toolchain')):
            value=receipt.seal(self.root,self.binary,self.ui,'a'*40,'2.0.0-dev','release',[],'2.34')
        receipt.verify(value,self.binary,self.ui)
        self.assertEqual(value['version'],'2.0.0-dev')
        self.assertEqual(value['embedded_identity']['web']['version'],'2.0.0-dev')

    def test_producer_relabel_refused_before_build(self):
        import build_pair
        checkout=self.root/'checkout';(checkout/'v2').mkdir(parents=True)
        (checkout/'v2/Cargo.toml').write_text('[workspace.package]\nversion="2.0.0-dev"\n')
        wrapper=self.root/'wrapper';wrapper.write_text('never executed')
        with patch.object(receipt,'git',side_effect=['a'*40,'']), \
             patch.object(build_pair.subprocess,'run') as run:
            with self.assertRaisesRegex(RuntimeError,'relabel refused'):
                build_pair.build(checkout,self.root/'output','a'*40,'2.0.0-rc.1',wrapper,self.root,self.root,'2.34')
        run.assert_not_called()
        self.assertFalse((self.root/'output').exists())

    def test_historical_receipt_is_explicit_integrity_only_not_new_assembly(self):
        self.value['format']='orkestr-v2-paired-artifacts-v1'
        del self.value['embedded_identity']
        self.binary.write_bytes(self.binary.read_bytes().split(identity.PREFIX)[0])
        wasm=self.ui/'app.wasm';wasm.write_bytes(b'historical compiled fixture without identity')
        self.value['server'].update(sha256=receipt.sha(self.binary),bytes=self.binary.stat().st_size)
        web=receipt.inventory(self.ui);self.value['web'].update(files=web,inventory_sha256=receipt.digest(web))
        with self.assertRaisesRegex(RuntimeError,'supported paired receipt'):
            receipt.verify(self.value,self.binary,self.ui)
        receipt.verify(self.value,self.binary,self.ui,historical=True)
        self.paired.write_text(json.dumps(self.value))
        with self.assertRaisesRegex(RuntimeError,'supported paired receipt'):self.assemble()
        self.assertFalse((self.root/'candidate').exists())

    def test_seal_rejects_version_outside_exact_source_manifest(self):
        (self.root/'v2/Cargo.toml').write_text('[workspace.package]\nversion="2.0.0-dev"\n')
        with patch.object(receipt,'git',side_effect=['a'*40,'']):
            with self.assertRaisesRegex(RuntimeError,'source workspace version'):
                receipt.seal(self.root,self.binary,self.ui,'a'*40,'2.0.0-rc.1','release',[],'2.34')

    def test_forged_receipt_identity_refused(self):
        self.value['embedded_identity']['server']['version']='2.0.0-dev'
        with self.assertRaisesRegex(RuntimeError,'paired embedded identity'):
            receipt.verify(self.value,self.binary,self.ui)


def load_tests(loader, tests, pattern):
    suite=loader.loadTestsFromTestCase(EmbeddedIdentityTests)
    for name in ('test_relabel_with_updated_hashes_still_refused_before_output','test_forged_receipt_identity_refused','test_dev_seal_requires_matching_compiled_pair','test_producer_relabel_refused_before_build','test_historical_receipt_is_explicit_integrity_only_not_new_assembly','test_seal_rejects_version_outside_exact_source_manifest'):
        suite.addTest(ReceiptRelabelTests(name))
    return suite
