"""Optional actual SQL-source smoke; not SQLx or a real binary upgrade receipt."""
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

DEFAULT=Path(__file__).resolve().parents[2]/'crates/store-sqlite/migrations'
MIGRATIONS=Path(os.environ.get('ORKESTR_V2_MIGRATIONS_DIR',str(DEFAULT)))


@unittest.skipUnless((MIGRATIONS/'0024_run_control_revision.sql').is_file(),'schema24 source not supplied')
class Schema24ContractTests(unittest.TestCase):
    def test_populated_history_17_to24_sql_reopen(self):
        self.exercise(24)

    @unittest.skipUnless((MIGRATIONS/'0028_graceful_supervisor_retirement.sql').is_file(),'schema28 source not supplied')
    def test_populated_history_17_to28_sql_reopen(self):
        self.exercise(28)

    def exercise(self,target):
        files=sorted(MIGRATIONS.glob('*.sql'))
        self.assertEqual([int(p.name.split('_')[0]) for p in files[:target]],list(range(1,target+1)))
        with tempfile.TemporaryDirectory() as raw:
            path=Path(raw)/'synthetic.sqlite3'
            with sqlite3.connect(path) as db:
                db.execute('PRAGMA foreign_keys=ON')
                for source in files[:17]:db.executescript(source.read_text())
                db.execute("INSERT INTO owners(id,username,password_hash) VALUES ('owner-fixture','synthetic','not-a-usable-password')")
                db.execute("INSERT INTO conversations(id,owner_id) VALUES ('conversation-fixture','owner-fixture')")
                db.execute("INSERT INTO messages VALUES ('message-fixture','owner-fixture','conversation-fixture','request-fixture','digest-fixture','synthetic public message','owner',1)")
                before=db.execute('SELECT * FROM messages').fetchall();db.commit()
                for source in files[17:target]:db.executescript(source.read_text())
                self.assertEqual(before,db.execute('SELECT * FROM messages').fetchall())
                self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(),[])
                self.assertIn('request_control_revision',[r[1] for r in db.execute('PRAGMA table_info(production_cancellations)')])
                self.assertIn('terminal_event_id',[r[1] for r in db.execute('PRAGMA table_info(production_resume_metadata)')])
                self.assertEqual(db.execute('SELECT * FROM production_control_revisions').fetchall(),[])
                if target>=28:
                    for table in ('production_stop_boundaries','production_held_inputs','worker_tasks','dormant_timers','production_graceful_retirements'):
                        self.assertEqual(db.execute('SELECT count(*) FROM '+table).fetchone()[0],0)
            with sqlite3.connect(path) as reopened:
                self.assertEqual(reopened.execute('PRAGMA integrity_check').fetchall(),[('ok',)])
                self.assertEqual(before,reopened.execute('SELECT * FROM messages').fetchall())
