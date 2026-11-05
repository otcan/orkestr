"""Actual managed-project staging preserves owners and enforces named ACLs."""
import json
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
import uuid
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import selected
import selected_managed
import test_selected as fixture

EXECUTOR=62132
AUTHORITY=62131
OWNER=995


class Shapes(unittest.TestCase):
    def test_managed_definition_and_owner_remain_explicit(self):
        good={'environment':{'HOME':'/srv/provider','PATH':'/usr/bin:/bin'}}
        selected_managed.shape(good)
        profile={'trusted':{'managed_executor':good},'project_owner_uid':OWNER}
        selected_managed.modes({'workspace_exec':profile}, True)
        for changed in ({'host_full_access':{}}, {'workspace_exec':{'trusted':{}}},
                        {'workspace_exec':{'trusted':{'managed_executor':good,'host_privileged':True}}}):
            with self.subTest(changed=changed), self.assertRaises(RuntimeError):
                selected_managed.modes(changed, True)
        with self.assertRaises(RuntimeError):selected_managed.modes({'workspace_exec':profile}, False)
        for bad in ({},good|{'extra':True},{'environment':{},'credentials':[]}):
            with self.assertRaises(RuntimeError):selected_managed.shape(bad)


@unittest.skipUnless(os.geteuid()==0 and shutil.which('setfacl'), 'Root POSIX ACL staging fixture')
class ManagedStaging(unittest.TestCase):
    current_source=fixture.Selected.current_source

    def setUp(self):
        fixture.Selected.setUp(self)
        old=self.root
        self.root=Path('/orkestr-stage-managed-'+str(uuid.uuid4()))
        old.rename(self.root);self.root.chmod(0o755)
        self.plan={key:(value.replace(str(old),str(self.root)) if type(value) is str else value)
                   for key,value in self.plan.items()}
        self.current_source()
        self.plan.update(uid=EXECUTOR,gid=EXECUTOR,executor_uid=EXECUTOR,executor_gid=EXECUTOR,
                         authority_uid=AUTHORITY,authority_gid=EXECUTOR,
                         provider_home=str(self.root/'provider'))
        provider=self.root/'provider';provider.mkdir(mode=0o700);os.chown(provider,EXECUTOR,EXECUTOR)
        for name in ('home','home/data','bootstrap'):
            os.chown(self.root/name,AUTHORITY,EXECUTOR)
        for name in ('workspace','state','authdir','authdir/auth.json'):
            os.chown(self.root/name,EXECUTOR,EXECUTOR)
        roles=[]
        for index in range(5):
            path=self.root/('role-'+str(index));path.mkdir(mode=0o700);os.chown(path,EXECUTOR,EXECUTOR)
            roles.append({'workspace':self.plan['workspace'],'state_root':str(path)})
        self.plan['roles']={'fast':roles[0],'workers':roles[1:]}
        project=self.root/'project';project.mkdir(mode=0o755)
        subprocess.run(['/usr/bin/git','init','-q',str(project)],check=True,env={'PATH':'/usr/bin:/bin'})
        for path in (project,*project.rglob('*')):os.chown(path,OWNER,986)
        self.project=project
        self.plan['workspace_exec']={
            'conversation_id':self.plan['conversation_id'],'project_id':'33333333-3333-4333-8333-333333333333',
            'workspace':str(project),'project_owner_uid':OWNER,'allowed_roots':[str(project)],
            'protected_roots':[str(self.root/'protected')],'cgroup_root':'/sys/fs/cgroup/synthetic-managed',
            'toolchain_root':str(self.root/'toolchain'),
            'trusted':{'managed_executor':{'environment':{'HOME':str(provider),'PATH':'/usr/bin:/bin'}}}}

    def acl(self):
        subprocess.run(['/usr/bin/setfacl','-R','-m',f'u:{EXECUTOR}:rwx,g::rx,m::rwx,o::rx',str(self.project)],check=True)

    def test_selected_managed_project_retains_original_owner_and_named_acl(self):
        self.acl();before=(self.project.stat().st_uid,self.project.stat().st_ino)
        result=selected.prepare(self.plan)
        self.assertFalse(result['activated'])
        beta=json.loads((self.root/'release/package/beta.json').read_text())
        self.assertEqual(beta['workspace_exec'],self.plan['workspace_exec'])
        self.assertEqual((self.project.stat().st_uid,self.project.stat().st_ino),before)
        self.assertEqual(before[0],OWNER)

    def test_missing_named_acl_refuses_before_release_output(self):
        with self.assertRaisesRegex(Exception,'workspace_named_executor_acl'):
            selected.prepare(self.plan)
        self.assertFalse((self.root/'release').exists())

    def test_foreign_acl_writer_refuses_before_release_output(self):
        self.acl()
        subprocess.run(['/usr/bin/setfacl','-m','u:62139:rwx',str(self.project)],check=True)
        with self.assertRaisesRegex(Exception,'workspace_unselected_acl_writer'):
            selected.prepare(self.plan)
        self.assertFalse((self.root/'release').exists())

    def test_authority_environment_key_refuses_before_release_output(self):
        self.acl()
        self.plan['workspace_exec']['trusted']['managed_executor']['environment']['ORKESTR_BOOTSTRAP_TOKEN']='synthetic'
        with self.assertRaisesRegex(Exception,'managed_workspace_environment'):
            selected.prepare(self.plan)
        self.assertFalse((self.root/'release').exists())

    def test_mapped_canonical_auth_stages_in_private_view_without_copying_credentials(self):
        self.acl()
        original=self.root/'canonical-home';original.mkdir(mode=0o700);os.chown(original,OWNER,986)
        account=original/'.codex';account.mkdir(mode=0o700);os.chown(account,OWNER,986)
        auth=account/'auth.json';auth.write_bytes(b'synthetic-canonical-auth');auth.chmod(0o600);os.chown(auth,OWNER,986)
        before=auth.stat();home=original.stat()
        target=Path(self.plan['provider_home'])/'.codex/auth.json'
        target.parent.mkdir(mode=0o700);os.chown(target.parent,EXECUTOR,EXECUTOR)
        target.touch(mode=0o600);os.chown(target,EXECUTOR,EXECUTOR)
        self.plan['auth_file']=str(target)
        directory=self.root/'resource-receipts'
        contract={'format':'orkestr-resource-namespace-v1','owner_id':self.plan['owner_id'],
            'authority_uid':AUTHORITY,'authority_gid':EXECUTOR,'executor_uid':EXECUTOR,'executor_gid':EXECUTOR,
            'source_owner_uid':OWNER,'source_homes':[{'path':str(original),'device':home.st_dev,'inode':home.st_ino,'gid':home.st_gid}],
            'resources':[{'kind':'codex_auth','source':str(auth),'target':str(target),'uid':OWNER,'gid':986,
                          'device':before.st_dev,'inode':before.st_ino}],
            'denials':[],'receipt_directory':str(directory)}
        raw=json.dumps(contract,sort_keys=True,separators=(',',':')).encode()
        path=self.root/'resources.json';path.write_bytes(raw);path.chmod(0o400)
        selection={'path':str(path),'sha256':hashlib.sha256(raw).hexdigest(),'receipt_directory':str(directory)}
        self.plan['resource_namespace']=selection
        namespace=os.stat('/proc/self/ns/mnt').st_ino
        original_open=Path.open
        def no_credential_read(path,*args,**kwargs):
            if path in (auth,target):raise AssertionError('credential contents read')
            return original_open(path,*args,**kwargs)
        with patch.object(Path,'open',no_credential_read):result=selected.prepare(self.plan)
        self.assertFalse(result['activated'])
        self.assertEqual(os.stat('/proc/self/ns/mnt').st_ino,namespace)
        self.assertEqual(list(directory.iterdir()),[])
        self.assertEqual((auth.stat().st_uid,auth.stat().st_ino),(OWNER,before.st_ino))
        self.assertEqual(auth.read_bytes(),b'synthetic-canonical-auth')
        self.assertEqual(target.read_bytes(),b'', 'outside the namespace only the empty placeholder remains')
        descriptor=json.loads((self.root/'release/package/service.json').read_text())
        self.assertEqual(descriptor['resource_namespace'],selection)
        receipt=json.loads((self.root/'release/release.json').read_text())
        self.assertFalse(receipt['credential_contents_read'])


if __name__=='__main__':unittest.main()
