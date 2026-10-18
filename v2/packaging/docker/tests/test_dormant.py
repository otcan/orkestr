"""Synthetic offline same-image recovery; no Docker or real server calls."""
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import test_distribution as distribution

recovery = distribution.load('dormant')


class DormantTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='v2-dormant-fixture-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.image = self.root / 'artifact-manifest.json'
        self.image.write_text('{"synthetic_image":"a"}')
        self.database = self.root / 'source.sqlite3'
        with closing(sqlite3.connect(self.database)) as db:
            db.execute('CREATE TABLE messages(body TEXT)')
            db.execute("INSERT INTO messages VALUES ('synthetic history')")
            db.commit()
        self.snapshot = self.root / 'snapshot'
        recovery.snapshot(self.database, self.snapshot, self.image)
        self.state = self.root / 'state'
        self.state.mkdir(mode=0o700)

    def test_actual_apply_hash_history_and_rollback(self):
        recovery.apply(self.snapshot, self.state, self.image)
        self.assertEqual(recovery.digest(self.state / 'data/core.sqlite3'),
                         recovery.digest(self.snapshot / 'core.sqlite3'))
        with closing(sqlite3.connect(self.state / 'data/core.sqlite3')) as db:
            self.assertEqual(db.execute('SELECT body FROM messages').fetchall(), [('synthetic history',)])
        recovery.rollback(self.state, self.image)
        self.assertEqual(list(self.state.iterdir()), [])

    def test_different_image_or_tampered_snapshot_refused_before_state(self):
        self.image.write_text('{"synthetic_image":"other"}')
        with self.assertRaisesRegex(RuntimeError, 'same exact image'):
            recovery.apply(self.snapshot, self.state, self.image)
        self.assertEqual(list(self.state.iterdir()), [])
        self.image.write_text('{"synthetic_image":"a"}')
        (self.snapshot / 'core.sqlite3').write_bytes(b'tampered')
        with self.assertRaisesRegex(RuntimeError, 'checksum'):
            recovery.apply(self.snapshot, self.state, self.image)
        self.assertEqual(list(self.state.iterdir()), [])

    def test_changed_database_or_extra_files_refuse_rollback(self):
        recovery.apply(self.snapshot, self.state, self.image)
        (self.state / 'data/core.sqlite3').write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError, 'changed'):
            recovery.rollback(self.state, self.image)
        self.assertTrue((self.state / 'restore-dormant.json').exists())

    def test_dangling_data_symlink_preserves_receipt_and_symlink(self):
        recovery.apply(self.snapshot, self.state, self.image)
        (self.state / 'data/core.sqlite3').unlink()
        (self.state / 'data').rmdir()
        (self.state / 'data').symlink_to(self.root / 'missing-synthetic-data')
        receipt = (self.state / 'restore-dormant.json').read_bytes()
        with self.assertRaisesRegex(RuntimeError, 'private owned directory'):
            recovery.rollback(self.state, self.image)
        self.assertTrue((self.state / 'data').is_symlink())
        self.assertEqual((self.state / 'restore-dormant.json').read_bytes(), receipt)

    def test_copy_failure_remains_dormant_then_rollback(self):
        with patch.object(recovery.shutil, 'copyfile', side_effect=OSError('synthetic copy failure')):
            with self.assertRaises(OSError):
                recovery.apply(self.snapshot, self.state, self.image)
        self.assertTrue((self.state / 'restore-dormant.json').exists())
        recovery.rollback(self.state, self.image)
        self.assertEqual(list(self.state.iterdir()), [])

    def test_symlink_snapshot_manifest_refused(self):
        (self.snapshot / 'manifest.json').unlink()
        (self.snapshot / 'manifest.json').symlink_to(self.image)
        with self.assertRaisesRegex(RuntimeError, 'regular'):
            recovery.apply(self.snapshot, self.state, self.image)

    def test_entrypoint_never_activates_dormant_state(self):
        fixture = distribution.DistributionTests('test_context_policy_and_copied_hashes')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        root = fixture.context()
        marker = self.state / 'restore-dormant.json'
        marker.write_text('{}')
        env = {'ORKESTR_V2_ORIGIN': fixture.args['origin'], 'ORKESTR_V2_CONTAINER_BIND': '1'}
        with self.assertRaisesRegex(RuntimeError, 'dormant'):
            distribution.entrypoint.environment(root, self.state, env)
        self.assertEqual(list(self.state.iterdir()), [marker])


class RecoveryProbeGuards(unittest.TestCase):
    def test_running_source_is_rejected_before_helper_or_cleanup(self):
        import sys
        sys.path.insert(0, str(distribution.HERE))
        runner = distribution.load('recovery_probe')
        with tempfile.TemporaryDirectory(prefix='v2-recovery-probe-') as raw:
            context = Path(raw)
            (context / 'artifact-manifest.json').write_text(json.dumps({'project': 'v2-install-' + 'a' * 12}))
            info = {'Config': {'Labels': {'com.docker.compose.project': 'v2-install-' + 'a' * 12}},
                    'State': {'Running': True}}
            with patch.object(runner.probe, 'run', return_value=json.dumps([info])) as command:
                with self.assertRaisesRegex(RuntimeError, 'stopped'):
                    runner.exercise(context, 'synthetic-container')
            self.assertEqual(command.call_count, 1)

    def test_existing_restore_volume_is_preserved(self):
        import sys
        sys.path.insert(0, str(distribution.HERE))
        runner = distribution.load('recovery_probe')
        with tempfile.TemporaryDirectory(prefix='v2-recovery-probe-') as raw:
            context = Path(raw)
            (context / 'artifact-manifest.json').write_text(json.dumps({'project': 'v2-install-' + 'a' * 12}))
            info = {'Config': {'Labels': {'com.docker.compose.project': 'v2-install-' + 'a' * 12}},
                    'State': {'Running': False}, 'Image': 'synthetic-image'}
            with patch.object(runner.probe, 'run', side_effect=[json.dumps([info]), 'synthetic-image', 'occupied']) as command:
                with self.assertRaisesRegex(RuntimeError, 'existing volume preserved'):
                    runner.exercise(context, 'synthetic-container')
            self.assertFalse(any(call.args[0] in ('run', 'rm') for call in command.call_args_list))
