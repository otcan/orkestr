"""Root-only synthetic full-package checks; no executable/provider is launched."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import subprocess
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
    def test_beta2_embedded_version_must_match_pair(self):
        r=self.root
        for name in ('server','ui/app.wasm'):
            p=r/name;p.write_bytes(p.read_bytes().replace(b'2.0.0-beta.1',b'2.0.0-beta.2'))
        pair=json.loads((r/'pair').read_bytes());pair['version']='2.0.0-beta.2'
        pair['server']['sha256']=sha(r/'server');pair['web']['files']=inventory(r/'ui')
        (r/'pair').write_text(json.dumps(pair));self.plan['pair_sha256']=sha(r/'pair')
        self.assertEqual(selected.pair_bytes(self.plan)['version'],'2.0.0-beta.2')
        (r/'ui/app.wasm').write_bytes((r/'ui/app.wasm').read_bytes().replace(b'2.0.0-beta.2',b'2.0.0-beta.1'))
        pair['web']['files']=inventory(r/'ui');(r/'pair').write_text(json.dumps(pair))
        self.plan['pair_sha256']=sha(r/'pair')
        with self.assertRaisesRegex(RuntimeError,'embedded identity mismatch'):
            selected.pair_bytes(self.plan)
    def test_existing_state_requires_opt_in_and_remains_untouched(self):
        markers=[]
        for name in ('workspace','state','ledger','ep'):
            directory=self.root/name
            if not directory.exists():
                directory.mkdir();os.chown(directory,0,986)
                directory.chmod(0o700 if name=='ledger' else 0o750)
            marker=directory/'synthetic-existing-state';marker.write_bytes(b'preserve exact bytes')
            markers.append(marker)
        with self.assertRaisesRegex(RuntimeError,'fresh native state/workspace'):
            selected.prepare(self.plan)
        self.assertFalse((self.root/'release').exists())
        self.plan['preserve_state']=True
        selected.prepare(self.plan);self.validate()
        self.assertTrue(json.loads((self.root/'release/release.json').read_bytes())['preserved_existing_state'])
        for marker in markers:self.assertEqual(marker.read_bytes(),b'preserve exact bytes')
    def test_current_source_packages_fixed_roles_and_shared_read_only_workspace(self):
        source=subprocess.check_output(['/usr/bin/git','-c','safe.directory='+str(REPO),
            '-C',str(REPO),'rev-parse','HEAD'],text=True).strip()
        r=self.root
        for name in ('server','ui/app.wasm'):
            p=r/name;p.write_bytes(p.read_bytes().replace(MANAGER_BASE.encode(),source.encode())
                                   .replace(b'2.0.0-beta.1',b'2.0.0-beta.2'))
        pair=json.loads((r/'pair').read_bytes());pair['source_commit']=source;pair['version']='2.0.0-beta.2'
        pair['server']['sha256']=sha(r/'server');pair['web']['files']=inventory(r/'ui')
        pair['web']['server_candidate']=source
        (r/'pair').write_text(json.dumps(pair));self.plan['pair_sha256']=sha(r/'pair')
        roles=[]
        for index in range(5):
            state=r/f'role-state-{index}';state.mkdir(mode=0o700);os.chown(state,995,986)
            roles.append({'workspace':str(r/'workspace'),'state_root':str(state)})
        self.plan['roles']={'fast':roles[0],'workers':roles[1:]}
        self.plan['live_map']='/var/lib/synthetic-live-map/map.json'
        self.plan['desktop_broker']='/var/lib/synthetic-private/desktop-broker.json'
        self.plan['timer_config']='/var/lib/synthetic-private/timers.json'
        self.plan['v1_chat_icons_dir']='/var/lib/synthetic-v1/chat-icons'
        self.plan['whatsapp_chats']='/var/lib/synthetic-private/whatsapp-chats.json'
        selected.prepare(self.plan)
        with authority(REPO,source) as (_,manager,_):
            package=manager.Package(r/'release/package',sha(r/'release/package/manifest.json'))
            self.assertEqual(set(package.role_profiles),{'deep','fast','worker-0','worker-1','worker-2','worker-3'})
            self.assertEqual(package.environment()['ORKESTR_V2_LIVE_MAP'],'/var/lib/synthetic-live-map/map.json')
            self.assertEqual(package.environment()['ORKESTR_V2_DESKTOP_BROKER_CONFIG'],
                             '/var/lib/synthetic-private/desktop-broker.json')
            self.assertEqual(package.environment()['ORKESTR_V2_TIMER_CONFIG'],'/var/lib/synthetic-private/timers.json')
            self.assertEqual(package.environment()['ORKESTR_V2_V1_CHAT_ICONS_DIR'],'/var/lib/synthetic-v1/chat-icons')
            self.assertEqual(package.environment()['ORKESTR_V2_WHATSAPP_CHATS_CONFIG'],
                             '/var/lib/synthetic-private/whatsapp-chats.json')
        for role in ('fast','worker-0','worker-1','worker-2','worker-3'):
            self.assertIn('broker-'+role,(r/f'release/package/launcher-{role}.py').read_text())
        receipt=json.loads((r/'release/release.json').read_bytes())
        self.assertTrue(receipt['roles_enabled']);self.assertFalse(receipt['provider_invoked'])
    def test_desktop_broker_path_refused_before_any_artifact_read(self):
        for bad in ('relative/broker.json','/var/../broker.json',7):
            self.plan['desktop_broker']=bad
            with self.assertRaisesRegex(RuntimeError,'desktop broker path'):selected.prepare(self.plan)
        self.assertFalse((self.root/'release').exists())
    def test_timer_config_path_refused_before_any_artifact_read(self):
        for bad in ('relative/timers.json','/var/../timers.json',7):
            self.plan['timer_config']=bad
            with self.assertRaisesRegex(RuntimeError,'timer config path'):selected.prepare(self.plan)
        self.assertFalse((self.root/'release').exists())
    def test_whatsapp_chats_path_refused_before_any_artifact_read(self):
        for bad in ('relative/chats.json','/var/../chats.json',7):
            self.plan['whatsapp_chats']=bad
            with self.assertRaisesRegex(RuntimeError,'whatsapp chats path'):selected.prepare(self.plan)
        self.assertFalse((self.root/'release').exists())
    def test_live_map_path_refused_before_any_artifact_read(self):
        for bad in ('relative/map.json','/var/../map.json',7):
            self.plan['live_map']=bad
            with self.assertRaisesRegex(RuntimeError,'live map path'):selected.prepare(self.plan)
        self.assertFalse((self.root/'release').exists())
    def test_current_source_pins_the_code_mode_host_beside_host_natives(self):
        source=subprocess.check_output(['/usr/bin/git','-c','safe.directory='+str(REPO),
            '-C',str(REPO),'rev-parse','HEAD'],text=True).strip()
        r=self.root
        for name in ('server','ui/app.wasm'):
            p=r/name;p.write_bytes(p.read_bytes().replace(MANAGER_BASE.encode(),source.encode())
                                   .replace(b'2.0.0-beta.1',b'2.0.0-beta.3'))
        pair=json.loads((r/'pair').read_bytes());pair['source_commit']=source;pair['version']='2.0.0-beta.3'
        pair['server']['sha256']=sha(r/'server');pair['web']['files']=inventory(r/'ui')
        pair['web']['server_candidate']=source
        (r/'pair').write_text(json.dumps(pair));self.plan['pair_sha256']=sha(r/'pair')
        header=b'\x7fELF\x02\x01'+b'\0'*12+b'\x3e\0'
        (r/'code-mode-host').write_bytes(header+b'synthetic-code-mode-host')
        self.plan['host_full_access']={'providers':True,'environment':{'HOME':'/home/service','PATH':'/usr/bin:/bin'}}
        with self.assertRaisesRegex(RuntimeError,'code_mode_host'):selected.prepare(self.plan)
        self.plan['code_mode_host']=str(r/'code-mode-host')
        self.plan['code_mode_host_sha256']='0'*64
        with self.assertRaisesRegex(RuntimeError,'artifact digest mismatch'):selected.prepare(self.plan)
        self.assertFalse((r/'release').exists())
        self.plan['code_mode_host_sha256']=sha(r/'code-mode-host')
        selected.prepare(self.plan)
        packaged=r/'release/package/codex-code-mode-host'
        self.assertEqual(sha(packaged),sha(r/'code-mode-host'))
        self.assertTrue(packaged.stat().st_mode&0o111)
        self.assertEqual(packaged.parent,(r/'release/package/native').parent)
        with authority(REPO,source) as (_,manager,_):
            package=manager.Package(r/'release/package',sha(r/'release/package/manifest.json'))
            self.assertIn('codex-code-mode-host',package.manifest['files'])
        self.assertTrue(json.loads((r/'release/release.json').read_bytes())['host_full_access_enabled'])
    def test_current_source_packages_claude_windows_by_account_reference(self):
        source=subprocess.check_output(['/usr/bin/git','-c','safe.directory='+str(REPO),
            '-C',str(REPO),'rev-parse','HEAD'],text=True).strip()
        r=self.root
        for name in ('server','ui/app.wasm'):
            p=r/name;p.write_bytes(p.read_bytes().replace(MANAGER_BASE.encode(),source.encode())
                                   .replace(b'2.0.0-beta.1',b'2.0.0-beta.3'))
        pair=json.loads((r/'pair').read_bytes());pair['source_commit']=source;pair['version']='2.0.0-beta.3'
        pair['server']['sha256']=sha(r/'server');pair['web']['files']=inventory(r/'ui')
        pair['web']['server_candidate']=source
        (r/'pair').write_text(json.dumps(pair));self.plan['pair_sha256']=sha(r/'pair')
        header=b'\x7fELF\x02\x01'+b'\0'*12+b'\x3e\0'
        (r/'code-mode-host').write_bytes(header+b'synthetic-code-mode-host')
        self.plan.update(code_mode_host=str(r/'code-mode-host'),code_mode_host_sha256=sha(r/'code-mode-host'))
        environment={'HOME':'/home/service','PATH':'/usr/bin:/bin'}
        self.plan['host_full_access']={'providers':True,'environment':environment}
        (r/'claude-cli').write_bytes(b'synthetic-claude-cli');(r/'claude-cli').chmod(0o755)
        for name in ('claude-account','claude-workspace','claude-home','claude-tmp'):
            p=r/name;p.mkdir();p.chmod(0o700);os.chown(p,995,986)
        (r/'claude-account/.credentials.json').write_bytes(b'synthetic-never-read')
        claude={'executable':str(r/'claude-cli'),'account':str(r/'claude-account'),
                'workspace':str(r/'claude-workspace'),'home':str(r/'claude-home'),
                'temporary':str(r/'claude-tmp'),'fast':True}
        self.plan['claude']=dict(claude)
        quota=r/'quota';quota.mkdir(mode=0o750);os.chown(quota,995,986)
        self.plan['claude_quota_projection']={'directory':str(quota),'account_ref':'33333333-3333-4333-8333-333333333333'}
        self.plan['host_full_access']={'providers':True,'environment':{**environment,'ANTHROPIC_API_KEY':'x'}}
        with self.assertRaisesRegex(RuntimeError,'Claude account'):selected.prepare(self.plan)
        self.plan['host_full_access']={'providers':True,'environment':environment}
        original=Path.open
        def guarded(path,*a,**kw):
            if 'claude-account' in str(path):raise AssertionError('Claude account read')
            return original(path,*a,**kw)
        with patch.object(Path,'open',guarded):selected.prepare(self.plan)
        with authority(REPO,source) as (_,manager,_):
            package=manager.Package(r/'release/package',sha(r/'release/package/manifest.json'))
            self.assertEqual(package.claude['workspace'],claude['workspace'])
            self.assertTrue(package.claude['fast'] and not package.claude['default'])
            self.assertEqual(package.runtime['claude_quota_projection'],self.plan['claude_quota_projection'])
            self.assertIn('broker/claude_quota.py',package.manifest['files'])
            # Exercise the actual protected Package contract, not a lookalike
            # that can accidentally invent attributes absent in production.
            from claude_connector import ClaudeConfiguration
            from claude_quota import QuotaSink
            with patch.object(Path,'open',guarded):
                config=ClaudeConfiguration.load(r/'release/package/claude-private.json')
                sink=QuotaSink.optional(package,config)
            self.assertIsInstance(sink,QuotaSink)
            self.assertEqual(sink.directory,quota)
            self.assertEqual(sink.uid,995)
            self.assertEqual(sink.owner,self.plan['owner_id'])
            package.runtime['claude_quota_projection']['directory']=str(package.endpoint.parent)
            self.assertIsNone(QuotaSink.optional(package,config))
        self.assertIn('broker-claude',(r/'release/package/launcher-claude.py').read_text())
        private=json.loads((r/'release/package/claude-private.json').read_bytes())
        self.assertEqual(private['host_full_access'],{'environment':environment})
        self.assertTrue(json.loads((r/'release/release.json').read_bytes())['claude_enabled'])
    def test_current_source_packages_command_profiles_for_several_conversations(self):
        source=subprocess.check_output(['/usr/bin/git','-c','safe.directory='+str(REPO),
            '-C',str(REPO),'rev-parse','HEAD'],text=True).strip()
        r=self.root
        for name in ('server','ui/app.wasm'):
            p=r/name;p.write_bytes(p.read_bytes().replace(MANAGER_BASE.encode(),source.encode())
                                   .replace(b'2.0.0-beta.1',b'2.0.0-beta.3'))
        pair=json.loads((r/'pair').read_bytes());pair['source_commit']=source;pair['version']='2.0.0-beta.3'
        pair['server']['sha256']=sha(r/'server');pair['web']['files']=inventory(r/'ui')
        pair['web']['server_candidate']=source
        (r/'pair').write_text(json.dumps(pair));self.plan['pair_sha256']=sha(r/'pair')
        roles=[]
        for index in range(5):
            state=r/f'role-state-{index}';state.mkdir(mode=0o700);os.chown(state,995,986)
            roles.append({'workspace':str(r/'workspace'),'state_root':str(state)})
        self.plan['roles']={'fast':roles[0],'workers':roles[1:]}
        def profile(conversation,project,name):
            workspace=r/name;workspace.mkdir(mode=0o700);os.chown(workspace,995,986)
            return {'conversation_id':conversation,'project_id':project,'workspace':str(workspace),
                    'allowed_roots':[str(workspace)],'protected_roots':[str(r/'home')],
                    'cgroup_root':'/sys/fs/cgroup/example/jobs','toolchain_root':'/opt/example-image/root'}
        self.plan['workspace_exec']=profile(self.plan['conversation_id'],'44444444-4444-4444-8444-444444444444','project-a')
        second=profile('55555555-5555-4555-8555-555555555555','66666666-6666-4666-8666-666666666666','project-b')
        self.plan['additional_workspace_exec']=[dict(second,project_id='44444444-4444-4444-8444-444444444444')]
        with self.assertRaisesRegex(RuntimeError,'overlap'):selected.prepare(self.plan)
        self.assertFalse((r/'release').exists())
        self.plan['additional_workspace_exec']=[second]
        selected.prepare(self.plan)
        with authority(REPO,source) as (_,manager,_):
            package=manager.Package(r/'release/package',sha(r/'release/package/manifest.json'))
            self.assertEqual(package.beta['additional_workspace_exec'],[second])
        # Many conversations with their own workspace fit (bounded at 128).
        many=[profile('%08d-5555-4555-8555-555555555555'%i,'%08d-6666-4666-8666-666666666666'%i,f'project-{i}')
              for i in range(40)]
        self.plan['additional_workspace_exec']=many
        shutil.rmtree(r/'release')
        selected.prepare(self.plan)
        with authority(REPO,source) as (_,manager,_):
            package=manager.Package(r/'release/package',sha(r/'release/package/manifest.json'))
            self.assertEqual(len(package.beta['additional_workspace_exec']),40)
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
