"""Fixture and mocked process checks only; no Rust binary is executed."""
import os
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import MagicMock, patch

import probe


class FakeProcess:
    returncode = 1

    def __init__(self, argv, *, cwd, env, **kwargs):
        self.root = Path(cwd)
        if self.mutate:
            (Path(env['ORKESTR_HOME']) / 'sentinel').write_bytes(b'changed')

    mutate = False

    def communicate(self, timeout=None):
        return b'', b'isolation alias refused'

    def poll(self):
        return self.returncode


class ProbeTests(unittest.TestCase):
    def test_all_negative_fixtures_accept_byte_preserving_refusal(self):
        with patch.object(probe.subprocess, 'Popen', FakeProcess):
            for case in probe.CASES[:-1]:
                with self.subTest(case=case):
                    self.assertTrue(probe.exercise(Path('/synthetic/server'), case, 48000)['passed'])

    def test_refusal_after_mutation_fails(self):
        with patch.object(probe.subprocess, 'Popen', FakeProcess), patch.object(FakeProcess, 'mutate', True):
            result = probe.exercise(Path('/synthetic/server'), 'db-symlink-empty', 48000)
        self.assertFalse(result['passed'])
        self.assertIn('legacy/sentinel', result['changed_paths'])

    def test_unrelated_error_is_not_isolation_evidence(self):
        with patch.object(probe.subprocess, 'Popen', FakeProcess), patch.object(
                FakeProcess, 'communicate', return_value=(b'', b'bind failed')):
            self.assertFalse(probe.exercise(Path('/synthetic/server'), 'db-hardlink', 48000)['passed'])

    def test_timeout_snapshot_preserves_cleanup_concealed_mutation(self):
        class CleanupProcess(FakeProcess):
            returncode = None

            def communicate(self, timeout=None):
                if self.returncode is None:
                    (self.root / 'legacy' / 'transient-wal').write_bytes(b'changed')
                    raise subprocess.TimeoutExpired('synthetic', timeout)
                return b'', b'isolation alias refused'

            def kill(self):
                (self.root / 'legacy' / 'transient-wal').unlink()
                self.returncode = -9

        with patch.object(probe.subprocess, 'Popen', CleanupProcess):
            result = probe.exercise(Path('/synthetic/server'), 'wal-symlink', 48000)
        self.assertFalse(result['passed'])
        self.assertIn('legacy/transient-wal', result['snapshot_changes']['before-timeout-kill'])
        self.assertEqual(result['snapshot_changes']['after-exit'], [])
        self.assertIn('legacy/transient-wal', result['changed_paths'])

    def test_live_control_snapshot_detects_mutation_removed_on_terminate(self):
        class CleanupControl(FakeProcess):
            returncode = None

            def __init__(self, argv, **kwargs):
                super().__init__(argv, **kwargs)
                (self.root / 'candidate' / 'core.sqlite3').touch()
                (self.root / 'legacy' / 'transient-shm').write_bytes(b'changed')

            def terminate(self):
                (self.root / 'legacy' / 'transient-shm').unlink()
                self.returncode = -15

        response = MagicMock()
        response.__enter__.return_value.status = 200
        with patch.object(probe.subprocess, 'Popen', CleanupControl), patch.object(
                probe.urllib.request, 'urlopen', return_value=response):
            result = probe.exercise(Path('/synthetic/server'), 'separated-homes', 48000)
        self.assertFalse(result['passed'])
        self.assertIn('legacy/transient-shm', result['snapshot_changes']['before-terminate'])
        self.assertNotIn('legacy/transient-shm', result['snapshot_changes']['after-exit'])

    def test_assigned_port_is_forwarded_exactly(self):
        with patch.object(probe.subprocess, 'Popen', side_effect=FakeProcess) as launch:
            probe.exercise(Path('/synthetic/server'), 'db-hardlink', 48000)
        self.assertEqual(launch.call_args.kwargs['env']['ORKESTR_V2_BIND'], '127.0.0.1:48000')

    def test_snapshot_does_not_follow_directory_symlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            probe.fixture(root, 'home-symlink')
            state = probe.snapshot(root)
            self.assertEqual(state['candidate'][0], 'symlink')
            self.assertNotIn('candidate/sentinel', state)

    def test_hardlink_identity_is_real(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home, legacy = probe.fixture(root, 'db-hardlink')
            self.assertTrue(os.path.samefile(home / 'core.sqlite3', legacy / 'core.sqlite3'))
            self.assertEqual((home / 'core.sqlite3').stat().st_nlink, 2)


if __name__ == '__main__':
    unittest.main()
