"""Bounded generated state and private resume selection, synthetic fixtures only."""
import os
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch
from isolation.claude_state import projects, state_root
from isolation.claude_selected import SelectedClaudeProfile
from claude_resume import ResumeSpec, _SEAL

NATIVE='11111111-1111-4111-8111-111111111111'


class ClaudeStateTests(unittest.TestCase):
    def test_closed_state_aliases_and_workspace_session(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)/'state';root.mkdir(mode=0o700);workspace='/work/synthetic'
            with patch('isolation.claude_state.private_path',return_value=str(root)):
                project=Path(projects(root,workspace))/re.sub(r'[^a-zA-Z0-9]','-',workspace)
                project.mkdir(mode=0o700)
                transcript=project/(NATIVE+'.jsonl');transcript.touch(mode=0o600)
                self.assertEqual(projects(root,workspace,NATIVE),str(root/'projects'))
                with self.assertRaises(ValueError):projects(root,workspace,fresh=True)
                profile=object.__new__(SelectedClaudeProfile)
                profile.state_root=str(root);profile.workspace=workspace
                account=profile.selected_account(lambda:{'CLAUDE_CODE_OAUTH_TOKEN':'synthetic-selected'})
                with patch('isolation.claude_selected.policy.filter_fd') as filtered:
                    with self.assertRaises(ValueError):profile.exec_native(account,NATIVE)
                    filtered.assert_not_called()
                with self.assertRaises(ValueError):account._take(profile)
                for other in ('/work/foreign',):
                    with self.assertRaises(ValueError):projects(root,other,NATIVE)
                with self.assertRaises(ValueError):projects(root,workspace,'22222222-2222-4222-8222-222222222222')
                target=Path(temporary)/'target';target.write_bytes(b'unchanged');target.chmod(0o600)
                transcript.unlink();os.link(target,transcript)
                with self.assertRaises(ValueError):state_root(root)
                self.assertEqual(target.read_bytes(),b'unchanged')
                target.unlink();transcript.unlink();transcript.symlink_to('/unmounted-synthetic')
                with self.assertRaises(ValueError):state_root(root)

    def test_generated_metadata_not_mounted(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            with patch('isolation.claude_state.private_path',return_value=str(root)):
                for name in ('.claude.json','remote-settings.json','policy-limits.json','policy-limits.json.stamp.json'):
                    (root/name).write_text('synthetic-account-metadata');(root/name).chmod(0o600)
                (root/'backups').mkdir(mode=0o700)
                backup=root/'backups/.claude.json.backup.123';backup.touch(mode=0o600)
                self.assertEqual(state_root(root),str(root))
                (root/'settings.json').touch(mode=0o600)
                with self.assertRaises(ValueError):state_root(root)

    def test_private_resume_spec_is_consumed_without_launch_fallback(self):
        profile=object.__new__(SelectedClaudeProfile)
        profile.state_root='/synthetic/state';profile.workspace='/work/synthetic'
        with patch('isolation.claude_selected.projects') as checked,patch.object(profile,'_exec') as launch:
            spec=ResumeSpec(_SEAL,profile,NATIVE)
            account=object()
            profile.exec_resume(account,spec)
            checked.assert_called_once_with(profile.state_root,profile.workspace,NATIVE)
            launch.assert_called_once_with(account,NATIVE,'claude-resume')
            with self.assertRaises(Exception):profile.exec_resume(account,spec)
        with self.assertRaises(ValueError):profile.exec_resume(object(),{'native':NATIVE})

    def test_fixed_resume_native_flags(self):
        from isolation import supervisor
        with patch('sys.argv',['supervisor','claude-resume-native','9',NATIVE]), \
             patch.object(supervisor,'install_filter') as filtered, \
             patch.object(supervisor.os,'execve',side_effect=RuntimeError('synthetic exec')) as execute:
            with self.assertRaises(RuntimeError):supervisor.main()
            filtered.assert_called_once_with(9)
            executable,args,_environment=execute.call_args.args
            self.assertEqual(executable,'/opt/provider/native')
            self.assertEqual(args[-2:],['--resume',NATIVE])
            self.assertNotIn('--session-id',args)
