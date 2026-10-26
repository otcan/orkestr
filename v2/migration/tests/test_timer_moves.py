"""Timer moves between V1 and V2 keep exactly one owner at every step."""
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import thread_timers
import timer_moves
import v2_client

CONVERSATION = '6a2a1f0e-9b7c-4d3e-8f10-112233445566'


def v1_timer(timer_id, cadence='daily', enabled=True, thread='thread-a', **extra):
    timer = {'id': timer_id, 'label': 'Synthetic ' + timer_id, 'targetType': 'thread', 'target': thread,
             'cadence': cadence, 'time': '09:00', 'every': None, 'runAt': '', 'timezone': 'Europe/Berlin',
             'prompt': 'Synthetic instruction ' + timer_id, 'promptFile': '', 'enabled': enabled,
             'nextRunAt': '2026-10-23T07:00:00.000Z', 'createdAt': '2026-01-01T00:00:00.000Z'}
    timer.update(extra)
    return timer


class FakeV1:
    """Mirrors the V1 ownership fence contract."""

    def __init__(self, timers):
        self.timers_by_id = {t['id']: dict(t) for t in timers}
        self.calls = []

    def timers(self):
        return [dict(t) for t in self.timers_by_id.values()]

    def handoff(self, timer_id, handoff_id):
        self.calls.append(('handoff', timer_id))
        timer = self.timers_by_id[timer_id]
        if timer.get('ownedBy') == 'v2':
            if timer['ownership']['handoffId'] != handoff_id:
                raise timer_moves.MoveError('v1_cli_refused:timer_ownership_conflict')
            return {'timer': timer, 'changed': False}
        timer.update(ownedBy='v2', ownership={'owner': 'v2', 'handoffId': handoff_id,
                                              'enabledBeforeHandoff': timer['enabled']}, enabled=False, nextRunAt=None)
        return {'timer': timer, 'changed': True}

    def handback(self, timer_id, handoff_id, keep_disabled=False):
        self.calls.append(('handback', timer_id))
        timer = self.timers_by_id[timer_id]
        if timer.get('ownedBy') != 'v2' or timer['ownership']['handoffId'] != handoff_id:
            raise timer_moves.MoveError('v1_cli_refused:timer_ownership_conflict')
        enabled = False if keep_disabled else timer['ownership']['enabledBeforeHandoff']
        timer.pop('ownedBy')
        timer.update(enabled=enabled, ownership={'owner': 'v1', 'handoffId': handoff_id},
                     nextRunAt='2026-10-21T07:00:00.000Z' if enabled else None)
        return {'timer': timer, 'changed': True}


class FakeV2:
    """Mirrors the V2 owner timer routes used by the move."""

    def __init__(self):
        self.timers, self.calls = {}, []
        self.refuse_enable = None

    def post(self, path, body):
        self.calls.append(('POST', path))
        if path == '/api/v2/timers/import':
            current = self.timers.setdefault(body['namespace'], dict(body, state='paused', revision=1, keys=set()))
            if current['conversation_id'] != body['conversation_id'] or current['label'] != body['label']:
                raise v2_client.ApiError(409, 'timer_conflict')
            return self.detail(body['namespace'])
        namespace, action = path.split('/')[4:6]
        timer = self.timers[namespace]
        if action == 'enable':
            if self.refuse_enable is not None:
                status, self.refuse_enable = self.refuse_enable, None
                raise v2_client.ApiError(status, 'timer_conflict' if status else 'unreachable')
            if body['request_key'] in timer['keys']:
                return self.detail(namespace)
            if timer['state'] not in ('paused', 'disabled') or body['expected_revision'] != timer['revision'] or \
                    body['conversation_id'] != timer['conversation_id'] or timer['schedule']['kind'] == 'dormant':
                raise v2_client.ApiError(409, 'timer_conflict')
            assert body['text'].startswith('Synthetic instruction')
            timer['keys'].add(body['request_key'])
            timer.update(state='enabled', revision=timer['revision'] + 1)
        else:
            if body['expected_revision'] != timer['revision']:
                raise v2_client.ApiError(409, 'timer_conflict')
            timer.update(state='disabled', revision=timer['revision'] + 1)
        return self.detail(namespace)

    def detail(self, namespace):
        timer = self.timers[namespace]
        return {'namespace': namespace, 'state': timer['state'], 'revision': timer['revision'],
                'conversation_id': timer['conversation_id'], 'controller_armed': timer['state'] == 'enabled',
                'controller_hold': None, 'next_due_ms': 1 if timer['state'] == 'enabled' else None}

    def get(self, path, query=None):
        self.calls.append(('GET', path))
        if path.endswith('/timers'):
            return {'timers': [self.detail(ns) for ns in self.timers]}
        namespace = path.rsplit('/', 1)[1]
        if namespace not in self.timers:
            raise v2_client.ApiError(404, 'timer_not_found')
        return self.detail(namespace)


