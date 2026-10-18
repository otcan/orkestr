"""Selected token capability and actual disposable Claude-profile namespace."""
import copy
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from isolation.claude_selected import SelectedAccount, SelectedClaudeProfile
from isolation import policy


class SelectedClaudeTests(unittest.TestCase):
    def test_private_capability_one_use_and_no_fallback(self):
        profile=object();other=object()
        cap=SelectedAccount(profile,lambda:{"CLAUDE_CODE_OAUTH_TOKEN":"synthetic-selected"})
        with self.assertRaises(TypeError):copy.copy(cap)
        with self.assertRaises(ValueError):cap._take(other)
        with self.assertRaises(ValueError):cap._take(profile)
        for value in ({},{"ANTHROPIC_API_KEY":"synthetic"},
                      {"CLAUDE_CODE_OAUTH_TOKEN":"synthetic","OTHER":"secret"}):
            with self.assertRaises(ValueError):SelectedAccount(profile,lambda:value)

    def test_actual_selected_namespace_and_private_fd(self):
        with tempfile.TemporaryDirectory(prefix="claude-selected-synthetic-") as tmp:
            root=Path(tmp);state=root/"state";state.mkdir();workspace=root/"work";workspace.mkdir()
            endpoint=root/"egress.sock"
            with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as peer:
                peer.bind(str(endpoint));peer.listen()
                profile=object.__new__(SelectedClaudeProfile)
                profile.native="/usr/bin/python3"
                profile.supervisor=str(Path(__file__).parent.resolve()/"isolation/supervisor.py")
                profile.state_root=str(state);profile.sessions=None;profile.auth=None
                profile.workspace=str(workspace);profile.endpoint=str(endpoint)
                profile.hosts=("subscription.example.invalid",)
                cap=profile.selected_account(lambda:{"CLAUDE_CODE_OAUTH_TOKEN":"synthetic-selected"})
                secret=cap._take(profile);fd=policy.filter_fd(allow_inet=True)
                try:
                    argv=profile._command(fd,"claude-synthetic")+[
                        "11111111-1111-4111-8111-111111111111",str(secret)]
                    self.assertNotIn("synthetic-selected"," ".join(argv))
                    source="\n".join([
                        "import os,socket,sys",
                        "assert os.environ['CLAUDE_CODE_OAUTH_TOKEN']=='synthetic-selected'",
                        "assert os.environ['CLAUDE_CONFIG_DIR']=='/account'",
                        "assert 'ANTHROPIC_API_KEY' not in os.environ and 'INHERITED_SECRET' not in os.environ",
                        "assert 'CODEX_HOME' not in os.environ",
                        "assert not os.listdir('/account')",
                        "try:\n socket.socket(socket.AF_UNIX);raise AssertionError('unix endpoint access')\nexcept OSError:pass",
                        "try:\n socket.create_connection(('192.0.2.1',443),timeout=.1);raise AssertionError('host network')\nexcept OSError:pass",
                        "print('selected-profile-ok')",
                    ])
                    child=subprocess.Popen(argv,env={"INHERITED_SECRET":"synthetic-unrelated"},
                        close_fds=True,pass_fds=(fd,secret),stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
                    try:
                        out,err=child.communicate(("exec("+repr(source)+")\n").encode(),timeout=4)
                        self.assertEqual((child.returncode,out,err),(0,b"selected-profile-ok\n",b""))
                    finally:
                        if child.poll() is None:child.kill();child.wait(timeout=2)
                    self.assertEqual(list(state.iterdir()),[])
                    with self.assertRaises(ValueError):cap._take(profile)
                finally:os.close(fd);os.close(secret)
