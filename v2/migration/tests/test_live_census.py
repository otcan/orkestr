"""Only temporary synthetic SQLite stores, including a concurrent WAL writer."""
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import live_census as census


class LiveCensusTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'state.sqlite'
        self.writer = sqlite3.connect(self.path)
        self.addCleanup(self.writer.close)
        self.writer.execute('PRAGMA journal_mode=WAL')
        self.writer.executescript('CREATE TABLE jobs (private TEXT);'
                                 'CREATE TABLE runs (private TEXT);'
                                 "INSERT INTO jobs VALUES ('synthetic-private');"
                                 "INSERT INTO runs VALUES ('synthetic-private');")

    def test_concurrent_commit_cannot_mix_counts(self):
        original = census._count_table
        committed = []
        def count(db, table):
            value = original(db, table)
            if not committed:
                self.writer.executescript("BEGIN; INSERT INTO jobs VALUES ('new');"
                                          "INSERT INTO runs VALUES ('new'); COMMIT;")
                committed.append(True)
            return value
        with patch.object(census, '_count_table', side_effect=count):
            report = census.count_live(self.path, family='jobs')
        self.assertEqual(report['counts']['jobs']['count'], 1)
        self.assertEqual(report['counts']['runs']['count'], 1)
        self.assertEqual(census.count_live(self.path, family='jobs')['counts']['runs']['count'], 2)
        self.assertNotIn('synthetic-private', repr(report))
        self.assertFalse(report['cross_store_consistency'])

    def test_authorizer_denies_columns_writes_attach_and_unlisted_tables(self):
        with census._read_transaction(self.path, 'jobs') as (db, _):
            for sql in ('SELECT private FROM jobs', 'SELECT count(private) FROM jobs',
                        'SELECT * FROM sqlite_master', 'DELETE FROM jobs',
                        "ATTACH ':memory:' AS extra", 'PRAGMA query_only=OFF',
                        'CREATE TABLE bad (x)', 'SELECT load_extension(NULL)'):
                with self.subTest(sql=sql), self.assertRaises(sqlite3.DatabaseError):
                    db.execute(sql).fetchall()
            self.assertEqual(census._count_table(db, 'jobs'), 1)

    def test_views_and_virtual_tables_are_not_counted(self):
        self.writer.execute('CREATE VIEW approvals AS SELECT private FROM runs')
        self.writer.execute('CREATE VIRTUAL TABLE notifications USING fts5(private)')
        self.writer.commit()
        report = census.count_live(self.path, family='jobs')
        for table in ('approvals', 'notifications'):
            self.assertEqual(report['counts'][table], {'status': 'unsupported', 'count': None})
        self.assertEqual(report['counts']['effects'], {'status': 'absent', 'count': None})

    def test_missing_invalid_family_and_symlink_refused(self):
        link = self.path.parent / 'link.sqlite'
        link.symlink_to(self.path)
        for path, family in ((link, 'jobs'), (self.path.parent / 'missing', 'jobs'),
                             (self.path, 'credentials')):
            with self.subTest(family=family), self.assertRaises(ValueError):
                census.count_live(path, family=family)
        self.assertFalse((self.path.parent / 'missing').exists())

    def test_uri_characters_remain_path(self):
        special = self.path.parent / 'question?#.sqlite'
        db = sqlite3.connect(special)
        db.execute('CREATE TABLE orkestr_threads (private TEXT)')
        db.close()
        self.assertEqual(census.count_live(special, family='threads')['counts']
                         ['orkestr_threads']['count'], 0)

    def test_failed_count_closes_transaction(self):
        with patch.object(census, '_count_table', side_effect=RuntimeError('synthetic')):
            with self.assertRaises(RuntimeError):
                census.count_live(self.path, family='jobs')
        self.writer.execute('INSERT INTO jobs VALUES (NULL)')
        self.writer.commit()
        self.assertEqual(census.count_live(self.path, family='jobs')['counts']['jobs']['count'], 2)

    def test_mode_ro_remains_readonly_without_other_guards(self):
        with census._read_transaction(self.path, 'jobs') as (db, _):
            db.set_authorizer(None)
            db.execute('PRAGMA query_only=OFF')
            with self.assertRaises(sqlite3.OperationalError):
                db.execute("INSERT INTO jobs VALUES ('forbidden')")

    def test_corrupt_file_fails_without_partial_report(self):
        bad = self.path.parent / 'bad.sqlite'
        bad.write_bytes(b'not a sqlite database')
        with self.assertRaises(sqlite3.DatabaseError):
            census.count_live(bad, family='jobs')

    def test_parent_symlink_refused(self):
        alias = self.path.parent / 'alias'
        alias.symlink_to(self.path.parent, target_is_directory=True)
        with self.assertRaises(ValueError):
            census.count_live(alias / self.path.name, family='jobs')
