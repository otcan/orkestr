"""No file content may be read while rejecting credential/artifact aliases."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from artifact_boundary import separate


class Boundary(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.plan={}
        for key in ('pair','server','native','auth_file','bootstrap_file'):
            p=self.root/key;p.write_bytes(b'synthetic');self.plan[key]=str(p)
        ui=self.root/'ui';ui.mkdir();(ui/'index.html').write_text('synthetic');self.plan['ui']=str(ui)
    def check(self,refuse):
        with patch.object(Path,'open',side_effect=AssertionError('no reads permitted')):
            if refuse:
                with self.assertRaises(Exception):separate(self.plan)
            else:separate(self.plan)
    def test_positive_metadata_only(self):self.check(False)
    def test_direct_aliases(self):
        for key in ('pair','server','native'):
            for credential in ('auth_file','bootstrap_file'):
                with self.subTest(key=key,credential=credential):
                    prior=self.plan[key];self.plan[key]=self.plan[credential]
                    self.check(True);self.plan[key]=prior
    def test_symlink_alias(self):
        p=self.root/'server';p.unlink();p.symlink_to(self.plan['auth_file']);self.check(True)
    def test_hardlink_alias(self):
        p=self.root/'native';p.unlink();os.link(self.plan['auth_file'],p);self.check(True)
    def test_ui_hardlink(self):
        os.link(self.plan['bootstrap_file'],self.root/'ui/secret');self.check(True)
    def test_ui_symlink(self):
        (self.root/'ui/secret').symlink_to(self.plan['auth_file']);self.check(True)
    def test_ui_directory_alias(self):
        (self.root/'ui/nested').symlink_to(self.root,target_is_directory=True);self.check(True)
    def test_credential_inside_ui(self):
        p=self.root/'ui/credential';p.write_bytes(b'synthetic');self.plan['auth_file']=str(p);self.check(True)

if __name__=='__main__':unittest.main()
