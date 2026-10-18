"""Actual Core SQL on populated disposable SQLite; not executable/pair acceptance."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
import upgrade_authority

MIGRATIONS=Path(os.environ.get('ORKESTR_V2_MIGRATIONS_DIR','/nonexistent-source'))


def insert(db, table, **values):
    db.execute('INSERT INTO '+table+' ('+','.join(values)+') VALUES ('+','.join('?' for _ in values)+')',list(values.values()))


def history(db):
    insert(db,'owners',id='owner-fixture',username='synthetic',password_hash='unusable-public-fixture')
    insert(db,'conversations',id='conversation-fixture',owner_id='owner-fixture')
    insert(db,'messages',id='message-fixture',owner_id='owner-fixture',conversation_id='conversation-fixture',request_key='request-fixture',payload_digest='digest-fixture',text='synthetic public message',actor_kind='owner',sequence=1)
    insert(db,'events',id='event-fixture',owner_id='owner-fixture',conversation_id='conversation-fixture',message_id='message-fixture',sequence=1)


def tasks(db):
    insert(db,'session_bindings',id='session-fixture',owner_id='owner-fixture',conversation_id='conversation-fixture',role='deep',provider_kind='codex',provider_namespace='fixture',native_session_id='native-fixture',state='blocked')
    insert(db,'production_supervisors',context_id='context-fixture',owner_id='owner-fixture',provider_kind='codex',namespace='fixture',supervisor_key='fixture',incarnation_id='incarnation-fixture',generation=1,lease_deadline_ms=1)
    insert(db,'production_runs',id='run-fixture',context_id='context-fixture',incarnation_id='incarnation-fixture',owner_id='owner-fixture',conversation_id='conversation-fixture',session_id='session-fixture',native_session_id='native-fixture',provider_kind='codex',binding_generation=1,message_id='message-fixture',event_id='event-fixture',scope_sequence=1,claim_generation=1,request_key='run-request',input_digest='a'*64,lease_generation=1,dispatch_fence=1,lease_deadline_ms=1,attempt=1,state='blocked',dispatch_state='quarantined')
    insert(db,'session_bindings',id='worker-session-fixture',owner_id='owner-fixture',conversation_id='conversation-fixture',role='worker',provider_kind='codex',provider_namespace='fixture',native_session_id='worker-native-fixture',parent_session_id='session-fixture',state='blocked',request_key='worker-request',request_digest='a'*64)
    insert(db,'worker_provider_delegations',id='delegation-fixture',owner_id='owner-fixture',conversation_id='conversation-fixture',parent_run_id='run-fixture',parent_session_id='session-fixture',context_id='context-fixture',incarnation_id='incarnation-fixture',parent_binding_generation=1,parent_lease_generation=1,parent_dispatch_fence=1,parent_deadline_ms=1,worker_session_id='worker-session-fixture',worker_binding_generation=1,source_message_id='message-fixture',source_event_id='event-fixture',request_key='delegation-request',input_digest='a'*64,requested_lifetime_ms=1,expires_at_ms=1,state='blocked')
    for state in ('queued','claimed','held','delegated'):
        insert(db,'worker_tasks',id='task-'+state,owner_id='owner-fixture',conversation_id='conversation-fixture',parent_run_id='run-fixture',context_id='context-fixture',incarnation_id='incarnation-fixture',parent_control_revision=1,source_message_id='message-fixture',source_event_id='event-fixture',request_key='request-'+state,request_digest='a'*64,lifetime_ms=1,created_at_ms=1,state=state,claim_hash='b'*64 if state=='claimed' else None,delegation_id='delegation-fixture' if state=='delegated' else None)
        insert(db,'worker_task_payloads',task_id='task-'+state,title='Synthetic task',instructions='Public fixture; never execute')


@unittest.skipUnless((MIGRATIONS/'0031_worker_task_holds.sql').is_file(),'exact schema31 SQL source not supplied')
class Schema31ContractTests(unittest.TestCase):
    def sources(self):
        files=sorted(MIGRATIONS.glob('*.sql'))
        self.assertEqual([int(p.name.split('_')[0]) for p in files],list(range(1,32)))
        self.assertEqual(hashlib.sha256(files[-1].read_bytes()).hexdigest(), 'c16853e32ee01d304bccc47dddeb3d53dbf2c7042378215f4d41b7e686816cec')
        inventory={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
        self.assertEqual(hashlib.sha256(json.dumps(inventory,sort_keys=True,separators=(',',':')).encode()).hexdigest(),
                         '4b7535910df4a0351e6984d26bc0b892a46fa318432e9d6c73ca114683cd180c')
        return files

    def test_populated_historical14_and17_to31_preserve_history_no_authority(self):
        sources=self.sources()
        for predecessor in (14,17):
            with self.subTest(predecessor=predecessor), tempfile.TemporaryDirectory() as raw:
                home=Path(raw);(home/'data').mkdir();path=home/'data/core.sqlite3'
                with sqlite3.connect(path) as db:
                    db.execute('PRAGMA foreign_keys=ON')
                    for source in sources[:predecessor]:db.executescript(source.read_text())
                    history(db);db.commit()
                    before=db.execute('SELECT * FROM messages').fetchall()
                    authority=upgrade_authority.snapshot(home)
                    for source in sources[predecessor:]:db.executescript(source.read_text())
                    self.assertEqual(before,db.execute('SELECT * FROM messages').fetchall())
                    self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(),[])
                result=upgrade_authority.verify(authority,upgrade_authority.snapshot(home))
                self.assertEqual(result['new_execution_authority'],0)
                with sqlite3.connect(path) as reopened:
                    self.assertEqual(reopened.execute('PRAGMA integrity_check').fetchall(),[('ok',)])
                    self.assertEqual(before,reopened.execute('SELECT * FROM messages').fetchall())

    def test_populated30_pending_tasks_are_held_and_receipts_survive_reopen(self):
        sources=self.sources()
        with tempfile.TemporaryDirectory() as raw:
            home=Path(raw);(home/'data').mkdir();path=home/'data/core.sqlite3'
            with sqlite3.connect(path) as db:
                db.execute('PRAGMA foreign_keys=ON')
                for source in sources[:30]:db.executescript(source.read_text())
                history(db);tasks(db);db.commit()
                before=upgrade_authority.snapshot(home)
                payload=db.execute('SELECT * FROM worker_task_payloads ORDER BY task_id').fetchall()
                db.executescript(sources[30].read_text())
                self.assertEqual(db.execute('SELECT state,claim_hash,issuer_token_hash FROM worker_tasks').fetchall(),[('held',None,None)]*3+[('delegated',None,None)])
                self.assertEqual(payload,db.execute('SELECT * FROM worker_task_payloads ORDER BY task_id').fetchall())
                with self.assertRaisesRegex(sqlite3.IntegrityError,'issuer lineage'):
                    db.execute("INSERT INTO worker_tasks SELECT ordinal+10,id||'-new',owner_id,conversation_id,parent_run_id,context_id,incarnation_id,parent_control_revision,source_message_id,source_event_id,request_key||'-new',request_digest,lifetime_ms,created_at_ms,'queued',NULL,NULL,NULL FROM worker_tasks LIMIT 1")
                self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(),[])
            result=upgrade_authority.verify(before,upgrade_authority.snapshot(home))
            self.assertEqual(result['pending_tasks_held'],2)
            with sqlite3.connect(path) as reopened:
                self.assertEqual(reopened.execute('PRAGMA integrity_check').fetchall(),[('ok',)])
                self.assertEqual(reopened.execute("SELECT count(*) FROM worker_tasks WHERE state IN ('queued','claimed')").fetchone()[0],0)
