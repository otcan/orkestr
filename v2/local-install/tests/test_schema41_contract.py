"""Exact SQL copy-first rehearsal; no binary, Store authority issuance or pair credit."""
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

PINS = json.loads(Path(__file__).with_name('schema41-fingerprints.json').read_text())
SOURCE = Path(os.environ.get('ORKESTR_V2_MIGRATIONS_DIR', '/nonexistent-source'))


def workspace_fixture(db):
    insert(db, 'session_bindings', id='session-fixture', owner_id='owner-fixture',
           conversation_id='conversation-fixture', role='deep', provider_kind='codex',
           provider_namespace='fixture', native_session_id='native-fixture', state='blocked')
    insert(db, 'production_supervisors', context_id='context-fixture', owner_id='owner-fixture',
           provider_kind='codex', namespace='fixture', supervisor_key='fixture',
           incarnation_id='incarnation-fixture', generation=1, lease_deadline_ms=1)
    insert(db, 'workspace_projects', id='workspace-fixture', owner_id='owner-fixture',
           conversation_id='conversation-fixture', generation=2, active=0,
           identity_json='{"synthetic":true,"not_a_path_grant":true}')
    insert(db, 'workspace_session_projects', session_id='session-fixture',
           project_id='workspace-fixture', generation=2, context_id='context-fixture',
           incarnation_id='incarnation-fixture')
    insert(db, 'workspace_launches', id='launch-fixture', project_id='workspace-fixture',
           generation=2, session_id='session-fixture', binding_generation=1,
           context_id='context-fixture', incarnation_id='incarnation-fixture',
           request_key='launch-key', metadata_key='metadata-key', nonce_hash=None,
           callback_attempted=1, state='delivery_unknown')


def rows(db):
    names=[r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    return {name: sorted(db.execute('SELECT * FROM "'+name+'"').fetchall(), key=repr) for name in names}


@unittest.skipUnless((SOURCE/'0041_memory_authority.sql').is_file(), 'exact schema41 SQL not supplied')
class Schema41ContractTests(unittest.TestCase):
    def sources(self):
        paths=sorted(SOURCE.glob('*.sql'))
        self.assertEqual([p.name for p in paths], [r['file'] for r in PINS['migrations']])
        for path, record in zip(paths, PINS['migrations']):
            data=path.read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(), record['sha256'])
            self.assertEqual(hashlib.sha384(data).hexdigest(), record['sqlx_sha384'])
        return paths

    def fixture(self, path, prefix):
        paths=self.sources()
        with closing(sqlite3.connect(path)) as db:
            db.execute('PRAGMA foreign_keys=ON')
            for sql in paths[:prefix]: db.executescript(sql.read_text())
            history(db)
            if prefix==40: workspace_fixture(db)
            db.commit()
        return paths

    def test_nine_supported_copy_upgrades_preserve_history_and_retired_workspace(self):
        for prefix in PINS['supported_prefixes']:
            with self.subTest(prefix=prefix), tempfile.TemporaryDirectory() as raw:
                root=Path(raw);original=root/'original.db';copy=root/'candidate.db';backup=root/'backup.db'
                paths=self.fixture(original,prefix)
                shutil.copyfile(original,backup);shutil.copyfile(original,copy)
                digest=hashlib.sha256(original.read_bytes()).hexdigest()
                with closing(sqlite3.connect(copy)) as db:
                    db.execute('PRAGMA foreign_keys=ON');before=rows(db)
                    db.executescript('BEGIN IMMEDIATE;'+''.join(p.read_text()+'\n' for p in paths[prefix:])+'COMMIT;')
                    after=rows(db)
                    for table, prior in before.items(): self.assertEqual(after[table],prior)
                    for name in ('memory_settings','memory_records','memory_decisions'):
                        self.assertEqual(after[name],[])
                    if prefix<40:
                        for name in ('workspace_projects','workspace_session_projects','workspace_launches'):
                            self.assertEqual(after[name],[])
                with closing(sqlite3.connect(copy)) as db:
                    self.assertEqual(db.execute('PRAGMA integrity_check').fetchall(),[('ok',)])
                    self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(),[])
                    self.assertEqual(rows(db),after)
                self.assertEqual(hashlib.sha256(original.read_bytes()).hexdigest(),digest)
                self.assertEqual(backup.read_bytes(),original.read_bytes())

    def test_failed_memory_migration_rolls_back_copy_only(self):
        with tempfile.TemporaryDirectory() as raw:
            source=Path(raw)/'original.db';copy=Path(raw)/'copy.db'
            paths=self.fixture(source,40);original=source.read_bytes();shutil.copyfile(source,copy)
            with closing(sqlite3.connect(copy)) as db:
                prior=rows(db)
                db.set_authorizer(lambda action,name,*rest: sqlite3.SQLITE_DENY
                                  if action==sqlite3.SQLITE_CREATE_TABLE and name=='memory_records'
                                  else sqlite3.SQLITE_OK)
                with self.assertRaises(sqlite3.DatabaseError):
                    db.executescript('BEGIN IMMEDIATE;'+paths[40].read_text()+'COMMIT;')
                db.set_authorizer(None);db.rollback()
                self.assertEqual(rows(db),prior)
                self.assertNotIn('memory_settings',rows(db))
            self.assertEqual(source.read_bytes(),original)

    def test_dormant_memory_stopped_backup_restore_retains_receipts(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);source=root/'current.db';backup=root/'backup.db';restored=root/'restored.db'
            self.fixture(source,41)
            with closing(sqlite3.connect(source)) as db:
                workspace_fixture(db)
                insert(db,'memory_settings',owner_id='owner-fixture',enabled=0)
                insert(db,'memory_records',id='memory-fixture',owner_id='owner-fixture',project_id=None,
                       revision=2,candidate_json='{"synthetic":"public fixture"}',trust='owner_authored',
                       consented_at_ms=1,updated_at_ms=2)
                insert(db,'memory_decisions',owner_id='owner-fixture',request_key='memory-key',
                       proposal_digest='a'*64,action='correct',memory_id='memory-fixture',revision=2,forgotten=0)
                db.commit();expected=rows(db)
            original=source.read_bytes();shutil.copyfile(source,backup);shutil.copyfile(backup,restored)
            with closing(sqlite3.connect(restored)) as db:
                self.assertEqual(rows(db),expected)
                self.assertEqual(db.execute('PRAGMA integrity_check').fetchall(),[('ok',)])
                self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(),[])
                self.assertEqual(db.execute('SELECT enabled FROM memory_settings').fetchall(),[(0,)])
                self.assertEqual(db.execute('SELECT active FROM workspace_projects').fetchall(),[(0,)])
                self.assertEqual(db.execute('SELECT state FROM workspace_launches').fetchall(),[('delivery_unknown',)])
            self.assertEqual(source.read_bytes(),original)
            self.assertEqual(backup.read_bytes(),original)


if __name__=='__main__': unittest.main()
