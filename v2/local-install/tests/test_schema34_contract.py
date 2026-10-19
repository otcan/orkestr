"""Exact steering SQL preservation checks; no server or provider execution."""
import sqlite3
import tempfile
import unittest
from pathlib import Path
import test_schema33_contract as previous
from test_schema31_contract import history


@unittest.skipUnless((previous.SOURCES/'0034_production_steering.sql').is_file(),'exact schema34 SQL not supplied')
class Schema34ContractTests(previous.Schema33ContractTests):
    pins=previous.PINS.with_name('schema34-fingerprints.json')

    def test_populated33_to34_does_not_create_steering_authority(self):
        paths=self.sources()
        with tempfile.TemporaryDirectory() as raw:
            path=Path(raw)/'core.sqlite3'
            with sqlite3.connect(path) as db:
                db.execute('PRAGMA foreign_keys=ON')
                for sql in paths[:33]:db.executescript(sql.read_text())
                history(db);db.commit()
                before=db.execute('SELECT * FROM messages').fetchall()
                db.executescript(paths[33].read_text())
                self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(),[])
                self.assertEqual(db.execute('SELECT * FROM messages').fetchall(),before)
            with sqlite3.connect(path) as db:
                self.assertEqual(db.execute('PRAGMA integrity_check').fetchall(),[('ok',)])
                for table in ('production_steering','production_steering_turns','worker_tool_results','durable_timer_authorities'):
                    self.assertEqual(db.execute('SELECT count(*) FROM '+table).fetchone()[0],0)
