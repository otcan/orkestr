"""Root-only disposable source-owner mappings; no live identities or credentials."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

from codex_service.contract import Refused
from codex_service.resource_contract import context,encoded
from codex_service.resource_namespace import Activation
from codex_service.resource_receipt import verify,ns

OLD,EXEC,CORE=62003,62002,62001


@unittest.skipUnless(os.geteuid()==0,'Root namespace kernel fixture')
class ResourceNamespaceTests(unittest.TestCase):
    def setUp(self):
        self.root=Path(tempfile.mkdtemp(prefix='resource-namespace-',dir='/'))
        self.root.chmod(0o755);self.addCleanup(lambda:shutil.rmtree(self.root))
        self.old=self.directory('old-home',OLD)
        self.provider=self.directory('provider',EXEC)
        self.core=self.directory('core',CORE)
        self.directory('core/data',CORE)
        bootstrap=self.core/'bootstrap';bootstrap.write_text('synthetic-only');bootstrap.chmod(0o600);os.chown(bootstrap,CORE,EXEC)
        self.runtime=dict(uid=EXEC,gid=EXEC,owner_id='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            authority_uid=CORE,authority_gid=EXEC,executor_uid=EXEC,executor_gid=EXEC,
            home=str(self.core),provider_home=str(self.provider),bootstrap_file=str(bootstrap),
            ledger_directory=str(self.root/'ledger'),endpoint_directory=str(self.root/'endpoint'))
        self.directory('old-home/.codex',OLD)
        self.auth=self.file('old-home/.codex/auth.json',OLD,b'synthetic-auth')
        self.lock=self.file('old-home/.codex/auth.lock',OLD,b'')
        self.gog=self.directory('old-home/.config',OLD)
        self.gog=self.directory('old-home/.config/gogcli',OLD)
        self.file('old-home/.config/gogcli/fake-token',OLD,b'synthetic-gog')
        self.claude=self.directory('old-home/managed-claude',OLD)
        self.file('old-home/managed-claude/.credentials.json',OLD,b'{"synthetic":true}')
        self.skill=self.directory('old-home/.codex/skills',OLD)
        self.file('old-home/.codex/skills/SKILL.md',OLD,b'synthetic skill')
        self.tool=self.directory('old-home/toolchain',OLD)
        self.file('old-home/toolchain/tool',OLD,b'synthetic-tool')
        self.beta={'managed_host':{'environment':{'HOME':str(self.provider),'PATH':'/usr/bin:/bin',
            'XDG_CONFIG_HOME':str(self.provider/'.config')}}}
        self.profile={'auth_file':str(self.provider/'.codex/auth.json')}
        self.claude_config={'account':str(self.provider/'accounts/claude')}
        self.ctx=context(self.runtime,self.beta,self.profile,self.claude_config)
        self.selected={'path':str(self.root/'contract.json'),'sha256':'',
                       'receipt_directory':str(self.root/'namespace-records')}
        h=self.old.stat()
        self.doc=dict(format='orkestr-resource-namespace-v1',owner_id=self.runtime['owner_id'],
            authority_uid=CORE,authority_gid=EXEC,executor_uid=EXEC,executor_gid=EXEC,
            source_owner_uid=OLD,source_homes=[dict(path=str(self.old),device=h.st_dev,inode=h.st_ino,gid=OLD)],
            receipt_directory=self.selected['receipt_directory'],resources=[],denials=[])
        for kind,source,target in [('codex_auth',self.auth,self.provider/'.codex/auth.json'),
            ('codex_lock',self.lock,self.provider/'.codex/auth.lock'),('gog_store',self.gog,self.provider/'.config/gogcli'),
            ('claude_account',self.claude,self.provider/'accounts/claude'),
            ('skill',self.skill,self.provider/'resources/skills'),('toolchain',self.tool,self.provider/'resources/toolchain')]:
            s=source.stat();self.doc['resources'].append(dict(kind=kind,source=str(source),target=str(target),
                uid=OLD,gid=OLD,device=s.st_dev,inode=s.st_ino))
        self.save()

    def directory(self,name,uid):
        p=self.root/name;p.mkdir(mode=0o700);os.chown(p,uid,uid);return p

    def file(self,name,uid,data):
        p=self.root/name;p.write_bytes(data);p.chmod(0o600);os.chown(p,uid,uid);return p

    def save(self):
        blob=encoded(self.doc);p=Path(self.selected['path']);p.write_bytes(blob);p.chmod(0o400)
        self.selected['sha256']=hashlib.sha256(blob).hexdigest()

    def test_actual_private_namespace_same_inodes_ownership_flags_and_cleanup(self):
        initial=ns('mnt');before=self.auth.stat()
        with Activation(self.selected,self.ctx):
            self.assertNotEqual(ns('mnt'),initial)
            value=verify(self.selected,self.ctx)
            view=Path(self.profile['auth_file']).stat()
            self.assertEqual((view.st_dev,view.st_ino),(before.st_dev,before.st_ino))
            self.assertEqual(view.st_uid,EXEC)
            self.assertEqual(self.auth.stat().st_uid,OLD)
            self.assertEqual(len(value['targets']),6)
        self.assertEqual(ns('mnt'),initial)
        self.assertEqual(self.auth.stat().st_uid,OLD)
        with self.assertRaises((Refused,FileNotFoundError)):verify(self.selected,self.ctx)
        self.assertEqual(list(Path(self.selected['receipt_directory']).iterdir()),[])

    def test_stale_source_and_alias_and_cross_authority_fail_before_namespace(self):
        initial=ns('mnt')
        for field,value in [('uid',CORE),('target',str(self.core/'auth.json'))]:
            original=self.doc['resources'][0][field];self.doc['resources'][0][field]=value;self.save()
            with self.assertRaises(Refused):
                with Activation(self.selected,self.ctx):pass
            self.assertEqual(ns('mnt'),initial)
            self.doc['resources'][0][field]=original
        original=self.doc['resources'][1]['inode'];self.doc['resources'][1]['inode']=1;self.save()
        with self.assertRaisesRegex(Refused,'resource_source_changed'):
            with Activation(self.selected,self.ctx):pass
        self.doc['resources'][1]['inode']=original
        self.save();original=self.auth.with_suffix('.original');self.auth.rename(original);self.auth.symlink_to(original)
        with self.assertRaises(Refused):
            with Activation(self.selected,self.ctx):pass
        self.assertEqual(ns('mnt'),initial)

    def test_unprivileged_readwrite_readonly_and_core_denials_are_kernel_enforced(self):
        import subprocess
        with Activation(self.selected,self.ctx):
            script=("import os,sys;from pathlib import Path;assert Path(sys.argv[1]).read_bytes()==b'synthetic-auth';"
                    "p=Path(sys.argv[2]);p.write_text('synthetic-new-business');"
                    "assert p.stat().st_uid==int(sys.argv[3]);"
                    "denied=0\nfor p in sys.argv[4:]:\n try: os.open(p,os.O_WRONLY|os.O_CLOEXEC)\n except OSError: denied+=1\n"
                    "assert denied==len(sys.argv[4:])")
            r=subprocess.run(['/usr/bin/python3','-I','-S','-B','-c',script,self.profile['auth_file'],
                str(self.provider/'.config/gogcli/new'),str(EXEC),str(self.provider/'resources/skills/SKILL.md'),
                str(self.core/'bootstrap'),str(self.old/'.codex/auth.json')],
                user=EXEC,group=EXEC,extra_groups=[],capture_output=True,text=True,
                env={'PATH':'/usr/bin:/bin','PYTHONDONTWRITEBYTECODE':'1'},timeout=10)
            self.assertEqual(r.returncode,0,r.stderr)
            self.assertEqual((self.gog/'new').stat().st_uid,OLD)
            self.assertEqual((self.gog/'new').read_text(),'synthetic-new-business')
            # Atomic source refresh does not rewrite the already-attested
            # mounted inode. The new source still has to satisfy its custody.
            mounted=Path(self.profile['auth_file']).stat().st_ino
            old=self.auth.with_suffix('.old');self.auth.rename(old)
            self.auth.write_bytes(b'synthetic-replacement');self.auth.chmod(0o600);os.chown(self.auth,OLD,OLD)
            receipt=verify(self.selected,self.ctx)
            auth_target=next(t for t in receipt['targets'] if t['target']==self.profile['auth_file'])
            self.assertEqual(auth_target['source_inode'],mounted)
            self.assertEqual(Path(self.profile['auth_file']).stat().st_ino,mounted)
            self.auth.chmod(0o644)
            with self.assertRaisesRegex(Refused,'resource_auth_custody'):verify(self.selected,self.ctx)

    def test_full_package_requires_namespace_and_core_consumes_readonly_attestation(self):
        import subprocess
        from unittest.mock import patch
        import codex_service_fixture as service
        import selected_codex_fixture as selected
        from codex_service.package import Package
        from codex_bounded.trust import digest
        with patch.multiple(service,UID=EXEC,GID=EXEC),patch.multiple(selected,UID=EXEC,GID=EXEC):
            fixture=service.ServiceFixture()
            self.addCleanup(fixture.close)
            fixture.prepare()
        authority=fixture.root/'authority'
        authority.mkdir(mode=0o700);os.chown(authority,CORE,EXEC)
        data=authority/'data';data.mkdir(mode=0o700);os.chown(data,CORE,EXEC)
        bootstrap=authority/'bootstrap';bootstrap.write_bytes(b'synthetic-bootstrap-only-1234567890')
        bootstrap.chmod(0o600);os.chown(bootstrap,CORE,EXEC)
        provider=fixture.home/'provider-home'
        runtime=json.loads((fixture.package/'service.json').read_bytes())
        runtime.update(authority_uid=CORE,authority_gid=EXEC,executor_uid=EXEC,executor_gid=EXEC,
            home=str(authority),bootstrap_file=str(bootstrap),provider_home=str(provider))
        beta=json.loads((fixture.package/'beta.json').read_bytes())
        beta['identity_split']=dict(authority_uid=CORE,executor_uid=EXEC,shared_gid=EXEC)
        beta['managed_host']={'environment':{'HOME':str(provider),'PATH':'/usr/bin:/bin',
                                          'XDG_CONFIG_HOME':str(provider/'.config')}}
        profile=json.loads((fixture.package/'profile.json').read_bytes())
        profile['auth_file']=str(provider/'.codex/auth.json')
        self.doc['resources']=[r for r in self.doc['resources'] if r['kind']!='claude_account']
        for row in self.doc['resources']:
            row['target']=str(provider/Path(row['target']).relative_to(self.provider))
        self.save();runtime['resource_namespace']=self.selected
        for name,value in [('service.json',runtime),('beta.json',beta),('profile.json',profile)]:
            (fixture.package/name).write_bytes(encoded(value))
        code_host=fixture.package/'codex-code-mode-host'
        shutil.copyfile(fixture.package/'native',code_host);code_host.chmod(0o550);os.chown(code_host,0,EXEC)
        manifest=fixture.package/'manifest.json';value=json.loads(manifest.read_bytes())
        value['files']['codex-code-mode-host']=digest(code_host)
        for name in ('service.json','beta.json','profile.json'):
            value['files'][name]=digest(fixture.package/name)
        manifest.write_bytes(encoded(value));pin=digest(manifest)
        ctx=context(runtime,beta,profile,None,fixture.package)
        with self.assertRaises((Refused,FileNotFoundError)):Package(fixture.package,pin)
        with Activation(self.selected,ctx):
            package=Package(fixture.package,pin)
            self.assertEqual(package.executor_uid,EXEC)
            script='import sys;sys.path.insert(0,sys.argv[1]);from codex_service.package import Package;Package(sys.argv[1],sys.argv[2]);print("core-package-ok")'
            result=subprocess.run(['/usr/bin/python3','-I','-S','-B','-c',script,str(fixture.package),pin],
                user=CORE,group=EXEC,extra_groups=[],capture_output=True,text=True,
                env={'PATH':'/usr/bin:/bin','PYTHONDONTWRITEBYTECODE':'1'},timeout=10)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(result.stdout.strip(),'core-package-ok')
        with self.assertRaises((Refused,FileNotFoundError)):Package(fixture.package,pin)

    def private_worktree(self):
        import subprocess
        ancestor=62004
        home=self.directory('other-private-home',ancestor);home.chmod(0o750)
        base=home/'coordinator';base.mkdir(mode=0o710);os.chown(base,ancestor,ancestor)
        workspace=base/'workspace';workspace.mkdir(mode=0o755);os.chown(workspace,ancestor,ancestor)
        repo=workspace/'repository';repo.mkdir(mode=0o755)
        worktree=self.old/'private-worktree'
        def git(*args):
            subprocess.run(['/usr/bin/git',*map(str,args)],check=True,capture_output=True,
                env={'PATH':'/usr/bin:/bin','HOME':'/nonexistent','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null'})
        git('init','-q',repo)
        (repo/'data.txt').write_text('synthetic baseline\n')
        git('-C',repo,'add','data.txt')
        git('-C',repo,'-c','user.name=Synthetic','-c','user.email=fixture@example.invalid','commit','-qm','fixture')
        git('-C',repo,'worktree','add','-q','-b','fixture-worktree',worktree)
        for root in (repo,worktree):
            for parent,dirs,files in os.walk(root):
                os.chown(parent,OLD,OLD)
                for name in files:os.chown(Path(parent)/name,OLD,OLD)
            subprocess.run(['/usr/bin/setfacl','-Rm',f'u:{EXEC}:rwX,g::r-X,m::rwx',str(root)],
                           check=True,capture_output=True)
        hidden=home/'operator-private';hidden.write_text('synthetic-unselected');hidden.chmod(0o600);os.chown(hidden,ancestor,ancestor)
        h=home.stat();self.doc['source_homes'].append(dict(path=str(home),device=h.st_dev,inode=h.st_ino,
                                                       uid=ancestor,gid=ancestor))
        self.beta['workspace_exec']=dict(project_id='11111111-2222-4333-8444-555555555555',
            conversation_id='11111111-2222-4333-8444-666666666666',workspace=str(worktree),
            project_owner_uid=OLD,allowed_roots=[str(worktree)],protected_roots=[str(self.core)],
            cgroup_root=str(self.root/'cgroup'),toolchain_root=str(self.tool),trusted={
            'host_privileged':False,'environment':{},'credential_env_files':[],
            'managed_executor':{'environment':{'HOME':str(self.provider),'PATH':'/usr/bin:/bin'}}})
        self.ctx=context(self.runtime,self.beta,self.profile,self.claude_config)
        self.save();return home,repo,worktree,hidden

    def test_private_different_owner_home_git_worktree_keeps_original_absolute_paths(self):
        import subprocess
        from types import SimpleNamespace
        from codex_service.resource_projects import git_environment
        from codex_service.resource_receipt import original_source
        home,repo,worktree,hidden=self.private_worktree()
        before=home.stat();initial=ns('mnt')
        with Activation(self.selected,self.ctx) as active:
            receipt=verify(self.selected,self.ctx)
            self.assertEqual(len(receipt['projects']),2)
            self.assertFalse(hidden.exists())
            self.assertEqual(worktree.stat().st_uid,OLD)
            # Both selected leaves are otherwise readable/traversable. Only
            # the private sparse-home ancestor must prevent Core path access.
            self.assertEqual(worktree.stat().st_mode&0o005,0o005)
            self.assertEqual((repo/'.git').stat().st_mode&0o005,0o005)
            for candidate in (worktree/'data.txt',repo/'.git/HEAD'):
                denied_core=subprocess.run(['/usr/bin/setpriv','--no-new-privs','--reuid='+str(CORE),
                    '--regid='+str(EXEC),'--clear-groups','/bin/cat',str(candidate)],
                    capture_output=True,env={'PATH':'/usr/bin:/bin'},timeout=5)
                self.assertNotEqual(denied_core.returncode,0)
            # Original source lookup remains usable through Root's retained
            # original-home FD even while logical paths show sparse masks.
            fd=original_source(self.doc['resources'][0],receipt['home_lookups'],receipt['creator'],self.doc['source_homes'])
            try:self.assertEqual(os.fstat(fd).st_uid,OLD)
            finally:os.close(fd)
            package=SimpleNamespace(runtime={'resource_namespace':self.selected},beta=self.beta)
            env=git_environment(package,{'PATH':'/usr/bin:/bin','HOME':str(self.provider),
                'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0'})
            def run(*args):
                r=subprocess.run(['/usr/bin/setpriv','--no-new-privs','--reuid='+str(EXEC),
                    '--regid='+str(EXEC),'--clear-groups',*map(str,args)],cwd=str(worktree),
                    capture_output=True,text=True,env=env,timeout=10)
                self.assertEqual(r.returncode,0,r.stderr);return r.stdout.strip()
            self.assertEqual(run('/bin/pwd'),str(worktree))
            self.assertEqual(run('/usr/bin/git','status','--porcelain'),'')
            self.assertEqual(run('/usr/bin/git','rev-parse','--git-common-dir'),str(repo/'.git'))
            run('/bin/sh','-c','printf "synthetic edit\n" >> data.txt; git status --porcelain')
            self.assertIn('M data.txt',run('/usr/bin/git','status','--porcelain'))
            run('/usr/bin/git','add','data.txt')
            run('/usr/bin/git','-c','user.name=Synthetic','-c','user.email=fixture@example.invalid','commit','-qm','synthetic update')
            self.assertEqual(run('/usr/bin/git','status','--porcelain'),'')
            r=subprocess.run(['/usr/bin/setpriv','--no-new-privs','--reuid='+str(EXEC),
                '--regid='+str(EXEC),'--clear-groups','/bin/cat',str(hidden)],capture_output=True,env=env)
            self.assertNotEqual(r.returncode,0)
        self.assertEqual(ns('mnt'),initial)
        after=home.stat()
        self.assertEqual((before.st_uid,before.st_gid,before.st_mode),(after.st_uid,after.st_gid,after.st_mode))
        self.assertEqual(hidden.read_text(),'synthetic-unselected')
        self.assertEqual(worktree.stat().st_uid,OLD)

    def test_private_ancestor_must_be_explicit_and_canonical_project_replacement_refuses(self):
        home,repo,worktree,hidden=self.private_worktree()
        saved=self.doc['source_homes'][1].pop('uid');self.save()
        initial=ns('mnt')
        with self.assertRaises(Refused):
            with Activation(self.selected,self.ctx):pass
        self.assertEqual(ns('mnt'),initial)
        self.doc['source_homes'][1]['uid']=saved;self.save()
        with Activation(self.selected,self.ctx) as active:
            old=next(h for h in active.homes if h['path']==str(self.old))['fd']
            os.rename('private-worktree','renamed-worktree',src_dir_fd=old,dst_dir_fd=old)
            os.mkdir('private-worktree',0o700,dir_fd=old)
            os.chown('private-worktree',OLD,OLD,dir_fd=old,follow_symlinks=False)
            # The visible bind still has the original inode, but the actual
            # configured source path now names a different plausible owner.
            with self.assertRaisesRegex(Refused,'resource_project_source_replaced'):
                verify(self.selected,self.ctx)
        self.assertEqual(ns('mnt'),initial)

if __name__=='__main__':unittest.main()
