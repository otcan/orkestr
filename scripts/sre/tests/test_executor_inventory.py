import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('inventory', Path(__file__).parents[1] / 'executor_inventory.py')
inv = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inv)
NATIVE = '10000000-0000-0000-0000-000000000001'


class InventoryTests(unittest.TestCase):
    def reconcile(self, **overrides):
        data = dict(processes=[], panes=[], transcripts=[], core=[], legacy=[], routes={}, proposals=[], observations=[])
        data.update(overrides)
        return inv.reconcile(**data)

    def test_stale_legacy_does_not_override_core_or_route(self):
        report = self.reconcile(
            core=[dict(provider_kind='codex', native_session_id=NATIVE, conversation_id='new', role='deep', state='ready')],
            legacy=[dict(apiSessionId=NATIVE, threadId='old', lastSeenAt='2000-01-01', secret='NEVER-EXPORT')],
            routes={'old': dict(backend='v2', conversation='new', password='NEVER-EXPORT')})
        row = report['executors'][0]
        self.assertEqual(row['ownership'], 'core-bound')
        self.assertEqual(row['core_bindings'][0]['conversation_id'], 'new')
        self.assertEqual(report['posting_routes'][0]['backend'], 'v2')
        self.assertEqual(row['liveness'], 'not-established')
        self.assertNotIn('NEVER-EXPORT', json.dumps(report))

    def test_duplicate_process_identity_and_mirrored_panes(self):
        processes = [dict(pid=p, ppid=1, provider='codex', native_session_id=NATIVE,
                          source='proc', kind='executor', ancestors=[9]) for p in [10, 11]]
        pane = dict(pid=9, pane='%1', socket='socket', views=['main:0.0', 'mirror:0.0'])
        report = self.reconcile(processes=processes, panes=[pane])
        self.assertEqual(len(report['executors']), 1)
        self.assertEqual(len(report['executors'][0]['processes']), 2)
        self.assertEqual(len(report['executors'][0]['panes']), 1)

    def test_duplicate_symlink_homes(self):
        with tempfile.TemporaryDirectory() as tmp:
            real = Path(tmp) / 'real'
            real.mkdir()
            (Path(tmp) / 'alias').symlink_to(real)
            self.assertEqual(inv.unique_homes([real, Path(tmp) / 'alias']), [str(real)])

    def test_recent_transcript_is_not_liveness_or_binding(self):
        p = dict(pid=10, ppid=1, provider='claude', native_session_id=NATIVE, source='proc', kind='executor')
        report = self.reconcile(processes=[p], proposals=[dict(native_session_id=NATIVE, role='investigator', project='test')])
        row = report['executors'][0]
        self.assertEqual(row['ownership'], 'unknown')
        self.assertEqual(row['core_bindings'], [])
        self.assertEqual(row['proposed_linkage'][0]['role'], 'investigator')

    def test_observation_requires_same_process_incarnation(self):
        p = dict(pid=10, ppid=1, provider='codex', native_session_id=None, source='proc', kind='executor', start_ticks='2')
        o = dict(pid=10, provider='codex', native_session_id=NATIVE, start_ticks='1')
        report = self.reconcile(processes=[p], observations=[o])
        self.assertIsNone(report['executors'][0]['native_session_id'])

    def test_readonly_core_projection_omits_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'core.sqlite3'
            with sqlite3.connect(path) as db:
                db.execute('CREATE TABLE session_bindings(conversation_id,role,provider_kind,native_session_id,generation,state)')
                db.execute('INSERT INTO session_bindings VALUES(?,?,?,?,?,?)', ('c','deep','codex',NATIVE,1,'ready'))
                db.execute('CREATE TABLE auth_sessions(token_hash)')
                db.execute("INSERT INTO auth_sessions VALUES('NEVER-EXPORT')")
            self.assertNotIn('NEVER-EXPORT', json.dumps(inv.bindings(path)))
            inv.write_private(Path(tmp) / 'report.json', '{}')
            self.assertEqual(os.stat(Path(tmp) / 'report.json').st_mode & 0o777, 0o600)

    def test_parent_chain_crosses_wrapper_processes(self):
        with tempfile.TemporaryDirectory() as tmp:
            for pid, parent in [(30, 20), (20, 10), (10, 1)]:
                p = Path(tmp) / str(pid)
                p.mkdir()
                (p / 'status').write_text('PPid:\t' + str(parent) + '\n')
            self.assertEqual(inv.parent_chain(30, tmp), [20, 10, 1])

    def test_proc_does_not_export_arguments_or_env(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc = Path(tmp) / '42'
            proc.mkdir()
            (proc / 'comm').write_text('codex')
            (proc / 'cmdline').write_bytes(b'/bin/codex\0resume\0' + NATIVE.encode() + b'\0--password\0NEVER-EXPORT\0')
            (proc / 'status').write_text('PPid:\t1\n')
            (proc / 'stat').write_text('42 (codex) ' + ' '.join(['0'] * 22))
            report = inv.proc_inventory(tmp)
            self.assertEqual(report[0]['native_session_id'], NATIVE)
            self.assertNotIn('NEVER-EXPORT', json.dumps(report))

    def test_inherited_other_provider_identity_and_open_transcript_do_not_bind(self):
        with tempfile.TemporaryDirectory() as tmp:
            for pid, provider, variable in [(42, 'claude', 'CODEX_THREAD_ID'), (43, 'codex', 'CLAUDE_SESSION_ID')]:
                proc = Path(tmp) / str(pid)
                proc.mkdir()
                (proc / 'cmdline').write_bytes(f'/bin/{provider}\0'.encode())
                (proc / 'status').write_text('PPid:\t1\n')
                (proc / 'stat').write_text(f'{pid} ({provider}) ' + ' '.join(['0'] * 22))
                (proc / 'environ').write_bytes(f'{variable}={NATIVE}\0SECRET=NEVER-EXPORT\0'.encode())
                (proc / 'fd').mkdir()
                (proc / 'fd/3').symlink_to(f'/synthetic/sessions/rollout-{NATIVE}.jsonl')
            report = inv.proc_inventory(tmp)
            self.assertEqual(len(report), 2)
            self.assertTrue(all(row['native_session_id'] is None for row in report))
            self.assertNotIn('NEVER-EXPORT', json.dumps(report))

    def test_provider_specific_resume_and_environment_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            for pid, args, environment in [(42, ['/bin/claude', '--resume', NATIVE], b''),
                                            (43, ['/bin/codex', 'app-server'], f'CODEX_THREAD_ID={NATIVE}\0'.encode())]:
                proc = Path(tmp) / str(pid)
                proc.mkdir()
                (proc / 'cmdline').write_bytes(('\0'.join(args) + '\0').encode())
                (proc / 'status').write_text('PPid:\t1\n')
                (proc / 'stat').write_text(f'{pid} (synthetic) ' + ' '.join(['0'] * 22))
                (proc / 'environ').write_bytes(environment)
            report = inv.proc_inventory(tmp)
            self.assertTrue(all(row['native_session_id'] == NATIVE for row in report))
            self.assertEqual(next(row for row in report if row['pid'] == 43)['kind'], 'infrastructure')


if __name__ == '__main__':
    unittest.main()
