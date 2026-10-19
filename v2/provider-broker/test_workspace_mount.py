"""Actual disposable FD5 mount qualification; no Store/provider authority claim."""
import os
from pathlib import Path
import subprocess
import sys
import unittest

MODULE = str(Path(__file__).resolve().parent)

class WorkspaceMountTests(unittest.TestCase):
    def test_same_descriptor_readonly_and_closed_after_mount(self):
        source = '''
import os, subprocess, tempfile, sys
sys.path.insert(0, MODULE)
from workspace_fd import InheritedWorkspace
with tempfile.TemporaryDirectory(prefix='workspace-fd-mount-') as root:
    original=root+'/selected'
    os.mkdir(original)
    with open(original+'/identity','w') as f:f.write('retained')
    fd=os.open(original,os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC)
    # Reserve high source before mapping, as in the trusted Runtime boundary.
    import fcntl
    retained=fcntl.fcntl(fd,fcntl.F_DUPFD_CLOEXEC,6)
    os.close(fd)
    os.dup2(retained,5);os.close(retained)
    workspace=InheritedWorkspace()
    os.rename(original,root+'/retired')
    os.mkdir(original)
    with open(original+'/identity','w') as f:f.write('foreign')
    help=subprocess.check_output(['/usr/bin/bwrap','--help'],timeout=3)
    args=['/usr/bin/bwrap','--unshare-all','--die-with-parent','--new-session','--clearenv',
          '--ro-bind','/usr','/usr','--proc','/proc','--dev','/dev']
    for runtime in ['/lib','/lib64']:
        if os.path.exists(runtime):args+=['--ro-bind',runtime,runtime]
    args+=list(workspace.mount_arguments(help))
    probe="""import os,errno
assert os.getcwd()=='/workspace'
with open('identity') as f:assert f.read()=='retained'
try:open('mutation','w')
except OSError as e:assert e.errno==errno.EROFS
else:raise AssertionError('writable workspace')
try:os.fstat(5)
except OSError as e:assert e.errno==errno.EBADF
else:raise AssertionError('workspace FD leaked to child')
"""
    args+=['/usr/bin/python3','-I','-c',probe]
    result=subprocess.run(args,pass_fds=(5,),capture_output=True,timeout=5,env={})
    os.close(5)
    assert result.returncode==0,result.stderr.decode()
    assert not os.path.exists(root+'/retired/mutation')
    assert not os.path.exists(original+'/mutation')
'''.replace('MODULE',repr(MODULE))
        result=subprocess.run([sys.executable,'-I','-c',source],capture_output=True,timeout=10,env={})
        self.assertEqual(result.returncode,0,result.stderr.decode())

if __name__=='__main__':
    unittest.main()
