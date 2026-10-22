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
        with self.assertRaisesRegex(RuntimeError,'bounded'):validate(b' '*16385)

    def test_selected_plan_accepts_only_closed_host_full_access(self):
        from selected import OPTIONAL, optional
        self.assertIn('host_full_access', OPTIONAL)
        access = {'providers': True, 'environment': {'HOME': '/home/service', 'PATH': '/usr/bin:/bin'}}
        host = {'code_mode_host': '/opt/codex/bin/codex-code-mode-host', 'code_mode_host_sha256': 'a' * 64}
        optional({'host_full_access': access, **host})
        for bad in ({'providers': True}, {'environment': {'PATH': '/bin'}},
                    {'providers': 'yes', 'environment': access['environment']},
                    dict(access, extra=True)):
            with self.subTest(bad=bad), self.assertRaises(RuntimeError):
                optional({'host_full_access': bad, **host})
        profile = {'conversation_id': '33333333-3333-4333-8333-333333333333',
                   'project_id': '44444444-4444-4444-8444-444444444444', 'workspace': '/srv/project',
                   'allowed_roots': ['/srv/project'], 'protected_roots': ['/srv/private'],
                   'cgroup_root': '/sys/fs/cgroup/example', 'toolchain_root': '/opt/image',
                   'trusted': {'host_privileged': True}}
        with self.assertRaisesRegex(RuntimeError, 'require host_full_access'):
            optional({'roles': {}, 'workspace_exec': profile})
        optional({'roles': {}, 'workspace_exec': profile, 'host_full_access': access, **host})

    def test_host_natives_require_exactly_one_pinned_code_mode_host(self):
        from selected import OPTIONAL, optional
        self.assertLessEqual({'code_mode_host', 'code_mode_host_sha256'}, OPTIONAL)
        access = {'providers': True, 'environment': {'HOME': '/home/service', 'PATH': '/usr/bin:/bin'}}
        host = {'code_mode_host': '/opt/codex/bin/codex-code-mode-host', 'code_mode_host_sha256': 'b' * 64}
        # Codex fails every dynamic tool call without its code-mode host.
        with self.assertRaisesRegex(RuntimeError, 'code_mode_host'):
            optional({'host_full_access': access})
        # A sandboxed provider forbids subprocesses: no host binary there.
        for plan in ({**host}, {'host_full_access': dict(access, providers=False), **host}):
            with self.subTest(plan=sorted(plan)), self.assertRaisesRegex(RuntimeError, 'code_mode_host'):
                optional(plan)
        optional({'host_full_access': dict(access, providers=False)})
        for bad in ({'code_mode_host': host['code_mode_host']},
                    {'code_mode_host': 'relative', 'code_mode_host_sha256': 'b' * 64},
                    {'code_mode_host': host['code_mode_host'], 'code_mode_host_sha256': 'B' * 64}):
            with self.subTest(bad=bad), self.assertRaises(RuntimeError):
                optional({'host_full_access': access, **bad})

    def test_workspace_exec_profile_is_explicit_exact_and_never_browser_authority(self):
        from beta_config import validate, workspace_exec
        profile={'conversation_id':'11111111-1111-4111-8111-111111111111',
                 'project_id':'22222222-2222-4222-8222-222222222222',
                 'workspace':'/srv/project','allowed_roots':['/srv/project'],
                 'protected_roots':['/srv/provider-account'],
                 'cgroup_root':'/sys/fs/cgroup/commands','toolchain_root':'/opt/command-image'}
        self.assertEqual(workspace_exec(profile),profile)
        for key,value in [
            ('allowed_roots',['/srv/project','/srv/other']), ('workspace','/srv/other'),
            ('project_id','00000000-0000-0000-0000-000000000000'),
            ('protected_roots',[]), ('protected_roots',['/srv/account']*56),
            ('toolchain_root','/srv/project/image'), ('cgroup_root','/opt/command-image/cgroup'),
            ('workspace','/'), ('cgroup_root','/sys/../tmp'), ('toolchain_root','relative')
        ]:
            with self.subTest(key=key),self.assertRaises(RuntimeError):
                workspace_exec(dict(profile,**{key:value}))
        for field in ('command','environment','network','owner_id','max_run_ms'):
            with self.subTest(field=field),self.assertRaises(RuntimeError):
                workspace_exec(dict(profile,**{field:'untrusted'}))
        base={'schema_version':1,'owner_id':'11111111-1111-4111-8111-111111111111',
              'conversation_id':'33333333-3333-4333-8333-333333333333',
              'manager_socket':'/run/example/control.sock','launcher':'/opt/example/launcher',
              'launcher_sha256':'a'*64,'workspace':'/srv/native-readonly',
              'namespace':'synthetic','supervisor_key':'synthetic.deep','workspace_exec':profile}
        with self.assertRaisesRegex(RuntimeError,'Worker roles'):validate(json.dumps(base).encode())
        role=lambda name:{'launcher':'/opt/example/'+name,'launcher_sha256':'b'*64,
                          'workspace':'/srv/native-readonly'}
        base['roles']={'fast':role('fast'),'workers':[role('w'+str(i)) for i in range(4)]}
        self.assertEqual(validate(json.dumps(base).encode())['workspace_exec'],profile)
        # Further conversations: their own conversation, project and workspace.
        other=dict(profile,conversation_id='55555555-5555-4555-8555-555555555555',
                   project_id='66666666-6666-4666-8666-666666666666',
                   workspace='/srv/second-project',allowed_roots=['/srv/second-project'])
        base['additional_workspace_exec']=[other]
        self.assertEqual(validate(json.dumps(base).encode())['additional_workspace_exec'],[other])
        for key,bad in (('conversation_id',profile['conversation_id']),('project_id',profile['project_id']),
                        ('workspace',profile['workspace']+'/nested')):
            clash=dict(other,**{key:bad})
            if key=='workspace':clash['allowed_roots']=[bad]
            base['additional_workspace_exec']=[clash]
            with self.subTest(key=key),self.assertRaisesRegex(RuntimeError,'overlap'):
                validate(json.dumps(base).encode())
        mixed=dict(other,trusted={'network':True}) if 'trusted' not in profile else {
            k:v for k,v in other.items() if k!='trusted'}
        base['additional_workspace_exec']=[mixed]
        with self.assertRaisesRegex(RuntimeError,'one kind'):validate(json.dumps(base).encode())
        alone=dict(base);alone.pop('workspace_exec');alone['additional_workspace_exec']=[other]
        with self.assertRaises(RuntimeError):validate(json.dumps(alone).encode())

    def test_host_full_access_is_explicit_and_required_by_host_privileged(self):
        from beta_config import validate, host_full_access
        access={'environment':{'HOME':'/home/example','PATH':'/usr/bin:/bin'}}
        self.assertEqual(host_full_access(access),access)
        for bad in ({'environment':{'PATH':'/usr/bin'}},{'environment':{'HOME':'rel','PATH':'/x'}},
                    dict(access,sandbox='off'),dict(access,providers='yes')):
            with self.assertRaises(RuntimeError):host_full_access(bad)
        role=lambda name:{'launcher':'/opt/example/'+name,'launcher_sha256':'b'*64,
                          'workspace':'/srv/native-readonly'}
        base={'schema_version':1,'owner_id':'11111111-1111-4111-8111-111111111111',
              'conversation_id':'33333333-3333-4333-8333-333333333333',
              'manager_socket':'/run/example/control.sock','launcher':'/opt/example/launcher',
              'launcher_sha256':'a'*64,'workspace':'/srv/native-readonly',
              'namespace':'synthetic','supervisor_key':'synthetic.deep',
              'roles':{'fast':role('fast'),'workers':[role('w'+str(i)) for i in range(4)]},
              'workspace_exec':{'conversation_id':'33333333-3333-4333-8333-333333333333',
                 'project_id':'22222222-2222-4222-8222-222222222222',
                 'workspace':'/srv/project','allowed_roots':['/srv/project'],
                 'protected_roots':['/srv/provider-account'],
                 'cgroup_root':'/sys/fs/cgroup/commands','toolchain_root':'/opt/command-image',
                 'trusted':{'host_privileged':True}}}
        with self.assertRaisesRegex(RuntimeError,'host_full_access'):validate(json.dumps(base).encode())
        base['host_full_access']=access
        self.assertEqual(validate(json.dumps(base).encode())['host_full_access'],access)

    def test_trusted_workspace_profile_is_closed_shape_with_empty_default_credentials(self):
        from beta_config import workspace_exec
        profile={'conversation_id':'11111111-1111-4111-8111-111111111111',
                 'project_id':'22222222-2222-4222-8222-222222222222',
                 'workspace':'/srv/project','allowed_roots':['/srv/project'],
                 'protected_roots':['/srv/provider-account'],
                 'cgroup_root':'/sys/fs/cgroup/commands','toolchain_root':'/opt/command-image'}
        trusted={'network':True,'host_toolchain':True,'cache_mounts':['/var/cache/example'],
                 'environment':{'CARGO_HOME':'/var/cache/example/cargo'},'job_timeout_ms':1800000}
        self.assertEqual(workspace_exec(dict(profile,trusted=trusted))['trusted'],trusted)
        self.assertEqual(workspace_exec(dict(profile,trusted={}))['trusted'],{})
        for key,value in [('network','yes'),('credential_mounts',['relative']),
                          ('skill_mounts','/not/a/list'),('job_timeout_ms',-1),
                          ('environment',{'lower':'x'}),('owner_id','x'),('command','x'),
                          ('cache_mounts',['/srv/../etc'])]:
            with self.subTest(key=key),self.assertRaises(RuntimeError):
                workspace_exec(dict(profile,trusted=dict(trusted,**{key:value})))

    def test_window_capacity_is_optional_and_bounded(self):
        from beta_config import validate
        base={'schema_version':1,'owner_id':'11111111-1111-4111-8111-111111111111',
              'conversation_id':'33333333-3333-4333-8333-333333333333',
              'manager_socket':'/run/example/control.sock','launcher':'/opt/example/launcher',
              'launcher_sha256':'a'*64,'workspace':'/srv/native-readonly',
              'namespace':'synthetic','supervisor_key':'synthetic.deep'}
        self.assertNotIn('max_active_windows',validate(json.dumps(base).encode()))
        for value in (1,8,12,64):
            self.assertEqual(validate(json.dumps(dict(base,max_active_windows=value)).encode())['max_active_windows'],value)
        for value in (0,65,-1,True,'8',None,2.0):
            with self.subTest(value=value),self.assertRaisesRegex(RuntimeError,'window capacity'):
                validate(json.dumps(dict(base,max_active_windows=value)).encode())

    def test_provisioned_home_preserves_existing_state(self):
        home=self.root/'home';home.mkdir(mode=0o700)
        original=b'synthetic existing database bytes, not an empty database'
        (home/'existing.sqlite3').write_bytes(original)
        self.pair.write_text(json.dumps(self.value))
        dependencies={'readelf':{},'files':{str(self.binary):closure.pin(self.binary)}}
        with patch.object(prepare,'elf_files',return_value=dependencies),patch.object(prepare,'python_files',return_value={}):
            plan=prepare.prepare(self.pair,closure.pin(self.pair)['sha256'],self.binary,self.ui,self.out,
                home,'https://beta.example.invalid',19822,os.getuid(),gid=os.getgid(),provisioned_home=True)
        self.assertEqual((home/'existing.sqlite3').read_bytes(),original)
        self.assertIn('operator-provisioned',json.loads(plan.read_text())['settings']['home_lifecycle'])

    def test_existing_home_requires_explicit_opt_in(self):
        (self.root/'home').mkdir(mode=0o700)
        with self.assertRaisesRegex(RuntimeError,'fresh isolated home'):self.assemble()
        self.assertFalse(self.out.exists())

    def test_provisioned_home_alias_or_public_mode_refused(self):
        home=self.root/'actual';home.mkdir(mode=0o755);home.chmod(0o755)
        self.pair.write_text(json.dumps(self.value))
        with self.assertRaisesRegex(RuntimeError,'private and service-owned'):
            prepare.prepare(self.pair,closure.pin(self.pair)['sha256'],self.binary,self.ui,self.out,
                home,'https://beta.example.invalid',19822,os.getuid(),gid=os.getgid(),provisioned_home=True)
        self.assertFalse(self.out.exists())
