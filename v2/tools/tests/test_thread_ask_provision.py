"""Offline checks for thread-ask grant provisioning against a fake API."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location(
    "thread_ask_provision", Path(__file__).resolve().parents[1] / "thread_ask_provision.py")
PROV = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROV)

A, B, C, R = (f'00000000-0000-4000-8000-00000000000{n}' for n in 'abcd')


class FakeApi:
    def __init__(self):
        self.grants = {}   # conversation -> (grant, targets)
        self.eligible = {A: True, B: True, C: True, R: False}
        self.calls, self.counter = [], 0

    def directory(self):
        rows = []
        for conversation, eligible in self.eligible.items():
            issued = self.grants.get(conversation)
            rows.append({'conversation_id': conversation, 'name': 'T' + conversation[-1], 'eligible': eligible,
                         'grant': {'conversation_id': conversation, 'issued': issued is not None,
                                   'generation': self.counter, 'targets': issued[1] if issued else None}})
        return rows

    def issue(self, conversation, targets):
        self.calls.append(('issue', conversation))
        self.counter += 1
        grant = f'{self.counter:064x}'
        self.grants[conversation] = (grant, list(targets))
        return {'grant': grant}

    def revoke(self, conversation):
        self.calls.append(('revoke', conversation))
        self.grants.pop(conversation, None)


class Provision(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.dir = Path(self.temp.name) / 'grants'
        self.api = FakeApi()

    def tearDown(self):
        self.temp.cleanup()

    def run_main(self, *extra):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = PROV.main(['--v2-url', 'http://127.0.0.1:1', '--credentials', 'unused',
                              '--grant-dir', str(self.dir), *(extra or ('--all-owner-conversations', '--all-targets', '--i-understand'))],
                             api=self.api)
        return code, [json.loads(line) for line in out.getvalue().splitlines()]

    def test_issues_installs_and_is_idempotent(self):
        code, lines = self.run_main()
        self.assertEqual(code, 0)
        self.assertEqual({l['conversation_id']: l['action'] for l in lines}, {A: 'issue', B: 'issue', C: 'issue'})
        # Each allowlist is exactly the owner's other eligible conversations.
        self.assertEqual(sorted(self.api.grants[A][1]), [B, C])
        for conversation in (A, B, C):
            path = self.dir / f'{conversation}.grant'
            self.assertEqual(path.read_text().strip(), self.api.grants[conversation][0])
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.dir / f'{R}.grant').exists())
        self.assertNotIn(self.api.grants[A][0], json.dumps(lines))
        # A second run changes nothing.
        before = list(self.api.calls)
        code, lines = self.run_main()
        self.assertEqual({l['action'] for l in lines}, {'unchanged'})
        self.assertEqual(self.api.calls, before)

    def test_changed_allowlist_missing_file_rotate_and_revoke(self):
        self.run_main()
        # A conversation becomes ineligible: it is revoked, the others re-issued.
        self.api.eligible[C] = False
        os.remove(self.dir / f'{C}.grant')
        _, lines = self.run_main()
        actions = {l['conversation_id']: l['action'] for l in lines}
        self.assertEqual(actions, {A: 'rotate', B: 'rotate', C: 'revoke'})
        self.assertEqual(self.api.grants[A][1], [B])
        # A missing file is re-issued; --rotate rotates everything selected.
        os.remove(self.dir / f'{A}.grant')
        _, lines = self.run_main()
        self.assertEqual({l['conversation_id']: l['action'] for l in lines}, {A: 'rotate', B: 'unchanged'})
        old = self.api.grants[B][0]
        _, lines = self.run_main('--rotate', '--only', 'Tb', '--all-targets', '--i-understand')
        self.assertEqual([l['action'] for l in lines], ['rotate'])
        self.assertNotEqual(self.api.grants[B][0], old)
        _, lines = self.run_main('--revoke', '--all-owner-conversations')
        self.assertEqual({l['action'] for l in lines}, {'revoke'})
        self.assertEqual(self.api.grants, {})
        self.assertEqual(list(self.dir.glob('*.grant')), [])

    def test_dry_run_writes_nothing(self):
        _, lines = self.run_main('--dry-run', '--all-owner-conversations', '--all-targets', '--i-understand')
        self.assertEqual({l['action'] for l in lines}, {'issue'})
        self.assertEqual(self.api.calls, [])
        self.assertFalse(self.dir.exists())

    def test_selection_is_explicit_and_names_resolve(self):
        with self.assertRaises(SystemExit):
            with contextlib.redirect_stderr(io.StringIO()):
                PROV.main(['--v2-url', 'http://x', '--credentials', 'c', '--grant-dir', str(self.dir)], api=self.api)
        code, lines = self.run_main('--only', 'ta', C, '--all-targets', '--i-understand')
        self.assertEqual(code, 0)
        self.assertEqual({l['conversation_id'] for l in lines}, {A, C})
        # The acknowledged wide form: every other eligible conversation.
        self.assertEqual(sorted(self.api.grants[A][1]), [B, C])
        err = io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            code = PROV.main(['--v2-url', 'http://x', '--credentials', 'c', '--grant-dir', str(self.dir),
                              '--only', 'nobody', '--targets', B], api=self.api)
        self.assertEqual((code, json.loads(err.getvalue())['code']), (2, 'unknown_conversation:nobody'))

    def test_allowlist_above_the_cap_fails_clearly(self):
        for n in range(PROV.TARGETS_MAX + 1):
            self.api.eligible[f'10000000-0000-4000-8000-{n:012x}'] = True
        code, lines = self.run_main('--only', A, '--all-targets', '--i-understand')
        self.assertEqual(code, 1)
        self.assertEqual((lines[0]['action'], lines[0]['code']), ('failed', 'allowlist_too_large'))
        self.assertEqual(self.api.calls, [])

    def refused(self, *extra):
        err = io.StringIO()
        with self.assertRaises(SystemExit) as raised, contextlib.redirect_stderr(err):
            PROV.main(['--v2-url', 'http://x', '--credentials', 'c', '--grant-dir', str(self.dir), *extra],
                      api=self.api)
        self.assertEqual(raised.exception.code, 2)
        self.assertEqual(self.api.calls, [])
        return err.getvalue()

    def test_only_without_an_allowlist_refuses(self):
        # `--only X` used to give X every other conversation (115 in prod).
        self.assertIn('--targets', self.refused('--only', A))
        self.assertIn('--targets', self.refused('--only', A, '--dry-run'))
        self.assertIn('--targets', self.refused('--all-owner-conversations'))
        self.assertIn('--i-understand', self.refused('--only', A, '--all-targets'))
        self.refused('--only', A, '--targets', B, '--all-targets', '--i-understand')
        self.refused('--only', A, '--revoke', '--targets', B)
        self.assertFalse(self.dir.exists())

    def test_explicit_targets_scope_the_grant(self):
        code, lines = self.run_main('--only', 'Ta', '--targets', 'tb')
        self.assertEqual(code, 0)
        self.assertEqual(self.api.grants, {A: (self.api.grants[A][0], [B])})
        self.assertEqual(lines[0]['action'], 'issue')
        self.assertEqual(lines[0]['targets_added'], [{'id': B, 'name': 'Tb'}])
        # Comma-separated and repeated forms; the asker is dropped from its own list.
        code, lines = self.run_main('--only', B, C, '--targets', f'{B},Tc', '--targets', A)
        self.assertEqual(code, 0)
        self.assertEqual(sorted(self.api.grants[B][1]), [A, C])
        self.assertEqual(sorted(self.api.grants[C][1]), [A, B])
        # Rerun with the same list: unchanged, no API call.
        before = list(self.api.calls)
        _, lines = self.run_main('--only', A, '--targets', B)
        self.assertEqual([l['action'] for l in lines], ['unchanged'])
        self.assertEqual(self.api.calls, before)
        # An ineligible or unknown target refuses the whole run.
        err = io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            code = PROV.main(['--v2-url', 'http://x', '--credentials', 'c', '--grant-dir', str(self.dir),
                              '--only', A, '--targets', R], api=self.api)
        self.assertEqual((code, json.loads(err.getvalue())['code']), (2, 'target_not_eligible:Td'))
        self.assertEqual(self.api.calls, before)

    def test_an_issued_grant_is_never_widened_silently(self):
        self.run_main('--only', A, '--targets', B)
        grant = self.api.grants[A]
        # The old wide form against the scoped grant: refused, grant untouched.
        code, lines = self.run_main('--only', A, '--all-targets', '--i-understand')
        self.assertEqual(code, 1)
        self.assertEqual((lines[0]['action'], lines[0]['reason'], lines[0]['code']),
                         ('failed', 'widen_refused', 'widen_requires_allow_widen'))
        self.assertEqual(lines[0]['targets_added'], [{'id': C, 'name': 'Tc'}])
        code, lines = self.run_main('--only', A, '--targets', f'{B},{C}')
        self.assertEqual(code, 1)
        self.assertEqual(self.api.grants[A], grant)
        # A wide fleet run widens nothing either, when new conversations appear.
        self.api.grants.clear()
        self.run_main()
        self.api.eligible['00000000-0000-4000-8000-00000000000e'] = True
        before = dict(self.api.grants)
        code, lines = self.run_main()
        self.assertEqual(code, 1)
        self.assertEqual({l['conversation_id']: l.get('reason') for l in lines if l['action'] == 'failed'},
                         {A: 'widen_refused', B: 'widen_refused', C: 'widen_refused'})
        for conversation in (A, B, C):
            self.assertEqual(self.api.grants[conversation], before[conversation])
        # Explicit --allow-widen does it, and says what was added.
        code, lines = self.run_main('--only', A, '--targets', f'{B},{C},Te', '--allow-widen')
        self.assertEqual(code, 0)
        self.assertEqual(lines[0]['action'], 'rotate')
        self.assertEqual([t['name'] for t in lines[0]['targets_added']], ['Te'])

    def test_narrowing_is_allowed_and_dry_run_shows_the_diff(self):
        self.run_main('--only', A, '--all-targets', '--i-understand')
        before = list(self.api.calls)
        code, lines = self.run_main('--only', A, '--targets', C, '--dry-run')
        self.assertEqual(code, 0)
        self.assertEqual(self.api.calls, before)
        self.assertEqual(lines[0]['action'], 'rotate')
        self.assertTrue(lines[0]['dry_run'])
        self.assertEqual((lines[0]['targets'], lines[0]['targets_added'], lines[0]['targets_removed']),
                         (1, [], [{'id': B, 'name': 'Tb'}]))
        # A widening dry run reports the refusal and the would-be additions.
        _, lines = self.run_main('--only', B, '--targets', A, '--dry-run')
        self.assertEqual(lines[0]['action'], 'issue')
        self.run_main('--only', A, '--targets', C)
        self.assertEqual(self.api.grants[A][1], [C])
        code, lines = self.run_main('--only', A, '--targets', f'{B},{C}', '--dry-run')
        self.assertEqual((code, lines[0]['reason']), (1, 'widen_refused'))
        self.assertEqual(lines[0]['targets_added'], [{'id': B, 'name': 'Tb'}])
        self.assertEqual(self.api.grants[A][1], [C])

    def test_credentials_must_be_private(self):
        path = Path(self.temp.name) / 'creds.json'
        path.write_text(json.dumps({'username': 'u', 'password': 'p'}))
        path.chmod(0o644)
        with self.assertRaises(PROV.ProvisionError):
            PROV.private_json(path)
        path.chmod(0o600)
        self.assertEqual(PROV.private_json(path)['username'], 'u')


if __name__ == '__main__':
    unittest.main()
