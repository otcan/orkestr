"""Synthetic primary-thread metadata: no deployment rows or identifiers."""
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import thread_projection as projection
from live_census import _read_transaction


class ThreadProjectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'threads.sqlite'
        self.writer = sqlite3.connect(self.path)
        self.addCleanup(self.writer.close)
        self.writer.execute('PRAGMA journal_mode=WAL')
        self.writer.execute('CREATE TABLE orkestr_threads (data, id TEXT, name TEXT)')
        self.writer.commit()

    def insert(self, *values):
        self.writer.executemany('INSERT INTO orkestr_threads(data) VALUES (?)', [(v,) for v in values])
        self.writer.commit()

    def report(self):
        return projection.thread_metadata_projection(self.path)

    def test_structural_flags_and_fixed_enums(self):
        self.insert(json.dumps({'threadKind':'worker','parentThreadId':'fake-parent',
            'runtimeKind':'codex-app-server', 'executor':{'type':'codex'},
            'lifecycleState':'active', 'state':'sleeping','retired':False,
            'binding':{'chatId':'fake-private-chat'}, 'browserSlug':'fake-browser',
            'prompt':'synthetic-private-body'}))
        report = self.report()
        b = report['buckets']
        for field, bucket in (('role','worker'), ('parent_reference','present'),
                ('runtime_top','codex-app-server'), ('binding_object','present'),
                ('browser_reference','present'), ('retired_marker','false')):
            self.assertEqual(b[field][bucket], 1)
        for text in ('fake-parent','fake-private-chat','fake-browser','synthetic-private-body'):
            self.assertNotIn(text, repr(report))

    def test_malformed_nonobject_and_storage_are_explicit(self):
        self.insert('{broken', '[]', 'null', '"text"', None, b'{}', 42, '{}')
        b = self.report()['buckets']
        self.assertEqual(b['quality'], {'object':1, 'malformed_json':1,
                                      'non_object':3, 'unsupported_storage':3})
        for buckets in b.values():
            self.assertEqual(sum(buckets.values()), 8)

    def test_unsupported_unknown_missing_and_empty(self):
        self.insert(json.dumps({'threadKind':3,'parentThreadId':{},'retired':'true',
                               'binding':[], 'runtimeKind':'private-runtime'}),
                    json.dumps({'threadKind':'','parentThreadId':'  '}), '{}')
        b = self.report()['buckets']
        self.assertEqual(b['role']['unsupported'],1)
        self.assertEqual(b['role']['empty'],1)
        self.assertEqual(b['role']['missing'],1)
        self.assertEqual(b['runtime_top']['unknown'],1)
        self.assertEqual(b['parent_reference']['unsupported'],1)
        self.assertEqual(b['retired_marker']['unsupported'],1)
        self.assertEqual(b['binding_object']['unsupported'],1)
        self.assertNotIn('private-runtime', repr(b))

    def test_conflicting_markers_are_not_inferred_or_collapsed(self):
        self.insert(json.dumps({'runtimeKind':'codex-tmux',
            'runtime':{'runtimeKind':'claude-code'},'lifecycleState':'active','retired':True}))
        b = self.report()['buckets']
        self.assertEqual(b['runtime_top']['codex-tmux'],1)
        self.assertEqual(b['runtime_nested']['claude-code'],1)
        self.assertEqual(b['lifecycle']['active'],1)
        self.assertEqual(b['retired_marker']['true'],1)

    def test_authorizer_denies_other_columns_tables_functions_and_writes(self):
        with _read_transaction(self.path, 'threads') as (db, _):
            db.set_authorizer(projection._authorize)
            for sql in ('SELECT id FROM orkestr_threads','SELECT name FROM orkestr_threads',
                        'SELECT * FROM sqlite_master','SELECT hex(data) FROM orkestr_threads',
                        'DELETE FROM orkestr_threads', "ATTACH ':memory:' AS x", 'PRAGMA table_list'):
                with self.subTest(sql=sql), self.assertRaises(sqlite3.DatabaseError):
                    db.execute(sql).fetchall()

    def test_empty_and_view_do_not_claim_unused(self):
        self.assertTrue(all(n==0 for b in self.report()['buckets'].values() for n in b.values()))
        self.writer.executescript('DROP TABLE orkestr_threads; CREATE VIEW orkestr_threads AS SELECT 1 AS data;')
        self.assertEqual(self.report()['status'], 'unavailable')

    def test_pinned_read_hides_concurrent_writer(self):
        self.insert('{}')
        original = projection._authorize
        once = []
        def authorize(*args):
            if not once:
                self.insert('{}'); once.append(True)
            return original(*args)
        with patch.object(projection, '_authorize', side_effect=authorize):
            self.assertEqual(self.report()['buckets']['quality']['object'],1)
        self.assertEqual(self.report()['buckets']['quality']['object'],2)

    def test_wrong_nested_container_is_unsupported(self):
        self.insert(json.dumps({'executor':[], 'runtime':'private-shape'}))
        b = self.report()['buckets']
        for name in ('executor_type','runtime_nested','runtime_metadata'):
            self.assertEqual(b[name]['unsupported'],1)

    def test_each_field_is_exhaustive_and_role_is_not_parent_inference(self):
        self.insert(json.dumps({'threadKind':'task-agent'}),
                    json.dumps({'parentThreadId':'fake-parent'}), '{}')
        b = self.report()['buckets']
        for field in b.values():
            self.assertEqual(sum(field.values()),3)
        self.assertEqual(b['role']['task-agent'],1)
        self.assertEqual(b['role']['missing'],2)
        self.assertEqual(b['parent_reference']['present'],1)

    def test_missing_data_column_fails(self):
        self.writer.execute('ALTER TABLE orkestr_threads RENAME COLUMN data TO unexpected')
        self.writer.commit()
        with self.assertRaises(sqlite3.DatabaseError):
            self.report()

    def test_nocase_data_does_not_fold_enum_values(self):
        self.writer.executescript('DROP TABLE orkestr_threads;'
            'CREATE TABLE orkestr_threads (data TEXT COLLATE NOCASE);')
        self.insert(json.dumps({'threadKind':'WORKER'}), json.dumps({'threadKind':'worker'}))
        buckets = self.report()['buckets']['role']
        self.assertEqual(buckets['worker'],1)
        self.assertEqual(buckets['unknown'],1)
