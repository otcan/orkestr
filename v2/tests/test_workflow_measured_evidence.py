"""Projection-only checks; no Core process, native launch or test input."""
import hashlib
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
import uuid
import workflow_measured_evidence as evidence


class ProjectionTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory();self.root=Path(self.temporary.name)
        self.database=self.root/'core.sqlite3';self.db=sqlite3.connect(self.database)
        self.db.executescript('''
            CREATE TABLE production_runs(id,session_id,native_session_id,provider_kind,role,state,event_id,message_id);
            CREATE TABLE execution_window_inputs(event_id,message_id,window_id);
            CREATE TABLE execution_windows(id,generation);
            CREATE TABLE production_acceptances(run_id,event_id);
        ''')
        self.ids=[str(uuid.uuid4()) for _ in range(8)]
        run,session,native,event,message,window,acceptance,_=self.ids
        self.db.execute("INSERT INTO production_runs VALUES(?,?,?,'codex','deep','succeeded',?,?)",(run,session,native,event,message))
        self.db.execute('INSERT INTO execution_window_inputs VALUES(?,?,?)',(event,message,window))
        self.db.execute('INSERT INTO execution_windows VALUES(?,1)',(window,))
        self.db.execute('INSERT INTO production_acceptances VALUES(?,?)',(run,acceptance))
        self.db.commit()
        self.case=SimpleNamespace(package=SimpleNamespace(data=self.root,authority_uid=1,executor_uid=2),
            exports=self.root/'exports',conversation_id='unused',conversation=str(uuid.uuid4()),
            other_export=Path(str(uuid.uuid4())),fixture=SimpleNamespace(account=self.root/'account'))
    def tearDown(self):self.db.close();self.temporary.cleanup()

    def test_run_projection_requires_exact_input_window_and_acceptance(self):
        with evidence.connect(self.case) as db:result=evidence.run(db,self.ids[0])
        self.assertEqual(result['run_id'],self.ids[0]);self.assertEqual(result['window_id'],self.ids[5])
        self.assertEqual(result['acceptance_event_id'],self.ids[6])
        self.db.execute('UPDATE execution_window_inputs SET message_id=?',(self.ids[7],));self.db.commit()
        with evidence.connect(self.case) as db:
            with self.assertRaises(AssertionError):evidence.run(db,self.ids[0])
        self.db.execute('UPDATE execution_window_inputs SET message_id=?',(self.ids[4],))
        self.db.execute('DELETE FROM production_acceptances');self.db.commit()
        with evidence.connect(self.case) as db:
            with self.assertRaises(AssertionError):evidence.run(db,self.ids[0])

    def test_attachment_projection_retains_measured_errno_and_bytes(self):
        folder=self.case.exports/self.case.conversation;folder.mkdir(parents=True)
        data=b'synthetic authorized attachment\n';file=folder/'fixture.txt';file.write_bytes(data);file.chmod(0o640)
        account=self.case.fixture.account/'sessions';account.mkdir(parents=True)
        trace='begin\nreference\nread\nmatched\nwrite=-1 errno=13\ncanary_write=-1 errno=30\nreadonly\nforeign_read=-1 errno=2\nscoped\n'
        proof=account/'synthetic-attachment-proof';proof.write_text(trace)
        result=evidence.attachment(self.case,self.ids[0])
        self.assertEqual(result['export']['sha256'],hashlib.sha256(data).hexdigest())
        self.assertEqual(result['export']['bytes'],len(data));self.assertEqual(result['export']['uid'],file.stat().st_uid)
        self.assertEqual(result['native_probe_trace'],trace)
        self.assertEqual(result['native_probe']['foreign_read'],dict(result=-1,errno=2))
        proof.write_text('matched\nreadonly\nscoped\n')
        with self.assertRaises(AssertionError):evidence.attachment(self.case,self.ids[0])
