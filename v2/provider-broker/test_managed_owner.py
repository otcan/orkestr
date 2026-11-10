"""Disposable cross-process V2 seam, never canonical account bytes/native."""
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import threading
import unittest
from isolation.managed_owner import ProfileOwner
from test_managed_refresh import EXPECTED,response

CHILD=r'''
import json,os,sys
from isolation.managed_owner import ProfileOwner
from test_managed_refresh import EXPECTED,response
root,account=sys.argv[1:]
owner=ProfileOwner(root,account,'synthetic-selected',lambda:None)
def exchange(request,**bounds):
 assert request=={'id':1,'method':'account/read','params':{'refreshToken':True}}
 print('entered',flush=True)
 assert sys.stdin.readline()=='finish\n'
 return response()
owner.refresh(exchange,EXPECTED)
print('finished',flush=True)
'''


class ManagedOwnerTests(unittest.TestCase):
    def setup_paths(self,root):
        directory=root/'owner';directory.mkdir(mode=0o700)
        account_dir=root/'account';account_dir.mkdir(mode=0o700)
        account=account_dir/'auth.json';account.write_text('synthetic old bytes');account.chmod(0o600)
        return directory,account

    def test_fake_peer_atomic_replacement_reloads_and_stales_old_handle(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory,account=self.setup_paths(Path(temporary))
            owner=ProfileOwner(directory,account,'synthetic-selected',account.read_text)
            old=owner.select()
            def exchange(request,**bounds):
                result=subprocess.run([sys.executable,'-c',
                    'import json,sys,os; assert "SYNTHETIC_OWNER_SECRET" not in os.environ; r=json.load(sys.stdin); assert r["method"]=="account/read" and r["params"]=={"refreshToken":True}; print(sys.argv[1])',json.dumps(response())],
                    input=json.dumps(request),text=True,capture_output=True,timeout=3,
                    env={'PATH':'/usr/bin:/bin'},close_fds=True,check=True)
                replacement=account.with_suffix('.new');replacement.write_text('synthetic new bytes');replacement.chmod(0o600)
                os.replace(replacement,account)
                return json.loads(result.stdout)
            fresh=owner.refresh(exchange,EXPECTED)
            with self.assertRaises(ValueError):old.launch()
            self.assertEqual(fresh.launch(),'synthetic new bytes')
            with self.assertRaises(ValueError):fresh.launch()

    def child(self,directory,account):
        return subprocess.Popen([sys.executable,'-c',CHILD,str(directory),str(account)],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,
            cwd=Path(__file__).parent,env={'PATH':'/usr/bin:/bin'},close_fds=True)

    def entered(self,child):
        self.assertTrue(select.select([child.stdout],[],[],3)[0])
        self.assertEqual(child.stdout.readline(),'entered\n')

    def test_cross_process_exclusion_and_stale_owner(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory,account=self.setup_paths(Path(temporary))
            old=ProfileOwner(directory,account,'synthetic-selected',lambda:None)
            stale=old.select();child=self.child(directory,account)
            try:
                self.entered(child)
                with self.assertRaises((ValueError,BlockingIOError)):
                    ProfileOwner(directory,account,'synthetic-selected',lambda:None)
                with self.assertRaises(ValueError):old.select()
                stdout,stderr=child.communicate('finish\n',timeout=3)
                self.assertEqual(child.returncode,0,stderr);self.assertEqual(stdout,'finished\n')
                with self.assertRaises(ValueError):stale.launch()
                ProfileOwner(directory,account,'synthetic-selected',lambda:None).select().launch()
            finally:
                if child.poll() is None:child.kill();child.wait(timeout=3)
                for stream in (child.stdin,child.stdout,child.stderr):stream.close()

    def test_owner_death_leaves_unknown_no_restart_or_reissue(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory,account=self.setup_paths(Path(temporary))
            child=self.child(directory,account)
            try:
                self.entered(child);child.kill();child.wait(timeout=3)
                with self.assertRaisesRegex(ValueError,'reconciliation'):
                    ProfileOwner(directory,account,'synthetic-selected',lambda:None)
                self.assertEqual(account.read_text(),'synthetic old bytes')
            finally:
                if child.poll() is None:child.kill();child.wait(timeout=3)
                for stream in (child.stdin,child.stdout,child.stderr):stream.close()

    def test_revoke_during_refresh_refuses_late_valid_result(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory,account=self.setup_paths(Path(temporary))
            owner=ProfileOwner(directory,account,'synthetic-selected',lambda:None)
            handle=owner.select();entered=threading.Event();release=threading.Event();errors=[]
            def exchange(*args,**kwargs):
                entered.set()
                if not release.wait(3):raise TimeoutError()
                return response()
            def run():
                try:owner.refresh(exchange,EXPECTED)
                except ValueError:errors.append('refused')
            thread=threading.Thread(target=run);thread.start()
            try:
                self.assertTrue(entered.wait(3));owner.revoke()
            finally:release.set();thread.join(3)
            self.assertFalse(thread.is_alive());self.assertEqual(errors,['refused'])
            with self.assertRaises(ValueError):handle.launch()
            with self.assertRaises(ValueError):owner.select()

    def test_path_identity_alias_and_foreign_profile_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);directory,account=self.setup_paths(root)
            owner=ProfileOwner(directory,account,'synthetic-selected',lambda:None)
            with self.assertRaises(ValueError):ProfileOwner(directory,account,'foreign',lambda:None)
            alias=account.with_name('alias');os.link(account,alias)
            with self.assertRaises(ValueError):owner.select()
            alias.unlink();account.unlink();account.symlink_to(root/'absent')
            with self.assertRaises(ValueError):owner.select()


    def test_uncoordinated_atomic_replacement_refuses_reload(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory,account=self.setup_paths(Path(temporary))
            owner=ProfileOwner(directory,account,'synthetic-selected',lambda:None)
            handle=owner.select()
            replacement=account.with_suffix('.new')
            replacement.write_text('synthetic foreign replacement');replacement.chmod(0o600)
            os.replace(replacement,account)
            with self.assertRaises(ValueError):handle.launch()
            with self.assertRaises(ValueError):owner.select()
            with self.assertRaises(ValueError):ProfileOwner(directory,account,'synthetic-selected',lambda:None)

    def test_fake_child_does_not_inherit_secret_or_owner_lock(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory,account=self.setup_paths(Path(temporary))
            owner=ProfileOwner(directory,account,'synthetic-selected',lambda:None)
            old=os.environ.get('SYNTHETIC_OWNER_SECRET')
            os.environ['SYNTHETIC_OWNER_SECRET']='synthetic-not-a-credential'
            def exchange(*args,**kwargs):
                code="""import os
assert 'SYNTHETIC_OWNER_SECRET' not in os.environ
for name in os.listdir('/proc/self/fd'):
 try: target=os.readlink('/proc/self/fd/'+name)
 except FileNotFoundError: continue
 assert not target.endswith('owner.lock') and not target.endswith('owner.sqlite')
"""
                subprocess.run([sys.executable,'-c',code],env={'PATH':'/usr/bin:/bin'},
                               close_fds=True,check=True,timeout=3,capture_output=True)
                return response()
            try:owner.refresh(exchange,EXPECTED)
            finally:
                if old is None:os.environ.pop('SYNTHETIC_OWNER_SECRET',None)
                else:os.environ['SYNTHETIC_OWNER_SECRET']=old


    def test_one_selected_handle_concurrent_launch_is_one_use(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory,account=self.setup_paths(Path(temporary))
            launches=[];outcomes=[]
            owner=ProfileOwner(directory,account,'synthetic-selected',lambda:launches.append(True))
            handle=owner.select()
            def run():
                try:handle.launch();outcomes.append('launched')
                except ValueError:outcomes.append('refused')
            threads=[threading.Thread(target=run) for _ in range(8)]
            for thread in threads:thread.start()
            for thread in threads:thread.join(3);self.assertFalse(thread.is_alive())
            self.assertEqual(launches,[True]);self.assertEqual(outcomes.count('launched'),1)
