"""Selected profile FD5: actual namespace mount, no native/account calls."""
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
from codex_bounded.profile import Configuration
from isolation.workspace_fd import InheritedWorkspace, WorkspaceRefused, logical_workspace

MODULE=str(Path(__file__).resolve().parent)

class SelectedWorkspaceTests(unittest.TestCase):
    @unittest.skipIf(os.geteuid()==0,"actual namespace exercised by unprivileged executor run")
    def test_actual_selected_command_uses_retained_readonly_fd_and_closes_it(self):
        source='''
import fcntl,os,socket,subprocess,tempfile,sys
sys.path.insert(0,MODULE)
from isolation.authenticated import SelectedCodexProfile
from isolation.workspace_fd import InheritedWorkspace
from isolation import policy
with tempfile.TemporaryDirectory(prefix='selected-fd5-') as tmp:
    selected=tmp+'/selected';os.mkdir(selected)
    with open(selected+'/identity','w') as out:out.write('retained')
    original=os.open(selected,os.O_RDONLY|os.O_DIRECTORY)
    high=fcntl.fcntl(original,fcntl.F_DUPFD_CLOEXEC,6);os.close(original)
    os.dup2(high,5);os.close(high)
    retained=InheritedWorkspace()
    os.rename(selected,tmp+'/retired')
    # No replacement path exists: descriptor entry must not reopen it.
    profile=object.__new__(SelectedCodexProfile)
    profile.native='/usr/bin/python3';profile.workspace=selected
    profile._workspace_descriptor=retained
    profile.supervisor=MODULE+'/isolation/supervisor.py'
    profile.auth=None;profile.sessions=None;profile.state_root=tmp+'/state'
    os.mkdir(profile.state_root)
    profile.hosts=('subscription.example.invalid',)
    profile.endpoint=tmp+'/egress.sock'
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as peer:
        peer.bind(profile.endpoint)
        fd=policy.filter_fd(allow_inet=True)
        try:
            command=profile._command(fd,'codex-bounded')
            assert selected not in command,command
            assert command[command.index('--chdir')+1]=='/workspace'
            assert command[command.index('--ro-bind-fd')+1:command.index('--ro-bind-fd')+3]==['5','/workspace']
            # Replace only fixed supervisor payload with an owned synthetic probe.
            start=command.index('--',command.index('--clearenv'))
            probe="""import os,errno
assert os.getcwd()=='/workspace'
assert open('identity').read()=='retained'
try:open('mutation','w')
except OSError as e:assert e.errno==errno.EROFS
else:raise AssertionError('writable mount')
try:os.fstat(5)
except OSError as e:assert e.errno==errno.EBADF
else:raise AssertionError('descriptor leaked')
"""
            command[start+1:]=['/usr/bin/python3','-I','-c',probe]
            result=subprocess.run(command,env={},pass_fds=(fd,5),capture_output=True,timeout=5)
            assert result.returncode==0,result.stderr.decode()
        finally:os.close(fd);os.close(5)
'''.replace('MODULE',repr(MODULE))
        result=subprocess.run([sys.executable,'-I','-c',source],env={},capture_output=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr.decode())

    def test_no_descriptor_no_fallback(self):
        source="import sys;sys.path.insert(0,"+repr(MODULE)+");from isolation.workspace_fd import InheritedWorkspace;InheritedWorkspace()"
        result=subprocess.run([sys.executable,'-I','-c',source],close_fds=True,env={},capture_output=True,timeout=3)
        self.assertNotEqual(result.returncode,0)
        self.assertIn(b'workspace_descriptor_missing',result.stderr)

    def test_closed_workspace_metadata(self):
        self.assertEqual(logical_workspace('/missing/host/work'),'/missing/host/work')
        for value in ('relative','/a/../b','/a\n',None):
            with self.subTest(value=value),self.assertRaises(WorkspaceRefused):logical_workspace(value)

    def test_command_one_use_and_passes_only_workspace_and_filter(self):
        # Real FD capture happens in subprocess tests; this isolates command lifetime.
        config=object.__new__(Configuration);config.issued=False
        config.workspace_descriptor=object();config.profile=type('P',(),{'_command':lambda s,fd,mode:['bwrap','--chdir','/workspace']})()
        config.package=type('P',(),{'root':Path('/synthetic/package')})()
        with patch('codex_bounded.profile.policy.filter_fd',return_value=19), \
                patch('codex_bounded.profile.protected',side_effect=lambda p:p):
            command,descriptors=config.isolated_command()
            self.assertEqual(descriptors,(19,5))
            with self.assertRaises(Exception):config.isolated_command()

    def test_fresh_and_resume_entries_select_fixed_logical_workspace(self):
        from types import SimpleNamespace
        from unittest.mock import Mock, MagicMock
        from codex_bounded import broker
        protocol='orkestr-v2-provider-broker-v1'
        for operation,resumed in [('open-owned-workspace-session',False),
                                  ('resume-owned-workspace-session',True)]:
            channel=Mock();pump=SimpleNamespace(run=Mock(),parent_eof=False)
            config=SimpleNamespace(workspace='/workspace',workspace_descriptor=object())
            package=SimpleNamespace(uid=os.geteuid(),root=Path('/synthetic/package'),
                                    profile_path=Mock(return_value=Path('/synthetic/package/profile.json')))
            descriptor=object();connection=MagicMock()
            connection.__enter__.return_value=connection
            connection.family=broker.socket.AF_UNIX;connection.type=broker.socket.SOCK_STREAM
            factory=Mock(return_value=pump)
            with self.subTest(operation=operation), \
                    patch.object(broker.sys,'argv',['launcher',operation,'--protocol',protocol]), \
                    patch('isolation.workspace_fd.InheritedWorkspace',return_value=descriptor), \
                    patch.object(broker,'Package',return_value=package), \
                    patch.object(broker,'modules',return_value=(channel,protocol,RuntimeError,Mock(),73,object)), \
                    patch.object(broker,'pump_type',return_value=factory), \
                    patch('codex_bounded.profile.Configuration',return_value=config) as configuration, \
                    patch('codex_bootstrap.receive',return_value='native-identity') as receive, \
                    patch.object(broker.signal,'signal'), \
                    patch.object(broker.socket,'socket',return_value=connection):
                self.assertEqual(broker.main(package.root),0)
                configuration.assert_called_once_with(package.root,None,workspace_descriptor=descriptor)
                channel.assert_called_once_with('/workspace',expected_native='native-identity' if resumed else None)
                self.assertEqual(receive.call_count,int(resumed))
                pump.run.assert_called_once()

    @unittest.skipUnless(os.geteuid()==0,'explicit disposable root package test')
    def test_protected_package_descriptor_config_after_host_name_disappears(self):
        source='''
import fcntl,os,socket,sys,json
sys.path.insert(0,MODULE)
from selected_codex_fixture import Fixture,UID,GID
from codex_bounded.configuration import Package
from codex_bounded.profile import Configuration
from isolation.workspace_fd import InheritedWorkspace
fixture=Fixture()
try:
    receipt=fixture.prepare()
    config_path=fixture.home/'selected-execution.json'
    value=json.loads(config_path.read_text())
    value['workspace_authority']={'project_id':'11111111-2222-4333-8444-555555555555',
        'allowed_roots':[str(fixture.workspace)],'protected_roots':[str(fixture.home)]}
    fixture.write_private(config_path,json.dumps(value).encode())
    from codex_bounded.trust import digest
    fixture.alter('runtime.json',lambda r:r.update(execution_config_sha256=digest(config_path)))
    package=Package(receipt['package'])
    with socket.socket(socket.AF_UNIX) as endpoint:
        endpoint.bind(str(package.endpoint));os.chown(package.endpoint,0,GID);package.endpoint.chmod(0o660)
        raw=os.open(fixture.workspace,os.O_RDONLY|os.O_DIRECTORY)
        high=fcntl.fcntl(raw,fcntl.F_DUPFD_CLOEXEC,6);os.close(raw)
        os.dup2(high,5);os.close(high)
        retained=InheritedWorkspace()
        fixture.workspace.rename(str(fixture.workspace)+'-retired')
        child=os.fork()
        if child==0:
          try:
            os.setgroups([]);os.setgid(GID);os.setuid(UID)
            config=Configuration(package.root,workspace_descriptor=retained)
            assert config.workspace=='/workspace'
            command,descriptors=config.isolated_command()
            try:
                assert descriptors[-1]==5
                assert str(fixture.workspace) not in command
                assert command[command.index('--chdir')+1]=='/workspace'
            finally:
                for fd in descriptors:os.close(fd)
            os._exit(0)
          except BaseException:
            import traceback;traceback.print_exc();os._exit(1)
        assert os.waitpid(child,0)[1]==0
        os.close(5)
finally:fixture.close()
'''.replace('MODULE',repr(MODULE))
        result=subprocess.run([sys.executable,'-I','-c',source],env={},capture_output=True,timeout=15)
        self.assertEqual(result.returncode,0,result.stderr.decode())
