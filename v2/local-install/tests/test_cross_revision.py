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

    def test_supported_edges(self):
        for edge in ((14,15),(14,17),(14,20),(17,20),(14,24),(17,24)):
            self.assertEqual(cross_revision.migration_edge(*edge),edge)

    def test_unsupported_edges_refused_before_artifact_access(self):
        from types import SimpleNamespace
        for edge in ((20,17),(17,17),(17,21),(15,20),(True,20)):
            with self.assertRaisesRegex(RuntimeError,'unsupported migration edge'):
                cross_revision.exercise(SimpleNamespace(old_schema=edge[0],new_schema=edge[1]))

    def test_schema17_and20_inventory(self):
        for count in (17,20,24):
            with tempfile.TemporaryDirectory() as raw:
                home=Path(raw);(home/'data').mkdir()
                with sqlite3.connect(home/'data/core.sqlite3') as db:
                    db.execute('CREATE TABLE _sqlx_migrations(version INTEGER,success INTEGER)')
                    db.executemany('INSERT INTO _sqlx_migrations VALUES (?,1)',[(i,) for i in range(1,count+1)])
                self.assertEqual(cross_revision.versions(home),list(range(1,count+1)))

    def test_original_package_source_is_checked_without_repackaging(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        args=SimpleNamespace(old_package='/synthetic-package',old_source='a'*40)
        with patch.object(cross_revision.builder,'package',return_value=(Path('/synthetic-package'),{'source_commit':'b'*40})), patch.object(cross_revision.builder,'assemble',side_effect=AssertionError('must not repackage')):
            with self.assertRaisesRegex(RuntimeError,'source/binary mismatch'):
                cross_revision.selected_package(args,'old',Path('/binary'),Path('/output'),17)
