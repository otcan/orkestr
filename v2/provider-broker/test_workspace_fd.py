"""Descriptor-only synthetic subprocess tests. No provider, account or mount."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

MODULE = str(Path(__file__).resolve().parent)
class WorkspaceFdTests(unittest.TestCase):
    def run_child(self, body):
        source = 'import os,sys\nsys.path.insert(0,'+repr(MODULE)+')\nfrom workspace_fd import *\n'+body
        result = subprocess.run([sys.executable,'-c',source],capture_output=True,timeout=5)
        self.assertEqual(result.returncode,0,result.stderr.decode())

    def test_missing_refuses(self):
        self.run_child("\ntry: os.close(5)\nexcept OSError: pass\ntry: InheritedWorkspace()\nexcept WorkspaceRefused: pass\nelse: raise AssertionError('accepted missing')\n")

    def test_regular_file_refuses(self):
        self.run_child("\nimport tempfile\nf=tempfile.TemporaryFile();os.dup2(f.fileno(),5)\ntry: InheritedWorkspace()\nexcept WorkspaceRefused: pass\nelse: raise AssertionError('accepted file')\n")

    def test_retained_directory_rename_and_fixed_mount(self):
        self.run_child("\nimport tempfile\nwith tempfile.TemporaryDirectory() as base:\n os.mkdir(base+'/old');fd=os.open(base+'/old',os.O_RDONLY|os.O_DIRECTORY);os.dup2(fd,5)\n w=InheritedWorkspace();os.rename(base+'/old',base+'/retained');os.mkdir(base+'/old')\n assert w.mount_arguments(b'--ro-bind-fd FD DEST')==('--ro-bind-fd','5','/workspace','--chdir','/workspace')\n assert w.pass_fds()==(3,5)\n assert w.pass_fds(resume=True)==(3,4,5)\n")

    def test_replaced_descriptor_refuses(self):
        self.run_child("\nimport tempfile\nwith tempfile.TemporaryDirectory() as base:\n os.mkdir(base+'/a');os.mkdir(base+'/b')\n a=os.open(base+'/a',os.O_RDONLY|os.O_DIRECTORY);os.dup2(a,5);w=InheritedWorkspace()\n b=os.open(base+'/b',os.O_RDONLY|os.O_DIRECTORY);os.dup2(b,5)\n try: w.validate()\n except WorkspaceRefused: pass\n else: raise AssertionError('accepted replacement')\n")

    def test_unsupported_bwrap_refuses(self):
        self.run_child("\nfd=os.open('/',os.O_RDONLY|os.O_DIRECTORY);os.dup2(fd,5);w=InheritedWorkspace()\ntry: w.mount_arguments(b'--ro-bind SRC DEST')\nexcept WorkspaceRefused: pass\nelse: raise AssertionError('fallback')\n")
