"""Pinned SQL rehearsal, never a substitute for a matching packaged executable."""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest
from test_schema31_contract import history, insert

PINS = json.loads(Path(__file__).with_name('schema39-fingerprints.json').read_text())
SOURCE = Path(os.environ.get('ORKESTR_V2_MIGRATIONS_DIR', '/nonexistent-source'))


@unittest.skipUnless((SOURCE/'0039_automatic_reply.sql').is_file(), 'exact schema39 SQL not supplied')
class Schema39ContractTests(unittest.TestCase):
    def sources(self):
        paths = sorted(SOURCE.glob('*.sql'))
        self.assertEqual([p.name for p in paths], [r['file'] for r in PINS['migrations']])
        for path, record in zip(paths, PINS['migrations']):
            data = path.read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(), record['sha256'])
            self.assertEqual(hashlib.sha384(data).hexdigest(), record['sqlx_sha384'])
        return paths

    def fixture(self, path):
        paths = self.sources()
        with closing(sqlite3.connect(path)) as db:
            db.execute('PRAGMA foreign_keys=ON')
            for sql in paths[:38]: db.executescript(sql.read_text())
            history(db)
            insert(db, 'attachment_manifests', id='attachment-fixture', owner_id='owner-fixture',
                   conversation_id='conversation-fixture', manifest_json='{"synthetic":true}')
            insert(db, 'attachment_objects', reference_id='reference-fixture',
                   manifest_id='attachment-fixture', bytes=b'public synthetic bytes')
            db.commit()
        return paths

    def test_copy_upgrade_reopen_preserves_attachment_bytes_and_no_routes(self):
        with tempfile.TemporaryDirectory() as raw:
            source=Path(raw)/'original.sqlite3'; target=Path(raw)/'candidate.sqlite3'
            paths=self.fixture(source); before=hashlib.sha256(source.read_bytes()).hexdigest()
            shutil.copyfile(source,target)
            with closing(sqlite3.connect(target)) as db:
                tables=[r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
                prior={t:db.execute('SELECT * FROM "'+t+'"').fetchall() for t in tables}
                db.executescript('BEGIN IMMEDIATE;'+paths[38].read_text()+';COMMIT;')
                for table,rows in prior.items():
                    self.assertEqual(db.execute('SELECT * FROM "'+table+'"').fetchall(),rows)
            with closing(sqlite3.connect(target)) as db:
                self.assertEqual(db.execute('PRAGMA integrity_check').fetchall(),[('ok',)])
                self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(),[])
                for name in ('routes','permissions','inputs','sends'):
                    self.assertEqual(db.execute('SELECT count(*) FROM automatic_reply_'+name).fetchone()[0],0)
            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(),before)

    def test_failed_copy_migration_rollback_retains_original(self):
        with tempfile.TemporaryDirectory() as raw:
            source=Path(raw)/'original.sqlite3'; target=Path(raw)/'candidate.sqlite3'
            paths=self.fixture(source); before=hashlib.sha256(source.read_bytes()).hexdigest()
            shutil.copyfile(source,target)
            with closing(sqlite3.connect(target)) as db:
                prior=db.execute('SELECT name,sql FROM sqlite_master ORDER BY name').fetchall()
                def refuse(action, name, *unused):
                    return sqlite3.SQLITE_DENY if action==sqlite3.SQLITE_CREATE_TABLE and name=='automatic_reply_inputs' else sqlite3.SQLITE_OK
                db.set_authorizer(refuse)
                with self.assertRaises(sqlite3.DatabaseError):
                    db.executescript('BEGIN IMMEDIATE;'+paths[38].read_text()+';COMMIT;')
                db.set_authorizer(None);db.rollback()
                self.assertEqual(db.execute('SELECT name,sql FROM sqlite_master ORDER BY name').fetchall(),prior)
                self.assertEqual(db.execute('PRAGMA integrity_check').fetchall(),[('ok',)])
            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(),before)
