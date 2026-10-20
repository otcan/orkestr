from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import archive_digest
import v1_export
from v1_fixture import OTHER_TEXT, SECRET_MARKER, V1Home, private, source_fingerprint

CLI = Path(__file__).resolve().parents[1] / 'thread_history.py'
NOW = datetime(2026, 1, 2, tzinfo=timezone.utc)


class V1ExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = V1Home(self.root / 'v1-home')
        self.addCleanup(self.home.close)
        self.home.thread('alpha')
        self.home.thread('other')
        self.home.message('alpha', 'user', 'synthetic question é')
        self.home.message('alpha', 'assistant', 'synthetic answer', phase='final_answer')
        self.home.message('other', 'user', OTHER_TEXT)

    def export(self, name='bundle', threads=('alpha',), **options):
        options.setdefault('now', NOW)
        return v1_export.export(self.home.root, list(threads), self.root / name, 'synthetic-v1', **options)

    def bundle_bytes(self, name='bundle'):
        return b''.join(p.read_bytes() for p in sorted((self.root / name).rglob('*')) if p.is_file())

    def test_wal_rows_selected_thread_only_and_source_unchanged(self):
        before = source_fingerprint(self.home.root)
        self.assertGreater(os.path.getsize(self.home.root / 'thread-messages.sqlite-wal'), 0)
        manifest = self.export()
        self.assertEqual(source_fingerprint(self.home.root), before)
        thread = manifest['threads'][0]
        self.assertEqual((thread['source_messages'], thread['exported'], thread['watermark']), (2, 2, 2))
        self.assertEqual(thread['roles'], {'assistant': 1, 'user': 1})
        self.assertEqual(thread['registry'], {'createdAt': '2026-01-01T00:00:00.000Z', 'id': 'alpha',
                                              'name': 'Synthetic thread'})
        data = self.bundle_bytes()
        for forbidden in (OTHER_TEXT.encode(), SECRET_MARKER.encode(), b'synthetic-native'):
            self.assertNotIn(forbidden, data)
        self.assertFalse((self.root / 'bundle' / 'backups').exists())
        for path in (self.root / 'bundle').rglob('*'):
            self.assertTrue(private(path), path.name)
        loaded, messages = v1_export.load(self.root / 'bundle')
        self.assertEqual(messages['alpha'][0]['text'], 'synthetic question é')
        self.assertEqual(messages['alpha'][1]['phase'], 'final_answer')
        self.assertEqual(messages['alpha'][0]['created_at'], '2026-01-01T00:00:01.000Z')
        self.assertEqual(thread['checksum'], archive_digest.checksum(messages['alpha']))
        self.assertEqual(loaded['consistency']['method'], 'sqlite_online_backup_readonly')

    def test_snapshot_identity_is_deterministic_and_changes_with_content(self):
        first = self.export('one')
        second = self.export('two')
        self.assertEqual(first['snapshot_id'], second['snapshot_id'])
        self.home.message('alpha', 'user', 'later')
        third = self.export('three')
        self.assertNotEqual(first['snapshot_id'], third['snapshot_id'])
        self.assertEqual(third['threads'][0]['watermark'], 3)

    def test_recent_unsettled_tail_is_cut_but_stale_nonterminal_is_kept(self):
        self.home.message('alpha', 'user', 'stale queued', state='queued', created='2025-01-01T00:00:00.000Z')
        self.home.message('alpha', 'assistant', 'after stale')
        recent = (NOW - timedelta(minutes=5)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
        self.home.message('alpha', 'assistant', 'still running', state='running', created=recent)
        self.home.message('alpha', 'user', 'queued behind', state='queued', created=recent)
        thread = self.export()['threads'][0]
        self.assertEqual((thread['exported'], thread['watermark'], thread['unsettled_tail']), (4, 4, 2))
        everything = self.export('all', include_unsettled=True)['threads'][0]
        self.assertEqual((everything['exported'], everything['unsettled_tail']), (6, 0))

    def test_attachments_copy_only_thread_uploads_with_hashes(self):
        inside = self.home.upload('alpha', 'report.txt', b'synthetic attachment')
        secret = self.home.root / 'secrets' / 'token.txt'
        secret.write_bytes(b'never-copy')
        link = Path(self.home.root, 'uploads', 'alpha', 'link.txt')
        link.symlink_to(secret)
        self.home.message('alpha', 'user', 'with files', attachments=[
            {'name': 'report.txt', 'path': inside, 'mimetype': 'text/plain'},
            {'name': 'escape', 'path': str(secret)},
            {'name': 'link', 'saved_path': str(link)},
            {'name': 'gone', 'filePath': str(link.parent / 'gone.txt')},
            {'name': 'encrypted-only', 'id': 'remote-object'}])
        thread = self.export()['threads'][0]
        # The symlink resolves outside the thread's upload directory.
        self.assertEqual(thread['attachments'], {'copied': 1, 'unavailable': {
            'missing_or_not_regular': 1, 'no_local_path': 1, 'outside_thread_uploads': 2}})
        _, messages = v1_export.load(self.root / 'bundle')
        attachments = messages['alpha'][2]['attachments']
        sha = hashlib.sha256(b'synthetic attachment').hexdigest()
        self.assertEqual(attachments[0], {'name': 'report.txt', 'sha256': sha, 'bytes': 20,
                                          'media_type': 'text/plain', 'available': True})
        self.assertEqual((self.root / 'bundle' / 'uploads' / sha).read_bytes(), b'synthetic attachment')
        self.assertNotIn(b'never-copy', self.bundle_bytes())

    def test_invalid_rows_are_quarantined_locally_with_ids(self):
        self.home.message('alpha', 'Robot!', 'bad role')
        self.home.message('alpha', 'user', 'x' * (1024 * 1024 + 1))
        thread = self.export()['threads'][0]
        self.assertEqual(thread['quarantined'], {'invalid_role': 1, 'text_too_large': 1})
        self.assertEqual(thread['quarantined_ids']['invalid_role'], ['alpha-m3'])
        self.assertEqual(thread['exported'], 2)

    def test_json_authority_and_legacy_divergence_evidence(self):
        self.home.thread('legacy', migrated=False)
        self.home.legacy_json('legacy', [{'id': 'j1', 'role': 'user', 'text': 'legacy one', 'createdAt': 'a'},
                                         {'id': 'j2', 'role': 'assistant', 'text': 'legacy two'}])
        self.home.legacy_json('alpha', [{'id': 'alpha-m1', 'role': 'user', 'text': 'old'},
                                        {'id': 'gone', 'role': 'user', 'text': 'old'}])
        manifest = self.export(threads=('legacy', 'alpha'))
        legacy, alpha = manifest['threads']
        self.assertEqual((legacy['authority'], legacy['exported']), ('json', 2))
        self.assertEqual(alpha['authority'], 'sqlite')
        self.assertEqual({k: alpha['legacy_json'][k] for k in ('messages', 'only_in_json', 'only_in_sqlite')},
                         {'messages': 2, 'only_in_json': 1, 'only_in_sqlite': 1})

    def test_paths_and_selection_fail_closed(self):
        for output, code in ((self.home.root / 'inside', 'output_overlaps_source'),):
            with self.assertRaisesRegex(v1_export.ExportError, code):
                v1_export.export(self.home.root, ['alpha'], output, 'synthetic-v1')
        (self.root / 'exists').mkdir()
        with self.assertRaisesRegex(v1_export.ExportError, 'output_exists'):
            self.export('exists')
        with self.assertRaisesRegex(v1_export.ExportError, 'thread_history_not_found'):
            self.export('missing', threads=('absent',))
        with self.assertRaisesRegex(v1_export.ExportError, 'thread_selection'):
            self.export('dup', threads=('alpha', 'alpha'))
        self.assertEqual([p.name for p in self.root.iterdir() if p.name.startswith('.v1-history-')], [])

    def test_tampered_bundle_is_refused(self):
        self.export()
        path = self.root / 'bundle' / 'threads' / 'alpha' / 'messages.jsonl'
        os.chmod(path, 0o600)
        path.write_bytes(path.read_bytes().replace(b'synthetic answer', b'synthetic answeR'))
        with self.assertRaisesRegex(v1_export.ExportError, 'bundle_file_mismatch'):
            v1_export.load(self.root / 'bundle')

    def test_cli_report_has_counts_but_no_content(self):
        result = subprocess.run([sys.executable, '-I', str(CLI), 'v1-export', '--v1-home', str(self.home.root),
                                 '--thread', 'alpha', '--out', str(self.root / 'cli'),
                                 '--source-instance', 'synthetic-v1'],
                                capture_output=True, text=True, check=True)
        report = json.loads(result.stdout)['result']
        self.assertEqual(report['threads'][0]['exported'], 2)
        self.assertNotIn('synthetic question', result.stdout + result.stderr)
        self.assertNotIn(str(self.home.root), result.stdout)
        failed = subprocess.run([sys.executable, '-I', str(CLI), 'v1-export', '--v1-home', str(self.home.root),
                                 '--thread', 'alpha', '--out', str(self.root / 'cli')],
                                capture_output=True, text=True)
        self.assertEqual((failed.returncode, json.loads(failed.stderr)['code']), (2, 'output_exists'))

    def test_pinned_digest_vector_matches_rust(self):
        message = {'source_message_id': 'msg-1', 'source_position': 1, 'role': 'user', 'phase': None,
                   'created_at': '2026-01-01T10:00:00.123Z', 'text': 'hi é',
                   'attachments': [{'name': 'a.txt', 'sha256': '0' * 64, 'bytes': 3,
                                    'media_type': 'text/plain', 'available': True}]}
        digest = archive_digest.digest(message)
        self.assertEqual(digest, '04a78502b2950c31549971e0bf3d46231da2f1fc90c20cd90502d97f478b6a9a')
        self.assertEqual(archive_digest.chain_next('', digest),
                         '48cfb477f978ae01f8ab07e5ea5022a42ede0749293c15ce86f5fbd2aa69551a')


if __name__ == '__main__':
    unittest.main()
