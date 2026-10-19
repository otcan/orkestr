"""Root-only synthetic full-package checks; no executable/provider is launched."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import selected
from manager_source import authority, MANAGER_BASE
from prepare import inventory

REPO=Path(__file__).resolve().parents[4]
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()

@unittest.skipUnless(os.geteuid()==0,'explicit root synthetic custody test')
class Selected(unittest.TestCase):
    def setUp(self):
        self.root=Path(tempfile.mkdtemp(prefix='sv-',dir='/root'))
        self.addCleanup(lambda:shutil.rmtree(self.root))
        r=self.root
        for name in ('home','home/data','home/provider-home','workspace','state','authdir'):
            p=r/name;p.mkdir();p.chmod(0o700);os.chown(p,995,986)
        for name in ('bootstrap','authdir/auth.json'):
            p=r/name;p.write_bytes(b'synthetic-only');p.chmod(0o600);os.chown(p,995,986)
        header=b'\x7fELF\x02\x01'+b'\0'*12+b'\x3e\0'
        (r/'server').write_bytes(header+f'ORKESTR_V2_BUILD_IDENTITY_V1|server|2.0.0-beta.1|{MANAGER_BASE}|END'.encode())
        (r/'native').write_bytes(header+b'not-executable-fixture')
        (r/'ui').mkdir();(r/'ui/index.html').write_text('synthetic')
        (r/'ui/app.wasm').write_bytes(f'ORKESTR_V2_BUILD_IDENTITY_V1|web|2.0.0-beta.1|{MANAGER_BASE}|END'.encode())
        pair={'source_commit':MANAGER_BASE,'version':'2.0.0-beta.1',
              'server':{'profile':'release','default_features':True,'features':[],'sha256':sha(r/'server')},
              'web':{'profile':'release','features':['web','execution-controls'],'server_candidate':MANAGER_BASE,'files':inventory(r/'ui')}}
        (r/'pair').write_text(json.dumps(pair))
        self.plan={'format':'orkestr-v2-selected-service-plan-v1','source_repository':str(REPO),
            **{k:str(r/v) for k,v in {'output':'release','pair':'pair','server':'server','ui':'ui','native':'native',
             'home':'home','workspace':'workspace','state_root':'state','auth_file':'authdir/auth.json',
             'bootstrap_file':'bootstrap','ledger_directory':'ledger','endpoint_directory':'ep'}.items()},
            'pair_sha256':sha(r/'pair'),'native_sha256':sha(r/'native'),'uid':995,'gid':986,
            'owner_id':'11111111-1111-4111-8111-111111111111','conversation_id':'22222222-2222-4222-8222-222222222222',
            'namespace':'synthetic','supervisor_key':'synthetic','origin':'https://example.invalid','port':19842}
    def validate(self):
        with authority(REPO,MANAGER_BASE) as (_,manager,_):
            return manager.Package(self.root/'release/package',sha(self.root/'release/package/manifest.json'))
    def test_full_package_credentials_metadata_only(self):
        original=Path.open
        def guarded(path,*a,**kw):
            if path.name in ('auth.json','bootstrap'):raise AssertionError('credential read')
            return original(path,*a,**kw)
        with patch.object(Path,'open',guarded):result=selected.prepare(self.plan);self.validate()
        self.assertFalse(result['activated'])
        beta=self.root/'release/package/beta.json'
        self.assertEqual((beta.stat().st_uid,beta.stat().st_gid,beta.stat().st_mode&0o777),(0,986,0o640))
        receipt=json.loads((self.root/'release/release.json').read_bytes())
        self.assertFalse(receipt['credential_contents_read'])
        self.assertEqual((self.root/'release').stat().st_mode&0o777,0o750)
        self.assertIn('-I -S -B',(self.root/'release/package/launcher.py').read_text())
    def test_reserved_directories_retained(self):
        for name,mode in (('ledger',0o700),('ep',0o750)):
            p=self.root/name;p.mkdir();os.chown(p,0,986);p.chmod(mode)
        selected.prepare(self.plan);self.validate()
    def test_tampered_ui(self):
        (self.root/'ui/index.html').write_text('tampered')
        with self.assertRaises(Exception):selected.prepare(self.plan)
        self.assertFalse((self.root/'release').exists())
    def test_no_overwrite(self):
        (self.root/'release').mkdir()
        with self.assertRaises(Exception):selected.prepare(self.plan)
    def test_module_tamper(self):
        selected.prepare(self.plan)
        (self.root/'release/package/codex_service/entry.py').write_text('tampered')
        with self.assertRaises(Exception):self.validate()
    def test_finalpath_relocation_refused(self):
        selected.prepare(self.plan);shutil.move(self.root/'release',self.root/'moved')
        with authority(REPO,MANAGER_BASE) as (_,manager,_):
            with self.assertRaises(Exception):manager.Package(self.root/'moved/package')
    def test_failed_validation_cleanup_preserves_reserved(self):
        for name,mode in (('ledger',0o700),('ep',0o750)):
            p=self.root/name;p.mkdir();os.chown(p,0,986);p.chmod(mode)
        self.plan['owner_id']='invalid'
        with self.assertRaises(Exception):selected.prepare(self.plan)
        self.assertFalse((self.root/'release').exists())
        self.assertTrue((self.root/'ledger').is_dir())
    def test_native_tamper(self):
        (self.root/'native').write_bytes(b'tampered')
        with self.assertRaises(Exception):selected.prepare(self.plan)
        self.assertFalse((self.root/'release').exists())
    def test_manifest_pin(self):
        selected.prepare(self.plan)
        with authority(REPO,MANAGER_BASE) as (_,manager,_):
            with self.assertRaises(Exception):manager.Package(self.root/'release/package','0'*64)
    def test_crossbinding_tamper_even_rehashed(self):
        selected.prepare(self.plan);root=self.root/'release/package'
        beta=json.loads((root/'beta.json').read_bytes());beta['workspace']=str(self.root/'state')
        (root/'beta.json').write_bytes(selected.encoded(beta))
        manifest=json.loads((root/'manifest.json').read_bytes());manifest['files']['beta.json']=sha(root/'beta.json')
        (root/'manifest.json').write_bytes(selected.encoded(manifest))
        with self.assertRaises(Exception):self.validate()
    def test_bad_custody(self):
        selected.prepare(self.plan);(self.root/'release/package/server').chmod(0o777)
        with self.assertRaises(Exception):self.validate()

if __name__=='__main__':unittest.main()
