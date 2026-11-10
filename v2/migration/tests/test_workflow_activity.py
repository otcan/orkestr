import json
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
import tempfile
import unittest
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from workflow_activity import database_projection, project_registry, read_registry

NOW = datetime(2026, 1, 2, tzinfo=timezone.utc)


class ActivityTests(unittest.TestCase):
    def test_message_counts_no_bodies_identifiers_or_unknown_columns(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'state.sqlite'
            db = sqlite3.connect(path)
            db.execute('CREATE TABLE orkestr_thread_messages(data TEXT, role TEXT COLLATE NOCASE, connector TEXT COLLATE NOCASE, created_at TEXT, secret TEXT)')
            for connector in ('whatsapp', 'WHATSAPP'):
                db.execute('INSERT INTO orkestr_thread_messages VALUES(?,?,?,?,?)', (json.dumps({'text': 'PRIVATE_MARKER', 'attachments': [{'id': 'PRIVATE_ID'}]}), 'user', connector, '2026-01-01T12:00:00Z', 'SECRET_MARKER'))
            db.execute("INSERT INTO orkestr_thread_messages VALUES('bad JSON', 'assistant', NULL, NULL, 'SECRET')")
            db.execute('INSERT INTO orkestr_thread_messages VALUES(?,?,?,?,?)', (json.dumps({'attachments':'PRIVATE_NOT_JSON'}), 'assistant', None, None, None))
            db.commit(); db.close()
            result = database_projection(path, 'messages', NOW)
            self.assertEqual(result['counts']['whatsapp'], 1)
            self.assertEqual(result['counts']['recent_24h'], 2)
            self.assertEqual(result['counts']['has_attachments'], 2)
            self.assertNotIn('PRIVATE', json.dumps(result))
            self.assertNotIn('SECRET', json.dumps(result))

    def test_thread_flags_and_missing_column_refusal(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'state.sqlite'
            db = sqlite3.connect(path)
            db.execute('CREATE TABLE orkestr_threads(data TEXT)')
            db.execute('INSERT INTO orkestr_threads VALUES(?)', (json.dumps({'binding': {'enabled': False, 'mirrorReplies': False}, 'repoPath': 'PRIVATE_PATH', 'updatedAt': '2026-01-01T23:00:00Z'}),))
            db.commit(); db.close()
            result = database_projection(path, 'threads', NOW)
            self.assertEqual(result['counts']['binding_disabled'], 1)
            self.assertEqual(result['counts']['local_repo_reference'], 1)
            self.assertNotIn('PRIVATE', json.dumps(result))
            db = sqlite3.connect(path)
            db.execute('ALTER TABLE orkestr_threads RENAME COLUMN data TO unrelated');db.close()
            with self.assertRaises(sqlite3.DatabaseError):
                database_projection(path, 'threads', NOW)

    def test_views_refuse_and_missing_is_unresolved(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'state.sqlite'
            db = sqlite3.connect(path);db.execute("CREATE VIEW orkestr_threads AS SELECT 'body' AS data");db.close()
            self.assertIn('unavailable', database_projection(path, 'threads', NOW)['status'])

    def test_registry_fixed_timestamps_not_raw_values(self):
        result = project_registry([{'lastRunAt': '2026-01-01T23:00:00Z', 'prompt': 'PRIVATE', 'nextRunAt': '2026-01-03T00:00:00Z'}, {'lastRunAt': 'bad'}, None], 'timers', NOW)
        self.assertEqual(result['counts']['lastRunAt']['within_24h'], 1)
        self.assertEqual(result['counts']['lastRunAt']['invalid'], 1)
        self.assertEqual(result['counts']['nextRunAt']['future'], 1)
        self.assertNotIn('PRIVATE', json.dumps(result))
        self.assertEqual(project_registry({'desktopLeases': []}, 'desktop', NOW)['counts']['rows'], 0)
        with self.assertRaises(ValueError):project_registry({}, 'runtime', NOW)

    def test_registry_symlink_and_duplicate_refuse(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home/'timers.json').write_text('[{"lastRunAt":null,"lastRunAt":null}]')
            with self.assertRaises(ValueError):read_registry(home, 'timers', NOW)
            (home/'timers.json').unlink();(home/'target').write_text('[]');(home/'timers.json').symlink_to(home/'target')
            with self.assertRaises(OSError):read_registry(home, 'timers', NOW)

    def test_message_projection_is_bounded_prefix_not_latest_claim(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'state.sqlite'
            db = sqlite3.connect(path)
            db.execute('CREATE TABLE orkestr_thread_messages(data TEXT, role TEXT, connector TEXT, created_at TEXT)')
            db.executemany('INSERT INTO orkestr_thread_messages VALUES(?,?,?,?)', [('{}', 'assistant', None, None)]*10000)
            db.execute("INSERT INTO orkestr_thread_messages VALUES('{}','user','whatsapp','2026-01-01T23:00:00Z')")
            db.commit(); db.close()
            result = database_projection(path, 'messages', NOW)
            self.assertEqual(result['rows'], 10000)
            self.assertEqual(result['counts']['whatsapp'], 0)
            self.assertIn('not_latest', result['coverage'])
