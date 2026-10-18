"""Mocked subprocess protocol with a genuine disposable SQLite snapshot."""
import json
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import dormant_checkpoint as checkpoint
from recovery import SNAPSHOT_FORMAT


class DormantCheckpointTests(unittest.TestCase):
    def run_checkpoint(self, fault=None):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);target=root/'successor-dormant'
            def invoke(entry,command,home,*extra,expected=0):
                if command=='backup':
                    snapshot=root/'successor-snapshot';snapshot.mkdir()
                    database=snapshot/'core.sqlite3'
                    with sqlite3.connect(database) as db:
                        db.execute('CREATE TABLE _sqlx_migrations(version INTEGER,success INTEGER)')
                        db.execute('INSERT INTO _sqlx_migrations VALUES (1,1)')
                    digest=checkpoint.sha256(database)
                    (snapshot/'manifest.json').write_text(json.dumps({'format':SNAPSHOT_FORMAT,'files':{'core.sqlite3':digest},'sqlite_user_version':0}))
                elif command=='install':
                    (home/'data').mkdir(parents=True);(home/'control').mkdir()
                    (home/'install.json').write_text('synthetic config');(home/'control/bootstrap.token').write_text('synthetic bootstrap')
                elif command=='restore-apply':
                    if expected==1:
                        if fault=='refusal_mutates':(home/'data/extra').write_text('unexpected')
                        return SimpleNamespace(stderr='same exact package required')
                    (home/'data/core.sqlite3').write_bytes((root/'successor-snapshot/core.sqlite3').read_bytes())
                    (home/'control/restore-dormant.json').write_text('synthetic dormant receipt')
                    if fault=='copy_tamper':(home/'data/core.sqlite3').write_bytes(b'tampered')
                elif command=='start':
                    if fault=='activation_mutates':(home/'control/restore-dormant.json').write_text('changed')
                    return SimpleNamespace(stderr='dormant activation prohibited')
                elif command=='restore-rollback':
                    (home/'data/core.sqlite3').unlink();(home/'control/restore-dormant.json').unlink()
                    if fault=='config_mutates':(home/'install.json').write_text('changed')
                return SimpleNamespace(stderr='')
            with patch.object(checkpoint,'invoke',side_effect=invoke):
                return checkpoint.exercise(Path('/entry'),Path('/package'),Path('/source'),root,19842,Path('/old-snapshot'),[1])

    def test_same_package_restore_refusal_and_rollback(self):
        result=self.run_checkpoint()
        self.assertTrue(result['cross_package_restore_refused']);self.assertTrue(result['rollback_empty'])

    def test_refusals_and_integrity_failures_cannot_pass(self):
        for fault in ('refusal_mutates','copy_tamper','activation_mutates','config_mutates'):
            with self.subTest(fault=fault),self.assertRaises(RuntimeError):self.run_checkpoint(fault)
