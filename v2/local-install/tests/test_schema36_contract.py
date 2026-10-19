"""Actual immutable budget SQL on disposable fixtures; no runtime activation."""
import sqlite3
from contextlib import closing
import hashlib
import shutil
import tempfile
import unittest
from pathlib import Path
import test_schema33_contract as previous
from test_schema31_contract import history, tasks, insert


@unittest.skipUnless((previous.SOURCES/'0036_worker_owner_execution_budget.sql').is_file(),'exact schema36 SQL not supplied')
class Schema36ContractTests(previous.Schema33ContractTests):
    pins=previous.PINS.with_name('schema36-fingerprints.json')

    def test_populated31_and33_history_to36_without_new_budgets(self):
        paths=self.sources()
        for predecessor in (31,33):
            with self.subTest(predecessor=predecessor),tempfile.TemporaryDirectory() as raw:
                path=Path(raw)/'core.sqlite3'
                with closing(sqlite3.connect(path)) as db:
                    db.execute('PRAGMA foreign_keys=ON')
                    for sql in paths[:30]:db.executescript(sql.read_text())
                    history(db);tasks(db)
                    for sql in paths[30:predecessor]:db.executescript(sql.read_text())
                    rows=db.execute('SELECT id,state,claim_hash,delegation_id FROM worker_tasks ORDER BY id').fetchall()
                    for sql in paths[predecessor:]:db.executescript(sql.read_text())
                    self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(),[])
                with closing(sqlite3.connect(path)) as db:
                    self.assertEqual(db.execute('PRAGMA integrity_check').fetchall(),[('ok',)])
                    self.assertEqual(db.execute('SELECT id,state,claim_hash,delegation_id FROM worker_tasks ORDER BY id').fetchall(),rows)
                    self.assertEqual(db.execute('SELECT count(*) FROM worker_tasks WHERE execution_budget_ms IS NOT NULL').fetchone()[0],0)
                    self.assertEqual(db.execute('SELECT count(*) FROM worker_running_budgets').fetchone()[0],0)

    def test_schema35_expired_budget_copy_to36_and_constraints(self):
        paths=self.sources()
        with tempfile.TemporaryDirectory() as raw:
            path=Path(raw)/'core.sqlite3'
            with closing(sqlite3.connect(path)) as db:
                db.execute('PRAGMA foreign_keys=ON')
                for sql in paths[:30]:db.executescript(sql.read_text())
                history(db);tasks(db)
                for sql in paths[30:35]:db.executescript(sql.read_text())
                self.assertEqual(db.execute('SELECT count(*) FROM worker_running_budgets').fetchone()[0],0)
                # Historical, expired budget attached to a blocked run. No grant issued.
                insert(db,'worker_running_budgets',run_id='run-fixture',task_id='task-delegated',max_run_ms=1000,anchor_ms=1,deadline_ms=1001,original_delegation_deadline_ms=2)
                before=db.execute('SELECT * FROM worker_running_budgets').fetchall()
                db.executescript(paths[35].read_text())
                self.assertEqual(db.execute('SELECT * FROM worker_running_budgets').fetchall(),before)
                self.assertEqual(db.execute('SELECT count(*) FROM worker_tasks WHERE execution_budget_ms IS NOT NULL').fetchone()[0],0)
                self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(),[])
                for value in (0,-1,3600001):
                    with self.subTest(budget=value),self.assertRaises(sqlite3.IntegrityError):
                        db.execute('UPDATE worker_tasks SET execution_budget_ms=? WHERE id=?',(value,'task-held'))
                for deadline in (1,1002):
                    with self.subTest(deadline=deadline),self.assertRaises(sqlite3.IntegrityError):
                        db.execute('UPDATE worker_running_budgets SET deadline_ms=?',(deadline,))
                db.execute('UPDATE worker_running_budgets SET deadline_ms=500')
                self.assertEqual(db.execute('SELECT deadline_ms FROM worker_running_budgets').fetchone()[0],500)
            with closing(sqlite3.connect(path)) as db:
                self.assertEqual(db.execute('PRAGMA integrity_check').fetchall(),[('ok',)])
                self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(),[])
                self.assertEqual(db.execute('SELECT state,dispatch_state FROM production_runs').fetchall(),[('blocked','quarantined')])

    def test_failed_copy_migration_rolls_back_and_preserves_stopped_source(self):
        paths=self.sources()
        with tempfile.TemporaryDirectory() as raw:
            original=Path(raw)/'original.sqlite3';copy=Path(raw)/'copy.sqlite3'
            with closing(sqlite3.connect(original)) as db:
                for sql in paths[:30]:db.executescript(sql.read_text())
                history(db);tasks(db)
                for sql in paths[30:35]:db.executescript(sql.read_text())
                insert(db,'worker_running_budgets',run_id='run-fixture',task_id='task-delegated',max_run_ms=1000,anchor_ms=1,deadline_ms=1001,original_delegation_deadline_ms=2)
                db.commit()
                schema=db.execute("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").fetchall()
                budget=db.execute('SELECT * FROM worker_running_budgets').fetchall()
            # Both connections are closed: this copies a disposable stopped SQLite
            # fixture, never a live database or the product backup protocol.
            before=hashlib.sha256(original.read_bytes()).hexdigest()
            shutil.copyfile(original,copy)
            with closing(sqlite3.connect(copy)) as db:
                db.execute('PRAGMA foreign_keys=ON')
                def refuse_budget_copy(action,table,*unused):
                    return sqlite3.SQLITE_DENY if action==sqlite3.SQLITE_INSERT and table=='worker_running_budgets' else sqlite3.SQLITE_OK
                db.set_authorizer(refuse_budget_copy)
                with self.assertRaises(sqlite3.DatabaseError):
                    db.executescript('BEGIN IMMEDIATE;'+paths[35].read_text()+';COMMIT;')
                db.set_authorizer(None);db.rollback()
                self.assertEqual(db.execute("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").fetchall(),schema)
                self.assertEqual(db.execute('SELECT * FROM worker_running_budgets').fetchall(),budget)
                self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(),[])
            self.assertEqual(hashlib.sha256(original.read_bytes()).hexdigest(),before)
            with closing(sqlite3.connect(original)) as db:
                self.assertEqual(db.execute('PRAGMA integrity_check').fetchall(),[('ok',)])
                self.assertEqual(db.execute('SELECT * FROM worker_running_budgets').fetchall(),budget)
