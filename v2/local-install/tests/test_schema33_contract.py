"""Exact Core SQL in disposable SQLite, not Store/binary qualification."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from test_schema31_contract import history, tasks, insert
import upgrade_authority

SOURCES=Path(os.environ.get('ORKESTR_V2_MIGRATIONS_DIR','/nonexistent-source'))
PINS=Path(__file__).resolve().parents[2]/'packaging/candidate/schema33-fingerprints.json'


@unittest.skipUnless((SOURCES/'0033_durable_timer_authorities.sql').is_file(),'exact schema33 SQL not supplied')
class Schema33ContractTests(unittest.TestCase):
    def sources(self):
        pins=json.loads(PINS.read_text());paths=sorted(SOURCES.glob('*.sql'))
        self.assertEqual([p.name for p in paths],[m['file'] for m in pins['migrations']])
        for path,pin in zip(paths,pins['migrations']):
            data=path.read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(),pin['sha256'])
            self.assertEqual(hashlib.sha384(data).hexdigest(),pin['sqlx_sha384'])
        inventory={m['file']:m['sha256'] for m in pins['migrations']}
        digest=lambda v:hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        self.assertEqual(digest(inventory),pins['inventory_sha256'])
        self.assertEqual(digest(dict(list(inventory.items())[:31])),
                         '4b7535910df4a0351e6984d26bc0b892a46fa318432e9d6c73ca114683cd180c')
        return paths

    def test_populated14_and17_history_to33_reopen_without_authority(self):
        paths=self.sources()
        for predecessor in (14,17):
            with self.subTest(predecessor=predecessor),tempfile.TemporaryDirectory() as raw:
                home=Path(raw);(home/'data').mkdir();path=home/'data/core.sqlite3'
                with sqlite3.connect(path) as db:
                    db.execute('PRAGMA foreign_keys=ON')
                    for sql in paths[:predecessor]:db.executescript(sql.read_text())
                    history(db);db.commit();before=db.execute('SELECT * FROM messages').fetchall()
                    authority=upgrade_authority.snapshot(home)
                    for sql in paths[predecessor:]:db.executescript(sql.read_text())
                    self.assertEqual(db.execute('SELECT * FROM messages').fetchall(),before)
                    self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(),[])
                    for table in ('worker_tool_results','durable_timer_authorities'):
                        self.assertEqual(db.execute('SELECT count(*) FROM '+table).fetchone()[0],0)
                self.assertEqual(upgrade_authority.verify(authority,upgrade_authority.snapshot(home))['new_execution_authority'],0)
                with sqlite3.connect(path) as db:
                    self.assertEqual(db.execute('PRAGMA integrity_check').fetchall(),[('ok',)])
                    self.assertEqual(db.execute('SELECT * FROM messages').fetchall(),before)

    def test_populated31_tasks_and_paused_timer_remain_dormant(self):
        paths=self.sources()
        with tempfile.TemporaryDirectory() as raw:
            home=Path(raw);(home/'data').mkdir();path=home/'data/core.sqlite3'
            with sqlite3.connect(path) as db:
                db.execute('PRAGMA foreign_keys=ON')
                for sql in paths[:30]:db.executescript(sql.read_text())
                history(db);tasks(db)
                insert(db,'dormant_timers',owner_id='owner-fixture',namespace='timer-fixture',source_namespace='synthetic',source_timer_id='timer-source',source_enabled=1,source_digest='a'*64,schedule_json='{}',state='paused',dormant_reason='synthetic import held',revision=1,generation=0)
                db.executescript(paths[30].read_text());db.commit()
                authority=upgrade_authority.snapshot(home)
                timer=db.execute('SELECT * FROM dormant_timers').fetchall()
                payload=db.execute('SELECT * FROM worker_task_payloads ORDER BY task_id').fetchall()
                for sql in paths[31:]:db.executescript(sql.read_text())
                self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(),[])
            self.assertEqual(upgrade_authority.verify(authority,upgrade_authority.snapshot(home))['new_execution_authority'],0)
            with sqlite3.connect(path) as db:
                self.assertEqual(db.execute('PRAGMA integrity_check').fetchall(),[('ok',)])
                self.assertEqual(db.execute('SELECT * FROM dormant_timers').fetchall(),timer)
                self.assertEqual(db.execute('SELECT * FROM worker_task_payloads ORDER BY task_id').fetchall(),payload)
                self.assertEqual(db.execute("SELECT count(*) FROM worker_tasks WHERE state IN ('queued','claimed')").fetchone()[0],0)
                for table in ('worker_tool_results','durable_timer_authorities'):
                    self.assertEqual(db.execute('SELECT count(*) FROM '+table).fetchone()[0],0)
