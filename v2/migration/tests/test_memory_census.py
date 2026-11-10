"""Source-defined personal memory table count; never content/identity reads."""
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from live_census import count_live, _read_transaction


class MemoryCensusTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'synthetic.sqlite'
        self.db = sqlite3.connect(self.path)
        self.addCleanup(self.db.close)

    def test_count_only_no_content_and_empty_is_not_unused_feature(self):
        self.db.execute('CREATE TABLE personal_agent_memories(content_json TEXT, consented_by TEXT)')
        self.db.execute("INSERT INTO personal_agent_memories VALUES ('synthetic-private-body','fake-owner')")
        self.db.commit()
        report = count_live(self.path, family='personal_memory')
        self.assertEqual(report['counts']['personal_agent_memories'], {'status': 'counted', 'count': 1})
        self.assertNotIn('synthetic-private-body', repr(report))
        with _read_transaction(self.path, 'personal_memory') as (db, _):
            for query in ('SELECT content_json FROM personal_agent_memories',
                          'SELECT count(consented_by) FROM personal_agent_memories',
                          'SELECT count(*) FROM sqlite_master'):
                with self.assertRaises(sqlite3.DatabaseError):
                    db.execute(query).fetchall()

    def test_missing_is_absent_table_not_absent_capability(self):
        report = count_live(self.path, family='personal_memory')
        self.assertEqual(report['counts']['personal_agent_memories'], {'status': 'absent', 'count': None})
        self.assertEqual(report['coverage'], 'partial')

    def test_view_not_evaluated(self):
        self.db.execute('CREATE TABLE private_data(secret TEXT)')
        self.db.execute('CREATE VIEW personal_agent_memories AS SELECT secret FROM private_data')
        self.db.commit()
        report = count_live(self.path, family='personal_memory')
        self.assertEqual(report['counts']['personal_agent_memories'], {'status': 'unsupported', 'count': None})
