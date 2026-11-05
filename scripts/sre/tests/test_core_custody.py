import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('custody', Path(__file__).parents[1] / 'core_custody.py')
c = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(c)


class CoreCustodyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'source').mkdir()
        self.source = self.root / 'source' / 'core.sqlite3'
        with sqlite3.connect(self.source) as db:
            db.execute('CREATE TABLE evidence(id INTEGER PRIMARY KEY, value TEXT)')
            db.execute("INSERT INTO evidence VALUES(1,'synthetic')")
        self.original = c.sha(self.source)
        self.descriptor = self.root / 'candidate.json'
        self.descriptor.write_text('{}')
        self.config = dict(source_core=str(self.source), target_root=str(self.root / 'authority'),
                           service_uid=10002, service_gid=10002, agent_uid=10001,
                           unit='synthetic.service', candidate_descriptor=str(self.descriptor))
        self.qualification = dict(self.config, format='core-identity-qualification-v1',
                                  candidate_sha256=c.sha(self.descriptor))
        for key in ('separate_server_executor_identity', 'agent_core_read_denied', 'agent_core_write_denied',
                    'provider_broker_smoke', 'startup_closure_verified', 'direct_consumers_reconciled',
                    'authenticated_provenance_verified', 'executor_privilege_escalation_denied'):
            self.qualification[key] = True
        self.receipt = self.root / 'receipt.json'

    def rehearsal(self):
        # Root metadata operations are injected; the actual SQLite copy, fsync,
        # schema/integrity checks, private modes and rollback execute in tempdir.
        with patch.object(c, 'validate'), patch.object(c.os, 'chown'):
            return c.stage(self.config,self.qualification,self.receipt,
                           stop_check=lambda _:True,descriptors=lambda _:[])

    def test_rehearsal_preserves_schema_data_and_source_and_rolls_back(self):
        result = self.rehearsal()
        target = Path(result['target_core'])
        self.assertEqual(c.schema(target),c.schema(self.source))
        with sqlite3.connect(target) as db:
            self.assertEqual(db.execute('SELECT value FROM evidence').fetchone()[0],'synthetic')
        self.assertEqual(c.sha(self.source),self.original)
        self.assertFalse(result['service_cutover_performed'])
        self.assertEqual(target.stat().st_mode & 0o777,0o600)
        self.assertEqual(self.receipt.stat().st_mode & 0o777,0o600)
        c.rollback(self.receipt,stop_check=lambda _:True,descriptors=lambda _:[])
        self.assertFalse(target.exists())
        self.assertEqual(c.sha(self.source),self.original)

    def test_missing_qualification_and_active_service_prevent_writes(self):
        with patch.object(c,'validate'):
            report=c.preflight(self.config,None,stop_check=lambda _:False,descriptors=lambda _:[123])
            self.assertIn('identity_split_not_qualified',report['blockers'])
            self.assertIn('service_not_stopped',report['blockers'])
            self.assertIn('core_open_descriptors',report['blockers'])
            with self.assertRaises(c.Refused):
                c.stage(self.config,None,self.receipt,stop_check=lambda _:False,descriptors=lambda _:[])
        self.assertFalse(Path(self.config['target_root']).exists())

    def test_changed_candidate_or_failed_probe_is_not_qualified(self):
        self.descriptor.write_text('{"different":true}')
        with self.assertRaisesRegex(c.Refused,'candidate_changed'):
            c.qualifying(self.config,self.qualification)
        self.qualification['agent_core_read_denied']=False
        with self.assertRaisesRegex(c.Refused,'probe_missing'):
            c.qualifying(self.config,self.qualification)

    def test_changed_staged_data_is_never_erased(self):
        self.rehearsal()
        target=Path(self.config['target_root'])/'core.sqlite3'
        with sqlite3.connect(target) as db:
            db.execute("INSERT INTO evidence VALUES(2,'new data')")
        with self.assertRaisesRegex(c.Refused,'do_not_erase'):
            c.rollback(self.receipt,stop_check=lambda _:True,descriptors=lambda _:[])
        self.assertTrue(target.exists())

    def test_same_uid_and_agent_owned_parent_are_refused(self):
        self.config['service_uid']=self.config['agent_uid']
        with self.assertRaisesRegex(c.Refused,'separate_service_identity_missing'):
            c.validate(self.config)
        self.config['service_uid']=10002
        # The universally writable /tmp ancestor makes this unsuitable authority custody.
        with self.assertRaisesRegex(c.Refused,'target_ancestor_writable'):
            c.validate(self.config)

    def test_direct_read_denial_without_escalation_denial_is_not_qualification(self):
        del self.qualification['executor_privilege_escalation_denied']
        with self.assertRaisesRegex(c.Refused,'probe_missing'):
            c.qualifying(self.config,self.qualification)
        self.qualification['executor_privilege_escalation_denied']=False
        with self.assertRaisesRegex(c.Refused,'probe_missing'):
            c.qualifying(self.config,self.qualification)

    def test_qualification_must_match_target_and_actor(self):
        self.qualification['agent_uid']=12345
        with self.assertRaisesRegex(c.Refused,'scope_mismatch'):
            c.qualifying(self.config,self.qualification)


if __name__=='__main__':
    unittest.main()
