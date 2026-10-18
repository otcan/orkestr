"""Synthetic aggregate-only projection contract and refusal tests."""
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from live_census import _read_transaction
from usage_projection import RUN_STATES, _authorize, run_state_projection


class UsageProjectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'synthetic.sqlite'
        db = sqlite3.connect(self.path)
        db.execute('CREATE TABLE runs (state TEXT, output_json TEXT, id TEXT)')
        db.executemany('INSERT INTO runs VALUES (?, ?, ?)',
                       [(state, 'synthetic-body', 'fake-id') for state in RUN_STATES]
                       + [('private-arbitrary-state', 'synthetic-body', 'fake-id'),
                          (None, None, None)])
        db.commit()
        db.close()

    def test_fixed_buckets_unknown_is_count_only(self):
        report = run_state_projection(self.path)
        self.assertEqual(report['buckets'], {**dict.fromkeys(RUN_STATES, 1), 'unknown': 2})
        for private in ('private-arbitrary-state', 'synthetic-body', 'fake-id'):
            self.assertNotIn(private, repr(report))
        self.assertFalse(report['cross_store_consistency'])

    def test_empty_is_observation_not_unused_workflow(self):
        db = sqlite3.connect(self.path)
        db.execute('DELETE FROM runs'); db.commit(); db.close()
        report = run_state_projection(self.path)
        self.assertEqual(set(report['buckets'].values()), {0})
        self.assertIn('not verified', report['meaning'])

    def test_forbidden_columns_and_functions(self):
        with _read_transaction(self.path, 'jobs') as (db, _):
            db.set_authorizer(_authorize)
            for sql in ('SELECT id FROM runs', 'SELECT output_json FROM runs',
                        'SELECT count(id) FROM runs', 'SELECT hex(state) FROM runs',
                        'SELECT * FROM sqlite_master', 'DELETE FROM runs',
                        "ATTACH ':memory:' AS x", 'PRAGMA table_list'):
                with self.subTest(sql=sql), self.assertRaises(sqlite3.DatabaseError):
                    db.execute(sql).fetchall()

    def test_missing_or_view_never_counted(self):
        db = sqlite3.connect(self.path)
        db.execute('DROP TABLE runs'); db.execute('CREATE VIEW runs AS SELECT 1 AS state')
        db.commit(); db.close()
        self.assertEqual(run_state_projection(self.path)['status'], 'unavailable')

    def test_nocase_state_stays_exact(self):
        db = sqlite3.connect(self.path)
        db.executescript("DROP TABLE runs; CREATE TABLE runs (state TEXT COLLATE NOCASE);"
                         "INSERT INTO runs VALUES ('RUNNING'), ('running');")
        db.close()
        report = run_state_projection(self.path)
        self.assertEqual(report['buckets']['running'],1)
        self.assertEqual(report['buckets']['unknown'],1)

    def test_missing_state_column_fails(self):
        db = sqlite3.connect(self.path)
        db.execute('ALTER TABLE runs RENAME COLUMN state TO unexpected')
        db.close()
        with self.assertRaises(sqlite3.DatabaseError):
            run_state_projection(self.path)
