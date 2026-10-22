"""Converting V1-style timers into one calendar timer: derivation, plan digest,
idempotency and the single-owner invariant at every step."""
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import calendar_convert as cc
import thread_timers
import timer_moves
import v2_client
from test_timer_moves import FakeV1, v1_timer

CONVERSATION = '6a2a1f0e-9b7c-4d3e-8f10-112233445566'
JOBS = 'jobs-thread'
PROMPT = 'Synthetic triage instruction with a weekday guard and NO_REPLY when nothing is new.'


def jobs_timers(extra_prompt=None):
    timers = []
    for hour in range(9, 21):
        timers.append(v1_timer('triage-%02d' % hour, thread=JOBS, time='%02d:00' % hour, label='Triage %02d:00' % hour,
                               prompt=PROMPT if extra_prompt is None or hour != 12 else extra_prompt))
    timers.append(v1_timer('weekday-enable', 'weekly', thread=JOBS, time='08:55', label='Weekday enable',
                           nextRunAt='2026-10-26T06:55:00Z', prompt='enable the triage timers', enabled=False))
    timers.append(v1_timer('weekend-disable', 'weekly', thread=JOBS, time='20:05', label='Weekend disable',
                           nextRunAt='2026-10-23T18:05:00Z', prompt='disable the triage timers', enabled=False))
    return timers


def recipe(**changes):
    value = {'schema': cc.RECIPE_SCHEMA, 'name': 'jobs-triage', 'thread': JOBS, 'label': 'Triage',
             'replace': {'label_prefix': ['Triage ']}, 'retire': {'label_prefix': ['Weekday enable', 'Weekend disable']},
             'schedule': {'derive': True, 'weekdays': [1, 2, 3, 4, 5]}, 'policy': {'silent': True}}
    value.update(changes)
    return value


class FakeCalendarV2:
    """The V2 routes the conversion uses; tracks which group (old or new) is enabled."""

    def __init__(self):
        self.timers, self.calls, self.fail_enable = {}, [], None
        self.overlap_seen = False

    def add_old(self, timer, state='enabled'):
        self.timers[timer['namespace']] = {'namespace': timer['namespace'], 'state': state, 'revision': 2 if state == 'enabled' else 1,
                                           'label': timer['label'], 'source_namespace': 'v1', 'texts': []}

    def _watch(self):
        groups = {t['source_namespace'] == cc.SOURCE_NAMESPACE for t in self.timers.values() if t['state'] == 'enabled'}
        if groups == {True, False}:
            self.overlap_seen = True

    def detail(self, ns):
        t = self.timers[ns]
        return {'namespace': ns, 'label': t['label'], 'state': t['state'], 'revision': t['revision'],
                'controller_armed': t['state'] == 'enabled', 'next_due_ms': 1 if t['state'] == 'enabled' else None}

    def get(self, path, query=None):
        self.calls.append(('GET', path))
        return {'timers': [self.detail(ns) for ns in self.timers]}

    def post(self, path, body):
        self.calls.append(('POST', path))
        if path == '/api/v2/timers/calendar':
            assert 'text' not in body, 'the new timer is created paused'
            assert body['schedule']['kind'] == 'calendar'
            self.timers.setdefault(body['namespace'], {'namespace': body['namespace'], 'state': 'paused', 'revision': 1,
                                                       'label': body['label'], 'source_namespace': cc.SOURCE_NAMESPACE,
                                                       'schedule': body['schedule'], 'policy': body['policy'], 'texts': []})
            return self.detail(body['namespace'])
        namespace, action = path.split('/')[4:6]
        timer = self.timers[namespace]
        if body['expected_revision'] != timer['revision']:
            raise v2_client.ApiError(409, 'timer_conflict')
        if action == 'enable':
            if self.fail_enable is not None and timer['source_namespace'] == cc.SOURCE_NAMESPACE:
                status, self.fail_enable = self.fail_enable, None
                raise v2_client.ApiError(status, 'unreachable' if status == 0 else 'timer_conflict')
            if timer['state'] not in ('paused', 'disabled'):
                raise v2_client.ApiError(409, 'timer_conflict')
            timer['texts'].append(body['text'])
            timer.update(state='enabled', revision=timer['revision'] + 1)
        else:
            assert body['action'] == 'disable'
            timer.update(state='disabled', revision=timer['revision'] + 1)
        self._watch()
        return self.detail(namespace)


class ConvertTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.v1 = FakeV1(jobs_timers())
        # The 12 triage timers were handed off already: V1 fenced, V2 enabled.
        self.bundle = self.export(self.v1)
        for timer in self.bundle['timers']:
            if timer['label'].startswith('Triage '):
                self.v1.timers_by_id[timer['id']].update(ownedBy='v2', enabled=False, ownership={
                    'owner': 'v2', 'handoffId': 'v2:' + timer['namespace'], 'enabledBeforeHandoff': True})
        self.v2 = FakeCalendarV2()
        for timer in self.bundle['timers']:
            if timer['label'].startswith('Triage '):
                self.v2.add_old(timer)
            else:
                self.v2.add_old(timer, 'paused')
        self.recipe = recipe()

    def export(self, v1, name='bundle.json'):
        path = self.root / name
        timer_moves.export(v1.timers(), [JOBS], path, 'synthetic-v1')
        return timer_moves.load_bundle(path)

    def plan(self, **kw):
        return cc.plan(self.v2, self.v1, self.bundle, self.recipe, kw.get('conversation', CONVERSATION), False)

    def apply(self, confirm=None):
        confirm = confirm or self.plan()['plan_digest']
        return cc.apply(self.v2, self.v1, self.bundle, self.recipe, CONVERSATION, confirm, False)

    def active(self):
        return [t['label'] for t in self.v2.timers.values() if t['state'] == 'enabled']

    # -- derivation -----------------------------------------------------------
    def test_twelve_hourly_timers_become_one_rule_in_plain_words(self):
        plan = self.plan()
        self.assertEqual(plan['rule'], {'kind': 'calendar', 'timezone': 'Europe/Berlin', 'weekdays': [1, 2, 3, 4, 5],
                                        'start_minute': 540, 'end_minute': 1200, 'every_hours': 1, 'minutes': [0]})
        self.assertEqual(plan['summary'], 'Hourly at :00, Mon–Fri, 09:00–20:00 Europe/Berlin')
        self.assertEqual(plan['policy']['silent_mode'], 'unless_changed')
        self.assertEqual([r['v2_state'] for r in plan['replaced']], ['enabled'] * 12)
        self.assertEqual([r['v2_state'] for r in plan['retired']], ['paused', 'paused'])
        self.assertEqual(len(cc.day_minutes(plan['rule'])), 12)
        self.assertIsNone(plan['blocked'])
        self.assertNotIn(PROMPT, json.dumps(plan))

    def test_window_override_for_an_owner_brief_that_differs(self):
        self.recipe['schedule'].update(start='08:00', end='19:00')
        plan = self.plan()
        self.assertEqual(plan['summary'], 'Hourly at :00, Mon–Fri, 08:00–19:00 Europe/Berlin')
        self.assertNotEqual(plan['plan_digest'], cc.plan(self.v2, self.v1, self.bundle, recipe(), CONVERSATION, False)['plan_digest'])

    def test_weekdays_are_never_assumed_and_irregular_ladders_are_refused(self):
        self.recipe['schedule'] = {'derive': True}
        with self.assertRaisesRegex(cc.ConvertError, 'weekdays_required'):
            self.plan()
        self.recipe = recipe()
        bundle = self.bundle
        bundle['timers'] = [t for t in bundle['timers'] if t['id'] != 'triage-12']
        with self.assertRaisesRegex(cc.ConvertError, 'uneven_ladder'):
            cc.resolve(bundle, self.recipe, False)

    def test_two_hourly_step_and_offset_and_explicit_rules(self):
        timers = [v1_timer('a-%d' % h, thread=JOBS, time='%02d:15' % h, label='Even %d' % h, prompt='x') for h in (8, 10, 12, 14)]
        path = self.root / 'even.json'
        timer_moves.export(timers, [JOBS], path, 'synthetic-v1')
        bundle = timer_moves.load_bundle(path)
        resolved = cc.resolve(bundle, recipe(replace={'label_prefix': ['Even ']}, retire={}), False)
        self.assertEqual(cc.describe(resolved['rule']), 'Every 2 hours at :15, Mon–Fri, 08:15–14:15 Europe/Berlin')

    def test_describe_matches_the_server_wording(self):
        berlin = cc.normalize({'timezone': 'Europe/Berlin', 'weekdays': [1, 2, 3, 4, 5], 'start_minute': 480, 'end_minute': 1140, 'minutes': [0]})
        self.assertEqual(cc.describe(berlin), 'Hourly at :00, Mon–Fri, 08:00–19:00 Europe/Berlin')
        istanbul = cc.normalize({'timezone': 'Europe/Istanbul', 'weekdays': [], 'start_minute': 540, 'end_minute': 1380, 'minutes': [37]})
        self.assertEqual(cc.describe(istanbul), 'Hourly at :37, every day, 09:00–23:00 Europe/Istanbul')
        self.assertEqual(len(cc.day_minutes(istanbul)), 14)
        self.assertEqual(cc.day_minutes(istanbul)[-1], 22 * 60 + 37)
        both = cc.normalize({'timezone': 'UTC', 'weekdays': [1, 3, 5, 6], 'start_minute': 540, 'end_minute': 570, 'minutes': [30]})
        self.assertEqual(cc.describe(both), 'At 09:30 UTC, Mon, Wed, Fri, Sat')
        for bad in ({'weekdays': [0]}, {'minutes': [60]}, {'minutes': []}, {'start_minute': 600, 'end_minute': 10},
                    {'timezone': 'Mars/Base'}, {'every_hours': 25}, {'start_minute': 480, 'end_minute': 510, 'minutes': [59]}):
            with self.assertRaises(cc.ConvertError):
                cc.normalize(dict({'timezone': 'UTC', 'weekdays': [], 'start_minute': 0, 'end_minute': 100, 'minutes': [0]}, **bad))

    def test_instruction_suffix_is_only_appended_and_changes_the_digest(self):
        base = cc.plan(self.v2, self.v1, self.bundle, self.recipe, CONVERSATION, False)['plan_digest']
        self.recipe['instruction_suffix'] = 'Start with NO_NEWS: <summary> when nothing needs action.'
        resolved = cc.resolve(self.bundle, self.recipe, False)
        self.assertEqual(resolved['instruction'], PROMPT + '\n\nStart with NO_NEWS: <summary> when nothing needs action.')
        self.assertNotEqual(cc.plan(self.v2, self.v1, self.bundle, self.recipe, CONVERSATION, False)['plan_digest'], base)

    def test_instructions_must_be_identical_or_the_conversion_stops(self):
        v1 = FakeV1(jobs_timers(extra_prompt='A different instruction'))
        bundle = self.export(v1, 'differs.json')
        with self.assertRaisesRegex(cc.ConvertError, 'instructions_differ'):
            cc.resolve(bundle, self.recipe, False)

    def test_prompt_files_are_inlined_without_printing_them(self):
        files = []
        timers = []
        for hour in (9, 10):
            handle = self.root / ('prompt-%d.md' % hour)
            handle.write_text('File instruction')
            timers.append(v1_timer('f-%d' % hour, thread=JOBS, time='%02d:00' % hour, label='File %d' % hour, prompt='', promptFile=str(handle)))
        path = self.root / 'files.json'
        timer_moves.export(timers, [JOBS], path, 'synthetic-v1')
        bundle = timer_moves.load_bundle(path)
        resolved = cc.resolve(bundle, recipe(replace={'label_prefix': ['File ']}, retire={}), True)
        self.assertEqual(resolved['instruction'], 'File instruction')

    # -- plan, apply, idempotency ----------------------------------------------
    def test_offline_plan_for_a_thread_not_on_v2_is_prepared_but_blocked(self):
        plan = cc.plan(None, self.v1, self.bundle, self.recipe, None, False)
        self.assertIn('thread_not_on_v2', plan['blocked'])
        self.assertEqual(plan['summary'], 'Hourly at :00, Mon–Fri, 09:00–20:00 Europe/Berlin')
        with self.assertRaisesRegex(cc.ConvertError, 'thread_not_on_v2'):
            cc.apply(None, self.v1, self.bundle, self.recipe, None, plan['plan_digest'], False)

    def test_apply_requires_the_reviewed_plan_digest(self):
        with self.assertRaisesRegex(cc.ConvertError, 'plan_digest_mismatch'):
            self.apply(confirm='0' * 16)
        self.assertEqual([c for c in self.v2.calls if c[0] == 'POST'], [])

    def test_apply_leaves_exactly_one_running_timer_and_never_two(self):
        report = self.apply()
        self.assertTrue(report['complete'])
        self.assertEqual(self.active(), ['Triage'])
        self.assertFalse(self.v2.overlap_seen, 'old and new were never enabled together')
        steps = [s['step'] for s in report['steps']]
        self.assertLess(steps.index('create'), steps.index('disable_old'))
        self.assertEqual(steps[-1], 'enable')
        new = self.v2.timers[cc.new_namespace(self.bundle, self.recipe)]
        self.assertEqual(new['texts'], [PROMPT], 'the unchanged instruction, weekday guard included')
        self.assertEqual(new['policy']['silent_mode'], 'unless_changed')
        # Old timers and the controllers are kept, off, for rollback.
        old = [t for t in self.v2.timers.values() if t['source_namespace'] == 'v1']
        self.assertEqual({t['state'] for t in old}, {'disabled', 'paused'})
        self.assertEqual(len(old), 14)
        self.assertTrue(cc.status(self.v2, self.v1, self.bundle, self.recipe, CONVERSATION, False)['single_owner'])

    def test_apply_is_idempotent(self):
        self.apply()
        before = json.dumps(self.v2.timers, sort_keys=True)
        calls = len(self.v2.calls)
        again = self.apply()
        self.assertTrue(again['complete'])
        self.assertEqual(json.dumps(self.v2.timers, sort_keys=True), before)
        self.assertEqual([c for c in self.v2.calls[calls:] if c[0] == 'POST'], [])
        self.assertEqual({s['result'] for s in again['steps'] if s['step'] == 'enable'}, {'already_enabled'})

    def test_interrupted_enable_leaves_zero_owners_and_a_rerun_finishes(self):
        self.v2.fail_enable = 0
        first = self.apply()
        self.assertFalse(first['complete'])
        self.assertEqual(self.active(), [], 'zero owners is safe; never two')
        second = self.apply()
        self.assertTrue(second['complete'])
        self.assertEqual(self.active(), ['Triage'])
        self.assertFalse(self.v2.overlap_seen)

    def test_enabled_controller_blocks_apply(self):
        self.v1.timers_by_id['weekday-enable']['enabled'] = True
        self.assertIn('controller', self.plan()['blocked'])
        with self.assertRaisesRegex(cc.ConvertError, 'v1_controller_enabled'):
            self.apply()

    def test_v1_owned_timers_are_fenced_before_the_new_timer_runs(self):
        # The swing shape: V1 still owns an enabled interval timer; the thread is on V2 now.
        v1 = FakeV1([v1_timer('hourly', 'interval', every='1h', thread=JOBS, timezone='', label='Inbox hourly', prompt='Swing inbox')])
        bundle = self.export(v1, 'swing.json')
        swing = recipe(name='swing-inbox', replace={'ids': ['hourly']}, retire={}, label='Inbox',
                       schedule={'timezone': 'Europe/Istanbul', 'weekdays': [], 'start': '09:00', 'end': '23:00', 'minutes': [37]},
                       policy={'silent': True, 'digest': {'times': ['09:00']}})
        v2 = FakeCalendarV2()
        digest = cc.plan(v2, v1, bundle, swing, CONVERSATION, False)['plan_digest']
        report = cc.apply(v2, v1, bundle, swing, CONVERSATION, digest, False)
        self.assertTrue(report['complete'])
        self.assertEqual(v1.timers_by_id['hourly']['ownedBy'], 'v2')
        self.assertEqual(v1.calls[0], ('handoff', 'hourly'))
        new = v2.timers[cc.new_namespace(bundle, swing)]
        self.assertEqual(new['policy']['digest'], {'timezone': 'Europe/Istanbul', 'minutes': [540]})
        self.assertEqual(new['schedule']['minutes'], [37])
        # Rollback hands the fenced V1 timer back; V2 never held a copy.
        back = cc.rollback(v2, v1, bundle, swing, CONVERSATION, 'v2', False)
        self.assertEqual(v1.timers_by_id['hourly'].get('ownedBy'), None)
        self.assertTrue(v1.timers_by_id['hourly']['enabled'])
        self.assertEqual(back['steps'][-1]['result'], 'handed_back_to_v1')
        self.assertEqual([t['state'] for t in v2.timers.values()], ['disabled'])

    # -- rollback ---------------------------------------------------------------
    def test_rollback_disables_new_first_then_restores_old_with_one_owner(self):
        self.apply()
        report = cc.rollback(self.v2, self.v1, self.bundle, self.recipe, CONVERSATION, 'v2', False)
        self.assertEqual(report['steps'][0], {'step': 'disable_new', 'result': 'disabled'})
        self.assertEqual(len(self.active()), 12)
        self.assertNotIn('Triage', self.active())
        self.assertFalse(self.v2.overlap_seen)
        again = cc.rollback(self.v2, self.v1, self.bundle, self.recipe, CONVERSATION, 'v2', False)
        self.assertEqual({s['result'] for s in again['steps'] if s['step'] == 'restore'}, {'already_enabled'})
        # And forward again after a rollback: still one owner.
        self.apply()
        self.assertEqual(self.active(), ['Triage'])
        self.assertFalse(self.v2.overlap_seen)

    def test_rollback_to_v1_hands_every_timer_back(self):
        self.apply()
        cc.rollback(self.v2, self.v1, self.bundle, self.recipe, CONVERSATION, 'v1', False)
        self.assertEqual(self.active(), [])
        triage = [t for t in self.v1.timers_by_id.values() if t['label'].startswith('Triage ')]
        self.assertTrue(all(t.get('ownedBy') is None and t['enabled'] for t in triage))

    def test_status_flags_a_double_owner(self):
        self.apply()
        # Someone re-enables an old V2 timer by hand while the new one runs.
        old = next(t for t in self.v2.timers.values() if t['source_namespace'] == 'v1' and t['state'] == 'disabled')
        old['state'] = 'enabled'
        report = cc.status(self.v2, self.v1, self.bundle, self.recipe, CONVERSATION, False)
        self.assertFalse(report['single_owner'])

    # -- recipes -----------------------------------------------------------------
    def test_shipped_recipes_are_valid_and_swing_is_blocked_until_it_is_on_v2(self):
        base = Path(__file__).resolve().parents[1] / 'recipes'
        jobs = cc.load_recipe(base / 'jobs-triage.json')
        self.assertEqual((jobs['thread'], jobs['schedule']), ('157ea1bfc66836fd', {'derive': True, 'weekdays': [1, 2, 3, 4, 5]}))
        swing = cc.load_recipe(base / 'swing-inbox.json')
        rule = cc.normalize(dict(timezone='Europe/Istanbul', weekdays=[], start_minute=cc.parse_clock(swing['schedule']['start']),
                                 end_minute=cc.parse_clock(swing['schedule']['end']), minutes=swing['schedule']['minutes']))
        self.assertEqual(cc.describe(rule), 'Hourly at :37, every day, 09:00–23:00 Europe/Istanbul')
        self.assertEqual(swing['policy']['digest'], {'times': ['09:00'], 'timezone': 'Europe/Istanbul'})
        with self.assertRaises(cc.ConvertError):
            bad = dict(jobs, schema='other')
            (self.root / 'bad.json').write_text(json.dumps(bad))
            cc.load_recipe(self.root / 'bad.json')


class CliTests(unittest.TestCase):
    def test_parser_accepts_the_calendar_commands_and_apply_needs_the_digest(self):
        parser = thread_timers.parser()
        args = parser.parse_args(['calendar-plan', '--bundle', 'b', '--recipe', 'r'])
        self.assertIsNone(args.conversation)
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            parser.parse_args(['calendar-apply', '--bundle', 'b', '--recipe', 'r', '--conversation', CONVERSATION,
                               '--v2-url', 'http://x', '--credentials-file', 'c'])
        args = parser.parse_args(['calendar-rollback', '--bundle', 'b', '--recipe', 'r', '--conversation', CONVERSATION,
                                  '--v2-url', 'http://x', '--credentials-file', 'c', '--to', 'v1'])
        self.assertEqual(args.to, 'v1')


if __name__ == '__main__':
    unittest.main()
