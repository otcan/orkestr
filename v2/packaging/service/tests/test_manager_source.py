"""Git-byte provenance independent of ancestry; no provider/native execution."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import manager_source as source

class Source(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.repo=Path(self.tmp.name)
        self.git('init','-q');self.git('config','user.name','Synthetic');self.git('config','user.email','test@example.invalid')
        (self.repo/'note').write_text('base');self.commit('base');self.base=self.git('rev-parse','HEAD')
        p=self.repo/'v2/provider-broker/codex_service';p.mkdir(parents=True)
        (p.parent/'README.md').write_text('synthetic')
        (p.parent/'test_case.py').write_text('raise Exception("test only")')
        (p/'manager.py').write_text('VALUE = 1\n');self.commit('reviewed');self.review=self.git('rev-parse','HEAD')
        self.git('checkout','-q','-b','candidate',self.base)
        (self.repo/'note').write_text('independent history');self.commit('independent')
        self.git('cherry-pick',self.review);self.candidate=self.git('rev-parse','HEAD')
        self.mock=patch.object(source,'MANAGER_BASE',self.review);self.mock.start();self.addCleanup(self.mock.stop)
    def git(self,*args):
        return subprocess.check_output(['/usr/bin/git','-C',str(self.repo),*args],stderr=subprocess.DEVNULL,text=True).strip()
    def commit(self,message):self.git('add','.');self.git('commit','-qm',message)
    def verify(self):return source.verified_inventory(self.repo,self.git('rev-parse','HEAD'))
    def test_genuine_cherry_pick_accepts(self):
        self.assertNotEqual(self.review,self.candidate)
        self.assertEqual(subprocess.run(['/usr/bin/git','-C',str(self.repo),'merge-base','--is-ancestor',self.review,self.candidate]).returncode,1)
        self.assertEqual(len(self.verify()),1)
    def test_changed_refuses_before_export_import(self):
        (self.repo/'v2/provider-broker/codex_service/manager.py').write_text('VALUE = 2\n');self.commit('changed')
        with patch.object(source.tempfile,'TemporaryDirectory',side_effect=AssertionError('export attempted')):
            with self.assertRaisesRegex(RuntimeError,'inventory mismatch'):
                with source.authority(self.repo,self.git('rev-parse','HEAD')):pass
    def test_added_production_refuses(self):
        (self.repo/'v2/provider-broker/socket.py').write_text('raise Exception()');self.commit('added')
        with self.assertRaisesRegex(RuntimeError,'inventory mismatch'):self.verify()
    def test_added_test_named_module_refuses(self):
        (self.repo/'v2/provider-broker/test_shadow.py').write_text('raise Exception()');self.commit('unreviewed test name')
        with self.assertRaisesRegex(RuntimeError,'inventory mismatch'):self.verify()
    def test_missing_refuses(self):
        (self.repo/'v2/provider-broker/codex_service/manager.py').unlink();self.commit('missing')
        with self.assertRaises(RuntimeError):self.verify()
    def test_test_only_changes_not_exported(self):
        for name in ('codex_service_fixture.py','selected_codex_fixture.py','test_case.py'):
            (self.repo/'v2/provider-broker'/name).write_text('raise Exception("must not import")')
        self.commit('tests');self.assertEqual(set(self.verify()),{'codex_service/manager.py'})

if __name__=='__main__':unittest.main()
