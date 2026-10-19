import importlib.util
import json
import os
import subprocess
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import prepare
import closure


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.scratch=tempfile.TemporaryDirectory();self.addCleanup(self.scratch.cleanup)
        self.root=Path(self.scratch.name).resolve();self.out=self.root/'package'
        self.binary=self.root/'binary';self.ui=self.root/'ui';self.ui.mkdir()
        self.source='a'*40
        record=lambda component:f'ORKESTR_V2_BUILD_IDENTITY_V1|{component}|2.0.0-beta.1|{self.source}|END'.encode()
        self.binary.write_bytes(record('server'));(self.ui/'web.wasm').write_bytes(record('web'));(self.ui/'index.html').write_text('synthetic')
        self.value={'version':'2.0.0-beta.1','source_commit':self.source,'server':{'profile':'release','default_features':True,'features':[],'sha256':closure.pin(self.binary)['sha256']},'web':{'profile':'release','features':['web','execution-controls'],'server_candidate':self.source,'files':prepare.inventory(self.ui)}}
        self.pair=self.root/'pair.json'

    def assemble(self):
        self.pair.write_text(json.dumps(self.value));digest=closure.pin(self.pair)['sha256']
        dependencies={'readelf':{},'files':{str(self.binary):closure.pin(self.binary)}}
        with patch.object(prepare,'elf_files',return_value=dependencies),patch.object(prepare,'python_files',return_value={}):
            return prepare.prepare(self.pair,digest,self.binary,self.ui,self.out,self.root/'home','https://beta.example.invalid',19822,995)

    def test_exact_pair_and_explicit_environment_without_parent_credentials(self):
        with patch.dict('os.environ',{'PROVIDER_KEY':'synthetic'},clear=True):path=self.assemble()
        plan=json.loads(path.read_text());env=plan['settings']['environment']
        self.assertNotIn('PROVIDER_KEY',env);self.assertNotIn('ORKESTR_V2_BOOTSTRAP_TOKEN',env)
        self.assertEqual(env['ORKESTR_V2_UI_DIST'],str(self.out/'ui'))
        self.assertEqual(env['ORKESTR_V2_ORIGIN'],'https://beta.example.invalid')
        self.assertFalse((self.root/'home').exists())
        self.assertEqual(plan['dependencies']['server']['files'][str(self.out/'server')]['mode'],0o550)

    def test_relabel_refused_before_publication(self):
        self.binary.write_bytes(self.binary.read_bytes().replace(b'beta.1',b'beta.2'))
        self.value['server']['sha256']=closure.pin(self.binary)['sha256']
        with self.assertRaisesRegex(RuntimeError,'embedded'):self.assemble()
        self.assertFalse(self.out.exists())

    def test_tampered_ui_refused(self):
        (self.ui/'index.html').write_text('changed')
        with self.assertRaisesRegex(RuntimeError,'web inventory'):self.assemble()
        self.assertFalse(self.out.exists())

    def test_incomplete_copy_never_publishes_manifest(self):
        with patch.object(prepare.shutil,'copytree',side_effect=OSError('synthetic copy failure')):
            with self.assertRaises(OSError):self.assemble()
        self.assertFalse(self.out.exists())

    def test_no_overwrite(self):
        self.out.mkdir();(self.out/'retained').write_text('preserved')
        with self.assertRaisesRegex(RuntimeError,'fresh'):self.assemble()
        self.assertEqual((self.out/'retained').read_text(),'preserved')

    def test_untrusted_origins_and_home_overlap(self):
        for origin in ('http://beta.example.invalid','https://user:pass@example.invalid','https://example.invalid/path','https://0.0.0.0'):
            with self.assertRaises(RuntimeError):prepare.settings(self.root/'home',origin,19822,995,self.out)
        with self.assertRaisesRegex(RuntimeError,'overlap'):prepare.settings(self.out/'home','https://example.invalid',19822,995,self.out)
        with self.assertRaises(RuntimeError):prepare.settings(self.root/'home','https://example.invalid',19822,0,self.out)

    def test_nonisolated_python_capture_refused(self):
        with self.assertRaisesRegex(RuntimeError,'-I -S -B'):closure.python_files()

    def test_dependency_change_refused(self):
        pin=closure.pin(self.binary);self.binary.write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError,'changed'):closure.verify([pin])

    def startup_child(self, tamper=False, wrong_uid=False):
        manifest=self.assemble();value=json.loads(manifest.read_text())
        home=self.root/'home';home.mkdir(mode=0o700)
        value['settings']['uid']=os.getuid()+(1 if wrong_uid else 0)
        value['settings']['gid']=os.getgid()
        value['dependencies']['server']['readelf']=closure.pin(self.binary)
        value['dependencies']['python']={'files':{},'native':{},'executable':str(Path(sys.executable).resolve())}
        manifest.chmod(0o600);manifest.write_text(json.dumps(value))
        digest=closure.pin(manifest)['sha256']
        if tamper:
            (self.out/'ui/index.html').chmod(0o600);(self.out/'ui/index.html').write_text('tampered')
        read,write=os.pipe();os.write(write,b'synthetic-bootstrap-only');os.close(write)
        code="import sys;sys.path.insert(0,sys.argv[1]);import start;from pathlib import Path;a,e=start.startup(Path(sys.argv[2]),sys.argv[3],int(sys.argv[4]));assert e['ORKESTR_V2_BOOTSTRAP_TOKEN']=='synthetic-bootstrap-only';assert 'PROVIDER_KEY' not in e;print('verified startup without exec')"
        try:
            return subprocess.run([sys.executable,'-I','-S','-B','-c',code,str(Path(__file__).resolve().parents[1]),str(manifest),digest,str(read)],pass_fds=(read,),env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','PROVIDER_KEY':'must-not-leak'},capture_output=True,text=True,timeout=10)
        finally:os.close(read)

    def test_isolated_child_verifies_pipe_environment_without_starting_server(self):
        result=self.startup_child()
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('verified startup without exec',result.stdout)

    def test_startup_rejects_package_tamper(self):
        result=self.startup_child(tamper=True)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('package inventory changed',result.stderr)

    def test_startup_rejects_wrong_dropped_identity(self):
        result=self.startup_child(wrong_uid=True)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('drop uid',result.stderr)

    def test_distinct_service_group_is_explicit(self):
        value=prepare.settings(self.root/'home','https://beta.example.invalid',19822,995,self.out,986)
        self.assertEqual((value['uid'],value['gid']),(995,986))
        with self.assertRaisesRegex(RuntimeError,'gid'):
            prepare.settings(self.root/'home','https://beta.example.invalid',19822,995,self.out,0)

    def test_closed_beta_config_contract(self):
        from beta_config import validate
        value={'schema_version':1,'owner_id':'11111111-1111-4111-8111-111111111111',
               'conversation_id':'22222222-2222-4222-8222-222222222222',
               'manager_socket':'/run/example/manager.sock','launcher':'/opt/example/launcher',
               'launcher_sha256':'a'*64,'workspace':'/var/lib/example/workspace',
               'namespace':'synthetic','supervisor_key':'synthetic.deep'}
        self.assertEqual(validate(json.dumps(value).encode()),value)
        for key,bad in [('schema_version',True),('owner_id','00000000-0000-0000-0000-000000000000'),
                        ('launcher','relative'),('launcher_sha256','A'*64),('namespace','bad key')]:
            with self.subTest(key=key),self.assertRaises(RuntimeError):
                validate(json.dumps(dict(value,**{key:bad})).encode())
        with self.assertRaises(RuntimeError):validate(json.dumps(dict(value,token='forbidden')).encode())
        with self.assertRaisesRegex(RuntimeError,'duplicate'):validate(b'{"schema_version":1,"schema_version":1}')
        with self.assertRaisesRegex(RuntimeError,'bounded'):validate(b' '*8193)
