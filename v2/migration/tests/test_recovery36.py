"""One populated schema36 copy/cut/dormant-apply/rollback proof, no server starts."""
import hashlib
import json
import os
import shutil
from pathlib import Path
import sqlite3
import sys
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[1]))
sys.path.insert(0, str(HERE.parents[2] / 'local-install/tests'))
import test_install as install_fixture
from recovery36_fixture import CORE, migration_sources, populate
from recovery_reconciliation import from_snapshot, inspect_frozen, reconcile

state, recovery, launcher = install_fixture.state, install_fixture.recovery, install_fixture.launcher


class Schema36Recovery(unittest.TestCase):
    setUp = install_fixture.InstallTests.setUp

    def test_populated_cut_dormant_apply_rollback_and_refusals(self):
        migrations = self.root / 'canonical-migrations'
        migrations.mkdir()
        migration_sources(migrations)
        state.initialize(self.home, self.package, 48123)
        source = populate(self.home / 'data/core.sqlite3', migrations)
        self.addCleanup(source.close)
        source.execute('PRAGMA journal_mode=WAL')
        source.execute("INSERT INTO projects(id,owner_id,request_key,payload_digest,name) VALUES('project-fake','owner-fake','project-fake',?,'Synthetic project')", ('a' * 64,))
        source.commit()  # Committed WAL content must be in the backup cut.
        before = source.execute('SELECT count(*) FROM messages').fetchone()[0]
        snapshot = self.root / 'snapshot'
        recovery.backup(self.home, snapshot)
        expected = from_snapshot(snapshot, migrations)
        self.assertEqual(expected['cut']['schema_version'], 36)
        for name in ('queued_inputs', 'stop_held_inputs', 'accepted_runs', 'unknown_runs', 'history_messages',
                     'held_tasks', 'owner_budget_tasks', 'worker_budgets', 'steering_queued',
                     'steering_unknown', 'steering_acknowledged', 'worker_result_unknown', 'timer_grants'):
            self.assertGreater(expected['cut']['coverage'][name]['rows'], 0, name)
        self.assertEqual(expected['cut']['tables']['projects']['rows'], 1)
        self.assertEqual(expected['cut']['tables']['auth_sessions']['rows'], 0)
        self.assertEqual(expected['cut']['tables']['production_readiness']['rows'], 0)
        # A later native delta does not contaminate the already frozen cut.
        source.execute("INSERT INTO messages(id,owner_id,conversation_id,request_key,payload_digest,text,actor_kind,sequence) VALUES('later-message','owner-fake','conversation-fake','later-input',?,'Synthetic post-cut delta','owner',21)", ('b' * 64,))
        source.execute("UPDATE conversations SET sequence=21 WHERE id='conversation-fake'")
        source.commit()
        self.assertEqual(from_snapshot(snapshot, migrations), expected)
        self.assertEqual(source.execute('SELECT count(*) FROM messages').fetchone()[0], before + 1)
        target = self.root / 'target'
        state.initialize(target, self.package, 48124)
        untouched = {p: (target / p).read_bytes() for p in ('install.json', 'control/bootstrap.token')}
        recovery.restore_apply(target, snapshot)
        restored = target / 'data/core.sqlite3'
        actual = dict(expected, cut=inspect_frozen(restored, expected['cut']['database_sha256'], migrations))
        self.assertEqual(reconcile(expected, actual)['activation'], 'prohibited; dormant target only')
        with patch.object(launcher, 'start') as start:
            with self.assertRaisesRegex(RuntimeError, 'dormant'):
                launcher.serve(target)
        start.assert_not_called()
        recovery.restore_rollback(target)
        self.assertEqual(list((target / 'data').iterdir()), [])
        for name, data in untouched.items():
            self.assertEqual((target / name).read_bytes(), data)
        self.assertEqual(from_snapshot(snapshot, migrations), expected)
        # Refuse changed dormant state; never delete delta or provenance to force rollback.
        recovery.restore_apply(target, snapshot)
        with sqlite3.connect(restored) as changed:
            changed.execute("UPDATE history_messages SET text='Synthetic changed history'")
        with self.assertRaisesRegex(RuntimeError, 'changed'):
            recovery.restore_rollback(target)
        self.assertTrue((target / 'control/restore-dormant.json').is_file())
        changed_sha = hashlib.sha256(restored.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError, 'digest mismatch'):
            inspect_frozen(restored, expected['cut']['database_sha256'], migrations)
        altered = dict(expected, cut=inspect_frozen(restored, changed_sha, migrations))
        with self.assertRaisesRegex(ValueError, 'reconciliation mismatch'):
            reconcile(expected, altered)
        # Copy-only rejection paths on expendable synthetic files.
        scratch = self.root / 'scratch.sqlite3'
        scratch.write_bytes((snapshot / 'core.sqlite3').read_bytes())
        sidecar = Path(str(scratch) + '-wal')
        sidecar.write_bytes(b'synthetic')
        with self.assertRaisesRegex(ValueError, 'standalone'):
            inspect_frozen(scratch, expected['cut']['database_sha256'], migrations)
        sidecar.unlink()
        with sqlite3.connect(scratch) as changed:
            changed.execute("UPDATE _sqlx_migrations SET checksum=x'00' WHERE version=36")
        with self.assertRaisesRegex(ValueError, 'migration checksum'):
            inspect_frozen(scratch, hashlib.sha256(scratch.read_bytes()).hexdigest(), migrations)
        self.assertEqual(from_snapshot(snapshot, migrations), expected)
        # Nothing invokes Store, a provider, a timer controller or an outbound worker.
        self.assertEqual(CORE, '006cca798e967fbd8deecd128933e46a2e0e94a8')
        # Optional explicit private evidence, synthetic only. Never discover homes.
        destination = os.environ.get('ORKESTR_V2_MIGRATION_EVIDENCE')
        if destination:
            evidence = Path(destination)
            self.assertTrue(evidence.is_absolute() and not evidence.exists())
            evidence.mkdir(mode=0o700)
            shutil.copytree(snapshot, evidence / 'snapshot')
            shutil.copytree(migrations, evidence / 'migrations')
            (evidence / 'reconciliation.json').write_text(json.dumps(expected, sort_keys=True, indent=2) + '\n')
            for folder in [evidence, evidence / 'snapshot', evidence / 'migrations']:
                folder.chmod(0o700)
                for file in folder.iterdir():
                    if file.is_file():
                        file.chmod(0o600)
