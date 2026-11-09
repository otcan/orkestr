"""Normal selected-plan Worker gate projection; no filesystem or provider work."""
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import selected_native_workers as workers


class NativeWorkerSelection(unittest.TestCase):
    def test_absence_keeps_existing_plans_and_runtime_unchanged(self):
        self.assertEqual(workers.runtime({}),{})
        self.assertEqual(workers.runtime({'authority_uid':10002,'managed_operations':True}),{})

    def test_explicit_split_managed_flag_projects_into_sealed_runtime(self):
        plan={'authority_uid':10002,'managed_operations':True,'managed_workers':True}
        runtime={'owner_id':'synthetic-owner'};runtime.update(workers.runtime(plan))
        self.assertEqual(runtime,{'owner_id':'synthetic-owner','managed_workers':True})
        self.assertEqual(plan,{'authority_uid':10002,'managed_operations':True,'managed_workers':True})

    def test_incomplete_or_nonboolean_selection_fails_before_staging(self):
        for plan in ({'managed_workers':True},{'authority_uid':10002,'managed_workers':True},
                     {'authority_uid':10002,'managed_operations':False,'managed_workers':True},
                     {'authority_uid':10002,'managed_operations':True,'managed_workers':False},
                     {'authority_uid':10002,'managed_operations':True,'managed_workers':1}):
            with self.subTest(plan=plan),self.assertRaisesRegex(RuntimeError,'Native Worker configuration'):
                workers.runtime(plan)


if __name__=='__main__':unittest.main()
