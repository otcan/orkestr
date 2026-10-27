"""Passive Codex quota projection: synthetic notifications only, no provider process."""
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

from codex_quota import QuotaSink, project
from protocol import Refused
from test_capacity_evidence import NATIVE, active, failed
from test_protocol import opened

OWNER = '10000000-0000-4000-8000-000000000001'
ACCOUNT = '30000000-0000-4000-8000-000000000001'
WEEKLY = {'usedPercent': 4, 'windowDurationMins': 10080, 'resetsAt': 1793599861}


def update(**snapshot):
    return {'method': 'account/rateLimits/updated', 'params': {'rateLimits': snapshot}}


class CodexQuotaProjectionTests(unittest.TestCase):
    def test_account_windows_by_duration_never_account_metadata(self):
        result = project({'limitId': 'codex', 'planType': 'pro', 'credits': {'balance': 'never-copied'},
                          'primary': WEEKLY, 'secondary': None}, 1000)
        self.assertEqual(result, {'seven_day': {'used_percent': 4, 'resets_at': 1793599861,
                                                'status': None, 'observed_at': 1000}})
        both = project({'primary': {'usedPercent': 20, 'windowDurationMins': 300, 'resetsAt': 2000000000},
                        'secondary': {'usedPercent': 41, 'windowDurationMins': 10080}}, 1000)
        self.assertEqual((both['five_hour']['used_percent'], both['seven_day']['used_percent']), (20, 41))
        self.assertIsNone(both['seven_day']['resets_at'])
        self.assertNotIn('never-copied', json.dumps(result))

    def test_model_specific_unknown_and_invalid_windows_are_not_projected(self):
        self.assertEqual(project({'limitId': 'codex_other', 'normalModelSlug': 'm', 'primary': WEEKLY}, 1000), {})
        for window in ({'usedPercent': 4, 'windowDurationMins': 1440}, {'usedPercent': 4},
                       {'usedPercent': True, 'windowDurationMins': 300}, {'usedPercent': 101, 'windowDurationMins': 300},
                       {'usedPercent': -1, 'windowDurationMins': 300}, {'usedPercent': '4', 'windowDurationMins': 300}):
            self.assertEqual(project({'primary': window}, 1000), {}, window)
        for value in (None, [], 'codex'):
            self.assertEqual(project(value, 1000), {})

    def test_sparse_updates_keep_each_window_observation_and_refuse_other_owners(self):
        with tempfile.TemporaryDirectory() as root:
            sink = QuotaSink(root, OWNER, ACCOUNT, os.getuid())
            sink.observe(OWNER, {'rateLimits': {'primary': WEEKLY}})
            sink.observe(OWNER, {'rateLimits': {'primary': {'usedPercent': 9, 'windowDurationMins': 300}}})
            path = Path(root) / 'codex.json'
            value = json.loads(path.read_text())
            self.assertEqual((value['format'], value['provider'], value['owner_id'], value['account_ref']),
                             ('orkestr-provider-quota-v1', 'codex', OWNER, ACCOUNT))
            self.assertEqual(set(value['windows']), {'five_hour', 'seven_day'})
            self.assertEqual(value['windows']['seven_day']['used_percent'], 4)
            self.assertEqual(path.stat().st_mode & 0o777, 0o640)
            self.assertFalse((Path(root) / 'claude.json').exists())
            before = path.read_bytes()
            sink.observe(ACCOUNT, {'rateLimits': {'primary': {**WEEKLY, 'usedPercent': 80}}})
            sink.observe(OWNER, {'rateLimits': {'limitId': 'codex_other', 'primary': {**WEEKLY, 'usedPercent': 80}}})
            self.assertEqual(path.read_bytes(), before)

    def test_symlink_and_writable_directory_refuse(self):
        for kind in ('symlink', 'directory'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as root:
                root = Path(root); outside = root / 'unrelated'; outside.write_text('unchanged')
                if kind == 'symlink':
                    (root / 'codex.json').symlink_to(outside)
                else:
                    root.chmod(0o770)
                with self.assertRaises((OSError, ValueError)):
                    QuotaSink(root, OWNER, ACCOUNT, os.getuid()).observe(OWNER, {'rateLimits': {'primary': WEEKLY}})
                self.assertEqual(outside.read_text(), 'unchanged')

    def test_operator_binding_is_optional_and_cannot_share_private_state(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root); directory = root / 'quota'; directory.mkdir(mode=0o750)
            package = SimpleNamespace(owner=OWNER, uid=os.getuid(), home=root / 'home', root=root / 'release',
                                      ledger_directory=root / 'ledger', endpoint=root / 'endpoints' / 'egress.sock',
                                      provider_home=root / 'home' / 'provider-home', runtime={})
            self.assertIsNone(QuotaSink.optional(package))
            package.runtime = {'claude_quota_projection': {'directory': str(directory), 'account_ref': ACCOUNT}}
            self.assertIsNone(QuotaSink.optional(package), 'the Claude binding never enables Codex')
            package.runtime = {'codex_quota_projection': {'directory': str(directory), 'account_ref': ACCOUNT}}
            self.assertIsInstance(QuotaSink.optional(package), QuotaSink)
            config = SimpleNamespace(workspace=root / 'workspace', host_environment={'HOME': str(root)})
            self.assertIsNone(QuotaSink.optional(package, config), 'real CODEX_HOME/HOME stays private')
            package.home = directory
            self.assertIsNone(QuotaSink.optional(package))


class CodexQuotaChannelTests(unittest.TestCase):
    def test_update_is_observed_but_never_forwarded_or_execution_evidence(self):
        channel = active(); calls = []
        channel.quota_observer = lambda owner, params: calls.append((owner, params))
        self.assertIsNone(channel.provider(update(primary=WEEKLY)))
        self.assertEqual(calls, [('synthetic-owner', {'rateLimits': {'primary': WEEKLY}})])
        self.assertFalse(channel.terminal)
        self.assertEqual(failed(channel)['sideEffects'], False)

    def test_before_commit_and_without_observer_it_stays_ignored(self):
        channel, _ = opened(); calls = []
        self.assertIsNone(channel.provider(update(primary=WEEKLY)))
        channel.quota_observer = lambda owner, params: calls.append(owner)
        self.assertIsNone(channel.provider(update(primary=WEEKLY)))
        self.assertEqual(calls, ['synthetic-owner'])

    def test_sink_error_is_isolated_but_stop_refusal_propagates(self):
        channel = active()
        def broken(_owner, _params): raise PermissionError('synthetic cache failure')
        channel.quota_observer = broken
        self.assertIsNone(channel.provider(update(primary=WEEKLY)))
        self.assertFalse(channel.terminal)
        def stopped(_owner, _params): raise Refused('synthetic stop')
        channel.quota_observer = stopped
        with self.assertRaises(Refused):
            channel.provider(update(primary=WEEKLY))


if __name__ == '__main__':
    unittest.main()
