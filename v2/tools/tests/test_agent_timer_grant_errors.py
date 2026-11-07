"""Grant setup failures stay structured and secret-free before any timer call."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / 'agent_timer.py'
SPEC = importlib.util.spec_from_file_location('agent_timer_grant_errors', SCRIPT)
TIMER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TIMER)
CONVERSATION = '00000000-0000-4000-8000-00000000000a'
GRANT = 'ab' * 32
SETUP_ERROR = {'ok': False, 'status': 0, 'code': 'grant_missing_or_invalid'}
PRIVATE_ERROR = {'ok': False, 'status': 0, 'code': 'grant_file_must_be_private'}


class GrantErrors(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='synthetic-timer-grants-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.path = self.root / ('private-path-' + GRANT + '.grant')

    def private_file(self, contents=GRANT):
        self.path.write_text(contents)
        self.path.chmod(0o600)
        return self.path

    def assert_cli_error(self, result, expected):
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, '')
        self.assertEqual(json.loads(result.stderr), expected)
        self.assertEqual(len(result.stderr.splitlines()), 1)
        for forbidden in (GRANT, str(self.root), self.path.name, 'Traceback'):
            self.assertNotIn(forbidden, result.stderr)

    def cli(self, *args, extra_env=None):
        # No inherited credentials or real instance configuration; grant
        # failures must precede the otherwise unreachable synthetic endpoint.
        env = {'PATH': os.defpath, 'LANG': 'C.UTF-8', **(extra_env or {})}
        return subprocess.run(
            [sys.executable, '-I', '-S', '-B', str(SCRIPT), '--v2-url',
             'http://127.0.0.1:1', '--conversation', CONVERSATION, *args],
            env=env, text=True, capture_output=True, timeout=5)

    def test_missing_explicit_and_provisioned_grants_have_clean_cli_errors(self):
        self.assert_cli_error(self.cli('--grant-file', str(self.path), 'list'), SETUP_ERROR)
        self.assert_cli_error(self.cli('list', extra_env={
            'ORKESTR_V2_AGENT_TIMER_GRANT_DIR': str(self.root)}), SETUP_ERROR)
        # An explicitly selected missing grant must never fall back to an
        # otherwise valid environment grant.
        self.assert_cli_error(self.cli('--grant-file', str(self.path), 'list', extra_env={
            'ORKESTR_V2_AGENT_TIMER_GRANT': GRANT}), SETUP_ERROR)

    def test_stat_and_read_failures_are_caught_before_constructing_a_client(self):
        self.private_file()
        for operation in ('lstat', 'read_text'):
            with self.subTest(operation=operation):
                out, err = io.StringIO(), io.StringIO()
                failure = PermissionError(13, 'synthetic secret ' + GRANT, str(self.path))
                with mock.patch.object(Path, operation, side_effect=failure), \
                        mock.patch.object(TIMER, 'Client') as client, \
                        contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                    code = TIMER.main(['--v2-url', 'http://127.0.0.1:1',
                                       '--conversation', CONVERSATION,
                                       '--grant-file', str(self.path), 'list'])
                self.assert_cli_error(subprocess.CompletedProcess(
                    [], code, out.getvalue(), err.getvalue()), SETUP_ERROR)
                client.assert_not_called()

    @unittest.skipIf(os.getuid() == 0, 'root can read mode-000 files; injected EACCES is covered')
    def test_unreadable_private_file_has_a_clean_process_error(self):
        self.private_file().chmod(0o000)
        self.assert_cli_error(self.cli('--grant-file', str(self.path), 'list'), SETUP_ERROR)

    def test_invalid_encoding_has_a_clean_process_error(self):
        self.path.write_bytes(b'\xff' + GRANT.encode())
        self.path.chmod(0o600)
        self.assert_cli_error(self.cli('--grant-file', str(self.path), 'list'), SETUP_ERROR)

    def test_symlink_and_directory_still_fail_the_private_file_check(self):
        target = self.root / 'synthetic-target.grant'
        target.write_text(GRANT)
        target.chmod(0o600)
        self.path.symlink_to(target)
        self.assert_cli_error(self.cli('--grant-file', str(self.path), 'list'), PRIVATE_ERROR)
        with mock.patch.object(Path, 'read_text') as read:
            with self.assertRaises(TIMER.TimerError) as caught:
                TIMER.read_grant(self.path)
            self.assertEqual(caught.exception.code, PRIVATE_ERROR['code'])
            read.assert_not_called()
        self.assert_cli_error(self.cli('--grant-file', str(self.root), 'list'), PRIVATE_ERROR)

    def test_owner_and_mode_checks_are_preserved(self):
        self.private_file()
        with mock.patch.object(TIMER.os, 'getuid', return_value=os.getuid() + 1):
            with self.assertRaises(TIMER.TimerError) as caught:
                TIMER.read_grant(self.path)
        self.assertEqual(caught.exception.code, PRIVATE_ERROR['code'])
        self.path.chmod(0o644)
        self.assert_cli_error(self.cli('--grant-file', str(self.path), 'list'), PRIVATE_ERROR)

    def test_successful_file_and_environment_grants_are_unchanged(self):
        self.private_file(' \n' + GRANT + '\n')
        self.assertEqual(TIMER.read_grant(self.path), GRANT)
        self.assertEqual(TIMER.read_grant(environ={
            'ORKESTR_V2_AGENT_TIMER_GRANT': ' ' + GRANT + '\n'}), GRANT)
        for contents in ('', 'short', GRANT.upper()):
            with self.subTest(contents=contents):
                self.private_file(contents)
                self.assert_cli_error(self.cli('--grant-file', str(self.path), 'list'), SETUP_ERROR)


if __name__ == '__main__':
    unittest.main()
