"""Reject unbound timer reader paths before reading/staging any package bytes."""
import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from selected_resources import timer_grants


class TimerGrantSelection(unittest.TestCase):
    def plan(self):
        return dict(resource_namespace={}, authority_uid=62001, provider_home='/srv/provider',
                    home='/srv/core', bootstrap_file='/srv/bootstrap', ledger_directory='/srv/ledger',
                    endpoint_directory='/srv/endpoint', output='/srv/release',
                    agent_timer_grants={'source': '/srv/core-grants',
                                        'target': '/srv/provider/agent-timer-grants'})

    def test_explicit_split_selection_and_legacy_absence(self):
        value = self.plan()
        before = copy.deepcopy(value)
        timer_grants(value)
        self.assertEqual(value, before)
        timer_grants({})

    def test_missing_namespace_extra_fields_and_scope_overlap_are_refused(self):
        value = self.plan()
        value.pop('resource_namespace')
        with self.assertRaises(RuntimeError):
            timer_grants(value)
        for key, changed in [('source', '/srv/core/private'), ('target', '/srv/foreign'),
                             ('target', '/srv/provider/../core'), ('extra', '/srv/extra')]:
            value = self.plan()
            value['agent_timer_grants'][key] = changed
            with self.subTest(key=key, changed=changed), self.assertRaises(RuntimeError):
                timer_grants(value)

    def test_explicit_null_does_not_mean_no_selection(self):
        root=Path(__file__).resolve().parents[3] / 'provider-broker'
        sys.path.insert(0,str(root))
        from codex_service.resource_timers import selected
        from codex_service.contract import Refused
        with self.assertRaises(Refused):
            selected({'agent_timer_grants':None},{})


if __name__ == '__main__':
    unittest.main()
