"""Native-only sealed CWD projections, without new Worker command profiles."""
import copy
import os
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

from codex_service.contract import Refused
from codex_service.resource_contract import context
from codex_service.resource_namespace import Activation
from codex_service.resource_receipt import verify,ns
from codex_service.resource_projects import git_environment
from codex_service import identity
import test_resource_namespace as fixture
OLD,EXEC,CORE=fixture.OLD,fixture.EXEC,fixture.CORE

OTHER=62004

@unittest.skipUnless(os.geteuid()==0,'Root namespace fixture')
class NativeWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.f=fixture.ResourceNamespaceTests('run');self.f.setUp();self.addCleanup(self.f.doCleanups)
        f=self.f
        self.other_home,self.worker_repo,self.worker,hidden=f.private_worktree()
        self.hidden=hidden
        # Four pre-existing Worker command profiles remain exactly four.
        worker=f.beta['workspace_exec']
        f.beta['additional_workspace_exec']=[{**copy.deepcopy(worker),'project_id':str(uuid.uuid4()),
            'conversation_id':str(uuid.uuid4())} for _ in range(3)]
        self.worker_profiles=copy.deepcopy([worker,*f.beta['additional_workspace_exec']])
        self.repo=f.old/'native-repository';self.repo.mkdir(mode=0o700)
        subprocess.run(['/usr/bin/git','init','-q',str(self.repo)],check=True,capture_output=True)
        self.nongit=f.old/'native-not-a-repository';self.nongit.mkdir(mode=0o700)
        self.other=self.other_home/'native-other-owner';self.other.mkdir(mode=0o700)
        for directory,uid in ((self.repo,OLD),(self.nongit,OLD),(self.other,OTHER)):
            (directory/'data').write_text('synthetic native cwd')
            for parent,dirs,files in os.walk(directory):
                os.chown(parent,uid,uid)
                for name in files:os.chown(Path(parent)/name,uid,uid)
            subprocess.run(['/usr/bin/setfacl','-Rm',f'u:{EXEC}:rwX,g::---,o::---',str(directory)],check=True,capture_output=True)
        subprocess.run(['/usr/bin/setfacl','-Rm',f'u:{OLD}:rwX,d:u:{OLD}:rwx',str(self.other)],check=True,capture_output=True)
        self.mapping={str(uuid.uuid4()):{'path':str(path),'shared':True} for path in (self.repo,self.nongit,self.other)}
        f.beta['conversation_workspaces']=copy.deepcopy(self.mapping)
        f.ctx=context(f.runtime,f.beta,f.profile,f.claude_config)
        f.save()

    def executor(self,script,*args,cwd='/'):
        return subprocess.run(['/usr/bin/setpriv','--no-new-privs','--reuid='+str(EXEC),
            '--regid='+str(EXEC),'--clear-groups','/usr/bin/python3','-I','-S','-B','-c',script,*map(str,args)],
            cwd=str(cwd),capture_output=True,text=True,env={'PATH':'/usr/bin:/bin','PYTHONDONTWRITEBYTECODE':'1'},timeout=10)

    def test_native_repo_nongit_and_declared_other_owner_keep_paths_without_worker_grants(self):
        f=self.f;initial=ns('mnt');before=[p.stat().st_uid for p in (self.repo,self.nongit,self.other)]
        with Activation(f.selected,f.ctx):
            receipt=verify(f.selected,f.ctx)
            native=[row for row in receipt['projects'] if 'conversation_id' in row]
            self.assertEqual({row['conversation_id'] for row in native},set(self.mapping))
            from codex_service.resource_projects import verify_projects
            forged=dict(native[0]);forged['project_id']=forged.pop('conversation_id')
            with self.assertRaisesRegex(Refused,'resource_project_receipt'):
                verify_projects([forged],f.ctx,receipt['home_lookups'],receipt['creator'],f.doc['source_homes'])
            self.assertEqual(f.ctx['projects'],self.worker_profiles)
            self.assertEqual(f.beta['conversation_workspaces'],self.mapping)
            self.assertFalse(self.hidden.exists())
            for path in (self.repo,self.nongit,self.other):
                result=self.executor('import os,sys;from pathlib import Path;assert os.getcwd()==sys.argv[1];assert Path("data").read_text()=="synthetic native cwd";Path("written").write_text("native")',path,cwd=path)
                self.assertEqual(result.returncode,0,result.stderr)
                denied=subprocess.run(['/usr/bin/setpriv','--no-new-privs','--reuid='+str(CORE),
                    '--regid='+str(EXEC),'--clear-groups','/bin/cat',str(path/'data')],capture_output=True)
                self.assertNotEqual(denied.returncode,0)
            owner=f.runtime['owner_id'];conversation=next(key for key,value in self.mapping.items() if value['path']==str(self.repo))
            package=SimpleNamespace(runtime={'resource_namespace':f.selected},beta=f.beta,owner=owner)
            with patch.object(identity,'_CONTEXT',dict(owner_id=owner,conversation_id=conversation,role='deep')):
                env=git_environment(package,{'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null'})
            values=[env['GIT_CONFIG_VALUE_'+str(i)] for i in range(int(env['GIT_CONFIG_COUNT']))]
            self.assertIn(str(self.repo),values);self.assertNotIn(str(self.other),values)
            env.update(PATH='/usr/bin:/bin',HOME=str(f.provider))
            status=subprocess.run(['/usr/bin/setpriv','--no-new-privs','--reuid='+str(EXEC),
                '--regid='+str(EXEC),'--clear-groups','/usr/bin/git','status','--porcelain'],
                cwd=str(self.repo),env=env,capture_output=True,text=True,timeout=10)
            self.assertEqual(status.returncode,0,status.stderr)
            with patch.object(identity,'_CONTEXT',dict(owner_id=owner,conversation_id=conversation,role='worker-0')):
                env=git_environment(package,{})
            self.assertNotIn(str(self.repo),env.values())
        self.assertEqual(ns('mnt'),initial)
        self.assertEqual([p.stat().st_uid for p in (self.repo,self.nongit,self.other)],before)
        self.assertEqual(f.ctx['projects'],self.worker_profiles)

    def test_whole_home_credentials_and_native_replacement_refuse(self):
        f=self.f;key=next(iter(self.mapping));original=f.beta['conversation_workspaces'][key]
        for path in (f.old,f.old/'.ssh',f.old/'.codex',f.core,f.provider):
            f.beta['conversation_workspaces'][key]={'path':str(path),'shared':True}
            ctx=context(f.runtime,f.beta,f.profile,f.claude_config)
            with self.assertRaises(Refused):
                with Activation(f.selected,ctx):pass
        f.beta['conversation_workspaces'][key]=original
        pointer=self.nongit/'.git';pointer.write_text('gitdir: absent-git\n');pointer.chmod(0o600);os.chown(pointer,OLD,OLD)
        subprocess.run(['/usr/bin/setfacl','-m',f'u:{EXEC}:r,g::---,o::---',str(pointer)],check=True,capture_output=True)
        with self.assertRaises((Refused,FileNotFoundError)):
            with Activation(f.selected,f.ctx):pass
        pointer.unlink()
        subprocess.run(['/usr/bin/setfacl','-m','u:62005:rwx',str(self.other)],check=True,capture_output=True)
        with self.assertRaisesRegex(Refused,'workspace_unselected_acl_writer'):
            with Activation(f.selected,f.ctx):pass
        subprocess.run(['/usr/bin/setfacl','-x','u:62005',str(self.other)],check=True,capture_output=True)
        subprocess.run(['/usr/bin/setfacl','-m',f'u:{OLD}:rwx',str(self.other_home)],check=True,capture_output=True)
        with self.assertRaisesRegex(Refused,'workspace_unselected_acl_writer'):
            with Activation(f.selected,f.ctx):pass
        subprocess.run(['/usr/bin/setfacl','-x',f'u:{OLD}',str(self.other_home)],check=True,capture_output=True)
        with Activation(f.selected,f.ctx) as active:
            fd=next(home for home in active.homes if home['path']==str(f.old))['fd']
            os.rename('native-repository','native-repository-old',src_dir_fd=fd,dst_dir_fd=fd)
            os.mkdir('native-repository',0o700,dir_fd=fd);os.chown('native-repository',OLD,OLD,dir_fd=fd)
            with self.assertRaisesRegex(Refused,'resource_project_source_replaced'):verify(f.selected,f.ctx)

    def test_root_owned_native_cwd_outside_homes_uses_shared_acl_without_chown(self):
        f=self.f;cwd=f.root/'root-native';cwd.mkdir(mode=0o700);(cwd/'data').write_text('synthetic native cwd')
        subprocess.run(['/usr/bin/setfacl','-m',f'u:{EXEC}:rwx,u:{CORE}:---,u:{OLD}:rwx,d:u:{OLD}:rwx,g::---,o::---',str(cwd)],check=True,capture_output=True)
        subprocess.run(['/usr/bin/setfacl','-m',f'u:{EXEC}:rw,u:{CORE}:---,g::---,o::---',str(cwd/'data')],check=True,capture_output=True)
        f.beta['conversation_workspaces'][str(uuid.uuid4())]={'path':str(cwd),'shared':True}
        f.ctx=context(f.runtime,f.beta,f.profile,f.claude_config)
        with Activation(f.selected,f.ctx):
            receipt=verify(f.selected,f.ctx)
            self.assertNotIn(str(cwd),[row['path'] for row in receipt['projects']])
            result=self.executor('from pathlib import Path;assert Path("data").read_text()=="synthetic native cwd"',cwd=cwd)
            self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(cwd.stat().st_uid,0)
        self.assertEqual(cwd.stat().st_uid,0)
        # Actual outside-home ACLs must keep provider CWDs private from Core.
        subprocess.run(['/usr/bin/setfacl','-m',f'u:{CORE}:r-x',str(cwd)],check=True,capture_output=True)
        with self.assertRaisesRegex(Refused,'resource_required_denial'):
            with Activation(f.selected,f.ctx):pass
