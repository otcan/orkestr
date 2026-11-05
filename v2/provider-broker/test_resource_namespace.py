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
        for field,value in [('uid',CORE),('inode',1),('target',str(self.core/'auth.json'))]:
            original=self.doc['resources'][0][field];self.doc['resources'][0][field]=value;self.save()
            with self.assertRaises(Refused):
                with Activation(self.selected,self.ctx):pass
            self.assertEqual(ns('mnt'),initial)
            self.doc['resources'][0][field]=original
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
            # A source file unlink/recreation must never bless the stale bound
            # inode, even when its bytes and owner look plausible.
            old=self.auth.with_suffix('.old');self.auth.rename(old)
            self.auth.write_bytes(b'synthetic-replacement');self.auth.chmod(0o600);os.chown(self.auth,OLD,OLD)
            with self.assertRaisesRegex(Refused,'resource_source_changed'):verify(self.selected,self.ctx)

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

if __name__=='__main__':unittest.main()
