"""Synthetic binaries/web and mocked provenance/HTTP; no build, server or Docker."""
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import receipt
import package_candidate as package
import soak


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='v2-candidate-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.binary = self.root/'server'
        self.binary.write_bytes(b'\x7fELF\x02\x01'+b'\0'*12+b'\x3e\0'+b'never executed')
        self.binary.chmod(0o755)
        self.ui = self.root/'web'; self.ui.mkdir()
        (self.ui/'index.html').write_text('synthetic')
        (self.ui/'app.wasm').write_bytes(b'synthetic not executed')
        (self.ui/'manifest.json').write_text('{"synthetic":true}')
        web = receipt.inventory(self.ui)
        self.value = {'format':receipt.FORMAT,'source_commit':'a'*40,'version':'2.0.0-rc.1','target':'linux-x86_64',
                      'server':{'sha256':receipt.sha(self.binary),'bytes':self.binary.stat().st_size,'profile':'release','features':[],'default_features':True},
                      'web':{'files':web,'inventory_sha256':receipt.digest(web)},
                      'schema':{'migrations':{'0001_fixture.sql':'b'*64}},
                      'build_contract':{'required_glibc':'2.34'}}
        self.paired = self.root/'paired.json';self.paired.write_text(json.dumps(self.value))

    def assemble(self):
        return package.assemble(self.binary,self.ui,self.paired,self.root/'candidate','python@sha256:'+'c'*64,19842)

    def test_same_revision_package_inventory_and_web_manifest(self):
        self.assemble()
        value = package.verify(self.root/'candidate')
        self.assertEqual(value['version'],'2.0.0-rc.1')
        self.assertIn('native/ui/manifest.json',value['files'])
        self.assertIn('docker/ui/manifest.json',value['files'])
        docker=json.loads((self.root/'candidate/docker/artifact-manifest.json').read_text())
        self.assertEqual(docker['server_source_commit_declared'],docker['ui_source_commit_declared'])

    def test_server_and_web_tamper_refused_before_output(self):
        self.binary.write_bytes(b'tamper')
        with self.assertRaisesRegex(RuntimeError,'server identity'):
            self.assemble()
        self.assertFalse((self.root/'candidate').exists())

    def test_web_manifest_tamper_refused(self):
        (self.ui/'manifest.json').write_text('tamper')
        with self.assertRaisesRegex(RuntimeError,'web identity'):
            self.assemble()

    def test_debug_or_fixture_features_refused(self):
        for key,value in [('profile','debug'),('features',['fixture-test-controls'])]:
            original=self.value['server'][key];self.value['server'][key]=value
            self.paired.write_text(json.dumps(self.value))
            with self.assertRaises(RuntimeError):self.assemble()
            self.value['server'][key]=original
        self.assertFalse((self.root/'candidate').exists())

    def test_extra_file_and_context_tamper_refused(self):
        self.assemble()
        (self.root/'candidate/docker/state_lock.py').write_text('tamper')
        with self.assertRaisesRegex(RuntimeError,'inventory mismatch'):
            package.verify(self.root/'candidate')

    def test_symlink_refused(self):
        (self.ui/'alias').symlink_to(self.ui/'index.html')
        with self.assertRaisesRegex(RuntimeError,'symlinks'):
            receipt.inventory(self.ui)

    def test_wrong_or_dirty_checkout_refused(self):
        args=(self.root,self.binary,self.ui,'a'*40,'2.0.0-rc.1','release',[],'2.34')
        with patch.object(receipt,'git',return_value='b'*40):
            with self.assertRaisesRegex(RuntimeError,'exact source'):receipt.seal(*args)
        with patch.object(receipt,'git',side_effect=['a'*40,' M tracked.rs']):
            with self.assertRaisesRegex(RuntimeError,'clean tracked'):receipt.seal(*args)

    def test_soak_records_success_and_failure_without_body(self):
        class Opener:
            def open(self,*args,**kwargs):
                return io.BytesIO(b'{"status":"ok","product":"orkestr-v2","fixture_mode":false}')
        response=Opener();stream=response.open();stream.status=200
        with patch.object(soak.urllib.request,'build_opener') as build:
            build.return_value.open.side_effect=[stream,TimeoutError('private diagnostic')]
            value=soak.measure('http://127.0.0.1:19842',2,0,1)
        self.assertEqual(value['successes'],1)
        self.assertEqual(value['samples'][1]['error_type'],'TimeoutError')
        self.assertNotIn('private diagnostic',json.dumps(value))

    def test_health_recovery_is_not_claimed_as_process_restart(self):
        def response():
            stream=io.BytesIO(b'{"status":"ok","product":"orkestr-v2","fixture_mode":false}')
            stream.status=200
            return stream
        with patch.object(soak.urllib.request,'build_opener') as build:
            build.return_value.open.side_effect=[TimeoutError(),TimeoutError(),response(),response()]
            value=soak.measure('http://127.0.0.1:19842',4,0,1,1000)
        self.assertEqual(value['longest_consecutive_failures'],2)
        self.assertEqual(value['health_recovery_transitions'],1)
        self.assertFalse(value['latency_threshold_passed'])
        self.assertEqual(value['coverage']['crash'],'unexecuted')
        self.assertEqual(value['coverage']['restart'],'unexecuted')
        self.assertEqual(value['coverage']['revocation'],'unexecuted')
        self.assertTrue(all('observed_at' in row and 'offset_ms' in row for row in value['samples']))
        self.assertGreaterEqual(value['duration_ms'],0)

    def test_latency_threshold_is_explicit_and_finite(self):
        for threshold in (0,-1,float('nan'),float('inf')):
            with self.assertRaisesRegex(RuntimeError,'finite latency'):
                soak.measure('http://127.0.0.1:19842',1,0,1,threshold)

    def test_soak_refuses_remote_unbounded_and_credentials(self):
        for origin in ('http://example.invalid:80','http://user@127.0.0.1:19842','http://127.0.0.1:19842/path'):
            with self.assertRaises(RuntimeError):soak.measure(origin,1,0,1)
        with self.assertRaises(RuntimeError):soak.measure('http://127.0.0.1:19842',0,0,1)

    def test_complete_receipt_has_only_public_metadata(self):
        with patch.object(receipt,'git',side_effect=['a'*40,'']), \
             patch.object(receipt,'schema',return_value={'0001_fixture.sql':'b'*64}), \
             patch.object(receipt.subprocess,'run',return_value=SimpleNamespace(stdout=b'synthetic-toolchain')):
            value=receipt.seal(self.root,self.binary,self.ui,'a'*40,'2.0.0-rc.1','release',[],'2.34')
        self.assertEqual(value['web']['inventory_sha256'],receipt.digest(value['web']['files']))
        self.assertEqual(value['build_contract']['wasm_bindgen'],'0.2.129')
        self.assertNotIn(str(self.root),json.dumps(value))
        self.assertEqual(value['server']['features'],[])

    def test_untracked_source_refused(self):
        with patch.object(receipt,'git',side_effect=['a'*40,'?? source.rs']):
            with self.assertRaisesRegex(RuntimeError,'clean tracked'):
                receipt.seal(self.root,self.binary,self.ui,'a'*40,'2.0.0-rc.1','release',[],'2.34')

    def test_candidate_rejection_precedes_native_execution(self):
        import accept_native
        self.assemble()
        (self.root/'candidate/native/server/orkestr-v2-server').write_bytes(b'tamper')
        with patch.object(accept_native,'invoke') as invoke:
            with self.assertRaisesRegex(RuntimeError,'inventory mismatch'):
                accept_native.exercise(self.root/'candidate',self.root,19842)
        invoke.assert_not_called()

    def test_build_owner_runner_is_offline_and_excludes_provider_environment(self):
        import build_pair
        checkout=self.root/'checkout';checkout.mkdir()
        cargo=self.root/'cargo-cache';cargo.mkdir()
        rustup=self.root/'rustup-cache';rustup.mkdir()
        wrapper=self.root/'authorized-cargo';wrapper.write_text('synthetic never executed')
        out=self.root/'build-output'
        def fake_run(command,**kwargs):
            if command[0]==str(wrapper):
                target=out/'target/release';target.mkdir(parents=True)
                (target/'orkestr-v2-server').write_bytes(self.binary.read_bytes())
            else:
                (out/'ui').mkdir()
            self.assertEqual(kwargs['env']['CARGO_NET_OFFLINE'],'true')
            self.assertEqual(kwargs['env']['PATH'].split(build_pair.os.pathsep)[0],str(cargo/'bin'))
            self.assertEqual(kwargs['env']['HOME'],str(out/'build-home'))
            self.assertNotIn('OPENAI_API_KEY',kwargs['env'])
            self.assertNotIn('UI_EXECUTION_CONTROLS',kwargs['env'])
            self.assertNotIn('UI_SERVER_CANDIDATE',kwargs['env'])
        with patch.object(receipt,'git',side_effect=['a'*40,'']), \
             patch.object(receipt,'seal',return_value=self.value), \
             patch.object(build_pair.subprocess,'run',side_effect=fake_run) as run, \
             patch.dict(build_pair.os.environ,{'OPENAI_API_KEY':'synthetic excluded'}):
            build_pair.build(checkout,out,'a'*40,'2.0.0-rc.1',wrapper,cargo,rustup,'2.34')
        self.assertEqual(run.call_count,2)
        self.assertEqual(run.call_args_list[0].args[0][1:],['build','--release','--offline','--locked','-p','orkestr-v2-server'])
        self.assertTrue(run.call_args_list[1].args[0][1].endswith('v2/apps/ui/scripts/bundle.sh'))

    def test_controls_receipt_is_explicit_and_bound_to_server_source(self):
        args=(self.root,self.binary,self.ui,'a'*40,'2.0.0-rc.1','release',[],'2.34')
        with patch.object(receipt,'git',side_effect=['a'*40,'']*2), \
             patch.object(receipt,'schema',return_value={'0001_fixture.sql':'b'*64}), \
             patch.object(receipt.subprocess,'run',return_value=SimpleNamespace(stdout=b'toolchain')):
            ordinary=receipt.seal(*args)
            controls=receipt.seal(*args,execution_controls=True)
        self.assertEqual(ordinary['web']['features'],['web'])
        self.assertNotIn('server_candidate',ordinary['web'])
        self.assertEqual(controls['web']['features'],['web','execution-controls'])
        self.assertEqual(controls['web']['server_candidate'],'a'*40)
        receipt.verify(controls,self.binary,self.ui)
        controls['web']['server_candidate']='b'*40
        with self.assertRaisesRegex(RuntimeError,'binding mismatch'):
            receipt.verify(controls,self.binary,self.ui)

    def test_controls_build_passes_exact_binding_and_seals_opt_in(self):
        import build_pair
        checkout=self.root/'checkout';checkout.mkdir()
        cargo=self.root/'cargo';cargo.mkdir()
        rustup=self.root/'rustup';rustup.mkdir()
        wrapper=self.root/'wrapper';wrapper.write_text('not executed')
        out=self.root/'output'
        def fake_run(command,**kwargs):
            self.assertEqual(kwargs['env']['UI_EXECUTION_CONTROLS'],'1')
            self.assertEqual(kwargs['env']['UI_SERVER_CANDIDATE'],'a'*40)
            if command[0]==str(wrapper):
                target=out/'target/release';target.mkdir(parents=True)
                (target/'orkestr-v2-server').write_bytes(self.binary.read_bytes())
        with patch.object(receipt,'git',side_effect=['a'*40,'']), \
             patch.object(receipt,'seal',return_value=self.value) as seal, \
             patch.object(build_pair.subprocess,'run',side_effect=fake_run) as run:
            build_pair.build(checkout,out,'a'*40,'2.0.0-rc.1',wrapper,cargo,rustup,'2.34',execution_controls=True)
        self.assertEqual(run.call_count,2)
        self.assertEqual(seal.call_args.kwargs,{'execution_controls':True})

    def test_archive_is_deterministic_for_verified_candidate(self):
        import archive
        self.assemble()
        a=archive.archive(self.root/'candidate',self.root/'a.tar.gz')
        b=archive.archive(self.root/'candidate',self.root/'b.tar.gz')
        self.assertEqual(a,b)
        with self.assertRaises(RuntimeError):archive.archive(self.root/'candidate',self.root/'a.tar.gz')
