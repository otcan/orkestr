"""Optional split contract and synthetic real-kernel privilege boundaries."""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

from codex_service.contract import Refused
from codex_service.identity import bind

ROOT=Path(__file__).parent


class IdentityContractTests(unittest.TestCase):
    def descriptor(self,**extra):
        value=dict(uid=10001,gid=10001,home='/private/authority')
        value.update(extra)
        return value

    def split(self,**extra):
        value=self.descriptor(authority_uid=10002,authority_gid=10001,executor_uid=10001,
                              executor_gid=10001,provider_home='/private/provider')
        value.update(extra)
        return value

    def test_legacy_contract_retains_single_identity(self):
        value=bind(self.descriptor())
        self.assertFalse(value['split'])
        self.assertEqual(value['authority_uid'],value['executor_uid'])

    def test_split_requires_closed_explicit_distinct_identity_and_separate_home(self):
        self.assertTrue(bind(self.split())['split'])
        for bad in [self.descriptor(authority_uid=10002),self.split(authority_uid=10001),
                    self.split(executor_uid=10003),self.split(authority_gid=10003),
                    self.split(provider_home='/private/authority/provider'),self.split(provider_home=None),
                    self.split(authority_uid=True)]:
            with self.assertRaises(Refused):bind(bad)

    def test_nnp_applies_in_subprocess_and_does_not_change_operator_parent(self):
        before=next(l for l in Path('/proc/self/status').read_text().splitlines() if l.startswith('NoNewPrivs:'))
        script='import sys;sys.path.insert(0,sys.argv[1]);from codex_service.identity import enforce_no_new_privs;enforce_no_new_privs();from pathlib import Path;print(next(l for l in Path("/proc/self/status").read_text().splitlines() if l.startswith("NoNewPrivs:")))'
        result=subprocess.run([sys.executable,'-I','-S','-B','-c',script,str(ROOT)],
                              check=True,text=True,capture_output=True,env={'PATH':'/usr/bin:/bin','PYTHONDONTWRITEBYTECODE':'1'})
        self.assertIn('1',result.stdout)
        after=next(l for l in Path('/proc/self/status').read_text().splitlines() if l.startswith('NoNewPrivs:'))
        self.assertEqual(before,after)


@unittest.skipUnless(os.geteuid()==0,'root-only synthetic ownership fixture')
class SplitPackageTests(unittest.TestCase):
    def setUp(self):
        from codex_service_fixture import ServiceFixture,UID,GID
        from codex_bounded.trust import digest
        self.digest=digest;self.uid=UID;self.gid=GID
        self.fixture=ServiceFixture();self.addCleanup(self.fixture.close)
        self.fixture.prepare()

    def select_split(self):
        from codex_service.package import Package
        root=self.fixture.root
        authority=root/'authority-home';authority.mkdir(mode=0o700)
        data=authority/'data';data.mkdir(mode=0o700)
        bootstrap=root/'authority-bootstrap';bootstrap.write_bytes(b'synthetic-owner-bootstrap-token-long-enough')
        bootstrap.chmod(0o600)
        authority_uid=self.uid-1
        for p in [authority,data,bootstrap]:os.chown(p,authority_uid,self.gid)
        service=self.fixture.package/'service.json';value=json.loads(service.read_text())
        value.update(authority_uid=authority_uid,authority_gid=self.gid,executor_uid=self.uid,
                     executor_gid=self.gid,provider_home=str(self.fixture.home/'provider-home'),
                     home=str(authority),bootstrap_file=str(bootstrap))
        service.write_text(json.dumps(value))
        beta_path=self.fixture.package/'beta.json';beta=json.loads(beta_path.read_text())
        beta['identity_split']=dict(authority_uid=authority_uid,executor_uid=self.uid,shared_gid=self.gid)
        beta_path.write_text(json.dumps(beta))
        manifest=self.fixture.package/'manifest.json';meta=json.loads(manifest.read_text())
        meta['files']['beta.json']=self.digest(beta_path)
        meta['files']['service.json']=self.digest(service)
        manifest.write_text(json.dumps(meta))
        return Package(self.fixture.package,self.digest(manifest))

    def test_split_loader_binds_authority_paths_but_refuses_unqualified_legacy_launch(self):
        from codex_service.manager import Manager
        package=self.select_split()
        self.assertNotEqual(package.authority_uid,package.executor_uid)
        self.assertEqual(package.home.stat().st_uid,package.authority_uid)
        self.assertEqual(package.provider_home.stat().st_uid,package.executor_uid)
        manager=Manager(self.fixture.package,self.digest(self.fixture.package/'manifest.json'))
        try:
            with self.assertRaisesRegex(Refused,'split_launch_unqualified'):manager.start()
            self.assertIsNone(manager.child)
        finally:manager.close()

    def test_executor_cannot_read_replace_authority_or_gain_setuid_with_nnp(self):
        package=self.select_split()
        core=package.data/'core.sqlite3';core.write_bytes(b'synthetic-authority-only')
        os.chown(core,package.authority_uid,package.authority_gid);core.chmod(0o600)
        # Synthetic setuid probe prints only euid. It is not sudo, a shell, an
        # authority client or a real provider, and is removed with the fixture.
        probe=self.fixture.root/'euid-probe'
        subprocess.run(['/usr/bin/cc','-x','c','-o',str(probe),'-'],input='#include <unistd.h>\n#include <stdio.h>\nint main(void){printf("%u\\n",(unsigned)geteuid());return 0;}\n',text=True,check=True,capture_output=True)
        probe.chmod(0o4755)
        script='import sys,os;sys.path.insert(0,sys.argv[1]);from codex_service.identity import enforce_no_new_privs;enforce_no_new_privs();p=sys.argv[2];denied=0\ntry:open(p,"rb")\nexcept PermissionError:denied+=1\ntry:os.rename(os.path.dirname(p),os.path.dirname(p)+"-replaced")\nexcept PermissionError:denied+=1\nassert denied==2;os.execv(sys.argv[3],[sys.argv[3]])'
        result=subprocess.run([sys.executable,'-I','-S','-B','-c',script,str(self.fixture.package),str(core),str(probe)],
                              user=self.uid,group=self.gid,extra_groups=[],check=False,text=True,capture_output=True,
                              env={'PATH':'/usr/bin:/bin','PYTHONDONTWRITEBYTECODE':'1'})
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(result.stdout.strip(),str(self.uid))
        self.assertEqual(os.geteuid(),0)  # Human/operator root was not modified.


if __name__=='__main__':unittest.main()
