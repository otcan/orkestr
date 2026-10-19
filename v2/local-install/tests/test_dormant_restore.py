"""Offline synthetic same-package recovery; no executable or provider starts."""
from contextlib import closing
import sqlite3
import unittest
from unittest.mock import patch

import test_install as fixtures
state, recovery, launcher = fixtures.state, fixtures.recovery, fixtures.launcher


class DormantRestoreTests(unittest.TestCase):
    setUp = fixtures.InstallTests.setUp

    def prepare(self):
        state.initialize(self.home, self.package, 48123)
        with closing(sqlite3.connect(self.home / 'data/core.sqlite3')) as db:
            db.execute('CREATE TABLE messages(body TEXT)')
            db.execute("INSERT INTO messages VALUES ('synthetic dormant history')")
            db.commit()
        snapshot = self.root / 'snapshot'
        recovery.backup(self.home, snapshot)
        target = self.root / 'target'
        state.initialize(target, self.package, 48124)
        return snapshot, target

    def test_apply_dormant_blocks_start_and_upgrade_then_rolls_back(self):
        snapshot, target = self.prepare()
        before = {p: (target / p).read_bytes() for p in ('install.json', 'control/bootstrap.token')}
        recovery.restore_apply(target, snapshot)
        with closing(sqlite3.connect(target / 'data/core.sqlite3')) as db:
            self.assertEqual(db.execute('SELECT body FROM messages').fetchall(), [('synthetic dormant history',)])
        with patch.object(launcher, 'start') as start:
            with self.assertRaisesRegex(RuntimeError, 'dormant'):
                launcher.serve(target)
        start.assert_not_called()
        with self.assertRaisesRegex(RuntimeError, 'dormant'):
            state.upgrade(target, self.package)
        recovery.restore_rollback(target)
        self.assertEqual(list((target / 'data').iterdir()), [])
        for p, content in before.items():
            self.assertEqual((target / p).read_bytes(), content)

    def test_changed_database_refuses_rollback(self):
        snapshot, target = self.prepare()
        recovery.restore_apply(target, snapshot)
        with closing(sqlite3.connect(target / 'data/core.sqlite3')) as db:
            db.execute("INSERT INTO messages VALUES ('changed')")
            db.commit()
        with self.assertRaisesRegex(RuntimeError, 'changed'):
            recovery.restore_rollback(target)
        self.assertTrue((target / 'control/restore-dormant.json').exists())

    def test_incomplete_copy_stays_dormant_and_can_rollback(self):
        snapshot, target = self.prepare()
        with patch('shutil.copyfile', side_effect=OSError('synthetic copy failure')):
            with self.assertRaises(OSError):
                recovery.restore_apply(target, snapshot)
        self.assertTrue((target / 'control/restore-dormant.json').exists())
        recovery.restore_rollback(target)
        self.assertEqual(list((target / 'data').iterdir()), [])

    def test_different_release_and_nonempty_target_refused(self):
        snapshot, target = self.prepare()
        current = state.config(target)
        current['release'] = '0' * 64
        with patch.object(recovery, 'config', return_value=current), patch.object(recovery, 'package'):
            with self.assertRaisesRegex(RuntimeError, 'same exact'):
                recovery.restore_apply(target, snapshot)
        (target / 'data/occupied').write_text('synthetic preserve')
        with self.assertRaisesRegex(RuntimeError, 'empty'):
            recovery.restore_apply(target, snapshot)
        self.assertEqual((target / 'data/occupied').read_text(), 'synthetic preserve')
