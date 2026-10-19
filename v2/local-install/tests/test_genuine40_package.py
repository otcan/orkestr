from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest

from genuine40_package import compare_upgrade, verify_baseline


class Genuine40Checks(unittest.TestCase):
    def setUp(self):
        self.scratch=tempfile.TemporaryDirectory();self.addCleanup(self.scratch.cleanup)
        self.root=Path(self.scratch.name);self.old=self.root/'old.sqlite3';self.new=self.root/'new.sqlite3'
        self.checksums={str(v):bytes([v])*48 for v in range(1,42)}
        with sqlite3.connect(self.old) as db:
            db.executescript('CREATE TABLE _sqlx_migrations(version INTEGER PRIMARY KEY, checksum BLOB, success INTEGER); CREATE TABLE history(id INTEGER PRIMARY KEY, unknown BLOB); INSERT INTO history VALUES(1,X\'0123\');')
            db.executemany('INSERT INTO _sqlx_migrations VALUES(?,?,1)',[(v,self.checksums[str(v)]) for v in range(1,41)])
        self.checksums={v:b.hex() for v,b in self.checksums.items()}
        shutil.copyfile(self.old,self.new)
        with sqlite3.connect(self.new) as db:
            db.executescript('CREATE TABLE memory_settings(owner_id TEXT PRIMARY KEY,enabled INTEGER); CREATE TABLE memory_records(id TEXT PRIMARY KEY,owner_id TEXT); CREATE INDEX memory_records_owner ON memory_records(owner_id); CREATE TABLE memory_decisions(owner_id TEXT,request_key TEXT,PRIMARY KEY(owner_id,request_key));')
            db.execute('INSERT INTO _sqlx_migrations VALUES(41,?,1)',(bytes.fromhex(self.checksums['41']),))

    def test_prior_rows_and_exact_prefix_preserved_empty_memory(self):
        verify_baseline(self.old,self.checksums)
        self.assertTrue(compare_upgrade(self.old,self.new,self.checksums)['old_rows_columns_schema_preserved'])

    def test_preexisting_memory_refused_before_execution(self):
        with self.assertRaisesRegex(RuntimeError,'predate Memory'):
            verify_baseline(self.new,self.checksums)

    def test_history_mutation_refused(self):
        with sqlite3.connect(self.new) as db:db.execute('UPDATE history SET unknown=X\'FFFF\'')
        with self.assertRaisesRegex(RuntimeError,'prior table'):
            compare_upgrade(self.old,self.new,self.checksums)

    def test_memory_backfill_refused(self):
        with sqlite3.connect(self.new) as db:db.execute("INSERT INTO memory_settings VALUES('synthetic',1)")
        with self.assertRaisesRegex(RuntimeError,'empty/default off'):
            compare_upgrade(self.old,self.new,self.checksums)

    def test_old_sqlx_mutation_refused(self):
        with sqlite3.connect(self.new) as db:db.execute('UPDATE _sqlx_migrations SET checksum=X\'00\' WHERE version=1')
        with self.assertRaisesRegex(RuntimeError,'SQLx rows'):
            compare_upgrade(self.old,self.new,self.checksums)

    def test_unexpected_ddl_refused(self):
        with sqlite3.connect(self.new) as db:db.execute('CREATE INDEX extra_history ON history(unknown)')
        with self.assertRaisesRegex(RuntimeError,'schema changes'):
            compare_upgrade(self.old,self.new,self.checksums)
