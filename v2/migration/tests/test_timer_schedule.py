import copy
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from timer_schedule import TimerRefusal, export_schedule, validate_export, next_due, prepare_import, prepare_enable


class TimerTests(unittest.TestCase):
    def timer(self, **changes):
        return export_schedule('synthetic-source', dict(id='fake-timer-a', enabled=True, cadence='daily', time='09:00', timezone='UTC', **changes))

    def test_projection_excludes_payload_identity_and_authority(self):
        value = export_schedule('synthetic-source', {'id': 'fake-timer-a', 'enabled': True, 'cadence': 'interval', 'every': '2h', 'prompt': 'PRIVATE', 'promptFile': 'PRIVATE', 'target': 'PRIVATE', 'ownerUserId': 'PRIVATE', 'requiredConnector': 'PRIVATE'})
        self.assertNotIn('PRIVATE', json.dumps(value))
        self.assertEqual(value['state'], 'PAUSED')
        self.assertEqual(next_due(value, '2026-01-01T12:00:00Z'), '2026-01-01T14:00:00Z')
        self.assertEqual(validate_export(value), value)

    def test_weekly_source_same_day_then_seven_days(self):
        v = export_schedule('synthetic-source', {'id':'fake-timer-a', 'enabled':False, 'cadence':'weekly', 'time':'09:00', 'timezone':'UTC'})
        self.assertEqual(next_due(v, '2026-01-01T08:00:00Z'), '2026-01-01T09:00:00Z')
        self.assertEqual(next_due(v, '2026-01-01T09:00:00Z'), '2026-01-08T09:00:00Z')
        self.assertFalse(v['projection']['sourceEnabled'])

    def test_once_overdue_no_catchup(self):
        v = export_schedule('synthetic-source', {'id':'fake-once', 'enabled':True, 'cadence':'once', 'runAt':'2026-01-02T00:00:00Z'})
        self.assertEqual(next_due(v, '2026-01-01T00:00:00Z'), '2026-01-02T00:00:00Z')
        with self.assertRaises(TimerRefusal): next_due(v, '2026-01-02T00:00:00Z')

    def test_dst_gap_and_fold_refused(self):
        for now, clock in [('2026-03-08T06:00:00Z', '02:30'), ('2026-11-01T04:00:00Z', '01:30')]:
            v = export_schedule('synthetic-source', {'id':'fake-dst', 'enabled':True, 'cadence':'daily', 'time':clock, 'timezone':'America/New_York'})
            with self.assertRaises(TimerRefusal): next_due(v, now)

    def test_invalid_source_defaults_and_uncertain_state_refused(self):
        base = {'id':'fake-a', 'enabled':True, 'cadence':'daily', 'time':'09:00', 'timezone':'UTC'}
        for change in ({'timezone':''}, {'time':'25:99'}, {'enabled':1}, {'status':'cancelled'}, {'legacy':{'status':'active'}}, {'cadence':'unknown'}, {'timezone':'Invalid/Zone'}):
            with self.subTest(change=change), self.assertRaises(TimerRefusal): export_schedule('synthetic-source', base | change)
        for every in ('bad', '999999999999d'):
            with self.assertRaises(TimerRefusal): export_schedule('synthetic-source', base | {'cadence':'interval', 'every':every})

    def test_tamper_and_extra_fields_refused(self):
        value = self.timer()
        for mutate in (lambda v:v.update(state='ENABLED'), lambda v:v['projection']['schedule'].update(time='10:00'), lambda v:v['projection'].update(prompt='fake'), lambda v:v['projection']['schedule'].update(weekday=1)):
            v=copy.deepcopy(value); mutate(v)
            with self.assertRaises(TimerRefusal): validate_export(v)

    def test_deterministic_intents_do_not_mutate_export_or_enable(self):
        value = self.timer(); before=copy.deepcopy(value)
        imported=prepare_import(value, 'fresh-target')
        first=prepare_enable(value, 'fresh-target', 1, 'fake-enable-key', '2026-01-01T08:00:00Z')
        self.assertEqual(first, prepare_enable(value, 'fresh-target', 1, 'fake-enable-key', '2026-01-01T08:00:00Z'))
        self.assertEqual(imported['state'], 'PAUSED'); self.assertEqual(value, before)
        with self.assertRaises(TimerRefusal): prepare_enable(value, 'fresh-target', True, 'fake-key', '2026-01-01T08:00:00Z')


if __name__ == '__main__': unittest.main()
