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
                              '--grant-dir', str(self.dir), *(extra or ('--all-owner-conversations',))],
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
        _, lines = self.run_main('--rotate', '--only', 'Tb')
        self.assertEqual([l['action'] for l in lines], ['rotate'])
        self.assertNotEqual(self.api.grants[B][0], old)
        _, lines = self.run_main('--revoke', '--all-owner-conversations')
        self.assertEqual({l['action'] for l in lines}, {'revoke'})
        self.assertEqual(self.api.grants, {})
        self.assertEqual(list(self.dir.glob('*.grant')), [])

    def test_dry_run_writes_nothing(self):
        _, lines = self.run_main('--dry-run', '--all-owner-conversations')
        self.assertEqual({l['action'] for l in lines}, {'issue'})
        self.assertEqual(self.api.calls, [])
        self.assertFalse(self.dir.exists())

    def test_selection_is_explicit_and_names_resolve(self):
        with self.assertRaises(SystemExit):
            with contextlib.redirect_stderr(io.StringIO()):
                PROV.main(['--v2-url', 'http://x', '--credentials', 'c', '--grant-dir', str(self.dir)], api=self.api)
        code, lines = self.run_main('--only', 'ta', C)
        self.assertEqual(code, 0)
        self.assertEqual({l['conversation_id'] for l in lines}, {A, C})
        # The allowlist is still every other eligible conversation.
        self.assertEqual(sorted(self.api.grants[A][1]), [B, C])
        err = io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            code = PROV.main(['--v2-url', 'http://x', '--credentials', 'c', '--grant-dir', str(self.dir),
                              '--only', 'nobody'], api=self.api)
        self.assertEqual((code, json.loads(err.getvalue())['code']), (2, 'unknown_conversation:nobody'))

    def test_allowlist_above_the_cap_fails_clearly(self):
        for n in range(PROV.TARGETS_MAX + 1):
            self.api.eligible[f'10000000-0000-4000-8000-{n:012x}'] = True
        code, lines = self.run_main('--only', A)
        self.assertEqual(code, 1)
        self.assertEqual((lines[0]['action'], lines[0]['code']), ('failed', 'allowlist_too_large'))
        self.assertEqual(self.api.calls, [])

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
