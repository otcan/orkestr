"""Synthetic fixed provider/class aggregate positive and refusal controls."""
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import workflow_projection as projection
from live_census import _read_transaction


class WorkflowProjectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'synthetic.sqlite'
        self.db = sqlite3.connect(self.path)
        self.addCleanup(self.db.close)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.executescript('CREATE TABLE attempts (provider TEXT, model TEXT, run_id TEXT);'
                              'CREATE TABLE trigger_audit (trigger_type TEXT, sender TEXT, chat_id TEXT);')
        for _, table, column, values in projection.PROJECTIONS:
            self.db.executemany(f'INSERT INTO {table} ({column}) VALUES (?)',
                                [(v,) for v in (*values, 'synthetic-private-unknown', None)])
        self.db.commit()

    def test_fixed_known_and_unknown_buckets_no_raw_output(self):
        report = projection.workflow_class_projection(self.path)
        for name, _, _, values in projection.PROJECTIONS:
            self.assertEqual(report['reports'][name]['buckets'],
                             {**dict.fromkeys(values, 1), 'unknown': 2})
        self.assertNotIn('synthetic-private-unknown', repr(report))
        self.assertFalse(report['cross_store_consistency'])

    def test_case_variants_are_unknown_not_guessed(self):
        self.db.execute("INSERT INTO attempts (provider) VALUES ('CODEX')")
        self.db.commit()
        report = projection.workflow_class_projection(self.path)
        self.assertEqual(report['reports']['attempt_provider']['buckets']['codex'], 1)
        self.assertEqual(report['reports']['attempt_provider']['buckets']['unknown'], 3)

    def test_missing_view_and_virtual_tables_not_read(self):
        self.db.executescript('DROP TABLE attempts; DROP TABLE trigger_audit;'
                             'CREATE VIEW attempts AS SELECT 1 AS provider;'
                             'CREATE VIRTUAL TABLE trigger_audit USING fts5(trigger_type);')
        report = projection.workflow_class_projection(self.path)
        self.assertTrue(all(r['status'] == 'unavailable' for r in report['reports'].values()))

    def test_empty_is_not_unused_workflow(self):
        self.db.executescript('DELETE FROM attempts; DELETE FROM trigger_audit;')
        report = projection.workflow_class_projection(self.path)
        self.assertEqual(set(report['reports']['attempt_provider']['buckets'].values()), {0})
        self.assertIn('not workflow coverage', report['meaning'])

    def test_authorizer_refuses_sensitive_columns_other_table_and_writes(self):
        with _read_transaction(self.path, 'jobs') as (db, _):
            db.set_authorizer(projection._authorize('attempts', 'provider'))
            for sql in ('SELECT model FROM attempts', 'SELECT run_id FROM attempts',
                        'SELECT sender FROM trigger_audit', 'SELECT chat_id FROM trigger_audit',
                        'SELECT count(*) FROM trigger_audit', 'SELECT * FROM sqlite_master',
                        'SELECT hex(provider) FROM attempts', 'DELETE FROM attempts',
                        "ATTACH ':memory:' AS extra", 'PRAGMA table_list'):
                with self.subTest(sql=sql), self.assertRaises(sqlite3.DatabaseError):
                    db.execute(sql).fetchall()

    def test_two_projections_share_pinned_snapshot(self):
        original = projection._query
        once = []
        def query(*args):
            if not once:
                self.db.executescript("BEGIN; INSERT INTO attempts (provider) VALUES ('codex');"
                                     "INSERT INTO trigger_audit (trigger_type) VALUES ('schedule'); COMMIT;")
                once.append(True)
            return original(*args)
        with patch.object(projection, '_query', side_effect=query):
            report = projection.workflow_class_projection(self.path)
        self.assertEqual(report['reports']['attempt_provider']['buckets']['codex'], 1)
        self.assertEqual(report['reports']['trigger_audit_class']['buckets']['schedule'], 1)
        later = projection.workflow_class_projection(self.path)
        self.assertEqual(later['reports']['attempt_provider']['buckets']['codex'], 2)
