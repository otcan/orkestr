from datetime import datetime, timezone
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import history_import
import v1_export
import v2_client
import v2_rollback
from fake_v2 import FakeV2
from v1_fixture import V1Home

NOW = datetime(2026, 1, 2, tzinfo=timezone.utc)


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = V1Home(self.root / 'home')
        self.addCleanup(self.home.close)
        self.home.thread('alpha')
        for index in range(1, 6):
            self.home.message('alpha', 'user' if index % 2 else 'assistant', f'synthetic {index}')
        self.server = FakeV2()
        self.count = 0

    def bundle(self):
        self.count += 1
        path = self.root / f'bundle-{self.count}'
        v1_export.export(self.home.root, ['alpha'], path, 'synthetic-v1', now=NOW)
        return v1_export.load(path)

    def run_import(self, apply=True, **target):
        manifest, messages = self.bundle()
        return history_import.import_thread(self.server, manifest, messages, 'alpha', apply=apply, **target)

    def test_dry_run_plans_without_writes(self):
        report = self.run_import(apply=False, create_name='Imported alpha')
        self.assertEqual((report['mode'], report['conversation_id'], report['delta']['messages']),
                         ('dry_run', None, 5))
        self.assertFalse([c for c in self.server.calls if c[0] == 'POST'])
        self.assertNotIn('synthetic 1', json.dumps(report))

    def test_create_import_reimport_and_delta(self):
        first = self.run_import(create_name='Imported alpha')
        conversation = first['conversation_id']
        self.assertEqual((first['result']['inserted'], first['verified']), (5, 'exact_match'))
        again = self.run_import(create_name='Imported alpha')
        self.assertEqual(again['conversation_id'], conversation)
        self.assertEqual((again['delta']['messages'], again['verified']), (0, 'exact_match'))
        self.home.message('alpha', 'user', 'synthetic 6')
        self.home.message('alpha', 'assistant', 'synthetic 7')
        delta = self.run_import(conversation=conversation)
        self.assertEqual(delta['target_before']['cursor'], 5)
        self.assertEqual((delta['delta']['messages'], delta['result']['inserted'], delta['result']['duplicates']),
                         (2, 2, 0))
        self.assertEqual((delta['target_after']['message_count'], delta['verified']), (7, 'exact_match'))

    def test_full_resend_is_duplicate_only_and_batches_are_bounded(self):
        conversation = self.server.conversation()
        with mock.patch.object(history_import, 'BATCH_MESSAGES', 2):
            report = self.run_import(conversation=conversation)
        self.assertEqual(report['delta']['batches'], 3)
        self.assertEqual([c[2] for c in self.server.calls if c[0] == 'POST'], [2, 2, 1])
        manifest, messages = self.bundle()
        receipt = self.server.post(f'/api/v2/conversations/{conversation}/archived-history', {
            'source_instance': 'synthetic-v1', 'source_thread_id': 'alpha', 'snapshot_id': 's',
            'messages': messages['alpha']})
        self.assertEqual((receipt['inserted'], receipt['duplicates']), (0, 5))

    def test_conflicting_target_is_reported_not_overwritten(self):
        conversation = self.server.conversation()
        manifest, messages = self.bundle()
        changed = dict(messages['alpha'][0], text='different')
        changed['source_message_id'] = 'foreign'
        self.server.post(f'/api/v2/conversations/{conversation}/archived-history', {
            'source_instance': 'synthetic-v1', 'source_thread_id': 'alpha', 'snapshot_id': 's',
            'messages': [changed]})
        report = history_import.import_thread(self.server, manifest, messages, 'alpha',
                                              conversation=conversation, apply=True)
        self.assertEqual(report['delta']['messages'], 4)
        self.assertEqual(report['verified'], 'checksum_mismatch')

    def test_unknown_conversation_and_bad_targets_fail(self):
        with self.assertRaises(v2_client.ApiError):
            self.run_import(conversation='00000000-0000-4000-8000-000000000001')
        manifest, messages = self.bundle()
        with self.assertRaisesRegex(v1_export.ExportError, 'choose_conversation_or_create_name'):
            history_import.import_thread(self.server, manifest, messages, 'alpha')
        with self.assertRaisesRegex(v1_export.ExportError, 'thread_not_in_bundle'):
            history_import.import_thread(self.server, manifest, messages, 'beta', create_name='x')

    def test_credentials_file_must_be_private(self):
        path = self.root / 'credentials.json'
        path.write_text(json.dumps({'username': 'synthetic', 'password': 'synthetic-password'}))
        os.chmod(path, 0o644)
        with self.assertRaises(v2_client.ApiError):
            v2_client.read_credentials(path)
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
        self.assertEqual(v2_client.read_credentials(path)[0], 'synthetic')


class RollbackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = V1Home(self.root / 'home')
        self.addCleanup(self.home.close)
        self.home.thread('alpha')
        self.home.message('alpha', 'user', 'before move')
        self.server = FakeV2()
        self.conversation = self.server.conversation()
        self.server.native[self.conversation] = {
            'inputs': [{'message_id': f'00000000-0000-4000-8000-00000000000{i}', 'sequence': s,
                        'actor_kind': 'owner', 'text': f'v2 input {s}'} for i, s in ((1, 1), (2, 3), (3, 5))],
            'replies': [{'run_id': 'r1', 'acceptance_sequence': 2, 'payload_id': 'p1', 'payload_removed': False},
                        {'run_id': 'r2', 'acceptance_sequence': 4, 'payload_id': 'p2', 'payload_removed': True}],
            'payloads': {'p1': 'v2 reply 2'}}

    def archive(self, after=0):
        archive = v2_rollback.export_conversation(self.server, self.conversation, after, now=NOW)
        path = self.root / f'archive-{after}.json'
        v2_rollback.write_archive(archive, path)
        return v2_rollback.read_archive(path)

    def rows(self):
        return self.home.db.execute(
            "select id,position,role,state,source,data from orkestr_thread_messages where thread_id='alpha' "
            'order by position').fetchall()

    def test_export_merges_inputs_and_replies_in_sequence(self):
        archive = self.archive()
        self.assertEqual([(e['v2_sequence'], e['role']) for e in archive['entries']],
                         [(1, 'user'), (2, 'assistant'), (3, 'user'), (4, 'assistant'), (5, 'user')])
        self.assertFalse(archive['entries'][3]['text_available'])
        self.assertEqual([e['v2_sequence'] for e in self.archive(after=3)['entries']], [4, 5])
        self.assertTrue(os.stat(self.root / 'archive-0.json').st_mode & 0o077 == 0)

    def test_append_is_dry_run_by_default_then_inert_and_idempotent(self):
        archive = self.archive()
        db = self.home.root / 'thread-messages.sqlite'
        plan = v2_rollback.append_to_v1(archive, db, 'alpha')
        self.assertEqual((plan['mode'], plan['appended'], plan['first_position']), ('dry_run', 0, 2))
        self.assertEqual(len(self.rows()), 1)
        report = v2_rollback.append_to_v1(archive, db, 'alpha', apply=True, now=NOW)
        self.assertEqual(report['appended'], 5)
        rows = self.rows()
        self.assertEqual([r[1] for r in rows], [1, 2, 3, 4, 5, 6])
        self.assertEqual({(r[3], r[4]) for r in rows[1:]}, {('archived', 'orkestr-v2-archive')})
        self.assertEqual(json.loads(rows[1][5])['v2Archive']['sequence'], 1)
        self.assertEqual(self.home.db.execute('select count(*) from orkestr_thread_bridge_changes').fetchone()[0], 0)
        self.assertEqual(self.home.db.execute(
            "select revision from orkestr_thread_message_meta where thread_id='alpha'").fetchone()[0], 2)
        again = v2_rollback.append_to_v1(archive, db, 'alpha', apply=True, now=NOW)
        self.assertEqual((again['appended'], again['already_present']), (0, 5))
        self.assertEqual(len(self.rows()), 6)

    def test_append_refuses_unmigrated_thread_tampered_archive_and_missing_store(self):
        archive = self.archive()
        self.home.thread('json-only', migrated=False)
        with self.assertRaisesRegex(v2_rollback.RollbackError, 'v1_thread_not_migrated'):
            v2_rollback.append_to_v1(archive, self.home.root / 'thread-messages.sqlite', 'json-only', apply=True)
        with self.assertRaisesRegex(v2_rollback.RollbackError, 'v1_sqlite_store_required'):
            v2_rollback.append_to_v1(archive, self.root / 'absent.sqlite', 'alpha')
        path = self.root / 'archive-0.json'
        os.chmod(path, 0o600)
        path.write_text(path.read_text().replace('v2 input 1', 'v2 input X'))
        with self.assertRaisesRegex(v2_rollback.RollbackError, 'archive_digest'):
            v2_rollback.read_archive(path)
        with self.assertRaisesRegex(v2_rollback.RollbackError, 'archive_exists'):
            v2_rollback.write_archive(archive, path)


if __name__ == '__main__':
    unittest.main()
