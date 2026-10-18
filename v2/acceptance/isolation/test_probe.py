"""Fixture and mocked process checks only; no Rust binary is executed."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

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
                    self.assertTrue(probe.exercise(Path('/synthetic/server'), case)['passed'])

    def test_refusal_after_mutation_fails(self):
        with patch.object(probe.subprocess, 'Popen', FakeProcess), patch.object(FakeProcess, 'mutate', True):
            result = probe.exercise(Path('/synthetic/server'), 'db-symlink-empty')
        self.assertFalse(result['passed'])
        self.assertIn('legacy/sentinel', result['changed_paths'])

    def test_unrelated_error_is_not_isolation_evidence(self):
        with patch.object(probe.subprocess, 'Popen', FakeProcess), patch.object(
                FakeProcess, 'communicate', return_value=(b'', b'bind failed')):
            self.assertFalse(probe.exercise(Path('/synthetic/server'), 'db-hardlink')['passed'])

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
