import copy
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from snapshot import Invalid, canonical, load, sha, validate_document
from planner import empty_ledger, map_key, reconcile
from bundle_io import copy_bundle
from ledger_io import plan_to_file, recovery_export, recovery_restore
from support import document, record, ref, seal, write_bundle

CLI = Path(__file__).resolve().parents[1] / 'migrate.py'


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bundle = self.root / 'snapshot'
        self.doc = write_bundle(self.bundle)
        self.ledger_path = self.root / 'plan.json'

    def entry(self, ledger, kind):
        return next(v for v in ledger['entries'].values() if v['kind'] == kind)

    def check_bad(self, mutation, code=None):
        value = copy.deepcopy(self.doc)
        mutation(value)
        seal(value)
        with self.assertRaises(Invalid) as raised:
            validate_document(value, self.bundle)
        if code:
            self.assertEqual(str(raised.exception), code)

    def test_valid_bundle_and_counts(self):
        value = load(self.bundle)
        self.assertEqual(len(value['records']), 16)
        self.assertEqual(sum(value['counts'].values()), 16)

    def test_repeat_keeps_ledger_identical(self):
        first, _ = reconcile(self.doc)
        second, counts = reconcile(self.doc, first)
        self.assertEqual(first, second)
        self.assertEqual(counts, {'duplicates': 16})

    def test_mapping_stable_across_record_order_and_snapshot_id(self):
        first, _ = reconcile(self.doc)
        other = copy.deepcopy(self.doc)
        other['records'].reverse()
        other['snapshot_id'] = 'fixture-snapshot-next'
        seal(other)
        second, _ = reconcile(other)
        self.assertEqual({k: v['target_id'] for k, v in first['entries'].items()},
                         {k: v['target_id'] for k, v in second['entries'].items()})

    def test_changed_content_quarantines_without_overwrite(self):
        first, _ = reconcile(self.doc)
        changed = copy.deepcopy(self.doc)
        changed['records'][3]['payload']['text'] = 'Changed synthetic content'
        seal(changed)
        second, counts = reconcile(changed, first)
        key = map_key(self.doc['source_instance'], self.doc['records'][3])
        self.assertEqual(counts['conflicts'], 1)
        self.assertEqual(second['entries'][key]['digest'], first['entries'][key]['digest'])
        self.assertEqual(second['entries'][key]['disposition'], 'QUARANTINED')
        child_key = map_key(self.doc['source_instance'], self.doc['records'][4])
        self.assertEqual(second['entries'][child_key]['disposition'], 'QUARANTINED')
        self.assertIn('quarantined_reference', second['entries'][child_key]['reasons'])
        repeated, _ = reconcile(changed, second)
        self.assertEqual(second, repeated)
        self.assertEqual(len(second['conflicts']), 1)

    def test_replay_original_parent_new_dependents_stays_quarantined(self):
        first, _ = reconcile(self.doc)
        changed = copy.deepcopy(self.doc)
        changed['records'][3]['payload']['text'] = 'Conflicting synthetic parent'
        second, _ = reconcile(seal(changed), first)
        # Reopen persisted state, then replay the original parent bytes. New children
        # are intentionally reversed so closure cannot depend on iteration order.
        reopened = json.loads(json.dumps(second))
        original = copy.deepcopy(self.doc)
        original['records'].extend([
            record('message', ['fixture-root', 'fixture-message-4'],
                   references=[ref('message', ['fixture-root', 'fixture-message-3'])],
                   payload={'position': 4}),
            record('message', ['fixture-root', 'fixture-message-3'],
                   references=[ref('message', ['fixture-root', 'fixture-message-1'])],
                   payload={'position': 3}),
        ])
        third, _ = reconcile(seal(original), reopened)
        for item in original['records']:
            entry = third['entries'][map_key(original['source_instance'], item)]
            if item['kind'] == 'message':
                self.assertEqual(entry['disposition'], 'QUARANTINED')
                if item['key'][1] in {'fixture-message-3', 'fixture-message-4'}:
                    self.assertIn('quarantined_reference', entry['reasons'])
        self.assertEqual(self.entry(third, 'project')['disposition'], 'HISTORY_ONLY')
        self.assertEqual(self.entry(third, 'run')['disposition'], 'PAUSED')
        fourth, _ = reconcile(original, third)
        self.assertEqual(third, fourth)

    def test_thread_cycle_propagates_through_implicit_ownership(self):
        value = copy.deepcopy(self.doc)
        value['records'][1]['references'] = [ref('thread', 'fixture-worker')]
        value['records'].append(record('message', ['fixture-worker', 'fixture-worker-message'],
                                       payload={'position': 1}))
        ledger, _ = reconcile(seal(value))
        for entry in ledger['entries'].values():
            if entry['kind'] in {'thread', 'message'}:
                self.assertEqual(entry['disposition'], 'QUARANTINED')
            if entry['kind'] == 'message':
                self.assertIn('quarantined_reference', entry['reasons'])
        self.assertEqual(self.entry(ledger, 'project')['disposition'], 'HISTORY_ONLY')
        self.assertEqual(self.entry(ledger, 'timer')['disposition'], 'PAUSED')

    def test_replay_thread_conflict_quarantines_new_implicit_message(self):
        first, _ = reconcile(self.doc)
        changed = copy.deepcopy(self.doc)
        changed['records'][1]['payload']['name'] = 'Conflicting synthetic root'
        second, _ = reconcile(seal(changed), first)
        original = copy.deepcopy(self.doc)
        child = record('message', ['fixture-root', 'fixture-new-message'],
                       payload={'position': 3})
        original['records'].append(child)
        third, _ = reconcile(seal(original), json.loads(json.dumps(second)))
        entry = third['entries'][map_key(original['source_instance'], child)]
        self.assertEqual(entry['disposition'], 'QUARANTINED')
        self.assertIn('quarantined_reference', entry['reasons'])
        self.assertEqual(self.entry(third, 'project')['disposition'], 'HISTORY_ONLY')

    def test_quarantine_does_not_cross_source_instances(self):
        first, _ = reconcile(self.doc)
        changed = copy.deepcopy(self.doc)
        changed['records'][1]['payload']['name'] = 'Conflicting synthetic root'
        second, _ = reconcile(seal(changed), first)
        other = copy.deepcopy(self.doc)
        other['source_instance'] = 'fixture-independent-instance'
        third, _ = reconcile(seal(other), second)
        for item in other['records']:
            if item['kind'] in {'thread', 'message'}:
                entry = third['entries'][map_key(other['source_instance'], item)]
                self.assertEqual(entry['disposition'], 'HISTORY_ONLY')

    def test_operational_kinds_paused(self):
        ledger, _ = reconcile(self.doc)
        for kind in ('run', 'timer', 'route', 'approval', 'automation', 'job'):
            self.assertEqual(self.entry(ledger, kind)['disposition'], 'PAUSED')
        self.assertFalse(ledger['dispatch_allowed'])
        self.assertEqual(self.entry(ledger, 'effect')['disposition'], 'QUARANTINED')

    def test_unknown_state_never_converts(self):
        value = copy.deepcopy(self.doc)
        value['records'][6]['source_state'] = 'fixture-future-state'
        ledger, _ = reconcile(seal(value))
        entry = self.entry(ledger, 'run')
        self.assertEqual(entry['source_state'], 'fixture-future-state')
        self.assertEqual(entry['disposition'], 'QUARANTINED')

    def test_unresolved_owner_scope_quarantined(self):
        value = copy.deepcopy(self.doc)
        value['records'][1]['owner'] = None
        ledger, _ = reconcile(seal(value))
        entries = [v for v in ledger['entries'].values() if v['kind'] == 'thread']
        self.assertTrue(all(e['disposition'] == 'QUARANTINED' for e in entries))

    def test_orphan_and_cross_owner_quarantined(self):
        for reference in (ref('thread', 'fixture-missing'), ref('project', 'fixture-project')):
            with self.subTest(reference=reference):
                value = copy.deepcopy(self.doc)
                value['records'][2]['references'] = [reference]
                value['records'][0]['owner'] = 'fixture-other-owner'
                ledger, _ = reconcile(seal(value))
                self.assertTrue(any(e['disposition'] == 'QUARANTINED'
                                    for e in ledger['entries'].values()))

    def test_cycle_quarantines_all_cycle_members(self):
        value = copy.deepcopy(self.doc)
        value['records'][1]['references'] = [ref('thread', 'fixture-worker')]
        ledger, _ = reconcile(seal(value))
        entries = [e for e in ledger['entries'].values() if e['kind'] == 'thread']
        self.assertTrue(all('cyclic_lineage' in e['reasons'] for e in entries))

    def test_message_order_and_composite_identity(self):
        value = copy.deepcopy(self.doc)
        value['records'].append(record('message', ['fixture-worker', 'fixture-message-1'],
                                       payload={'position': 1}))
        ledger, _ = reconcile(seal(value))
        self.assertEqual(sum(e['kind'] == 'message' for e in ledger['entries'].values()), 3)
        value['records'][4]['payload']['position'] = 1
        ledger, _ = reconcile(seal(value))
        entries = [e for e in ledger['entries'].values() if e['kind'] == 'message']
        self.assertEqual(sum('duplicate_position' in e['reasons'] for e in entries), 2)

    def test_parent_order_quarantined(self):
        value = copy.deepcopy(self.doc)
        value['records'][4]['payload']['position'] = 0
        ledger, _ = reconcile(seal(value))
        self.assertTrue(any('invalid_message_parent_order' in e['reasons']
                            for e in ledger['entries'].values()))

    def test_unsupported_kind_quarantined(self):
        value = copy.deepcopy(self.doc)
        value['records'].append(record('fixture-future-kind', 'fixture-new'))
        ledger, _ = reconcile(seal(value))
        self.assertEqual(self.entry(ledger, 'fixture-future-kind')['disposition'], 'QUARANTINED')

    def test_manifest_integrity(self):
        value = copy.deepcopy(self.doc)
        value['records'][0]['payload']['name'] = 'Tampered'
        with self.assertRaisesRegex(Invalid, 'manifest_digest'):
            validate_document(value, self.bundle)

    def test_counts_and_watermark_and_versions(self):
        self.check_bad(lambda d: d['consistency']['segments'].update(jobs='other'), 'inconsistent_watermark')
        self.check_bad(lambda d: d.update(version=2), 'version')
        value = copy.deepcopy(self.doc)
        value['counts']['thread'] = 999
        value['digest'] = sha({k: v for k, v in value.items() if k != 'digest'})
        with self.assertRaisesRegex(Invalid, 'record_counts'):
            validate_document(value, self.bundle)

    def test_duplicate_source_key(self):
        self.check_bad(lambda d: d['records'].append(copy.deepcopy(d['records'][0])), 'duplicate_identity')

    def test_excluded_payload_fields(self):
        for key in ('token', 'password', 'cookies', 'chat_id', 'lease_holder', 'route_target'):
            self.check_bad(lambda d: d['records'][0]['payload'].update(nested={key: 'fixture-only'}),
                           'excluded_field')

    def test_credential_and_session_kinds_excluded(self):
        for kind in ('credentials', 'session', 'browser_profile', 'private_key'):
            self.check_bad(lambda d: d['records'].append(record(kind, 'fixture-excluded')),
                           'excluded_record_kind')

    def test_path_traversal_absolute_missing_and_hash(self):
        for path in ('../outside', '/absolute', 'artifacts/../example.txt', 'artifacts\\example.txt'):
            self.check_bad(lambda d: d['artifacts'][0].update(path=path), 'unsafe_path')
        self.check_bad(lambda d: d['artifacts'][0].update(path='artifacts/missing'), 'missing_file')
        self.check_bad(lambda d: d['artifacts'][0].update(sha256='0' * 64), 'artifact_digest')

    def test_symlink_even_inside_bundle_rejected(self):
        (self.bundle / 'artifacts' / 'link').symlink_to('example.txt')
        self.check_bad(lambda d: d['artifacts'][0].update(path='artifacts/link'), 'symlink_forbidden')

    def test_duplicate_json_key_rejected(self):
        (self.bundle / 'snapshot.json').write_text('{"version":1,"version":1}')
        with self.assertRaisesRegex(Invalid, 'duplicate_json_key'):
            load(self.bundle)

    def test_nonfinite_rejected(self):
        (self.bundle / 'snapshot.json').write_text('{"a":NaN}')
        with self.assertRaisesRegex(Invalid, 'nonfinite'):
            load(self.bundle)

    def test_atomic_persist_reopen_repeat_source_unchanged(self):
        before = {str(p): p.read_bytes() for p in self.bundle.rglob('*') if p.is_file()}
        plan_to_file(self.bundle, self.ledger_path)
        first = self.ledger_path.read_bytes()
        counts = plan_to_file(self.bundle, self.ledger_path)
        self.assertEqual(first, self.ledger_path.read_bytes())
        self.assertEqual(counts, {'duplicates': 16})
        self.assertEqual(stat.S_IMODE(self.ledger_path.stat().st_mode), 0o600)
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.bundle.rglob('*') if p.is_file()})

    def test_no_output_inside_source_or_symlink(self):
        with self.assertRaisesRegex(Invalid, 'source_output_overlap'):
            plan_to_file(self.bundle, self.bundle / 'plan.json')
        self.ledger_path.symlink_to(self.root / 'other')
        with self.assertRaisesRegex(Invalid, 'output_symlink'):
            plan_to_file(self.bundle, self.ledger_path)

    def test_concurrent_cli_planners_keep_one_mapping(self):
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1')
        processes = [subprocess.Popen([sys.executable, str(CLI), 'plan', str(self.bundle),
                                      str(self.ledger_path)], stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, env=env) for _ in range(3)]
        for process in processes:
            stdout, stderr = process.communicate(timeout=15)
            self.assertEqual(process.returncode, 0, stderr)
            self.assertFalse(json.loads(stdout)['dispatch_allowed'])
        self.assertEqual(len(json.loads(self.ledger_path.read_text())['entries']), 16)

    def test_recovery_includes_v2_only_delta_and_preserves_legacy(self):
        plan_to_file(self.bundle, self.ledger_path)
        before = json.loads(self.ledger_path.read_text())
        delta = document()
        delta.update(source_instance='fixture-v2-instance', origin='v2_delta')
        delta['records'] = [record('thread', 'fixture-v2-thread')]
        delta_root = self.root / 'delta'
        write_bundle(delta_root, delta)
        plan_to_file(delta_root, self.ledger_path)
        after = json.loads(self.ledger_path.read_text())
        self.assertEqual(len(after['entries']), 17)
        self.assertTrue(all(after['entries'][key] == value for key, value in before['entries'].items()))
        archive, restored = self.root / 'archive.json', self.root / 'restored.json'
        recovery_export(self.ledger_path, archive)
        recovery_restore(archive, restored)
        self.assertEqual(after, json.loads(restored.read_text()))
        self.assertEqual(sum(e['origin'] == 'v2_delta' for e in after['entries'].values()), 1)
        with self.assertRaisesRegex(Invalid, 'restore_target_exists'):
            recovery_restore(archive, restored)
        with self.assertRaisesRegex(Invalid, 'recovery_target_exists'):
            recovery_export(self.ledger_path, archive)

    def test_corrupt_recovery_and_authority_refused(self):
        plan_to_file(self.bundle, self.ledger_path)
        archive = self.root / 'archive.json'
        recovery_export(self.ledger_path, archive)
        value = json.loads(archive.read_text())
        value['ledger']['dispatch_allowed'] = True
        archive.write_text(json.dumps(value))
        with self.assertRaisesRegex(Invalid, 'recovery_digest'):
            recovery_restore(archive, self.root / 'restored')
        value['digest'] = sha({k: v for k, v in value.items() if k != 'digest'})
        archive.write_text(json.dumps(value))
        with self.assertRaisesRegex(Invalid, 'ledger_authority'):
            recovery_restore(archive, self.root / 'restored')

    def test_bundle_export_restore_fresh_inert_only(self):
        # Unlisted source files (including auth-like material) are never copied.
        (self.bundle / 'unlisted-auth.fixture').write_text('fake-excluded-data')
        exported, restored = self.root / 'exported', self.root / 'restored'
        copy_bundle(self.bundle, exported)
        copy_bundle(exported, restored)
        self.assertEqual(load(self.bundle), load(restored))
        self.assertFalse((restored / 'unlisted-auth.fixture').exists())
        self.assertEqual(stat.S_IMODE(restored.stat().st_mode), 0o700)
        with self.assertRaisesRegex(Invalid, 'bundle_target_exists'):
            copy_bundle(self.bundle, restored)
        with self.assertRaisesRegex(Invalid, 'source_output_overlap'):
            copy_bundle(self.bundle, self.bundle / 'nested')

    def test_copy_refuses_alias_and_bad_source_without_partial_output(self):
        alias = self.root / 'alias'
        alias.symlink_to(self.bundle, target_is_directory=True)
        with self.assertRaisesRegex(Invalid, 'snapshot_root_alias'):
            copy_bundle(alias, self.root / 'copied')
        (self.bundle / 'artifacts' / 'example.txt').write_text('Changed bytes')
        with self.assertRaises(Invalid):
            copy_bundle(self.bundle, self.root / 'copied')
        self.assertFalse((self.root / 'copied').exists())

    def test_missing_artifact_reference_quarantined(self):
        value = copy.deepcopy(self.doc)
        value['records'][9]['payload']['path'] = 'artifacts/missing'
        ledger, _ = reconcile(seal(value))
        self.assertEqual(self.entry(ledger, 'artifact')['disposition'], 'QUARANTINED')

    def test_cli_bad_input_does_not_leak_paths(self):
        result = subprocess.run([sys.executable, str(CLI), 'validate', str(self.root / 'private-missing')],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn(str(self.root), result.stderr)
        self.assertEqual(json.loads(result.stderr)['code'], 'snapshot_root')


if __name__ == '__main__':
    unittest.main()