class ScheduleTests(unittest.TestCase):
    def test_v1_cadences_map_exactly_or_stay_dormant_with_reason(self):
        s = timer_moves.schedule_for
        self.assertEqual(s(v1_timer('d')), {'kind': 'zoned_clock', 'timezone': 'Europe/Berlin', 'weekday': None,
                                            'minute_of_day': 540})
        # V1 weekly runs on the weekday of its stored next run (Friday here).
        self.assertEqual(s(v1_timer('w', 'weekly', time='20:05', nextRunAt='2026-10-23T18:05:00Z'))['weekday'], 5)
        self.assertEqual(s(v1_timer('i', 'interval', every='8h')), {'kind': 'interval', 'every_ms': 8 * 3600000})
        self.assertEqual(s(v1_timer('o', 'once', runAt='2026-08-17T19:40:00+02:00')),
                         {'kind': 'once', 'due_ms': 1786988400000})
        self.assertEqual(s(v1_timer('n', timezone=''))['reason'], 'missing_timezone')
        self.assertEqual(s(v1_timer('n', timezone=''), 'Europe/Istanbul')['timezone'], 'Europe/Istanbul')
        self.assertEqual(s(v1_timer('z', timezone='Mars/Base'))['reason'], 'unsupported_timezone')
        self.assertEqual(s(v1_timer('x', 'interval', every='30s'))['reason'], 'ambiguous_cadence')
        self.assertEqual(s(v1_timer('y', 'cron'))['kind'], 'dormant')


class MoveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.v1 = FakeV1([v1_timer('daily'), v1_timer('paused', enabled=False), v1_timer('nozone', timezone=''),
                          v1_timer('other', thread='thread-b')])
        self.v2 = FakeV2()
        path = self.root / 'bundle.json'
        report = timer_moves.export(self.v1.timers(), ['thread-a'], path, 'synthetic-v1')
        self.assertNotIn('Synthetic instruction', json.dumps(report))
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.bundle = timer_moves.load_bundle(path)
        self.daily = next(t for t in self.bundle['timers'] if t['id'] == 'daily')

    def owners(self):
        result = timer_moves.status(self.v2, self.v1, self.bundle, 'thread-a', CONVERSATION)
        self.assertTrue(result['single_owner'])
        return {t['id']: t['owner'] for t in result['timers']}

    def test_import_handoff_rerun_and_handback_keep_one_owner(self):
        self.assertEqual({t['id'] for t in self.bundle['timers']}, {'daily', 'paused', 'nozone'})
        dry = timer_moves.import_thread(self.v2, self.bundle, 'thread-a', CONVERSATION)
        self.assertEqual(self.v2.calls, [])
        self.assertTrue(all(t['action'] == 'would_import_paused' for t in dry['timers']))
        timer_moves.import_thread(self.v2, self.bundle, 'thread-a', CONVERSATION, apply=True)
        self.assertEqual(self.owners(), {'daily': 'v1', 'paused': 'none', 'nozone': 'v1'})
        moved = timer_moves.handoff(self.v2, self.v1, self.bundle, 'thread-a', CONVERSATION, apply=True)
        results = {t['id']: t['result'] for t in moved['timers']}
        self.assertEqual(results, {'daily': 'handed_off', 'paused': 'skipped_disabled_in_v1',
                                   'nozone': 'skipped_dormant_schedule:missing_timezone'})
        self.assertEqual(self.v1.calls, [('handoff', 'daily')])
        self.assertEqual(self.owners()['daily'], 'v2')
        again = timer_moves.handoff(self.v2, self.v1, self.bundle, 'thread-a', CONVERSATION, apply=True)
        self.assertEqual(again['timers'][0]['result'], 'already_v2')
        back = timer_moves.handback(self.v2, self.v1, self.bundle, 'thread-a', timer_ids=['daily'], apply=True)
        self.assertEqual(back['timers'][0]['result'], 'handed_back')
        self.assertEqual(self.owners()['daily'], 'v1')
        self.assertTrue(self.v1.timers_by_id['daily']['enabled'])
        self.assertEqual(self.v2.timers[self.daily['namespace']]['state'], 'disabled')
        # A second move after handback uses a fresh enable key and works.
        timer_moves.handoff(self.v2, self.v1, self.bundle, 'thread-a', CONVERSATION, timer_ids=['daily'], apply=True)
        self.assertEqual(self.owners()['daily'], 'v2')

    def test_definite_v2_refusal_restores_v1_and_unknown_outcome_leaves_no_owner(self):
        timer_moves.import_thread(self.v2, self.bundle, 'thread-a', CONVERSATION, apply=True)
        self.v2.refuse_enable = 409
        moved = timer_moves.handoff(self.v2, self.v1, self.bundle, 'thread-a', CONVERSATION,
                                    timer_ids=['daily'], apply=True)
        self.assertEqual(moved['timers'][0]['result'], 'v2_refused_restored_v1:timer_conflict')
        self.assertEqual(self.owners()['daily'], 'v1')
        self.v2.refuse_enable = 0
        moved = timer_moves.handoff(self.v2, self.v1, self.bundle, 'thread-a', CONVERSATION,
                                    timer_ids=['daily'], apply=True)
        self.assertEqual(moved['timers'][0]['result'], 'uncertain_rerun_handoff')
        self.assertEqual(self.owners()['daily'], 'none')
        moved = timer_moves.handoff(self.v2, self.v1, self.bundle, 'thread-a', CONVERSATION,
                                    timer_ids=['daily'], apply=True)
        self.assertEqual(moved['timers'][0]['result'], 'handed_off')
        self.assertEqual(self.owners()['daily'], 'v2')

    def test_dry_run_changes_nothing_and_interrupted_fence_is_completed(self):
        timer_moves.import_thread(self.v2, self.bundle, 'thread-a', CONVERSATION, apply=True)
        plan = timer_moves.handoff(self.v2, self.v1, self.bundle, 'thread-a', CONVERSATION, timer_ids=['daily'])
        self.assertEqual(plan['timers'][0]['result'], 'would_hand_off')
        self.assertEqual(self.v1.calls, [])
        # Simulate a V2 enable that landed while the V1 fence record was lost.
        self.v2.timers[self.daily['namespace']].update(state='enabled', revision=2)
        result = timer_moves.status(self.v2, self.v1, self.bundle, 'thread-a', CONVERSATION)
        self.assertFalse(result['single_owner'])
        fixed = timer_moves.handoff(self.v2, self.v1, self.bundle, 'thread-a', CONVERSATION,
                                    timer_ids=['daily'], apply=True)
        self.assertEqual(fixed['timers'][0]['result'], 'fence_completed')
        self.assertEqual(self.owners()['daily'], 'v2')

    def assert_disabled_skipped(self, moved):
        row = next(t for t in moved['timers'] if t['id'] == 'paused')
        self.assertEqual(row['result'], 'skipped_disabled_in_v1')
        self.assertEqual(row['reason'], 'source_disabled')
        self.assertIn({'id': 'paused', 'reason': 'source_disabled'}, moved['skipped'])
        self.assertNotIn(('POST', '/api/v2/timers/%s/enable' % row['namespace']), self.v2.calls)
        self.assertNotIn(('handoff', 'paused'), self.v1.calls)
        self.assertEqual(self.v2.timers[row['namespace']]['state'], 'paused')
        self.assertFalse(self.v1.timers_by_id['paused']['enabled'])
        self.assertNotEqual(self.v1.timers_by_id['paused'].get('ownedBy'), 'v2')

    def test_v1_disabled_timer_is_never_enabled_in_v2_by_default(self):
        timer_moves.import_thread(self.v2, self.bundle, 'thread-a', CONVERSATION, apply=True)
        moved = timer_moves.handoff(self.v2, self.v1, self.bundle, 'thread-a', CONVERSATION, apply=True)
        self.assert_disabled_skipped(moved)
        self.assertEqual(moved['skipped'], [{'id': 'paused', 'reason': 'source_disabled'},
                                            {'id': 'nozone', 'reason': 'dormant_schedule:missing_timezone'}])

    def test_v1_disabled_timer_stays_off_even_when_selected_by_id(self):
        timer_moves.import_thread(self.v2, self.bundle, 'thread-a', CONVERSATION, apply=True)
        moved = timer_moves.handoff(self.v2, self.v1, self.bundle, 'thread-a', CONVERSATION,
                                    timer_ids=['paused'], apply=True)
        self.assert_disabled_skipped(moved)
        self.assertEqual(self.v1.calls, [])

    def test_v1_disabled_timer_stays_off_with_include_disabled(self):
        timer_moves.import_thread(self.v2, self.bundle, 'thread-a', CONVERSATION, apply=True)
        moved = timer_moves.handoff(self.v2, self.v1, self.bundle, 'thread-a', CONVERSATION,
                                    include_disabled=True, apply=True)
        self.assert_disabled_skipped(moved)
        moved = timer_moves.handoff(self.v2, self.v1, self.bundle, 'thread-a', CONVERSATION,
                                    timer_ids=['paused'], include_disabled=True, apply=True)
        self.assert_disabled_skipped(moved)
        # Enabled timers still move exactly as before.
        self.assertEqual(self.owners()['daily'], 'v2')

    def test_only_force_enable_disabled_hands_off_a_v1_disabled_timer(self):
        timer_moves.import_thread(self.v2, self.bundle, 'thread-a', CONVERSATION, apply=True)
        plan = timer_moves.handoff(self.v2, self.v1, self.bundle, 'thread-a', CONVERSATION,
                                   timer_ids=['paused'], force_enable_disabled=True)
        self.assertEqual(plan['timers'][0]['result'], 'would_hand_off')
        self.assertEqual(plan['skipped'], [])
        moved = timer_moves.handoff(self.v2, self.v1, self.bundle, 'thread-a', CONVERSATION,
                                    timer_ids=['paused'], force_enable_disabled=True, apply=True)
        row = moved['timers'][0]
        self.assertEqual((row['result'], row['forced_enable_disabled']), ('handed_off', True))
        self.assertEqual(moved['skipped'], [])
        self.assertEqual(self.v1.calls, [('handoff', 'paused')])
        self.assertEqual(self.v2.timers[row['namespace']]['state'], 'enabled')
        self.assertEqual(self.owners()['paused'], 'v2')

    def test_cli_has_separate_force_flag_and_prints_skipped_timers(self):
        common = ['handoff', '--bundle', 'b', '--thread', 'thread-a', '--conversation', CONVERSATION,
                  '--v2-url', 'http://127.0.0.1:1', '--credentials-file', 'c']
        parser = thread_timers.parser()
        args = parser.parse_args(common + ['--include-disabled'])
        self.assertEqual((args.include_disabled, args.force_enable_disabled), (True, False))
        self.assertTrue(parser.parse_args(common + ['--force-enable-disabled']).force_enable_disabled)
        timer_moves.import_thread(self.v2, self.bundle, 'thread-a', CONVERSATION, apply=True)
        moved = timer_moves.handoff(self.v2, self.v1, self.bundle, 'thread-a', CONVERSATION, apply=True)
        out = io.StringIO()
        thread_timers._summarize_skipped(moved, out)
        self.assertEqual(out.getvalue(), 'handoff skipped 2 timer(s): paused (source_disabled), '
                                         'nozone (dormant_schedule:missing_timezone)\n')
        self.assertNotIn('Synthetic instruction', out.getvalue())
        quiet = io.StringIO()
        thread_timers._summarize_skipped({'skipped': []}, quiet)
        self.assertEqual(quiet.getvalue(), '')

    def test_bundle_must_be_private_and_unknown_timer_is_refused(self):
        loose = self.root / 'loose.json'
        loose.write_text(json.dumps(self.bundle))
        loose.chmod(0o644)
        with self.assertRaises(timer_moves.MoveError):
            timer_moves.load_bundle(loose)
        with self.assertRaises(timer_moves.MoveError):
            timer_moves.handoff(self.v2, self.v1, self.bundle, 'thread-a', CONVERSATION, timer_ids=['missing'])

    def test_v1_cli_is_invoked_with_explicit_arguments(self):
        seen = []

        class Done:
            returncode, stderr = 0, ''
            stdout = json.dumps({'timer': {}, 'changed': True})

        def runner(argv, **kwargs):
            seen.append(argv)
            return Done()
        cli = timer_moves.V1Cli('/opt/orkestr/bin/orkestr', runner)
        cli.handoff('305d54e89718', 'v2:ns')
        cli.handback('305d54e89718', 'v2:ns', keep_disabled=True)
        self.assertEqual(seen, [
            ['/opt/orkestr/bin/orkestr', 'timers', 'handoff', '305d54e89718', '--handoff-id', 'v2:ns', '--json'],
            ['/opt/orkestr/bin/orkestr', 'timers', 'handback', '305d54e89718', '--handoff-id', 'v2:ns',
             '--keep-disabled', '--json']])


if __name__ == '__main__':
    unittest.main()
