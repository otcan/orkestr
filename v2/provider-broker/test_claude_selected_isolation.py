"""Selected token capability and actual disposable Claude-profile namespace."""
import copy
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import re
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
            root=Path(tmp);state=root/"state";state.mkdir(mode=0o700);workspace=root/"work";workspace.mkdir(mode=0o700)
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
                    with patch('isolation.claude_state.private_path',return_value=str(state)):
                        argv=profile._command(fd,"claude-synthetic")+[
                            "11111111-1111-4111-8111-111111111111",str(secret)]
                    self.assertNotIn("synthetic-selected"," ".join(argv))
                    source="\n".join([
                        "import os,socket,sys",
                        "assert os.environ['CLAUDE_CODE_OAUTH_TOKEN']=='synthetic-selected'",
                        "assert os.environ['CLAUDE_CONFIG_DIR']=='/account'",
                        "assert 'ANTHROPIC_API_KEY' not in os.environ and 'INHERITED_SECRET' not in os.environ",
                        "assert 'CODEX_HOME' not in os.environ",
                        "assert os.listdir('/account')==['projects']",
                        "try:\n socket.socket(socket.AF_UNIX);raise AssertionError('unix endpoint access')\nexcept OSError:pass",
                        "try:\n socket.create_connection(('192.0.2.1',443),timeout=.1);raise AssertionError('host network')\nexcept OSError:pass",
                        "from pathlib import Path",
                        "for entry in Path('/proc/self/fd').iterdir():",
                        " try: target=os.readlink(entry)",
                        " except FileNotFoundError: continue",
                        " assert 'memfd:selected-account' not in target",
                        "project="+repr(re.sub(r"[^a-zA-Z0-9]","-",str(workspace))),
                        "os.makedirs('/account/projects/'+project,mode=0o700)",
                        "session=os.open('/account/projects/'+project+'/11111111-1111-4111-8111-111111111111.jsonl',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)",
                        "os.write(session,b'synthetic-session-metadata\\n');os.close(session)",
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
                    retained=state/'projects'/re.sub(r'[^a-zA-Z0-9]','-',str(workspace))/'11111111-1111-4111-8111-111111111111.jsonl'
                    self.assertEqual(retained.read_bytes(),b'synthetic-session-metadata\n')
                    self.assertNotIn(b'synthetic-selected',retained.read_bytes())
                    with patch('isolation.claude_state.private_path',return_value=str(state)):
                        self.assertEqual(profile._state(state),str(state))
                    # A fresh owned namespace sees only durable project history;
                    # account/settings and telemetry are not mounted on reuse.
                    (state/'.claude.json').write_text('synthetic-excluded-metadata')
                    (state/'.claude.json').chmod(0o600)
                    second_secret=profile.selected_account(lambda:{'CLAUDE_CODE_OAUTH_TOKEN':'synthetic-selected'})._take(profile)
                    second_filter=policy.filter_fd(allow_inet=True)
                    try:
                        with patch('isolation.claude_state.private_path',return_value=str(state)):
                            second_argv=profile._command(second_filter,'claude-synthetic')+[
                                '11111111-1111-4111-8111-111111111111',str(second_secret)]
                        second_source="\n".join([
                            'from pathlib import Path',
                            "assert not Path('/account/.claude.json').exists()",
                            "files=list(Path('/account/projects').glob('*/*.jsonl'))",
                            "assert len(files)==1 and files[0].read_bytes()==b'synthetic-session-metadata\\n'",
                            "print('persistent-profile-ok')",
                        ])
                        second=subprocess.Popen(second_argv,env={},close_fds=True,
                            pass_fds=(second_filter,second_secret),stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
                        try:
                            out,err=second.communicate(('exec('+repr(second_source)+')\n').encode(),timeout=4)
                            self.assertEqual((second.returncode,out,err),(0,b'persistent-profile-ok\n',b''))
                        finally:
                            if second.poll() is None:second.kill();second.wait(timeout=2)
                    finally:os.close(second_secret);os.close(second_filter)
                    self.assertEqual((state/'.claude.json').read_text(),'synthetic-excluded-metadata')
                    with self.assertRaises(ValueError):cap._take(profile)
                finally:os.close(fd);os.close(secret)
