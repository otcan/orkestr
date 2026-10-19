"""Upgrade inventory must read committed WAL, even after managed server exit."""
from pathlib import Path
import sqlite3
import tempfile
import unittest
import cross_revision


class UpgradeInventoryTests(unittest.TestCase):
    def test_uncheckpointed_migrations_are_included(self):
        with tempfile.TemporaryDirectory(prefix='v2-upgrade-wal-') as raw:
            home = Path(raw)
            (home/'data').mkdir()
            database = sqlite3.connect(home/'data/core.sqlite3')
            try:
                database.execute('PRAGMA journal_mode=WAL')
                database.execute('PRAGMA wal_autocheckpoint=0')
                database.execute('CREATE TABLE _sqlx_migrations(version INTEGER,success INTEGER)')
                database.executemany('INSERT INTO _sqlx_migrations VALUES (?,1)',
                                     [(i,) for i in range(1,16)])
                database.commit()
                self.assertGreater((home/'data/core.sqlite3-wal').stat().st_size, 0)
                self.assertEqual(cross_revision.versions(home), list(range(1,16)))
            finally:
                database.close()
