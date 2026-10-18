"""Run private resume preparation from ONLY the immutable profile inventory."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


class InventoryTests(unittest.TestCase):
    def test_isolated_inventory_resume_class_identity_and_preparation(self):
        source=Path(__file__).parent
        inventory=json.loads((source/'authenticated-package.json').read_text())
        with tempfile.TemporaryDirectory(prefix='profile-inventory-') as temporary:
            stage=Path(temporary)
            for name,digest in inventory['files'].items():
                original=source/name
                self.assertEqual(hashlib.sha256(original.read_bytes()).hexdigest(),digest)
                destination=stage/name;destination.parent.mkdir(parents=True,exist_ok=True)
                shutil.copyfile(original,destination)
            script=r'''
import sys
sys.path.insert(0,sys.argv[1])
from unittest.mock import patch
from isolation.claude_selected import SelectedClaudeProfile
from isolation.selected_subscription import SelectedSubscription
from claude_resume import ResumeSpec, _SEAL
import claude_bootstrap
assert claude_bootstrap.ResumeSpec is ResumeSpec
from pathlib import Path
import re
profile=object.__new__(SelectedClaudeProfile)
profile.state_root=str(Path(sys.argv[1])/'state')
profile.workspace='/work/synthetic'
root=Path(profile.state_root);root.mkdir(mode=0o700)
project=root/'projects'/re.sub(r'[^a-zA-Z0-9]','-',profile.workspace)
project.mkdir(parents=True,mode=0o700);project.parent.chmod(0o700)
native='11111111-1111-4111-8111-111111111111'
(project/(native+'.jsonl')).touch(mode=0o600)
with patch('isolation.claude_state.private_path',return_value=str(root)),patch.object(profile,'_exec') as launch:
    spec=ResumeSpec(_SEAL,profile,native)
    account=object()
    profile.exec_resume(account,spec)
    launch.assert_called_once_with(account,native,'claude-resume')
    try:profile.exec_resume(account,spec)
    except Exception:pass
    else:raise AssertionError('spec reused')
print('inventory-only-resume-ok')
'''
            result=subprocess.run([sys.executable,'-I','-B','-c',script,str(stage)],
                cwd=stage,env={},capture_output=True,timeout=5)
            self.assertEqual((result.returncode,result.stdout,result.stderr),
                             (0,b'inventory-only-resume-ok\n',b''))
