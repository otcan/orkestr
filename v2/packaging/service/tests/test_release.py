import json
from pathlib import Path
import shlex
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from closure import pin
from release import prepare_release, wrapper


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();self.package=self.root/'inner'
        (self.package/'codex_service').mkdir(parents=True)
        (self.package/'codex_service/entry.py').write_text('raise SystemExit("never executed")\n')
        (self.package/'manifest.json').write_text(json.dumps({'format':'orkestr-v2-codex-service-package-v1','source_commit':'a'*40}))
        self.digest=pin(self.package/'manifest.json')['sha256'];self.output=self.root/'release'
        (self.package/'launcher.py').write_bytes(b'synthetic never executed')
        beta={'schema_version':1,'owner_id':'11111111-1111-4111-8111-111111111111',
              'conversation_id':'22222222-2222-4222-8222-222222222222',
              'launcher':str(self.output/'package/launcher.py'),
              'launcher_sha256':pin(self.package/'launcher.py')['sha256'],
              'manager_socket':'/run/synthetic/manager.sock','workspace':'/var/lib/synthetic/workspace',
              'namespace':'synthetic','supervisor_key':'synthetic'}
        (self.package/'beta.json').write_text(json.dumps(beta))
        (self.package/'profile.json').write_text(json.dumps({'native':str(self.output/'package/native'),
            'supervisor':str(self.output/'package/isolation/supervisor.py'),'workspace':beta['workspace']}))
        (self.package/'service.json').write_text(json.dumps({'owner_id':beta['owner_id'],
            'conversation_id':beta['conversation_id']}))

    def test_outer_wrapper_pins_inner_without_inventory_cycle(self):
        path=prepare_release(self.package,self.digest,self.output)
        value=json.loads(path.read_text());text=(self.output/'start-service').read_text()
        self.assertIn('-I -S -B',text);self.assertIn(self.digest,text)
        self.assertIn('start-service',value['files'])
        self.assertNotIn('release.json',value['files'])
        self.assertFalse((self.output/'package/start-service').exists())
        self.assertEqual((self.output/'package/manifest.json').read_bytes(),(self.package/'manifest.json').read_bytes())
        self.assertIn('manager',shlex.split(text.split('exec ',1)[1]))

    def test_wrong_manifest_refuses_before_publication(self):
        with self.assertRaisesRegex(RuntimeError,'manifest mismatch'):
            prepare_release(self.package,'b'*64,self.output)
        self.assertFalse(self.output.exists())

    def test_inner_alias_refused(self):
        (self.package/'alias').symlink_to('manifest.json')
        with self.assertRaisesRegex(RuntimeError,'symlinks'):
            prepare_release(self.package,self.digest,self.output)
        self.assertFalse(self.output.exists())

    def test_existing_release_preserved(self):
        self.output.mkdir();(self.output/'retained').write_bytes(b'preserved')
        with self.assertRaisesRegex(RuntimeError,'fresh'):
            prepare_release(self.package,self.digest,self.output)
        self.assertEqual((self.output/'retained').read_bytes(),b'preserved')

    def test_wrapper_literal_path_and_no_argument_forwarding(self):
        text=wrapper(Path('/opt/synthetic release'),Path('/usr/bin/python3.11'),'a'*64).decode()
        self.assertIn("'/opt/synthetic release/package/codex_service/entry.py'",text)
        self.assertNotIn('$@',text)
        self.assertIn('[ "$#" -eq 0 ] || exit 2',text)

    def test_staging_path_binding_refused_before_copy(self):
        path=self.package/'beta.json';value=json.loads(path.read_text())
        value['launcher']=str(self.package/'launcher.py');path.write_text(json.dumps(value))
        with self.assertRaisesRegex(RuntimeError,'final launcher'):
            prepare_release(self.package,self.digest,self.output)
        self.assertFalse(self.output.exists())

    def test_scope_mismatch_refused_before_copy(self):
        path=self.package/'service.json';value=json.loads(path.read_text())
        value['conversation_id']='33333333-3333-4333-8333-333333333333';path.write_text(json.dumps(value))
        with self.assertRaisesRegex(RuntimeError,'scope binding'):
            prepare_release(self.package,self.digest,self.output)
        self.assertFalse(self.output.exists())
